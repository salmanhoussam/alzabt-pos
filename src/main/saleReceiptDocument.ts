/**
 * TILL-PRINT — the printed / PDF till receipt (owner decisions D-TP1/D-TP3). One pure function from the SAME
 * ledger DTO the on-screen receipt renders (SaleReceiptDto) to HTML, in two layouts:
 *   thermal80  80 mm roll (72 mm printable), auto height — for a thermal printer, when the shop has one;
 *   a5         A5 page — for "Save PDF" and an ordinary printer.
 *
 * 🔴 IT TAKES THE LEDGER DTO AND NOTHING ELSE; every value goes through `escape()`.
 * 🔴 THE SAME FACTS AS THE SCREEN, in the same order: lines, total, then the payment exactly as the on-screen
 *    receipt states it — paid by (method + Whish reference) | split tenders | on account (customer; for a sale
 *    paid from an advance: sale total / paid from ADV-x / left on account — never the sale total as "amount
 *    due") | partial (paid now + left on account). A voided sale is stamped VOIDED, never "refunded".
 * 🔴 A REPRINT (`copy`) carries the SAME receipt number and a visible «نسخة / COPY» mark; nothing else changes.
 *
 * Pure (no Electron import), so it is tested in plain Node.
 */
import type { MoneyDto, SaleReceiptDto } from "../shared/ipcContract";
import { instantIn } from "./advanceDocument";
import { escape, printDecimalOf, printMoney } from "./invoiceDocument";

export type ReceiptLayout = "thermal80" | "a5";

export interface SaleReceiptDocumentInput {
  readonly receipt: SaleReceiptDto;
  readonly layout: ReceiptLayout;
  readonly copy: boolean;
  readonly shopName: string | null;
  readonly timeZone?: string;
}

const t = (ar: string, en: string) => `${escape(ar)} <span class="en">${escape(en)}</span>`;

const METHOD: Record<string, [string, string]> = {
  cash: ["نقداً", "Cash"],
  whish: ["ويش موني", "Whish Money"],
  bank_transfer: ["تحويل مصرفي", "Bank transfer"],
  external: ["تحويل", "Transfer"],
  card: ["بطاقة", "Card"],
  other: ["أخرى", "Other"],
};
const methodText = (method: string | null, provider: string | null | undefined) => {
  const key = provider === "whish" ? "whish" : provider === "bank_transfer" ? "bank_transfer" : method ?? "";
  const m = METHOD[key];
  return m ? t(m[0], m[1]) : "—";
};

