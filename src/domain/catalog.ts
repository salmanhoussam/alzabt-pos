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

/** Units a product may be sold in today. Fractional units (kg, m) need fractional quantities first. */
export const BASE_UNITS: ReadonlyArray<string> = Object.freeze(["piece", "box"]);

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
