/**
 * Posting what is owed, and recording what has been paid. Backend only — no IPC, no screen.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 OWNER ONLY, FOR EVERY WRITE AND EVERY READ, IN THIS SLICE. A cashier may take a customer's
 * name at the till (S1B) but may not create a debt in that customer's name, and may not collect
 * against one. Letting a cashier collect is a real and probably correct future decision — it is
 * also the decision that needs a till workflow, a shift reconciliation and a drawer count behind
 * it, none of which exist. Until Salman approves those, the narrow gate is the honest one, and it
 * only ever REMOVES permission. `requireOwner` is one function so a later method cannot quietly be
 * laxer than this one.
 *
 * 🔴 NOTHING HERE TOUCHES `sales`, `sale_lines` OR `invoices`. A payment is a new row in
 * `settlements`; it never rewrites the finalized document it pays for. `sales.paid_minor` and
 * `sales.balance_due_minor` keep meaning exactly what migration 7 said they mean — the money
 * position AT THE MOMENT OF SALE — and both tables stay immutable by trigger, so this service
 * could not rewrite them even if it tried.
 *
 * 🔴 A RETRY IS ANSWERABLE, WHICH IS WHY THE KEY IS REQUIRED. The hardest thing to get right in a
 * payments path is not the happy case, it is the operator who does not know whether the last tap
 * went through. Both postings take an idempotency key and store a fingerprint of the request
 * beside it, so a repeat can be answered with one of exactly three truths:
 *
 *     same key, same money      -> this already happened, here it is          (duplicate: true)
 *     same key, different money -> refuse loudly, IDEMPOTENCY_CONFLICT
 *     no such key               -> it did not happen; posting now is safe
 *
 * There is deliberately no fourth "probably fine" branch. The second case is the one that protects
 * a merchant from a mistyped amount being accepted because the key happened to match.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { businessDateOf } from "../domain/businessDay";
import { DomainError } from "../domain/errors";
import { formatDecimal, money } from "../domain/money";
import {
  type CollectionChannel,
  type ObligationDirection,
  type ObligationRecord,
  type ObligationSource,
  type SettlementMethod,
  type SettlementProvider,
  type SettlementRecord,
  balancesByCurrency,
  channelStorage,
  cleanPaymentReference,
  isCollectionChannel,
  isObligationDirection,
  isObligationSource,
  isSettlementMethod,
  ledgerAmount,
  outstanding,
  partyKindFor,
  sourceRef as cleanSourceRef,
} from "../domain/ledger";
import type { AttemptRecord, LedgerRepository } from "../persistence/ledgerRepository";
import type { PartyRepository } from "../persistence/partyRepository";
import type {
  AllocationRecord,
  ReceiptProvider,
  ReceiptRecord,
  ReceiptRepository,
  StoredReceiptAttempt,
} from "../persistence/receiptRepository";

interface PreparedCollection {
  readonly key: string;
  readonly obligation: ObligationRecord;
  readonly partyId: string;
  readonly obligationId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly method: SettlementMethod;
  readonly provider: SettlementProvider | null;
  readonly reference: string | null;
  readonly fundsConfirmed: boolean | null;
  /** The named channel, or null for the legacy migration-13 call (which keeps no attempt). */
  readonly channel: CollectionChannel | null;
  readonly fingerprint: string;
}

/** Who is acting. Supplied by the POS service, which owns the session and the live role. */
export interface LedgerActor {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "admin" | "cashier";
}

export interface LedgerServiceDeps {
  readonly ledger: LedgerRepository;
  readonly parties: PartyRepository;
  /** Migration 18. Optional so a terminal (or test) without receipts keeps working unchanged. */
  readonly receipts?: ReceiptRepository;
  /** The live operator, re-read on every call. `null` means nobody is signed in. */
  readonly actor: () => LedgerActor | null;
  /** `db.transaction(fn).immediate()` — the one connection, the one transaction. */
  readonly transact: <T>(fn: () => T) => T;
  readonly terminal: { readonly timeZone: string };
  /** Resolves a sale id to its currency, so a sale-sourced debt cannot invent one. */
  readonly saleCurrency: (saleId: string) => string | null;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ObligationDraft {
  readonly partyId: unknown;
  readonly direction: unknown;
  readonly sourceKind: unknown;
  readonly sourceRef: unknown;
  readonly currency: unknown;
  readonly amountMinor: unknown;
}

export interface SettlementDraft {
  readonly obligationId: unknown;
  readonly partyId: unknown;
  readonly idempotencyKey: unknown;
  readonly amountMinor: unknown;
  readonly method: unknown;
  /**
   * Migration 17. When present the payment is a COLLECTION through a named channel (cash · card ·
   * whish · bank_transfer · other) and the stored method/provider are derived from it, with the
   * reference and confirmation rules applied. Absent = the migration-13 behaviour, unchanged.
   */
  readonly channel?: unknown;
  readonly reference?: unknown;
  readonly fundsConfirmed?: unknown;
}

/** What a caller gets back. `duplicate` distinguishes a retry from a fresh posting. */
export interface PostResult<T> {
  readonly record: T;
  readonly duplicate: boolean;
}

/** What one allocated receipt asks for. Everything is validated before anything is written. */
export interface ReceiptDraft {
  readonly customerId: unknown;
  readonly idempotencyKey: unknown;
  /** Only `whish` or `bank_transfer` in this slice. */
  readonly channel: unknown;
  readonly reference: unknown;
  readonly fundsConfirmed: unknown;
  /** The currency the operator believes every debt is in; checked, never assumed. */
  readonly currency: unknown;
  readonly totalMinor: unknown;
  readonly allocations: unknown;
}

export interface ReceiptResult {
  readonly receipt: ReceiptRecord;
  readonly allocations: ReadonlyArray<AllocationRecord>;
  readonly duplicate: boolean;
}

interface PreparedReceipt {
  readonly key: string;
  readonly customerId: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly provider: ReceiptProvider;
  readonly reference: string;
  /** Sorted by obligation id, so the fingerprint and the write order are deterministic. */
  readonly lines: ReadonlyArray<{ readonly obligationId: string; readonly amountMinor: bigint }>;
  readonly fingerprint: string;
}

const MAX_RECEIPT_ALLOCATIONS = 50;

const KEY_PATTERN = /^[A-Za-z0-9-]{8,100}$/;

export class LedgerService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: LedgerServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  // ── Authorization ───────────────────────────────────────────────────────────────────────────

