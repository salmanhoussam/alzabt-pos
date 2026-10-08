/**
 * The invoice sheet — filling in an invoice, not a generic admin form.
 *
 * 🔴 THE RENDERER'S MATH IS A PREVIEW AND NOTHING ELSE. Every line total shown here comes from the
 * SERVICE: a row is sent, the service parses the typed quantity and price, computes the total with
 * the same exact-integer half-up rule the sales ledger uses, stores it, and sends the whole invoice
 * back. The sheet renders what came back. It never computes a total it then asks anyone to trust,
 * and FINALIZE sends an invoice id and nothing else.
 *
 * 🔴 PICKING A CATALOG PRODUCT PREFILLS; IT DOES NOT BIND. The description, unit and price stay
 * editable afterwards, and editing them here changes the invoice only — never the catalog. What the
 * catalog should become is decided later, deliberately, in the review queue.
 */
import { useEffect, useMemo, useState } from "react";
import { matchesSearch } from "../../../domain/arabic";
import type {
  AdminProductDto,
  InvoiceLineRequest,
  InvoiceViewDto,
  ReconciliationDto,
} from "../../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../../api";
import { useT } from "../../i18n";

const EMPTY_LINE: InvoiceLineRequest = {
  description: null,
  unitLabel: null,
  canonicalUnit: null,
  productId: null,
  quantity: "1",
  unitPrice: "",
};

type FinalizedNotice = {
  readonly number: number;
  readonly items: ReadonlyArray<ReconciliationDto>;
};

/** Groups the review queue the way the operator is told about it after finalizing. */
function summarize(items: ReadonlyArray<ReconciliationDto>, t: (k: string) => string): string[] {
  const unresolved = items.filter((i) => i.status === "PENDING" || i.status === "FAILED");
  const counts = new Map<string, number>();
  for (const item of unresolved) counts.set(item.classification, (counts.get(item.classification) ?? 0) + 1);
  const label: Record<string, string> = {
    PRODUCT_NOT_FOUND: t("inv.review.addToCatalog"),
    PRICE_DIFFERENCE: t("inv.review.invoiceValue") + " / " + t("inv.review.catalogValue"),
    UNIT_DIFFERENCE: t("inv.sheet.colUnit"),
    DESCRIPTION_DIFFERENCE: t("inv.sheet.colDescription"),
    MULTIPLE_DIFFERENCES: t("inv.review.selectFields"),
    AMBIGUOUS_MATCH: t("inv.review.candidates"),
  };
  return [...counts.entries()].map(([classification, n]) => `${n} × ${label[classification] ?? classification}`);
}

