import type { ReactNode } from "react";
import type { MoneyDto, SaleDto } from "../../shared/ipcContract";
import { fmt } from "../api";
import { fromMoneyDto } from "../../shared/dto";
import { LineMath } from "../components/LineMath";
import { useT } from "../i18n";
import { stamp } from "../format";
import { type NamedProduct, receiptLineName } from "../receiptNames";

/** On-screen receipt summary (no printing in this gate). */
export function Receipt({
  sale,
  onNewSale,
  onAccountFor = null,
  advanceApplied = null,
  actions = null,
  productNames,
  fit: fitProp,
}: {
  sale: SaleDto;
  /**
   * J1-PHASE5 U-3: hold the card to the screen and scroll only the lines. Defaults to «has new sale» (the
   * completed-sale screen, unchanged); the History reprint passes it explicitly. Layout only — no data changes.
   */
  fit?: boolean;
  onNewSale?: () => void;
  /** DEC-35x: part of this on-account sale was paid from an advance (read back from main). Not new money. */
  advanceApplied?: { readonly number: string; readonly applied: MoneyDto; readonly debtLeft: MoneyDto } | null;
  /** SELL-CREDIT: the customer an on-account sale was just recorded for (the sale DTO carries no name). */
  onAccountFor?: string | null;
  /** TILL-PRINT: Print / PDF actions (LedgerReceipt), shown above «new sale». */
  actions?: ReactNode;
  /**
   * J1-RECEIPT-NAMES: the current catalogue, for DISPLAY ONLY — each line's name in the screen's
   * language when it is verifiably the recorded product name (receiptNames.ts). Absent → recorded names.
   */
  productNames?: ReadonlyMap<string, NamedProduct>;
}) {
  const { t, unit, lang } = useT();
  /**
   * J1-COMPLETED-FIT (owner Windows run, 2026-11-20): the completed-sale screen is the one with «new
   * sale». Measured with 8 lines at 1366×768: the card was 871 px tall, and the total, payment, print
   * buttons and «new sale» all sat below the visible area (e2e/completed-sale-layout.mjs). There the card
   * is held to the screen and only the LINES scroll — the cart's own pattern.
   * J1-PHASE5 U-3 (UX-SCALING, 2026-11-20): the History reprint had the same defect (total and print row
   * 438–1,081 px below the fold at every measured size), so it now opts in through `fit`.
   */
  const fit = fitProp ?? onNewSale !== undefined;
  return (
    <div className={fit ? "center receipt-fit" : "center"} data-testid="receipt-screen" data-fit={fit ? "1" : "0"}>
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
        <div className="receipt-lines" data-testid="receipt-lines">
        <table className="receipt-table">
          <tbody>
            {sale.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>
                  {(() => {
                    const n = receiptLineName(l, l.productId === null ? undefined : productNames?.get(l.productId), lang);
                    return (
                      <>
                        <span dir="auto" data-testid="receipt-line-name">{n.display}</span>{" "}
                        {/* The RECORDED name — what the printed / PDF receipt says — kept visible whenever it differs. */}
                        {n.recorded !== null && (
                          <span className="muted small receipt-line-recorded" dir="auto" data-testid="receipt-line-recorded">
                            {n.recorded}
                          </span>
                        )}{" "}
                      </>
                    );
                  })()}
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
        </div>
        {/* 🔴 THE METHOD IS TRANSLATED, NOT PRINTED RAW. This cell used to render the enum itself,
            so an Arabic till showed "cash" — the same leak as PENDING in the review queue. */}
        {/* SELL-CREDIT: an unpaid till sale is a debt on a customer's account — never "paid by …". */}
        {sale.sourceType === "pos" && sale.paymentStatus === "unpaid" ? (
          <>
          <div className="receipt-paid" data-testid="receipt-on-account">
            <span className="muted small">{t("receipt.onAccount")}</span>
            {onAccountFor !== null && onAccountFor !== undefined && <bdi data-testid="receipt-on-account-customer">{onAccountFor}</bdi>}
            {/* DEC-35z: after an advance paid part or all of the sale, the sale total is NOT the amount due —
                so the generic "amount due" line is not shown at all on this path. */}
            {!advanceApplied && (
              <>
                <span className="muted small">{t("receipt.balanceDue")}</span>
                <strong data-testid="receipt-balance-due"><bdi dir="ltr">{fmt(sale.balanceDue)}</bdi></strong>
              </>
            )}
          </div>
          {advanceApplied && (
            /* Three facts, each named: what was sold, what the advance paid, what the customer still owes
               (main's read-back after the commit — never computed here). */
            <dl className="receipt-advance" data-testid="receipt-advance-applied" data-advance={advanceApplied.number}>
              <dt>{t("receipt.saleTotal")}</dt>
              <dd data-testid="receipt-sale-total"><bdi dir="ltr">{fmt(sale.total)}</bdi></dd>
              <dt>
                {t("receipt.paidFromAdvance")} <bdi dir="ltr">{advanceApplied.number}</bdi>
              </dt>
              <dd data-testid="receipt-advance-paid"><bdi dir="ltr">{fmt(advanceApplied.applied)}</bdi></dd>
              <dt>{t("receipt.leftOnAccount")}</dt>
              <dd data-testid="receipt-debt-left"><strong><bdi dir="ltr">{fmt(advanceApplied.debtLeft)}</bdi></strong></dd>
            </dl>
          )}
          </>
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
        {actions}
        {onNewSale && (
          <button className="btn primary big wide" data-testid="new-sale" onClick={onNewSale}>
            {t("receipt.newSale")}
          </button>
        )}
      </div>
    </div>
  );
}
