/**
 * Customer advances — RECORD (Cash / Whish Money) with durable crash recovery. Backend only.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHO: the OWNER and the CASHIER may record an advance (owner decision D1, DEC-35q). An admin may
 * not (no admin account exists yet — the same rule `ledgerService` applies). Applying and refunding
 * an advance are owner-only and are NOT in this file; the database already enforces that by trigger.
 * This service deliberately lives outside `ledgerService`, whose every read and write is owner-only.
 *
 * 🔴 WHAT AN ADVANCE IS: one row in `customer_advances`. No sale, tender, settlement, receipt or
 * obligation is written. It is not sales revenue and it reduces no debt by itself (D2, D8).
 *
 * 🔴 CRASH SAFETY (G1, migration 20, owner decision D5). A cash advance must never be recorded twice
 * because a reply was lost, and a genuine second advance (same customer, same amount, same day) must
 * never be refused for looking similar. So the ONLY identity is the request's own key:
 *
 *   Tx1  the intent (key, customer, amount, channel, reference, confirmation, fingerprint) commits
 *        BEFORE any money row can exist;
 *   Tx2  the ADV number, the advance and the intent's resolution commit together (one transaction:
 *        a failure rolls the number back too — no gap, no reuse; owner decision D7);
 *   UI   the receipt is shown, then `acknowledge(key)`.
 *
 * After a crash or a lost reply `pending()` answers every unacknowledged intent FROM THE LEDGER:
 *   recorded       the advance exists under that key → the same ADV receipt again;
 *   open           provably no advance under that key → finish it under the SAME key, or close it;
 *   closed         closed as not recorded, waiting for the operator to have seen that;
 *   unknown        the lookup itself failed → never reported as "not recorded".
 * While a customer has an OPEN intent, a NEW advance for that customer is refused
 * (ADVANCE_UNRESOLVED): the operator must first settle what happened to the money already handled.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { businessDateOf } from "../domain/businessDay";
import { DomainError } from "../domain/errors";
import { type ObligationRecord, cleanPaymentReference, ledgerAmount } from "../domain/ledger";
import type {
  AdvanceChannel,
  AdvanceCorrectionRecord,
  AdvanceIntent,
  AdvanceApplicationRecord,
  AdvanceRecord,
  AdvanceRepository,
} from "../persistence/advanceRepository";
import type { LedgerRepository } from "../persistence/ledgerRepository";
import type { CreateCreditSaleInput, CreateCreditSaleResult } from "./posService";
import type { PartyRepository } from "../persistence/partyRepository";

export interface AdvanceActor {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "admin" | "cashier";
}

export interface AdvanceServiceDeps {
  readonly advances: AdvanceRepository;
  /** Read-only use: the migration-19 reference registry (`isReferenceRegistered`). */
  readonly ledger: LedgerRepository;
  readonly parties: PartyRepository;
  /** The live operator, re-read on every call. `null` means nobody is signed in. */
  readonly actor: () => AdvanceActor | null;
  /** `db.transaction(fn).immediate()` — the one connection. */
  readonly transact: <T>(fn: () => T) => T;
  readonly terminal: { readonly timeZone: string; readonly currency: string };
  readonly now?: () => Date;
  readonly newId?: () => string;
  /**
   * DEC-35x — the till's OWN owner-only credit sale (PosService.createCustomerCreditSale), called inside
   * this service's transaction so the sale, its receivable and the advance application commit together.
   * Absent → sellOnAdvance answers NOT_AVAILABLE.
   */
  readonly creditSale?: (input: CreateCreditSaleInput) => CreateCreditSaleResult;
}

export interface RecordAdvanceDraft {
  readonly customerId: unknown;
  readonly amountMinor: unknown;
  readonly channel: unknown;
  readonly reference?: unknown;
  readonly fundsConfirmed?: unknown;
  readonly idempotencyKey: unknown;
}

export interface AdvanceResult {
  readonly record: AdvanceRecord;
  /** True when this exact request had already been recorded: nothing new was written. */
  readonly duplicate: boolean;
}

export type PendingAdvance =
  | { readonly status: "recorded"; readonly key: string; readonly advance: AdvanceRecord }
  | { readonly status: "open"; readonly key: string; readonly intent: AdvanceIntent; readonly createdAt: string }
  | { readonly status: "closed"; readonly key: string; readonly intent: AdvanceIntent; readonly createdAt: string }
  | { readonly status: "unknown"; readonly key: string; readonly createdAt: string };

export interface CorrectAdvanceDraft {
  readonly advanceId: unknown;
  /** 'not_received' (the money never came) or 'replaced' (it came; its details were wrong). */
  readonly kind: unknown;
  readonly reason: unknown;
  /** The owner's explicit declaration: required for 'not_received' and for a SMALLER replacement. */
  readonly confirmNotReceived?: unknown;
  readonly customerId?: unknown;
  readonly amountMinor?: unknown;
  readonly channel?: unknown;
  readonly reference?: unknown;
  readonly fundsConfirmed?: unknown;
  readonly idempotencyKey: unknown;
}

export interface CorrectionResult {
  readonly correction: AdvanceCorrectionRecord;
  readonly original: AdvanceRecord;
  readonly successor: AdvanceRecord | null;
  readonly duplicate: boolean;
}

interface PreparedCorrection {
  readonly key: string;
  readonly kind: "not_received" | "replaced";
  readonly original: AdvanceRecord;
  readonly reason: string;
  readonly fundsNotReceived: boolean;
  readonly successor: {
    readonly customerId: string;
    readonly amountMinor: bigint;
    readonly channel: AdvanceChannel;
    readonly reference: string | null;
    readonly sameReference: boolean;
  } | null;
  readonly fingerprint: string;
}

