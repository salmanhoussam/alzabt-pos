import { DomainError } from "./errors";
import { type Money, parseDecimal } from "./money";

/** A sellable product as the terminal knows it. Prices are exact Money, never numbers. */
export interface Product {
  readonly id: string;
  /** Optional: a merchant catalog may have no SKUs. Unique when present. */
  readonly sku: string | null;
  /** The name shown and snapshotted on the sale line (see displayName for local catalogs). */
  readonly name: string;
  /**
   * TILL-NAMES: the two stored names, exactly as the merchant wrote them, for DISPLAY and SEARCH
   * only. Absent on a catalog that has one name (the bundled fixture). `name` above stays the
   * snapshot rule (displayName) — what a sale line records never depends on the screen's language.
   */
  readonly nameAr?: string;
  readonly nameEn?: string | null;
  readonly price: Money;
  /** The unit one quantity of this product is sold in ("piece", "box"). Quantities stay whole. */
  readonly baseUnit: string;
  /** True when the price is a placeholder the merchant still has to set. Still sellable. */
  readonly priceNeedsReview: boolean;
  /**
   * The barcode in its stored, canonical form (`normalizeBarcode` in ./barcode decides that), or
   * null. The Sell screen matches a scan against this EXACTLY — never against the name or SKU.
   */
  readonly barcode: string | null;
}

/** The shape a catalog is written in (fixture or local catalog table): prices as text. */
export interface CatalogSource {
  readonly currency: string;
  readonly products: ReadonlyArray<{
    readonly id: string;
    readonly sku: string | null;
    readonly name: string;
    /** TILL-NAMES: see Product.nameAr / nameEn. Optional; absent on single-name sources. */
    readonly nameAr?: string;
    readonly nameEn?: string | null;
    readonly price: string;
    readonly baseUnit?: string;
    readonly priceNeedsReview?: boolean;
    /** Canonical barcode. Absent means none: a fixture or an older source simply has no barcodes. */
    readonly barcode?: string | null;
  }>;
  /**
   * Canonical barcodes of the shop's INACTIVE products, and nothing else about them.
   *
   * 🔴 STRINGS, NOT PRODUCTS. A scanned inactive product must get its own message rather than "no
   * product found", but an inactive product must never become sellable — so it never enters
   * `products`, and the Sell screen learns only that this code belongs to something not for sale:
   * no id, no name, no price.
   */
  readonly inactiveBarcodes?: ReadonlyArray<string>;
}

/**
 * Longest product id anywhere in the terminal (catalog, IPC, sale snapshot). One constant so the
 * import path and the sale path cannot disagree again (a 77-char imported id once failed the sale
 * path's 64-char limit). Imported ids are "merchant-csv:" + a source_id of at most 64 chars.
 */
export const MAX_PRODUCT_ID_LENGTH = 128;

/**
 * Units a product may be sold in. Validated here rather than in the schema (migration 3 declares
 * `base_unit TEXT NOT NULL CHECK (length(base_unit) > 0)`), which is why this list can grow with
 * NO migration — the reason the first offline release could add four units for free.
 *
 * Since migration 4 a quantity is exact thousandths, and `kg`/`meter` genuinely sell in fractions.
 * A unit NOT named in FRACTIONAL_SALE_UNITS is whole-only, in the code and in the database's own
 * CHECK, so a unit added to this list tomorrow fails closed rather than silently admitting a
 * fraction. Nothing anywhere converts a fraction into a float.
 */
export const BASE_UNITS: ReadonlyArray<string> = Object.freeze([
  "piece",
  "box",
  "pack",
  "kg",
  "meter",
  "other",
]);

/**
 * Units whose quantities may be fractional. Defined once in domain/quantity.ts — the database's own
 * CHECK is spelled from the same list — and re-exported here because the catalog screen labels it.
 */
export { FRACTIONAL_SALE_UNITS } from "./quantity";

/**
 * Approved catalog naming rule: name_ar is required, name_en is optional, and an English display
 * falls back to name_ar. No translation is ever invented.
 */
export function displayName(nameAr: string, nameEn: string | null): string {
  return nameEn ?? nameAr;
}

/**
 * TILL-NAMES (DEC-35h §3): the name a SCREEN shows in a given UI language. Arabic UI → name_ar;
 * English UI → name_en, falling back to name_ar. A single-name product (no nameAr/nameEn) shows
 * `name`. Never invents a translation, and never feeds a sale line — `name` is the snapshot.
 */
export function nameForLanguage(
  p: { readonly name: string; readonly nameAr?: string; readonly nameEn?: string | null },
  lang: "ar" | "en",
): string {
  const ar = p.nameAr ?? p.name;
  if (lang === "ar") return ar;
  return p.nameEn ?? ar;
}

