import type { SaleDto } from "../../shared/ipcContract";
import { fmt } from "../api";
import { fromMoneyDto } from "../../shared/dto";
import { LineMath } from "../components/LineMath";
import { useT } from "../i18n";
import { stamp } from "../format";

/** On-screen receipt summary (no printing in this gate). */
export function Receipt({
  sale,
  onNewSale,
  onAccountFor = null,
}: {
  sale: SaleDto;
  onNewSale?: () => void;
  /** SELL-CREDIT: the customer an on-account sale was just recorded for (the sale DTO carries no name). */
  onAccountFor?: string | null;
}) {
  const { t, unit } = useT();
  return (
    <div className="center">
      <div className="card receipt" data-testid="receipt">
        <div className="receipt-ok">
          <span className="receipt-check" aria-hidden="true">✓</span>
          <h2>{t("receipt.done")}</h2>
        </div>
        <p className="muted small receipt-meta" data-testid="receipt-number">
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
                  <LineMath
                    quantityMilli={l.quantityMilli}
                    saleUnit={l.saleUnit}
                    unitPrice={fromMoneyDto(l.unitPrice)}
                    unitLabel={unit}
                  />
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
        {/* SELL-CREDIT: an unpaid till sale is a debt on a customer's account — never "paid by …". */}
        {sale.sourceType === "pos" && sale.paymentStatus === "unpaid" ? (
          <div className="receipt-paid" data-testid="receipt-on-account">
            <span className="muted small">{t("receipt.onAccount")}</span>
            {onAccountFor !== null && onAccountFor !== undefined && <bdi data-testid="receipt-on-account-customer">{onAccountFor}</bdi>}
            <span className="muted small">{t("receipt.balanceDue")}</span>
            <strong data-testid="receipt-balance-due"><bdi dir="ltr">{fmt(sale.balanceDue)}</bdi></strong>
          </div>
        ) : sale.tenders && sale.tenders.length >= 2 ? (
          /* SELL-SPLIT-CASH-WHISH: one line per part — its method, its amount and, for Whish, its
             reference — never a single "paid by" for money that arrived two ways. */
          <div className="receipt-tenders" data-testid="receipt-tenders">
            {sale.tenders.map((x) => (
              <div className="receipt-paid" key={x.seq} data-testid="receipt-tender" data-seq={x.seq} data-method={x.method} data-provider={x.provider ?? "none"}>
                <span className="muted small">{t("receipt.paidBy")}</span>
                <strong>{x.provider === "whish" ? t("method.whish") : t(`method.${x.method}`)}</strong>
                <strong data-testid="receipt-tender-amount"><bdi dir="ltr">{fmt(x.amount)}</bdi></strong>
                {x.reference && (
                  <bdi dir="auto" data-testid="receipt-tender-reference">
                    {x.reference}
                  </bdi>
                )}
              </div>
            ))}
          </div>
        ) : (
        <div className="receipt-paid">
          <span className="muted small">{t("receipt.paidBy")}</span>
          <strong
            data-testid="receipt-method"
            data-method={sale.paymentMethod ?? "none"}
            data-provider={sale.externalPayment?.provider ?? "none"}
          >
            {sale.externalPayment?.provider === "whish"
              ? t("method.whish")
              : sale.paymentMethod
                ? t(`method.${sale.paymentMethod}`)
                : t("history.payNoMethod")}
          </strong>
        </div>
        )}
        {/* SELL-PARTIAL-DEBT: a partial till sale says BOTH halves — what was received now (by the method
            above) and what stays on the customer's account. Never one total read as paid. */}
        {sale.sourceType === "pos" && sale.paymentStatus === "partial" && (
          <>
            <div className="receipt-paid">
              <span className="muted small">{t("receipt.paidNow")}</span>
              <strong data-testid="receipt-paid-amount"><bdi dir="ltr">{fmt(sale.paid)}</bdi></strong>
            </div>
            <div className="receipt-paid" data-testid="receipt-on-account">
              <span className="muted small">{t("receipt.onAccount")}</span>
              {onAccountFor !== null && onAccountFor !== undefined && <bdi data-testid="receipt-on-account-customer">{onAccountFor}</bdi>}
              <span className="muted small">{t("receipt.balanceDue")}</span>
              <strong data-testid="receipt-balance-due"><bdi dir="ltr">{fmt(sale.balanceDue)}</bdi></strong>
            </div>
          </>
        )}
        {/* P2: the Whish reference the operator recorded — the receipt is the customer's proof of it. */}
        {sale.externalPayment && (
          <div className="receipt-paid">
            <span className="muted small">{t("receipt.reference")}</span>
            <bdi dir="auto" data-testid="receipt-reference">
              {sale.externalPayment.reference}
            </bdi>
          </div>
        )}
        {onNewSale && (
          <button className="btn primary big wide" data-testid="new-sale" onClick={onNewSale}>
            {t("receipt.newSale")}
          </button>
        )}
      </div>
    </div>
  );
}
