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

export interface SaleLineRecord {
  readonly id: string;
  readonly saleId: string;
  readonly lineNo: number;
  readonly productId: string;
  /** Snapshots taken at sale time — a later catalog change never alters them. */
  readonly sku: string;
  readonly productName: string;
  /**
   * The unit this line was SOLD in, snapshotted. NULL only on a line written before migration 4,
   * where the historical unit is genuinely unknown and is never guessed from today's catalog.
   */
  readonly saleUnit: string | null;
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
  readonly subtotal: Money;
  readonly total: Money;
  readonly paymentMethod: PaymentMethod;
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
