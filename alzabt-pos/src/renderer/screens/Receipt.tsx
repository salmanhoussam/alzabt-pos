import type { SaleDto } from "../../shared/ipcContract";
import { fmt } from "../api";

/** On-screen receipt summary (no printing in this gate). */
export function Receipt({ sale, onNewSale }: { sale: SaleDto; onNewSale?: () => void }) {
  return (
    <div className="center">
      <div className="card receipt">
        <h2>Sale completed</h2>
        <p className="muted">
          Receipt #{sale.receiptNumber} · {new Date(sale.completedAt).toLocaleString()} · {sale.cashierName}
        </p>
        <table className="receipt-table">
          <tbody>
            {sale.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>
                  {l.productName} <span className="muted">({l.sku})</span>
                </td>
                <td className="num">
                  {l.quantity} × {fmt(l.unitPrice)}
                </td>
                <td className="num">{fmt(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>Total</th>
              <th className="num">{fmt(sale.total)}</th>
            </tr>
            <tr>
              <td colSpan={2}>Paid by</td>
              <td className="num">{sale.paymentMethod}</td>
            </tr>
          </tfoot>
        </table>
        {onNewSale && (
          <button className="btn primary big wide" onClick={onNewSale}>
            New sale
          </button>
        )}
      </div>
    </div>
  );
}
