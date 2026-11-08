import { useEffect, useMemo, useRef, useState } from "react";
import { CustomerFinder } from "./CustomerFinder";
import type { CustomerDto } from "../../shared/ipcContract";
import { type CartLine, type PricedCart, addProduct, decrement, priceCart, removeProduct } from "../../domain/cart";
import type { Catalog } from "../../domain/catalog";
import { formatDecimal } from "../../domain/money";
import { formatQuantity, parseQuantity } from "../../domain/quantity";
import type { PaymentMethod } from "../../domain/sale";
import { fromCatalogDto } from "../../shared/dto";
import type { AdminProductDto, SaleDto } from "../../shared/ipcContract";
import { ApiError, call, errorText, newIdempotencyKey, pos } from "../api";
import { useThumbnails } from "../useThumbnails";
import { type SellDraft, keepSellableLines } from "../sellDraft";
import { LineMath } from "../components/LineMath";
import { Receipt } from "./Receipt";
import { useT } from "../i18n";
import {
  PAY_SCAN_MESSAGE_KEY,
  SCAN_MESSAGE_KEY,
  type ScanOutcome,
  enterAction,
  isModalOpen,
  isPhotoPreviewShortcut,
  isQuantityPending,
  leavesQuantityEditor,
  isSearchShortcut,
  isTypeToSearch,
  quantityEnterAction,
  refuseEnterActivation,
  resolveScan,
} from "../sellScan";

/**
 * The till's buttons, in the order the till uses them. Cash first: it is most of the volume.
 *
 * P2 (owner, 2026-11-07): the plain «تحويل خارجي» button is GONE. An `external` sale is now Whish Money
 * only, and it is recorded only with its reference and the operator's explicit "the money arrived"
 * (`whish` below opens that step; it never records on one click).
 *
 * P3 (DEC-35): the till offers ONLY the shop's accepted methods for new money — Cash and Whish Money. Card
 * and Other are gone from this screen AND refused by the service for a new sale; every historic card /
 * other sale keeps its own words in History and on its receipt. (On account from Sell is a later slice.)
 */
type TillButton = "cash" | "whish" | "card" | "other";
const TILL_BUTTONS: ReadonlyArray<TillButton> = ["cash", "whish"];
const METHOD_KEY: Record<TillButton, string> = {
  cash: "pay.cash",
  whish: "pay.whish",
  card: "pay.card",
  other: "pay.other",
};
/** The Whish step's own sentences for the refusals it can meet (text follows the operation). */
const WHISH_ERROR_KEY: Readonly<Record<string, string>> = {
  DUPLICATE_PAYMENT_REFERENCE: "pay.whishErr.duplicate",
  FUNDS_NOT_CONFIRMED: "pay.whishErr.notConfirmed",
  INVALID_INPUT: "pay.whishErr.reference",
};

/**
 * `focusRequest` is bumped by the tab bar when the operator clicks Sell while Sell is already open:
 * that click focuses the tab button and does not remount this screen, so `autoFocus` cannot help.
 */
