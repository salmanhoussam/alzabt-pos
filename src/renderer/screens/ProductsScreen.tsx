/**
 * Products — offline product management. Bilingual from its first commit (the standing rule), so
 * every label comes from `useT()` and the layout uses CSS logical properties only.
 *
 * What the operator can do here: find a product, add one, edit one, and stop selling one. What they
 * cannot do: delete one. A product that may appear on a past invoice stays on record; "Deactivate"
 * hides it from the Sell screen and nothing more.
 *
 * Search runs in the renderer over the full list because the whole local catalog is already in
 * memory and a merchant catalog is thousands of rows, not millions — one keystroke filters it with
 * no round trip. The normalisation itself is the shared domain function, so the rule the operator
 * experiences is the same one the tests assert.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_UNITS, FRACTIONAL_SALE_UNITS } from "../../domain/catalog";
import { matchesSearch } from "../../domain/arabic";
import type {
  AdminProductDto,
  CategoryDto,
  PhoneSessionDto,
  PhoneSessionState,
  ProductDraftRequest,
} from "../../shared/ipcContract";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";
import {
  EMPTY_MASTER_FORM,
  type MasterForm,
  categoryChoices,
  masterFormOf,
  masterPatchFrom,
} from "../../shared/productMasterForm";
import { type ThumbnailCache, dataUrlFrom, thumbnailsToFetch } from "../thumbnails";

type Editing = { readonly mode: "add" } | { readonly mode: "edit"; readonly product: AdminProductDto };

const EMPTY: ProductDraftRequest = { nameAr: "", nameEn: null, sku: null, price: "", baseUnit: "piece" };

/**
 * The SELLING fields of an existing product.
 *
 * 🔴 IT CARRIES NO `master`, AND THAT IS THE CONTRACT. The enrichment group is built separately, as
 * a DIFF of what the owner actually changed (`masterPatchFrom`) — so a save that touched no
 * enrichment field sends no enrichment group at all. Putting the six fields here would resend them
 * on every save and silently revert anything changed elsewhere since the form opened.
 */
function draftOf(p: AdminProductDto): ProductDraftRequest {
  return { nameAr: p.nameAr, nameEn: p.nameEn, sku: p.sku, price: p.priceDecimal, baseUnit: p.baseUnit };
}

/**
 * Fetches the thumbnails of the rows on screen, and nothing else.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 EVERY DECISION HERE IS MADE BY `thumbnailsToFetch`, NOT BY THIS HOOK. The six rules — no
 * photo, offscreen, cached, replaced, in flight, failed — live in src/renderer/thumbnails.ts
 * because this repository has no DOM harness and a rule inside an effect is a rule nothing can
 * test. This hook is the wiring: it asks what to fetch, fetches it, and revokes what is no longer
 * reachable.
 *
 * 🔴 AND THEY ARE `data:` URLS, NOT `blob:` ONES. The renderer's CSP starts from
 * `default-src 'none'` and admits `img-src 'self' data:`, so a blob URL is blocked and the image
 * silently never decodes — which is how the first installed Windows run of this screen failed.
 * Widening the CSP was rejected; see `ThumbnailState`. A data URL is a string, released with the
 * state, so there is nothing to revoke.
 *
 * 🔴 A BROKEN PHOTO COSTS ONE FAILED READ. A corrupt blob is refused by `productImageBytes`'s
 * checksum guard — by design — and the row records `failed` at that version, which rule 6 then
 * never retries. Without that, one bad photo would re-request on every render for as long as the
 * screen is open and the row would never settle.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
function useThumbnails(visible: readonly AdminProductDto[]): ThumbnailCache {
  const [cache, setCache] = useState<ThumbnailCache>(new Map());
  // Read inside the effect without making it a dependency: re-running on every cache change is
  // exactly the render loop the `loading`/`failed` states exist to prevent.
  const latest = useRef(cache);
  latest.current = cache;

  useEffect(() => {
    // Every row handed to this hook is on screen. A virtualised list would pass only the rendered
    // window; today the table renders what it filters, so `shown` IS the visible set.
    const wanted = thumbnailsToFetch(visible, new Set(visible.map((p) => p.id)), latest.current);
    if (wanted.length === 0) return;
    let live = true;

    // Mark them loading in one update, so a second render cannot start the same fetch again.
    setCache((prev) => {
      const next = new Map(prev);
      for (const r of wanted) next.set(r.productId, { kind: "loading", version: r.version });
      return next;
    });

    for (const request of wanted) {
      void (async () => {
        try {
          const got = await call(pos().getProductImageBytes({ imageId: request.imageId }));
          if (!live) return;
          const url = dataUrlFrom(new Uint8Array(got.bytes), got.meta.mime);
          setCache((prev) => {
            const next = new Map(prev);
            next.set(request.productId, { kind: "ready", version: request.version, url });
            return next;
          });
        } catch {
          if (!live) return;
          // 🔴 The placeholder, remembered. Not rethrown: one unreadable photo must not take down
          // the products screen, and the row below falls back to the ordinary empty state.
          setCache((prev) => {
            const next = new Map(prev);
            next.set(request.productId, { kind: "failed", version: request.version });
            return next;
          });
        }
      })();
    }

    return () => {
      live = false;
    };
  }, [visible]);

  return cache;
}

/**
 * The "a photo goes here" mark.
 *
 * 🔴 INLINE SVG, AND NO ICON LIBRARY. A dashed empty square read as an empty INPUT in the Windows
 * capture — the merchant saw a field, not a picture frame. What communicates "photo" is a picture,
 * so this draws the universal one: a frame, a horizon, a sun. Twelve lines of SVG, offline, no
 * dependency, and it inherits `currentColor` so it follows the theme like every other muted mark.
 *
 * `aria-hidden`: the text beside it already says what this is, and a screen reader announcing
 * "image" here would be announcing the absence of one.
 */
