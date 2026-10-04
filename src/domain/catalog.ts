import { DomainError } from "./errors";
import { type Money, parseDecimal } from "./money";

/** A sellable product as the terminal knows it. Prices are exact Money, never numbers. */
export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly price: Money;
}

/** The shape a catalog is written in (fixture today, a cloud snapshot later): prices as text. */
export interface CatalogSource {
  readonly currency: string;
  readonly products: ReadonlyArray<{
    readonly id: string;
    readonly sku: string;
    readonly name: string;
    readonly price: string;
  }>;
}

export interface Catalog {
  readonly currency: string;
  readonly products: ReadonlyArray<Product>;
  readonly byId: ReadonlyMap<string, Product>;
}

/**
 * Validates and freezes a catalog. Every product is priced in the catalog's single currency;
 * ids and SKUs must be unique and non-empty. A catalog that fails here is never used.
 */
export function loadCatalog(source: CatalogSource): Catalog {
  const byId = new Map<string, Product>();
  const skus = new Set<string>();
  const products: Product[] = [];
  for (const raw of source.products) {
    if (!raw.id || !raw.sku || !raw.name.trim()) {
      throw new DomainError("INVALID_CATALOG", `Product is missing id, sku or name: ${JSON.stringify(raw)}`);
    }
    if (byId.has(raw.id)) throw new DomainError("INVALID_CATALOG", `Duplicate product id '${raw.id}'`);
    if (skus.has(raw.sku)) throw new DomainError("INVALID_CATALOG", `Duplicate SKU '${raw.sku}'`);
    const product: Product = Object.freeze({
      id: raw.id,
      sku: raw.sku,
      name: raw.name.trim(),
      price: parseDecimal(raw.price, source.currency),
    });
    byId.set(product.id, product);
    skus.add(product.sku);
    products.push(product);
  }
  return Object.freeze({ currency: source.currency, products: Object.freeze(products), byId });
}
