/**
 * The printed invoice. `renderInvoiceDocument` is a pure function of the FROZEN DTO, so these tests
 * build real invoices through the real service and render what the printer would receive.
 *
 * What is NOT asserted here: pixel layout and real pagination, which need a browser engine. Those
 * belong to the Windows E2E pass. What IS asserted is everything that can be: every line present,
 * the frozen snapshot used, free text escaped, the bidi isolation, and the CSS that governs page
 * breaks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escape, printMoney, renderInvoiceDocument } from "../../src/main/invoiceDocument";
import { toInvoiceViewDto } from "../../src/shared/dto";
import type { InvoiceViewDto } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

const PROFILE = {
  nameAr: "متجر اختباري",
  nameEn: "Test Store",
  address: "شارع الاختبار، بيروت",
  phone1: "01-000000",
  phone2: "03-111111",
  email: "shop@example.test",
  taxpayerNumber: "TP-1",
  commercialRegister: "CR-2",
  vatNumber: "VAT-3",
};

/** A finalized invoice, rendered through the real pipeline. */
function finalized(
  lines: ReadonlyArray<{ description: string; unitLabel?: string | null; quantity: string; unitPrice: string }>,
  opts: { profile?: Record<string, unknown>; customer?: string; paid?: string } = {},
): InvoiceViewDto {
  h.invoices.saveCompanyProfile({ ...PROFILE, ...opts.profile });
  const { invoice } = h.invoices.createDraft();
  for (const l of lines) {
    h.invoices.addLine(invoice.id, {
      description: l.description,
      unitLabel: l.unitLabel === undefined ? "حبة" : l.unitLabel,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
    });
  }
  h.invoices.updateDraftHeader(invoice.id, {
    customerName: opts.customer ?? "زبون اختباري",
    customerAddress: "عنوان الزبون",
    customerPhone: "70-123456",
    notes: "ملاحظة",
    paid: opts.paid ?? null,
  });
  return toInvoiceViewDto(h.invoices.finalizeInvoice(invoice.id));
}

/**
 * Rows in the LINE-ITEM table specifically.
 *
 * 🔴 The first version of this helper matched the first `<tbody>` in the document, which is the
 * invoice-meta table's — so it counted the meta and customer rows too and reported 20 for a
 * 15-line invoice. The instrument was wrong, not the renderer. It now anchors on the lines table.
 */
const bodyRows = (html: string) => {
  const table = /<table class="lines">([\s\S]*?)<\/table>/.exec(html);
  if (!table) throw new Error("no line-item table in the rendered document");
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(table[1]!);
  if (!tbody) throw new Error("no tbody in the line-item table");
  return (tbody[1]!.match(/<tr>/g) ?? []).length;
};

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("the document carries every line", () => {
  it("includes all 15 lines of a reference-sized invoice, in order", () => {
    const lines = Array.from({ length: 15 }, (_, i) => ({
      description: `صنف رقم ${i + 1}`,
      quantity: String(i + 1),
      unitPrice: "2.00",
    }));
    const html = renderInvoiceDocument(finalized(lines));
    expect(bodyRows(html)).toBe(15);
    for (let i = 1; i <= 15; i += 1) expect(html).toContain(`صنف رقم ${i}`);
    // The line numbers are the stored ones, printed in order.
    //
    // 🔴 This targets `td.idx`, the item-number cell. An earlier version matched `td.n`, which the
    // quantity column also carries — so it read every number twice and the failure looked like a
    // duplicated row. The item-number cell was given its own class so the two cannot be confused.
    const numbers = [...html.matchAll(/<td class="n idx"><bdi dir="ltr">(\d+)<\/bdi><\/td>/g)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it("includes all 120 lines of an invoice long enough to force several pages", () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({
      description: `بند طويل للاختبار رقم ${i + 1}`,
      quantity: "1.5",
      unitPrice: "3.33",
    }));
    const view = finalized(lines);
    const html = renderInvoiceDocument(view);
    // 🔴 Not one line may be dropped by the renderer. This is the assertion that a missing row is a
    // test failure rather than something a reader of the PDF has to notice.
    expect(bodyRows(html)).toBe(120);
    expect(view.lines).toHaveLength(120);
    expect(html).toContain("بند طويل للاختبار رقم 1<");
    expect(html).toContain("بند طويل للاختبار رقم 120<");
  });

  it("the CSS that governs pagination is present and says what it must", () => {
    const html = renderInvoiceDocument(finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }]));
    expect(html).toContain("@page { size: A4;");
    // A row is never split across a page boundary...
    expect(html).toMatch(/table\.lines tr \{[^}]*page-break-inside: avoid/);
    expect(html).toMatch(/table\.lines tr \{[^}]*break-inside: avoid/);
    // ...the column headers repeat on every page...
    expect(html).toMatch(/table\.lines thead \{ display: table-header-group/);
    // ...and the totals block stays together rather than being orphaned.
    expect(html).toMatch(/\.tail \{[^}]*page-break-inside: avoid/);
  });
});

