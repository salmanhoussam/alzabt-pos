import type { SaleDto } from "../../shared/ipcContract";
import { fmt } from "../api";
import { fromMoneyDto } from "../../shared/dto";
import { LineMath } from "../components/LineMath";
import { useT } from "../i18n";
import { stamp } from "../format";

/** On-screen receipt summary (no printing in this gate). */
export function Receipt({ sale, onNewSale }: { sale: SaleDto; onNewSale?: () => void }) {
  const { t } = useT();
  return (
    <div className="center">
      <div className="card receipt">
        <div className="receipt-ok">
          <span className="receipt-check" aria-hidden="true">✓</span>
          <h2>{t("receipt.done")}</h2>
        </div>
        <p className="muted small receipt-meta">
          {t("receipt.number")} <bdi dir="ltr">#{sale.receiptNumber}</bdi>
          {" · "}
          <bdi dir="ltr">{stamp(sale.completedAt)}</bdi>
          {" · "}
          {sale.cashierName}
        </p>
        <table className="receipt-table">
          <tbody>
            {sale.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>
                  <span dir="auto">{l.productName}</span>{" "}
                  {l.sku && <span className="muted small"><bdi dir="ltr">{l.sku}</bdi></span>}
                </td>
                <td className="num">
                  <LineMath quantityMilli={l.quantityMilli} saleUnit={l.saleUnit} unitPrice={fromMoneyDto(l.unitPrice)} />
                </td>
                <td className="num"><bdi dir="ltr">{fmt(l.lineTotal)}</bdi></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>{t("receipt.total")}</th>
              <th className="num receipt-total"><bdi dir="ltr">{fmt(sale.total)}</bdi></th>
            </tr>
          </tfoot>
        </table>
        {/* 🔴 THE METHOD IS TRANSLATED, NOT PRINTED RAW. This cell used to render the enum itself,
            so an Arabic till showed "cash" — the same leak as PENDING in the review queue. */}
        <div className="receipt-paid">
          <span className="muted small">{t("receipt.paidBy")}</span>
          <strong data-testid="receipt-method">
            {sale.paymentMethod ? t(`method.${sale.paymentMethod}`) : t("history.payNoMethod")}
          </strong>
        </div>
        {onNewSale && (
          <button className="btn primary big wide" data-testid="new-sale" onClick={onNewSale}>
            {t("receipt.newSale")}
          </button>
        )}
      </div>
    </div>
  );
}
