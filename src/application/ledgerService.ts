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
import {
  type ObligationDirection,
  type ObligationRecord,
  type ObligationSource,
  type SettlementMethod,
  type SettlementRecord,
  balancesByCurrency,
  isObligationDirection,
  isObligationSource,
  isSettlementMethod,
  ledgerAmount,
  outstanding,
  partyKindFor,
  sourceRef as cleanSourceRef,
} from "../domain/ledger";
import type { LedgerRepository } from "../persistence/ledgerRepository";
import type { PartyRepository } from "../persistence/partyRepository";

/** Who is acting. Supplied by the POS service, which owns the session and the live role. */
export interface LedgerActor {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "admin" | "cashier";
}

export interface LedgerServiceDeps {
  readonly ledger: LedgerRepository;
  readonly parties: PartyRepository;
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
}

/** What a caller gets back. `duplicate` distinguishes a retry from a fresh posting. */
export interface PostResult<T> {
  readonly record: T;
  readonly duplicate: boolean;
}

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
    const amount = ledgerAmount(draft.amountMinor, draft.currency);

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

  /**
   * Record money actually paid against one obligation. Partial or full.
   *
   * The overpayment check is here AND in a database trigger. This one exists so the merchant reads
   * "that is more than is owed" with the real figure; the trigger is the authority, and it is what
   * holds if two payments are ever attempted at once.
   */
  settle(draft: SettlementDraft): PostResult<SettlementRecord> {
    const actor = this.requireOwner();

    if (typeof draft.obligationId !== "string" || draft.obligationId.length === 0) {
      throw new DomainError("INVALID_INPUT", "A payment needs an obligation");
    }
    if (typeof draft.idempotencyKey !== "string" || !KEY_PATTERN.test(draft.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "A valid idempotency key is required");
    }
    if (!isSettlementMethod(draft.method)) {
      throw new DomainError("INVALID_PAYMENT_METHOD", "That payment method is not one this till records");
    }
    const key = draft.idempotencyKey;
    const method: SettlementMethod = draft.method;

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
        }),
      )
      .digest("hex");

    const instant = this.now();
    return this.deps.transact(() => {
      const prior = this.deps.ledger.findSettlementByIdempotencyKey(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That payment key was already used for a different payment");
        }
        return { record: prior.settlement, duplicate: true };
      }

      const paid = this.deps.ledger.settledTotal(obligation.id);
      if (paid + amount.minor > obligation.amountMinor) {
        throw new DomainError(
          "INVALID_AMOUNT",
          `That is more than is owed; ${obligation.amountMinor - paid} ${obligation.currency} remains`,
        );
      }

      const record: SettlementRecord = {
        id: this.newId(),
        obligationId: obligation.id,
        currency: obligation.currency,
        idempotencyKey: key,
        amountMinor: amount.minor,
        method,
        settledBy: actor.id,
        settledAt: instant.toISOString(),
        businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
      };
      this.deps.ledger.insertSettlement({ ...record, requestFingerprint: fingerprint });
      return { record, duplicate: false };
    });
  }
}
