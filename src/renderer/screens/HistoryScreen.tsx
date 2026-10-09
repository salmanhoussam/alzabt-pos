import { useEffect, useState } from "react";
import type { SaleDto, SaleWithVoidDto } from "../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../api";
import { Receipt } from "./Receipt";

/**
 * How a sale says it was paid, in words.
 *
 * 🔴 NEVER A FABRICATED METHOD. `paymentMethod` is null when nothing was recorded — which is the
 * normal case for a manual invoice — and this says exactly that instead of printing "cash". The
 * status is the fact that matters to the shop; the method is how money arrived, when it did.
 */
function paymentText(sale: SaleDto): string {
  if (sale.paymentStatus === "unpaid") return "Unpaid";
  const method = sale.paymentMethod ?? "method not recorded";
  return sale.paymentStatus === "partial" ? `Partial — ${method}` : `Paid — ${method}`;
}

export function HistoryScreen() {
  const [rows, setRows] = useState<SaleWithVoidDto[] | null>(null);
  const [open, setOpen] = useState<SaleWithVoidDto | null>(null);
  const [voiding, setVoiding] = useState<SaleWithVoidDto | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    call(pos().getSaleHistory({ limit: 50 })).then(setRows).catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  const confirmVoid = async () => {
    if (!voiding) return;
    setBusy(true);
    setError(null);
    try {
      await call(pos().voidSale({ saleId: voiding.sale.id, reason }));
      setVoiding(null);
      setReason("");
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
          ← Back to history
        </button>
        {open.void && (
          <p className="error">
            VOIDED by {open.void.cashierName}: {open.void.reason}
          </p>
        )}
        <Receipt sale={open.sale} />
      </div>
    );
  }

  return (
    <div className="history">
      <h2>Sale history</h2>
      {error && <p className="error">{error}</p>}
      {!rows && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted">No sales yet.</p>}
      {rows && rows.length > 0 && (
        <table className="history-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Cashier</th>
              <th>Payment</th>
              <th className="num">Total</th>
              <th className="num">Balance due</th>
              <th>Status</th>
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
              >
                <td>
                  {r.sale.receiptNumber}
                  {/* The document's own number, so an invoice sale is identifiable without a
                      second history page. Absent on a till sale, which has no invoice. */}
                  {r.sale.sourceType === "invoice" && (
                    <span className="src-badge" data-testid="history-invoice-ref">
                      Invoice {r.sale.invoiceNumber ?? "—"}
                    </span>
                  )}
                </td>
                <td>{new Date(r.sale.completedAt).toLocaleString()}</td>
                <td>{r.sale.cashierName}</td>
                <td data-testid="history-payment">{paymentText(r.sale)}</td>
                <td className="num">{fmt(r.sale.total)}</td>
                <td className="num" data-testid="history-balance">
                  {r.sale.balanceDue.minor === "0" ? "—" : fmt(r.sale.balanceDue)}
                </td>
                <td>{r.void ? "Voided" : "Completed"}</td>
                <td>
                  <div className="actions">
                  <button className="btn" onClick={() => setOpen(r)}>
                    View
                  </button>
                  {!r.void && r.sale.sourceType === "pos" && (
                    <button
                      className="btn danger"
                      data-testid="history-void"
                      onClick={() => {
                        setVoiding(r);
                        setReason("");
                        setError(null);
                      }}
                    >
                      Void
                    </button>
                  )}
                  {/* 🔴 NOT HIDDEN SILENTLY. Voiding an invoice-origin sale would leave the
                      immutable invoice looking valid while its sale was cancelled; the honest
                      correction is a credit note, which is not built yet. The service refuses it
                      too, so this is the explanation rather than the enforcement. */}
                  {!r.void && r.sale.sourceType === "invoice" && (
                    <span className="muted" data-testid="history-void-blocked" title="Invoice cancellation / credit-note workflow is not implemented yet">
                      From invoice — no void
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
          <div className="card dialog">
            <h2>
              Void receipt #{voiding.sale.receiptNumber} — {fmt(voiding.sale.total)}
            </h2>
            <p className="muted">The sale stays in the ledger; a separate void record is added.</p>
            <label className="field">
              Reason
              <input
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. wrong item rung up"
                autoFocus
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="row">
              <button className="btn ghost" disabled={busy} onClick={() => setVoiding(null)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy || reason.trim().length < 3} onClick={confirmVoid}>
                Confirm void
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
