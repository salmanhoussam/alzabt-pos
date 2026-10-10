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
  // A sale that came from a finalized invoice. Its honest correction is a credit note, which does
  // not exist yet, so the POS void refuses rather than half-cancelling a commercial document.
  | "VOID_NOT_ALLOWED_FOR_INVOICE"
  | "INVALID_REASON"
  | "INVALID_INPUT"
  | "LEDGER_INTEGRITY"
  | "IMPORT_REJECTED"
  | "NOT_AVAILABLE"
  | "PRODUCT_NOT_FOUND"
  | "DUPLICATE_SKU"
  | "UNSUPPORTED_UNIT"
  // migration 4 — exact quantities
  | "FRACTION_NOT_ALLOWED"
  | "ZERO_VALUE_LINE"
  | "PRICE_OUT_OF_RANGE"
  // migration 6 — manual invoices and catalog reconciliation
  | "INVOICE_NOT_FOUND"
  | "INVOICE_NOT_DRAFT"
  | "INVOICE_NOT_FINALIZABLE"
  | "COMPANY_PROFILE_REQUIRED"
  | "INVOICE_NUMBERING_LOCKED"
  | "RECONCILIATION_NOT_FOUND"
  | "RECONCILIATION_ALREADY_RESOLVED"
  | "RESOLUTION_INCOMPLETE"
  // migration 8 — operator accounts and role-based authorization
  | "INVALID_PIN"
  | "OPERATOR_NOT_FOUND"
  | "OPERATOR_INACTIVE"
  | "DUPLICATE_OPERATOR_NAME"
  | "SETUP_REQUIRED"
  | "SETUP_NOT_REQUIRED"
  // The authorization refusal. Deliberately ONE code for every restricted channel: the operator
  // learns that this action needs an owner, and not which channels exist to probe.
  | "NOT_AUTHORIZED"
  | "LAST_OWNER_PROTECTED"
  | "SELF_ROLE_CHANGE";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
