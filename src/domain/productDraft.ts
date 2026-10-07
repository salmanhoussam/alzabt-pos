/**
 * Validation for a product the OPERATOR types on the till — the manual counterpart of
 * `catalogImport.ts`, which validates a product that arrives in a file. Pure: no I/O, no database.
 *
 * What is required is exactly what a sale and the approved invoice need, and nothing more:
 * an Arabic name (what the invoice prints), an exact price (what the line is calculated from) and
 * a unit (what the invoice's UNIT column shows). Everything else is optional, and an image is
 * deliberately not among the fields at all.
 *
 * The price goes through `parseDecimal`, so "12", "3.50" are accepted while "$5", "5,00", "1.005",
 * "-1" and "1e3" are refused — the same single entry point a CSV price uses. No float ever appears.
 */
import { BASE_UNITS } from "./catalog";
import { DomainError } from "./errors";
import { type Money, parseDecimal } from "./money";

export const MAX_PRODUCT_NAME = 200;
export const MAX_SKU = 64;

/** Exactly what the operator may type. `null` for an optional field means "not given". */
export interface ProductDraft {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string | null;
  readonly price: string;
  readonly baseUnit: string;
}

/** A validated draft: the price is exact Money and every string is already trimmed. */
export interface ValidProductDraft {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string | null;
  readonly price: Money;
  readonly baseUnit: string;
}

function requiredName(value: unknown, field: string): string {
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", `'${field}' is required`);
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") throw new DomainError("INVALID_INPUT", `'${field}' is required`);
  if (trimmed.length > MAX_PRODUCT_NAME) {
    throw new DomainError("INVALID_INPUT", `'${field}' must be at most ${MAX_PRODUCT_NAME} characters`);
  }
  return trimmed;
}

/** An optional string: empty, whitespace-only and null all mean "not given" — never "" in storage. */
function optional(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", `'${field}' must be text`);
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) throw new DomainError("INVALID_INPUT", `'${field}' must be at most ${max} characters`);
  return trimmed;
}

export function validateProductDraft(draft: ProductDraft, currency: string): ValidProductDraft {
  const nameAr = requiredName(draft.nameAr, "name_ar");
  const nameEn = optional(draft.nameEn, "name_en", MAX_PRODUCT_NAME);
  const sku = optional(draft.sku, "sku", MAX_SKU);

  if (typeof draft.baseUnit !== "string" || draft.baseUnit === "") {
    throw new DomainError("INVALID_INPUT", "A unit is required");
  }
  if (!BASE_UNITS.includes(draft.baseUnit)) {
    throw new DomainError("UNSUPPORTED_UNIT", `'${draft.baseUnit}' is not a unit this terminal sells in`);
  }

  if (typeof draft.price !== "string") throw new DomainError("INVALID_AMOUNT", "A selling price is required");
  const price = parseDecimal(draft.price.trim(), currency);
  // migration 3: selling_price_minor > 0. A product with no price yet is represented by
  // price_needs_review on an imported row, never by a zero — the column refuses a zero anyway.
  if (price.minor <= 0n) {
    throw new DomainError("INVALID_AMOUNT", "The selling price must be greater than zero");
  }

  return { nameAr, nameEn, sku, price, baseUnit: draft.baseUnit };
}
