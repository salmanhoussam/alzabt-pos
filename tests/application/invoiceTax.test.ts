/**
 * Per-invoice tax: the rate belongs to ONE document, and cannot leak into the next one.
 *
 * 🔴 WHY THIS EXISTS. Tax used to be read from `company_profile` at finalization, so issuing a
 * single taxed invoice meant switching a GLOBAL setting on, finalizing, and switching it off —
 * and anything finalized in between silently inherited the wrong state. An invoice now carries its
 * own answer from the moment the operator sets it.
 *
 * No migration was needed, and that was measured: migration 6 declares `tax_snapshot_json` nullable
 * with only a json-object CHECK, and the "what being FINAL means" CHECK does not list it. A draft
 * may legitimately hold its tax state in the same column that freezes it.
 *
 * Synthetic data only. No rate is hard-coded in the product — every one below is typed by the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

const LINE = { description: "صنف اختباري", unitLabel: "حبة", quantity: "1", unitPrice: "100.00", productId: null };

function draft(): string {
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLine(invoice.id, LINE);
  return invoice.id;
}

const inv = (id: string) => h.invoices.getInvoice(id).invoice;

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

describe("tax belongs to one invoice", () => {
  it("a draft starts untaxed when the shop has no tax configured", () => {
    const id = draft();
    expect(inv(id).tax_minor).toBe(0n);
    expect(inv(id).total_minor).toBe(10_000n);
  });

  it("switching tax on recomputes this invoice, by exact basis points", () => {
    const id = draft();
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "11" });
    const row = inv(id);
    // 100.00 at 11% = 11.00 exactly. 10000 * 1100 / 10000 = 1100, integer throughout.
    expect(row.subtotal_minor).toBe(10_000n);
    expect(row.tax_minor).toBe(1_100n);
    expect(row.total_minor).toBe(11_100n);
    expect(JSON.parse(row.tax_snapshot_json!)).toEqual({ enabled: true, rate_basis_points: 1100, label: null });
  });

  it("a fractional rate stays exact — 11.5% is 1150 basis points, never a float", () => {
    const id = draft();
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "11.5" });
    expect(JSON.parse(inv(id).tax_snapshot_json!).rate_basis_points).toBe(1150);
    expect(inv(id).tax_minor).toBe(1_150n);
  });

  it("switching tax back off restores the untaxed totals", () => {
    const id = draft();
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "11" });
    expect(inv(id).total_minor).toBe(11_100n);
    h.invoices.setInvoiceTax(id, { enabled: false });
    const row = inv(id);
    expect(row.tax_minor).toBe(0n);
    expect(row.total_minor).toBe(10_000n);
    expect(JSON.parse(row.tax_snapshot_json!).enabled).toBe(false);
  });

  it("🔴 NO LEAKAGE: a taxed invoice does not make the NEXT invoice taxed", () => {
    const taxed = draft();
    h.invoices.setInvoiceTax(taxed, { enabled: true, ratePercent: "11" });
    h.invoices.finalizeInvoice(taxed);

    const next = draft();
    expect(inv(next).tax_minor, "the next invoice inherited tax").toBe(0n);
    expect(inv(next).total_minor).toBe(10_000n);
    h.invoices.finalizeInvoice(next);
    expect(inv(next).tax_minor).toBe(0n);

    // And the first one still holds its own rate, untouched by the second.
    expect(inv(taxed).tax_minor).toBe(1_100n);
    expect(JSON.parse(inv(taxed).tax_snapshot_json!).rate_basis_points).toBe(1100);
  });

  it("🔴 NO LEAKAGE in the other direction either: two different rates, side by side", () => {
    const a = draft();
    h.invoices.setInvoiceTax(a, { enabled: true, ratePercent: "11" });
    const b = draft();
    h.invoices.setInvoiceTax(b, { enabled: true, ratePercent: "5" });
    const c = draft(); // never touched: stays untaxed

    h.invoices.finalizeInvoice(a);
    h.invoices.finalizeInvoice(b);
    h.invoices.finalizeInvoice(c);

    expect(inv(a).tax_minor).toBe(1_100n);
    expect(inv(b).tax_minor).toBe(500n);
    expect(inv(c).tax_minor).toBe(0n);
  });

  it("the rate is FROZEN at finalization and survives a later change to the shop setting", () => {
    const id = draft();
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "11" });
    h.invoices.finalizeInvoice(id);

    // The shop later configures a completely different tax. The issued document does not move.
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", taxEnabled: true, taxRatePercent: "20", taxLabel: "VAT" });
    const row = inv(id);
    expect(row.tax_minor).toBe(1_100n);
    expect(row.total_minor).toBe(11_100n);
    expect(JSON.parse(row.tax_snapshot_json!).rate_basis_points).toBe(1100);
  });

  it("a finalized invoice refuses a tax change", () => {
    const id = draft();
    h.invoices.finalizeInvoice(id);
    expect(() => h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "11" })).toThrow(DomainError);
    expect(inv(id).tax_minor).toBe(0n);
  });

  it("an unusable rate is refused, and the invoice is left alone", () => {
    const id = draft();
    for (const bad of ["", "abc", "-5", "101", "11.555"]) {
      expect(() => h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: bad }), bad).toThrow(DomainError);
    }
    expect(inv(id).tax_minor).toBe(0n);
    expect(inv(id).tax_snapshot_json).toBeNull();
  });

  it("a draft with no tax state of its own still follows the shop setting", () => {
    // Backwards compatibility: a draft created before per-invoice tax existed has a null snapshot,
    // and must behave exactly as it did yesterday.
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", taxEnabled: true, taxRatePercent: "11", taxLabel: "VAT" });
    const id = draft();
    expect(inv(id).tax_snapshot_json).toBeNull();
    h.invoices.finalizeInvoice(id);
    expect(inv(id).tax_minor).toBe(1_100n);
  });

  it("the sale created from a taxed invoice carries the same frozen tax", () => {
    const id = draft();
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "11" });
    h.invoices.finalizeInvoice(id);
    const sale = h.invoices.saleForInvoice(id)!;
    expect(sale.tax.minor).toBe(1_100n);
    expect(sale.subtotal.minor).toBe(10_000n);
    expect(sale.total.minor).toBe(11_100n);
    expect(sale.total.minor).toBe(sale.subtotal.minor + sale.tax.minor);
  });
});