  /**
   * The only gate in this file. Money is owner-only for now — see the header.
   *
   * `admin` is refused as well as `cashier`. The admin tier exists in `audit_events` but no admin
   * account can be created in this product yet, so granting it authority here would be granting it
   * to a role nobody has reviewed.
   */
  private requireOwner(): LedgerActor {
    const actor = this.deps.actor();
    if (!actor) throw new DomainError("NOT_LOGGED_IN", "Sign in first");
    if (actor.role !== "owner") {
      throw new DomainError("NOT_AUTHORIZED", "Only the shop owner can do that");
    }
    return actor;
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────

  /**
   * One party's obligations, scoped to its own side of the ledger.
   *
   * 🔴 THE DIRECTION COMES FROM THE PARTY, NOT FROM THE CALLER. A customer can only ever have
   * receivables and a supplier only payables, so there is no parameter a caller could get wrong
   * and no way to ask for "this customer's payables" and be handed a supplier's rows.
   */
  obligationsOf(partyId: string): ObligationRecord[] {
    this.requireOwner();
    const party = this.deps.parties.findById(partyId);
    if (!party) throw new DomainError("PARTY_NOT_FOUND", "That account no longer exists");
    const direction: ObligationDirection = party.kind === "customer" ? "receivable" : "payable";
    return this.deps.ledger.listObligations(partyId, direction);
  }

  settlementsOf(obligationId: string): SettlementRecord[] {
    this.requireOwner();
    if (!this.deps.ledger.findObligationById(obligationId)) {
      throw new DomainError("INVALID_INPUT", "That obligation no longer exists");
    }
    return this.deps.ledger.listSettlements(obligationId);
  }

  /** What is still owed on one obligation, in its own currency. */
  outstandingOf(obligationId: string): { minor: bigint; currency: string } {
    this.requireOwner();
    const o = this.deps.ledger.findObligationById(obligationId);
    if (!o) throw new DomainError("INVALID_INPUT", "That obligation no longer exists");
    const left = outstanding(o, this.deps.ledger.listSettlements(o.id));
    return { minor: left.minor, currency: left.currency };
  }

  /**
   * A party's outstanding balances, ONE PER CURRENCY.
   *
   * 🔴 A MAP, NOT A NUMBER. There is no exchange rate in this product, so a party who owes 50 USD
   * and 2,000,000 LBP owes exactly that — two facts. Returning one blended figure would have
   * required inventing a rate, and a wrong rate in a merchant's books is worse than two numbers.
   */
  balancesOf(partyId: string): ReadonlyMap<string, bigint> {
    const obligations = this.obligationsOf(partyId);
    return balancesByCurrency(obligations, (id) => this.deps.ledger.listSettlements(id));
  }

  /**
   * One CUSTOMER's whole statement, composed for a screen. Read-only.
   *
   * 🔴 IT ADDS NO REPOSITORY OPERATION AND NO POSTING SEMANTICS. Every figure comes from the S3A
   * reads above — `obligationsOf`, `listSettlements`, `outstanding` — so there is exactly one
   * definition of what a customer owes and this is not a second one.
   *
   * 🔴 CUSTOMERS ONLY, AND A SUPPLIER ID IS REFUSED AS "NOT FOUND". `obligationsOf` would happily
   * serve a supplier's payables, so the kind is checked HERE rather than left to the caller. The
   * refusal deliberately does not distinguish "no such party" from "that is a supplier": the
   * renderer has no supplier channel at all, so confirming one exists would be the only thing this
   * reply could leak.
   *
   * 🔴 ONE CALL, NOT N+1. A screen that asked for obligations and then looped for each one's
   * settlements would read a ledger that could change between calls and could render a debt beside
   * someone else's payments. Composing in main means the statement is one consistent read.
   */
  /**
   * The settlement a given idempotency key already committed, or null.
   *
   * 🔴 THIS EXISTS FOR ONE REASON: telling an owner the TRUTH after an unexpected fault. If the
   * IPC response is lost after the commit, the only honest way to answer "was my payment taken?"
   * is to ASK THE LEDGER by the key the caller sent — not to guess from the exception, which is
   * how a shop ends up collecting the same debt twice. `saleOutcomeText.ts` established this
   * shape for sales; this is the same discipline for a collection.
   *
   * It is a READ. It posts nothing, and it is owner-gated like every other read here.
   */
  /**
   * What was COLLECTED against customer debts on ONE business day, per currency and per way of paying
   * (owner-only read): direct collections plus whole receipts, each counted once.
   *
   * 🔴 THIS IS COLLECTIONS ONLY, NOT SHOP-WIDE RECEIPTS. It does not include a POS checkout's own tender
   * (`sales.payment_method`), an invoice's typed `paid` figure, or any sale paid at the till — those are
   * not integrated here, so this must not be presented as the day's total takings.
   *
   * Cash is its own row: a Whish, bank or card receipt is never inside the till-cash figure, and no
   * currency is ever added to another.
   */
  collectionTotals(businessDate: string): ReturnType<LedgerRepository["collectionTotals"]> {
    this.requireOwner();
    if (typeof businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new DomainError("INVALID_INPUT", "A business date must be written as YYYY-MM-DD");
    }
    return this.deps.ledger.collectionTotals(businessDate);
  }

  settlementForIdempotencyKey(key: string): SettlementRecord | null {
    this.requireOwner();
    if (typeof key !== "string" || key.length === 0) return null;
    return this.deps.ledger.findSettlementByIdempotencyKey(key)?.settlement ?? null;
  }

  statementFor(customerId: string): {
    readonly obligations: ReadonlyArray<{
      readonly obligation: ObligationRecord;
      readonly settlements: readonly SettlementRecord[];
      readonly outstandingMinor: bigint;
    }>;
    readonly balances: ReadonlyMap<string, bigint>;
  } {
    this.requireOwner();
    const party = this.deps.parties.findById(customerId);
    if (!party || party.kind !== "customer") {
      throw new DomainError("PARTY_NOT_FOUND", "That account no longer exists");
    }
    const rows = this.deps.ledger.listObligations(customerId, "receivable").map((obligation) => {
      const settlements = this.deps.ledger.listSettlements(obligation.id);
      return {
        obligation,
        settlements,
        outstandingMinor: outstanding(obligation, settlements).minor,
      };
    });
    return {
      obligations: rows,
      balances: balancesByCurrency(
        rows.map((r) => r.obligation),
        (id) => rows.find((r) => r.obligation.id === id)?.settlements ?? [],
      ),
    };
  }

  // ── Posting ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Record that a party owes, or is owed, money.
   *
   * Everything — the duplicate check and the insert — happens inside ONE transaction, so a failure
   * anywhere leaves no half-posted row. The read-then-write is safe under concurrency because the
   * transaction is `immediate` and `UNIQUE (source_kind, source_ref)` is the real authority: the
   * lookup only exists so a retry gets a sentence instead of a constraint error.
   */
  postObligation(draft: ObligationDraft): PostResult<ObligationRecord> {
    const actor = this.requireOwner();

    if (!isObligationDirection(draft.direction)) {
      throw new DomainError("INVALID_INPUT", "An obligation needs a direction");
    }
    if (!isObligationSource(draft.sourceKind)) {
      throw new DomainError("INVALID_INPUT", "An obligation needs a source");
    }
    if (typeof draft.partyId !== "string" || draft.partyId.length === 0) {
      throw new DomainError("INVALID_INPUT", "An obligation needs an account");
    }
    if (typeof draft.currency !== "string") {
      throw new DomainError("INVALID_INPUT", "An obligation needs a currency");
    }
    const direction: ObligationDirection = draft.direction;
    const sourceKind: ObligationSource = draft.sourceKind;
    const ref = cleanSourceRef(draft.sourceRef);
    // Validates the amount is a positive bigint within range AND the currency is one this product
    // knows. Throws before anything is written.
    const amount = this.validateObligationAmount(draft.amountMinor, draft.currency);

    const party = this.deps.parties.findById(draft.partyId);
    if (!party) throw new DomainError("PARTY_NOT_FOUND", "That account no longer exists");

    // 🔴 THE SIDE OF THE LEDGER IS DECIDED BY THE ACCOUNT, and disagreement is refused rather than
    // corrected. A caller asking to post a payable against a customer has a bug, and silently
    // flipping it to a receivable would hide that bug behind a plausible row.
    if (party.kind !== partyKindFor(direction)) {
      throw new DomainError(
        "INVALID_INPUT",
        direction === "receivable"
          ? "A receivable belongs to a customer account"
          : "A payable belongs to a supplier account",
      );
    }

    let saleId: string | null = null;
    if (sourceKind === "sale") {
      saleId = ref;
      const saleCurrency = this.deps.saleCurrency(saleId);
      // Wording matched to `posService`'s own two SALE_NOT_FOUND sites on purpose. The code is
      // mapped to one Arabic sentence («لم نجد هذه الفاتورة.»), and `refusalText`'s criterion (a)
      // fails the build when two sites carrying one code describe different things — so a second
      // phrasing here would either make that sentence wrong for one of them or lose the mapping.
      if (saleCurrency === null) throw new DomainError("SALE_NOT_FOUND", "Sale not found");
      // The debt cannot be denominated differently from the sale that created it.
      if (saleCurrency !== amount.currency) {
        throw new DomainError("MIXED_CURRENCY", `That sale is in ${saleCurrency}, not ${amount.currency}`);
      }
    }

    const instant = this.now();
    return this.deps.transact(() => {
      const existing = this.deps.ledger.findObligationBySource(sourceKind, ref);
      if (existing) {
        // A repeat for the same source is a retry, not a second debt. Answer with what is there.
        if (existing.amountMinor !== amount.minor || existing.currency !== amount.currency) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "That source already carries an obligation for a different amount",
          );
        }
        return { record: existing, duplicate: true };
      }

      const record: ObligationRecord = {
        id: this.newId(),
        partyId: party.id,
        partyKind: party.kind,
        direction,
        sourceKind,
        sourceRef: ref,
        saleId,
        currency: amount.currency,
        amountMinor: amount.minor,
        postedBy: actor.id,
        postedAt: instant.toISOString(),
        businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
      };
      this.deps.ledger.insertObligation(record);
      return { record, duplicate: false };
    });
  }

  /** Shared amount/currency validation for internal atomic sale-to-obligation posting. */
  validateObligationAmount(amountMinor: unknown, currency: unknown): ReturnType<typeof ledgerAmount> {
    if (typeof currency !== "string") {
      throw new DomainError("INVALID_INPUT", "An obligation needs a currency");
    }
    return ledgerAmount(amountMinor, currency);
  }

  /** Owner-authorized read used to reconcile an atomic POS credit-sale pair. */
  findSaleObligation(saleId: string): ObligationRecord | null {
    this.requireOwner();
    return this.deps.ledger.findObligationBySource("sale", saleId);
  }

  /**
   * Record money actually paid against one obligation. Partial or full.
   *
   * The overpayment check is here AND in a database trigger. This one exists so the merchant reads
   * "that is more than is owed" with the real figure; the trigger is the authority, and it is what
   * holds if two payments are ever attempted at once.
   */
  settle(draft: SettlementDraft): PostResult<SettlementRecord> {
    const actor = this.requireOwner();
    return this.commitCollection(this.prepareCollection(draft), actor, true);
  }

  /**
   * A COLLECTION: the durable intent first, then the settlement.
   *
   * 1. Everything is validated BEFORE anything is written, so a refused payment leaves no trace.
   * 2. The intent (customer, obligation, amount, channel, reference, confirmation and the ORIGINAL
   *    idempotency key) is committed in its own transaction. From here on, whatever the renderer
   *    loses — navigation, a closed window, a restart — the exact attempt is recoverable.
   * 3. The settlement commits in a second transaction and closes its own attempt atomically.
   *
   * 🔴 A new key for this customer is refused while an earlier attempt cannot be resolved by reading
   * the ledger (COLLECTION_UNRESOLVED), so an unknown outcome is never papered over with a second
   * payment. An earlier attempt the ledger CAN answer — recorded, or provably not — is closed
   * here and then no longer blocks.
   */
  collect(draft: SettlementDraft & { readonly customerId: unknown }): PostResult<SettlementRecord> {
    const actor = this.requireOwner();
    const prepared = this.prepareCollection(draft);
    if (prepared.channel === null || typeof draft.customerId !== "string" || draft.customerId !== prepared.partyId) {
      throw new DomainError("INVALID_INPUT", "A collection needs a payment channel and its customer");
    }
    const instant = this.now();
    this.deps.transact(() => {
      const live = this.requireOwner();
      if (live.id !== actor.id) {
        throw new DomainError("NOT_AUTHORIZED", "The signed-in operator changed during the payment");
      }
      this.beginAttempt(prepared, actor, instant);
    });
    try {
      // 🔴 EVERY non-replay settlement re-reads the receipt lock inside its own transaction — a NEW attempt
      // and also the continuation of an attempt that is already OPEN but not yet recorded. Only a replay
      // of a settlement that already committed is answered without it.
      return this.commitCollection(prepared, actor, true);
    } catch (error) {
      // A DomainError was thrown INSIDE the settlement transaction, which rolled back: nothing was
      // written under this key, so the attempt is provably "not recorded" and is closed. Anything
      // else (an internal fault, a lost handle) proves nothing — the attempt stays OPEN and the
      // ledger is asked later.
      // An authorization failure writes nothing more — the attempt is left exactly as it was.
      // 🔴 COLLECTION_UNRESOLVED is a HOLD, not a verdict on this payment: the attempt is left OPEN so that,
      // once the earlier receipt is reconciled, the exact repeat under the ORIGINAL key still works.
      if (
        error instanceof DomainError &&
        error.code !== "NOT_LOGGED_IN" &&
        error.code !== "NOT_AUTHORIZED" &&
        error.code !== "COLLECTION_UNRESOLVED"
      ) {
        try {
          this.deps.transact(() => {
            if (!this.deps.ledger.findSettlementByIdempotencyKey(prepared.key)) {
              this.deps.ledger.resolveAttempt(prepared.key, "not_recorded", this.now());
            }
          });
        } catch {
          /* leave it open; the read side will resolve it */
        }
      }
      throw error;
    }
  }

  private beginAttempt(p: PreparedCollection, actor: LedgerActor, instant: Date): void {
    const ledger = this.deps.ledger;
    // A settlement under this key (including every pre-migration-17 one) needs no attempt: the
    // settlement itself is the record, and commitCollection answers the replay.
    if (ledger.findSettlementByIdempotencyKey(p.key)) return;
    const existing = ledger.findAttempt(p.key);
    if (existing) {
      if (existing.fingerprint !== p.fingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That payment key was already used for a different payment");
      }
      // Closing an attempt is FINAL. If 'not_recorded' is later replayed, allowing settlement
      // under that key would leave a recorded payment paired with a permanently 'not_recorded'
      // attempt. A delayed IPC retry after a replacement collection is especially dangerous.
      if (existing.resolution === "not_recorded") {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That collection attempt is closed as not recorded");
      }
      if (existing.resolution === "recorded") {
        throw new DomainError("LEDGER_INTEGRITY", "A recorded collection attempt has no matching settlement");
      }
      return; // only an OPEN same-intent attempt may continue under its original key (Tx2 re-checks the receipt lock)
    }
    // 🔴 Migration 18: a NEW collection is refused while an earlier allocated receipt of this customer is
    // unknown or in conflict (see assertNoUnresolvedReceipts). A replay or continuation never gets here.
    this.assertNoUnresolvedReceipts(p.partyId);
    // Any OTHER open attempt of this customer must be answerable from the ledger before a new one starts.
    for (const open of ledger.listOpenAttempts(p.partyId)) {
      let settled: ReturnType<LedgerRepository["findSettlementByIdempotencyKey"]>;
      try {
        settled = ledger.findSettlementByIdempotencyKey(open.key);
      } catch {
        throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
      }
      if (settled && settled.fingerprint !== open.fingerprint) {
        throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
      }
      ledger.resolveAttempt(open.key, settled ? "recorded" : "not_recorded", instant);
    }
    ledger.insertAttempt(
      {
        key: p.key,
        customerId: p.partyId,
        obligationId: p.obligationId,
        currency: p.currency,
        amountMinor: p.amountMinor,
        channel: p.channel as NonNullable<PreparedCollection["channel"]>,
        reference: p.reference,
        fundsConfirmed: p.fundsConfirmed,
        fingerprint: p.fingerprint,
        createdBy: actor.id,
        createdAt: instant.toISOString(),
      },
      instant,
    );
  }

  /**
   * One customer's collections that are still open, each with what the ledger says about it
   * (owner-only, READ-ONLY — it writes nothing).
   *
   *   recorded      the ledger has a settlement under the original key and it matches the intent;
   *   not_recorded  the ledger was read successfully and has none — this says nothing about whether external money was received;
   *   conflict      a settlement exists under the key but is a DIFFERENT payment — fail closed;
   *   unknown       the lookup itself failed — never reported as "not recorded".
   */
  openCollections(customerId: string): Array<{
    readonly attempt: AttemptRecord;
    readonly status: "recorded" | "not_recorded" | "conflict" | "unknown";
  }> {
    this.requireOwner();
    if (typeof customerId !== "string" || customerId.length === 0) return [];
    const open = this.deps.ledger.listOpenAttempts(customerId);
    return open.map((attempt) => {
      try {
        const settled = this.deps.ledger.findSettlementByIdempotencyKey(attempt.key);
        if (!settled) return { attempt, status: "not_recorded" as const };
        return { attempt, status: settled.fingerprint === attempt.fingerprint ? ("recorded" as const) : ("conflict" as const) };
      } catch {
        return { attempt, status: "unknown" as const };
      }
    });
  }

  /** Validates a draft completely and normalises it. Writes nothing. */
  private prepareCollection(draft: SettlementDraft): PreparedCollection {
    if (typeof draft.obligationId !== "string" || draft.obligationId.length === 0) {
      throw new DomainError("INVALID_INPUT", "A payment needs an obligation");
    }
    if (typeof draft.idempotencyKey !== "string" || !KEY_PATTERN.test(draft.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "A valid idempotency key is required");
    }
    const key = draft.idempotencyKey;
    let channelName: CollectionChannel | null = null;
    let method: SettlementMethod;
    let provider: SettlementProvider | null = null;
    let reference: string | null = null;
    let fundsConfirmed: boolean | null = null;
    if (draft.channel !== undefined) {
      if (!isCollectionChannel(draft.channel)) {
        throw new DomainError("INVALID_PAYMENT_METHOD", "That payment method is not one this till records");
      }
      const channel: CollectionChannel = draft.channel;
      channelName = channel;
      ({ method, provider } = channelStorage(channel));
      reference = cleanPaymentReference(draft.reference, channel);
      if (draft.fundsConfirmed !== undefined && draft.fundsConfirmed !== null && typeof draft.fundsConfirmed !== "boolean") {
        throw new DomainError("INVALID_INPUT", "The confirmation must be true or false");
      }
      if (channel === "whish" || channel === "bank_transfer" || channel === "other") {
        // 🔴 NEVER INFERRED. An operator-recorded external payment is only a payment once the operator
        // says the money really arrived; this till does not contact Whish or a bank.
        if (draft.fundsConfirmed !== true) {
          throw new DomainError("FUNDS_NOT_CONFIRMED", "Confirm that the money was actually received");
        }
        fundsConfirmed = true;
      } else if (channel === "card") {
        fundsConfirmed = draft.fundsConfirmed === true ? true : null;
      } else if (draft.fundsConfirmed === true) {
        throw new DomainError("INVALID_INPUT", "A cash payment carries no confirmation");
      }
    } else {
      if (!isSettlementMethod(draft.method)) {
        throw new DomainError("INVALID_PAYMENT_METHOD", "That payment method is not one this till records");
      }
      if (draft.reference !== undefined || draft.fundsConfirmed !== undefined) {
        throw new DomainError("INVALID_INPUT", "A payment reference needs a payment channel");
      }
      method = draft.method;
    }

    const obligation = this.deps.ledger.findObligationById(draft.obligationId);
    if (!obligation) throw new DomainError("INVALID_INPUT", "That obligation no longer exists");

    // 🔴 THE CALLER MUST NAME THE PARTY IT THINKS IT IS PAYING, and it is checked rather than
    // trusted. A screen that has drifted onto another account pays the wrong person otherwise, and
    // two customers really can share a name — so the id is compared, never the name.
    if (typeof draft.partyId !== "string" || draft.partyId !== obligation.partyId) {
      throw new DomainError("INVALID_INPUT", "That payment does not belong to this account");
    }

    const amount = ledgerAmount(draft.amountMinor, obligation.currency);

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          obligationId: obligation.id,
          partyId: obligation.partyId,
          amountMinor: amount.minor.toString(),
          currency: amount.currency,
          method,
          // Only when present, so a cash collection hashes EXACTLY as it did before migration 17 and
          // an older key still replays. A different provider, reference or confirmation is a
          // different payment and conflicts.
          ...(provider !== null ? { provider } : {}),
          ...(reference !== null ? { reference } : {}),
          ...(fundsConfirmed !== null ? { fundsConfirmed } : {}),
        }),
      )
      .digest("hex");

    return {
      key,
      obligation,
      partyId: obligation.partyId,
      obligationId: obligation.id,
      currency: obligation.currency,
      amountMinor: amount.minor,
      method,
      provider,
      reference,
      fundsConfirmed,
      channel: channelName,
      fingerprint,
    };
  }

  /** The settlement transaction. Re-reads the durable owner role INSIDE it, then writes or replays. */
  private commitCollection(p: PreparedCollection, actor: LedgerActor, recheckReceipts: boolean): PostResult<SettlementRecord> {
    const { key, obligation, provider, reference, fundsConfirmed, method, fingerprint } = p;
    const amount = { minor: p.amountMinor };
    const instant = this.now();
    return this.deps.transact(() => {
      // The owner may be demoted between request validation and acquiring the write transaction.
      // Re-read the durable role under BEGIN IMMEDIATE, before a replay or any financial write.
      const liveActor = this.requireOwner();
      if (liveActor.id !== actor.id) {
        throw new DomainError("NOT_AUTHORIZED", "The signed-in operator changed during the payment");
      }
      const prior = this.deps.ledger.findSettlementByIdempotencyKey(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That payment key was already used for a different payment");
        }
        this.deps.ledger.resolveAttempt(key, "recorded", instant);
        return { record: prior.settlement, duplicate: true };
      }

      // 🔴 Migration 18: the receipt lock is re-read INSIDE this transaction for every settlement that is
      // about to be WRITTEN — a new attempt, an already-open attempt continuing, or the legacy settle().
      // A replay of a settlement that already committed returned above and is never held.
      if (recheckReceipts) this.assertNoUnresolvedReceipts(p.partyId);

      // 🔴 ONE PROVIDER TRANSACTION, ONE COLLECTION. The same Whish or bank reference under a new key
      // would count the same money twice. (The unique index is the backstop for a race.)
      // Migration 18: a reference already on a real RECEIPT is just as taken (the database refuses it too,
      // by trigger, but the owner should read the same sentence rather than an internal error).
      if (
        provider !== null &&
        reference !== null &&
        (this.deps.ledger.findSettlementByProviderReference(provider, reference) ||
          this.deps.receipts?.findByProviderReference(provider, reference))
      ) {
        throw new DomainError("DUPLICATE_PAYMENT_REFERENCE", "That payment reference is already recorded");
      }

      const paid = this.deps.ledger.settledTotal(obligation.id);
      if (paid + amount.minor > obligation.amountMinor) {
        const outstandingMinor = obligation.amountMinor - paid;
        throw new DomainError(
          "INVALID_AMOUNT",
          `That is more than is owed; ${formatDecimal(money(outstandingMinor, obligation.currency))} ${obligation.currency} remains`,
          "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING",
          { outstandingMinor, currency: obligation.currency },
        );
      }

      const record: SettlementRecord = {
        id: this.newId(),
        obligationId: obligation.id,
        currency: obligation.currency,
        idempotencyKey: key,
        amountMinor: amount.minor,
        method,
        provider,
        reference,
        fundsConfirmed,
        settledBy: actor.id,
        settledAt: instant.toISOString(),
        businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
      };
      this.deps.ledger.insertSettlement({ ...record, requestFingerprint: fingerprint });
      // The settlement and the closing of its attempt are ONE transaction: an attempt is never open
      // for a payment that committed.
      this.deps.ledger.resolveAttempt(key, "recorded", instant);
      return { record, duplicate: false };
    });
  }

  // ── M17B-S1 · ONE external receipt, SEVERAL debts of ONE customer (migration 18) ──────────────

  private receiptsRepo(): ReceiptRepository {
    if (!this.deps.receipts) throw new DomainError("NOT_AVAILABLE", "Receipts are not available on this terminal");
    return this.deps.receipts;
  }

  /**
   * Validates a receipt request completely and normalises it. WRITES NOTHING, so a refused request
   * leaves no trace. Nothing is inferred: the confirmation, the currency, the reference and every
   * share must be stated, and a share that is not exactly accounted for refuses the whole request.
   */
  private prepareReceipt(draft: ReceiptDraft): PreparedReceipt {
    if (typeof draft.idempotencyKey !== "string" || !KEY_PATTERN.test(draft.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "A valid idempotency key is required");
    }
    if (!isCollectionChannel(draft.channel)) {
      throw new DomainError("INVALID_PAYMENT_METHOD", "That payment method is not one this till records");
    }
    const channel = draft.channel;
    // 🔴 ONLY A REAL EXTERNAL RECEIPT. Cash, card and "other" are not shared across debts in this slice.
    if (channel !== "whish" && channel !== "bank_transfer") {
      throw new DomainError("RECEIPT_CHANNEL_NOT_ALLOWED", "Only a Whish or bank transfer can be shared across debts");
    }
    const reference = cleanPaymentReference(draft.reference, channel);
    if (reference === null) throw new DomainError("INVALID_INPUT", "Write the payment reference");
    if (draft.fundsConfirmed !== true) {
      throw new DomainError("FUNDS_NOT_CONFIRMED", "Confirm that the money was actually received");
    }
    if (typeof draft.customerId !== "string" || draft.customerId.length === 0) {
      throw new DomainError("INVALID_INPUT", "A receipt needs its customer");
    }
    const customer = this.deps.parties.findById(draft.customerId);
    if (!customer || customer.kind !== "customer" || customer.is_active !== 1) {
      throw new DomainError("PARTY_NOT_FOUND", "That active customer account no longer exists");
    }
    if (typeof draft.currency !== "string") throw new DomainError("INVALID_INPUT", "A receipt needs its currency");
    const total = ledgerAmount(draft.totalMinor, draft.currency);

    if (!Array.isArray(draft.allocations)) throw new DomainError("INVALID_INPUT", "A receipt needs its allocations");
    if (draft.allocations.length < 2) {
      throw new DomainError("RECEIPT_NEEDS_TWO_DEBTS", "Share a receipt across at least two debts");
    }
    if (draft.allocations.length > MAX_RECEIPT_ALLOCATIONS) {
      throw new DomainError("INVALID_INPUT", "Too many debts in one receipt");
    }
    const seen = new Set<string>();
    const lines: Array<{ obligationId: string; amountMinor: bigint }> = [];
    let sum = 0n;
    for (const raw of draft.allocations as ReadonlyArray<unknown>) {
      const a = raw as { obligationId?: unknown; amountMinor?: unknown } | null;
      if (!a || typeof a !== "object" || typeof a.obligationId !== "string" || a.obligationId.length === 0) {
        throw new DomainError("INVALID_INPUT", "Every share needs its debt");
      }
      if (seen.has(a.obligationId)) {
        throw new DomainError("RECEIPT_ALLOCATION_MISMATCH", "A debt can appear only once in a receipt");
      }
      seen.add(a.obligationId);
      const ob = this.deps.ledger.findObligationById(a.obligationId);
      if (!ob) throw new DomainError("INVALID_INPUT", "That obligation no longer exists");
      // 🔴 ONE CUSTOMER, RECEIVABLES ONLY. A supplier's payable has a supplier as its party, so the id
      // comparison already refuses it; direction is checked too rather than trusted.
      if (ob.partyId !== customer.id || ob.partyKind !== "customer" || ob.direction !== "receivable") {
        throw new DomainError("INVALID_INPUT", "That payment does not belong to this account");
      }
      if (ob.currency !== total.currency) {
        throw new DomainError("MIXED_CURRENCY", `That debt is in ${ob.currency}, not ${total.currency}`);
      }
      const share = ledgerAmount(a.amountMinor, ob.currency);
      sum += share.minor;
      lines.push({ obligationId: ob.id, amountMinor: share.minor });
    }
    // 🔴 EXACT, NEVER APPROXIMATE: no remainder, no excess, no "credit balance".
    if (sum !== total.minor) {
      throw new DomainError("RECEIPT_ALLOCATION_MISMATCH", "The shares must add up to the total received");
    }
    lines.sort((x, y) => (x.obligationId < y.obligationId ? -1 : x.obligationId > y.obligationId ? 1 : 0));
    const provider: ReceiptProvider = channel;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          kind: "receipt",
          customerId: customer.id,
          currency: total.currency,
          provider,
          reference,
          fundsConfirmed: true,
          totalMinor: total.minor.toString(),
          allocations: lines.map((l) => [l.obligationId, l.amountMinor.toString()]),
        }),
      )
      .digest("hex");
    return {
      key: draft.idempotencyKey,
      customerId: customer.id,
      currency: total.currency,
      totalMinor: total.minor,
      provider,
      reference,
      lines,
      fingerprint,
    };
  }

  /**
   * Records ONE real external receipt and shares it across two or more debts of one customer.
   *
   * Same two-transaction shape as a collection: the durable intent first (under the ORIGINAL key),
   * then ONE transaction that writes every allocation, then the receipt row that SEALS them, then
   * closes its own attempt. The owner role is re-read inside BOTH transactions.
   */
  recordAllocatedReceipt(draft: ReceiptDraft): ReceiptResult {
    const actor = this.requireOwner();
    const repo = this.receiptsRepo();
    const prepared = this.prepareReceipt(draft);
    const instant = this.now();
    this.deps.transact(() => {
      const live = this.requireOwner();
      if (live.id !== actor.id) {
        throw new DomainError("NOT_AUTHORIZED", "The signed-in operator changed during the payment");
      }
      this.beginReceiptAttempt(prepared, actor, instant);
    });
    try {
      return this.commitReceipt(prepared, actor);
    } catch (error) {
      // A DomainError inside the receipt transaction rolled everything back: nothing exists under this
      // key, so the attempt is closed as not recorded — and then it can never post (database trigger).
      // Anything else (a COMMIT-time failure, a lost handle) proves nothing: the attempt stays OPEN
      // and the ledger is asked later. An authorization failure writes nothing more.
      // A HOLD (COLLECTION_UNRESOLVED) is not a verdict on this payment: the attempt stays open and
      // byte-identical so the original key and intent retry once the earlier collection is reconciled.
      if (
        error instanceof DomainError &&
        error.code !== "NOT_LOGGED_IN" &&
        error.code !== "NOT_AUTHORIZED" &&
        error.code !== "COLLECTION_UNRESOLVED"
      ) {
        try {
          this.deps.transact(() => {
            if (!repo.findByKey(prepared.key)) repo.resolveAttempt(prepared.key, "not_recorded", this.now());
          });
        } catch {
          /* leave it open; the read side will resolve it */
        }
      }
      throw error;
    }
  }

  private beginReceiptAttempt(p: PreparedReceipt, actor: LedgerActor, instant: Date): void {
    const repo = this.receiptsRepo();
    // A receipt already under this key needs no new intent: commitReceipt answers the replay.
    if (repo.findByKey(p.key)) return;
    const existing = repo.findAttempt(p.key);
    if (existing) {
      if (existing.fingerprint !== p.fingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That payment key was already used for a different payment");
      }
      // Closing is FINAL: a late retry of a key closed as not recorded must never post money.
      if (existing.resolution === "not_recorded") {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That receipt attempt is closed as not recorded");
      }
      if (existing.resolution === "recorded") {
        throw new DomainError("LEDGER_INTEGRITY", "A recorded receipt attempt has no matching receipt");
      }
      return; // an OPEN attempt of the SAME intent continues under its original key
    }
    // 🔴 NOTHING NEW WHILE AN EARLIER MONEY-IN FOR THIS CUSTOMER IS UNANSWERED. Open collection attempts
    // are only READ here (M17A's own behaviour is not touched); open receipt attempts are classified
    // from the ledger and, when it can answer, closed.
    this.assertNoUnresolvedCollections(p.customerId);
    for (const open of repo.listOpenAttempts(p.customerId)) {
      const status = this.classifyReceiptAttempt(open);
      if (status === "unknown" || status === "conflict") {
        throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
      }
      repo.resolveAttempt(open.key, status, instant);
    }
    repo.insertAttempt({
      key: p.key,
      customerId: p.customerId,
      currency: p.currency,
      amountMinor: p.totalMinor,
      provider: p.provider,
      reference: p.reference,
      fingerprint: p.fingerprint,
      createdBy: actor.id,
      createdAt: instant.toISOString(),
      lines: p.lines,
    });
  }

  /**
   * 🔴 THE REVERSE LOCK. A receipt may not be started — and no allocation may be written or sealed — while
   * an earlier COLLECTION attempt of this customer is `unknown` (its settlement lookup failed) or
   * `conflict` (a settlement under its key is a different payment). A listing that itself fails is
   * treated as unresolved. `not_recorded` and `recorded` do not lock: the ledger answered.
   */
  private assertNoUnresolvedCollections(customerId: string): void {
    let open: ReturnType<LedgerRepository["listOpenAttempts"]>;
    try {
      open = this.deps.ledger.listOpenAttempts(customerId);
    } catch {
      throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
    }
    for (const attempt of open) {
      let settled: ReturnType<LedgerRepository["findSettlementByIdempotencyKey"]>;
      try {
        settled = this.deps.ledger.findSettlementByIdempotencyKey(attempt.key);
      } catch {
        throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
      }
      if (settled && settled.fingerprint !== attempt.fingerprint) {
        throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
      }
    }
  }

  /**
   * 🔴 RECEIPT-VERSUS-INTENT, derived from the STORED ROWS and never from a stored fingerprint. A receipt
   * is "what was intended" only if its customer, currency, total, provider, reference and allocation
   * COUNT equal the intent AND its allocations are exactly the intent's lines (same debt, same amount),
   * with no allocation left over. The database seal enforces the same thing at write time.
   */
  private receiptMatchesIntent(
    receipt: ReceiptRecord,
    allocations: ReadonlyArray<AllocationRecord>,
    intent: {
      readonly customerId: string;
      readonly currency: string;
      readonly amountMinor: bigint;
      readonly provider: ReceiptProvider;
      readonly reference: string;
      readonly lines: ReadonlyArray<{ readonly obligationId: string; readonly amountMinor: bigint }>;
    },
  ): boolean {
    if (
      receipt.customerId !== intent.customerId ||
      receipt.currency !== intent.currency ||
      receipt.amountMinor !== intent.amountMinor ||
      receipt.provider !== intent.provider ||
      receipt.reference !== intent.reference ||
      receipt.allocationCount !== intent.lines.length ||
      allocations.length !== intent.lines.length
    ) {
      return false;
    }
    const key = (x: { obligationId: string; amountMinor: bigint }) => `${x.obligationId}:${x.amountMinor.toString()}`;
    const want = intent.lines.map(key).sort();
    const have = allocations.map(key).sort();
    return want.every((v, i) => v === have[i]);
  }

  /** The receipt transaction: re-reads the owner, replays or writes allocations then the SEAL. */
  private commitReceipt(p: PreparedReceipt, actor: LedgerActor): ReceiptResult {
    const repo = this.receiptsRepo();
    const instant = this.now();
    return this.deps.transact(() => {
      const liveActor = this.requireOwner();
      if (liveActor.id !== actor.id) {
        throw new DomainError("NOT_AUTHORIZED", "The signed-in operator changed during the payment");
      }
      const prior = repo.findByKey(p.key);
      if (prior) {
        if (prior.fingerprint !== p.fingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That payment key was already used for a different payment");
        }
        // 🔴 A stored fingerprint is not trusted: the receipt must verify AND equal what was asked, from its own
        // rows. An inconsistent receipt is never answered as "recorded" and never closes the attempt.
        const stored = repo.listAllocations(prior.receipt.id);
        if (
          !repo.receiptIntegrity(prior.receipt.id).ok ||
          !this.receiptMatchesIntent(prior.receipt, stored, { ...p, amountMinor: p.totalMinor })
        ) {
          throw new DomainError("LEDGER_INTEGRITY", "The stored receipt does not match what was recorded for this key");
        }
        repo.resolveAttempt(p.key, "recorded", instant);
        return { receipt: prior.receipt, allocations: stored, duplicate: true };
      }
      const attempt = repo.findAttempt(p.key);
      if (attempt?.resolution === "not_recorded") {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That receipt attempt is closed as not recorded");
      }
      // 🔴 THE REVERSE LOCK, re-read INSIDE this transaction before ANY write: an open attempt continuing under
      // its own key may not write allocations or seal while an earlier collection is unknown or in conflict.
      this.assertNoUnresolvedCollections(p.customerId);

      // 🔴 ONE REAL PROVIDER TRANSACTION, ONE RECORD — as a receipt AND as a direct collection.
      if (repo.findByProviderReference(p.provider, p.reference) || this.deps.ledger.findSettlementByProviderReference(p.provider, p.reference)) {
        throw new DomainError("DUPLICATE_PAYMENT_REFERENCE", "That payment reference is already recorded");
      }
      // The customer may have been archived since validation.
      const customer = this.deps.parties.findById(p.customerId);
      if (!customer || customer.kind !== "customer" || customer.is_active !== 1) {
        throw new DomainError("PARTY_NOT_FOUND", "That active customer account no longer exists");
      }

      const receiptId = this.newId();
      const day = businessDateOf(instant, this.deps.terminal.timeZone);
      for (const line of p.lines) {
        const ob = this.deps.ledger.findObligationById(line.obligationId);
        if (!ob || ob.partyId !== p.customerId || ob.direction !== "receivable" || ob.currency !== p.currency) {
          throw new DomainError("INVALID_INPUT", "That payment does not belong to this account");
        }
        // The LIVE outstanding, re-read now: a collection may have reduced this debt since validation.
        const paid = this.deps.ledger.settledTotal(ob.id);
        if (paid + line.amountMinor > ob.amountMinor) {
          const outstandingMinor = ob.amountMinor - paid;
          throw new DomainError(
            "INVALID_AMOUNT",
            `That is more than is owed; ${formatDecimal(money(outstandingMinor, ob.currency))} ${ob.currency} remains`,
            "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING",
            { outstandingMinor, currency: ob.currency },
          );
        }
        repo.insertAllocation({
          id: this.newId(),
          receiptId,
          obligationId: ob.id,
          currency: ob.currency,
          // An INTERNAL key, never shown and never a provider reference: it only has to be unique.
          idempotencyKey: `rcpt-${createHash("sha256").update(`${p.key}:${ob.id}`).digest("hex").slice(0, 32)}`,
          fingerprint: p.fingerprint,
          amountMinor: line.amountMinor,
          settledBy: actor.id,
          settledAt: instant.toISOString(),
          businessDate: day,
        });
      }
      // The SEAL, last: its trigger verifies the allocations just written.
      repo.insertReceipt({
        id: receiptId,
        customerId: p.customerId,
        currency: p.currency,
        amountMinor: p.totalMinor,
        provider: p.provider,
        reference: p.reference,
        allocationCount: p.lines.length,
        idempotencyKey: p.key,
        fingerprint: p.fingerprint,
        receivedBy: actor.id,
        receivedAt: instant.toISOString(),
        businessDate: day,
      });
      repo.resolveAttempt(p.key, "recorded", instant);
      const stored = repo.findByKey(p.key);
      if (!stored || !repo.receiptIntegrity(receiptId).ok) {
        throw new DomainError("LEDGER_INTEGRITY", "The receipt could not be verified after it was written");
      }
      return { receipt: stored.receipt, allocations: repo.listAllocations(receiptId), duplicate: false };
    });
  }

  /**
   * One customer's receipts that are still open, each with what the ledger says (owner-only,
   * READ-ONLY):
   *
   *   recorded      a receipt exists under the original key, matches the intent and verifies;
   *   not_recorded  the ledger was read successfully and holds none — this says nothing about whether
   *                 the external money was received;
   *   conflict      something under the key is a DIFFERENT payment, or does not verify — fail closed;
   *   unknown       the lookup itself failed — never reported as "not recorded".
   */
  openReceipts(customerId: string): Array<{
    readonly attempt: StoredReceiptAttempt;
    readonly status: "recorded" | "not_recorded" | "conflict" | "unknown";
  }> {
    this.requireOwner();
    if (typeof customerId !== "string" || customerId.length === 0 || !this.deps.receipts) return [];
    return this.deps.receipts.listOpenAttempts(customerId).map((attempt) => ({
      attempt,
      status: this.classifyReceiptAttempt(attempt),
    }));
  }

  /** What the ledger says about ONE open receipt attempt. A failed lookup is `unknown`, never "not recorded". */
  private classifyReceiptAttempt(attempt: StoredReceiptAttempt): "recorded" | "not_recorded" | "conflict" | "unknown" {
    const repo = this.deps.receipts;
    if (!repo) return "unknown";
    try {
      const found = repo.findByKey(attempt.key);
      if (!found) return "not_recorded";
      // 🔴 "recorded" needs the receipt to VERIFY and to EQUAL the intent from its own rows; a matching stored
      // fingerprint alone proves nothing (a receipt with other shares can carry the same fingerprint).
      const ok =
        found.fingerprint === attempt.fingerprint &&
        repo.receiptIntegrity(found.receipt.id).ok &&
        this.receiptMatchesIntent(found.receipt, repo.listAllocations(found.receipt.id), attempt);
      return ok ? "recorded" : "conflict";
    } catch {
      return "unknown";
    }
  }

  /**
   * 🔴 THE AUTHORITATIVE LOCK, AT THE SERVICE BOUNDARY. A new money-in for this customer is refused
   * while an earlier allocated-receipt attempt is genuinely `unknown` (the ledger could not be read) or
   * `conflict` (something else sits under its key, or it does not verify). `not_recorded` and
   * `recorded` do NOT lock: the ledger answered. The renderer's own locking is a convenience and is
   * never what this relies on. A listing that itself fails is treated as unknown — it fails closed.
   *
   * `not_recorded` says only that ALZABT POS holds no receipt under that key; it is never read as proof
   * that real external funds did not arrive, which is why the operator is told to check the payment.
   */
  private assertNoUnresolvedReceipts(customerId: string): void {
    const repo = this.deps.receipts;
    if (!repo) return;
    let open: StoredReceiptAttempt[];
    try {
      open = repo.listOpenAttempts(customerId);
    } catch {
      throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
    }
    for (const attempt of open) {
      const status = this.classifyReceiptAttempt(attempt);
      if (status === "unknown" || status === "conflict") {
        throw new DomainError("COLLECTION_UNRESOLVED", "An earlier payment could not be confirmed yet");
      }
    }
  }

  /** The receipt a given key committed, or null — the ledger's own answer after an unexpected fault. */
  receiptForIdempotencyKey(key: string): ReceiptRecord | null {
    this.requireOwner();
    if (typeof key !== "string" || key.length === 0 || !this.deps.receipts) return null;
    const repo = this.deps.receipts;
    const found = repo.findByKey(key);
    if (!found) return null;
    // 🔴 An unexpected-failure answer may claim "recorded" ONLY for a receipt that verifies and equals the intent
    // stored under its key. An inconsistent receipt throws, which the caller reports as UNKNOWN (never as
    // recorded, never as not recorded).
    const intent = repo.findAttempt(key);
    if (
      !repo.receiptIntegrity(found.receipt.id).ok ||
      (intent && !this.receiptMatchesIntent(found.receipt, repo.listAllocations(found.receipt.id), intent))
    ) {
      throw new DomainError("LEDGER_INTEGRITY", "The stored receipt could not be verified against its intent");
    }
    return found.receipt;
  }

  /** Which receipt (if any) each settlement is an allocation of — display only, never money. */
  receiptsOfSettlements(settlementIds: ReadonlyArray<string>): Map<string, ReceiptRecord> {
    this.requireOwner();
    return this.deps.receipts ? this.deps.receipts.receiptsOfSettlements(settlementIds) : new Map();
  }
}
