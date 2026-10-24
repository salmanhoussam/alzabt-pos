/**
 * Obligations and settlements: what is owed, and what has actually been paid against it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE BALANCE IS CALCULATED HERE AND STORED NOWHERE. `outstanding()` is the only definition of
 * what a party still owes, and it is `amount - sum(settlements)` every time it is asked. There is
 * no `balance_minor` column, no cached total and no running tally. A second copy of a balance is
 * the one bug in an accounts system nobody can recover from: the moment it disagrees with the rows
 * it summarises, no one can say which is right, and the shop's books become an argument.
 *
 * 🔴 ONE CURRENCY, ALWAYS. `src/domain/money.ts` has refused to add across currencies since the
 * first migration and this product has no exchange rate anywhere. So a balance is a balance IN ONE
 * CURRENCY: a party owing both USD and LBP has two obligations and two outstanding amounts, never
 * one blended number. Every function here refuses a mixed input rather than guessing a rate.
 *
 * 🔴 EVERY AMOUNT IS POSITIVE. Direction is carried by `direction`, never by the sign of a number.
 * A negative obligation would be a reversal and a negative settlement a refund; both are real
 * features with their own authorization, and neither is built. Letting a sign stand in for them
 * would have shipped them by accident.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { DomainError } from "./errors";
import { MAX_MINOR, type Money, money } from "./money";

/**
 * Which way the money flows.
 *
 * `receivable` — a customer owes the shop.  `payable` — the shop owes a supplier.
 *
 * These are not interchangeable and are never summed together. A shop that is owed 100 and owes 100
 * is not "level": it is owed 100 by one person and owes 100 to another, and only one of those two
 * will turn up.
 */
export const OBLIGATION_DIRECTIONS = ["receivable", "payable"] as const;
export type ObligationDirection = (typeof OBLIGATION_DIRECTIONS)[number];

/** Which side of the directory a direction belongs to. The database enforces the same pairing. */
export function partyKindFor(direction: ObligationDirection): "customer" | "supplier" {
  return direction === "receivable" ? "customer" : "supplier";
}

export function isObligationDirection(v: unknown): v is ObligationDirection {
  return typeof v === "string" && (OBLIGATION_DIRECTIONS as readonly string[]).includes(v);
}

/**
 * Where a debt came from.
 *
 * `sale`   — a completed sale in this ledger. Carries a real foreign key, and `sourceRef` IS the
 *            sale id, which is what makes a second obligation for the same sale impossible.
 * `manual` — a document that lives outside this app, such as a supplier's paper bill. `sourceRef`
 *            is that document's own reference, and it is equally unique.
 */
export const OBLIGATION_SOURCES = ["sale", "manual"] as const;
export type ObligationSource = (typeof OBLIGATION_SOURCES)[number];

export function isObligationSource(v: unknown): v is ObligationSource {
  return typeof v === "string" && (OBLIGATION_SOURCES as readonly string[]).includes(v);
}

/**
 * How a settlement was received or paid.
 *
 * 🔴 MIGRATION 1'S FOUR VALUES, UNCHANGED. There is no `whish` here and no `credit`: `credit` is a
 * STATE of a sale, never a method, exactly as migration 7 wrote it. Adding a tender to this list
 * would also re-interpret what every historical `card` and `external` row meant.
 */
