/**
 * The manual invoice — its arithmetic, its states, and the rules that make a finalized one a
 * commercial document rather than an editable form.
 *
 * 🔴 AN INVOICE IS NOT A SALE, IN V1 AND BY DECISION. Finalizing one writes no `sales` row, enters
 * no daily total, moves no stock and creates no customer ledger entry. `paid` and `balance_due` are
 * fields ON THE DOCUMENT; they are not an accounts-receivable system, and nothing here should be
 * read as if they were.
 *
 * 🔴 THE FRACTION RULE DOES NOT APPLY HERE, AND THAT IS DELIBERATE. `quantity.ts`'s `lineTotal`
 * refuses a fraction of a whole-only sale unit, because the till must not invent half a hammer. An
 * invoice is a different act: it RECORDS WHAT WAS COMMERCIALLY WRITTEN, in the merchant's own
 * words, including a unit label this build has never heard of. So the same exact integer
 * arithmetic, the same overflow guard, the same rounding — without the catalog's unit policy, which
 * stays where it belongs: on `catalog_products`.
 */
import { DomainError } from "./errors";
import { type Money, add, money, zero } from "./money";
import {
  MAX_QUANTITY_DECIMALS,
  MAX_QUANTITY_MILLI,
  MAX_QUANTITY_UNITS,
  QUANTITY_SCALE,
  assertUnitPriceMinor,
  formatQuantity,
} from "./quantity";

