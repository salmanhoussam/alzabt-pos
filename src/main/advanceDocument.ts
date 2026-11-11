/**
 * The printed ADV- receipt (customer advance, migration 20) — one pure function from DTOs the main
 * process read from the ledger to a small A5 HTML document. Same rules as the invoice document:
 *
 * 🔴 IT TAKES LEDGER DTOs AND NOTHING ELSE. Main loads the advance BY ID; the renderer has no channel
 *    that carries markup. Every interpolated value goes through `escape()`.
 * 🔴 IT SAYS WHAT THE MONEY IS. An advance is not a sale and settles no debt (D2/D8); the receipt
 *    says so in both languages. A CORRECTION document says, just as plainly, that it is NOT a new
 *    receipt of money and names the original it restates; a corrected original is stamped with how
 *    it was corrected — never silently reprinted as if it were still live.
 *
 * Pure (no Electron import), so it is tested in plain Node.
 */
import type { AdvanceCorrectionDto, AdvanceDto } from "../shared/ipcContract";
import { escape, printMoney } from "./invoiceDocument";

export interface AdvanceDocumentInput {
  readonly advance: AdvanceDto;
  readonly correction: AdvanceCorrectionDto | null;
  /** The shop's name for the header, or null (then the header carries only the document title). */
  readonly shopName: string | null;
  /** The terminal's IANA zone (e.g. Asia/Beirut). Absent prints the stored instant in UTC, labelled. */
  readonly timeZone?: string;
}

const t = (ar: string, en: string) => `${escape(ar)} <span class="en">${escape(en)}</span>`;

/** The stored instant in the terminal's zone (`2026-10-04 12:00`), or in UTC labelled as such. */
function instantIn(iso: string, timeZone: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (!timeZone) return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function renderAdvanceDocument(input: AdvanceDocumentInput): string {
  const instant = (iso: string) => instantIn(iso, input.timeZone);
  const a = input.advance;
  const c = input.correction;
  const method =
    a.channel === "whish"
      ? `${t("ويش موني", "Whish Money")} · <bdi dir="ltr">${escape(a.reference ?? "")}</bdi>`
      : t("نقداً", "Cash");
  const rows: string[] = [
    `<tr><th>${t("رقم الإيصال", "Receipt no.")}</th><td><bdi dir="ltr" data-field="number">${escape(a.number)}</bdi></td></tr>`,
    `<tr><th>${t("الزبون", "Customer")}</th><td><bdi>${escape(a.customerName)}</bdi></td></tr>`,
    `<tr><th>${t("المبلغ", "Amount")}</th><td class="amount" data-field="amount">${printMoney(a.amount)}</td></tr>`,
    `<tr><th>${t("طريقة القبض", "Received by")}</th><td>${method}</td></tr>`,
    `<tr><th>${t("المستلم", "Received by (staff)")}</th><td><bdi>${escape(a.receivedByName)}</bdi></td></tr>`,
    `<tr><th>${t("تاريخ القبض", "Received at")}</th><td><bdi dir="ltr">${escape(instant(a.receivedAt))}</bdi></td></tr>`,
  ];
  const notes: string[] = [];
  if (a.origin === "correction") {
    notes.push(
      `<p class="banner correction" data-field="correction-of">${t(
        `إيصال تصحيح لـ${a.correctsNumber ?? "—"} — ليس قبضاً جديداً. قُبض المبلغ أصلاً بتاريخ ${instant(a.receivedAt)}.`,
        `Correction of ${a.correctsNumber ?? "—"} — NOT a new receipt of money. Originally received ${instant(a.receivedAt)}.`,
      )}</p>`,
    );
  }
  if (c) {
    const what =
      c.kind === "not_received"
        ? t("مصحَّح — لم يُقبض المبلغ", "CORRECTED — the money was not received")
        : t(`مصحَّح ← ${c.successorNumber ?? "—"}`, `CORRECTED → ${c.successorNumber ?? "—"}`);
    notes.push(
      `<p class="banner stamp" data-field="corrected">${what}<br>${t("السبب", "Reason")}: <bdi>${escape(c.reason)}</bdi> · <bdi>${escape(
        c.correctedByName,
      )}</bdi> · <bdi dir="ltr">${escape(instant(c.correctedAt))}</bdi></p>`,
    );
  }
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(a.number)}</title>
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
  .stamp { border-style: dashed; }
  .foot { font-size: 9pt; color: #333; margin-top: 4mm; }
</style></head>
<body>
${input.shopName ? `<div class="shop"><bdi>${escape(input.shopName)}</bdi></div>` : ""}
<h1>${t("إيصال دفعة مسبقة", "Customer advance receipt")}</h1>
${notes.join("\n")}
<table>${rows.join("")}</table>
<p class="foot">${t(
    "دفعة مسبقة على حساب الزبون — ليست فاتورة بيع ولا تسديداً لدين.",
    "An advance held for the customer — not a sale and not a debt payment.",
  )}</p>
</body></html>`;
}