export const SETTLEMENT_METHODS = ["cash", "card", "external", "other"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export function isSettlementMethod(v: unknown): v is SettlementMethod {
  return typeof v === "string" && (SETTLEMENT_METHODS as readonly string[]).includes(v);
}

/** The longest external reference a manual obligation may carry. */
export const MAX_SOURCE_REF = 120;

/**
 * A positive ledger amount.
 *
 * Rejects zero, negatives, non-integers and anything past `MAX_MINOR` — the same bound migration 4
 * put on every other amount in this product, so the ledger cannot hold a number the rest of the app
 * would refuse to render.
 */
export function ledgerAmount(minor: unknown, currency: string): Money {
  if (typeof minor !== "bigint") {
    throw new DomainError("NOT_EXACT", "A ledger amount must be exact minor units");
  }
  if (minor <= 0n) {
    throw new DomainError("INVALID_AMOUNT", "A ledger amount must be greater than zero");
  }
  if (minor > MAX_MINOR) {
    throw new DomainError("MONEY_OUT_OF_RANGE", `Amount ${minor} is outside the accepted range`);
  }
  // `money()` re-checks the currency against the ISO table, so an unknown code is refused here too.
  return money(minor, currency);
}

/** A source reference, trimmed. Never empty — an unsourced debt is not auditable. */
export function sourceRef(raw: unknown): string {
  if (typeof raw !== "string") throw new DomainError("INVALID_INPUT", "A source reference is required");
  const ref = raw.trim();
  if (ref.length === 0) throw new DomainError("INVALID_INPUT", "A source reference is required");
  if (ref.length > MAX_SOURCE_REF) {
    throw new DomainError("INVALID_INPUT", `A source reference may not exceed ${MAX_SOURCE_REF} characters`);
  }
  return ref;
}

/** An obligation as the ledger holds it. Amounts are exact minor units. */
export interface ObligationRecord {
  readonly id: string;
  readonly partyId: string;
  readonly partyKind: "customer" | "supplier";
  readonly direction: ObligationDirection;
  readonly sourceKind: ObligationSource;
  readonly sourceRef: string;
  readonly saleId: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly postedBy: string;
  readonly postedAt: string;
  readonly businessDate: string;
}

/** A settlement as the ledger holds it. */
export interface SettlementRecord {
  readonly id: string;
  readonly obligationId: string;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly amountMinor: bigint;
  readonly method: SettlementMethod;
  readonly settledBy: string;
  readonly settledAt: string;
  readonly businessDate: string;
}

/**
 * What is still owed on one obligation.
 *
 * Refuses a settlement in another currency rather than converting it — the structural composite
 * foreign key makes that row un-insertable anyway, so reaching this throw means something upstream
 * bypassed the repository, and silence would be worse than a loud refusal.
 */
export function outstanding(obligation: ObligationRecord, settlements: readonly SettlementRecord[]): Money {
  let paid = 0n;
  for (const s of settlements) {
    if (s.obligationId !== obligation.id) {
      throw new DomainError("LEDGER_INTEGRITY", "A settlement for another obligation was included");
    }
    if (s.currency !== obligation.currency) {
      throw new DomainError("MIXED_CURRENCY", `Cannot settle ${obligation.currency} with ${s.currency}`);
    }
    paid += s.amountMinor;
  }
  if (paid > obligation.amountMinor) {
    // Only reachable if the overpayment trigger were ever dropped. Say so rather than return a
    // negative "balance", which a screen would happily render as money owed back.
    throw new DomainError("LEDGER_INTEGRITY", "Settlements exceed the obligation they belong to");
  }
  return money(obligation.amountMinor - paid, obligation.currency);
}

/** True when nothing is left to pay. */
export function isSettled(obligation: ObligationRecord, settlements: readonly SettlementRecord[]): boolean {
  return outstanding(obligation, settlements).minor === 0n;
}

/**
 * A party's outstanding balances, one per currency.
 *
 * 🔴 RETURNS A MAP, NOT A NUMBER, and that is the whole point. There is no single "what does he
 * owe" when a shop trades in two currencies, and inventing one would require an exchange rate this
 * product has never had. A caller that wants one number must choose a currency first.
 *
 * Obligations of BOTH directions are refused in one call for the same reason: a receivable and a
 * payable are different facts about different people and must never net off.
 */
export function balancesByCurrency(
  obligations: readonly ObligationRecord[],
  settlementsFor: (obligationId: string) => readonly SettlementRecord[],
): ReadonlyMap<string, bigint> {
  const totals = new Map<string, bigint>();
  let direction: ObligationDirection | null = null;
  for (const o of obligations) {
    if (direction === null) direction = o.direction;
    else if (direction !== o.direction) {
      throw new DomainError("LEDGER_INTEGRITY", "Receivables and payables cannot be summed together");
    }
    const left = outstanding(o, settlementsFor(o.id)).minor;
    totals.set(o.currency, (totals.get(o.currency) ?? 0n) + left);
  }
  return totals;
}