describe("the document uses the FROZEN snapshot, never live data", () => {
  it("a later company-profile change does not alter the rendered invoice", () => {
    const view = finalized([{ description: "صنف", quantity: "1", unitPrice: "10.00" }]);
    const before = renderInvoiceDocument(view);

    h.invoices.saveCompanyProfile({ ...PROFILE, nameAr: "اسم جديد", phone1: "09-999999", vatNumber: "VAT-NEW" });

    // Re-read the invoice from the database — not the DTO held in memory — and render again.
    const after = renderInvoiceDocument(toInvoiceViewDto(h.invoices.getInvoice(view.invoice.id)));
    expect(after).toBe(before);
    expect(after).toContain("متجر اختباري");
    expect(after).not.toContain("اسم جديد");
    expect(after).toContain("VAT-3");
    expect(after).not.toContain("VAT-NEW");
  });

  it("a later catalog change does not alter the rendered invoice", () => {
    const product = h.service.createProduct({
      nameAr: "مفك براغي",
      nameEn: null,
      sku: null,
      price: "5.00",
      baseUnit: "piece",
    });
    const view = finalized([{ description: "مفك براغي", quantity: "2", unitPrice: "5.00" }]);
    const before = renderInvoiceDocument(view);

    h.service.updateProduct(
      product.id,
      { nameAr: "مفك براغي جديد", nameEn: null, sku: null, price: "99.00", baseUnit: "kg" },
      true,
    );

    const after = renderInvoiceDocument(toInvoiceViewDto(h.invoices.getInvoice(view.invoice.id)));
    expect(after).toBe(before);
    expect(after).toContain("مفك براغي<");
    expect(after).not.toContain("مفك براغي جديد");
    expect(after).toContain("5.00");
    expect(after).not.toContain("99.00");
  });

  it("the function cannot reach live data: it takes the DTO and nothing else", () => {
    const view = finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }]);
    // Rendering the same DTO twice is byte-identical, and rendering it needs no database at all —
    // which is why a reprint six weeks later cannot drift.
    expect(renderInvoiceDocument(view)).toBe(renderInvoiceDocument(view));
    expect(renderInvoiceDocument.length).toBeLessThanOrEqual(2);
  });
});

describe("totals, words and the official identifiers", () => {
  it("prints the frozen total and the frozen amount in words", () => {
    const view = finalized([{ description: "صنف", quantity: "1", unitPrice: "474.40" }]);
    const html = renderInvoiceDocument(view);
    expect(view.invoice.amountInWords).toBe("فقط أربعمئة وأربعة وسبعون دولاراً وأربعون سنتاً لا غير");
    expect(html).toContain("فقط أربعمئة وأربعة وسبعون دولاراً وأربعون سنتاً لا غير");
    expect(html).toContain("474.40");
  });

  it("omits the tax row entirely when the shop configured no tax", () => {
    const html = renderInvoiceDocument(finalized([{ description: "صنف", quantity: "1", unitPrice: "10.00" }]));
    // The totals block holds exactly four rows: subtotal, grand total, paid, balance due.
    const totals = /<table class="totals">([\s\S]*?)<\/table>/.exec(html)![1]!;
    expect((totals.match(/<tr/g) ?? []).length).toBe(4);
    expect(totals).not.toMatch(/ضريبة|\bTax\b/);
    expect(totals).toContain("Grand Total");
    // 🔴 "Taxpayer No." is NOT a tax row — the first version of this assertion used /Tax/ against
    // the whole document and caught the identifier label. The identifier still prints.
    expect(html).toContain("Taxpayer No.");
  });

  it("prints the shop's own tax label and amount when it configured one", () => {
    const view = finalized([{ description: "صنف", quantity: "1", unitPrice: "100.00" }], {
      profile: { taxEnabled: true, taxRatePercent: "11", taxLabel: "ض.ق.م 11%" },
    });
    const html = renderInvoiceDocument(view);
    expect(html).toContain("ض.ق.م 11%");
    expect(view.invoice.tax).toEqual({ minor: "1100", currency: "USD" });
    expect(html).toContain("111.00"); // 100.00 + 11.00
  });

  it("prints paid and balance due as fields on the document", () => {
    const view = finalized([{ description: "صنف", quantity: "1", unitPrice: "100.00" }], { paid: "40.00" });
    const html = renderInvoiceDocument(view);
    expect(view.invoice.balanceDue).toEqual({ minor: "6000", currency: "USD" });
    expect(html).toContain("Balance Due");
    expect(html).toContain("60.00");
  });

  it("prints each official identifier under its OWN label, and only the ones that exist", () => {
    const both = renderInvoiceDocument(finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }]));
    expect(both).toContain("Taxpayer No.");
    expect(both).toContain("Comm. Register");
    expect(both).toContain("VAT Reg. No.");
    // 🔴 Three labels, three values — never one identifier printed under another's heading.
    expect(both).toMatch(/Taxpayer No\.[^<]*<bdi dir="ltr">TP-1/);
    expect(both).toMatch(/Comm\. Register[^<]*<bdi dir="ltr">CR-2/);
    expect(both).toMatch(/VAT Reg\. No\.[^<]*<bdi dir="ltr">VAT-3/);

    const onlyVat = renderInvoiceDocument(
      finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }], {
        profile: { taxpayerNumber: null, commercialRegister: null },
      }),
    );
    expect(onlyVat).not.toContain("Taxpayer No.");
    expect(onlyVat).toContain("VAT Reg. No.");
  });

  it("claims nothing about legal or tax compliance anywhere on the page", () => {
    const html = renderInvoiceDocument(
      finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }], {
        profile: { taxEnabled: true, taxRatePercent: "11", taxLabel: "VAT 11%" },
      }),
    );
    expect(html).not.toMatch(/compliant|compliance|قانونية|مطابقة للقانون/i);
  });
});

