import { DomainError } from "./errors";
import type { SettlementMethod, SettlementProvider } from "./ledger";
import type { PaymentMethod } from "./sale";

/**
 * P3 · THE METHODS THIS SHOP ACCEPTS FOR NEW MONEY (owner decision DEC-35, 2026-11-07).
 *
 *   Cash          — the amount actually received.
 *   Whish Money   — stored as method `external` + provider `whish`, always with its reference and the
 *                   operator's explicit confirmation (P2 for sales; the collection rules for debts).
 *   On account    — NOT a payment and never recorded as one: a debt on one identified customer, posted
 *                   by its own owner-only path. It therefore never appears in these lists.
 *
 * 🔴 WHAT THIS DOES NOT DO. It never reads, rewrites or re-labels history. The schema still holds
 * `card`, `other`, `bank_transfer` and provider-less `external` exactly as migration 1 / 13 / 17 wrote
 * them; every historic row keeps its own words on every screen. It is consulted ONLY at the point where a
 * NEW sale, settlement or receipt is about to be written — after the idempotency replay of an existing
 * key has been answered, and never for an attempt that was already open — so a request that was recorded
 * (or started) before this rule answers exactly as it always did.
 *
 * Widening this list is an owner decision (DEC-35), never a code default.
 */
export const ACCEPTED_SALE_METHODS: ReadonlyArray<"cash" | "whish"> = ["cash", "whish"];
export const ACCEPTED_COLLECTION_CHANNELS: ReadonlyArray<"cash" | "whish"> = ["cash", "whish"];

/** A NEW till sale: cash, or `external` (which P2 already restricts to Whish with its evidence). */
export function assertAcceptedNewSalePayment(method: PaymentMethod): void {
  if (method !== "cash" && method !== "external") {
    // A LITERAL, not a shared constant: the refusal-text audit reads every throw site's own sentence.
    throw new DomainError("PAYMENT_METHOD_NOT_ACCEPTED", "This shop records new payments in cash or Whish Money only");
  }
}

/** A NEW settlement or receipt, by its STORED shape: cash, or external + Whish. */
export function assertAcceptedNewCollection(method: SettlementMethod, provider: SettlementProvider | null): void {
  const cash = method === "cash" && provider === null;
  const whish = method === "external" && provider === "whish";
  if (!cash && !whish) throw new DomainError("PAYMENT_METHOD_NOT_ACCEPTED", "This shop records new payments in cash or Whish Money only");
}