/**
 * The OTHER stored name, for a smaller second line when it helps the merchant; null when the
 * product has only one name or both are the same text.
 */
export function secondaryName(
  p: { readonly name: string; readonly nameAr?: string; readonly nameEn?: string | null },
  lang: "ar" | "en",
): string | null {
  if (p.nameAr === undefined || p.nameEn === undefined || p.nameEn === null) return null;
  const other = lang === "ar" ? p.nameEn : p.nameAr;
  return other.trim() === nameForLanguage(p, lang).trim() ? null : other;
}

/**
 * The fields the till searches: both stored names, the snapshot name, SKU and barcode. Used with
 * domain/arabic.ts `matchesSearch`, the same normalisation Products and Invoices already use.
 */
export function searchFields(p: Product): ReadonlyArray<string | null | undefined> {
  return [p.nameAr, p.nameEn, p.name, p.sku, p.barcode];
}

export interface Catalog {
  readonly currency: string;
  readonly products: ReadonlyArray<Product>;
  readonly byId: ReadonlyMap<string, Product>;
  /** See `CatalogSource.inactiveBarcodes`. Never overlaps an active product's barcode. */
  readonly inactiveBarcodes: ReadonlySet<string>;
  /**
   * DEMO-FALLBACK: true ONLY on the bundled sample catalog served under the explicit demo switch
   * (src/main/demoCatalog.ts). Absent / false on every real catalog. The till shows a permanent
   * warning while it is true.
   */
  readonly demo?: boolean;
}

/** The merchant-mode catalog when the shop has no active product: nothing to sell, never the sample. */
export function emptyCatalog(currency: string): Catalog {
  return Object.freeze({ currency, products: Object.freeze([]), byId: new Map(), inactiveBarcodes: new Set<string>() });
}

/** Marks a validated catalog as the demo sample. Used only under the explicit demo switch. */
export function asDemoCatalog(catalog: Catalog): Catalog {
  return Object.freeze({ ...catalog, demo: true });
}

/**
 * Validates and freezes a catalog. Every product is priced in the catalog's single currency;
 * ids must be unique and non-empty, SKUs and barcodes unique when present. A catalog that fails here
 * is never used.
 */
export function loadCatalog(source: CatalogSource): Catalog {
  const byId = new Map<string, Product>();
  const skus = new Set<string>();
  const barcodes = new Set<string>();
  const products: Product[] = [];
  for (const raw of source.products) {
    if (!raw.id || raw.sku === "" || !raw.name.trim()) {
      throw new DomainError("INVALID_CATALOG", `Product is missing id or name, or has an empty sku: ${JSON.stringify(raw)}`);
    }
    if (raw.id.length > MAX_PRODUCT_ID_LENGTH) {
      throw new DomainError("INVALID_CATALOG", `Product id longer than ${MAX_PRODUCT_ID_LENGTH} characters`);
    }
    if (byId.has(raw.id)) throw new DomainError("INVALID_CATALOG", `Duplicate product id '${raw.id}'`);
    if (raw.sku !== null && skus.has(raw.sku)) throw new DomainError("INVALID_CATALOG", `Duplicate SKU '${raw.sku}'`);
    // 🔴 ONE CODE, ONE PRODUCT. Migration 9's unique index already guarantees this for the local
    // table; a catalog that broke it would let one scan mean two products, so it is refused here too.
    const barcode = raw.barcode ?? null;
    if (barcode !== null && barcodes.has(barcode)) {
      throw new DomainError("INVALID_CATALOG", `Duplicate barcode '${barcode}'`);
    }
    const baseUnit = raw.baseUnit ?? "piece";
    if (!BASE_UNITS.includes(baseUnit)) {
      throw new DomainError("INVALID_CATALOG", `Product '${raw.id}' has unsupported unit '${baseUnit}'`);
    }
    const product: Product = Object.freeze({
      id: raw.id,
      sku: raw.sku,
      name: raw.name.trim(),
      ...(raw.nameAr !== undefined ? { nameAr: raw.nameAr } : {}),
      ...(raw.nameEn !== undefined ? { nameEn: raw.nameEn } : {}),
      price: parseDecimal(raw.price, source.currency),
      baseUnit,
      priceNeedsReview: raw.priceNeedsReview ?? false,
      barcode,
    });
    byId.set(product.id, product);
    if (product.sku !== null) skus.add(product.sku);
    if (barcode !== null) barcodes.add(barcode);
    products.push(product);
  }
  const inactiveBarcodes = new Set<string>();
  for (const code of source.inactiveBarcodes ?? []) {
    if (barcodes.has(code)) {
      throw new DomainError("INVALID_CATALOG", `Barcode '${code}' is listed as both active and inactive`);
    }
    inactiveBarcodes.add(code);
  }
  return Object.freeze({ currency: source.currency, products: Object.freeze(products), byId, inactiveBarcodes });
}
