import { useEffect, useRef, useState } from "react";
import type { SaleDto, SaleWithVoidDto } from "../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../api";
import { Receipt } from "./Receipt";
import { useT } from "../i18n";
import { stamp } from "../format";

type T = (key: string) => string;

/**
 * How a sale says it was paid, in words.
 *
 * 🔴 NEVER A FABRICATED METHOD. `paymentMethod` is null when nothing was recorded — the normal
 * case for a manual invoice — and this says exactly that instead of printing "cash". The status is
 * the fact that matters to the shop; the method is how money arrived, when it did.
 */
function paymentText(sale: SaleDto, t: T): string {
  if (sale.paymentStatus === "unpaid") return t("history.payUnpaid");
  const method = sale.paymentMethod ? t(`method.${sale.paymentMethod}`) : t("history.payNoMethod");
  const head = sale.paymentStatus === "partial" ? t("history.payPartial") : t("history.payPaid");
  return `${head} — ${method}`;
}

/** 🔴 unpaid and partial are WARNING, not danger: an outstanding balance is a commercial state. */
const paymentTone = (sale: SaleDto) => (sale.paymentStatus === "paid" ? "ok" : "warn");

export function HistoryScreen() {
  const { t } = useT();
  const [rows, setRows] = useState<SaleWithVoidDto[] | null>(null);
  const [open, setOpen] = useState<SaleWithVoidDto | null>(null);
  const [voiding, setVoiding] = useState<SaleWithVoidDto | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** The control that opened the dialog, so focus can be handed back to it on close. */
  const invokerRef = useRef<HTMLElement | null>(null);

  const load = () => {
    call(pos().getSaleHistory({ limit: 50 })).then(setRows).catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  const closeVoid = () => {
    setVoiding(null);
    setReason("");
    invokerRef.current?.focus();
    invokerRef.current = null;
  };

  /**
   * Dialog mechanics: focus starts on the SAFE action, Esc dismisses, focus is trapped while open
   * and restored to the invoking row button on close.
   *
   * 🔴 ENTER MUST NEVER VOID BY ITSELF, and the mechanism is structural rather than a guard:
   * there is no <form> here, so Enter activates only the element that currently has focus. Focus
   * opens on the dismiss button, and Enter in the reason input submits nothing. Voiding therefore
   * requires the operator to be standing on the destructive control. A valid reason existing is
   * not consent to destroy.
   */
  useEffect(() => {
    if (!voiding) return;
    dismissRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeVoid();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiding]);

  const confirmVoid = async () => {
    if (!voiding) return;
    setBusy(true);
    setError(null);
    try {
      await call(pos().voidSale({ saleId: voiding.sale.id, reason }));
      setVoiding(null);
      setReason("");
      invokerRef.current = null;
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <div>
        <button className="btn ghost" onClick={() => setOpen(null)}>
          ← {t("history.back")}
        </button>
        {open.void && (
          <p className="error">
            {t("history.voidedBy")} {open.void.cashierName}: {open.void.reason}
          </p>
        )}
        <Receipt sale={open.sale} />
      </div>
    );
  }

  return (
    <div className="history">
      <div className="screen-head">
        <h1>{t("history.title")}</h1>
        {rows && (
          <span className="muted small">
            {t("history.count")}: <bdi>{rows.length}</bdi>
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!rows && <p className="muted">{t("common.loading")}</p>}
      {rows && rows.length === 0 && <p className="muted center">{t("history.empty")}</p>}
      {rows && rows.length > 0 && (
        <table className="history-table">
          <thead>
            <tr>
              <th>{t("history.colReceipt")}</th>
              <th>{t("history.colTime")}</th>
              <th>{t("history.colCashier")}</th>
              <th>{t("history.colPayment")}</th>
              <th className="num">{t("history.colTotal")}</th>
              <th className="num">{t("history.colBalance")}</th>
              <th>{t("history.colStatus")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.sale.id}
                className={r.void ? "voided" : ""}
                data-testid="history-row"
                data-source={r.sale.sourceType}
                data-payment-status={r.sale.paymentStatus}
                data-payment-method={r.sale.paymentMethod ?? "none"}
              >
                <td>
                  <bdi dir="ltr">#{r.sale.receiptNumber}</bdi>
                  {/* The document's own number, so an invoice sale is identifiable without a
                      second history page. Absent on a till sale, which has no invoice. */}
                  {r.sale.sourceType === "invoice" && (
                    <span className="badge state" data-testid="history-invoice-ref">
                      {t("history.invoiceRef")} <bdi dir="ltr">{r.sale.invoiceNumber ?? "—"}</bdi>
                    </span>
                  )}
                </td>
                <td><bdi dir="ltr">{stamp(r.sale.completedAt)}</bdi></td>
                <td>{r.sale.cashierName}</td>
                <td data-testid="history-payment">
                  <span className={`badge ${paymentTone(r.sale)}`}>{paymentText(r.sale, t)}</span>
                </td>
                <td className="num"><bdi dir="ltr">{fmt(r.sale.total)}</bdi></td>
                <td className="num" data-testid="history-balance">
                  {r.sale.balanceDue.minor === "0" ? "—" : <bdi dir="ltr">{fmt(r.sale.balanceDue)}</bdi>}
                </td>
                <td>
                  <span className={`badge ${r.void ? "bad" : "state"}`}>
                    {r.void ? t("history.statusVoided") : t("history.statusCompleted")}
                  </span>
                </td>
                <td>
                  <div className="actions">
                    <button className="btn small" onClick={() => setOpen(r)}>
                      {t("history.view")}
                    </button>
                    {/* 🔴 GHOST-DANGER IN A ROW. Filled danger belongs to the final confirmation
                        only; two filled red blocks used to be the strongest objects on a screen
                        whose whole job is looking things up. */}
                    {!r.void && r.sale.sourceType === "pos" && (
                      <button
                        className="btn danger ghost small"
                        data-testid="history-void"
                        onClick={(e) => {
                          invokerRef.current = e.currentTarget;
                          setVoiding(r);
                          setReason("");
                          setError(null);
                        }}
                      >
                        {t("void.action")}
                      </button>
                    )}
                    {/* 🔴 NOT HIDDEN SILENTLY. Voiding an invoice-origin sale would leave the
                        immutable invoice looking valid while its sale was cancelled; the honest
                        correction is a credit note, which is not built yet. The service refuses it
                        too, so this is the explanation rather than the enforcement. */}
                    {!r.void && r.sale.sourceType === "invoice" && (
                      <span className="muted small" data-testid="history-void-blocked" title={t("void.blockedWhy")}>
                        {t("void.blocked")}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {voiding && (
        <div className="overlay">
          <div className="card dialog" role="dialog" aria-modal="true" ref={dialogRef}>
            <h2>
              {t("void.title")} <bdi dir="ltr">#{voiding.sale.receiptNumber}</bdi> —{" "}
              <bdi dir="ltr">{fmt(voiding.sale.total)}</bdi>
            </h2>
            <p className="muted small">{t("void.body")}</p>
            {/* Which receipt this is, so one can be told from another before it is destroyed. */}
            <p className="small">
              <bdi dir="ltr">{stamp(voiding.sale.completedAt)}</bdi> · {voiding.sale.cashierName} ·{" "}
              {paymentText(voiding.sale, t)}
            </p>
            <label className="field">
              <span>{t("void.reason")}</span>
              <input
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("void.reasonHint")}
                data-testid="void-reason"
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="row">
              <button className="btn" disabled={busy} onClick={closeVoid} ref={dismissRef} data-testid="void-dismiss">
                {t("void.dismiss")}
              </button>
              <button
                className="btn danger"
                disabled={busy || reason.trim().length < 3}
                onClick={() => void confirmVoid()}
                data-testid="void-confirm"
              >
                {t("void.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
