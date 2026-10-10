/**
 * `addLines` — several typed rows committed as ONE unit.
 *
 * 🔴 THE FIELD DEFECT THIS CONTRACT EXISTS FOR (2026-10-10, real installed `ce4dd28`). The sheet
 * held exactly one unsaved row and disabled "+ Add Row" until it was saved, so entering a five-item
 * invoice meant five save round-trips. The row model was always a renderer concern — nothing in the
 * service or the repository required it — but fixing the renderer alone would have meant looping
 * `addLine`, which is one transaction per row: a refusal on row 4 would commit rows 1-3 and lose
 * the rest. These tests are about that seam, not about the UI.
 *
 * Every description, unit and price here is SYNTHETIC. No merchant data is in this repository.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { MAX_INVOICE_LINES } from "../../src/domain/invoice";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";
import type { Harness } from "../helpers/harness";

let t: TempDir;
let h: Harness;

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const row = (description: string, quantity: string, unitPrice: string) => ({
  description,
  unitLabel: "حبة",
  canonicalUnit: null,
  productId: null,
  quantity,
  unitPrice,
});

const countLines = (invoiceId: string) =>
  Number((h.db.prepare("SELECT count(*) AS c FROM invoice_lines WHERE invoice_id = ?").get(invoiceId) as { c: bigint }).c);

describe("adding several rows at once", () => {
  it("writes every row and numbers them in the order they were typed", () => {
    const { invoice } = h.invoices.createDraft();
    const view = h.invoices.addLines(invoice.id, [
      row("صنف أوّل", "2", "10.00"),
      row("صنف ثانٍ", "1", "5.50"),
      row("صنف ثالث", "3", "1.00"),
    ]);

    expect(view.lines.map((l) => l.description)).toEqual(["صنف أوّل", "صنف ثانٍ", "صنف ثالث"]);
    expect(view.lines.map((l) => l.line_no)).toEqual([1n, 2n, 3n]);
  });

  it("rewrites the totals ONCE, from the rows the database actually holds", () => {
    const { invoice } = h.invoices.createDraft();
    // 2×10.00 + 1×5.50 + 3×1.00 = 28.50
    const view = h.invoices.addLines(invoice.id, [
      row("صنف أوّل", "2", "10.00"),
      row("صنف ثانٍ", "1", "5.50"),
      row("صنف ثالث", "3", "1.00"),
    ]);
    expect(view.invoice.subtotal_minor).toBe(2850n);
    expect(view.invoice.total_minor).toBe(2850n);
  });

  it("appends after rows that are already on the invoice, without disturbing them", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, row("صنف محفوظ", "1", "7.00"));
    const view = h.invoices.addLines(invoice.id, [row("صنف جديد", "1", "3.00")]);

    expect(view.lines.map((l) => l.description)).toEqual(["صنف محفوظ", "صنف جديد"]);
    expect(view.lines.map((l) => l.line_no)).toEqual([1n, 2n]);
    expect(view.invoice.total_minor).toBe(1000n);
  });

  it("🔴 ALL OR NOTHING — one bad row commits none of them", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, row("صنف محفوظ", "1", "7.00"));

    // Row 3 carries a price the domain refuses. Rows 1 and 2 are perfectly valid, and that is the
    // point: a loop of addLine would already have written them by the time row 3 was reached.
    expect(() =>
      h.invoices.addLines(invoice.id, [
        row("صنف أوّل", "1", "1.00"),
        row("صنف ثانٍ", "1", "2.00"),
        row("صنف فاسد", "1", "not-a-price"),
      ]),
    ).toThrow(DomainError);

    // The invoice is exactly as it was: the one previously saved line, and its total.
    expect(countLines(invoice.id)).toBe(1);
    const after = h.invoices.getInvoice(invoice.id);
    expect(after.invoice.total_minor).toBe(700n);
  });

  it("🔴 refuses a batch that would cross the line ceiling, counting what is already there", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, row("صنف محفوظ", "1", "1.00"));

    // One existing line + MAX rows is one too many. The ceiling is checked against the SUM, not
    // against the batch alone — checking the batch alone would let two batches walk past it.
    const many = Array.from({ length: MAX_INVOICE_LINES }, (_, i) => row(`صنف ${i}`, "1", "1.00"));
    expect(() => h.invoices.addLines(invoice.id, many)).toThrow(DomainError);
    expect(countLines(invoice.id)).toBe(1);
  });

  it("refuses to add rows to an invoice that is already final", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
    h.invoices.addLine(invoice.id, row("صنف اختباري", "1", "10.00"));
    h.invoices.finalizeInvoice(invoice.id);

    expect(() => h.invoices.addLines(invoice.id, [row("صنف متأخّر", "1", "1.00")])).toThrow(DomainError);
    expect(countLines(invoice.id)).toBe(1);
  });
});