export const INVOICE_STATUSES = ["draft", "final"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** A sheet of paper holds far fewer; this is the bound, not a target. */
export const MAX_INVOICE_LINES = 200;
export const MAX_DESCRIPTION = 200;
export const MAX_CUSTOMER_FIELD = 200;
export const MAX_NOTES = 500;

/** Tax is held in basis points so a rate is an exact integer: 1100 = 11.00%. */
export const TAX_RATE_SCALE = 10_000;

export interface InvoiceLineAmounts {
  readonly quantityMilli: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

/**
 * The invoice's quantity, parsed from what the operator typed.
 *
 * Accepts the same shapes `parseQuantity` does — "2", "2.5", "0.333", "34" — and refuses the same
 * malformed ones. It does NOT consult a unit: see the note at the top of this file.
 */
export function parseInvoiceQuantity(text: unknown): number {
  if (typeof text !== "string") {
    throw new DomainError("INVALID_QUANTITY", "A quantity is required");
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) {
    throw new DomainError("INVALID_QUANTITY", `'${text}' is not a plain decimal quantity`);
  }
  const frac = match[2] ?? "";
  if (frac.length > MAX_QUANTITY_DECIMALS) {
    throw new DomainError(
      "INVALID_QUANTITY",
      `'${text}' has more than ${MAX_QUANTITY_DECIMALS} decimal places`,
    );
  }
  const whole = Number(match[1]!);
  if (!Number.isSafeInteger(whole) || whole > MAX_QUANTITY_UNITS) {
    throw new DomainError("INVALID_QUANTITY", `A quantity may not exceed ${MAX_QUANTITY_UNITS} units`);
  }
  const quantityMilli = whole * QUANTITY_SCALE + Number(frac.padEnd(MAX_QUANTITY_DECIMALS, "0") || "0");
  assertInvoiceQuantity(quantityMilli);
  return quantityMilli;
}

/** Range only — positive, within the established safe bound. No unit policy. */
export function assertInvoiceQuantity(quantityMilli: number): void {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli < 1 || quantityMilli > MAX_QUANTITY_MILLI) {
    throw new DomainError(
      "INVALID_QUANTITY",
      `A quantity must be between 0.001 and ${MAX_QUANTITY_UNITS} units`,
    );
  }
}

/**
 * One invoice line's total — the identical exact-integer rule the ledger already uses:
 *
 *     line_total_minor = (quantity_milli * unit_price_minor + 500) / 1000
 *
 * `bigint` division truncates and both operands are non-negative, so it equals SQLite's integer
 * division on INTEGER columns in a STRICT table — which is what lets the database CHECK admit this
 * result and no other. `assertUnitPriceMinor` is the same overflow guard: it keeps the
 * multiplication itself inside signed 64-bit INTEGER, because SQLite does not raise on overflow, it
 * silently yields a REAL.
 *
 * A zero total is ALLOWED here, unlike on a sale: an invoice may legitimately carry a free item,
 * and refusing it would block a document the merchant is entitled to write.
 */
export function invoiceLineTotal(unitPrice: Money, quantityMilli: number): Money {
  assertInvoiceQuantity(quantityMilli);
  assertUnitPriceMinor(unitPrice.minor);
  const total = (BigInt(quantityMilli) * unitPrice.minor + 500n) / BigInt(QUANTITY_SCALE);
  return money(total, unitPrice.currency);
}

export interface TaxConfig {
  readonly enabled: boolean;
  /** Basis points. 1100 = 11.00%. Ignored entirely when `enabled` is false. */
  readonly rateBasisPoints: number;
  /** What the line prints as, e.g. "VAT 11%". Snapshotted with the invoice. */
  readonly label: string | null;
}

/** 🔴 Tax is OFF unless a company profile turns it on. No rate is hard-coded anywhere. */
export const TAX_DISABLED: TaxConfig = Object.freeze({ enabled: false, rateBasisPoints: 0, label: null });

export interface InvoiceTotals {
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly paid: Money;
  readonly balanceDue: Money;
}

export function assertTaxConfig(tax: TaxConfig): void {
  if (!tax.enabled) return;
  if (!Number.isSafeInteger(tax.rateBasisPoints) || tax.rateBasisPoints < 0 || tax.rateBasisPoints > TAX_RATE_SCALE) {
    throw new DomainError("INVALID_AMOUNT", "A tax rate must be between 0 and 100 percent");
  }
}

/**
 * The invoice's totals, in exact integers throughout.
 *
 *   subtotal     = sum of line totals
 *   tax          = (subtotal * rate_basis_points + 5000) / 10000   — half up, integer, or zero
 *   total        = subtotal + tax
 *   balance_due  = total - paid
 *
 * `paid` may exceed nothing and may be zero: the real document this replaces is routinely issued
 * with PAID 0.00 and the full amount outstanding. Overpayment is refused, because a negative
 * balance due is not something this document can express.
 */
export function computeInvoiceTotals(
  lineTotals: ReadonlyArray<Money>,
  currency: string,
  tax: TaxConfig,
  paid: Money,
): InvoiceTotals {
  assertTaxConfig(tax);
  if (paid.currency !== currency) {
    throw new DomainError("MIXED_CURRENCY", `Paid amount is not in ${currency}`);
  }
  if (paid.minor < 0n) throw new DomainError("INVALID_AMOUNT", "A paid amount must not be negative");

  let subtotal = zero(currency);
  for (const lineTotal of lineTotals) {
    if (lineTotal.currency !== currency) {
      throw new DomainError("MIXED_CURRENCY", `An invoice line is not in ${currency}`);
    }
    subtotal = add(subtotal, lineTotal);
  }

  const taxMinor = tax.enabled
    ? (subtotal.minor * BigInt(tax.rateBasisPoints) + BigInt(TAX_RATE_SCALE / 2)) / BigInt(TAX_RATE_SCALE)
    : 0n;
  const taxAmount = money(taxMinor, currency);
  const total = add(subtotal, taxAmount);

  if (paid.minor > total.minor) {
    throw new DomainError("INVALID_AMOUNT", "The paid amount is greater than the invoice total");
  }
  return {
    subtotal,
    tax: taxAmount,
    total,
    paid,
    balanceDue: money(total.minor - paid.minor, currency),
  };
}

// ── Field validation, shared by the draft editor and the finalize gate ──────────────────────────

export function cleanText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", `'${field}' must be text`);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new DomainError("INVALID_INPUT", `'${field}' must be at most ${max} characters`);
  }
  return trimmed;
}

export function requireText(value: unknown, field: string, max: number): string {
  const cleaned = cleanText(value, field, max);
  if (cleaned === null) throw new DomainError("INVALID_INPUT", `'${field}' is required`);
  return cleaned;
}

/**
 * What a line must have before an invoice carrying it can be FINALIZED. A draft may hold less — the
 * operator is allowed to write half an invoice, walk away, and come back.
 */
export function assertLineFinalizable(line: {
  readonly description: string | null;
  readonly unitLabel: string | null;
  readonly quantityMilli: number;
}): void {
  if (!line.description || line.description.trim() === "") {
    throw new DomainError("INVALID_INPUT", "Every invoice line needs a description before finalizing");
  }
  if (!line.unitLabel || line.unitLabel.trim() === "") {
    throw new DomainError("INVALID_INPUT", `'${line.description}' has no unit`);
  }
  assertInvoiceQuantity(line.quantityMilli);
}

/** The printed quantity, reusing the ledger's one formatter so the two can never disagree. */
export const formatInvoiceQuantity = formatQuantity;
