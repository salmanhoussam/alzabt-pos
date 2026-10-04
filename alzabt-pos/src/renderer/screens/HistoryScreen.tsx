import { useEffect, useState } from "react";
import type { SaleWithVoidDto } from "../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../api";
import { Receipt } from "./Receipt";

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
              <th>Paid by</th>
              <th className="num">Total</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sale.id} className={r.void ? "voided" : ""}>
                <td>{r.sale.receiptNumber}</td>
                <td>{new Date(r.sale.completedAt).toLocaleString()}</td>
                <td>{r.sale.cashierName}</td>
                <td>{r.sale.paymentMethod}</td>
                <td className="num">{fmt(r.sale.total)}</td>
                <td>{r.void ? "Voided" : "Completed"}</td>
                <td>
                  <div className="actions">
                  <button className="btn" onClick={() => setOpen(r)}>
                    View
                  </button>
                  {!r.void && (
                    <button
                      className="btn danger"
                      onClick={() => {
                        setVoiding(r);
                        setReason("");
                        setError(null);
                      }}
                    >
                      Void
                    </button>
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
