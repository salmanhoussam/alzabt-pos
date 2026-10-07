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
import { useCallback, useEffect, useMemo, useState } from "react";
import { BASE_UNITS, FRACTIONAL_SALE_UNITS } from "../../domain/catalog";
import { matchesSearch } from "../../domain/arabic";
import type { AdminProductDto, ProductDraftRequest } from "../../shared/ipcContract";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";

type Editing = { readonly mode: "add" } | { readonly mode: "edit"; readonly product: AdminProductDto };

const EMPTY: ProductDraftRequest = { nameAr: "", nameEn: null, sku: null, price: "", baseUnit: "piece" };

function draftOf(p: AdminProductDto): ProductDraftRequest {
  return { nameAr: p.nameAr, nameEn: p.nameEn, sku: p.sku, price: p.priceDecimal, baseUnit: p.baseUnit };
}

export function ProductsScreen() {
  const { t, unit } = useT();
  const [products, setProducts] = useState<AdminProductDto[] | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setProducts(await call(pos().listProducts()));
    } catch (e) {
      setProducts([]);
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = useMemo(() => {
    if (!products) return [];
    return products.filter((p) => matchesSearch([p.nameAr, p.nameEn, p.sku], query));
  }, [products, query]);

  if (products === null) return <div className="center muted">…</div>;

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
        <button className="btn primary" onClick={() => setEditing({ mode: "add" })} data-testid="add-product">
          {t("action.add")}
        </button>
      </header>

      <p className="muted small">{t("products.searchHint")}</p>
      <p className="muted small" data-testid="product-count">
        {products.length} {t("products.count")} · {shown.length} {t("products.countShown")}
      </p>

      {products.length === 0 ? (
        <p className="center muted">{t("products.empty")}</p>
      ) : shown.length === 0 ? (
        <p className="center muted" data-testid="no-match">
          {t("products.noMatch")}
        </p>
      ) : (
        <table className="history-table admin-table">
          <thead>
            <tr>
              <th>{t("products.colName")}</th>
              <th>{t("products.colSku")}</th>
              <th className="num">{t("products.colPrice")}</th>
              <th>{t("products.colUnit")}</th>
              <th>{t("products.colState")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className={p.isActive ? undefined : "row-inactive"} data-testid="product-row">
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
                  <span className="badge faint">
                    {t(p.source === "manual" ? "products.source.manual" : "products.source.import")}
                  </span>
                </td>
                <td dir="auto">{p.sku ?? "—"}</td>
                <td className="num">
                  {p.priceDecimal} {p.price.currency}
                  {p.priceNeedsReview && <span className="badge warn">{t("products.priceNeedsReview")}</span>}
                </td>
                <td>
                  {unit(p.baseUnit)}
                  {FRACTIONAL_SALE_UNITS.includes(p.baseUnit) && (
                    <span className="badge faint" title={t("products.fractionsAllowed")}>
                      0.001
                    </span>
                  )}
                </td>
                <td>
                  <span className={p.isActive ? "badge ok" : "badge"}>
                    {t(p.isActive ? "products.active" : "products.inactive")}
                  </span>
                </td>
                <td className="admin-actions">
                  <button className="btn ghost" onClick={() => setEditing({ mode: "edit", product: p })}>
                    {t("action.edit")}
                  </button>
                  <button
                    className="btn ghost"
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

      {editing && (
        <ProductForm
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            setNotice(message);
            await reload();
          }}
          onError={setError}
        />
      )}

      {(notice || error) && (
        <div className="overlay">
          <div className="card dialog">
            <h2>{error ? t("err.title") : t("app.name")}</h2>
            <p className={error ? "error" : undefined}>{error ?? notice}</p>
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
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const { t, unit } = useT();
  const isEdit = props.editing.mode === "edit";
  const [draft, setDraft] = useState<ProductDraftRequest>(
    props.editing.mode === "edit" ? draftOf(props.editing.product) : EMPTY,
  );
  const [isActive, setIsActive] = useState(props.editing.mode === "edit" ? props.editing.product.isActive : true);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<ProductDraftRequest>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (props.editing.mode === "edit") {
        await call(pos().updateProduct({ id: props.editing.product.id, draft, isActive }));
        await props.onSaved(t("msg.updated"));
      } else {
        await call(pos().createProduct({ draft }));
        await props.onSaved(t("msg.created"));
      }
    } catch (e) {
      props.onError(errorText(e));
    } finally {
      setBusy(false);
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

        <div className="tool-actions">
          <button className="btn primary" type="submit" disabled={busy} data-testid="save-product">
            {t("action.save")}
          </button>
          <button className="btn ghost" type="button" onClick={props.onClose}>
            {t("action.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