/** quantity in milli-units → "2" / "1.5" / "0.125" (never a float). */
function qty(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const frac = String(Math.abs(milli % 1000)).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

const row = (label: string, value: string, field: string, strong = false) =>
  `<tr data-field="${field}"><th>${label}</th><td>${strong ? `<strong>${value}</strong>` : value}</td></tr>`;
const money = (m: MoneyDto) => printMoney(m);

export function renderSaleReceiptDocument(input: SaleReceiptDocumentInput): string {
  const { receipt: r, layout, copy } = input;
  const s = r.sale;
  const pay: string[] = [];
  if (s.sourceType === "pos" && s.paymentStatus === "unpaid") {
    pay.push(row(t("على الحساب", "On account"), r.customerName ? `<bdi>${escape(r.customerName)}</bdi>` : "—", "on-account"));
    if (r.advanceApplied) {
      pay.push(row(t("إجمالي البيع", "Sale total"), money(s.total), "sale-total"));
      pay.push(
        row(
          `${t("المسدّد من الدفعة المقدّمة", "Paid from advance")} <bdi dir="ltr" data-field="advance-number">${escape(r.advanceApplied.number)}</bdi>`,
          money(r.advanceApplied.applied),
          "advance-paid",
        ),
      );
      pay.push(row(t("المتبقّي على الحساب", "Left on account"), money(r.advanceApplied.debtLeft), "debt-left", true));
    } else {
      pay.push(row(t("المبلغ المستحق", "Amount due"), money(s.balanceDue), "balance-due", true));
    }
  } else if (s.tenders && s.tenders.length >= 2) {
    for (const x of s.tenders) {
      pay.push(
        row(
          `${t("دُفع", "Paid by")} ${methodText(x.method, x.provider)}`,
          `${money(x.amount)}${x.reference ? ` · <bdi dir="ltr" data-field="tender-reference">${escape(x.reference)}</bdi>` : ""}`,
          `tender-${x.seq}`,
        ),
      );
    }
  } else {
    pay.push(row(t("طريقة الدفع", "Paid by"), methodText(s.paymentMethod, s.externalPayment?.provider ?? null), "method"));
  }
  if (s.sourceType === "pos" && s.paymentStatus === "partial") {
    pay.push(row(t("المدفوع الآن", "Paid now"), money(s.paid), "paid-now"));
    pay.push(row(t("على الحساب", "On account"), r.customerName ? `<bdi>${escape(r.customerName)}</bdi>` : "—", "on-account"));
    pay.push(row(t("المتبقّي على الحساب", "Left on account"), money(s.balanceDue), "balance-due", true));
  }
  if (s.externalPayment) pay.push(row(t("مرجع ويش", "Whish reference"), `<bdi dir="ltr" data-field="reference">${escape(s.externalPayment.reference)}</bdi>`, "reference-row"));

  const lines = s.lines
    .map(
      (l) =>
        `<tr data-field="line-${l.lineNo}"><td><bdi>${escape(l.productName)}</bdi>${l.sku ? ` <span class="en"><bdi dir="ltr">${escape(l.sku)}</bdi></span>` : ""}<br><span class="qty"><bdi dir="ltr">${escape(qty(l.quantityMilli))} × ${escape(printDecimal(l.unitPrice))}</bdi></span></td><td class="num">${money(l.lineTotal)}</td></tr>`,
    )
    .join("");

  const page =
    layout === "thermal80"
      ? `@page { size: 80mm 297mm; margin: 3mm 4mm; } body { width: 72mm; font-size: 9pt; } h1 { font-size: 11pt; } .en { font-size: 7pt; }`
      : `@page { size: A5; margin: 12mm 10mm; } body { font-size: 11pt; } h1 { font-size: 15pt; } .en { font-size: 8.5pt; }`;
  const voided = r.void
    ? `<p class="banner" data-field="voided">${t("بيع مُبطَل — الإبطال ليس استرداداً", "VOIDED sale — a void is not a refund")}<br>${t("السبب", "Reason")}: <bdi>${escape(r.void.reason)}</bdi> · <bdi>${escape(r.void.cashierName)}</bdi></p>`
    : "";
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(`#${s.receiptNumber}`)}</title>
<style>
  ${page}
  body { margin: 0; font-family: "Segoe UI", "Tahoma", "Arial", sans-serif; color: #000; }
  h1 { margin: 0 0 1mm; }
  .shop { font-weight: 700; }
  .en { color: #444; }
  table { width: 100%; border-collapse: collapse; margin: 1.5mm 0; }
  th, td { padding: 0.8mm 1mm; text-align: start; vertical-align: top; border-bottom: 1px dotted #888; }
  td.num { text-align: end; white-space: nowrap; }
  .qty { color: #333; }
  .total th, .total td { font-weight: 700; border-top: 1px solid #000; }
  .banner { border: 1.5px solid #000; padding: 1mm 2mm; margin: 2mm 0; font-weight: 700; }
  .copy { text-align: center; letter-spacing: 1px; }
</style></head>
<body data-layout="${layout}">
${input.shopName ? `<div class="shop"><bdi>${escape(input.shopName)}</bdi></div>` : ""}
<h1>${t("إيصال بيع", "Sales receipt")}</h1>
${copy ? `<p class="banner copy" data-field="copy">${t("نسخة", "COPY")}</p>` : ""}
${voided}
<table>
${row(t("رقم الإيصال", "Receipt no."), `<bdi dir="ltr" data-field="number">#${s.receiptNumber}</bdi>`, "number-row")}
${row(t("التاريخ", "Date"), `<bdi dir="ltr" data-field="at">${escape(instantIn(s.completedAt, input.timeZone))}</bdi>`, "at-row")}
${row(t("البائع", "Cashier"), `<bdi data-field="cashier">${escape(s.cashierName)}</bdi>`, "cashier-row")}
</table>
<table class="lines">${lines}
<tr class="total" data-field="total"><th>${t("المجموع", "Total")}</th><td class="num">${money(s.total)}</td></tr>
</table>
<table>${pay.join("")}</table>
</body></html>`;
}

/**
 * A unit price as a plain decimal (no currency) for the "qty × price" line.
 * CURRENCY-P1: at the currency's own exponent (`printDecimalOf`), like every other printed amount — it was a fixed 2.
 */
function printDecimal(m: MoneyDto): string {
  return printDecimalOf(m);
}