describe("right-to-left correctness", () => {
  it("the page is RTL and every numeric run is isolated left-to-right", () => {
    const view = finalized([{ description: "مفك براغي Phillips", unitLabel: "حبة", quantity: "2.5", unitPrice: "3.75" }]);
    const html = renderInvoiceDocument(view);
    expect(html).toContain('<html lang="ar" dir="rtl">');

    // 🔴 Why the isolate matters, not just that it is there: in an RTL paragraph the bidi algorithm
    // can reorder a run like "9.38 USD" so the currency lands on the wrong side of the number, and
    // the reader sees something other than what is stored. Each run is pinned.
    expect(html).toContain('<bdi dir="ltr">2.5</bdi>');
    expect(html).toContain('<bdi dir="ltr">3.75&nbsp;USD</bdi>');
    expect(html).toContain('<bdi dir="ltr">9.38&nbsp;USD</bdi>'); // 2.5 x 3.75 = 9.375 -> 9.38 half up
    expect(html).toMatch(/<bdi dir="ltr">#\d+<\/bdi>/); // the invoice number
    expect(html).toMatch(/<bdi dir="ltr">2026-\d{2}-\d{2}<\/bdi>/); // the date
    expect(html).toContain('<bdi dir="ltr">70-123456</bdi>'); // the customer's phone
    expect(html).toContain('<bdi dir="ltr">01-000000</bdi>'); // the shop's phone

    // Mixed Latin inside Arabic free text keeps the operator's own words untouched.
    expect(html).toContain("مفك براغي Phillips");
  });

  it("the column headers are bilingual, with the English run isolated", () => {
    const html = renderInvoiceDocument(finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }]));
    for (const [ar, en] of [
      ["البيان", "Description"],
      ["الكمية", "QTY"],
      ["الوحدة", "Unit"],
      ["سعر الوحدة", "Unit Price"],
    ]) {
      expect(html).toContain(ar);
      expect(html).toContain(`<bdi dir="ltr">${en}</bdi>`);
    }
  });
});

describe("the renderer is safe with text an operator typed", () => {
  it("escapes HTML in a description, a customer name and the notes", () => {
    const view = finalized([{ description: '<script>alert(1)</script> & "quoted"', quantity: "1", unitPrice: "1.00" }], {
      customer: "<b>زبون</b>",
    });
    const html = renderInvoiceDocument(view);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("&lt;b&gt;زبون&lt;/b&gt;");
  });

  it("escapes a logo URL rather than interpolating it raw", () => {
    const view = finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }]);
    const html = renderInvoiceDocument(view, { logoUrl: 'x" onerror="alert(1)' });
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot; onerror=&quot;");
  });

  it("prints no logo element at all when none is configured", () => {
    const html = renderInvoiceDocument(finalized([{ description: "صنف", quantity: "1", unitPrice: "1.00" }]));
    expect(html).not.toContain("<img");
  });

  it("escape() and printMoney() are exact", () => {
    expect(escape("<a>&\"'")).toBe("&lt;a&gt;&amp;&quot;&#39;");
    expect(printMoney({ minor: "47440", currency: "USD" })).toBe('<bdi dir="ltr">474.40&nbsp;USD</bdi>');
    expect(printMoney({ minor: "5", currency: "USD" })).toBe('<bdi dir="ltr">0.05&nbsp;USD</bdi>');
    expect(printMoney({ minor: "0", currency: "USD" })).toBe('<bdi dir="ltr">0.00&nbsp;USD</bdi>');
    // LBP has no minor unit, so the stored integer prints as whole currency.
    expect(printMoney({ minor: "150000", currency: "LBP" }, 0)).toBe('<bdi dir="ltr">150000&nbsp;LBP</bdi>');
  });
});

describe("a draft is never printed as though it were issued", () => {
  it("renders a visible DRAFT marker instead of inventing a number", () => {
    h.invoices.saveCompanyProfile(PROFILE);
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", quantity: "1", unitPrice: "1.00" });
    const html = renderInvoiceDocument(toInvoiceViewDto(h.invoices.getInvoice(invoice.id)));
    expect(html).toContain("مسودة / DRAFT");
    expect(html).not.toMatch(/<bdi dir="ltr">#\d+<\/bdi>/);
    // The IPC layer refuses to print this at all; the renderer is honest about it regardless.
  });
});
