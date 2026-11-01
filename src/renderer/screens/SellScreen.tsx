import { useEffect, useMemo, useRef, useState } from "react";
import { CustomerFinder } from "./CustomerFinder";
import type { CustomerDto } from "../../shared/ipcContract";
import { type CartLine, type PricedCart, addProduct, decrement, priceCart, removeProduct } from "../../domain/cart";
import type { Catalog } from "../../domain/catalog";
import { formatDecimal } from "../../domain/money";
import { formatQuantity, parseQuantity } from "../../domain/quantity";
import { PAYMENT_METHODS, type PaymentMethod } from "../../domain/sale";
import { fromCatalogDto } from "../../shared/dto";
import type { AdminProductDto, SaleDto } from "../../shared/ipcContract";
import { call, errorText, newIdempotencyKey, pos } from "../api";
import { useThumbnails } from "../useThumbnails";
import { LineMath } from "../components/LineMath";
import { Receipt } from "./Receipt";
import { useT } from "../i18n";
import {
  SCAN_MESSAGE_KEY,
  type ScanOutcome,
  enterAction,
  isSearchShortcut,
  isTypeToSearch,
  quantityEnterAction,
  refuseEnterActivation,
  resolveScan,
} from "../sellScan";

/** The four real methods, in the order the till uses them. Cash first: it is most of the volume. */
const METHOD_KEY: Record<PaymentMethod, string> = {
  cash: "pay.cash",
  card: "pay.card",
  external: "pay.external",
  other: "pay.other",
};

/**
 * `focusRequest` is bumped by the tab bar when the operator clicks Sell while Sell is already open:
 * that click focuses the tab button and does not remount this screen, so `autoFocus` cannot help.
 */