export function SellScreen({
  focusRequest = 0,
  role,
  draft = null,
  onDraftChange,
}: {
  readonly focusRequest?: number;
  /** DEMO-FALLBACK: chooses the empty-state guidance only (owner: add / import; cashier: ask the owner). */
  readonly role?: string;
  /**
   * SELL-CART-LOST-ON-TAB: the cart this operator left when they opened another tab (App hands it back
   * only to the same operator). Memory only — see ../sellDraft.ts.
   */
  readonly draft?: SellDraft | null;
  /** Called with the screen's unfinished work whenever it changes, so App can keep it across tabs. */
  readonly onDraftChange?: (next: Omit<SellDraft, "operatorId">) => void;
} = {}) {
  const { t, unit } = useT();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [clearing, setClearing] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const cashRef = useRef<HTMLButtonElement | null>(null);
  const [cart, setCart] = useState<CartLine[]>(() => (draft ? [...draft.cart] : []));
  const [paying, setPaying] = useState(false);
  // One idempotency key per checkout attempt: kept across retries, replaced when the cart changes.
  // SELL-CART-LOST-ON-TAB: the key travels WITH the kept cart, so a payment retried after a tab switch
  // replays the same request (never a second sale); every cart edit still replaces it, as before.
  const [attemptKey, setAttemptKey] = useState(() => draft?.attemptKey ?? newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  /** P2: the Whish Money step — open, the typed reference, and the explicit "the money arrived". */
  const [whishOpen, setWhishOpen] = useState(false);
  const [whishReference, setWhishReference] = useState("");
  const [whishConfirmed, setWhishConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<SaleDto | null>(null);
  const [query, setQuery] = useState("");
  /** The refusal of the last scan (unknown / inactive / invalid code), until the field changes. */
  const [scanNote, setScanNote] = useState<keyof typeof SCAN_MESSAGE_KEY | null>(null);
  /** Something was typed (a scan) while the payment pane was open; it did nothing, and says why. */
  const [payScanNote, setPayScanNote] = useState(false);
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

  /** Lines dropped from a kept cart because their product stopped being sellable while away. */
  const [droppedOnReturn, setDroppedOnReturn] = useState(0);

  useEffect(() => {
    call(pos().getCatalog())
      .then((dto) => {
        const fresh = fromCatalogDto(dto);
        // SELL-CART-LOST-ON-TAB: a kept cart is checked against the catalogue AS IT IS NOW. Prices are
        // never carried (they are recomputed from `fresh`); a product deactivated meanwhile is removed
        // and said so, and the checkout key is replaced because the request is no longer the same.
        setCart((current) => {
          const { kept, dropped } = keepSellableLines(current, fresh);
          if (dropped === 0) return current;
          setDroppedOnReturn(dropped);
          setAttemptKey(newIdempotencyKey());
          return kept;
        });
        setCatalog(fresh);
      })
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
   * The customer the operator picked for THIS sale (SELL-CUSTOMER-LINK, ACC-2).
   *
   * 🔴 SENT BY ID WITH THE PAID SALE, AND IT IS STILL NOT A DEBT. `createSale` carries `customerId`;
   * main re-checks it is an active customer inside the sale transaction and records the sale as
   * paid, with no obligation. The note under the chip says exactly that. Changing or clearing the
   * customer replaces the checkout key, like a cart edit, so a retry can never land on the previous
   * customer; a completed sale clears it, so the next sale never inherits it.
   */
  const [customer, setCustomer] = useState<CustomerDto | null>(() => draft?.customer ?? null);

  // SELL-CART-LOST-ON-TAB: hand the unfinished work to App on every change. The latest callback is
  // kept in a ref so a sale that finishes AFTER the operator left the tab can still empty the draft.
  const draftSink = useRef(onDraftChange);
  draftSink.current = onDraftChange;
  useEffect(() => {
    draftSink.current?.({ cart, customer, attemptKey });
  }, [cart, customer, attemptKey]);
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

  /** Drops a line's pending quantity; the committed one — the one in the cart — stays. */
  const discardQuantity = (productId: string) =>
    setQtyDraft((d) => {
      const { [productId]: _dropped, ...rest } = d;
      return rest;
    });

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

  /**
   * Cash takes the initial focus and Esc returns to the cart. Enter does not pay (see the methods).
   * A printable key typed on the pane's controls — a scan, in practice — has nowhere to go here, so
   * it is not resolved: it only raises the "finish or cancel the payment" warning. Nothing is
   * prevented or redirected, and a text field (none today) would keep its typing.
   */
  useEffect(() => {
    if (!paying) return;
    cashRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPaying(false);
        return;
      }
      if (isTypeToSearch(e, e.target instanceof HTMLElement ? e.target : null)) setPayScanNote(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setPayScanNote(false);
    };
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
      if (!field || isModalOpen(document)) return;
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
    if (paying || preview !== null || findingCustomer || clearing || isModalOpen(document)) return;
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

  /** P2: every opening of the payment pane starts the Whish step empty and UNconfirmed. */
  useEffect(() => {
    if (paying) return;
    setWhishOpen(false);
    setWhishReference("");
    setWhishConfirmed(false);
  }, [paying]);

  /** SELL-CREDIT: the customer an on-account sale was recorded for, shown on its receipt (the DTO carries no name). */
  const [completedOnAccountFor, setCompletedOnAccountFor] = useState<string | null>(null);

  /** One end for every recorded sale: the receipt, an empty till, a fresh key — also straight to App. */
  const finishSale = (sale: SaleDto, onAccountFor: string | null) => {
    setCompleted(sale);
    setCompletedOnAccountFor(onAccountFor);
    setCart([]);
    setCustomer(null);
    setPaying(false);
    setAttemptKey(newIdempotencyKey());
    // Also straight to App: if the operator switched tab while this sale was in flight, this screen
    // is gone and the state updates above land nowhere — the recorded sale must not come back as a cart.
    draftSink.current?.({ cart: [], customer: null, attemptKey: newIdempotencyKey() });
    setDroppedOnReturn(0);
  };

  /**
   * SELL-CREDIT (owner, 2026-11-08): the whole sale on the chosen customer's account. A DEBT, never a
   * payment: no method, no tender; main posts the sale, its lines and ONE receivable for the full total
   * in one transaction, OWNER ONLY (channel + service, live role). The same checkout key as the cart, so
   * a double click or a lost reply replays the same request and can never create a second sale or debt.
   */
  const payOnAccount = async () => {
    if (!priced || busy || customer === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call(
        pos().createCustomerCreditSale({
          idempotencyKey: attemptKey,
          lines: cart.map((l) => ({ productId: l.productId, quantityMilli: l.quantityMilli })),
          expectedTotalMinor: priced.total.minor.toString(),
          customerId: customer.id,
        }),
      );
      finishSale(result.sale, customer.displayName);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pay = async (method: PaymentMethod, whish?: { readonly reference: string; readonly fundsConfirmed: boolean }) => {
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
          ...(customer === null ? {} : { customerId: customer.id }),
          ...(whish === undefined ? {} : { whish }),
        }),
      );
      finishSale(result.sale, null);
    } catch (e) {
      const own = whish !== undefined && e instanceof ApiError ? WHISH_ERROR_KEY[e.code] : undefined;
      setError(own ? t(own) : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const whishReady = whishReference.trim() !== "" && whishConfirmed && !busy;

  /** Leaves a receipt for a fresh till. */
  const startNewSale = () => {
    setCompleted(null);
    setCompletedOnAccountFor(null);
  };

  if (completed) return <Receipt sale={completed} onAccountFor={completedOnAccountFor} onNewSale={startNewSale} />;
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
              // Behind a modal (e.g. the import-result dialog) a scan changes nothing the cashier
              // could not see. Its text — invisible there too — is cleared, so the first scan after
              // the dialog closes starts from an empty field instead of being appended to it.
              if (isModalOpen(document)) {
                setQuery("");
                setScanNote(null);
                return;
              }
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
        {/* 🔴 DEMO-FALLBACK: a shop with no active product sees THIS — never the sample café catalog. */}
        {catalog.products.length === 0 && (
          <div className="card empty-catalog" data-testid="sell-empty-catalog" data-role={role === "owner" ? "owner" : "cashier"}>
            <h3>{t("sell.emptyCatalog.title")}</h3>
            <p>{t(role === "owner" ? "sell.emptyCatalog.owner" : "sell.emptyCatalog.cashier")}</p>
          </div>
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
              aria-keyshortcuts={url !== null ? "Alt+P" : undefined}
              onKeyDown={(e) => {
                // 🔴 ALT+P PREVIEWS THE FOCUSED CARD. The grid keeps ONE tab stop by design, so the
                // photo control is deliberately not a tab stop of its own — fifty cards would mean
                // fifty more. This is how a keyboard reaches it, and `aria-keyshortcuts` above is
                // how it is announced. It was a bare "p" until a scanned code starting with p
                // opened a photo instead of reaching the search field (`isPhotoPreviewShortcut`).
                if (isPhotoPreviewShortcut(e)) {
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
          {/* Not under a barcode refusal: the scanned text filters the grid to nothing, and the
              refusal above already says what happened. */}
          {visible.length === 0 && scanNote === null && catalog.products.length > 0 && <p className="muted">{t("sell.noMatch")}</p>}
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
            setAttemptKey(newIdempotencyKey());
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
        {/* SELL-CART-LOST-ON-TAB: never shrink a kept cart silently. */}
        {droppedOnReturn > 0 && (
          <p className="notice small" role="status" data-testid="cart-dropped-note">
            {t("sell.cartKept.dropped").replace("{n}", String(droppedOnReturn))}
          </p>
        )}

        {/* ── The customer of this PAID sale (ACC-2) ────────────────────────────────────────────
            🔴 THE SENTENCE UNDER IT IS LOAD-BEARING. The sale is linked to the customer and shows in
            their activity, but it records NO debt and adds nothing to what they owe — a cashier must
            never read a linked sale as a receivable. Said every time a customer is chosen. */}
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
              <button
                className="btn ghost small"
                onClick={() => {
                  setCustomer(null);
                  setAttemptKey(newIdempotencyKey());
                }}
                data-testid="sell-clear-customer"
              >
                {t("sell.clearCustomer")}
              </button>
              <p className="muted small" data-testid="sell-customer-paid-link">
                {t("sell.customerPaidLink")}
              </p>
            </>
          )}
        </div>
        {!priced && <p className="muted">{t("sell.empty")}</p>}
        {priced && (
          <ul className="lines">
            {priced.lines.map((l) => {
              const committedQty = formatQuantity(l.quantityMilli);
              const pendingQty = isQuantityPending(qtyDraft[l.productId], committedQty);
              /** Leaving the editor (box, confirm, cancel) discards; moving inside it does not. */
              const blurEditor = (e: React.FocusEvent<HTMLElement>) => {
                if (leavesQuantityEditor(e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null, l.productId)) {
                  discardQuantity(l.productId);
                }
              };
              const editorKey = (e: React.KeyboardEvent<HTMLElement>) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                discardQuantity(l.productId);
                focusSearchAfterRender(false);
              };
              return (
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
                    className={pendingQty ? "qty-n qty-input qty-pending" : "qty-n qty-input"}
                    type="text"
                    inputMode="decimal"
                    aria-label={t("sell.quantityOf")}
                    aria-describedby={pendingQty ? `line-qty-hint-${l.productId}` : undefined}
                    data-testid={`qty-${l.productId}`}
                    data-qty-editor={l.productId}
                    value={qtyDraft[l.productId] ?? committedQty}
                    onChange={(e) => setQtyDraft((d) => ({ ...d, [l.productId]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        discardQuantity(l.productId);
                        focusSearchAfterRender(false);
                        return;
                      }
                      // The keyboard path to ✓: in the DOM the line's + and ✕ come first, and
                      // tabbing onto them would leave the editor and discard the value.
                      if (e.key === "Tab" && !e.shiftKey && pendingQty) {
                        const confirm = e.currentTarget.closest("li")?.querySelector<HTMLButtonElement>(".line-qty-confirm");
                        if (confirm) {
                          e.preventDefault();
                          confirm.focus();
                        }
                        return;
                      }
                      const action = enterAction({ key: e.key, repeat: e.repeat, isComposing: e.nativeEvent.isComposing });
                      if (action === "ignore") return;
                      e.preventDefault();
                      if (action === "swallow") return;
                      if (isModalOpen(document)) return;
                      /* 🔴 ENTER NEVER COMMITS A QUANTITY (SB-RISK-01, option A). It only asks what
                         the text is (sellScan.ts, quantityEnterAction): a barcode — a product's own
                         code, or more digits than any quantity has — is resolved as the scan it is,
                         the pending text is dropped and the line keeps its quantity. Anything else
                         stays PENDING and unsaved until the confirm control is used. */
                      const text = qtyDraft[l.productId];
                      const decision = text === undefined ? null : quantityEnterAction(text, catalog);
                      if (decision !== null && decision.kind === "scan") {
                        discardQuantity(l.productId);
                        const added = applyScan(text!, decision.outcome);
                        focusSearchAfterRender(!added);
                      }
                    }}
                    onBlur={(e) => {
                      if (leavesQuantityEditor(e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null, l.productId)) {
                        discardQuantity(l.productId);
                      }
                    }}
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
                {pendingQty && (
                  /* 🔴 THE ONLY WAY A TYPED QUANTITY REACHES THE CART. The line total and the cart
                     total above still show the committed quantity; this row says the typed one is
                     not saved and offers the two deliberate answers. Confirm refuses Enter (a scan
                     ends in Enter) and takes a click, a tap or Space; a pointer press does not move
                     focus out of the box first (`preventDefault` on mousedown), so the pending
                     value is still there when the click lands. */
                  <div className="line-qty-pending">
                    <p className="line-qty-hint" id={`line-qty-hint-${l.productId}`} role="status" data-testid="line-qty-hint">
                      {t("sell.qty.pendingHint")}
                    </p>
                    <button
                      type="button"
                      className="btn primary small line-qty-confirm"
                      data-testid="line-qty-confirm"
                      data-qty-editor={l.productId}
                      aria-label={t("sell.qty.confirm")}
                      onMouseDown={(e) => e.preventDefault()}
                      onKeyDown={(e) => {
                        refuseEnterActivation(e);
                        editorKey(e);
                        // Shift+Tab goes back to the box it confirms, not to the line's ✕.
                        if (e.key === "Tab" && e.shiftKey) {
                          const box = e.currentTarget.closest("li")?.querySelector<HTMLInputElement>(".qty-input");
                          if (box) {
                            e.preventDefault();
                            box.focus();
                          }
                        }
                      }}
                      onBlur={blurEditor}
                      onClick={() => {
                        commitQuantity(l.productId, l.saleUnit);
                        focusSearchAfterRender(false);
                      }}
                    >
                      ✓ {t("sell.qty.confirm")}
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      data-testid="line-qty-cancel"
                      data-qty-editor={l.productId}
                      onMouseDown={(e) => e.preventDefault()}
                      onKeyDown={editorKey}
                      onBlur={blurEditor}
                      onClick={() => {
                        discardQuantity(l.productId);
                        focusSearchAfterRender(false);
                      }}
                    >
                      {t("sell.qty.cancel")}
                    </button>
                  </div>
                )}
              </li>
              );
            })}
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
            {customer !== null && (
              /* Visible BEFORE the method is chosen: whose sale this is, and that it is paid now. */
              <p className="small" data-testid="pay-customer" data-customer={customer.id}>
                {t("pay.forCustomer")} <bdi>{customer.displayName}</bdi>
              </p>
            )}
            {!whishOpen && (
            <div className="methods">
              {TILL_BUTTONS.map((m) => (
                /* 🔴 CASH IS THE INITIAL FOCUS, NOT A FORCED CHOICE — AND ENTER DOES NOT PAY. A
                   click, a tap, or Space on the focused method records the sale; Enter is refused
                   (`refuseEnterActivation`), because a barcode scan ends in Enter and used to
                   record a cash sale here without the scanned item. Cash leads because it is most
                   of a shop's volume — a prototype to confirm in the field test.
                   P2: Whish Money does NOT record on this click — it opens its own step below. */
                <button
                  key={m}
                  ref={m === "cash" ? cashRef : undefined}
                  className={m === "cash" ? "btn primary big" : "btn big"}
                  disabled={busy}
                  data-testid={`pay-${m}`}
                  onKeyDown={refuseEnterActivation}
                  onClick={() => {
                    if (m === "whish") {
                      setError(null);
                      setWhishOpen(true);
                      return;
                    }
                    void pay(m);
                  }}
                >
                  {t(METHOD_KEY[m])}
                </button>
              ))}
            </div>
            )}
            {/* SELL-CREDIT: the owner's third choice — not a payment method, a debt on the chosen customer.
                A cashier never sees it (and the channel and the service refuse them anyway). Without an
                active customer it stays disabled and says why. */}
            {!whishOpen && role === "owner" && (
              <div className="on-account" data-testid="on-account">
                <button
                  className="btn big"
                  disabled={busy || customer === null}
                  data-testid="pay-on-account"
                  onKeyDown={refuseEnterActivation}
                  onClick={() => void payOnAccount()}
                >
                  {t("pay.onAccount")}
                </button>
                <p className="muted small" data-testid="pay-on-account-note">
                  {customer === null ? t("pay.onAccountNeedCustomer") : t("pay.onAccountNote")}
                </p>
              </div>
            )}
            {whishOpen && (
              /* P2 · SELL-WHISH-REFERENCE-AND-CONFIRMATION. Nothing is recorded until the operator has
                 typed the Whish reference AND ticked that the money really arrived (never pre-ticked).
                 The till does not contact Whish; the main process refuses a reused reference, and the
                 whole sale is rolled back, so a refusal here leaves nothing behind. */
              <div className="whish-step" data-testid="whish-step">
                <h3>{t("pay.whish")}</h3>
                <label className="field">
                  <span>{t("pay.whishReference")}</span>
                  <input
                    type="text"
                    dir="auto"
                    autoFocus
                    maxLength={64}
                    value={whishReference}
                    disabled={busy}
                    data-testid="whish-reference"
                    onChange={(e) => {
                      setWhishReference(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      // A scanner or a habit ends in Enter: it never records the sale from here.
                      if (e.key === "Enter") e.preventDefault();
                    }}
                  />
                </label>
                <p className="muted small">{t("pay.whishReferenceHint")}</p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={whishConfirmed}
                    disabled={busy}
                    data-testid="whish-confirm"
                    onChange={(e) => setWhishConfirmed(e.target.checked)}
                  />
                  <span>{t("pay.whishConfirm")}</span>
                </label>
                <p className="muted small">{t("pay.whishConfirmHint")}</p>
                <button
                  className="btn primary big wide"
                  disabled={!whishReady}
                  data-testid="whish-submit"
                  onKeyDown={refuseEnterActivation}
                  onClick={() => {
                    if (!whishReady) return;
                    void pay("external", { reference: whishReference, fundsConfirmed: true });
                  }}
                >
                  {t("pay.whishSubmit")}
                </button>
                <button
                  className="btn ghost wide"
                  disabled={busy}
                  data-testid="whish-back"
                  onClick={() => {
                    setWhishOpen(false);
                    setError(null);
                  }}
                >
                  {t("pay.whishBack")}
                </button>
              </div>
            )}
            {payScanNote && (
              <p className="error" role="status" data-testid="pay-scan-note">
                {t(PAY_SCAN_MESSAGE_KEY)}
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <button className="btn ghost wide" disabled={busy} onClick={() => setPaying(false)} data-testid="pay-back">
              {t("pay.back")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
