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
import { useEffect, useMemo, useRef, useState } from "react";
import { matchesSearch } from "../../../domain/arabic";
import type {
  AdminProductDto,
  InvoiceHeaderPatch,
  InvoiceHeaderPatchKey,
  InvoiceLineRequest,
  InvoiceViewDto,
  ReconciliationDto,
} from "../../../shared/ipcContract";
import { INVOICE_HEADER_PATCH_KEYS } from "../../../shared/ipcContract";
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

/**
 * Exact basis points as a percentage string: 1100 -> "11", 1150 -> "11.5".
 *
 * 🔴 INTEGER ARITHMETIC ONLY. Dividing by 100 in floating point would print 11.499999999999998 for
 * a rate the database holds exactly, on a commercial document.
 */
function percentText(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const frac = basisPoints % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
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
  const [discarding, setDiscarding] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [saved, setSaved] = useState(false);
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

  /**
   * The live DOM value of every header input, so the CURRENT typed text can be read at any moment.
   *
   * 🔴 THE INPUTS STAY UNCONTROLLED ON PURPOSE. Controlling them would re-render on every service
   * response and move the caret while the operator is still typing. Refs give the same read access
   * without touching what they are doing.
   */
  const fieldRefs = useRef<Partial<Record<InvoiceHeaderPatchKey, HTMLInputElement | null>>>({});
  const bind = (key: InvoiceHeaderPatchKey) => (el: HTMLInputElement | null) => {
    fieldRefs.current[key] = el;
  };
  /** "" means "not given" for every header field — the service reads null as cleared. */
  const typed = (key: InvoiceHeaderPatchKey): string | null => {
    const raw = fieldRefs.current[key]?.value;
    if (raw === undefined) return null;
    return raw.trim() === "" ? null : raw;
  };

  /**
   * Sends ONLY the keys that changed.
   *
   * 🔴 THIS IS THE FIX FOR A REAL DEFECT, not a tidy-up. This helper used to fill every untouched
   * field from `view.invoice` and send a FULL overwrite. `view` is React state, so when two blurs
   * happened before the first response landed, the second request carried the FIRST field's stale
   * value and silently overwrote what had just been saved — a customer phone lost on a commercial
   * invoice, depending only on how fast the operator pressed Tab. Keys that are absent here are
   * absent all the way to the service, which then reads them from the current database row.
   */
  const header = (patch: InvoiceHeaderPatch) => run(() => call(pos().updateInvoiceHeader({ invoiceId, patch })));

  /**
   * Writes EVERY header field as the operator has it typed right now, in one request.
   *
   * The durable save path the product rule demands: commercial header data must never depend only
   * on blur timing. Save draft, leaving the screen and Finalize all go through this, so a value
   * that was typed but never blurred is still persisted.
   */
  const flushHeader = async (): Promise<InvoiceViewDto | null> => {
    const patch: Record<string, string | null> = {};
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      if (fieldRefs.current[key]) patch[key] = typed(key);
    }
    if (Object.keys(patch).length === 0) return view;
    const next = await call(pos().updateInvoiceHeader({ invoiceId, patch: patch as InvoiceHeaderPatch }));
    setView(next);
    return next;
  };

  /**
   * Is anything typed but not yet stored?
   *
   * 🔴 THE EXIT RULE NEEDS A REAL ANSWER, not an optimistic one. Comparing each bound input's
   * CURRENT value against the value on the stored row is the only way to know; a flag set by
   * onChange would miss a field restored to its original value and would nag for nothing.
   */
  const isDirty = (): boolean => {
    const inv = view?.invoice;
    if (!inv) return false;
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      if (!fieldRefs.current[key]) continue;
      const stored = (inv as unknown as Record<string, string | null>)[key] ?? "";
      if ((typed(key) ?? "") !== stored) return true;
    }
    return false;
  };

  const snapshot = view?.invoice.taxSnapshot ?? null;
  const taxOn = snapshot?.enabled === true;
  /** The frozen rate as a percentage string, from exact basis points — never a float. */
  const taxRate = snapshot && snapshot.enabled ? percentText(snapshot.rateBasisPoints) : "";

  const applyTax = (enabled: boolean, ratePercent: string) =>
    run(() =>
      call(
        pos().setInvoiceTax({
          invoiceId,
          enabled,
          // An empty rate with tax switched on means "11" has not been typed yet; the service
          // refuses it and says so, rather than guessing a rate onto a commercial document.
          ratePercent: enabled ? (ratePercent.trim() === "" ? "0" : ratePercent) : null,
          label: snapshot?.label ?? null,
        }),
      ),
    );

  const saveDraft = () =>
    run(async () => {
      const next = await flushHeader();
      if (!next) throw new Error("the draft could not be read back");
      setSaved(true);
      return next;
    });

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

  /**
   * Deletes the draft — AFTER an explicit in-app confirmation.
   *
   * 🔴 NOT window.confirm, which the rest of this screen already avoids: the finalize confirmation
   * is an in-app overlay, a native dialog is not reachable by a data-testid, and in some embeddings
   * window.confirm returns false immediately — which would make a destructive action silently do
   * nothing. The overlay is both testable and consistent.
   */
  const discard = async () => {
    setDiscarding(false);
    try {
      await call(pos().discardInvoiceDraft({ invoiceId }));
      onClosed();
    } catch (e) {
      setError(errorText(e));
    }
  };

  /**
   * Leaves the draft WITHOUT destroying it — the safe exit this screen did not have.
   *
   * Until now `onClosed` was reachable only from discard(), so leaving an open draft meant deleting
   * it: an operator had to finalize or lose the work. This flushes the typed header first, so
   * navigating away cannot silently lose a value either.
   */
  /**
   * Leaving the draft.
   *
   * 🔴 NEVER AN ALWAYS-SILENT SAVE. A clean draft exits immediately — no dialog, no pause, which
   * is the common case. A dirty one asks, because a silent save hides a decision the operator did
   * not make, and an unconditional prompt punishes leaving a screen that has not changed.
   */
  const leave = () => {
    if (isDirty()) {
      setExiting(true);
      return;
    }
    onClosed();
  };

  const saveAndLeave = async () => {
    setBusy(true);
    setError(null);
    try {
      await flushHeader();
      setExiting(false);
      onClosed();
    } catch (e) {
      setError(errorText(e));
      setExiting(false);
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      // 🔴 FLUSH FIRST, AND AWAIT IT. A field the operator typed but never blurred — the commonest
      // case being the last field they touched before reaching for Finalize — would otherwise be
      // absent from a document that is immutable the moment it commits. Finalizing is the one
      // irreversible act in this screen, so it reads the inputs rather than trusting that a blur
      // happened. If the flush is refused, finalization does not proceed.
      await flushHeader();
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
          {/* 🔴 THE DOCUMENT SAYS WHAT IT IS, on screen as well as on paper. An outgoing sales
              invoice and an incoming intake document look alike; only a label distinguishes them. */}
          <span className="badge mode" data-testid="sheet-mode">
            {t("inv.mode.badge")}
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
              ref={bind("invoiceDate")}
              onChange={(e) => void header({ invoiceDate: e.target.value === "" ? null : e.target.value })}
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
            ref={bind("customerName")}
            onBlur={(e) => void header({ customerName: e.target.value.trim() === "" ? null : e.target.value })}
            data-testid="sheet-customer"
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.address")}</span>
          <input
            defaultValue={inv.customerAddress ?? ""}
            disabled={readOnly}
            ref={bind("customerAddress")}
            onBlur={(e) => void header({ customerAddress: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.phone")}</span>
          <input
            dir="ltr"
            defaultValue={inv.customerPhone ?? ""}
            disabled={readOnly}
            ref={bind("customerPhone")}
            onBlur={(e) => void header({ customerPhone: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field wide">
          <span>{t("inv.sheet.notes")}</span>
          <input
            defaultValue={inv.notes ?? ""}
            disabled={readOnly}
            ref={bind("notes")}
            onBlur={(e) => void header({ notes: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
      </section>

      {/* 🔴 PER-INVOICE TAX, not a global switch. Issuing one taxed invoice used to mean toggling
          the shop setting on and off around it, and anything finalized in between inherited the
          wrong state. The rate is frozen onto THIS document at finalization. */}
      {!readOnly && (
        <section className="inv-tax" data-testid="sheet-tax-controls">
          <label className="field inline">
            <input
              type="checkbox"
              checked={taxOn}
              onChange={(e) => void applyTax(e.target.checked, taxRate)}
              data-testid="tax-enabled"
            />
            <span>{t("inv.tax.apply")}</span>
          </label>
          {taxOn && (
            <label className="field">
              <span>{t("inv.tax.rate")}</span>
              <input
                dir="ltr"
                inputMode="decimal"
                defaultValue={taxRate}
                onBlur={(e) => void applyTax(true, e.target.value)}
                data-testid="tax-rate"
              />
            </label>
          )}
          <span className="muted small">{t("inv.tax.hint")}</span>
        </section>
      )}

      <div className="inv-lines-scroll">
      <table className="inv-lines" data-testid="sheet-lines">
        <thead>
          <tr>
            <th>{t("inv.sheet.colNo")}</th>
            <th>{t("inv.sheet.colDescription")}</th>
            <th>{t("inv.sheet.colQty")}</th>
            <th>{t("inv.sheet.colUnit")}</th>
            <th>{t("inv.sheet.colUnitPrice")}</th>
            <th>{t("inv.sheet.colTotal")}</th>
            {/* FIELD FINDING 1: the actions column was headerless, so the buttons read as part of
                the money columns next to them. It is a named region now. */}
            <th className="row-actions-col">{t("inv.sheet.colActions")}</th>
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
              <td className="row-actions">
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
              <td className="row-actions">
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
        {/* FIELD FINDING 2: adding a second item was not discoverable. The affordance now sits in
            the table itself, immediately under the last row, and it is ALWAYS rendered — the old
            one disappeared while a row was being entered, which is exactly when an operator looks
            for it. While a draft row is open it is disabled and says why, instead of vanishing. */}
        {!readOnly && (
          <tfoot>
            <tr className="inv-add-row">
              <td colSpan={7}>
                <div className="inv-add-bar">
                  <button
                    className="btn primary"
                    onClick={() => setDraftLine(EMPTY_LINE)}
                    disabled={busy || draftLine !== null}
                    data-testid="add-row"
                  >
                    + {t("inv.sheet.addRow")}
                  </button>
                  {draftLine !== null && (
                    <span className="muted small" data-testid="add-row-hint">
                      {t("inv.sheet.addRowWhileOpen")}
                    </span>
                  )}
                  <span className="muted small" data-testid="sheet-rows-count">
                    {t("inv.sheet.rowsCount")}: <bdi dir="ltr">{view.lines.length}</bdi>
                  </span>
                </div>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      </div>

      {!readOnly && !draftLine && (
        <div className="inv-actions">
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
                    ref={bind("paid")}
                    onBlur={(e) => void header({ paid: e.target.value.trim() === "" ? null : e.target.value })}
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

      {/* 🔴 inv-keep: the action bar stays in view while the sheet scrolls past it. The class
          already existed and was used by one screen only; the sheet it was written for did not
          have it. Reused because this sheet scrolls inside the same .content scrollport, not
          because the class happened to exist — verified in the installed-app screenshots. */}
      <div className="inv-actions inv-keep">
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
            {/* 🔴 THE DURABLE SAVE PATH, as an action the operator can see and trust. The product
                rule is that commercial header data must never depend only on blur timing; this
                writes every field as it is typed right now. */}
            {/* One save, one exit. Two buttons reading "حفظ المسودّة" and "حفظ وخروج" sat side by
                side and differed only in whether the screen closed. */}
            <button className="btn" onClick={() => void saveDraft()} disabled={busy} data-testid="save-draft">
              {t("inv.sheet.save")}
            </button>
            <button className="btn" onClick={leave} disabled={busy} data-testid="leave-draft">
              {t("inv.sheet.leave")}
            </button>
            {saved && (
              <span className="muted small" data-testid="draft-saved">
                {t("inv.sheet.saved")}
              </span>
            )}
            {/* Destructive, separate, and confirmed. Navigating away is NOT this. */}
            <button className="btn danger ghost" onClick={() => setDiscarding(true)} data-testid="discard">
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

      {exiting && (
        <div className="overlay">
          <div className="card dialog" role="dialog" aria-modal="true" data-testid="exit-confirm">
            <h2>{t("inv.exit.title")}</h2>
            <p className="muted small">{t("inv.exit.body")}</p>
            <div className="inv-actions">
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void saveAndLeave()}
                data-testid="exit-save"
              >
                {t("inv.exit.saveAndLeave")}
              </button>
              {/* Ghost-danger: it discards work, but it is an action row, not the confirm of a
                  destructive dialog, so it must not out-weigh "save and leave". */}
              <button
                className="btn danger ghost"
                disabled={busy}
                onClick={() => {
                  setExiting(false);
                  onClosed();
                }}
                data-testid="exit-discard"
              >
                {t("inv.exit.leaveWithout")}
              </button>
              <button className="btn" disabled={busy} onClick={() => setExiting(false)} data-testid="exit-cancel">
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {discarding && (
        <div className="overlay">
          <div className="card dialog" data-testid="discard-confirm">
            <h2>{t("inv.sheet.discardTitle")}</h2>
            <p className="muted">{t("inv.sheet.discardConfirm")}</p>
            <div className="inv-actions">
              <button className="btn danger" onClick={() => void discard()} data-testid="discard-confirm-yes">
                {t("inv.sheet.discardYes")}
              </button>
              <button className="btn ghost" onClick={() => setDiscarding(false)} data-testid="discard-confirm-no">
                {t("inv.sheet.discardKeep")}
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
                  <button className="btn ghost" onClick={() => setFinalized(null)} data-testid="review-later">
                    {t("inv.sheet.later")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{t("inv.history.reviewClear")}</p>
                <button className="btn primary wide" onClick={() => setFinalized(null)} data-testid="review-clear-ok">
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
                  <button className="btn ghost wide" onClick={() => pick(p)} data-testid="picker-option">
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