function PhotoGlyph() {
  return (
    <svg className="photo-glyph" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect x="4.5" y="9.5" width="39" height="29" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="19" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M7 34l10-10 7 7 6-5 11 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** One product's photo cell: a thumbnail, or the neutral placeholder every other state falls back to. */
function Thumb(props: { product: AdminProductDto; cache: ThumbnailCache; label: (k: string) => string }) {
  const state = props.cache.get(props.product.id);
  if (!props.product.hasImage) {
    return <span className="thumb thumb-empty" aria-label={props.label("products.noPhoto")} title={props.label("products.noPhoto")} data-testid="thumb-empty" />;
  }
  if (state?.kind === "ready") {
    return (
      <img
        className="thumb"
        src={state.url}
        alt={props.product.nameAr}
        loading="lazy"
        data-testid="thumb-image"
        // 🔴 Even a photo that LOADED can fail to decode in the browser. The fallback is the same
        // placeholder, applied by swapping the class rather than removing the element, so the row
        // height does not jump as the list renders.
        onError={(e) => {
          e.currentTarget.classList.add("thumb-broken");
          e.currentTarget.removeAttribute("src");
        }}
      />
    );
  }
  if (state?.kind === "failed") {
    return (
      <span
        className="thumb thumb-broken"
        aria-label={props.label("products.photoBroken")}
        title={props.label("products.photoBroken")}
        data-testid="thumb-failed"
      />
    );
  }
  // No state yet, or loading. The same box, so nothing reflows when the bytes arrive.
  return <span className="thumb thumb-loading" aria-hidden="true" data-testid="thumb-loading" />;
}

export function ProductsScreen() {
  const { t, unit } = useT();
  const [products, setProducts] = useState<AdminProductDto[] | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [managing, setManaging] = useState(false);
  /** The open phone-pairing session, or null. One at a time, matching the bridge's own contract. */
  const [phone, setPhone] = useState<PhoneSessionDto | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);

  const [exporting, setExporting] = useState(false);

  /**
   * Export Online Catalogue.
   *
   * 🔴 THIS NAMES NO PATH AND RECEIVES NONE. Main shows the folder picker, writes the package and
   * answers with a summary; `null` means the owner dismissed the picker, which is not an error and
   * must not produce a success message.
   */
  const exportOnline = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await call(pos().exportOnlineCatalog());
      if (result === null) return;
      if (result.products === 0) {
        setNotice(t("products.exportOnlineEmpty"));
        return;
      }
      const lines = [
        t("products.exportOnlineDone"),
        t("products.exportOnlineSummary")
          .replace("{products}", String(result.products))
          .replace("{images}", String(result.images))
          .replace("{folder}", result.folderName),
      ];
      if (result.incomplete > 0) {
        lines.push(t("products.exportOnlineIncomplete").replace("{count}", String(result.incomplete)));
      }
      setNotice(lines.join("\n"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  const reload = useCallback(async () => {
    try {
      setProducts(await call(pos().listProducts()));
    } catch (e) {
      setProducts([]);
      setError(errorText(e));
    }
    // 🔴 The two support reads are SEPARATE and non-fatal. A terminal that cannot answer them still
    // shows the products list: the Category chooser falls back to "no category" and the Brand field
    // to a plain text box, which is exactly what they are without suggestions.
    try {
      setCategories(await call(pos().listCategories()));
    } catch {
      setCategories([]);
    }
    try {
      setBrands(await call(pos().listBrands()));
    } catch {
      setBrands([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const categoryName = useCallback(
    (id: string | null) => (id === null ? null : (categories.find((c) => c.id === id)?.nameAr ?? null)),
    [categories],
  );

  /**
   * Open a phone session.
   *
   * 🔴 IT PASSES AN ACTION AND, FOR AN EDIT, A PRODUCT ID — and nothing else. The renderer cannot
   * choose the port, the address, the token or the expiry; all four are main's. A failure here is
   * shown as an ordinary error (no network, no owner, a product that has since gone) rather than
   * leaving a dialog open over a session that does not exist.
   */
  const openPhone = useCallback(
    async (action: "NEW_PRODUCT" | "EDIT_PRODUCT", productId: string | null) => {
      if (phoneBusy) return;
      setPhoneBusy(true);
      setError("");
      setNotice("");
      try {
        const session = await call(
          productId === null
            ? pos().startPhoneSession({ action })
            : pos().startPhoneSession({ action, productId }),
        );
        setPhone(session);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setPhoneBusy(false);
      }
    },
    [phoneBusy],
  );

  const shown = useMemo(() => {
    if (!products) return [];
    // 🔴 THE BARCODE IS SEARCHABLE, and it is the canonical stored form that is matched — a cashier
    // scanning a box types/scans 13 digits and finds the product. `matchesSearch` is the shared
    // domain function, so the rule the operator experiences is the one the tests assert.
    return products.filter((p) => matchesSearch([p.nameAr, p.nameEn, p.sku, p.barcode], query));
  }, [products, query]);

  const thumbs = useThumbnails(shown);

  if (products === null) return <div className="center muted">{t("common.loading")}</div>;

  return (
    <div className="catalog-admin">
      <header className="admin-head">
        <h2>{t("products.title")}</h2>
        <input
          className="admin-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("products.search")}
          aria-label={t("products.search")}
          data-testid="product-search"
        />
        <button className="btn" onClick={() => setManaging(true)} data-testid="manage-categories">
          {t("form.categoryManage")}
        </button>
        {/* 🔴 IN THE PRODUCT MASTER TOOLBAR, NOT BURIED IN BACKUP. What it exports is this screen's
            data, so this is where an owner looks for it. The wording says EXPORT, never "publish"
            or "update the website": the package is written to a folder and nothing is uploaded,
            and a button that implies otherwise would be a lie the owner acts on. */}
        <button
          className="btn"
          onClick={() => void exportOnline()}
          disabled={exporting}
          title={t("products.exportOnlineHint")}
          data-testid="export-online-catalog"
        >
          {t("products.exportOnline")}
        </button>
        {/* 🔴 "FROM THE PHONE", NEVER "UPLOAD". The till serves the page over the shop's own
            network and nothing leaves the building — the same honesty the export button's wording
            is held to. The button is owner-only by the channel policy, not by being hidden: a
            cashier who reached `window.pos.startPhoneSession` is refused by main. */}
        <button
          className="btn"
          onClick={() => void openPhone("NEW_PRODUCT", null)}
          disabled={phoneBusy}
          data-testid="add-product-phone"
        >
          {t("phone.add")}
        </button>
        <button className="btn primary" onClick={() => setEditing({ mode: "add" })} data-testid="add-product">
          {t("action.add")}
        </button>
      </header>

      {/* 🔴 ONE LINE, NOT TWO PARAGRAPHS. The two explanations together pushed the table a long way
          down the screen on every single visit, and a merchant reads them once. The behaviour they
          describe is unchanged; the words are merged and the table starts meaningfully higher. */}
      <p className="muted small">{t("products.searchHint")}</p>
      <p className="muted small" data-testid="product-count">
        {/* 🔴 EACH NUMBER ISOLATED. Interpolated bare into RTL text, "0 … · 0 …" reordered until
            the two digits sat together and the separator was unreadable. */}
        <bdi>{products.length}</bdi> {t("products.count")} · <bdi>{shown.length}</bdi>{" "}
        {t("products.countShown")}
      </p>

      {products.length === 0 ? (
        /* Telling the operator to add the first product while the button sits in the opposite
           corner is an instruction, not an affordance. */
        <div className="empty-state" data-testid="products-empty">
          <p className="muted">{t("products.empty")}</p>
          <button className="btn primary" onClick={() => setEditing({ mode: "add" })}>
            {t("action.add")}
          </button>
        </div>
      ) : shown.length === 0 ? (
        <p className="center muted" data-testid="no-match">
          {t("products.noMatch")}
        </p>
      ) : (
        <table className="history-table admin-table">
          <thead>
            <tr>
              {/* 🔴 A NARROW FIXED COLUMN, not a card. This is a fast shop-management screen: the
                  photo is there to let the owner recognise an item at a glance, and a thumbnail
                  wide enough to admire would halve the number of rows on screen. */}
              <th className="col-thumb">{t("products.colPhoto")}</th>
              <th>{t("products.colName")}</th>
              <th>{t("products.colSku")}</th>
              <th>{t("products.colCategory")}</th>
              <th className="num">{t("products.colPrice")}</th>
              <th>{t("products.colUnit")}</th>
              <th>{t("products.colState")}</th>
              {/* 🔴 `col-actions`, NOT `admin-actions`. The width rule has to reach the header or
                  the column is still negotiated from it — but `.admin-actions` is `display: flex`,
                  and a `<th>` with `display: flex` stops being a table cell and takes the header
                  row with it. So the width lives on its own class, carried by both. */}
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className={p.isActive ? undefined : "row-inactive"} data-testid="product-row">
                <td className="col-thumb">
                  {/* An INACTIVE product keeps its thumbnail: it is still on this screen and still
                      identifiable by its photo. `row-inactive` dims the whole row, which is the
                      state the operator needs to read, not the absence of a picture. */}
                  <Thumb product={p} cache={thumbs} label={t} />
                </td>
                <td>
                  <span dir="auto">{p.nameAr}</span>
                  {p.nameEn && (
                    <>
                      {" "}
                      <span className="muted" dir="auto">
                        ({p.nameEn})
                      </span>
                    </>
                  )}
                  {/* 🔴 THE "يدوي / manual" BADGE IS GONE, AND IT WAS MEASURED BEFORE IT WENT.
                      What `source` really does: `exportCatalog` calls `listForExport(CSV_SOURCE)`,
                      so ONLY imported products are written to the merchant catalog export — a
                      manually typed product is silently left out of it. That is a real,
                      consequential merchant-facing difference.
                      But "يدوي" does not say it. A merchant reading that word has no way to learn
                      that this product will be missing from their exported price list, and the
                      badge sat on every row of every visit saying nothing they could act on.
                      So it is removed from the daily list, and the export's exclusion is reported
                      as what it is: a gap in the EXPORT, to be surfaced where the export happens
                      rather than hinted at here in a word that does not mean it. */}
                </td>
                <td className="col-codes">
                  {/* SKU and barcode are separate identifiers and both stay LTR-isolated: a bare
                      digit run next to Arabic reorders, which is how a 13-digit code becomes
                      unreadable. SKU first, because it is the shop's own key.

                      🔴 ONE LINE, NOT TWO, AND THE WINDOWS GATE IS WHY. The first version put the
                      barcode on its own line under the SKU, and the installed run measured rows at
                      69px and 57px — a product with a barcode was taller than one without, so a
                      list meant to be scanned had two row heights depending on data. Inline with a
                      separator keeps both codes readable and every row identical; `nowrap` on the
                      cell stops a long code reintroducing the same problem by wrapping. */}
                  {p.sku ? <bdi dir="ltr">{p.sku}</bdi> : <span className="muted">—</span>}
                  {p.barcode && (
                    <>
                      <span className="muted" aria-hidden="true"> · </span>
                      <bdi dir="ltr" className="muted small" data-testid="row-barcode">
                        {p.barcode}
                      </bdi>
                    </>
                  )}
                </td>
                <td>
                  {categoryName(p.categoryId) ? (
                    <span dir="auto">{categoryName(p.categoryId)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">
                  {/* One isolated run: amount and currency together, never split. */}
                  <bdi dir="ltr">{`${p.priceDecimal} ${p.price.currency}`}</bdi>
                  {p.priceNeedsReview && <span className="badge warn">{t("products.priceNeedsReview")}</span>}
                </td>
                <td>
                  {unit(p.baseUnit)}
                  {/* A bare "0.001" said nothing. Every badge carries a word, never a value. */}
                  {FRACTIONAL_SALE_UNITS.includes(p.baseUnit) && (
                    <span className="badge state" title={t("products.fractionsAllowed")}>
                      {t("products.fractional")}
                    </span>
                  )}
                </td>
                <td>
                  <span className={p.isActive ? "badge ok" : "badge state"}>
                    {t(p.isActive ? "products.active" : "products.inactive")}
                  </span>
                  {/* Only when true. A column that said "not online" on every row would be noise on
                      a screen whose default is a local-only product. */}
                  {p.isOnlineVisible && (
                    <span className="badge faint" data-testid="badge-online">
                      {t("products.online")}
                    </span>
                  )}
                </td>
                <td className="admin-actions col-actions">
                  {/* A testid because E2E selectors are never visible text — the terminal's
                      default language is Arabic, and "Edit" is not what this button says. */}
                  <button
                    className="btn small"
                    onClick={() => setEditing({ mode: "edit", product: p })}
                    data-testid="product-edit"
                  >
                    {t("action.edit")}
                  </button>
                  {/* 🔴 THE PRODUCT IS NAMED HERE AND NOWHERE ELSE AFTERWARDS. This id goes to
                      main, which resolves it once and binds the SESSION to it; the phone never
                      sends a product id and could not change which product it edits if it tried. */}
                  <button
                    className="btn small"
                    onClick={() => void openPhone("EDIT_PRODUCT", p.id)}
                    disabled={phoneBusy}
                    title={t("phone.editHint")}
                    data-testid="product-edit-phone"
                  >
                    {t("phone.edit")}
                  </button>
                  {/* Deactivating hides a product from sale: ghost-danger, not a twin of Edit.

                      🔴 THE TESTID IS LOAD-BEARING, ADDED IN H2 AFTER A REAL GATE FAILURE. Two
                      installed-app scripts selected this button BY POSITION
                      (`getByRole("button").nth(1)`), because it had no testid to ask for. H2 added
                      "Continue on Phone" above it, index 1 became that button, and
                      `product-management.mjs` clicked the phone action and then waited 30s for an
                      OK dialog that never came. `online-catalog.mjs` held the same selector and
                      would have broken next; it only escaped because the first failure skipped it.

                      Reordering the new button below this one would have "fixed" it by moving the
                      same trap one slot along. A name cannot be displaced. */}
                  <button
                    className={p.isActive ? "btn danger ghost small" : "btn small"}
                    data-testid="product-deactivate"
                    onClick={async () => {
                      try {
                        await call(pos().setProductActive({ id: p.id, isActive: !p.isActive }));
                        setNotice(t(p.isActive ? "msg.deactivated" : "msg.activated"));
                        await reload();
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }}
                  >
                    {t(p.isActive ? "action.deactivate" : "action.activate")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {phone && (
        <PhoneSessionDialog
          session={phone}
          onClose={() => setPhone(null)}
          onSaved={async (_productId, action) => {
            // 🔴 THE LIST REFRESHES FROM THE LEDGER, not from anything the phone sent. The saved
            // product is read back through the ordinary `listProducts` path, so what the owner
            // then sees on the till is storage, not a hopeful local copy.
            setNotice(t(action === "EDIT_PRODUCT" ? "phone.savedEdit" : "phone.savedNew"));
            await reload();
          }}
        />
      )}

      {managing && (
        <CategoryManager
          categories={categories}
          onClose={() => setManaging(false)}
          onChanged={async (message) => {
            setNotice(message);
            await reload();
          }}
          onError={setError}
        />
      )}

      {editing && (
        <ProductForm
          /* 🔴 A fresh form per product. Without a key React reuses the instance across two Edit
             clicks, and the second product would open showing the first one's typed-but-unsaved
             values — the cross-section state leak the Section Editor already paid for once. */
          key={editing.mode === "edit" ? editing.product.id : "add"}
          editing={editing}
          categories={categories}
          brands={brands}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            setNotice(message);
            await reload();
          }}
          onError={setError}
          onPhotoChanged={() => {
            void reload();
          }}
        />
      )}

      {(notice || error) && (
        <div className="overlay">
          <div className="card dialog">
            <h2>{error ? t("err.title") : t("app.name")}</h2>
            {/* `pre-line` because the export summary is three lines: what happened, the
                counts, and the incomplete-data warning. Without it they run together. */}
            <p className={error ? "error" : undefined} style={{ whiteSpace: "pre-line" }}>
              {error ?? notice}
            </p>
            {!error && <p className="muted small">{t("msg.historyUntouched")}</p>}
            <button
              className="btn primary wide"
              onClick={() => {
                setNotice(null);
                setError(null);
              }}
            >
              {t("action.ok")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The add/edit form. The price box is a plain text input on purpose: a `number` input would let the
 * browser localise, round or increment the value, and the price must reach the main process exactly
 * as typed so the one parser (`parseDecimal`) decides what is valid.
 */
function ProductForm(props: {
  editing: Editing;
  categories: readonly CategoryDto[];
  brands: readonly string[];
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
  /**
   * A photo was added, replaced or removed.
   *
   * 🔴 A PHOTO IS NOT PART OF THE FORM'S DRAFT. It is an owner mutation that commits the moment the
   * picker returns, so it is already in the ledger whether or not the owner then presses Save — and
   * the list BEHIND this dialog is showing a stale thumbnail until something reloads it. Cancelling
   * the form does not undo a photo, and nothing here should imply it does.
   */
  onPhotoChanged?: () => void;
}) {
  const { t, unit } = useT();
  const isEdit = props.editing.mode === "edit";
  const [draft, setDraft] = useState<ProductDraftRequest>(
    props.editing.mode === "edit" ? draftOf(props.editing.product) : EMPTY,
  );
  const [isActive, setIsActive] = useState(props.editing.mode === "edit" ? props.editing.product.isActive : true);
  const [busy, setBusy] = useState(false);
  /**
   * 🔴 THE ORIGINAL IS KEPT, NOT JUST THE CURRENT VALUES, because the patch is a DIFF. Holding only
   * the edited state would leave no way to tell "the owner typed this brand" from "the brand was
   * already this" — and the first produces a patch key while the second must produce nothing.
   */
  const original = useMemo(
    () => (props.editing.mode === "edit" ? masterFormOf(props.editing.product) : EMPTY_MASTER_FORM),
    [props.editing],
  );
  const [master, setMaster] = useState<MasterForm>(original);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoGone, setPhotoGone] = useState(false);
  /**
   * 🔴 THE CONTENT HASH OF THE PHOTO SET IN THIS DIALOG, and it exists for cache invalidation.
   *
   * `ProductPhoto` fetches on its `version`, and after a REPLACE the product id is unchanged — so
   * without a new version the effect would not re-run and the owner would be looking at the photo
   * they just replaced, with no way to tell. `imageVersion` is the stored SHA-256 (slice E1), so a
   * different photo is always a different version and the same photo never refetches.
   */
  const [setVersion, setSetVersion] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * 🔴 EVERY OPEN STARTS AT THE TOP. React keeps the same element when `editing` goes from one
   * product to another — same component, same position — so without this the dialog would inherit
   * wherever the previous one was left, and an owner clicking Edit on a second product would land
   * mid-form with no idea which part of it they were looking at. The `key` on the mounted form
   * handles the state; this handles the scroll position, which is DOM and survives a re-render.
   */
  useEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, [props.editing]);

  const set = (patch: Partial<ProductDraftRequest>) => setDraft((d) => ({ ...d, ...patch }));
  const setM = (patch: Partial<MasterForm>) => setMaster((m) => ({ ...m, ...patch }));

  const product = props.editing.mode === "edit" ? props.editing.product : null;
  // A photo just added to a product that had none counts, which is why this is not `product.hasImage`
  // alone — the row in the list behind the dialog has not been reloaded yet.
  const hasPhoto = product !== null && (product.hasImage || setVersion !== null) && !photoGone;
  const photoVersion = setVersion ?? product?.imageVersion ?? null;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 🔴 ONLY WHAT CHANGED. `masterPatchFrom` returns undefined when the owner touched no
      // enrichment field, and the optional key then carries nothing at all — so this save is
      // indistinguishable from an import's, and every stored enrichment value is left exactly as
      // it is. See src/shared/productMasterForm.ts for why a snapshot would be wrong.
      const patch = masterPatchFrom(original, master);
      const body: ProductDraftRequest = patch === undefined ? draft : { ...draft, master: patch };
      if (props.editing.mode === "edit") {
        await call(pos().updateProduct({ id: props.editing.product.id, draft: body, isActive }));
        await props.onSaved(t("msg.updated"));
      } else {
        await call(pos().createProduct({ draft: body }));
        await props.onSaved(t("msg.created"));
      }
    } catch (e) {
      props.onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Add or replace the photo. MAIN runs the picker; this names a product and nothing else.
   *
   * A cancelled dialog answers null — not an error, and nothing was written, so the only correct
   * response is to leave the form exactly as it was.
   */
  const choosePhoto = async () => {
    if (product === null || photoBusy) return;
    setPhotoBusy(true);
    try {
      const meta = await call(pos().setProductImage({ productId: product.id }));
      if (meta === null) return;
      setPhotoGone(false);
      setSetVersion(meta.sha256Hex);
      props.onPhotoChanged?.();
    } catch (e) {
      props.onError(errorText(e));
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    if (product === null || photoBusy) return;
    setPhotoBusy(true);
    try {
      await call(pos().removeProductImage({ productId: product.id }));
      setPhotoGone(true);
      setSetVersion(null);
      props.onPhotoChanged?.();
    } catch (e) {
      props.onError(errorText(e));
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <div className="overlay">
      <form
        className="card dialog product-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{t(isEdit ? "form.editTitle" : "form.addTitle")}</h2>

        {/* 🔴 A TRUE MODAL FOOTER NEEDS A SCROLL REGION THAT IS NOT THE CARD.
            `.overlay > .card` gives every dialog `overflow-y: auto`, so the whole card scrolled —
            and a footer STICKY INSIDE a scrolling card sits on top of the content passing beneath
            it. The Windows capture showed exactly that: Save and Cancel with form fields
            continuing underneath. Sticky was the wrong mechanism, not a wrong offset.
            Now the card does not scroll, this region does, and the footer is its sibling — so
            nothing can ever pass under it, and a native dropdown opening near the bottom has the
            footer below it rather than through it. */}
        <div className="form-scroll" ref={scrollRef}>

        {/* 🔴 TWO COLUMNS, AND THE INSTALLED SCREENSHOT IS WHY. Stacked, the three sections are
            taller than a 1008x681 shop screen: the Windows capture of Edit Product showed the form
            ending at the Category field, with the PHOTO section, the online section and the Save
            button all below the fold. The photo state was therefore not "obvious on opening" — it
            needed scrolling — and the E2E assertion passed anyway, because the element existed in
            the DOM. That is precisely why a screenshot is the acceptance gate and a selector is not.

            Reading order is preserved: in RTL the first column is the right-hand one, so BASIC
            INFORMATION still comes first. It collapses back to one column on a narrow window. */}
        <div className="form-grid">
        <div className="form-col">

        {/* 🔴 THREE SECTIONS, NOT A WALL OF FIELDS. What a merchant adding a product needs is at
            the top; what only the website needs is below, clearly labelled as such. The note says
            so in words, because a field being optional is not visible from a form. */}
        <h3 className="form-section">{t("form.secBasic")}</h3>

        <label className="field">
          <span>
            {t("form.nameAr")} <em className="muted">({t("form.required")})</em>
          </span>
          <input
            dir="rtl"
            lang="ar"
            value={draft.nameAr}
            onChange={(e) => set({ nameAr: e.target.value })}
            required
            data-testid="field-nameAr"
          />
        </label>

        <label className="field">
          <span>{t("form.nameEn")}</span>
          <input dir="ltr" lang="en" value={draft.nameEn ?? ""} onChange={(e) => set({ nameEn: e.target.value })} />
        </label>

        <label className="field">
          <span>{t("form.sku")}</span>
          <input dir="ltr" value={draft.sku ?? ""} onChange={(e) => set({ sku: e.target.value })} />
        </label>

        {/* 🔴 SEPARATE FROM SKU, by decision. The SKU is the shop's own key; the barcode is the
            manufacturer's. `dir="ltr"` because a digit run inside an RTL form reorders, and
            `inputMode="numeric"` without forbidding letters, because Code 128 payloads are not all
            digits and their case is significant. Normalisation belongs to the one barcode module in
            main — a screen must never pre-process a barcode, or a typed UPC-A and a scanned EAN-13
            would reach storage as two products. */}
        <label className="field">
          <span>{t("form.barcode")}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            value={master.barcode}
            onChange={(e) => setM({ barcode: e.target.value })}
            data-testid="field-barcode"
          />
          <em className="muted small">{t("form.barcodeHint")}</em>
        </label>

        <label className="field">
          <span>{t("form.category")}</span>
          <select
            value={master.categoryId}
            onChange={(e) => setM({ categoryId: e.target.value })}
            data-testid="field-category"
          >
            <option value="">{t("form.categoryNone")}</option>
            {/* 🔴 ACTIVE CATEGORIES, PLUS THIS PRODUCT'S OWN EVEN IF RETIRED — see
                `categoryChoices`. Offering only active ones would show a product's retired category
                as blank, and the first save would silently move it to "no category". */}
            {categoryChoices(props.categories, master.categoryId).map(({ category, retired }) => (
              <option key={category.id} value={category.id}>
                {category.nameAr}
                {retired ? ` — ${t("form.categoryRetired")}` : ""}
              </option>
            ))}
          </select>
        </label>

        {/* 🔴 FREE TEXT WITH SUGGESTIONS, which is the approved architecture and not a shortcut: a
            hardware shop carries hundreds of brands arriving as supplier spellings, and normalising
            them would mean building category management twice plus a merge tool. A `datalist`
            suggests without constraining, so a brand nobody has typed yet is still typable. */}
        <label className="field">
          <span>{t("form.brand")}</span>
          <input
            list="brand-suggestions"
            dir="auto"
            value={master.brand}
            onChange={(e) => setM({ brand: e.target.value })}
            data-testid="field-brand"
          />
          <datalist id="brand-suggestions">
            {props.brands.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          <em className="muted small">{t("form.brandHint")}</em>
        </label>

        <label className="field">
          <span>
            {t("form.price")} <em className="muted">({t("form.required")})</em>
          </span>
          <input
            dir="ltr"
            inputMode="decimal"
            value={draft.price}
            onChange={(e) => set({ price: e.target.value })}
            required
            data-testid="field-price"
          />
        </label>

        <label className="field">
          <span>
            {t("form.unit")} <em className="muted">({t("form.required")})</em>
          </span>
          <select value={draft.baseUnit} onChange={(e) => set({ baseUnit: e.target.value })} data-testid="field-unit">
            {BASE_UNITS.map((u) => (
              <option key={u} value={u}>
                {unit(u)}
              </option>
            ))}
          </select>
        </label>

        {FRACTIONAL_SALE_UNITS.includes(draft.baseUnit) && (
          <p className="muted small" data-testid="fractional-note">
            {t("products.fractionsAllowed")}
          </p>
        )}

        {isEdit && (
          <label className="field row-field">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span>{t("products.active")}</span>
          </label>
        )}

        </div>

        <div className="form-col">
        {/* 🔴 THE PHOTO SECTION COMES FIRST IN THIS COLUMN, and the installed screenshot is why
            twice over. Stacked, the form did not fit a 1008x681 shop screen at all; two columns
            was not enough either — BASIC INFORMATION alone is about 630px of controls. So the
            dialog scrolls, and what must be visible WITHOUT scrolling is the one thing the brief
            names: "opening Edit Product must immediately make the photo state obvious".

            Reading order in the markup still runs BASIC -> ONLINE -> PHOTO for a screen reader?
            No — and that is the honest trade. The visual order here is BASIC | PHOTO + ONLINE,
            and the DOM matches what is shown, so the two never disagree. */}
        <h3 className="form-section">{t("form.secPhoto")}</h3>

        {/* 🔴 THE PHOTO STATE IS VISIBLE HERE, never behind a second dialog. Opening a product that
            has a photo must show it immediately; one that has none must show a deliberate empty
            state rather than nothing at all.

            🔴 AND THE ACTIONS TELL THE TRUTH. Through E2.1 that meant Add/Replace were DISABLED
            with the reason written underneath, because the channel answered NOT_AVAILABLE and a
            button that looks available and then fails is worse than one that admits it. Slice F
            built the producer, so the same principle now means the opposite: the buttons work, and
            the note under them says what the picker will actually accept. */}
        <div className="photo-panel" data-testid="photo-panel">
          {product === null ? (
            <div className="photo-frame" data-testid="photo-new-product">
              <PhotoGlyph />
              <p className="muted">{t("form.photoNone")}</p>
            </div>
          ) : hasPhoto ? (
            <ProductPhoto productId={product.id} version={photoVersion} alt={product.nameAr} label={t} />
          ) : (
            <div className="photo-frame" data-testid="photo-empty">
              <PhotoGlyph />
              <p className="muted">{t("form.photoNone")}</p>
            </div>
          )}

          <div className="tool-actions">
            <button
              className="btn"
              type="button"
              disabled={photoBusy || product === null}
              onClick={() => void choosePhoto()}
              data-testid="photo-add"
            >
              {t(hasPhoto ? "form.photoReplace" : "form.photoAdd")}
            </button>
            {hasPhoto && (
              <button
                className="btn danger ghost"
                type="button"
                disabled={photoBusy}
                onClick={() => void removePhoto()}
                data-testid="photo-remove"
              >
                {t("form.photoRemove")}
              </button>
            )}
          </div>
          {/* What the picker will actually accept. Measured, not aspirational: nativeImage decodes
              JPEG and PNG from a buffer and nothing else — not WEBP, not an iPhone's HEIC. */}
          <p className="muted small">{t(product === null ? "form.photoAfterSave" : "form.photoFormats")}</p>
        </div>
        <h3 className="form-section">{t("form.secOnline")}</h3>
        <p className="muted small">{t("form.localOnly")}</p>

        {/* A description is PROSE, so it is a textarea and its line breaks survive to the website —
            `validateProductMaster` trims only the ends for exactly this reason. */}
        <label className="field">
          <span>{t("form.descAr")}</span>
          <textarea
            dir="rtl"
            lang="ar"
            rows={3}
            value={master.descriptionAr}
            onChange={(e) => setM({ descriptionAr: e.target.value })}
            data-testid="field-descAr"
          />
        </label>

        <label className="field">
          <span>{t("form.descEn")}</span>
          <textarea
            dir="ltr"
            lang="en"
            rows={3}
            value={master.descriptionEn}
            onChange={(e) => setM({ descriptionEn: e.target.value })}
            data-testid="field-descEn"
          />
        </label>

        <label className="field row-field">
          <input
            type="checkbox"
            checked={master.isOnlineVisible}
            onChange={(e) => setM({ isOnlineVisible: e.target.checked })}
            data-testid="field-online"
          />
          <span>{t("form.onlineVisible")}</span>
        </label>
        <p className="muted small">{t("form.onlineHint")}</p>

        </div>
        </div>

        </div>

        <div className="tool-actions form-footer" data-testid="form-footer">
          <button className="btn primary" type="submit" disabled={busy} data-testid="save-product">
            {t("action.save")}
          </button>
          <button className="btn ghost" type="button" onClick={props.onClose} data-testid="cancel-product">
            {t("action.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The full-size preview inside the Product Master form.
 *
 * 🔴 IT ASKS FOR THE PHOTO BY NAME, like every other read of image bytes. It cannot be handed them
 * by the product row — `AdminProductDto` carries a flag, an id and a content hash, never a blob —
 * so it fetches the metadata, then the bytes, then revokes its object URL on the way out.
 *
 * A failure shows the ordinary empty state with the reason beside it. One unreadable photo must not
 * take the form down: the owner still needs to fix the price.
 */
function ProductPhoto(props: { productId: string; version: string | null; alt: string; label: (k: string) => string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    // A new version is a new question: a photo that failed to load must not stay failed after it
    // has been replaced with a good one.
    setFailed(false);
    setUrl(null);
    void (async () => {
      try {
        const meta = await call(pos().getProductImageMeta({ productId: props.productId }));
        if (!live) return;
        if (meta === null) {
          setFailed(true);
          return;
        }
        const got = await call(pos().getProductImageBytes({ imageId: meta.id }));
        if (!live) return;
        setUrl(dataUrlFrom(new Uint8Array(got.bytes), got.meta.mime));
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
    // 🔴 THE VERSION IS IN HERE ON PURPOSE. It is the stored content hash, so replacing a photo
    // changes it and this refetches; re-rendering for any other reason does not.
  }, [props.productId, props.version]);

  if (failed) {
    return (
      <div className="photo-frame photo-frame-broken" data-testid="photo-failed">
        <PhotoGlyph />
        <p className="muted">{props.label("form.photoFailed")}</p>
      </div>
    );
  }
  if (url === null) {
    return (
      <div className="photo-frame" data-testid="photo-loading">
        <PhotoGlyph />
      </div>
    );
  }
  return <img className="photo-preview" src={url} alt={props.alt} data-testid="photo-preview" />;
}

/**
 * Category management — the owner's list.
 *
 * 🔴 DEACTIVATE IS THE ORDINARY ACT AND DELETE IS THE EXCEPTION, and the layout says so: Delete is
 * ghost-danger and only appears where it can actually succeed. A category in use carries a badge
 * instead, because the service refuses that delete and a button that always fails is a trap.
 *
 * There are NO seeded categories anywhere in this product. The shop's list is the shop's.
 */
function CategoryManager(props: {
  categories: readonly CategoryDto[];
  onClose: () => void;
  onChanged: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useT();
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (op: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await op();
      await props.onChanged(message);
    } catch (e) {
      props.onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay">
      <div className="card dialog" data-testid="category-manager">
        <h2>{t("cat.title")}</h2>

        <form
          className="cat-add"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await call(pos().createCategory({ nameAr, nameEn: nameEn.trim() === "" ? null : nameEn }));
              setNameAr("");
              setNameEn("");
            }, t("cat.created"));
          }}
        >
          <label className="field">
            <span>{t("cat.nameAr")}</span>
            <input dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} required data-testid="cat-nameAr" />
          </label>
          <label className="field">
            <span>{t("cat.nameEn")}</span>
            <input dir="ltr" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </label>
          <button className="btn primary" type="submit" disabled={busy} data-testid="cat-add">
            {t("cat.add")}
          </button>
        </form>

        {props.categories.length === 0 ? (
          <p className="center muted" data-testid="cat-empty">
            {t("cat.empty")}
          </p>
        ) : (
          <table className="history-table admin-table">
            <tbody>
              {props.categories.map((c) => (
                <tr key={c.id} className={c.isActive ? undefined : "row-inactive"} data-testid="cat-row">
                  <td>
                    <span dir="auto">{c.nameAr}</span>
                    {c.nameEn && (
                      <>
                        {" "}
                        <span className="muted" dir="auto">
                          ({c.nameEn})
                        </span>
                      </>
                    )}
                    {!c.isActive && <span className="badge state">{t("form.categoryRetired")}</span>}
                  </td>
                  <td className="admin-actions col-actions">
                    <button
                      className={c.isActive ? "btn danger ghost small" : "btn small"}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => call(pos().setCategoryActive({ categoryId: c.id, isActive: !c.isActive })),
                          t("cat.renamed"),
                        )
                      }
                    >
                      {t(c.isActive ? "action.deactivate" : "action.activate")}
                    </button>
                    {/* 🔴 Delete is offered, and the service is the authority on whether it may
                        proceed: a category in use is refused with CATEGORY_IN_USE and the owner is
                        told to deactivate or move its products. The renderer does not pre-judge it,
                        because it does not know the count — and guessing would either hide a
                        legitimate delete or promise one that cannot happen. */}
                    <button
                      className="btn danger ghost small"
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => call(pos().deleteCategory({ categoryId: c.id })), t("cat.deleted"))}
                      data-testid="cat-delete"
                    >
                      {t("action.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="muted small">{t("cat.deleteBlocked")}</p>

        <div className="tool-actions">
          <button className="btn ghost" type="button" onClick={props.onClose} data-testid="cat-close">
            {t("action.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The pairing dialog: a QR, the address, a countdown, and what the phone is doing.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE QR IS INJECTED AS SVG MARKUP, AND `dangerouslySetInnerHTML` IS THE RIGHT TOOL HERE RATHER
 * THAN A SHORTCUT. The alternatives were measured and rejected: a `blob:` URL is refused by this
 * renderer's CSP (`default-src 'none'; img-src 'self' data:` — migration 10's Windows gate caught
 * exactly that), and a `data:` URL would mean base64-encoding a vector that is already text. The
 * markup is produced by `zxing-wasm` inside the main process from a URL main itself built; no part
 * of it comes from a merchant, a file or a network, so there is no untrusted text in the string.
 *
 * 🔴 IT POLLS RATHER THAN LISTENING. There is no main→renderer event channel in this product and
 * this dialog is already running a timer to count the expiry down, so the state ride along with it.
 * `phoneSessionState` reports a save exactly once, which is what makes "saved" a terminal state
 * here instead of something that re-fires every second.
 *
 * 🔴 AND IT NEVER SHOWS THE TOKEN. The DTO does not carry one. What is displayed is the address and
 * the port, deliberately, so a merchant whose phone cannot connect can read them out to whoever is
 * helping — an address is not a secret; the token is, and it lives only inside the symbol.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
function PhoneSessionDialog(props: {
  readonly session: PhoneSessionDto;
  readonly onClose: () => void;
  readonly onSaved: (productId: string, action: "NEW_PRODUCT" | "EDIT_PRODUCT") => void | Promise<void>;
}) {
  const { t } = useT();
  const [state, setState] = useState<PhoneSessionState["state"]>("waiting");
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, new Date(props.session.expiresAt).getTime() - Date.now()),
  );
  const saved = useRef(false);
  /**
   * 🔴 THE SUCCESS IS LATCHED, AND THE FIRST VERSION OF THIS DIALOG GOT IT WRONG.
   *
   * `phoneSessionState` reports `saved` EXACTLY ONCE — that is its contract, so a dialog polling
   * every second cannot re-announce a save. But it means the very next tick returns `closed`, and
   * a render that branched on the live poll value alone would show the success banner for one
   * second and then fall through to... the QR again, for a session that no longer exists. The
   * merchant would see "saved" blink and be handed a dead code to scan.
   *
   * So the terminal state is held here rather than re-read. Found by reasoning about the
   * once-only contract, not by a test — which is why the E2E photographs the banner and the unit
   * test asserts the second poll returns `closed`.
   */
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      setRemainingMs(Math.max(0, new Date(props.session.expiresAt).getTime() - Date.now()));
      try {
        const next = await call(pos().phoneSessionState());
        if (cancelled) return;
        setState(next.state);
        // 🔴 GUARDED, because the poll can only report `saved` once but a slow render could land
        // two ticks: the refresh must not run twice and the dialog must not flicker.
        if (next.state === "saved" && next.savedProductId && !saved.current) {
          saved.current = true;
          setDone(true);
          await props.onSaved(next.savedProductId, next.action ?? props.session.action);
        }
      } catch {
        // A failed poll is not a failed session; the next tick tries again. Swallowing it here is
        // deliberate — showing an error because one poll missed would be a lie about the phone.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.session.expiresAt]);

  // `done` wins over everything: a saved session is closed and expired too, and neither of those
  // is what the owner needs to be told about it.
  const expired = !done && (remainingMs <= 0 || state === "closed");
  const mins = String(Math.floor(remainingMs / 60000));
  const secs = String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0");

  const cancel = async () => {
    try {
      await call(pos().cancelPhoneSession());
    } catch {
      // Closing the dialog matters more than reporting that a session was already gone.
    }
    props.onClose();
  };

  return (
    <div className="overlay">
      <div className="card dialog phone-dialog" data-testid="phone-dialog">
        <h2>{t("phone.title")}</h2>

        {done ? (
          <p className="ok" data-testid="phone-dialog-saved">
            {props.session.action === "EDIT_PRODUCT" ? t("phone.savedEdit") : t("phone.savedNew")}
          </p>
        ) : expired ? (
          <p className="error" data-testid="phone-dialog-expired">
            {t("phone.expired")}
          </p>
        ) : (
          <>
            {/* The symbol itself. Sized in CSS so it stays scannable on a small till screen. */}
            <div
              className="phone-qr"
              data-testid="phone-qr"
              aria-label={t("phone.title")}
              dangerouslySetInnerHTML={{ __html: props.session.qrSvg }}
            />
            <p className="muted small">{t("phone.explain")}</p>
            <p className="small" data-testid="phone-address">
              {t("phone.address")}: <bdi>{props.session.host}</bdi>:<bdi>{props.session.port}</bdi>
            </p>
            <p className="small" data-testid="phone-countdown">
              {t("phone.expiresIn").replace("{mins}", mins).replace("{secs}", secs)}
            </p>
            <p className="muted small" data-testid="phone-progress">
              {state === "claimed" ? t("phone.claimed") : t("phone.waiting")}
            </p>
            {/* 🔴 ONLY WHEN GENUINELY AMBIGUOUS. A machine with one real adapter and a Hyper-V one
                is not a question for the merchant, and a prompt that fires every time is a prompt
                nobody reads. */}
            {props.session.addressAmbiguous && (
              <div className="muted small" data-testid="phone-ambiguous">
                <p>{t("phone.ambiguous")}</p>
                <ul>
                  {props.session.addressCandidates.map((c) => (
                    <li key={`${c.interfaceName}-${c.address}`}>
                      <bdi>{c.address}</bdi> — {c.interfaceName}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* The honest firewall note the approved design asks for, rather than a silent failure. */}
            <p className="muted small" data-testid="phone-firewall">
              {t("phone.firewall")}
            </p>
          </>
        )}

        <div className="actions phone-actions">
          {done || expired ? (
            <button className="btn primary" onClick={() => void cancel()} data-testid="phone-dialog-close">
              {t("phone.close")}
            </button>
          ) : (
            <button className="btn" onClick={() => void cancel()} data-testid="phone-dialog-cancel">
              {t("phone.cancel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