export function SellScreen({ focusRequest = 0 }: { readonly focusRequest?: number } = {}) {
  const { t, unit } = useT();
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
  /** The refusal of the last scan (unknown / inactive / invalid code), until the field changes. */
  const [scanNote, setScanNote] = useState<keyof typeof SCAN_MESSAGE_KEY | null>(null);
  /**
   * What the operator is typing into a line's quantity box, per product. Held as TEXT until it is
   * committed, so a half-typed "2." is never a quantity; parseQuantity decides at that one moment.
   */
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});

  /**
   * The photo METADATA for the catalogue — an id, a MIME and a content hash per photographed
   * product. No bytes.
   *
   * 🔴 THE EXISTING CHANNEL, NOT A NEW ONE. `listProducts` is `requireCashier`, and its handler
   * already reads photos through `primaryPhotoIndex` — one indexed query returning metadata,
   * explicitly never a join that carries BLOBs. So the Sell screen learns WHICH products have a
   * photo for one list read, and the pricing catalogue (`getCatalog`) is untouched: no image field
   * entered the pricing DTO, and no image bytes travel on a product-list channel.
   *
   * 🔴 AND A FAILURE HERE COSTS THUMBNAILS, NEVER SELLING. The catch sets no error: a till whose
   * photo index cannot be read must still sell, so the grid falls back to placeholders.
   */
  const [photoMeta, setPhotoMeta] = useState<readonly AdminProductDto[]>([]);

  useEffect(() => {
    call(pos().getCatalog())
      .then((dto) => setCatalog(fromCatalogDto(dto)))
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    let live = true;
    void call(pos().listProducts())
      .then((rows) => {
        if (live) setPhotoMeta(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
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
   * The photo rows for the products ON SCREEN — the input the shared hook's six rules consume.
   *
   * 🔴 THE SEARCH RESULT, NOT THE CATALOGUE. 508 photographed products would be 508 reads on open
   * if this passed everything; it passes what the grid renders, so typing narrows the set rather
   * than multiplying it, and a keystroke that reveals nothing new fetches nothing.
   */
  const visibleIds = useMemo(() => new Set(visible.map((p) => p.id)), [visible]);
  const visiblePhotos = useMemo(() => photoMeta.filter((row) => visibleIds.has(row.id)), [photoMeta, visibleIds]);
  const thumbs = useThumbnails(visiblePhotos);

  /** The product whose photo is open full size. Viewing only — it touches no cart and no data. */
  const [preview, setPreview] = useState<{ readonly name: string; readonly url: string } | null>(null);
  /**
   * The customer the operator picked, for their own reference.
   *
   * 🔴 IT IS NOT ATTACHED TO THE SALE, AND THE SCREEN SAYS SO. `CreateSaleRequest` carries no
   * customer id — the sales contract has no such field until the credit/receivable slice lands — so
   * pretending otherwise here would be the one thing worse than not having the feature: a cashier
   * believing a debt was recorded when nothing was. It is a label beside the cart and nothing else.
   */
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [findingCustomer, setFindingCustomer] = useState(false);

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

  /**
   * Esc closes the photo preview, the same way it leaves the payment pane.
   *
   * 🔴 AND FOCUS GOES BACK WHERE IT CAME FROM. The control that opened the preview is remembered
   * and refocused on close, so a cashier working by keyboard is not dropped at the top of the grid.
   */
  useEffect(() => {
    if (preview === null) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPreview(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [preview]);

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

  /**
   * 🔴 FOCUS COMES BACK TO THE SEARCH FIELD, BECAUSE A SCAN GOES WHEREVER FOCUS IS. A scanner types
   * its code and presses Enter into the focused element: left on a product card or a "+" button,
   * that Enter clicks it and sells the wrong thing. So the field takes focus when the screen opens
   * (`autoFocus`, which also covers "New sale" after a receipt), when the payment pane closes, after
   * a mouse click that changed the cart, and on `/`.
   */
  useEffect(() => {
    if (!paying) return;
    return () => searchRef.current?.focus();
  }, [paying]);

  /**
   * `/` focuses the field; any other printable key typed on something that is not a text field
   * (a card, a cart button, a tab) moves focus to the field FIRST, so it — and the rest of a scan,
   * Enter included — lands there (`isTypeToSearch`). Off while a dialog or the payment pane is open.
   */
  useEffect(() => {
    if (paying || preview !== null || findingCustomer || clearing) return;
    const onKey = (e: KeyboardEvent) => {
      const field = searchRef.current;
      if (!field) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (isSearchShortcut(e, target)) {
        e.preventDefault();
        field.focus();
        return;
      }
      if (target !== field && isTypeToSearch(e, target)) field.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paying, preview, findingCustomer, clearing]);

  /** The tab bar's request: the Sell tab was clicked while Sell was already open. */
  useEffect(() => {
    if (focusRequest === 0) return;
    if (paying || preview !== null || findingCustomer || clearing) return;
    searchRef.current?.focus();
    // Only a NEW request may move focus; the dialog flags are read as they are at that moment.
  }, [focusRequest]);

  /** Focus (and optionally select) the field after React has rendered what the handler set. */
  const focusSearchAfterRender = (select: boolean) => {
    requestAnimationFrame(() => {
      const field = searchRef.current;
      if (!field) return;
      field.focus();
      if (select) field.select();
    });
  };

  /** A mouse click (detail > 0) returns focus to the field; a keyboard press keeps the operator where they are. */
  const refocusAfterClick = (e: { readonly detail: number }) => {
    if (e.detail > 0) searchRef.current?.focus();
  };

  const edit = (next: CartLine[]) => {
    setCart(next);
    setAttemptKey(newIdempotencyKey());
    setError(null);
  };

  /**
   * Applies one resolved scan — from the search field, or from a quantity box that was handed a
   * barcode. Adds the product, or puts the scanned text in the search field with its message, so
   * a refused scan is never silent and the next scan replaces it.
   */
  const applyScan = (text: string, outcome: Exclude<ScanOutcome, { kind: "none" }>): boolean => {
    if (outcome.kind === "add") {
      try {
        edit(addProduct(cart, outcome.productId));
      } catch (err) {
        setError(errorText(err));
        return false;
      }
      setQuery("");
      setScanNote(null);
      return true;
    }
    setQuery(text);
    setScanNote(outcome.kind);
    return false;
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
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setScanNote(null);
            }}
            onKeyDown={(e) => {
              const action = enterAction({ key: e.key, repeat: e.repeat, isComposing: e.nativeEvent.isComposing });
              if (action === "ignore") return;
              e.preventDefault();
              if (action === "swallow") return;
              /* 🔴 ENTER IS THE SCANNER'S KEY: IT ADDS ONLY AN EXACT BARCODE MATCH. A scanner and a
                 person typing are indistinguishable here, so Enter no longer adds the single visible
                 result or a product whose SKU or name equals the text — a scan that misses must say
                 so, never sell a look-alike. Searching by name or SKU still narrows the grid, and the
                 operator chooses the card. (src/renderer/sellScan.ts holds the whole decision.) */
              const outcome = resolveScan(query, catalog);
              if (outcome.kind === "none") return;
              // A refused scan's text stays, SELECTED: the operator can read what was scanned, and
              // the next scan replaces it instead of being appended to it.
              if (!applyScan(query, outcome)) e.currentTarget.select();
            }}
          />
          {/* A shortcut is a key, not placeholder prose. */}
          <kbd className="search-kbd" aria-hidden="true">/</kbd>
        </div>
        {scanNote !== null && (
          <p className="error" role="status" data-testid="scan-note" data-kind={scanNote}>
            {t(SCAN_MESSAGE_KEY[scanNote])}
          </p>
        )}
        <div className="products">
          {visible.map((p, i) => {
            const thumb = thumbs.get(p.id);
            const url = thumb?.kind === "ready" ? thumb.url : null;
            return (
            /* 🔴 A CELL, SO THE PHOTO IS NOT INSIDE THE CARD BUTTON. A button cannot contain a
               button: nesting them is invalid markup and gives the inner one no reliable way to
               keep a click away from the outer one. Siblings cannot propagate into each other at
               all, so "the photo opens a preview and never adds to the cart" is structural here
               rather than an event-handler promise. */
            <div className="product-cell" key={p.id}>
            <button
              className="product"
              tabIndex={i === 0 ? 0 : -1}
              aria-keyshortcuts={url !== null ? "p" : undefined}
              onKeyDown={(e) => {
                // 🔴 "p" PREVIEWS THE FOCUSED CARD. The grid keeps ONE tab stop by design, so the
                // photo control is deliberately not a tab stop of its own — fifty cards would mean
                // fifty more. This is how a keyboard reaches it, and `aria-keyshortcuts` above is
                // how it is announced.
                if (e.key === "p" || e.key === "P") {
                  if (url === null) return;
                  e.preventDefault();
                  setPreview({ name: p.name, url });
                  return;
                }
                const cards = Array.from(
                  // 🔴 THE GRID, NOT `parentElement`. Each card now sits in its own cell, so the
                  // parent is that cell and this query would find one card and go nowhere.
                  e.currentTarget.closest(".products")?.querySelectorAll<HTMLButtonElement>("button.product") ?? [],
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
              onClick={(e) => {
                edit(addProduct(cart, p.id));
                refocusAfterClick(e);
              }}
            >
              <span className="product-name" dir="auto">
                {p.name}
              </span>
              {p.sku && <span className="product-sku muted">{p.sku}</span>}
              <span className="product-price">
                {/* One isolated run, amount and currency together — the same shape the cart line
                    and the total use, so a price reads identically wherever it appears. */}
                <bdi dir="ltr">{`${formatDecimal(p.price)} ${catalog.currency}`}</bdi>
                {p.baseUnit !== "piece" && <span className="muted"> / {unit(p.baseUnit)}</span>}
                {p.priceNeedsReview && (
                  <span className="badge warn" data-testid="price-review" title={t("sell.placeholderPrice")}>
                    {t("sell.priceUnknown")}
                  </span>
                )}
              </span>
            </button>
            {/* 🔴 THE PHOTO IS A SIBLING OF THE CARD, AND ONLY A VIEWER. It opens a larger copy of
                the bytes already in hand; it never adds to the cart, never touches a quantity, and
                offers a cashier no way to replace or remove anything — viewing a photo is not
                permission to edit one. */}
            {url !== null ? (
              <button
                type="button"
                className="product-thumb"
                tabIndex={-1}
                data-testid="sell-thumb"
                data-product={p.id}
                title={t("sell.photoOpen")}
                aria-label={`${t("sell.photoOpen")}: ${p.name}`}
                onClick={() => setPreview({ name: p.name, url })}
              >
                <img src={url} alt="" data-testid="sell-thumb-image" />
              </button>
            ) : (
              /* A product with no photo, one whose photo failed its checksum, and one still
                 loading all land here: the same quiet placeholder, never a broken frame, and
                 never anything the cashier has to resolve before selling. */
              <span
                className="product-thumb product-thumb-empty"
                data-testid="sell-thumb-empty"
                data-product={p.id}
                role="img"
                aria-label={t("sell.photoNone")}
                title={t("sell.photoNone")}
              />
            )}
            </div>
            );
          })}
          {visible.length === 0 && <p className="muted">{t("sell.noMatch")}</p>}
        </div>
      </section>

      {/* 🔴 RENDERED BESIDE THE CART, NEVER INSTEAD OF IT. Everything above stays mounted, so the
          cart, the product search text, the quantity drafts and the checkout idempotency key all
          survive a customer being created mid-sale. */}
      {findingCustomer && (
        <CustomerFinder
          onClose={() => setFindingCustomer(false)}
          onPick={(c) => {
            setCustomer(c);
            setFindingCustomer(false);
          }}
        />
      )}

      {preview !== null && (
        /* The same overlay/dialog the clear-cart and payment panes use — no new modal system. */
        <div className="overlay" data-testid="sell-photo-preview">
          <div className="card dialog">
            <h2 dir="auto">{preview.name}</h2>
            <img className="sell-preview-image" src={preview.url} alt={preview.name} data-testid="sell-preview-image" />
            <button
              className="btn primary wide"
              data-testid="sell-photo-close"
              autoFocus
              onClick={() => setPreview(null)}
            >
              {t("action.close")}
            </button>
          </div>
        </div>
      )}

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

        {/* ── The customer, for reference only ──────────────────────────────────────────────────
            🔴 THE SENTENCE UNDER IT IS LOAD-BEARING. Nothing here records a debt or links the
            customer to the sale, and a cashier who assumed otherwise would stop chasing a real
            receivable. The note says so in the shop's own language every time a customer is
            chosen — not once in a tooltip. */}
        <div className="cart-customer">
          <button
            className="btn ghost small"
            onClick={() => setFindingCustomer(true)}
            data-testid="sell-choose-customer"
          >
            {customer === null ? t("sell.chooseCustomer") : t("sell.changeCustomer")}
          </button>
          {customer !== null && (
            <>
              <span className="customer-chip" data-testid="sell-customer" data-customer={customer.id}>
                <bdi>{customer.displayName}</bdi>
              </span>
              <button className="btn ghost small" onClick={() => setCustomer(null)} data-testid="sell-clear-customer">
                {t("sell.clearCustomer")}
              </button>
              <p className="muted small" data-testid="sell-customer-not-attached">
                {t("customers.notOnSaleYet")}
              </p>
            </>
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
                    <LineMath
                      quantityMilli={l.quantityMilli}
                      saleUnit={l.saleUnit}
                      unitPrice={l.unitPrice}
                      unitLabel={unit}
                    />
                  </span>
                </div>
                <div className="qty">
                  {/* 🔴 NOT "qty-*": that prefix already belongs to the per-product quantity
                      INPUT (`qty-${productId}`), and the suite selects it with
                      [data-testid^="qty-"]. Naming these buttons qty-dec/qty-inc put three
                      buttons inside that prefix and .first() started matching a button. */}
                  <button
                    className="btn key"
                    aria-label={t("sell.decrease")}
                    data-testid="line-dec"
                    onClick={(e) => {
                      edit(decrement(cart, l.productId));
                      refocusAfterClick(e);
                    }}
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
                      const action = enterAction({ key: e.key, repeat: e.repeat, isComposing: e.nativeEvent.isComposing });
                      if (action === "ignore") return;
                      e.preventDefault();
                      if (action === "swallow") return;
                      /* 🔴 A QUANTITY BOX ASKS WHAT ITS TEXT IS (sellScan.ts, quantityEnterAction). A
                         barcode — a product's own code, or more digits than any quantity has —
                         is resolved as the scan it is and the line keeps its quantity; anything
                         shaped like a quantity is the quantity, exactly as before. Either way focus
                         then returns to the search field, AFTER this render, so the blur that
                         follows reads the cleared draft and commits nothing a second time. */
                      const text = qtyDraft[l.productId];
                      const decision = text === undefined ? null : quantityEnterAction(text, catalog);
                      if (decision !== null && decision.kind === "scan") {
                        setQtyDraft((d) => {
                          const { [l.productId]: _dropped, ...rest } = d;
                          return rest;
                        });
                        const added = applyScan(text!, decision.outcome);
                        focusSearchAfterRender(!added);
                        return;
                      }
                      commitQuantity(l.productId, l.saleUnit);
                      focusSearchAfterRender(false);
                    }}
                    onBlur={() => commitQuantity(l.productId, l.saleUnit)}
                  />
                  <button
                    className="btn key"
                    aria-label={t("sell.increase")}
                    data-testid="line-inc"
                    onClick={(e) => {
                      edit(addProduct(cart, l.productId));
                      refocusAfterClick(e);
                    }}
                  >
                    +
                  </button>
                  {/* Demoted: removing a line must not look like adjusting one. */}
                  <button
                    className="btn ghost small line-remove"
                    aria-label={t("sell.remove")}
                    data-testid="line-remove-btn"
                    title={t("sell.remove")}
                    onClick={(e) => {
                      edit(removeProduct(cart, l.productId));
                      refocusAfterClick(e);
                    }}
                  >
                    ✕
                  </button>
                </div>
                <span className="line-total">
                  <bdi dir="ltr">{`${formatDecimal(l.lineTotal)} ${catalog.currency}`}</bdi>
                </span>
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
                onKeyDown={refuseEnterActivation}
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
                /* 🔴 CASH IS THE INITIAL FOCUS, NOT A FORCED CHOICE — AND ENTER DOES NOT PAY. A
                   click, a tap, or Space on the focused method records the sale; Enter is refused
                   (`refuseEnterActivation`), because a barcode scan ends in Enter and used to
                   record a cash sale here without the scanned item. Cash leads because it is most
                   of a shop's volume — a prototype to confirm in the field test. */
                <button
                  key={m}
                  ref={m === "cash" ? cashRef : undefined}
                  className={m === "cash" ? "btn primary big" : "btn big"}
                  disabled={busy}
                  data-testid={`pay-${m}`}
                  onKeyDown={refuseEnterActivation}
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
