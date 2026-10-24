/**
 * What the Finalize confirmation shows must be what finalization stores.
 *
 * The confirmation renders the stored invoice. Total = subtotal + tax, and the tax rate is applied
 * only when its field loses focus, so a rate still being typed is NOT on the document. These tests
 * pin the figures the confirmation reads (after rows → tax → header are stored) against the
 * finalized invoice, and show what the old ordering displayed.
 *
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let keySeq = 0;
const nextKey = () => `batch-test-${++keySeq}-key`;


beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  h.service.login("cashier-01", "1111");
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const LINE = { description: "صنف", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "100.00" };
const shown = (id: string) => h.invoices.getInvoice(id).invoice;

describe("the confirmation figures", () => {
  it("🔴 with the rate stored first, the displayed total equals the finalized total", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [LINE], nextKey());
    h.invoices.setInvoiceTax(invoice.id, { enabled: true, ratePercent: "11" });
    h.invoices.updateDraftHeader(invoice.id, { customerName: "زبون", paid: "50.00" });

    const displayed = shown(invoice.id);
    const final = h.invoices.finalizeInvoice(invoice.id).invoice;

    expect(displayed.total_minor).toBe(11_100n);
    expect(final.total_minor).toBe(displayed.total_minor);
    expect(final.paid_minor).toBe(displayed.paid_minor);
    expect(final.balance_due_minor).toBe(displayed.balance_due_minor);
    expect(final.customer_name).toBe(displayed.customer_name);
  });

  it("🔴 REPRODUCES THE STALE ORDER: a rate applied only after the dialog was drawn changes the total", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [LINE], nextKey());
    h.invoices.setInvoiceTax(invoice.id, { enabled: true, ratePercent: "0" });

    const displayedBeforeBlur = shown(invoice.id).total_minor; // what the dialog would have shown
    h.invoices.setInvoiceTax(invoice.id, { enabled: true, ratePercent: "11" }); // the blur lands late
    const final = h.invoices.finalizeInvoice(invoice.id).invoice;

    expect(displayedBeforeBlur).toBe(10_000n);
    expect(final.total_minor).toBe(11_100n); // it differed
  });

  it("a header refusal leaves the draft as it was — nothing is finalized", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [LINE], nextKey());
    expect(() => h.invoices.updateDraftHeader(invoice.id, { paid: "500.00" })).toThrow(DomainError);
    const row = shown(invoice.id);
    expect(row.status).toBe("draft");
    expect(row.paid_minor).toBe(0n);
    expect(row.total_minor).toBe(10_000n);
  });
});
