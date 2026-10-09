import { useEffect, useMemo, useRef, useState } from "react";
import { type CartLine, type PricedCart, addProduct, decrement, priceCart, removeProduct } from "../../domain/cart";
import type { Catalog } from "../../domain/catalog";
import { formatDecimal } from "../../domain/money";
import { formatQuantity, parseQuantity } from "../../domain/quantity";
import { PAYMENT_METHODS, type PaymentMethod } from "../../domain/sale";
import { fromCatalogDto } from "../../shared/dto";
import type { SaleDto } from "../../shared/ipcContract";
import { call, errorText, newIdempotencyKey, pos } from "../api";
import { LineMath } from "../components/LineMath";
import { Receipt } from "./Receipt";
import { useT } from "../i18n";

/** The four real methods, in the order the till uses them. Cash first: it is most of the volume. */
const METHOD_KEY: Record<PaymentMethod, string> = {
  cash: "pay.cash",
  card: "pay.card",
  external: "pay.external",
  other: "pay.other",
};

export function SellScreen() {
  const { t } = useT();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [clearing, setClearing] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const cashRef = useRef<HTMLButtonElement | null>(null);
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

  /** Cash takes the initial focus and Esc returns to the cart; Enter is the browser's own. */
  useEffect(() => {
    if (!paying) return;
    cashRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPaying(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paying]);

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
  if (!catalog) return <div className="center muted">{error ?? t("common.loading")}</div>;

  return (
    <div className="sell">
      <section className="products-pane">
        <div className="search-wrap">
          <input
            ref={searchRef}
            className="search"
            type="search"
            dir="auto"
            placeholder={t("sell.search")}
            value={query}
            data-testid="product-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              /* 🔴 ENTER NEVER GUESSES. It adds a product only when the search leaves exactly ONE
                 candidate, or when the typed text IS a product's SKU or full name. With several
                 matches the operator must choose — a till that silently rings up "the first fuzzy
                 result" sells the wrong thing and nobody notices until the count is short. */
              const q = query.trim().toLowerCase();
              if (!q) return;
              const exact = visible.find(
                (p) => (p.sku ?? "").toLowerCase() === q || p.name.toLowerCase() === q,
              );
              const unique = visible.length === 1 ? visible[0] : undefined;
              const chosen = exact ?? unique;
              if (chosen) {
                edit(addProduct(cart, chosen.id));
                setQuery("");
              }
            }}
          />
          {/* A shortcut is a key, not placeholder prose. */}
          <kbd className="search-kbd" aria-hidden="true">/</kbd>
        </div>
        <div className="products">
          {visible.map((p, i) => (
            /* 🔴 TAB REACHES THE GRID, NOT EVERY CARD. One roving tab stop: Tab moves between work
               regions — search, grid, cart, primary — and arrows move inside the grid. Tabbing
               through fifty products to reach the cart is not a keyboard path, it is a punishment. */
            <button
              key={p.id}
              className="product"
              tabIndex={i === 0 ? 0 : -1}
              onKeyDown={(e) => {
                const cards = Array.from(
                  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button.product") ?? [],
                );
                const here = cards.indexOf(e.currentTarget);
                const step = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
                if (step === 0 && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const columns = 3;
                const delta = step !== 0 ? step : e.key === "ArrowDown" ? columns : -columns;
                const next = cards[Math.min(cards.length - 1, Math.max(0, here + delta))];
                next?.focus();
              }}
              onClick={() => edit(addProduct(cart, p.id))}
            >
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
          {visible.length === 0 && <p className="muted">{t("sell.noMatch")}</p>}
        </div>
      </section>

      <aside className="cart" data-testid="cart">
        <div className="cart-head">
          <h2>{t("sell.currentSale")}</h2>
          {/* 🔴 CLEAR CART LIVES HERE, NOT UNDER THE PRIMARY. It used to be a full-width button
              directly beneath "Complete sale" — a destructive action with the same footprint and
              the same place the hand goes. Ghost-danger, in the header, behind a confirmation. */}
          {cart.length > 0 && (
            <button className="btn danger ghost small" data-testid="clear-cart" onClick={() => setClearing(true)}>
              {t("sell.clearCart")}
            </button>
          )}
        </div>
        {!priced && <p className="muted">{t("sell.empty")}</p>}
        {priced && (
          <ul className="lines">
            {priced.lines.map((l) => (
              <li key={l.productId} className="line">
                <div className="line-main">
                  <span dir="auto">{l.productName}</span>
                  <span className="muted">
                    <LineMath quantityMilli={l.quantityMilli} saleUnit={l.saleUnit} unitPrice={l.unitPrice} />
                  </span>
                </div>
                <div className="qty">
                  <button
                    className="btn key"
                    aria-label={t("sell.decrease")}
                    onClick={() => edit(decrement(cart, l.productId))}
                  >
                    −
                  </button>
                  <input
                    className="qty-n qty-input"
                    type="text"
                    inputMode="decimal"
                    aria-label={t("sell.quantityOf")}
                    data-testid={`qty-${l.productId}`}
                    value={qtyDraft[l.productId] ?? formatQuantity(l.quantityMilli)}
                    onChange={(e) => setQtyDraft((d) => ({ ...d, [l.productId]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitQuantity(l.productId, l.saleUnit);
                    }}
                    onBlur={() => commitQuantity(l.productId, l.saleUnit)}
                  />
                  <button
                    className="btn key"
                    aria-label={t("sell.increase")}
                    onClick={() => edit(addProduct(cart, l.productId))}
                  >
                    +
                  </button>
                  {/* Demoted: removing a line must not look like adjusting one. */}
                  <button
                    className="btn ghost small line-remove"
                    aria-label={t("sell.remove")}
                    title={t("sell.remove")}
                    onClick={() => edit(removeProduct(cart, l.productId))}
                  >
                    ✕
                  </button>
                </div>
                <span className="line-total">{formatDecimal(l.lineTotal)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="cart-foot">
          {/* The count is PRODUCT LINES, not a sum of quantities — "2 صنف" with three of one of
              them is two items on the bill, which is what the operator is checking. */}
          <div className="cart-count muted small">
            <bdi>{cart.length}</bdi> {t("sell.lineCount")}
          </div>
          <div className="total">
            <span>{t("sell.total")}</span>
            {/* One isolated run: amount and currency together, never split. */}
            <strong data-testid="cart-total">
              <bdi dir="ltr">{`${priced ? formatDecimal(priced.total) : "0.00"} ${catalog.currency}`}</bdi>
            </strong>
          </div>
          <button className="btn primary big wide" disabled={!priced} data-testid="complete-sale" onClick={() => setPaying(true)}>
            {t("sell.complete")}
          </button>
        </div>
        {error && !paying && <p className="error">{error}</p>}
      </aside>

      {clearing && (
        <div className="overlay">
          <div className="card dialog" role="dialog" aria-modal="true">
            <h2>{t("sell.clearConfirm")}</h2>
            {/* Names what will be removed, rather than asking "are you sure" about nothing. */}
            <p className="muted small">{t("sell.clearConfirmBody")}</p>
            <ul className="clear-list">
              {cart.map((l) => {
                const product = catalog.products.find((p) => p.id === l.productId);
                return (
                  <li key={l.productId}>
                    <span dir="auto">{product?.name ?? l.productId}</span>{" "}
                    <span className="muted small">
                      <bdi dir="ltr">{formatQuantity(l.quantityMilli)}</bdi>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="row">
              <button className="btn" onClick={() => setClearing(false)} data-testid="clear-dismiss">
                {t("void.dismiss")}
              </button>
              <button
                className="btn danger"
                data-testid="clear-confirm"
                onClick={() => {
                  edit([]);
                  setClearing(false);
                }}
              >
                {t("sell.clearConfirmYes")}
              </button>
            </div>
          </div>
        </div>
      )}

      {paying && priced && (
        <div className="overlay">
          <div className="card dialog">
            <h2>
              {t("pay.title")} — <bdi dir="ltr">{`${formatDecimal(priced.total)} ${priced.currency}`}</bdi>
            </h2>
            <p className="muted small">{t("pay.note")}</p>
            <div className="methods">
              {PAYMENT_METHODS.map((m) => (
                /* 🔴 CASH IS THE INITIAL FOCUS, NOT A FORCED CHOICE. Enter activates whatever the
                   operator has focused; moving to Card and pressing Enter records a card sale.
                   Cash leads because it is most of a shop's volume — a prototype to confirm in the
                   field test, not a decided default. */
                <button
                  key={m}
                  ref={m === "cash" ? cashRef : undefined}
                  className={m === "cash" ? "btn primary big" : "btn big"}
                  disabled={busy}
                  data-testid={`pay-${m}`}
                  onClick={() => pay(m)}
                >
                  {t(METHOD_KEY[m])}
                </button>
              ))}
            </div>
            {error && <p className="error">{error}</p>}
            <button className="btn ghost wide" disabled={busy} onClick={() => setPaying(false)}>
              {t("pay.back")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
