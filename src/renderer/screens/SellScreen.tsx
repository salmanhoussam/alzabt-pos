import { useEffect, useMemo, useState } from "react";
import { type CartLine, type PricedCart, addProduct, decrement, priceCart, removeProduct } from "../../domain/cart";
import type { Catalog } from "../../domain/catalog";
import { formatDecimal } from "../../domain/money";
import { formatQuantity, parseQuantity } from "../../domain/quantity";
import { PAYMENT_METHODS, type PaymentMethod } from "../../domain/sale";
import { fromCatalogDto } from "../../shared/dto";
import type { SaleDto } from "../../shared/ipcContract";
import { call, errorText, newIdempotencyKey, pos } from "../api";
import { Receipt } from "./Receipt";

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card (external terminal)",
  external: "External transfer",
  other: "Other",
};

export function SellScreen() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paying, setPaying] = useState(false);
  // One idempotency key per checkout attempt: kept across retries, replaced when the cart changes.
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<SaleDto | null>(null);
  const [query, setQuery] = useState("");
  /**
   * What the operator is typing into a line's quantity box, per product. Held as TEXT until it is
   * committed, so a half-typed "2." is never a quantity; parseQuantity decides at that one moment.
   */
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    call(pos().getCatalog())
      .then((dto) => setCatalog(fromCatalogDto(dto)))
      .catch((e) => setError(errorText(e)));
  }, []);

  // Display total — the main process recomputes from its own catalog and refuses a mismatch.
  const priced: PricedCart | null = useMemo(
    () => (catalog && cart.length ? priceCart(catalog, cart) : null),
    [catalog, cart],
  );

  // Plain substring search on the displayed name (and SKU). No Arabic normalisation in this pilot.
  const visible = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    if (!q) return catalog.products;
    return catalog.products.filter((p) => p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q));
  }, [catalog, query]);

  /**
   * Commits a typed quantity. Invalid text is REFUSED with the domain's own message and the box
   * returns to the quantity that is actually in the cart — a fraction on a whole-only unit is never
   * quietly rounded, and nothing is stored until it parses.
   */
  const commitQuantity = (productId: string, saleUnit: string) => {
    const text = qtyDraft[productId];
    setQtyDraft((d) => {
      const { [productId]: _dropped, ...rest } = d;
      return rest;
    });
    if (text === undefined) return;
    try {
      const quantityMilli = parseQuantity(text, saleUnit);
      setError(null);
      edit(cart.map((l) => (l.productId === productId ? { productId, quantityMilli } : l)));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const edit = (next: CartLine[]) => {
    setCart(next);
    setAttemptKey(newIdempotencyKey());
    setError(null);
  };

  const pay = async (method: PaymentMethod) => {
    if (!priced || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call(
        pos().createSale({
          idempotencyKey: attemptKey,
          lines: cart.map((l) => ({ productId: l.productId, quantityMilli: l.quantityMilli })),
          paymentMethod: method,
          expectedTotalMinor: priced.total.minor.toString(),
        }),
      );
      setCompleted(result.sale);
      setCart([]);
      setPaying(false);
      setAttemptKey(newIdempotencyKey());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (completed) return <Receipt sale={completed} onNewSale={() => setCompleted(null)} />;
  if (!catalog) return <div className="center muted">{error ?? "Loading catalog…"}</div>;

  return (
    <div className="sell">
      <section className="products-pane">
        <input
          className="search"
          type="search"
          dir="auto"
          placeholder={`Search ${catalog.products.length} products…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="products">
          {visible.map((p) => (
            <button key={p.id} className="product" onClick={() => edit(addProduct(cart, p.id))}>
              <span className="product-name" dir="auto">
                {p.name}
              </span>
              {p.sku && <span className="product-sku muted">{p.sku}</span>}
              <span className="product-price">
                {formatDecimal(p.price)}
                {p.baseUnit !== "piece" && <span className="muted"> / {p.baseUnit}</span>}
                {p.priceNeedsReview && <span className="badge" title="Placeholder price — set the real price">price?</span>}
              </span>
            </button>
          ))}
          {visible.length === 0 && <p className="muted">No product matches “{query}”.</p>}
        </div>
      </section>

      <aside className="cart">
        <h2>Current sale</h2>
        {!priced && <p className="muted">Tap a product to add it.</p>}
        {priced && (
          <ul className="lines">
            {priced.lines.map((l) => (
              <li key={l.productId} className="line">
                <div className="line-main">
                  <span dir="auto">{l.productName}</span>
                  <span className="muted">
                    {formatDecimal(l.unitPrice)} × {formatQuantity(l.quantityMilli)} {l.saleUnit}
                  </span>
                </div>
                <div className="qty">
                  <button className="btn key" aria-label="Decrease" onClick={() => edit(decrement(cart, l.productId))}>
                    −
                  </button>
                  <input
                    className="qty-n qty-input"
                    type="text"
                    inputMode="decimal"
                    aria-label={`Quantity in ${l.saleUnit}`}
                    data-testid={`qty-${l.productId}`}
                    value={qtyDraft[l.productId] ?? formatQuantity(l.quantityMilli)}
                    onChange={(e) => setQtyDraft((d) => ({ ...d, [l.productId]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitQuantity(l.productId, l.saleUnit);
                    }}
                    onBlur={() => commitQuantity(l.productId, l.saleUnit)}
                  />
                  <button className="btn key" aria-label="Increase" onClick={() => edit(addProduct(cart, l.productId))}>
                    +
                  </button>
                  <button className="btn ghost" aria-label="Remove" onClick={() => edit(removeProduct(cart, l.productId))}>
                    ✕
                  </button>
                </div>
                <span className="line-total">{formatDecimal(l.lineTotal)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="total">
          <span>Total</span>
          <strong>
            {priced ? formatDecimal(priced.total) : "0.00"} {catalog.currency}
          </strong>
        </div>
        <button className="btn primary big wide" disabled={!priced} onClick={() => setPaying(true)}>
          Complete sale
        </button>
        {cart.length > 0 && (
          <button className="btn ghost wide" onClick={() => edit([])}>
            Clear cart
          </button>
        )}
        {error && !paying && <p className="error">{error}</p>}
      </aside>

      {paying && priced && (
        <div className="overlay">
          <div className="card dialog">
            <h2>
              Payment — {formatDecimal(priced.total)} {priced.currency}
            </h2>
            <p className="muted">Record how the customer paid. No payment is processed here.</p>
            <div className="methods">
              {PAYMENT_METHODS.map((m) => (
                <button key={m} className="btn big" disabled={busy} onClick={() => pay(m)}>
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </div>
            {error && <p className="error">{error}</p>}
            <button className="btn ghost wide" disabled={busy} onClick={() => setPaying(false)}>
              Back to cart
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
