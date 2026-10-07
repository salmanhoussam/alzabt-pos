import { DomainError } from "./errors";
import { type Money, parseDecimal } from "./money";

/** A sellable product as the terminal knows it. Prices are exact Money, never numbers. */
export interface Product {
  readonly id: string;
  /** Optional: a merchant catalog may have no SKUs. Unique when present. */
  readonly sku: string | null;
  /** The name shown and snapshotted on the sale line (see displayName for local catalogs). */
  readonly name: string;
  readonly price: Money;
  /** The unit one quantity of this product is sold in ("piece", "box"). Quantities stay whole. */
  readonly baseUnit: string;
  /** True when the price is a placeholder the merchant still has to set. Still sellable. */
  readonly priceNeedsReview: boolean;
}

/** The shape a catalog is written in (fixture or local catalog table): prices as text. */
export interface CatalogSource {
  readonly currency: string;
  readonly products: ReadonlyArray<{
    readonly id: string;
    readonly sku: string | null;
    readonly name: string;
    readonly price: string;
    readonly baseUnit?: string;
    readonly priceNeedsReview?: boolean;
  }>;
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

export interface Catalog {
  readonly currency: string;
  readonly products: ReadonlyArray<Product>;
  readonly byId: ReadonlyMap<string, Product>;
}

/**
 * Validates and freezes a catalog. Every product is priced in the catalog's single currency;
 * ids must be unique and non-empty, SKUs unique when present. A catalog that fails here is never used.
 */
export function loadCatalog(source: CatalogSource): Catalog {
  const byId = new Map<string, Product>();
  const skus = new Set<string>();
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
    const baseUnit = raw.baseUnit ?? "piece";
    if (!BASE_UNITS.includes(baseUnit)) {
      throw new DomainError("INVALID_CATALOG", `Product '${raw.id}' has unsupported unit '${baseUnit}'`);
    }
    const product: Product = Object.freeze({
      id: raw.id,
      sku: raw.sku,
      name: raw.name.trim(),
      price: parseDecimal(raw.price, source.currency),
      baseUnit,
      priceNeedsReview: raw.priceNeedsReview ?? false,
    });
    byId.set(product.id, product);
    if (product.sku !== null) skus.add(product.sku);
    products.push(product);
  }
  return Object.freeze({ currency: source.currency, products: Object.freeze(products), byId });
}
