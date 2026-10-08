/**
 * Invoices → Needs catalog review, and the panel that resolves one item.
 *
 * 🔴 NO DIFFERENCE IS EVER SHOWN WITHOUT A USABLE WAY OUT. Every state below offers at least one
 * action that always works — "Keep catalog unchanged" or "Keep invoice only" — so the operator can
 * never reach a screen that tells them something is wrong and leaves them there.
 *
 * 🔴 "KEEP" IS A DECISION, NOT "IGNORE". It is labelled as a decision, it records who made it and
 * when, and it takes the item out of the queue. Calling it Ignore would have made a deliberate
 * choice look like giving up.
 *
 * 🔴 AND comparable:false IS NOT "THE UNITS DIFFER". When the invoice's printed unit maps to nothing
 * this build knows, the panel says the unit could not be mapped and asks which catalog unit it
 * means. It never asserts a disagreement it cannot actually demonstrate.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BASE_UNITS } from "../../../domain/catalog";
import { matchesSearch } from "../../../domain/arabic";
import type {
  AdminProductDto,
  DifferenceDto,
  ReconciliationDto,
  ReconciliationFilterDto,
} from "../../../shared/ipcContract";
import { call, errorText, pos } from "../../api";
import { useT } from "../../i18n";

type Field = DifferenceDto["field"];

const FILTERS: ReadonlyArray<readonly [ReconciliationFilterDto, string]> = [
  ["unresolved", "inv.review.needsReview"],
  ["failed", "inv.review.failed"],
  ["resolved", "inv.review.resolved"],
  ["all", "inv.review.all"],
];

const CLASSIFICATION_KEY: Record<string, string> = {
  MATCHED: "inv.history.reviewClear",
  PRICE_DIFFERENCE: "inv.review.updatePrice",
  UNIT_DIFFERENCE: "inv.review.updateUnit",
  DESCRIPTION_DIFFERENCE: "inv.sheet.colDescription",
  MULTIPLE_DIFFERENCES: "inv.review.selectFields",
  PRODUCT_NOT_FOUND: "inv.review.addToCatalog",
  AMBIGUOUS_MATCH: "inv.review.candidates",
};

/** Money in minor units as a decimal string — the same exact representation the service sent. */
function decimal(minor: string): string {
  const digits = minor.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function valueOf(d: DifferenceDto, which: "invoice" | "catalog"): string {
  const raw = which === "invoice" ? d.invoice : d.catalog;
  if (raw === null) return "—";
  return d.field === "selling_price_minor" ? decimal(raw) : raw;
}

export function ReconciliationQueue({ focusInvoiceId }: { readonly focusInvoiceId?: string | null }) {
  const { t } = useT();
  const [filter, setFilter] = useState<ReconciliationFilterDto>("unresolved");
  const [items, setItems] = useState<ReconciliationDto[]>([]);
  const [counts, setCounts] = useState<{ unresolved: number }>({ unresolved: 0 });
  const [open, setOpen] = useState<ReconciliationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const queue = await call(pos().listReconciliationQueue({ filter, limit: 200 }));
      const shown = focusInvoiceId ? queue.items.filter((i) => i.invoiceId === focusInvoiceId) : queue.items;
      setItems([...shown]);
      setCounts({ unresolved: queue.unresolved });
      setError(null);
    } catch (e) {
      setItems([]);
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [filter, focusInvoiceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const afterResolve = async () => {
    setOpen(null);
    await reload();
  };

  if (loading && items.length === 0) return <div className="center muted">…</div>;

  return (
    <div className="inv-review">
      <header className="admin-head">
        <h2>{t("inv.review.title")}</h2>
        <span className="badge" data-testid="review-unresolved-count">
          <bdi dir="ltr">{counts.unresolved}</bdi> {t("inv.review.summary")}
        </span>
      </header>

      <div className="inv-filters" role="tablist">
        {FILTERS.map(([value, key]) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "btn primary small" : "btn ghost small"}
            onClick={() => setFilter(value)}
            data-testid={`review-filter-${value}`}
          >
            {t(key)}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {items.length === 0 ? (
        <p className="muted center" data-testid="review-empty">
          {t("inv.review.none")}
        </p>
      ) : (
        <table className="admin-table" data-testid="review-table">
          <thead>
            <tr>
              <th>{t("inv.review.colInvoice")}</th>
              <th>{t("inv.review.colItem")}</th>
              <th>{t("inv.review.colReason")}</th>
              <th>{t("inv.review.colStatus")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-testid="review-row">
                <td dir="ltr">#{item.invoiceNumber ?? "—"}</td>
                <td>{item.line?.description ?? "—"}</td>
                <td>
                  <span className="badge">{t(CLASSIFICATION_KEY[item.classification] ?? item.classification)}</span>
                  {item.status === "FAILED" && (
                    <div className="error small" data-testid="review-failure">
                      {item.failureMessage}
                    </div>
                  )}
                </td>
                <td>
                  <span className={item.status === "FAILED" ? "error" : "muted"}>{item.status}</span>
                  {item.resolutionActorName && <div className="muted small">{item.resolutionActorName}</div>}
                  {item.attemptCount > 0 && (
                    <div className="muted small" dir="ltr">
                      {item.attemptCount} {t("inv.review.attempts")}
                    </div>
                  )}
                </td>
                <td className="actions">
                  {(item.status === "PENDING" || item.status === "FAILED") && (
                    <button className="btn primary small" onClick={() => setOpen(item)} data-testid="review-resolve">
                      {item.status === "FAILED" ? t("inv.review.retry") : t("inv.review.resolve")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && <ResolutionPanel item={open} onDone={afterResolve} onCancel={() => setOpen(null)} />}
    </div>
  );
}

/**
 * One item, one consistent layout: what the invoice said, what the catalog says, why it is here,
 * and only the actions that are actually valid — plus a safe keep action, always.
 */
function ResolutionPanel({
  item,
  onDone,
  onCancel,
}: {
  readonly item: ReconciliationDto;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(item.status === "FAILED" ? item.failureMessage : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Field[]>(() => item.differences.filter((d) => d.comparable).map((d) => d.field));
  const [unit, setUnit] = useState<string>("");
  const [nameEn, setNameEn] = useState("");
  const [products, setProducts] = useState<AdminProductDto[]>([]);
  const [query, setQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<string | null>(item.matchedProductId);
  const [newSku, setNewSku] = useState("");
  const [newNameAr, setNewNameAr] = useState(item.line?.description ?? "");

  useEffect(() => {
    call(pos().listProducts())
      .then(setProducts)
      .catch(() => setProducts([]));
  }, []);

  const unmappedUnit = item.differences.some((d) => d.field === "base_unit" && !d.comparable);
  const matches = useMemo(
    () => products.filter((p) => matchesSearch([p.nameAr, p.nameEn, p.sku], query)).slice(0, 15),
    [products, query],
  );

  const act = async (fn: () => Promise<ReconciliationDto>, message?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (message) setNotice(message);
      onDone();
    } catch (e) {
      // 🔴 The invoice is untouched and the catalog is untouched; the panel says so rather than
      // leaving the operator wondering what half-happened.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const keepCatalog = () => act(() => call(pos().resolveKeepCatalog({ reconciliationId: item.id })));
  const keepInvoiceOnly = () => act(() => call(pos().resolveKeepInvoiceOnly({ reconciliationId: item.id })));
  const link = () =>
    selectedProduct
      ? act(() => call(pos().resolveLinkProduct({ reconciliationId: item.id, productId: selectedProduct })))
      : undefined;
  const create = () =>
    act(() =>
      call(
        pos().resolveCreateProduct({
          reconciliationId: item.id,
          nameAr: newNameAr.trim() === "" ? null : newNameAr,
          // 🔴 Never translated from the description. Blank stays blank.
          nameEn: nameEn.trim() === "" ? null : nameEn,
          sku: newSku.trim() === "" ? null : newSku,
          baseUnit: unit === "" ? null : unit,
        }),
      ),
    );
  const updateCatalog = (selected: ReadonlyArray<Field>) =>
    act(
      () =>
        call(
          pos().resolveUpdateCatalog({
            reconciliationId: item.id,
            fields: selected,
            canonicalUnit: unit === "" ? null : unit,
            nameEn: nameEn.trim() === "" ? null : nameEn,
          }),
        ),
      selected.includes("selling_price_minor") ? t("inv.review.priceCleared") : undefined,
    );

  const toggle = (field: Field) =>
    setFields((f) => (f.includes(field) ? f.filter((x) => x !== field) : [...f, field]));

  const unitChooser = (
    <label className="field">
      <span>{t("inv.review.chooseUnit")}</span>
      <select value={unit} onChange={(e) => setUnit(e.target.value)} data-testid="resolve-unit">
        <option value="">—</option>
        {BASE_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </label>
  );

  const productChooser = (
    <div className="inv-candidates">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("products.search")}
        data-testid="resolve-search"
      />
      <ul>
        {(query === "" && item.candidates.length > 0
          ? item.candidates.map((c) => ({
              id: c.id,
              nameAr: c.nameAr,
              priceDecimal: decimal(c.sellingPriceMinor),
              baseUnit: c.baseUnit,
            }))
          : matches.map((p) => ({ id: p.id, nameAr: p.nameAr, priceDecimal: p.priceDecimal, baseUnit: p.baseUnit }))
        ).map((c) => (
          <li key={c.id}>
            <label>
              <input
                type="radio"
                name="candidate"
                checked={selectedProduct === c.id}
                onChange={() => setSelectedProduct(c.id)}
                data-testid="resolve-candidate"
              />
              <span>{c.nameAr}</span>
              <span className="muted" dir="ltr">
                {c.priceDecimal} · {c.baseUnit}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {/* A score is not evidence. Nothing here links a product on its own. */}
      <p className="muted small">{t("inv.review.noFuzzy")}</p>
    </div>
  );

  return (
    <div className="overlay">
      <div className="card dialog inv-resolve" data-testid="resolve-panel">
        <h2>{t("inv.review.resolve")}</h2>

        {/* The same four blocks, in the same order, for every classification. */}
        <dl className="inv-resolve-head">
          <dt>{t("inv.review.colItem")}</dt>
          <dd data-testid="resolve-description">{item.line?.description ?? "—"}</dd>
          <dt>{t("inv.review.reason")}</dt>
          <dd>
            <span className="badge" data-testid="resolve-classification">
              {t(CLASSIFICATION_KEY[item.classification] ?? item.classification)}
            </span>
          </dd>
        </dl>

        {item.differences.length > 0 && (
          <table className="admin-table inv-diff" data-testid="resolve-differences">
            <thead>
              <tr>
                <th />
                <th>{t("inv.review.invoiceValue")}</th>
                <th>{t("inv.review.catalogValue")}</th>
              </tr>
            </thead>
            <tbody>
              {item.differences.map((d) => (
                <tr key={d.field} data-testid={`diff-${d.field}`}>
                  <td>
                    {item.classification === "MULTIPLE_DIFFERENCES" || item.differences.length > 1 ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={fields.includes(d.field)}
                          disabled={!d.comparable && d.field === "base_unit" && unit === ""}
                          onChange={() => toggle(d.field)}
                          data-testid={`select-${d.field}`}
                        />
                        <span>{fieldLabel(d.field, t)}</span>
                      </label>
                    ) : (
                      fieldLabel(d.field, t)
                    )}
                  </td>
                  <td dir="auto">{valueOf(d, "invoice")}</td>
                  <td dir="auto">{valueOf(d, "catalog")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 🔴 The unmapped-unit case states what is UNKNOWN, not a disagreement. */}
        {unmappedUnit && (
          <div className="notice" data-testid="resolve-unmapped">
            <p>{t("inv.review.unitUnmapped")}</p>
            <p className="muted small">{t("inv.review.unitUnmappedNote")}</p>
            {unitChooser}
          </div>
        )}

        {item.classification === "PRODUCT_NOT_FOUND" && (
          <section className="inv-resolve-actions" data-testid="resolve-not-found">
            <h3>{t("inv.review.addToCatalog")}</h3>
            <label className="field">
              <span>{t("inv.review.nameArField")}</span>
              <input value={newNameAr} onChange={(e) => setNewNameAr(e.target.value)} data-testid="resolve-name-ar" />
            </label>
            <label className="field">
              <span>{t("inv.review.nameEnField")}</span>
              <input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} data-testid="resolve-name-en" />
            </label>
            <p className="muted small">{t("inv.review.nameEnTyped")}</p>
            <label className="field">
              <span>{t("products.colSku")}</span>
              <input dir="ltr" value={newSku} onChange={(e) => setNewSku(e.target.value)} />
            </label>
            {unitChooser}
            <button className="btn primary" onClick={create} disabled={busy} data-testid="resolve-create">
              {t("inv.review.addToCatalog")}
            </button>

            <h3>{t("inv.review.linkExisting")}</h3>
            {productChooser}
            <button className="btn" onClick={link} disabled={busy || !selectedProduct} data-testid="resolve-link">
              {t("inv.review.linkSelected")}
            </button>
          </section>
        )}

        {item.classification === "AMBIGUOUS_MATCH" && (
          <section className="inv-resolve-actions" data-testid="resolve-ambiguous">
            <h3>{t("inv.review.candidates")}</h3>
            {productChooser}
            <div className="inv-actions">
              <button className="btn primary" onClick={link} disabled={busy || !selectedProduct} data-testid="resolve-link">
                {t("inv.review.linkSelected")}
              </button>
              <button className="btn" onClick={() => setQuery("")} disabled={busy}>
                {t("inv.review.searchAgain")}
              </button>
            </div>
          </section>
        )}

        {(item.classification === "PRICE_DIFFERENCE" ||
          item.classification === "UNIT_DIFFERENCE" ||
          item.classification === "DESCRIPTION_DIFFERENCE") && (
          <section className="inv-resolve-actions" data-testid="resolve-single">
            {item.classification === "DESCRIPTION_DIFFERENCE" && (
              <>
                <label className="field">
                  <span>{t("inv.review.nameEnField")}</span>
                  <input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} data-testid="resolve-name-en" />
                </label>
                <p className="muted small">{t("inv.review.nameEnTyped")}</p>
              </>
            )}
            <button
              className="btn primary"
              onClick={() => updateCatalog(item.differences.map((d) => d.field))}
              disabled={busy || (unmappedUnit && unit === "")}
              data-testid="resolve-update"
            >
              {item.classification === "PRICE_DIFFERENCE"
                ? t("inv.review.updatePrice")
                : item.classification === "UNIT_DIFFERENCE"
                  ? t("inv.review.updateUnit")
                  : t("inv.review.applySelected")}
            </button>
          </section>
        )}

        {item.classification === "MULTIPLE_DIFFERENCES" && (
          <section className="inv-resolve-actions" data-testid="resolve-multiple">
            <h3>{t("inv.review.selectFields")}</h3>
            {fields.includes("name_en") && (
              <>
                <label className="field">
                  <span>{t("inv.review.nameEnField")}</span>
                  <input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} data-testid="resolve-name-en" />
                </label>
                <p className="muted small">{t("inv.review.nameEnTyped")}</p>
              </>
            )}
            {/* Only what is ticked is sent. Nothing else is touched. */}
            <button
              className="btn primary"
              onClick={() => updateCatalog(fields)}
              disabled={busy || fields.length === 0 || (fields.includes("base_unit") && unmappedUnit && unit === "")}
              data-testid="resolve-apply-selected"
            >
              {t("inv.review.applySelected")}
            </button>
          </section>
        )}

        {error && (
          <div className="error" data-testid="resolve-error">
            <p>{error}</p>
            <p className="muted small">{t("inv.review.failureNote")}</p>
          </div>
        )}
        {notice && <p className="notice">{notice}</p>}

        {/* Always present, in every state: the decision that cannot fail. */}
        <div className="inv-actions inv-keep">
          <button className="btn" onClick={keepCatalog} disabled={busy} data-testid="resolve-keep-catalog">
            {t("inv.review.keepCatalog")}
          </button>
          <button className="btn" onClick={keepInvoiceOnly} disabled={busy} data-testid="resolve-keep-invoice">
            {t("inv.review.keepInvoiceOnly")}
          </button>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            {t("action.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function fieldLabel(field: Field, t: (k: string) => string): string {
  switch (field) {
    case "selling_price_minor":
      return t("products.colPrice");
    case "base_unit":
      return t("products.colUnit");
    case "name_ar":
      return t("inv.review.nameArField");
    case "name_en":
      return t("inv.review.nameEnField");
  }
}
