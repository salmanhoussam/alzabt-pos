/**
 * The cart is a list of (productId, quantity) — nothing else. Prices are NEVER carried in the cart:
 * they are looked up from the catalog when the cart is priced, so the renderer cannot supply a
 * price. The same `priceCart` runs in the renderer (to show a running total) and in the main
 * process (to compute the amount that is actually recorded), so there is one arithmetic only.
 */
import type { Catalog } from "./catalog";
import { DomainError } from "./errors";
import { type Money, add, multiply, zero } from "./money";

export const MAX_QUANTITY = 9999;
export const MAX_CART_LINES = 200;

export interface CartLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface PricedLine {
  readonly lineNo: number;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly quantity: number;
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

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new DomainError("INVALID_QUANTITY", `Quantity must be an integer between 1 and ${MAX_QUANTITY}`);
  }
}

// ── Pure cart edits (return a new array; never mutate) ─────────────────────────────────────────

export function addProduct(cart: ReadonlyArray<CartLine>, productId: string): CartLine[] {
  const existing = cart.find((l) => l.productId === productId);
  if (existing) return setQuantity(cart, productId, existing.quantity + 1);
  if (cart.length >= MAX_CART_LINES) {
    throw new DomainError("INVALID_QUANTITY", `A sale may have at most ${MAX_CART_LINES} lines`);
  }
  return [...cart, { productId, quantity: 1 }];
}

export function setQuantity(cart: ReadonlyArray<CartLine>, productId: string, quantity: number): CartLine[] {
  assertQuantity(quantity);
  return cart.map((l) => (l.productId === productId ? { productId, quantity } : l));
}

/** Decrease by one; a line that would reach zero is removed. */
export function decrement(cart: ReadonlyArray<CartLine>, productId: string): CartLine[] {
  const line = cart.find((l) => l.productId === productId);
  if (!line) return [...cart];
  return line.quantity <= 1 ? removeProduct(cart, productId) : setQuantity(cart, productId, line.quantity - 1);
}

export function removeProduct(cart: ReadonlyArray<CartLine>, productId: string): CartLine[] {
  return cart.filter((l) => l.productId !== productId);
}

// ── Pricing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Prices a cart against a catalog. Duplicate product ids are rejected (a well-formed cart has one
 * line per product); every product must exist; all lines must share one currency.
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
    assertQuantity(line.quantity);
    if (seen.has(line.productId)) {
      throw new DomainError("INVALID_INPUT", `Product '${line.productId}' appears twice in the cart`);
    }
    seen.add(line.productId);
    const product = catalog.byId.get(line.productId);
    if (!product) throw new DomainError("UNKNOWN_PRODUCT", `Unknown product '${line.productId}'`);
    if (product.price.currency !== catalog.currency) {
      throw new DomainError("MIXED_CURRENCY", `Product '${product.id}' is not priced in ${catalog.currency}`);
    }
    const lineTotal = multiply(product.price, line.quantity);
    subtotal = add(subtotal, lineTotal);
    lines.push({
      lineNo: index + 1,
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      quantity: line.quantity,
      unitPrice: product.price,
      lineTotal,
    });
  });
  return { currency: catalog.currency, lines, subtotal, total: subtotal };
}
