/**
 * The printed invoice — one pure function from a FROZEN invoice to an A4 HTML document.
 *
 * 🔴 IT TAKES THE FROZEN DTO AND NOTHING ELSE. No database handle, no company profile, no catalog.
 * Everything it prints — the issuer block, the amount in words, every line total — was computed and
 * stored when the invoice was finalized, so reprinting an invoice from last month cannot pick up
 * this month's phone number or this month's prices. That is not a convention here; it is the
 * function's signature.
 *
 * 🔴 AND IT NEVER ACCEPTS RENDERER HTML. The main process calls this with an id-loaded invoice; the
 * renderer has no channel that carries markup. Every value interpolated below goes through
 * `escape()`, because a description is free text an operator typed.
 *
 * Pure (no Electron import), so it is tested in plain Node.
 */
import type { InvoiceLineDto, InvoiceViewDto, MoneyDto } from "../shared/ipcContract";

export interface InvoiceDocumentOptions {
  /** A file:// or data: URL for the logo. Absent prints the issuer's name alone. */
  readonly logoUrl?: string | null;
  /** Which language's labels lead. Both are always printed — the document is bilingual. */
  readonly language?: "ar" | "en";
}

const LABELS = {
  invoice: ["فاتورة", "INVOICE"],
  number: ["رقم الفاتورة", "Invoice No."],
  date: ["التاريخ", "Date"],
  customer: ["العميل", "Customer"],
  address: ["العنوان", "Address"],
  phone: ["الهاتف", "Phone"],
  notes: ["ملاحظات", "Notes"],
  itemNo: ["م", "No."],
  description: ["البيان", "Description"],
  qty: ["الكمية", "QTY"],
  unit: ["الوحدة", "Unit"],
  unitPrice: ["سعر الوحدة", "Unit Price"],
  lineTotal: ["المجموع", "Total"],
  subtotal: ["المجموع", "Subtotal"],
  total: ["الإجمالي", "Grand Total"],
  paid: ["المدفوع", "Paid"],
  balance: ["الرصيد المستحق", "Balance Due"],
  taxpayer: ["الرقم المالي", "Taxpayer No."],
  register: ["السجل التجاري", "Comm. Register"],
  vat: ["رقم التسجيل الضريبي", "VAT Reg. No."],
} as const;

/** Every interpolated value passes through here. A description is text an operator typed. */
export function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Money as it prints: the exact minor units turned into a decimal string, with the currency beside
 * it, wrapped in a left-to-right isolate.
 *
 * 🔴 `<bdi dir="ltr">` is not decoration. In an RTL document, a run like "474.40 USD" sitting next
 * to Arabic text is reordered by the bidirectional algorithm — the currency can jump to the wrong
 * side of the number, and a reader sees a different amount than the one stored. The isolate pins
 * the run.
 */
export function printMoney(m: MoneyDto, exponent = 2): string {
  const digits = m.minor.padStart(exponent + 1, "0");
  const decimal = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return `<bdi dir="ltr">${escape(decimal)}&nbsp;${escape(m.currency)}</bdi>`;
}

function row(line: InvoiceLineDto, exponent: number): string {
  return `<tr>
  <td class="n idx"><bdi dir="ltr">${line.lineNo}</bdi></td>
  <td class="desc">${escape(line.description ?? "")}</td>
  <td class="n"><bdi dir="ltr">${escape(line.quantityText)}</bdi></td>
  <td class="unit">${escape(line.unitLabel ?? "")}</td>
  <td class="money">${printMoney(line.unitPrice, exponent)}</td>
  <td class="money">${printMoney(line.lineTotal, exponent)}</td>
</tr>`;
}

function identifierRows(view: InvoiceViewDto): string {
  const issuer = view.invoice.issuer;
  if (!issuer) return "";
  // 🔴 Three DIFFERENT identifiers, each under its own label. Printing them does NOT make this
  // invoice legally or tax compliant, and nothing here says it does.
  const pairs: Array<readonly [readonly [string, string], string | null]> = [
    [LABELS.taxpayer, issuer.taxpayerNumber],
    [LABELS.register, issuer.commercialRegister],
    [LABELS.vat, issuer.vatNumber],
  ];
  const present = pairs.filter(([, value]) => value !== null && value.trim() !== "");
  if (present.length === 0) return "";
  return `<div class="ids">${present
    .map(
      ([[ar, en], value]) =>
        `<span>${escape(ar)} / ${escape(en)}: <bdi dir="ltr">${escape(value!)}</bdi></span>`,
    )
    .join("")}</div>`;
}