export interface AdvanceView {
  readonly record: AdvanceRecord;
  readonly number: string;
  readonly customerName: string;
  readonly receivedByName: string;
  readonly correctsNumber: string | null;
}

export interface AdvanceCorrectionView {
  readonly record: AdvanceCorrectionRecord;
  readonly correctedByName: string;
  readonly successorNumber: string | null;
}

export interface AdvanceStatementLine {
  readonly advance: AdvanceRecord;
  /** The live, applicable balance of this advance — 0 once corrected. */
  readonly unusedMinor: bigint;
  /** Set when THIS advance was corrected (not received, or replaced by `successorNo`). */
  readonly correction: AdvanceCorrectionRecord | null;
  readonly successorNo: number | null;
  /** Set when THIS advance is itself a correction of ADV-`correctsNo`. */
  readonly correctsNo: number | null;
}

const hash = (o: unknown): string => createHash("sha256").update(JSON.stringify(o)).digest("hex");

/** `ADV-000001`: six digits, never reset (owner decision D7). Wider numbers are printed in full. */
export function formatAdvanceNo(docNo: number): string {
  return `ADV-${String(docNo).padStart(6, "0")}`;
}

const KEY_SHAPE = /^[A-Za-z0-9_-]{8,100}$/;
/** An application's key also names its settlement (`advapp-<key>`), which must stay within 100 characters. */
const APPLY_KEY_SHAPE = /^[A-Za-z0-9_-]{8,90}$/;

/** DEC-35x — apply an advance to ONE existing debt of the SAME customer (owner only). */
export interface ApplyAdvanceDraft {
  readonly advanceId: unknown;
  readonly obligationId: unknown;
  readonly amountMinor: unknown;
  readonly idempotencyKey: unknown;
}

/** DEC-35x — a NEW sale on the customer's account, paid (part or all) from that customer's advance. */
export interface SellOnAdvanceDraft {
  readonly idempotencyKey: unknown;
  readonly customerId: unknown;
  readonly lines: CreateCreditSaleInput["lines"];
  readonly expectedTotalMinor: unknown;
  readonly advanceId: unknown;
  readonly amountMinor: unknown;
}

export interface SellOnAdvanceResult {
  readonly sale: CreateCreditSaleResult["sale"];
  readonly obligation: CreateCreditSaleResult["obligation"];
  readonly application: ApplyAdvanceResult;
  readonly duplicate: boolean;
}

/** The sale key also names the application (`<key>-adv`), which must stay within 90 characters. */
const SALE_KEY_SHAPE = /^[A-Za-z0-9-]{8,86}$/;

export interface ApplyAdvanceResult {
  readonly application: AdvanceApplicationRecord;
  readonly advance: AdvanceRecord;
  /** Read back AFTER the commit: what this advance still holds, and what the debt still owes. */
  readonly unusedMinor: bigint;
  readonly debtOutstandingMinor: bigint;
  readonly duplicate: boolean;
}

