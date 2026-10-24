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
import { normalizeBarcode } from "./barcode";
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
  /**
   * Migration 9's Product Master fields. OPTIONAL AS A GROUP, and optional field by field.
   *
   * 🔴 THE LINE THIS FILE REFUSES TO CROSS: none of these may ever become required. A product with
   * no category, no barcode, no brand, no description and no online visibility is a complete,
   * sellable product — the shop traded for months before any of them existed. These describe a
   * product for the WEBSITE, and local trade must never wait on a description.
   *
   * Absent (the whole `master` key missing) means "this caller does not deal in enrichment", which
   * is what invoice reconciliation and the import path mean. It is NOT "clear these fields" — the
   * repository's own `keep()` draws that line, and this file's job is to ensure what reaches it is
   * valid, not to decide what absence means.
   */
  readonly master?: ProductMasterDraft;
}

/** What an operator may type into the Product Master sections, before any of it is checked. */
export interface ProductMasterDraft {
  readonly categoryId?: string | null;
  /** Raw, as typed or as a decoder returned it. Canonicalized here, never by a screen. */
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly descriptionAr?: string | null;
  readonly descriptionEn?: string | null;
  readonly isOnlineVisible?: boolean;
}

/** A validated draft: the price is exact Money and every string is already trimmed. */
export interface ValidProductDraft {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string | null;
  readonly price: Money;
  readonly baseUnit: string;
  /** Present only when the caller supplied one. Every value is already canonical. */
  readonly master?: ValidProductMaster;
}

export interface ValidProductMaster {
  readonly categoryId?: string | null;
  /** 🔴 CANONICAL. A 12-digit UPC-A has already become its 13-digit EAN-13 form. */
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly descriptionAr?: string | null;
  readonly descriptionEn?: string | null;
  readonly isOnlineVisible?: boolean;
}

export const MAX_BRAND = 120;
export const MAX_DESCRIPTION = 2000;

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

  const master = draft.master === undefined ? undefined : validateProductMaster(draft.master);
  return master === undefined
    ? { nameAr, nameEn, sku, price, baseUnit: draft.baseUnit }
    : { nameAr, nameEn, sku, price, baseUnit: draft.baseUnit, master };
}

/**
 * Validates and canonicalizes the Product Master group.
 *
 * 🔴 EVERY KEY IS PRESERVED AS ABSENT-OR-PRESENT, which is why this builds the object key by key
 * instead of returning a fixed shape. A caller that mentioned only `isOnlineVisible` must not come
 * back holding `descriptionAr: null`, because the repository would read that as "clear it".
 *
 * 🔴 THE CATEGORY IS NOT CHECKED FOR EXISTENCE HERE. That needs the database, and this file is
 * pure. The service checks it, inside the same transaction that writes the product, because
 * checking outside one would be a race against a category being deactivated or deleted.
 */
export function validateProductMaster(draft: ProductMasterDraft): ValidProductMaster {
  const out: {
    categoryId?: string | null;
    barcode?: string | null;
    brand?: string | null;
    descriptionAr?: string | null;
    descriptionEn?: string | null;
    isOnlineVisible?: boolean;
  } = {};

  if (draft.categoryId !== undefined) {
    // A category id is an opaque identifier, not text the operator types, so it is only checked
    // for shape here. `null` is legitimate and means "no category".
    if (draft.categoryId === null) out.categoryId = null;
    else if (typeof draft.categoryId !== "string" || draft.categoryId.trim() === "") {
      throw new DomainError("INVALID_INPUT", "'category_id' must be a category or empty");
    } else out.categoryId = draft.categoryId.trim();
  }

  if (draft.barcode !== undefined) {
    // 🔴 ONE normalization, from the one module that owns it. A screen must never pre-process a
    // barcode, or a typed UPC-A and a decoded EAN-13 would reach storage as two products.
    const normalized = normalizeBarcode(draft.barcode);
    out.barcode = normalized === null ? null : normalized.value;
  }

  if (draft.brand !== undefined) out.brand = optional(draft.brand, "brand", MAX_BRAND);

  if (draft.descriptionAr !== undefined) {
    out.descriptionAr = description(draft.descriptionAr, "description_ar");
  }
  if (draft.descriptionEn !== undefined) {
    out.descriptionEn = description(draft.descriptionEn, "description_en");
  }

  if (draft.isOnlineVisible !== undefined) {
    if (typeof draft.isOnlineVisible !== "boolean") {
      throw new DomainError("INVALID_INPUT", "'is_online_visible' must be true or false");
    }
    out.isOnlineVisible = draft.isOnlineVisible;
  }

  return out;
}

/**
 * A description, which is prose rather than a name.
 *
 * 🔴 DELIBERATELY NOT `optional()`. That helper collapses every run of whitespace into one space,
 * which is right for a name and WRONG for prose: it would destroy the paragraph breaks a merchant
 * typed to describe a product, and those appear on the website. So line breaks survive and only
 * the ends are trimmed. Control characters other than newline and tab are refused, because they
 * would make an exported JSON string lie about its own content.
 */
function description(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", `'${field}' must be text`);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_DESCRIPTION) {
    throw new DomainError("INVALID_INPUT", `'${field}' must be at most ${MAX_DESCRIPTION} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new DomainError("INVALID_INPUT", `'${field}' cannot contain control characters`);
  }
  return trimmed;
}
