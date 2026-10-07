/**
 * Every expected business failure is a DomainError with a stable machine `code`. The IPC layer
 * forwards `code` + `message` to the UI; anything that is NOT a DomainError is treated as an
 * internal fault and never shown verbatim.
 */
export type DomainErrorCode =
  | "UNKNOWN_CURRENCY"
  | "NOT_EXACT"
  | "MONEY_OUT_OF_RANGE"
  | "INVALID_AMOUNT"
  | "INVALID_QUANTITY"
  | "MIXED_CURRENCY"
  | "INVALID_CATALOG"
  | "UNKNOWN_PRODUCT"
  | "EMPTY_CART"
  | "INVALID_PAYMENT_METHOD"
  | "TOTAL_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_LOGGED_IN"
  | "INVALID_CREDENTIALS"
  | "CASHIER_LOCKED"
  | "SALE_NOT_FOUND"
  | "ALREADY_VOIDED"
  | "VOID_NOT_ALLOWED"
  | "INVALID_REASON"
  | "INVALID_INPUT"
  | "LEDGER_INTEGRITY"
  | "IMPORT_REJECTED"
  | "NOT_AVAILABLE"
  | "PRODUCT_NOT_FOUND"
  | "DUPLICATE_SKU"
  | "UNSUPPORTED_UNIT";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