export class AdvanceService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: AdvanceServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  /** Crash-test seams (tests/helpers/advanceCrashChild.ts). Nothing in src/ overrides them. */
  protected afterIntentCommitted(): void {}
  protected afterAdvanceCommitted(): void {}

  private requireRecorder(): AdvanceActor {
    const actor = this.deps.actor();
    if (!actor) throw new DomainError("NOT_LOGGED_IN", "Sign in first");
    if (actor.role !== "owner" && actor.role !== "cashier") {
      throw new DomainError("NOT_AUTHORIZED", "Only the owner or a cashier can record an advance");
    }
    return actor;
  }

  private sameOperator(actor: AdvanceActor): void {
    const live = this.requireRecorder();
    if (live.id !== actor.id) throw new DomainError("NOT_AUTHORIZED", "The signed-in operator changed during the advance");
  }

  /** Validates EVERYTHING before anything is written: a refused advance leaves no trace. */
  private prepare(draft: RecordAdvanceDraft, actor: AdvanceActor): AdvanceIntent {
    if (typeof draft.idempotencyKey !== "string" || !KEY_SHAPE.test(draft.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "An advance needs a request key");
    }
    if (typeof draft.customerId !== "string" || draft.customerId.length === 0) {
      throw new DomainError("INVALID_INPUT", "An advance needs a customer");
    }
    const customer = this.deps.parties.findById(draft.customerId);
    if (!customer || customer.kind !== "customer" || customer.is_active !== 1) {
      throw new DomainError("PARTY_NOT_FOUND", "That active customer account no longer exists");
    }
    const amount = ledgerAmount(draft.amountMinor, this.deps.terminal.currency);
    // DEC-35 / P3: a NEW receipt of money is Cash or Whish Money only (the schema still holds the old
    // methods for history; the service is the gate, as for every other payment).
    if (draft.channel !== "cash" && draft.channel !== "whish") {
      throw new DomainError("PAYMENT_METHOD_NOT_ACCEPTED", "This shop records new payments in cash or Whish Money only");
    }
    const channel: AdvanceChannel = draft.channel;
    const reference = cleanPaymentReference(draft.reference, channel);
    if (channel === "whish") {
      if (draft.fundsConfirmed !== true) {
        throw new DomainError("FUNDS_NOT_CONFIRMED", "Confirm that the Whish Money transfer has arrived");
      }
    } else if (draft.fundsConfirmed !== undefined && draft.fundsConfirmed !== null && draft.fundsConfirmed !== false) {
      throw new DomainError("INVALID_INPUT", "A cash advance carries no transfer confirmation");
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          customerId: customer.id,
          currency: amount.currency,
          amountMinor: amount.minor.toString(),
          channel,
          reference,
        }),
      )
      .digest("hex");
    return {
      key: draft.idempotencyKey,
      customerId: customer.id,
      currency: amount.currency,
      amountMinor: amount.minor,
      channel,
      reference,
      fundsConfirmed: channel === "whish",
      fingerprint,
      createdBy: actor.id,
    };
  }

  private referenceTaken(intent: AdvanceIntent): boolean {
    return intent.reference !== null && this.deps.ledger.isReferenceRegistered("whish", intent.reference);
  }

  /** Record a NEW advance (or answer an exact repeat of one). */
  record(draft: RecordAdvanceDraft): AdvanceResult {
    const actor = this.requireRecorder();
    const intent = this.prepare(draft, actor);

    // An exact repeat of a request that already committed: the same advance, nothing written.
    const done = this.deps.advances.findAdvanceByKey(intent.key);
    if (done) {
      if (done.fingerprint !== intent.fingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key was already used for a different advance");
      }
      return { record: done, duplicate: true };
    }

    // ── Tx1: the durable intent, committed before any money row can exist ──
    this.deps.transact(() => {
      this.sameOperator(actor);
      const existing = this.deps.advances.findAttempt(intent.key);
      if (existing) {
        if (existing.fingerprint !== intent.fingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key was already used for a different advance");
        }
        if (existing.resolution === "not_recorded") {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That advance was closed as not received");
        }
        if (existing.resolution === "recorded") {
          throw new DomainError("LEDGER_INTEGRITY", "A recorded advance attempt has no advance");
        }
        return; // the same OPEN intent continues under its original key
      }
      if (this.deps.advances.listOpenAttempts(intent.customerId).length > 0) {
        throw new DomainError("ADVANCE_UNRESOLVED", "An earlier advance for this customer is not settled yet");
      }
      if (this.referenceTaken(intent)) {
        throw new DomainError("DUPLICATE_PAYMENT_REFERENCE", "That payment reference is already recorded");
      }
      this.deps.advances.insertAttempt(intent, this.now().toISOString());
    });
    this.afterIntentCommitted();

    // ── Tx2: number + advance + resolution, together ──
    const record = this.commit(intent, actor);
    this.afterAdvanceCommitted();
    return { record, duplicate: false };
  }

  /**
   * Tx2 for an OPEN intent. A refusal the ledger can prove wrote nothing (the reference is taken, the
   * customer was deactivated) closes the intent as NOT recorded; anything else leaves it OPEN, so it
   * is answered later and never guessed.
   */
  private commit(intent: AdvanceIntent, actor: AdvanceActor): AdvanceRecord {
    try {
      return this.deps.transact(() => {
        this.sameOperator(actor);
        const customer = this.deps.parties.findById(intent.customerId);
        if (!customer || customer.kind !== "customer" || customer.is_active !== 1) {
          throw new DomainError("PARTY_NOT_FOUND", "That active customer account no longer exists");
        }
        if (this.referenceTaken(intent)) {
          throw new DomainError("DUPLICATE_PAYMENT_REFERENCE", "That payment reference is already recorded");
        }
        const instant = this.now();
        const record: AdvanceRecord = {
          id: this.newId(),
          docNo: this.deps.advances.issueAdvanceNumber(),
          customerId: intent.customerId,
          currency: intent.currency,
          amountMinor: intent.amountMinor,
          method: intent.channel === "whish" ? "external" : "cash",
          provider: intent.channel === "whish" ? "whish" : null,
          reference: intent.reference,
          key: intent.key,
          fingerprint: intent.fingerprint,
          // The operator who actually received the money (owner decision D1: the receiver is reported).
          receivedBy: intent.createdBy,
          receivedAt: instant.toISOString(),
          businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
        };
        this.deps.advances.insertAdvance(record);
        this.deps.advances.resolveAttempt(intent.key, "recorded", instant.toISOString());
        return record;
      });
    } catch (err) {
      if (err instanceof DomainError && (err.code === "DUPLICATE_PAYMENT_REFERENCE" || err.code === "PARTY_NOT_FOUND")) {
        this.deps.transact(() => this.deps.advances.resolveAttempt(intent.key, "not_recorded", this.now().toISOString()));
      }
      throw err;
    }
  }

  /** Every intent whose outcome has not been acknowledged, each answered from the ledger. Writes nothing. */
  pending(): PendingAdvance[] {
    this.requireRecorder();
    return this.deps.advances.listUnacknowledged().map((a): PendingAdvance => {
      try {
        const advance = this.deps.advances.findAdvanceByKey(a.key);
        if (advance) return { status: "recorded", key: a.key, advance };
        if (a.resolution === "not_recorded") return { status: "closed", key: a.key, intent: a, createdAt: a.createdAt };
        return { status: "open", key: a.key, intent: a, createdAt: a.createdAt };
      } catch {
        return { status: "unknown", key: a.key, createdAt: a.createdAt };
      }
    });
  }

  /** Finish an OPEN intent under its ORIGINAL key and intent (the money really was received). */
  finish(key: unknown): AdvanceResult {
    const actor = this.requireRecorder();
    if (typeof key !== "string") throw new DomainError("INVALID_INPUT", "An advance needs a request key");
    const done = this.deps.advances.findAdvanceByKey(key);
    if (done) return { record: done, duplicate: true };
    const attempt = this.deps.advances.findAttempt(key);
    if (!attempt) throw new DomainError("INVALID_INPUT", "There is no such pending advance");
    if (attempt.resolution !== null) throw new DomainError("IDEMPOTENCY_CONFLICT", "That advance was closed as not received");
    const record = this.commit(attempt, actor);
    this.afterAdvanceCommitted();
    return { record, duplicate: false };
  }

  /**
   * Close an OPEN intent as NOT recorded (the money was not taken). Its creator or the owner only;
   * the closing is final (a late retry under that key is refused by the service AND by trigger).
   */
  close(key: unknown): void {
    const actor = this.requireRecorder();
    if (typeof key !== "string") throw new DomainError("INVALID_INPUT", "An advance needs a request key");
    this.deps.transact(() => {
      this.sameOperator(actor);
      const attempt = this.deps.advances.findAttempt(key);
      if (!attempt) throw new DomainError("INVALID_INPUT", "There is no such pending advance");
      if (actor.role !== "owner" && attempt.createdBy !== actor.id) {
        throw new DomainError("NOT_AUTHORIZED", "Only the owner or the operator who started it can close it");
      }
      if (attempt.resolution !== null) throw new DomainError("IDEMPOTENCY_CONFLICT", "That advance is already settled");
      const at = this.now().toISOString();
      this.deps.advances.resolveAttempt(key, "not_recorded", at); // the trigger refuses it if an advance exists
      this.deps.advances.acknowledgeAttempt(key, at);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // G2 — CORRECTING A MISTAKEN ADVANCE (migration 20, owner approval DEC-35s). OWNER ONLY. One
  // transaction: the correction row, then (for `replaced`) the successor with its own ADV number. No
  // external money moves, so there is no attempt table: the whole correction commits or nothing does,
  // and a repeat under the same key (crash, lost reply) returns the SAME correction.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** Crash-test seam (tests/helpers/advanceCrashChild.ts). Nothing in src/ overrides it. */
  protected afterCorrectionCommitted(): void {}
  /** Crash seam INSIDE the application transaction: the settlement is written, the application not yet. */
  protected afterApplicationSettlementWritten(): void {}
  /** Crash seam INSIDE the sale-on-advance transaction: the sale and its receivable written, no application yet. */
  protected afterSaleOnAdvanceWritten(): void {}

  private requireOwner(): AdvanceActor {
    const actor = this.requireRecorder();
    if (actor.role !== "owner") throw new DomainError("NOT_AUTHORIZED", "Only the owner can correct an advance");
    return actor;
  }

  /** Validates EVERYTHING before anything is written: a refused correction leaves no trace. */
  private prepareCorrection(draft: CorrectAdvanceDraft): PreparedCorrection {
    if (typeof draft.idempotencyKey !== "string" || !KEY_SHAPE.test(draft.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "A correction needs a request key");
    }
    const reason = typeof draft.reason === "string" ? draft.reason.trim() : "";
    if (reason.length < 3 || reason.length > 200) {
      throw new DomainError("INVALID_REASON", "A correction needs a reason (3 to 200 characters)");
    }
    if (typeof draft.advanceId !== "string") throw new DomainError("ADVANCE_NOT_FOUND", "That advance does not exist");
    const original = this.deps.advances.findAdvanceById(draft.advanceId);
    if (!original) throw new DomainError("ADVANCE_NOT_FOUND", "That advance does not exist");

    if (draft.kind === "not_received") {
      if (draft.confirmNotReceived !== true) {
        throw new DomainError("INVALID_INPUT", "Declare explicitly that the money was not received");
      }
      for (const f of ["customerId", "amountMinor", "channel", "reference", "fundsConfirmed"] as const) {
        if (draft[f] !== undefined) throw new DomainError("INVALID_INPUT", "A not-received correction changes no detail");
      }
      return {
        key: draft.idempotencyKey,
        kind: "not_received",
        original,
        reason,
        fundsNotReceived: true,
        successor: null,
        fingerprint: hash({ advanceId: original.id, kind: "not_received", reason }),
      };
    }
    if (draft.kind !== "replaced") throw new DomainError("INVALID_INPUT", "Unknown correction");

    const customerId = draft.customerId === undefined ? original.customerId : draft.customerId;
    if (typeof customerId !== "string") throw new DomainError("INVALID_INPUT", "A correction needs a customer");
    const customer = this.deps.parties.findById(customerId);
    if (!customer || customer.kind !== "customer" || customer.is_active !== 1) {
      throw new DomainError("PARTY_NOT_FOUND", "That active customer account no longer exists");
    }
    const amount =
      draft.amountMinor === undefined ? original.amountMinor : ledgerAmount(draft.amountMinor, original.currency).minor;
    if (amount > original.amountMinor) {
      // The extra of the SAME transfer cannot be recorded under the same reference, and a second
      // receipt would break the registry: refused here, for the owner to review (DEC-35s).
      throw new DomainError("ADVANCE_CORRECTION_ABOVE_ORIGINAL", "A correction cannot raise the amount received");
    }
    const smaller = amount < original.amountMinor;
    if (smaller && draft.confirmNotReceived !== true) {
      throw new DomainError("INVALID_INPUT", "Declare explicitly that the difference was not received");
    }
    if (!smaller && draft.confirmNotReceived !== undefined && draft.confirmNotReceived !== false) {
      throw new DomainError("INVALID_INPUT", "Nothing is declared not received when the amount is unchanged");
    }
    const originalChannel: AdvanceChannel = original.method === "external" ? "whish" : "cash";
    const channel = draft.channel === undefined ? originalChannel : draft.channel;
    if (channel !== "cash" && channel !== "whish") {
      throw new DomainError("PAYMENT_METHOD_NOT_ACCEPTED", "This shop records new payments in cash or Whish Money only");
    }
    const rawRef =
      draft.reference === undefined && channel === "whish" && originalChannel === "whish" ? original.reference : draft.reference;
    const reference = cleanPaymentReference(rawRef, channel);
    const sameReference =
      reference !== null && original.reference !== null && this.deps.advances.sameReferenceKey(reference, original.reference);
    if (channel === "whish" && !sameReference) {
      // A transfer the system has not seen confirmed under THIS reference must be confirmed now.
      if (draft.fundsConfirmed !== true) {
        throw new DomainError("FUNDS_NOT_CONFIRMED", "Confirm that the Whish Money transfer has arrived");
      }
    } else if (channel === "cash" && draft.fundsConfirmed !== undefined && draft.fundsConfirmed !== null && draft.fundsConfirmed !== false) {
      throw new DomainError("INVALID_INPUT", "A cash advance carries no transfer confirmation");
    }
    if (
      customer.id === original.customerId &&
      amount === original.amountMinor &&
      channel === originalChannel &&
      reference === original.reference
    ) {
      throw new DomainError("INVALID_INPUT", "The correction changes nothing");
    }
    return {
      key: draft.idempotencyKey,
      kind: "replaced",
      original,
      reason,
      fundsNotReceived: smaller,
      successor: { customerId: customer.id, amountMinor: amount, channel, reference, sameReference },
      fingerprint: hash({
        advanceId: original.id,
        kind: "replaced",
        reason,
        customerId: customer.id,
        amountMinor: amount.toString(),
        channel,
        reference,
      }),
    };
  }

  /** Correct a mistaken, fully unused advance (owner only). Idempotent by key + fingerprint. */
  correct(draft: CorrectAdvanceDraft): CorrectionResult {
    const actor = this.requireOwner();

    // A repeat under a committed key is answered BEFORE re-validating against today's state (the
    // original is now corrected, so validation alone would wrongly refuse the replay).
    if (typeof draft.idempotencyKey === "string") {
      const done = this.deps.advances.findCorrectionByKey(draft.idempotencyKey);
      if (done) {
        const again = this.prepareReplay(draft, done);
        if (!again) throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key was already used for a different correction");
        return this.correctionResult(done, true);
      }
    }
    const p = this.prepareCorrection(draft);

    const result = this.deps.transact(() => {
      const live = this.requireOwner();
      if (live.id !== actor.id) throw new DomainError("NOT_AUTHORIZED", "The signed-in operator changed during the correction");
      if (this.deps.advances.findCorrectionByKey(p.key)) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key was already used");
      }
      if (this.deps.advances.findCorrectionOf(p.original.id)) {
        throw new DomainError("ADVANCE_ALREADY_CORRECTED", "That advance was already corrected");
      }
      if (this.deps.advances.isUsed(p.original.id)) {
        throw new DomainError("ADVANCE_IN_USE", "An advance already applied or refunded cannot be corrected");
      }
      if (
        p.successor &&
        p.successor.reference !== null &&
        !p.successor.sameReference &&
        this.deps.ledger.isReferenceRegistered("whish", p.successor.reference)
      ) {
        throw new DomainError("DUPLICATE_PAYMENT_REFERENCE", "That payment reference is already recorded");
      }
      const instant = this.now();
      const correction: AdvanceCorrectionRecord = {
        id: this.newId(),
        advanceId: p.original.id,
        kind: p.kind,
        successorAdvanceId: p.successor ? this.newId() : null,
        fundsNotReceived: p.fundsNotReceived,
        reason: p.reason,
        correctedBy: actor.id,
        correctedAt: instant.toISOString(),
        businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
        key: p.key,
        fingerprint: p.fingerprint,
      };
      // ORDER IS THE SAFETY: the correction first, then its successor (the trigger requires it).
      this.deps.advances.insertCorrection(correction);
      if (p.successor && correction.successorAdvanceId) {
        this.deps.advances.insertAdvance({
          id: correction.successorAdvanceId,
          docNo: this.deps.advances.issueAdvanceNumber(),
          customerId: p.successor.customerId,
          currency: p.original.currency,
          amountMinor: p.successor.amountMinor,
          method: p.successor.channel === "whish" ? "external" : "cash",
          provider: p.successor.channel === "whish" ? "whish" : null,
          reference: p.successor.reference,
          key: p.key,
          fingerprint: p.fingerprint,
          // WHO really received the money and WHEN — copied, never the correction's own moment.
          receivedBy: p.original.receivedBy,
          receivedAt: p.original.receivedAt,
          businessDate: p.original.businessDate,
          origin: "correction",
          correctsAdvanceId: p.original.id,
        });
      }
      return this.correctionResult(correction, false);
    });
    this.afterCorrectionCommitted();
    return result;
  }

  /**
   * Is this draft the SAME request as the committed correction? Compared on the stored fingerprint,
   * recomputed from the draft alone (the original's live state is irrelevant to a replay).
   */
  private prepareReplay(draft: CorrectAdvanceDraft, done: AdvanceCorrectionRecord): boolean {
    const reason = typeof draft.reason === "string" ? draft.reason.trim() : "";
    if (draft.advanceId !== done.advanceId || draft.kind !== done.kind) return false;
    if (done.kind === "not_received") return hash({ advanceId: done.advanceId, kind: "not_received", reason }) === done.fingerprint;
    const original = this.deps.advances.findAdvanceById(done.advanceId);
    if (!original) return false;
    const originalChannel = original.method === "external" ? "whish" : "cash";
    const channel = draft.channel === undefined ? originalChannel : draft.channel;
    let amount: bigint;
    let reference: string | null;
    try {
      amount = draft.amountMinor === undefined ? original.amountMinor : ledgerAmount(draft.amountMinor, original.currency).minor;
      const rawRef =
        draft.reference === undefined && channel === "whish" && originalChannel === "whish" ? original.reference : draft.reference;
      reference = channel === "cash" || channel === "whish" ? cleanPaymentReference(rawRef, channel) : null;
    } catch {
      return false;
    }
    const customerId = draft.customerId === undefined ? original.customerId : draft.customerId;
    return (
      hash({ advanceId: done.advanceId, kind: "replaced", reason, customerId, amountMinor: amount.toString(), channel, reference }) ===
      done.fingerprint
    );
  }

  private correctionResult(c: AdvanceCorrectionRecord, duplicate: boolean): CorrectionResult {
    const original = this.deps.advances.findAdvanceById(c.advanceId);
    if (!original) throw new DomainError("LEDGER_INTEGRITY", "A correction names a missing advance");
    const successor = c.successorAdvanceId ? this.deps.advances.findAdvanceById(c.successorAdvanceId) : null;
    if (c.successorAdvanceId && !successor) throw new DomainError("LEDGER_INTEGRITY", "A correction lost its successor");
    return { correction: c, original, successor, duplicate };
  }

  /**
   * A customer's advances for the account statement: every advance (never hidden), its live balance
   * (0 once corrected), and how it was corrected. Debt is NOT here and is never netted (D2).
   */
  statement(customerId: unknown): AdvanceStatementLine[] {
    // OWNER, like the debt statement: a cashier records advances but does not read what anyone holds.
    this.requireOwner();
    if (typeof customerId !== "string") throw new DomainError("INVALID_INPUT", "A statement needs a customer");
    return this.deps.advances.listAdvances(customerId).map((a) => {
      const corr = this.deps.advances.findCorrectionOf(a.id);
      const successor = corr?.successorAdvanceId ? this.deps.advances.findAdvanceById(corr.successorAdvanceId) : null;
      const corrects = a.correctsAdvanceId ? this.deps.advances.findAdvanceById(a.correctsAdvanceId) : null;
      return {
        advance: a,
        unusedMinor: this.deps.advances.unusedMinor(a.id),
        correction: corr,
        successorNo: successor ? successor.docNo : null,
        correctsNo: corrects ? corrects.docNo : null,
      };
    });
  }

  // ── DEC-35x: APPLY AN ADVANCE TO AN EXISTING DEBT ─────────────────────────────────────────────────
  //
  // 🔴 NOT NEW MONEY. The money arrived on the advance's own day (ADV-). Applying it writes ONE
  // settlement against the debt — in the advance's own method, with NO provider and NO reference (the
  // Whish reference stays on the advance, registered once) — and ONE application row naming the
  // advance. The daily money report classifies that settlement as an application, never a collection.
  //
  // 🔴 ATOMIC. Both rows commit in ONE transaction or neither does; the M19 trigger re-checks owner,
  // same customer, receivable, method and the unused balance; the M20 trigger refuses a corrected
  // advance; the overpayment trigger refuses more than the debt owes. A process killed between the two
  // inserts leaves nothing (SQLite rolls the open transaction back).
  //
  // 🔴 IDEMPOTENT. The request key IS the application's identity: a retry after a lost reply returns
  // the SAME application (duplicate: true); the same key with a different advance, debt or amount is
  // IDEMPOTENCY_CONFLICT. No attempt table is needed: nothing is handed over at the till, so there is
  // no receipt to acknowledge — the one transaction is the whole operation.

  applyToDebt(draft: ApplyAdvanceDraft): ApplyAdvanceResult {
    return this.applyWithin(draft, false);
  }

  /** `inside`: the caller already holds the write transaction (sellOnAdvance) — no transaction of our own. */
  private applyWithin(draft: ApplyAdvanceDraft, inside: boolean): ApplyAdvanceResult {
    const actor = this.requireOwner();
    if (typeof draft.idempotencyKey !== "string" || !APPLY_KEY_SHAPE.test(draft.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "An application needs a request key");
    }
    const key = draft.idempotencyKey;
    if (typeof draft.advanceId !== "string" || draft.advanceId.length === 0 || draft.advanceId.length > 100) {
      throw new DomainError("INVALID_INPUT", "An application needs an advance");
    }
    if (typeof draft.obligationId !== "string" || draft.obligationId.length === 0 || draft.obligationId.length > 100) {
      throw new DomainError("INVALID_INPUT", "An application needs a debt");
    }
    const advanceId = draft.advanceId;
    const obligationId = draft.obligationId;
    const fingerprint = (amount: unknown) => hash({ op: "apply-advance", advanceId, obligationId, amountMinor: typeof amount === "bigint" ? amount.toString() : String(amount) });

    // A repeat under a committed key is answered BEFORE re-validating against today's balances (the
    // advance and the debt have moved since — validation alone would wrongly refuse the replay).
    const done = this.deps.advances.findApplicationByKey(key);
    if (done) {
      if (done.fingerprint !== fingerprint(draft.amountMinor) || done.advanceId !== advanceId || done.obligationId !== obligationId) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key was already used for a different application");
      }
      return this.applicationResult(done, true);
    }
    if (this.deps.ledger.findSettlementByIdempotencyKey(`advapp-${key}`)) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key was already used");
    }

    const check = () => {
      const advance = this.deps.advances.findAdvanceById(advanceId);
      if (!advance) throw new DomainError("ADVANCE_NOT_FOUND", "That advance does not exist");
      if (this.deps.advances.findCorrectionOf(advance.id)) {
        throw new DomainError("ADVANCE_CORRECTED_NOT_APPLICABLE", "That advance was corrected and cannot be applied");
      }
      const debt = this.deps.ledger.findObligationById(obligationId);
      if (!debt || debt.direction !== "receivable") throw new DomainError("ADVANCE_DEBT_NOT_FOUND", "That debt does not exist");
      if (debt.partyId !== advance.customerId) {
        throw new DomainError("ADVANCE_DEBT_OTHER_CUSTOMER", "An advance can only pay its own customer's debt");
      }
      if (debt.currency !== advance.currency) throw new DomainError("ADVANCE_DEBT_CURRENCY", "The advance and the debt are in different currencies");
      const amount = ledgerAmount(draft.amountMinor, advance.currency).minor;
      const outstanding = debt.amountMinor - this.deps.ledger.settledTotal(debt.id);
      if (outstanding <= 0n || this.deps.advances.obligationSaleVoided(debt.id)) {
        throw new DomainError("ADVANCE_DEBT_NOT_OPEN", "That debt owes nothing");
      }
      if (amount > this.deps.advances.unusedMinor(advance.id)) {
        throw new DomainError("ADVANCE_APPLY_ABOVE_BALANCE", "The amount is above what the advance still holds");
      }
      if (amount > outstanding) throw new DomainError("ADVANCE_APPLY_ABOVE_DEBT", "The amount is above what the debt still owes");
      return { advance, debt, amount };
    };
    check(); // Everything validated BEFORE anything is written: a refused application leaves no trace.

    const write = (): AdvanceApplicationRecord => {
      const live = this.requireOwner();
      if (live.id !== actor.id) throw new DomainError("NOT_AUTHORIZED", "The signed-in operator changed during the application");
      if (this.deps.advances.findApplicationByKey(key)) throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key was already used");
      const { advance, debt, amount } = check(); // the SAME rules again, inside the write lock
      const at = this.now().toISOString();
      const settlementId = this.newId();
      this.deps.ledger.insertSettlement({
        id: settlementId,
        obligationId: debt.id,
        currency: debt.currency,
        idempotencyKey: `advapp-${key}`,
        requestFingerprint: fingerprint(amount),
        amountMinor: amount,
        method: advance.method,
        provider: null,
        reference: null,
        fundsConfirmed: null,
        settledBy: live.id,
        settledAt: at,
        businessDate: businessDateOf(this.now(), this.deps.terminal.timeZone),
      });
      this.afterApplicationSettlementWritten();
      this.deps.advances.insertApplication({ id: this.newId(), advanceId: advance.id, settlementId, amountMinor: amount, key, appliedBy: live.id, appliedAt: at });
      const written = this.deps.advances.findApplicationByKey(key);
      if (!written) throw new DomainError("LEDGER_INTEGRITY", "The application could not be read back");
      return written;
    };
    const result = inside ? write() : this.deps.transact(write);
    return this.applicationResult(result, false);
  }

  // ── DEC-35x: APPLY AN ADVANCE TO A NEW SALE ──────────────────────────────────────────────────────
  //
  // The owner's sale on the customer's account (the till's own createCustomerCreditSale: catalog
  // pricing, displayed-total check, active customer, owner gate) and the application of the advance to
  // THAT sale's receivable, in ONE outer transaction (the credit sale's own transactions become
  // savepoints). Whatever the advance does not cover stays the customer's debt. No down payment is
  // accepted here, so no new Cash or Whish money enters: the money arrived as the ADV-.
  //
  // IDEMPOTENT: the sale key K identifies the sale; the application key is `K-adv`. A retry after a lost
  // reply returns the SAME sale and the SAME application; the same K for other details is refused.
  // CRASH-SAFE: the process dying anywhere before COMMIT leaves neither the sale nor the application.

  sellOnAdvance(draft: SellOnAdvanceDraft): SellOnAdvanceResult {
    this.requireOwner();
    const sell = this.deps.creditSale;
    if (!sell) throw new DomainError("NOT_AVAILABLE", "Sales on an advance are not available on this terminal");
    if (typeof draft.idempotencyKey !== "string" || !SALE_KEY_SHAPE.test(draft.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "A sale on an advance needs a request key");
    }
    if (typeof draft.customerId !== "string" || draft.customerId.length === 0) throw new DomainError("INVALID_INPUT", "A customer account is required");
    if (typeof draft.advanceId !== "string" || draft.advanceId.length === 0) throw new DomainError("INVALID_INPUT", "An advance is required");
    if (typeof draft.expectedTotalMinor !== "bigint") throw new DomainError("INVALID_INPUT", "A valid displayed total is required");
    const key = draft.idempotencyKey;
    const appKey = `${key}-adv`;
    const input: CreateCreditSaleInput = { idempotencyKey: key, customerId: draft.customerId, lines: draft.lines, expectedTotalMinor: draft.expectedTotalMinor };

    // A committed request is answered from the ledger first (balances have moved since).
    const done = this.deps.advances.findApplicationByKey(appKey);
    if (done) {
      const pair = sell(input); // the credit sale's own replay: same sale, or IDEMPOTENCY_CONFLICT
      const again = this.applyWithin({ advanceId: draft.advanceId, obligationId: pair.obligation.id, amountMinor: draft.amountMinor, idempotencyKey: appKey }, false);
      return { sale: pair.sale, obligation: pair.obligation, application: again, duplicate: true };
    }

    // Refusals that need no sale are decided BEFORE anything is written.
    const advance = this.deps.advances.findAdvanceById(draft.advanceId);
    if (!advance) throw new DomainError("ADVANCE_NOT_FOUND", "That advance does not exist");
    if (this.deps.advances.findCorrectionOf(advance.id)) throw new DomainError("ADVANCE_CORRECTED_NOT_APPLICABLE", "That advance was corrected and cannot be applied");
    if (advance.customerId !== draft.customerId) throw new DomainError("ADVANCE_DEBT_OTHER_CUSTOMER", "An advance can only pay its own customer's sale");
    const amount = ledgerAmount(draft.amountMinor, advance.currency).minor;
    if (amount > this.deps.advances.unusedMinor(advance.id)) throw new DomainError("ADVANCE_APPLY_ABOVE_BALANCE", "The amount is above what the advance still holds");
    if (amount > draft.expectedTotalMinor) throw new DomainError("ADVANCE_APPLY_ABOVE_DEBT", "The amount is above the sale's total");

    return this.deps.transact(() => {
      const pair = sell(input);
      // A key that already names a sale WITHOUT this application is not ours to extend.
      if (pair.duplicate) throw new DomainError("IDEMPOTENCY_CONFLICT", "That request key already names another sale");
      this.afterSaleOnAdvanceWritten();
      const application = this.applyWithin({ advanceId: advance.id, obligationId: pair.obligation.id, amountMinor: amount, idempotencyKey: appKey }, true);
      return { sale: pair.sale, obligation: pair.obligation, application, duplicate: false };
    });
  }

  private applicationResult(app: AdvanceApplicationRecord, duplicate: boolean): ApplyAdvanceResult {
    const advance = this.deps.advances.findAdvanceById(app.advanceId);
    const debt = this.deps.ledger.findObligationById(app.obligationId);
    if (!advance || !debt) throw new DomainError("LEDGER_INTEGRITY", "The application's advance or debt is missing");
    return {
      application: app,
      advance,
      unusedMinor: this.deps.advances.unusedMinor(advance.id),
      debtOutstandingMinor: debt.amountMinor - this.deps.ledger.settledTotal(debt.id),
      duplicate,
    };
  }

  /** Owner: the debt an application paid (display only). */
  debtOf(obligationId: string): ObligationRecord | null {
    this.requireOwner();
    return this.deps.ledger.findObligationById(obligationId);
  }

  /** A display name for an operator id (the id itself when the row is gone). */
  operatorName(operatorId: string): string {
    return this.deps.advances.names("", operatorId).operator ?? operatorId;
  }

  /** Owner: what one advance paid, debt by debt (statement / document). */
  applicationsOf(advanceId: string): AdvanceApplicationRecord[] {
    this.requireOwner();
    return this.deps.advances.listApplications(advanceId);
  }

  /** Display only: which statement settlements were paid FROM an advance, and from which ADV-. */
  advancesOfSettlements(settlementIds: ReadonlyArray<string>): Map<string, { advanceId: string; number: string }> {
    this.requireOwner();
    const out = new Map<string, { advanceId: string; number: string }>();
    for (const [sid, a] of this.deps.advances.advancesOfSettlements(settlementIds)) out.set(sid, { advanceId: a.advanceId, number: formatAdvanceNo(a.docNo) });
    return out;
  }

  /** Everything a document or a screen shows about one advance, read from the ledger. No arithmetic. */
  view(a: AdvanceRecord): AdvanceView {
    const names = this.deps.advances.names(a.customerId, a.receivedBy);
    const corrects = a.correctsAdvanceId ? this.deps.advances.findAdvanceById(a.correctsAdvanceId) : null;
    return {
      record: a,
      number: formatAdvanceNo(a.docNo),
      customerName: names.customer ?? "—",
      receivedByName: names.operator ?? "—",
      correctsNumber: corrects ? formatAdvanceNo(corrects.docNo) : null,
    };
  }

  /** A customer's display name (for a pending intent, which has no advance row yet). */
  customerName(customerId: string): string {
    return this.deps.advances.names(customerId, "").customer ?? "—";
  }

  /** The correction of an advance as a screen / document states it, or null. */
  correctionView(c: AdvanceCorrectionRecord | null): AdvanceCorrectionView | null {
    if (!c) return null;
    const by = this.deps.advances.names("", c.correctedBy).operator ?? "—";
    const successor = c.successorAdvanceId ? this.deps.advances.findAdvanceById(c.successorAdvanceId) : null;
    return { record: c, correctedByName: by, successorNumber: successor ? formatAdvanceNo(successor.docNo) : null };
  }

  /** One advance for its document (print / PDF). Any signed-in recorder; by ID only. */
  document(advanceId: unknown): { readonly advance: AdvanceView; readonly correction: AdvanceCorrectionView | null } {
    this.requireRecorder();
    if (typeof advanceId !== "string") throw new DomainError("ADVANCE_NOT_FOUND", "That advance does not exist");
    const a = this.deps.advances.findAdvanceById(advanceId);
    if (!a) throw new DomainError("ADVANCE_NOT_FOUND", "That advance does not exist");
    return { advance: this.view(a), correction: this.correctionView(this.deps.advances.findCorrectionOf(a.id)) };
  }

  /** The operator has SEEN the outcome (the ADV receipt, or the closing). Idempotent. */
  acknowledge(key: unknown): void {
    this.requireRecorder();
    if (typeof key !== "string") throw new DomainError("INVALID_INPUT", "An advance needs a request key");
    this.deps.transact(() => {
      const attempt = this.deps.advances.findAttempt(key);
      if (!attempt) throw new DomainError("INVALID_INPUT", "There is no such pending advance");
      if (attempt.resolution === null) throw new DomainError("ADVANCE_UNRESOLVED", "That advance is not settled yet");
      this.deps.advances.acknowledgeAttempt(key, this.now().toISOString());
    });
  }
}
