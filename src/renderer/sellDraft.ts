import type { CartLine } from "../domain/cart";
import type { Catalog } from "../domain/catalog";
import type { CustomerDto } from "../shared/ipcContract";

/**
 * SELL-CART-LOST-ON-TAB (owner go, 2026-11-08) — the Sell screen's unfinished work, kept while the
 * operator looks at another tab.
 *
 * WHY IT IS NEEDED. App renders Sell only while its tab is active, so leaving the tab unmounted the
 * screen and lost the cart, the chosen customer and the checkout's idempotency key.
 *
 * 🔴 WHAT IT IS — AND IS NOT.
 *  • Memory only, in the running window. Nothing is written to the ledger, the disk or the main
 *    process: switching tabs creates no sale, no payment, no debt and no stock movement. It is NOT kept
 *    when the app closes, restarts or crashes — this promises a tab switch, never a saved cart.
 *  • The cart has no per-line notes today; what is kept is everything it holds: products, quantities,
 *    the chosen customer and the checkout key.
 *  • Lines are product + quantity only. Prices are NEVER kept here: they are recomputed from the fresh
 *    catalogue on return, and the main process re-prices and refuses a mismatch at checkout.
 *  • The checkout key is kept with the cart. If a sale was in flight when the operator left, pressing
 *    pay again with the same cart replays under the same key and can never record a second sale.
 *  • It belongs to ONE operator: a draft is handed back only to the operator who left it, and App drops
 *    it on sign-out, so one cashier's cart never reaches another.
 *  • A catalogue import starts a fresh till (unchanged behaviour); a completed sale empties it.
 */
export interface SellDraft {
  readonly operatorId: string;
  readonly cart: ReadonlyArray<CartLine>;
  readonly customer: CustomerDto | null;
  readonly attemptKey: string;
}

/** The draft the operator signed in NOW may resume — theirs, or none. */
export function draftFor(draft: SellDraft | null, operatorId: string | null | undefined): SellDraft | null {
  if (!draft || !operatorId) return null;
  return draft.operatorId === operatorId ? draft : null;
}

/**
 * A kept cart against the catalogue as it is NOW. A product deactivated or removed while the operator
 * was away is dropped (it can no longer be sold, and pricing it would fail); everything else is kept
 * exactly — same products, same quantities, same order, nothing duplicated.
 */
export function keepSellableLines(
  cart: ReadonlyArray<CartLine>,
  catalog: Catalog,
): { readonly kept: CartLine[]; readonly dropped: number } {
  const sellable = new Set(catalog.products.map((p) => p.id));
  const kept = cart.filter((l) => sellable.has(l.productId));
  return { kept, dropped: cart.length - kept.length };
}