export function InvoiceSheet({
  invoiceId,
  onReviewNow,
  onClosed,
}: {
  readonly invoiceId: string;
  readonly onReviewNow: () => void;
  readonly onClosed: () => void;
}) {
  const { t } = useT();
  const [view, setView] = useState<InvoiceViewDto | null>(null);
  const [products, setProducts] = useState<AdminProductDto[]>([]);
  const [draftLine, setDraftLine] = useState<InvoiceLineRequest | null>(null);
  const [pickerFor, setPickerFor] = useState<"new" | string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [finalized, setFinalized] = useState<FinalizedNotice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call(pos().getInvoice({ invoiceId }))
      .then(setView)
      .catch((e) => setError(errorText(e)));
    call(pos().listProducts())
      .then(setProducts)
      .catch(() => setProducts([]));
  }, [invoiceId]);

  const readOnly = view?.invoice.status === "final";

  /** One place where every service answer lands, so a refusal always reaches the operator. */
  const run = async (action: () => Promise<InvoiceViewDto>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
    } catch (e) {
      // 🔴 The paid/total invariant refusal arrives here. It names both amounts and the way out,
      // and it is shown verbatim rather than replaced with a generic message.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const header = (patch: Partial<Record<"invoiceDate" | "customerName" | "customerAddress" | "customerPhone" | "notes" | "paid", string | null>>) => {
    if (!view) return;
    const inv = view.invoice;
    void run(() =>
      call(
        pos().updateInvoiceHeader({
          invoiceId,
          invoiceDate: patch.invoiceDate !== undefined ? patch.invoiceDate : inv.invoiceDate,
          customerName: patch.customerName !== undefined ? patch.customerName : inv.customerName,
          customerAddress: patch.customerAddress !== undefined ? patch.customerAddress : inv.customerAddress,
          customerPhone: patch.customerPhone !== undefined ? patch.customerPhone : inv.customerPhone,
          notes: patch.notes !== undefined ? patch.notes : inv.notes,
          paid: patch.paid !== undefined ? patch.paid : (inv.paid.minor === "0" ? null : paidText(inv.paid.minor)),
        }),
      ),
    );
  };

  const addLine = () => {
    if (!draftLine) return;
    void run(async () => {
      const next = await call(pos().addInvoiceLine({ invoiceId, line: draftLine }));
      setDraftLine(null);
      return next;
    });
  };

  const editLine = (lineId: string, line: InvoiceLineRequest) =>
    run(() => call(pos().updateInvoiceLine({ invoiceId, lineId, line })));

  const removeLine = (lineId: string) => run(() => call(pos().removeInvoiceLine({ invoiceId, lineId })));

  const discard = async () => {
    if (!window.confirm(t("inv.sheet.discardConfirm"))) return;
    try {
      await call(pos().discardInvoiceDraft({ invoiceId }));
      onClosed();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const finalize = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const next = await call(pos().finalizeInvoice({ invoiceId }));
      setView(next);
      const items = await call(pos().listReconciliation({ invoiceId }));
      setFinalized({ number: next.invoice.invoiceNumber!, items });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const print = async () => {
    try {
      const result = await call(pos().printInvoice({ invoiceId }));
      if (result.status === "unavailable") setError(t("inv.sheet.print") + " — " + t("inv.review.none"));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const savePdf = async () => {
    try {
      await call(pos().saveInvoicePdf({ invoiceId }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const matches = useMemo(
    () => products.filter((p) => matchesSearch([p.nameAr, p.nameEn, p.sku], query)).slice(0, 20),
    [products, query],
  );

  if (!view) return <div className="center muted">{error ?? "…"}</div>;
  const inv = view.invoice;

  /** Prefills from a catalog product — and leaves every field editable. */
  const prefill = (p: AdminProductDto): InvoiceLineRequest => ({
    description: p.nameAr,
    unitLabel: p.baseUnit,
    canonicalUnit: p.baseUnit,
    productId: p.id,
    quantity: "1",
    unitPrice: p.priceDecimal,
  });

  const pick = (p: AdminProductDto) => {
    const line = prefill(p);
    if (pickerFor === "new") setDraftLine(line);
    else if (pickerFor) {
      const existing = view.lines.find((l) => l.id === pickerFor);
      if (existing) void editLine(existing.id, { ...line, quantity: String(existing.quantityMilli / 1000) });
    }
    setPickerFor(null);
    setQuery("");
  };

  return (
    <div className="inv-sheet">
      <header className="inv-sheet-head">
        <div className="inv-issuer">
          <strong data-testid="sheet-issuer">{inv.issuer?.nameAr ?? t("inv.company.title")}</strong>
          {inv.issuer?.nameEn && <span dir="ltr" className="muted"> · {inv.issuer.nameEn}</span>}
        </div>
        <div className="inv-meta">
          <span>
            {t("inv.sheet.number")}:{" "}
            <strong dir="ltr" data-testid="sheet-number">
              {inv.invoiceNumber === null ? `— (${t("inv.sheet.numberAtFinalize")})` : `#${inv.invoiceNumber}`}
            </strong>
          </span>
          <span className={readOnly ? "badge" : "badge draft"} data-testid="sheet-status">
            {readOnly ? t("inv.sheet.title") : t("inv.sheet.draft")}
          </span>
          <label className="field inline">
            <span>{t("inv.sheet.date")}</span>
            <input
              type="date"
              dir="ltr"
              value={inv.invoiceDate ?? ""}
              disabled={readOnly}
              onChange={(e) => header({ invoiceDate: e.target.value === "" ? null : e.target.value })}
              data-testid="sheet-date"
            />
          </label>
        </div>
      </header>

      {readOnly && <p className="notice" data-testid="sheet-readonly">{t("inv.sheet.readOnly")}</p>}

      <section className="inv-customer">
        <label className="field">
          <span>{t("inv.sheet.customer")}</span>
          <input
            defaultValue={inv.customerName ?? ""}
            disabled={readOnly}
            onBlur={(e) => header({ customerName: e.target.value.trim() === "" ? null : e.target.value })}
            data-testid="sheet-customer"
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.address")}</span>
          <input
            defaultValue={inv.customerAddress ?? ""}
            disabled={readOnly}
            onBlur={(e) => header({ customerAddress: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.phone")}</span>
          <input
            dir="ltr"
            defaultValue={inv.customerPhone ?? ""}
            disabled={readOnly}
            onBlur={(e) => header({ customerPhone: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field wide">
          <span>{t("inv.sheet.notes")}</span>
          <input
            defaultValue={inv.notes ?? ""}
            disabled={readOnly}
            onBlur={(e) => header({ notes: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
      </section>

      <table className="inv-lines" data-testid="sheet-lines">
        <thead>
          <tr>
            <th>{t("inv.sheet.colNo")}</th>
            <th>{t("inv.sheet.colDescription")}</th>
            <th>{t("inv.sheet.colQty")}</th>
            <th>{t("inv.sheet.colUnit")}</th>
            <th>{t("inv.sheet.colUnitPrice")}</th>
            <th>{t("inv.sheet.colTotal")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {view.lines.map((l) => (
            <tr key={l.id} data-testid="sheet-line">
              <td className="num" dir="ltr">{l.lineNo}</td>
              <td>
                <input
                  defaultValue={l.description ?? ""}
                  disabled={readOnly}
                  onBlur={(e) =>
                    editLine(l.id, {
                      description: e.target.value.trim() === "" ? null : e.target.value,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: priceText(l.unitPrice.minor),
                    })
                  }
                />
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  defaultValue={l.quantityText}
                  disabled={readOnly}
                  onBlur={(e) =>
                    editLine(l.id, {
                      description: l.description,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: e.target.value,
                      unitPrice: priceText(l.unitPrice.minor),
                    })
                  }
                />
              </td>
              <td>
                {/* Free text, kept verbatim — the printed label is historical truth. */}
                <input
                  defaultValue={l.unitLabel ?? ""}
                  disabled={readOnly}
                  onBlur={(e) =>
                    editLine(l.id, {
                      description: l.description,
                      unitLabel: e.target.value.trim() === "" ? null : e.target.value,
                      canonicalUnit: null,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: priceText(l.unitPrice.minor),
                    })
                  }
                />
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  defaultValue={priceText(l.unitPrice.minor)}
                  disabled={readOnly}
                  onBlur={(e) =>
                    editLine(l.id, {
                      description: l.description,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: e.target.value,
                    })
                  }
                />
              </td>
              {/* Read-only, and computed by the service — never by this component. */}
              <td className="num total" data-testid="sheet-line-total">
                <bdi dir="ltr">{fmt(l.lineTotal)}</bdi>
              </td>
              <td className="actions">
                {!readOnly && (
                  <>
                    <button className="btn ghost small" onClick={() => setPickerFor(l.id)}>
                      {t("inv.sheet.pick")}
                    </button>
                    <button className="btn ghost small" onClick={() => void removeLine(l.id)}>
                      {t("inv.sheet.remove")}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {view.lines.length === 0 && !draftLine && (
            <tr>
              <td colSpan={7} className="muted center">
                {t("inv.sheet.noLines")}
              </td>
            </tr>
          )}
          {draftLine && (
            <tr className="inv-new-line">
              <td className="num">+</td>
              <td>
                <input
                  autoFocus
                  value={draftLine.description ?? ""}
                  onChange={(e) => setDraftLine({ ...draftLine, description: e.target.value || null })}
                  data-testid="new-line-description"
                />
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  value={draftLine.quantity}
                  onChange={(e) => setDraftLine({ ...draftLine, quantity: e.target.value })}
                  data-testid="new-line-quantity"
                />
              </td>
              <td>
                <input
                  value={draftLine.unitLabel ?? ""}
                  onChange={(e) => setDraftLine({ ...draftLine, unitLabel: e.target.value || null, canonicalUnit: null })}
                  data-testid="new-line-unit"
                />
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  value={draftLine.unitPrice}
                  onChange={(e) => setDraftLine({ ...draftLine, unitPrice: e.target.value })}
                  data-testid="new-line-price"
                />
              </td>
              <td className="num muted">—</td>
              <td className="actions">
                <button className="btn primary small" onClick={addLine} disabled={busy} data-testid="new-line-save">
                  {t("action.save")}
                </button>
                <button className="btn ghost small" onClick={() => setPickerFor("new")}>
                  {t("inv.sheet.pick")}
                </button>
                <button className="btn ghost small" onClick={() => setDraftLine(null)}>
                  {t("action.cancel")}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {!readOnly && !draftLine && (
        <div className="inv-actions">
          <button className="btn" onClick={() => setDraftLine(EMPTY_LINE)} data-testid="add-row">
            + {t("inv.sheet.addRow")}
          </button>
          <span className="muted small">{t("inv.sheet.pickHint")}</span>
        </div>
      )}

      <section className="inv-totals">
        <table>
          <tbody>
            <tr>
              <th>{t("inv.sheet.subtotal")}</th>
              <td data-testid="sheet-subtotal"><bdi dir="ltr">{fmt(inv.subtotal)}</bdi></td>
            </tr>
            {/* Only when the shop configured a tax. No rate is built into this program. */}
            {inv.taxSnapshot?.enabled || inv.tax.minor !== "0" ? (
              <tr>
                <th>{inv.taxSnapshot?.label ?? t("inv.sheet.tax")}</th>
                <td data-testid="sheet-tax"><bdi dir="ltr">{fmt(inv.tax)}</bdi></td>
              </tr>
            ) : null}
            <tr className="grand">
              <th>{t("inv.sheet.total")}</th>
              <td data-testid="sheet-total"><bdi dir="ltr">{fmt(inv.total)}</bdi></td>
            </tr>
            <tr>
              <th>{t("inv.sheet.paid")}</th>
              <td>
                {readOnly ? (
                  <bdi dir="ltr">{fmt(inv.paid)}</bdi>
                ) : (
                  <input
                    dir="ltr"
                    inputMode="decimal"
                    defaultValue={inv.paid.minor === "0" ? "" : paidText(inv.paid.minor)}
                    onBlur={(e) => header({ paid: e.target.value.trim() === "" ? null : e.target.value })}
                    data-testid="sheet-paid"
                  />
                )}
              </td>
            </tr>
            <tr>
              <th>{t("inv.sheet.balance")}</th>
              <td data-testid="sheet-balance"><bdi dir="ltr">{fmt(inv.balanceDue)}</bdi></td>
            </tr>
          </tbody>
        </table>
        <div className="inv-words" data-testid="sheet-words">
          <span className="muted small">{t("inv.sheet.words")}</span>
          <div>{inv.amountInWords ?? <span className="muted">({t("inv.sheet.wordsAtFinalize")})</span>}</div>
        </div>
      </section>

      {error && <p className="error" data-testid="sheet-error">{error}</p>}

      <div className="inv-actions">
        {!readOnly ? (
          <>
            <button
              className="btn primary"
              onClick={() => setConfirming(true)}
              disabled={busy || view.lines.length === 0}
              data-testid="finalize"
            >
              {t("inv.sheet.finalize")}
            </button>
            <button className="btn ghost" onClick={discard} data-testid="discard">
              {t("inv.sheet.discard")}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={print} data-testid="print">
              {t("inv.sheet.print")}
            </button>
            <button className="btn" onClick={savePdf} data-testid="save-pdf">
              {t("inv.sheet.savePdf")}
            </button>
          </>
        )}
        <button className="btn ghost" onClick={onClosed}>
          {t("action.cancel")}
        </button>
      </div>

      {/* Finalization is never implicit: the operator reads the figures and confirms. */}
      {confirming && (
        <div className="overlay">
          <div className="card dialog" data-testid="finalize-confirm">
            <h2>{t("inv.sheet.confirmTitle")}</h2>
            <dl className="inv-confirm">
              <dt>{t("inv.sheet.customer")}</dt>
              <dd>{inv.customerName ?? "—"}</dd>
              <dt>{t("inv.sheet.lineCount")}</dt>
              <dd dir="ltr">{view.lines.length}</dd>
              <dt>{t("inv.sheet.subtotal")}</dt>
              <dd dir="ltr">{fmt(inv.subtotal)}</dd>
              <dt>{t("inv.sheet.total")}</dt>
              <dd dir="ltr">{fmt(inv.total)}</dd>
              <dt>{t("inv.sheet.paid")}</dt>
              <dd dir="ltr">{fmt(inv.paid)}</dd>
              <dt>{t("inv.sheet.balance")}</dt>
              <dd dir="ltr">{fmt(inv.balanceDue)}</dd>
            </dl>
            <p className="muted small">{t("inv.sheet.confirmNote")}</p>
            <div className="inv-actions">
              <button className="btn primary" onClick={finalize} data-testid="finalize-confirm-yes">
                {t("inv.sheet.finalize")}
              </button>
              <button className="btn ghost" onClick={() => setConfirming(false)}>
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {finalized && (
        <div className="overlay">
          <div className="card dialog" data-testid="finalized-notice">
            <h2>
              {t("inv.sheet.finalized")} <bdi dir="ltr">#{finalized.number}</bdi>
            </h2>
            {summarize(finalized.items, t).length > 0 ? (
              <>
                <p>
                  <strong dir="ltr">
                    {finalized.items.filter((i) => i.status === "PENDING" || i.status === "FAILED").length}
                  </strong>{" "}
                  {t("inv.review.summary")}
                </p>
                <ul>
                  {summarize(finalized.items, t).map((row) => (
                    <li key={row} dir="auto">
                      {row}
                    </li>
                  ))}
                </ul>
                <div className="inv-actions">
                  <button className="btn primary" onClick={onReviewNow} data-testid="review-now">
                    {t("inv.sheet.reviewNow")}
                  </button>
                  <button className="btn ghost" onClick={() => setFinalized(null)}>
                    {t("inv.sheet.later")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{t("inv.history.reviewClear")}</p>
                <button className="btn primary wide" onClick={() => setFinalized(null)}>
                  {t("action.ok")}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {pickerFor && (
        <div className="overlay">
          <div className="card dialog" data-testid="product-picker">
            <h2>{t("inv.sheet.pick")}</h2>
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("products.search")}
            />
            <ul className="inv-picker">
              {matches.map((p) => (
                <li key={p.id}>
                  <button className="btn ghost wide" onClick={() => pick(p)}>
                    <span>{p.nameAr}</span>
                    <span className="muted" dir="ltr">
                      {p.priceDecimal} · {p.baseUnit}
                      {p.priceNeedsReview ? " · price?" : ""}
                    </span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="muted">{t("products.noMatch")}</li>}
            </ul>
            <p className="muted small">{t("inv.sheet.pickHint")}</p>
            <button className="btn ghost wide" onClick={() => setPickerFor(null)}>
              {t("action.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Minor units back to the decimal string the service will re-parse. Two decimals, no float math. */
function priceText(minor: string): string {
  const digits = minor.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
const paidText = priceText;
