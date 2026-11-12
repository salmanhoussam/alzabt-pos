/**
 * The printed COL- receipt (DEC-35z+ COL): money RECEIVED from a customer against their debt — one
 * document per real money arrival: a direct collection (one settlement) or one shared Whish transfer
 * (one receipt, several debts). Pure: a ledger DTO in, a small A5 HTML document out. Same rules as the
 * ADV- / REF- documents:
 *
 * 🔴 IT TAKES A LEDGER DTO AND NOTHING ELSE; every interpolated value goes through `escape()`.
 * 🔴 IT IS A DOCUMENT OF A PAYMENT THAT ALREADY EXISTS. Printing writes nothing: no payment row, no
 *    second registration of the Whish reference. The reference printed is the ORIGINAL one.
 * 🔴 IT IS STABLE. No live balance is printed (it moves with later payments), so every reprint of the
 *    same COL- is identical.
 *
 * Pure (no Electron import), so it is tested in plain Node.
 */
import type { CollectionDocumentDto, StatementDocumentDto } from "../shared/ipcContract";
import { instantIn } from "./advanceDocument";
import { escape, printMoney } from "./invoiceDocument";

export interface CollectionDocumentInput {
  readonly doc: CollectionDocumentDto;
  readonly shopName: string | null;
  readonly timeZone?: string;
}

const t = (ar: string, en: string) => `${escape(ar)} <span class="en">${escape(en)}</span>`;

/** The debt's own document, in both languages — never an internal id. */
export function debtText(d: StatementDocumentDto): string {
  switch (d.kind) {
    case "invoice":
      return `${t("فاتورة", "Invoice")} <bdi dir="ltr">#${d.number}</bdi>`;
    case "sale":
      return `${t("إيصال بيع", "Sale receipt")} <bdi dir="ltr">#${d.receiptNumber}</bdi>`;
    case "manual":
      return `${t("دين يدوي", "Manual debt")} <bdi>${escape(d.reference)}</bdi>`;
    case "unresolved":
      return "—";
  }
}

function channelText(doc: CollectionDocumentDto): string {
  if (doc.channel === "cash") return t("نقداً", "Cash");
  if (doc.channel === "whish") return t("ويش موني", "Whish Money");
  if (doc.channel === "bank_transfer") return t("تحويل مصرفي", "Bank transfer");
  return t("أخرى (قديم)", "Other (legacy)");
}

export function renderCollectionDocument(input: CollectionDocumentInput): string {
  const d = input.doc;
  const rows: string[] = [
    `<tr><th>${t("رقم الإيصال", "Receipt no.")}</th><td><bdi dir="ltr" data-field="number">${escape(d.number)}</bdi></td></tr>`,
    `<tr><th>${t("الزبون", "Customer")}</th><td><bdi data-field="customer">${escape(d.customerName)}</bdi></td></tr>`,
    `<tr><th>${t("المبلغ المقبوض", "Amount received")}</th><td class="amount" data-field="amount">${printMoney(d.total)}</td></tr>`,
    `<tr><th>${t("طريقة القبض", "Payment method")}</th><td data-field="method">${channelText(d)}${
      d.reference ? ` · <bdi dir="ltr" data-field="reference">${escape(d.reference)}</bdi>` : ""
    }</td></tr>`,
    `<tr><th>${t("المستلم", "Received by (staff)")}</th><td><bdi data-field="by">${escape(d.receivedByName)}</bdi></td></tr>`,
    `<tr><th>${t("تاريخ القبض", "Received at")}</th><td><bdi dir="ltr" data-field="at">${escape(instantIn(d.receivedAt, input.timeZone))}</bdi></td></tr>`,
  ];
  const lines = d.lines
    .map(
      (l, i) =>
        `<tr data-field="line-${i}"><td>${debtText(l.debtDocument)}</td><td class="num">${printMoney(l.amount)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(d.number)}</title>
<style>
  @page { size: A5; margin: 12mm 10mm; }
  body { margin: 0; font-family: "Segoe UI", "Tahoma", "Arial", sans-serif; font-size: 11pt; color: #111; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  h2 { font-size: 11pt; margin: 4mm 0 1mm; }
  .shop { font-size: 12pt; font-weight: 600; margin-bottom: 2mm; }
  .en { color: #555; font-size: 8.5pt; }
  table { width: 100%; border-collapse: collapse; margin: 3mm 0; }
  th, td { border: 1px solid #999; padding: 2mm 3mm; text-align: start; vertical-align: top; }
  th { width: 38%; background: #f1f1f1; font-weight: 600; }
  td.amount { font-size: 14pt; font-weight: 700; }
  td.num { width: 30%; }
  .foot { font-size: 9pt; color: #333; margin-top: 4mm; }
</style></head>
<body>
${input.shopName ? `<div class="shop"><bdi>${escape(input.shopName)}</bdi></div>` : ""}
<h1>${t("إيصال تحصيل", "Collection receipt")}</h1>
<table>${rows.join("")}</table>
<h2>${t("سُدِّد به", "Applied to")}</h2>
<table class="lines">${lines}</table>
<p class="foot">${t(
    "تسديد دين على حساب الزبون — ليس بيعاً جديداً. إعادة طباعة هذا الإيصال لا تسجّل دفعة جديدة.",
    "A payment against the customer's debt — not a new sale. Reprinting this receipt records no new payment.",
  )}</p>
</body></html>`;
}
