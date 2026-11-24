/**
 * The printed REF- receipt (DEC-35z+): cash handed back from a customer advance's unused balance. One
 * pure function from the DTO main read from the ledger BY ID to a small A5 HTML document — the same
 * rules as the ADV- document:
 *
 * 🔴 IT TAKES A LEDGER DTO AND NOTHING ELSE. The renderer has no channel that carries markup; every
 *    interpolated value goes through `escape()`.
 * 🔴 IT SAYS WHAT THE MONEY IS: cash OUT of the drawer, from the named ADV-. Not an expense, not a
 *    reduction of sales revenue. When the ADV arrived by Whish, it says plainly that the refund was
 *    paid in CASH and that NOTHING was sent back through Whish — the POS cannot know or do that.
 * 🔴 IT IS STABLE. A reprint renders the same REF- from the same immutable row: no live balance is
 *    printed (it changes with later applications/refunds), so the first print and every reprint match.
 *
 * Pure (no Electron import), so it is tested in plain Node.
 */
import type { AdvanceRefundDto } from "../shared/ipcContract";
import { instantIn } from "./advanceDocument";
import { escape, printMoney } from "./invoiceDocument";

export interface RefundDocumentInput {
  readonly refund: AdvanceRefundDto;
  readonly shopName: string | null;
  readonly timeZone?: string;
}

const t = (ar: string, en: string) => `${escape(ar)} <span class="en">${escape(en)}</span>`;

export function renderRefundDocument(input: RefundDocumentInput): string {
  const r = input.refund;
  const fromWhish = r.advanceChannel === "whish";
  const original = fromWhish
    ? `${t("ويش موني", "Whish Money")}${r.advanceReference ? ` · <bdi dir="ltr" data-field="advance-reference">${escape(r.advanceReference)}</bdi>` : ""}`
    : t("نقداً", "Cash");
  const rows: string[] = [
    `<tr><th>${t("رقم الإيصال", "Receipt no.")}</th><td><bdi dir="ltr" data-field="number">${escape(r.number)}</bdi></td></tr>`,
    `<tr><th>${t("الزبون", "Customer")}</th><td><bdi data-field="customer">${escape(r.customerName)}</bdi></td></tr>`,
    `<tr><th>${t("المبلغ المُعاد", "Amount refunded")}</th><td class="amount" data-field="amount">${printMoney(r.amount)}</td></tr>`,
    `<tr><th>${t("طريقة الإعادة", "Refund method")}</th><td data-field="method">${t("نقداً", "Cash")}</td></tr>`,
    `<tr><th>${t("من الدفعة المسبقة", "From advance")}</th><td><bdi dir="ltr" data-field="advance">${escape(r.advanceNumber)}</bdi> — ${original}</td></tr>`,
    `<tr><th>${t("السبب", "Reason")}</th><td><bdi data-field="reason">${escape(r.reason)}</bdi></td></tr>`,
    `<tr><th>${t("أعادها", "Refunded by (staff)")}</th><td><bdi data-field="by">${escape(r.refundedByName)}</bdi></td></tr>`,
    `<tr><th>${t("التاريخ", "Date")}</th><td><bdi dir="ltr" data-field="at">${escape(instantIn(r.refundedAt, input.timeZone))}</bdi></td></tr>`,
  ];
  const whishNote = fromWhish
    ? `<p class="banner" data-field="whish-note">${t(
        "قُبضت الدفعة الأصلية عبر ويش موني، وأُعيد هذا المبلغ نقداً من الصندوق. لم يُرسَل أي مبلغ عبر ويش موني.",
        "The original advance was received by Whish Money; this amount was handed back in CASH from the drawer. Nothing was sent back through Whish Money.",
      )}</p>`
    : "";
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(r.number)}</title>
<style>
  @page { size: A5; margin: 12mm 10mm; }
  body { margin: 0; font-family: "Segoe UI", "Tahoma", "Arial", sans-serif; font-size: 11pt; color: #111; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  .shop { font-size: 12pt; font-weight: 600; margin-bottom: 2mm; }
  .en { color: #555; font-size: 8.5pt; }
  table { width: 100%; border-collapse: collapse; margin: 3mm 0; }
  th, td { border: 1px solid #999; padding: 2mm 3mm; text-align: start; vertical-align: top; }
  th { width: 38%; background: #f1f1f1; font-weight: 600; }
  td.amount { font-size: 14pt; font-weight: 700; }
  .banner { border: 2px solid #111; padding: 2mm 3mm; margin: 3mm 0; font-weight: 600; }
  .foot { font-size: 9pt; color: #333; margin-top: 4mm; }
  .sign { margin-top: 8mm; display: flex; justify-content: space-between; font-size: 10pt; }
</style></head>
<body>
${input.shopName ? `<div class="shop"><bdi>${escape(input.shopName)}</bdi></div>` : ""}
<h1>${t("إيصال استرداد نقدي", "Cash refund receipt")}</h1>
${whishNote}
<table>${rows.join("")}</table>
<p class="foot">${t(
    "استرداد نقدي من الرصيد غير المستخدم لدفعة مسبقة — مال خارج من الصندوق. ليس مصروفاً ولا تخفيضاً لإيراد المبيعات، ولا يغيّر قيد الدفعة الأصلية.",
    "A cash refund from an advance's unused balance — money out of the drawer. Not an expense, not a reduction of sales revenue, and the original advance is not changed.",
  )}</p>
<div class="sign"><span>${t("توقيع المستلم", "Received by (customer)")}: ____________</span><span>${t("توقيع المحل", "Shop")}: ____________</span></div>
</body></html>`;
}
