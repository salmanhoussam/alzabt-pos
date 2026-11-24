/**
 * CURRENCY-P1 — Workstream C: a currency mismatch between an invoice and the terminal / catalog / a product is REFUSED
 * before anything is written, and never relabels one currency's minor units as another's.
 *
 * SYNTHETIC ONLY. The shipped terminal is fixed to USD (`src/fixtures/terminal.ts`), so a mismatch cannot arise through
 * the product's own entry points today; it arises in a restored or synthetic ledger. The harness takes the terminal
 * configuration BY REFERENCE, so switching `terminal.currency` between steps reproduces exactly that state — a document
 * written under one currency, acted on under another — without touching the schema, a trigger or any stored row.
 *
 * Each refusal test asserts, in this order: the code (`MIXED_CURRENCY`, the existing code every mismatch site uses),
 * that NOTHING changed (rows counted / values re-read), and a positive control that the same action succeeds once the
 * currencies agree — so the refusal is proven to be caused by the mismatch and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
const terminal = { currency: "USD", timeZone: "Asia/Beirut" };

beforeEach(() => {
  terminal.currency = "USD";
  t = tempDir();
  h = makeHarness(t.dbPath, { terminal });
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
});
afterEach(() => {
  terminal.currency = "USD";
  h.db.close();
  t.cleanup();
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "NO-THROW";
  } catch (e) {
    return e instanceof DomainError ? e.code : `OTHER:${String(e)}`;
  }
};
const count = (table: string): number =>
  Number((h.db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);
const product = (nameAr: string, price: string) =>
  h.service.createProduct({ nameAr, nameEn: null, sku: null, price, baseUnit: "piece" });
const line = (unitPrice: string, extra: { description?: string; productId?: string | null } = {}) => ({
  description: extra.description ?? "صنف اختباري",
  unitLabel: "حبة",
  productId: extra.productId ?? null,
  quantity: "1",
  unitPrice,
});

describe("finalize: an invoice is issued only in the terminal's currency", () => {
  it("refuses a draft whose currency differs from the terminal — still a draft, no number, no sale, no review row", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, line("5.00"));
    const before = { sales: count("sales"), reconciliation: count("invoice_reconciliation"), audit: h.audit.count() };

    terminal.currency = "LBP";
    expect(codeOf(() => h.invoices.finalizeInvoice(invoice.id))).toBe("MIXED_CURRENCY");

    const after = h.invoices.getInvoice(invoice.id).invoice;
    expect(after.status).toBe("draft");
    expect(after.invoice_number).toBeNull();
    expect(after.currency).toBe("USD");
    expect(count("sales")).toBe(before.sales);
    expect(count("invoice_reconciliation")).toBe(before.reconciliation);

    // Positive control: the same draft issues normally once the currencies agree.
    terminal.currency = "USD";
    expect(h.invoices.finalizeInvoice(invoice.id).invoice.status).toBe("final");
  });
});

describe("a line linked to a catalog product must be in that product's currency", () => {
  it("addLine and updateLine refuse a product in another currency; nothing is written", () => {
    const p = product("مفك", "5.00"); // USD catalog
    terminal.currency = "LBP";
    const { invoice } = h.invoices.createDraft(); // an LBP draft
    expect(invoice.currency).toBe("LBP");

    expect(codeOf(() => h.invoices.addLine(invoice.id, line("5.00", { productId: p.id })))).toBe("MIXED_CURRENCY");
    expect(h.invoices.getInvoice(invoice.id).lines).toHaveLength(0);

    // An unlinked line in the invoice's own currency is consistent and still allowed.
    const added = h.invoices.addLine(invoice.id, line("1500"));
    const l = added.lines[0]!;
    expect(l.unit_price_minor).toBe(150000n);
    expect(codeOf(() => h.invoices.updateLine(invoice.id, l.id, line("1500", { productId: p.id })))).toBe("MIXED_CURRENCY");
    const reread = h.invoices.getInvoice(invoice.id).lines[0]!;
    expect(reread.product_id).toBeNull();
    expect(reread.unit_price_minor).toBe(150000n);
  });

  it("positive control: a same-currency pick is unchanged", () => {
    const p = product("مفك", "5.00");
    const { invoice } = h.invoices.createDraft();
    const added = h.invoices.addLine(invoice.id, line("5.00", { productId: p.id }));
    expect(added.lines[0]!.product_id).toBe(p.id);
    expect(added.lines[0]!.unit_price_minor).toBe(500n);
  });
});

describe("reconciliation never relabels an invoice price as the catalog's currency (Abu Abbas's risk)", () => {
  it("createProductFromInvoice refuses when the invoice currency is not the catalog's; nothing created", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, line("7.00", { description: "صنف جديد كلياً" }));
    h.invoices.finalizeInvoice(invoice.id);
    const queue = h.invoices.listReconciliation(invoice.id);
    expect(queue).toHaveLength(1);
    const productsBefore = h.service.listProducts().length;

    terminal.currency = "LBP"; // the catalog/terminal is now in another currency than the USD invoice
    expect(codeOf(() => h.invoices.createProductFromInvoice(queue[0]!.id, {}))).toBe("MIXED_CURRENCY");
    expect(h.service.listProducts().length).toBe(productsBefore);
    expect(h.invoices.listReconciliation(invoice.id)[0]!.status).toBe("PENDING");

    // Positive control: same currency → created at exactly the line's price.
    terminal.currency = "USD";
    const resolved = h.invoices.createProductFromInvoice(queue[0]!.id, {});
    expect(resolved.status).toBe("CREATED_PRODUCT");
    const created = h.service.listProducts().find((x) => x.id === resolved.matched_product_id)!;
    expect(created.selling_price_minor).toBe(700n);
    expect(created.currency).toBe("USD");
  });

  it("updateCatalogFromInvoice refuses to copy an LBP line price into a USD product; the product is unchanged", () => {
    const p = product("مطرقة", "5.00"); // USD 500 minor
    terminal.currency = "LBP";
    const { invoice } = h.invoices.createDraft(); // LBP invoice, matched to the product by its Arabic name
    h.invoices.addLine(invoice.id, line("7.00", { description: "مطرقة" }));
    h.invoices.finalizeInvoice(invoice.id);
    const queue = h.invoices.listReconciliation(invoice.id);
    expect(queue[0]!.matched_product_id).toBe(p.id);
    // Back to the real shape: a USD terminal and USD catalog, holding an LBP invoice (e.g. from a restored ledger).
    // Negative control on the baseline: the update ran WITHOUT any error and the product became 700 minor = $7.00 —
    // an LBP 7.00 line price silently relabelled as USD.
    terminal.currency = "USD";

    expect(
      codeOf(() => h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] })),
    ).toBe("MIXED_CURRENCY");
    const after = h.service.listProducts().find((x) => x.id === p.id)!;
    expect(after.selling_price_minor).toBe(500n);
    expect(after.currency).toBe("USD");
    expect(h.invoices.listReconciliation(invoice.id)[0]!.status).toBe("PENDING");
  });

  it("positive control: a same-currency price update still applies", () => {
    const p = product("مطرقة", "5.00");
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, line("7.00", { description: "مطرقة" }));
    h.invoices.finalizeInvoice(invoice.id);
    const queue = h.invoices.listReconciliation(invoice.id);
    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] });
    expect(h.service.listProducts().find((x) => x.id === p.id)!.selling_price_minor).toBe(700n);
  });
});
