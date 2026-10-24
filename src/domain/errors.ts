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
  // Migration 9, Product Master. Each is a business refusal the UI acts on, not an internal
  // error: a duplicate barcode names the product that holds it, and an inactive category is
  // refused only when newly ASSIGNED — a product that already carries one keeps it.
  | "DUPLICATE_BARCODE"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_INACTIVE"
  | "CATEGORY_IN_USE"
  | "DUPLICATE_CATEGORY"
  // The product's photo. Separate from PRODUCT_NOT_FOUND because the two mean different things to
  // the UI: the product is there and simply has no photo yet, which is an empty state, not an error
  // the operator has to recover from.
  | "IMAGE_NOT_FOUND"
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
  // Migration 12 · an account id that names no party of the asked-for kind. A new ENTITY needs its
  // own code: reusing PRODUCT_NOT_FOUND would tell a cashier the wrong thing about the wrong thing.
  | "PARTY_NOT_FOUND"
  | "DUPLICATE_OPERATOR_NAME"
  | "SETUP_REQUIRED"
  | "SETUP_NOT_REQUIRED"
  // The authorization refusal. Deliberately ONE code for every restricted channel: the operator
  // learns that this action needs an owner, and not which channels exist to probe.
  | "NOT_AUTHORIZED"
  // Migration 16 — issuing an invoice on a customer account. Each is its own code because each is a
  // different sentence the operator can act on (text-context rule): none may borrow a generic one.
  | "CREDIT_OWNER_ONLY"
  | "CREDIT_NEEDS_CUSTOMER"
  | "CREDIT_NEEDS_UNPAID"
  | "CREDIT_NOT_ISSUED"
  | "LAST_OWNER_PROTECTED"
  | "SELF_ROLE_CHANGE"
  // Migration 11. Its own code rather than reusing SELF_ROLE_CHANGE: the refused act is different,
  // and a shop reading "cannot change their own role" after touching a permission switch would be
  // told about the wrong thing.
  | "SELF_PERMISSION_CHANGE"
  // 🔴 The install/upgrade ceremony: while the seeded bootstrap owner has not claimed this
  // terminal, nobody else gets a session OR a setup ticket. Distinct from SETUP_REQUIRED, which is
  // about one operator missing a valid ticket; this is about the TERMINAL not being claimed yet.
  | "OWNER_SETUP_REQUIRED";

/** Internal data for the one data-bearing customer-payment refusal; IPC serializes its bigint as text. */
export interface CustomerPaymentOverpaymentContext {
  readonly outstandingMinor: bigint;
  readonly currency: string;
}

export class DomainError extends Error {
  /**
   * An OPTIONAL machine tag naming WHICH refusal this is, for presentation layers that must say
   * it in another language.
   *
   * 🔴 WHY A TAG AND NOT A NEW CODE. Every photo refusal is honestly `INVALID_INPUT` — the file
   * was not acceptable — and splitting that into six codes would change a domain vocabulary the
   * UI, the tests and the IPC contract already depend on. But "INVALID_INPUT" alone cannot tell a
   * merchant whether to pick a smaller file or a different one, and the only thing that knew the
   * difference was the English sentence. A tag carries the distinction without the prose, so a
   * translation can be looked up instead of parsed out of a message.
   *
   * It is additive and optional: every existing throw site, code, message and behaviour is
   * unchanged, and a consumer that ignores it sees exactly what it saw before.
   */
  readonly code: DomainErrorCode;
  readonly reason?: string;
  readonly context?: CustomerPaymentOverpaymentContext;

  constructor(code: DomainErrorCode, message: string);
  constructor(code: DomainErrorCode, message: string, reason: string);
  constructor(
    code: DomainErrorCode,
    message: string,
    reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING",
    context: CustomerPaymentOverpaymentContext,
  );
  constructor(
    code: DomainErrorCode,
    message: string,
    reason?: string,
    context?: CustomerPaymentOverpaymentContext,
  ) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.context = context;
    this.name = "DomainError";
  }
}