export function renderInvoiceDocument(view: InvoiceViewDto, options: InvoiceDocumentOptions = {}): string {
  const inv = view.invoice;
  const issuer = inv.issuer;
  // LBP has no minor unit; the exponent decides how the stored integer prints.
  const exponent = inv.currency === "LBP" ? 0 : 2;
  const taxEnabled = inv.taxSnapshot?.enabled === true;
  const taxLabel = inv.taxSnapshot?.label ?? "ضريبة / Tax";

  const logo =
    options.logoUrl && options.logoUrl.trim() !== ""
      ? `<img class="logo" src="${escape(options.logoUrl)}" alt="" />`
      : "";

  const contact = [issuer?.address, issuer?.phone1, issuer?.phone2, issuer?.email]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => `<span><bdi>${escape(v)}</bdi></span>`)
    .join("");

  // 🔴 NO REDUNDANT GRAND TOTAL. With no tax and no discount, "Subtotal" and "Grand Total" are the
  // same number printed twice under two labels, which makes a reader look for the difference. When
  // there is nothing to add up, ONE total line prints, and it is the emphasised one. The moment the
  // shop configures a tax there genuinely are two numbers, and both print.
  const totals: string[] = [];
  if (taxEnabled) {
    totals.push(
      `<tr><th>${escape(LABELS.subtotal[0])} / ${escape(LABELS.subtotal[1])}</th><td>${printMoney(inv.subtotal, exponent)}</td></tr>`,
      // Tax prints only when the shop configured one. No rate is hard-coded anywhere in this build.
      `<tr><th>${escape(taxLabel)}</th><td>${printMoney(inv.tax, exponent)}</td></tr>`,
      `<tr class="grand"><th>${escape(LABELS.total[0])} / ${escape(LABELS.total[1])}</th><td>${printMoney(inv.total, exponent)}</td></tr>`,
    );
  } else {
    totals.push(
      `<tr class="grand"><th>${escape(LABELS.subtotal[0])} / ${escape(LABELS.subtotal[1])}</th><td>${printMoney(inv.total, exponent)}</td></tr>`,
    );
  }
  totals.push(
    `<tr class="paid"><th>${escape(LABELS.paid[0])} / ${escape(LABELS.paid[1])}</th><td>${printMoney(inv.paid, exponent)}</td></tr>`,
    // The one figure the customer acts on, so it is the one figure in red.
    `<tr class="balance"><th>${escape(LABELS.balance[0])} / ${escape(LABELS.balance[1])}</th><td>${printMoney(inv.balanceDue, exponent)}</td></tr>`,
  );

  return `<!doctype html>
<html lang="${options.language === "en" ? "en" : "ar"}" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${escape(LABELS.invoice[0])} ${inv.invoiceNumber ?? ""}</title>
<style>
  /* 🔴 EVERY COLOUR AND RULE HERE IS STRUCTURAL, NOT DECORATION. The template this follows uses a
     single red accent to carry the eye from the company name to the one figure the customer must
     act on (Balance Due), and black bars to separate the three regions a reader scans in order:
     who issued it, what it is, what it costs. Nothing below is tied to any one shop: the colours
     are the document's, the names and numbers all come from the frozen snapshot. */
  :root { --ink: #111; --accent: #c1121f; --rule: #9aa0a6; --soft: #f3f4f6; }
  @page { size: A4; margin: 13mm 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: "Segoe UI", "Tahoma", "Arial", sans-serif; font-size: 11pt;
    color: var(--ink); background: #fff;
    /* Print the backgrounds: a black bar with white labels is the design, and a viewer that
       strips backgrounds would render white-on-white. */
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { width: 100%; }
  /* The accent rule above the header: the first thing on the page, and the shop's own colour band. */
  .accent-bar { height: 3mm; background: var(--accent); margin-bottom: 3mm; }
  header { display: flex; align-items: flex-start; gap: 10mm; border-bottom: 3px solid var(--ink); padding-bottom: 4mm; }
  .issuer { flex: 1 1 auto; }
  /* A stronger company header, as the field asked: the name leads the page. */
  .issuer h1 { margin: 0 0 1mm; font-size: 22pt; line-height: 1.1; letter-spacing: -.2px; }
  .issuer .legal { font-size: 10pt; color: #333; font-weight: 600; }
  .issuer .tagline { font-size: 9.5pt; color: var(--accent); font-weight: 600; }
  .contact { margin-top: 2mm; font-size: 9pt; color: #444; display: flex; flex-wrap: wrap; gap: 0 4mm; }
  .ids { margin-top: 1.5mm; font-size: 8.5pt; color: #555; display: flex; flex-wrap: wrap; gap: 0 4mm; }
  .logo { max-height: 24mm; max-width: 44mm; object-fit: contain; }
  /* The black invoice bar. */
  .doctitle {
    margin: 4mm 0 3mm; padding: 2mm 4mm; background: var(--ink); color: #fff;
    font-size: 15pt; font-weight: 700; letter-spacing: .6px;
    display: flex; justify-content: space-between; align-items: baseline; gap: 6mm;
  }
  .doctitle .docnum { font-size: 12.5pt; font-weight: 600; }
  .meta, .customer { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
  .meta td, .customer td { padding: 1.4mm 2.5mm; }
  .meta th, .customer th { padding: 1.4mm 2.5mm; text-align: start; white-space: nowrap; color: #333; font-weight: 700; }
  /* The customer block: a boxed panel with a shaded label column, like the template's. */
  .customer { margin-top: 0; border: 1px solid var(--ink); }
  .customer th { background: var(--soft); width: 34mm; border-inline-end: 1px solid var(--rule); }
  .customer tr + tr th, .customer tr + tr td { border-top: 1px solid #dcdee1; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 10.5pt; }
  table.lines th, table.lines td { border: 1px solid var(--rule); padding: 1.8mm 2mm; vertical-align: top; }
  /* The black item header with white labels. */
  table.lines thead th {
    background: var(--ink); color: #fff; font-size: 9.5pt; text-align: center;
    border-color: var(--ink);
  }
  /* A banded body, so a 15-line invoice stays readable across a page break. */
  table.lines tbody tr:nth-child(even) td { background: #fafafa; }
  /* A row is never split across a page break, and the header repeats on every page. */
  table.lines tr { page-break-inside: avoid; break-inside: avoid; }
  table.lines thead { display: table-header-group; }
  table.lines tfoot { display: table-row-group; }
  td.n { text-align: center; width: 16mm; }
  td.idx { width: 9mm; color: #444; }
  td.unit { text-align: center; width: 22mm; }
  td.money { text-align: end; width: 28mm; white-space: nowrap; }
  td.desc { text-align: start; }
  /* The closing block never splits: words on one side, money on the other, balanced across A4. */
  .tail { margin-top: 4mm; display: flex; gap: 6mm; align-items: stretch; page-break-inside: avoid; break-inside: avoid; }
  .words { flex: 1 1 auto; border: 1px solid var(--rule); border-top: 3px solid var(--ink);
           padding: 3mm; font-size: 10.5pt; min-height: 20mm; }
  .words .words-label { font-size: 8.5pt; color: #666; font-weight: 700; display: block; margin-bottom: 1mm; }
  table.totals { border-collapse: collapse; min-width: 74mm; font-size: 10.5pt; }
  table.totals th { text-align: start; padding: 1.6mm 3mm; color: #333; font-weight: 600; white-space: nowrap; }
  table.totals td { text-align: end; padding: 1.6mm 3mm; white-space: nowrap; border-bottom: 1px solid #e3e5e8; }
  table.totals tr.grand th, table.totals tr.grand td {
    font-weight: 700; font-size: 12pt; background: var(--soft); border-top: 2px solid var(--ink);
    border-bottom: 1px solid var(--ink);
  }
  /* The red Balance Due row — the one number the customer acts on. */
  table.totals tr.balance th, table.totals tr.balance td {
    color: var(--accent); font-weight: 700; font-size: 12pt; border-bottom: 2px solid var(--accent);
  }
  footer { margin-top: 6mm; border-top: 3px solid var(--ink); padding-top: 2.5mm; font-size: 8.5pt; color: #555;
           display: flex; flex-wrap: wrap; justify-content: center; gap: 0 5mm; text-align: center; }
  .draft { color: var(--accent); font-weight: 700; }
</style>
</head>
<body>
<div class="sheet">
  <div class="accent-bar"></div>
  <header>
    <div class="issuer">
      <h1>${escape(issuer?.nameAr ?? "")}</h1>
      ${issuer?.nameEn ? `<div class="legal"><bdi dir="ltr">${escape(issuer.nameEn)}</bdi></div>` : ""}
      ${issuer?.legalName ? `<div class="legal">${escape(issuer.legalName)}</div>` : ""}
      ${issuer?.tagline ? `<div class="tagline">${escape(issuer.tagline)}</div>` : ""}
      ${contact ? `<div class="contact">${contact}</div>` : ""}
      ${identifierRows(view)}
    </div>
    ${logo}
  </header>

  <div class="doctitle">
    <span>${escape(LABELS.invoice[0])} &middot; <bdi dir="ltr">${escape(LABELS.invoice[1])}</bdi></span>
    <span class="docnum">${
      inv.invoiceNumber === null
        ? `<span class="draft">${escape("مسودة / DRAFT")}</span>`
        : `<bdi dir="ltr">#${inv.invoiceNumber}</bdi>`
    }</span>
  </div>

  <table class="meta"><tbody><tr>
    <th>${escape(LABELS.number[0])} / ${escape(LABELS.number[1])}</th>
    <td>${
      inv.invoiceNumber === null
        ? `<span class="draft">${escape("مسودة / DRAFT")}</span>`
        : `<bdi dir="ltr">#${inv.invoiceNumber}</bdi>`
    }</td>
    <th>${escape(LABELS.date[0])} / ${escape(LABELS.date[1])}</th>
    <td><bdi dir="ltr">${escape(inv.invoiceDate ?? "")}</bdi></td>
  </tr></tbody></table>

  <table class="customer"><tbody>
    <tr><th>${escape(LABELS.customer[0])} / ${escape(LABELS.customer[1])}</th><td>${escape(inv.customerName ?? "")}</td></tr>
    ${inv.customerAddress ? `<tr><th>${escape(LABELS.address[0])} / ${escape(LABELS.address[1])}</th><td>${escape(inv.customerAddress)}</td></tr>` : ""}
    ${inv.customerPhone ? `<tr><th>${escape(LABELS.phone[0])} / ${escape(LABELS.phone[1])}</th><td><bdi dir="ltr">${escape(inv.customerPhone)}</bdi></td></tr>` : ""}
    ${inv.notes ? `<tr><th>${escape(LABELS.notes[0])} / ${escape(LABELS.notes[1])}</th><td>${escape(inv.notes)}</td></tr>` : ""}
  </tbody></table>

  <table class="lines">
    <thead><tr>
      <th>${escape(LABELS.itemNo[0])}<br /><bdi dir="ltr">${escape(LABELS.itemNo[1])}</bdi></th>
      <th>${escape(LABELS.description[0])}<br /><bdi dir="ltr">${escape(LABELS.description[1])}</bdi></th>
      <th>${escape(LABELS.qty[0])}<br /><bdi dir="ltr">${escape(LABELS.qty[1])}</bdi></th>
      <th>${escape(LABELS.unit[0])}<br /><bdi dir="ltr">${escape(LABELS.unit[1])}</bdi></th>
      <th>${escape(LABELS.unitPrice[0])}<br /><bdi dir="ltr">${escape(LABELS.unitPrice[1])}</bdi></th>
      <th>${escape(LABELS.lineTotal[0])}<br /><bdi dir="ltr">${escape(LABELS.lineTotal[1])}</bdi></th>
    </tr></thead>
    <tbody>
${view.lines.map((l) => row(l, exponent)).join("\n")}
    </tbody>
  </table>

  <div class="tail">
    <div class="words">
      <span class="words-label">${escape("المبلغ كتابةً")} / <bdi dir="ltr">${escape("Amount in words")}</bdi></span>
      ${escape(inv.amountInWords ?? "")}
    </div>
    <table class="totals"><tbody>
${totals.join("\n")}
    </tbody></table>
  </div>

  <footer>
    ${issuer?.address ? `<span>${escape(issuer.address)}</span>` : ""}
    ${issuer?.phone1 ? `<span><bdi dir="ltr">${escape(issuer.phone1)}</bdi></span>` : ""}
    ${issuer?.phone2 ? `<span><bdi dir="ltr">${escape(issuer.phone2)}</bdi></span>` : ""}
    ${issuer?.email ? `<span><bdi dir="ltr">${escape(issuer.email)}</bdi></span>` : ""}
  </footer>
</div>
</body>
</html>`;
}
