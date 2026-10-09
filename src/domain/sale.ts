import { DomainError } from "./errors";
import type { Money } from "./money";

/**
 * How a sale was PAID — recorded, never processed. No card data, no gateway, no funds custody.
 * One method per sale in this gate (split payments are out of scope).
 */
export const PAYMENT_METHODS = ["cash", "card", "external", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function assertPaymentMethod(value: unknown): asserts value is PaymentMethod {
  if (typeof value !== "string" || !(PAYMENT_METHODS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_PAYMENT_METHOD", `Unsupported payment method '${String(value)}'`);
  }
}

/**
 * WHERE a sale came from. Explicit, never inferred from a string pattern in another column.
 *
 * `pos`     an ordinary till checkout. Keeps every rule it has had since migration 1: a real
 *           payment method, a catalog product and SKU on every line, a canonical sale unit.
 * `invoice` a finalized manual invoice (migration 7). Broader on purpose: it may be unpaid, carry
 *           tax, and sell a line the catalog has never heard of.
 */
export const SALE_SOURCE_TYPES = ["pos", "invoice"] as const;
export type SaleSourceType = (typeof SALE_SOURCE_TYPES)[number];

/**
 * WHETHER a sale was paid — a STATE, and deliberately not a value of PaymentMethod. "unpaid" is
 * not a way of paying; conflating the two is what forced the old schema to lie.
 */
export const PAYMENT_STATUSES = ["paid", "partial", "unpaid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The one place the status is derived, so no caller can invent a disagreeing pair. Mirrors the
 * database CHECK in migration 7 exactly; a zero-total sale is `paid`, which is what a zero balance
 * means.
 */
export function paymentStatusFor(paidMinor: bigint, balanceDueMinor: bigint): PaymentStatus {
  if (balanceDueMinor === 0n) return "paid";
  return paidMinor === 0n ? "unpaid" : "partial";
}

export interface SaleLineRecord {
  readonly id: string;
  readonly saleId: string;
  readonly lineNo: number;
  /**
   * The invoice line this sale line froze, or null for a POS line. UNIQUE in the database, so one
   * invoice line can never appear as two sale lines.
   */
  readonly invoiceLineId: string | null;
  /**
   * 🔴 NULL ONLY ON AN INVOICE-ORIGIN LINE, and it means the catalog genuinely has no such product
   * yet — the PRODUCT_NOT_FOUND case, awaiting reconciliation. A POS line always has both; the
   * sale_lines_pos_shape trigger refuses one that does not.
   */
  readonly productId: string | null;
  /** Snapshots taken at sale time — a later catalog change never alters them. */
  readonly sku: string | null;
  readonly productName: string;
  /**
   * The unit this line was SOLD in, snapshotted. NULL only on a line written before migration 4,
   * where the historical unit is genuinely unknown and is never guessed from today's catalog.
   */
  readonly saleUnit: string | null;
  /**
   * What the paper said, verbatim: "كيس (50PCS)". Null on a POS line (the unit IS the canonical
   * one) and on a pre-migration-7 row. A later reconciliation choosing a base unit for the CATALOG
   * must never rewrite this — it is commercial history.
   */
  readonly unitLabel: string | null;
  /** Thousandths of one sale unit (domain/quantity.ts). */
  readonly quantityMilli: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

/** A completed sale. Immutable: the database refuses UPDATE and DELETE on it. */
export interface SaleRecord {
  readonly id: string;
  readonly receiptNumber: number;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly currency: string;
  readonly sourceType: SaleSourceType;
  /** The finalized invoice this sale came from, or null for a POS sale. */
  readonly invoiceId: string | null;
  readonly subtotal: Money;
  /** Copied from the invoice's FROZEN tax. Always zero for a POS sale and a taxless invoice. */
  readonly tax: Money;
  readonly total: Money;
  readonly paid: Money;
  readonly balanceDue: Money;
  readonly paymentStatus: PaymentStatus;
  /**
   * 🔴 NULL MEANS "NOT RECORDED", which is the truth for a manual invoice that captured no method.
   * Never a fabricated 'cash'. Required on every POS sale, by database CHECK.
   */
  readonly paymentMethod: PaymentMethod | null;
  readonly businessDate: string;
  readonly completedAt: string;
  readonly createdAt: string;
  readonly lines: ReadonlyArray<SaleLineRecord>;
}

/** A void is a separate, immutable event that points at the sale it cancels. */
export interface VoidRecord {
  readonly id: string;
  readonly saleId: string;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly reason: string;
  readonly businessDate: string;
  readonly createdAt: string;
}

export const VOID_REASON_MIN = 3;
export const VOID_REASON_MAX = 200;

export function normalizeVoidReason(reason: unknown): string {
  if (typeof reason !== "string") throw new DomainError("INVALID_REASON", "A void reason is required");
  const trimmed = reason.trim();
  if (trimmed.length < VOID_REASON_MIN || trimmed.length > VOID_REASON_MAX) {
    throw new DomainError(
      "INVALID_REASON",
      `A void reason must be ${VOID_REASON_MIN}–${VOID_REASON_MAX} characters`,
    );
  }
  return trimmed;
}
