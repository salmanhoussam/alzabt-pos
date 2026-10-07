/**
 * The cart is a list of (productId, quantityMilli) — nothing else. Prices are NEVER carried in the
 * cart: they are looked up from the catalog when the cart is priced, so the renderer cannot supply a
 * price. The same `priceCart` runs in the renderer (to show a running total) and in the main
 * process (to compute the amount that is actually recorded), so there is one arithmetic only.
 *
 * Quantities are exact thousandths of a sale unit (see domain/quantity.ts). The cart never holds a
 * decimal number: operator text becomes an integer at `parseQuantity`, once.
 */
import type { Catalog } from "./catalog";
import { DomainError } from "./errors";
import { type Money, add, zero } from "./money";
import { QUANTITY_SCALE, assertQuantityMilli, lineTotal } from "./quantity";

export const MAX_CART_LINES = 200;

export interface CartLine {
  readonly productId: string;
  /** Thousandths of one sale unit: 1 piece is 1000, 2.5 kg is 2500. */
  readonly quantityMilli: number;
}

export interface PricedLine {
  readonly lineNo: number;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  /** The unit this line is sold in, snapshotted onto the sale line. */
  readonly saleUnit: string;
  readonly quantityMilli: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

export interface PricedCart {
  readonly currency: string;
  readonly lines: ReadonlyArray<PricedLine>;
  readonly subtotal: Money;
  /** Equal to subtotal in this gate: no tax, discount or rounding rule exists yet. */
  readonly total: Money;
}

/**
 * The sale unit of a cart line. In V1 this is always the product's `base_unit` — one selling unit
 * per product — and that equality is the invariant a future pack-pricing migration relies on to
 * backfill a conversion of exactly 1. It is read here, in one place, so that when sell units arrive
 * only this function changes.
 */
export function saleUnitFor(catalog: Catalog, productId: string): string {
  const product = catalog.byId.get(productId);
  if (!product) throw new DomainError("UNKNOWN_PRODUCT", `Unknown product '${productId}'`);
  return product.baseUnit;
}

// ── Pure cart edits (return a new array; never mutate) ─────────────────────────────────────────

/**
 * Adds one whole sale unit, or one more of it. Tapping a product is always a whole unit: a fraction
 * is typed deliberately through `setQuantityMilli`, never produced by tapping.
 */
export function addProduct(cart: ReadonlyArray<CartLine>, productId: string): CartLine[] {
  const existing = cart.find((l) => l.productId === productId);
  if (existing) {
    return cart.map((l) =>
      l.productId === productId ? { productId, quantityMilli: l.quantityMilli + QUANTITY_SCALE } : l,
    );
  }
  if (cart.length >= MAX_CART_LINES) {
    throw new DomainError("INVALID_QUANTITY", `A sale may have at most ${MAX_CART_LINES} lines`);
  }
  return [...cart, { productId, quantityMilli: QUANTITY_SCALE }];
}

/** Sets an exact quantity. The unit decides whether a fraction is allowed; it is validated here. */
export function setQuantityMilli(
  cart: ReadonlyArray<CartLine>,
  productId: string,
  quantityMilli: number,
  saleUnit: string,
): CartLine[] {
  assertQuantityMilli(quantityMilli, saleUnit);
  return cart.map((l) => (l.productId === productId ? { productId, quantityMilli } : l));
}

/**
 * Decrease by one whole sale unit; a line that would reach zero or below is removed. On a fractional
 * line this first drops the fraction (2.5 kg -> 2 kg), which is what a till operator means by "one
 * less" — it never produces a negative or a surprising remainder.
 */
export function decrement(cart: ReadonlyArray<CartLine>, productId: string): CartLine[] {
  const line = cart.find((l) => l.productId === productId);
  if (!line) return [...cart];
  const whole = Math.floor(line.quantityMilli / QUANTITY_SCALE) * QUANTITY_SCALE;
  const next = whole === line.quantityMilli ? line.quantityMilli - QUANTITY_SCALE : whole;
  if (next < QUANTITY_SCALE && next !== 0) {
    // A sub-unit remainder (0.5 kg) decremented away leaves nothing to sell.
    return removeProduct(cart, productId);
  }
  return next <= 0
    ? removeProduct(cart, productId)
    : cart.map((l) => (l.productId === productId ? { productId, quantityMilli: next } : l));
}

export function removeProduct(cart: ReadonlyArray<CartLine>, productId: string): CartLine[] {
  return cart.filter((l) => l.productId !== productId);
}

// ── Pricing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Prices a cart against a catalog. Duplicate product ids are rejected (a well-formed cart has one
 * line per product); every product must exist; all lines must share one currency. Each line's total
 * comes from `lineTotal`, the single exact-integer rule the database also checks.
 */
export function priceCart(catalog: Catalog, cart: ReadonlyArray<CartLine>): PricedCart {
  if (cart.length === 0) throw new DomainError("EMPTY_CART", "The cart is empty");
  if (cart.length > MAX_CART_LINES) {
    throw new DomainError("INVALID_QUANTITY", `A sale may have at most ${MAX_CART_LINES} lines`);
  }
  const seen = new Set<string>();
  const lines: PricedLine[] = [];
  let subtotal = zero(catalog.currency);
  cart.forEach((line, index) => {
    if (seen.has(line.productId)) {
      throw new DomainError("INVALID_INPUT", `Product '${line.productId}' appears twice in the cart`);
    }
    seen.add(line.productId);
    const product = catalog.byId.get(line.productId);
    if (!product) throw new DomainError("UNKNOWN_PRODUCT", `Unknown product '${line.productId}'`);
    if (product.price.currency !== catalog.currency) {
      throw new DomainError("MIXED_CURRENCY", `Product '${product.id}' is not priced in ${catalog.currency}`);
    }
    const saleUnit = product.baseUnit;
    const total = lineTotal(product.price, line.quantityMilli, saleUnit);
    subtotal = add(subtotal, total);
    lines.push({
      lineNo: index + 1,
      productId: product.id,
      // sale_lines.sku is NOT NULL (Gate 1 schema, immutable): a product without a SKU snapshots "".
      sku: product.sku ?? "",
      productName: product.name,
      saleUnit,
      quantityMilli: line.quantityMilli,
      unitPrice: product.price,
      lineTotal: total,
    });
  });
  return { currency: catalog.currency, lines, subtotal, total: subtotal };
}
