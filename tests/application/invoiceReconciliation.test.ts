/**
 * Catalog reconciliation: what finalization classifies, what each resolution does, and — above all
 * — what a resolution must NOT do to a product nobody asked it to touch.
 *
 * The product service injected here is the REAL `PosService`, on the REAL connection, so every
 * "an audit row was written" / "no audit row was written" assertion below is about the durable
 * migration-5 trail and not about a fake that agreed with the test.
 *
 * Synthetic products, prices and names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { InvoiceService } from "../../src/application/invoiceService";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import type { Difference } from "../../src/domain/invoiceMatching";
import { type TempDir, type Harness, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

interface LineSpec {
  readonly description?: string | null;
  readonly unitLabel?: string | null;
  readonly unitPrice: string;
  readonly productId?: string | null;
  readonly quantity?: string;
}

const saveProfile = () => h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });

const product = (nameAr: string, price: string, extra: { sku?: string; baseUnit?: string; nameEn?: string } = {}) =>
  h.service.createProduct({
    nameAr,
    nameEn: extra.nameEn ?? null,
    sku: extra.sku ?? null,
    price,
    baseUnit: extra.baseUnit ?? "piece",
  });

/** An imported product carries `price_needs_review` — the only path that ever sets the flag. */
function importedNeedingReview(sourceId: string, nameAr: string, price: string, baseUnit = "piece") {
  const csv = [
    "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review",
    `${sourceId},${nameAr},,${price},USD,${baseUnit},1`,
  ].join("\n");
  h.service.importCatalogCsv("synthetic.csv", new TextEncoder().encode(csv));
  const row = h.service.listProducts().find((p) => p.name_ar === nameAr);
  if (!row) throw new Error("test setup: the imported product was not found");
  return row;
}

/** Finalizes one invoice carrying `lines`, and returns its id with its review queue. */
function finalize(lines: ReadonlyArray<LineSpec>) {
  const { invoice } = h.invoices.createDraft();
  for (const line of lines) {
    h.invoices.addLine(invoice.id, {
      description: line.description ?? "صنف اختباري",
      unitLabel: line.unitLabel === undefined ? "حبة" : line.unitLabel,
      productId: line.productId ?? null,
      quantity: line.quantity ?? "1",
      unitPrice: line.unitPrice,
    });
  }
  h.invoices.finalizeInvoice(invoice.id);
  return { invoiceId: invoice.id, queue: h.invoices.listReconciliation(invoice.id) };
}

const auditCount = () => h.audit.count();
const auditTypes = () => h.audit.countByType();
const reload = (id: string) => h.service.listProducts().find((p) => p.id === id)!;

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  saveProfile();
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("what finalization writes to the review queue", () => {
  it("writes one row per line, with the catalog values it actually compared", () => {
    const p = product("مفك براغي", "5.00");
    const { queue } = finalize([{ description: "مفك براغي", unitPrice: "5.00" }, { description: "شيء مجهول", unitPrice: "2.00" }]);

    expect(queue).toHaveLength(2);
    const matched = queue.find((r) => r.classification === "MATCHED")!;
    // 🔴 The snapshot of what the catalog said WHEN WE LOOKED — kept even for a matched line, where
    // `differences_json` is empty and would otherwise record nothing at all.
    const observed = JSON.parse(matched.candidates_json!) as Array<Record<string, unknown>>;
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ id: p.id, name_ar: "مفك براغي", selling_price_minor: "500", base_unit: "piece" });
    expect(matched.differences_json).toBe("[]");
  });

  it("settles a MATCHED line and leaves everything else for a person", () => {
    product("مفك براغي", "5.00");
    const { queue } = finalize([{ description: "مفك براغي", unitPrice: "5.00" }, { description: "مجهول", unitPrice: "2.00" }]);

    const matched = queue.find((r) => r.classification === "MATCHED")!;
    // The classification is the truth about the comparison; the status is the resolution.
    expect(matched.status).toBe("KEPT_CATALOG");
    expect(matched.resolved_at).toBe("2026-10-04T09:00:00.000Z");
    expect(matched.resolution_actor_id).toBe("cashier-01");

    expect(queue.find((r) => r.classification === "PRODUCT_NOT_FOUND")!.status).toBe("PENDING");
    expect(h.invoices.reconciliationCounts().unresolved).toBe(1);
  });

  it("changes NO product, creates NO product and clears NO flag", () => {
    const p = importedNeedingReview("1", "برغي", "1.00");
    const before = auditCount();
    const productsBefore = h.service.listProducts().length;

    finalize([{ description: "برغي", unitPrice: "9.99" }, { description: "شيء جديد تماماً", unitPrice: "3.00" }]);

    expect(h.service.listProducts()).toHaveLength(productsBefore);
    expect(reload(p.id).selling_price_minor).toBe(100n);
    expect(reload(p.id).price_needs_review).toBe(1n);
    // Finalizing an invoice is not a catalog event. Nothing was audited.
    expect(auditCount()).toBe(before);
  });

  it("keeps the review queue after the invoice screen is closed — it is a table, not screen state", () => {
    product("مفك", "5.00");
    const { invoiceId } = finalize([{ description: "مجهول", unitPrice: "2.00" }]);
    // Nothing is held in memory: a fresh service on the same database sees the same queue.
    const fresh = new InvoiceService({
      invoices: new InvoiceRepository(h.db),
      reconciliation: new ReconciliationRepository(h.db),
      company: h.companyStore,
      catalogStore: new CatalogRepository(h.db),
      products: h.service,
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: h.clock.now,
    });
    expect(fresh.listUnresolvedReconciliation()).toHaveLength(1);
    expect(fresh.listReconciliation(invoiceId)).toHaveLength(1);
  });
});

describe("every classification", () => {
  it("MATCHED — name, price and unit all agree", () => {
    product("مفك براغي", "5.00", { baseUnit: "piece" });
    const { queue } = finalize([{ description: "مفك براغي", unitLabel: "حبة", unitPrice: "5.00" }]);
    expect(queue[0]!.classification).toBe("MATCHED");
    expect(queue[0]!.match_tier).toBe("name_ar");
  });

  it("PRICE_DIFFERENCE — only the price moved", () => {
    product("مفك براغي", "5.00");
    const { queue } = finalize([{ description: "مفك براغي", unitPrice: "6.50" }]);
    expect(queue[0]!.classification).toBe("PRICE_DIFFERENCE");
    const diffs = h.invoices.decodeDifferences(queue[0]!);
    expect(diffs).toEqual([
      { field: "selling_price_minor", invoice: "650", catalog: "500", comparable: true },
    ]);
  });

  it("UNIT_DIFFERENCE — a known label that means a different catalog unit", () => {
    product("حبل", "5.00", { baseUnit: "piece" });
    const { queue } = finalize([{ description: "حبل", unitLabel: "متر", unitPrice: "5.00" }]);
    expect(queue[0]!.classification).toBe("UNIT_DIFFERENCE");
    const diff = h.invoices.decodeDifferences(queue[0]!)[0]!;
    // A PROVEN disagreement: "متر" maps to meter, the catalog says piece.
    expect(diff).toEqual({ field: "base_unit", invoice: "متر", catalog: "piece", comparable: true });
  });

  it("UNIT_DIFFERENCE with comparable:false — an unmappable label is 'we cannot tell', not 'they differ'", () => {
    product("برغي", "5.00", { baseUnit: "piece" });
    const { queue } = finalize([{ description: "برغي", unitLabel: "كيس (50PCS)", unitPrice: "5.00" }]);
    expect(queue[0]!.classification).toBe("UNIT_DIFFERENCE");
    const diff = h.invoices.decodeDifferences(queue[0]!)[0]!;
    expect(diff.comparable).toBe(false);
    expect(diff.invoice).toBe("كيس (50PCS)");
    // 🔴 The distinction this test exists for: the same classification, two different claims. One
    // says the units disagree; this one says nothing is known about the invoice's unit.
    const proven = (d: Difference) => d.field === "base_unit" && d.comparable;
    expect(h.invoices.decodeDifferences(queue[0]!).some(proven)).toBe(false);
  });

  it("DESCRIPTION_DIFFERENCE — the operator's chosen product, written under another name", () => {
    const p = product("مفك براغي", "5.00");
    const { queue } = finalize([{ description: "مفك صليبة", unitPrice: "5.00", productId: p.id }]);
    expect(queue[0]!.classification).toBe("DESCRIPTION_DIFFERENCE");
    expect(queue[0]!.match_tier).toBe("explicit");
    expect(h.invoices.decodeDifferences(queue[0]!)).toEqual([
      { field: "name_ar", invoice: "مفك صليبة", catalog: "مفك براغي", comparable: true },
    ]);
  });

  it("MULTIPLE_DIFFERENCES — price and unit at once", () => {
    product("حبل", "5.00", { baseUnit: "piece" });
    const { queue } = finalize([{ description: "حبل", unitLabel: "متر", unitPrice: "7.00" }]);
    expect(queue[0]!.classification).toBe("MULTIPLE_DIFFERENCES");
    expect(h.invoices.decodeDifferences(queue[0]!).map((d) => d.field).sort()).toEqual([
      "base_unit",
      "selling_price_minor",
    ]);
  });

  it("PRODUCT_NOT_FOUND — with fuzzy rows offered as SUGGESTIONS, never as a match", () => {
    product("مفك براغي كبير", "5.00");
    const { queue } = finalize([{ description: "مفك براغي صغير", unitPrice: "5.00" }]);
    expect(queue[0]!.classification).toBe("PRODUCT_NOT_FOUND");
    expect(queue[0]!.match_tier).toBe("none");
    // 🔴 A suggestion is not a link: matched_product_id stays null however good the score was.
    expect(queue[0]!.matched_product_id).toBeNull();
    expect(JSON.parse(queue[0]!.candidates_json!)).toHaveLength(1);
  });

  it("AMBIGUOUS_MATCH — two products share the name, so neither is chosen", () => {
    product("قفل", "5.00", { sku: "A" });
    product("قفل", "9.00", { sku: "B" });
    const { queue } = finalize([{ description: "قفل", unitPrice: "5.00" }]);
    expect(queue[0]!.classification).toBe("AMBIGUOUS_MATCH");
    expect(queue[0]!.matched_product_id).toBeNull();
    expect(JSON.parse(queue[0]!.candidates_json!)).toHaveLength(2);
  });

  it("an explicitly chosen product that has vanished does not fall back to a weaker match", () => {
    product("مفك براغي", "5.00");
    const { queue } = finalize([{ description: "مفك براغي", unitPrice: "5.00", productId: "ghost-product" }]);
    // Falling through to the name match would silently re-point the line at a different product.
    expect(queue[0]!.classification).toBe("PRODUCT_NOT_FOUND");
    expect(queue[0]!.match_tier).toBe("none");
  });
});

describe("resolutions that change nothing", () => {
  it("keep catalog: zero mutation, zero audit, out of the queue, and who decided it", () => {
    const p = product("مفك", "5.00");
    const { queue } = finalize([{ description: "مفك", unitPrice: "6.00" }]);
    const before = auditCount();

    const resolved = h.invoices.keepCatalog(queue[0]!.id);
    expect(resolved.status).toBe("KEPT_CATALOG");
    expect(resolved.resolution_actor_id).toBe("cashier-01");
    expect(resolved.resolution_actor_name).toBe("Cashier One");
    expect(resolved.resolved_at).toBe("2026-10-04T09:00:00.000Z");
    expect(reload(p.id).selling_price_minor).toBe(500n);
    expect(auditCount()).toBe(before);
    expect(h.invoices.reconciliationCounts().unresolved).toBe(0);
  });

  it("keep invoice only: a one-off line creates no product", () => {
    const { queue } = finalize([{ description: "أجرة توصيل", unitPrice: "10.00" }]);
    const before = { audits: auditCount(), products: h.service.listProducts().length };

    const resolved = h.invoices.keepInvoiceOnly(queue[0]!.id);
    expect(resolved.status).toBe("KEPT_INVOICE_ONLY");
    expect(resolved.matched_product_id).toBeNull();
    expect(h.service.listProducts()).toHaveLength(before.products);
    expect(auditCount()).toBe(before.audits);
  });

  it("link existing: records the product without touching catalog or invoice", () => {
    const p = product("مفك براغي كبير", "5.00");
    const { invoiceId, queue } = finalize([{ description: "مفك براغي صغير", unitPrice: "7.00" }]);
    const lineBefore = h.invoices.getInvoice(invoiceId).lines[0]!;
    const before = auditCount();

    const resolved = h.invoices.linkExistingProduct(queue[0]!.id, p.id);
    expect(resolved.status).toBe("LINKED_PRODUCT");
    expect(resolved.matched_product_id).toBe(p.id);
    expect(reload(p.id).selling_price_minor).toBe(500n);
    expect(auditCount()).toBe(before);
    // 🔴 The finalized document is untouched: the line still says what it said.
    expect(h.invoices.getInvoice(invoiceId).lines[0]).toEqual(lineBefore);
  });

  it("refuses to link a product that no longer exists, and keeps the item in the queue", () => {
    const { queue } = finalize([{ description: "مجهول", unitPrice: "1.00" }]);
    expect(() => h.invoices.linkExistingProduct(queue[0]!.id, "ghost")).toThrow(/no longer exists/);
    expect(h.reconciliationStore.requireById(queue[0]!.id).status).toBe("PENDING");
  });

  it("refuses to re-decide an item that is already settled", () => {
    product("مفك", "5.00");
    const { queue } = finalize([{ description: "مفك", unitPrice: "6.00" }]);
    h.invoices.keepCatalog(queue[0]!.id);
    expect(() => h.invoices.keepCatalog(queue[0]!.id)).toThrow(/already settled/);
    expect(() => h.invoices.keepInvoiceOnly(queue[0]!.id)).toThrow(/already settled/);
  });
});

describe("creating a product from an invoice line", () => {
  it("creates it through PosService, audits it, and links the review item", () => {
    const { invoiceId, queue } = finalize([{ description: "صنف جديد", unitLabel: "حبة", unitPrice: "12.50" }]);
    const before = auditCount();

    const resolved = h.invoices.createProductFromInvoice(queue[0]!.id, {});
    expect(resolved.status).toBe("CREATED_PRODUCT");

    const created = h.service.listProducts().find((p) => p.name_ar === "صنف جديد")!;
    expect(created.selling_price_minor).toBe(1250n);
    expect(created.base_unit).toBe("piece");
    // A typed price is a real price, so a created product needs no review.
    expect(created.price_needs_review).toBe(0n);
    expect(resolved.matched_product_id).toBe(created.id);

    // The durable trail says WHERE it came from, through the existing event type.
    expect(auditCount()).toBe(before + 1);
    const row = h.audit.listForEntity("product", created.id)[0]!;
    expect(row.event_type).toBe("PRODUCT_CREATED");
    expect(JSON.parse(row.metadata_json!)).toMatchObject({
      origin: "invoice_reconciliation",
      invoice_id: invoiceId,
    });
  });

  it("never invents an English name from the invoice description", () => {
    const { queue } = finalize([{ description: "صنف عربي فقط", unitPrice: "3.00" }]);
    h.invoices.createProductFromInvoice(queue[0]!.id, {});
    expect(h.service.listProducts().find((p) => p.name_ar === "صنف عربي فقط")!.name_en).toBeNull();
  });

  it("asks for the catalog unit when the printed label maps to nothing", () => {
    const { queue } = finalize([{ description: "صنف معبّأ", unitLabel: "كيس (50PCS)", unitPrice: "4.00" }]);
    const before = auditCount();

    expect(() => h.invoices.createProductFromInvoice(queue[0]!.id, {})).toThrow(/choose the catalog unit/);
    expect(auditCount()).toBe(before);

    // And the way out exists: the operator names the unit, and it works.
    const resolved = h.invoices.createProductFromInvoice(queue[0]!.id, { baseUnit: "pack" });
    expect(resolved.status).toBe("CREATED_PRODUCT");
    expect(h.service.listProducts().find((p) => p.name_ar === "صنف معبّأ")!.base_unit).toBe("pack");
  });

  it("does not create a second product when a retry follows a lost acknowledgement", () => {
    const { queue } = finalize([{ description: "صنف جديد", unitPrice: "12.50" }]);
    const resolved = h.invoices.createProductFromInvoice(queue[0]!.id, {});
    const created = resolved.matched_product_id!;
    const after = { audits: auditCount(), products: h.service.listProducts().length };

    // Put the item back in the queue as an interrupted attempt would have left it, then retry.
    h.db.prepare("UPDATE invoice_reconciliation SET status = 'PENDING', resolved_at = NULL, resolution_actor_id = NULL, resolution_actor_name = NULL WHERE id = ?").run(queue[0]!.id);
    const again = h.invoices.createProductFromInvoice(queue[0]!.id, {});

    expect(again.status).toBe("CREATED_PRODUCT");
    expect(again.matched_product_id).toBe(created);
    expect(h.service.listProducts()).toHaveLength(after.products);
    expect(auditCount()).toBe(after.audits);
  });
});

describe("updating the catalog from an invoice line", () => {
  it("copies the price, audits it as PRODUCT_UPDATED, and names the invoice", () => {
    const p = product("مفك", "5.00");
    const { invoiceId, queue } = finalize([{ description: "مفك", unitPrice: "6.50" }]);
    const before = auditCount();

    const resolved = h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] });
    expect(resolved.status).toBe("UPDATED_CATALOG");
    expect(JSON.parse(resolved.selected_fields_json!)).toEqual(["selling_price_minor"]);
    expect(reload(p.id).selling_price_minor).toBe(650n);

    expect(auditCount()).toBe(before + 1);
    const row = h.audit.listForEntity("product", p.id)[0]!;
    // 🔴 No PRICE_CHANGED event type. A price changed here is the same fact as a price changed on
    // the product screen, and it travels in the same event.
    expect(row.event_type).toBe("PRODUCT_UPDATED");
    expect(auditTypes().PRICE_CHANGED).toBeUndefined();
    expect(JSON.parse(row.changed_json).selling_price_minor).toEqual({ before: "500", after: "650" });
    expect(JSON.parse(row.metadata_json!)).toMatchObject({ origin: "invoice_reconciliation", invoice_id: invoiceId });
  });

  it("copies a known unit, and asks which unit an unmappable label means", () => {
    const p = product("حبل", "5.00", { baseUnit: "piece" });
    const { queue } = finalize([{ description: "حبل", unitLabel: "متر", unitPrice: "5.00" }]);
    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["base_unit"] });
    expect(reload(p.id).base_unit).toBe("meter");

    const q = product("برغي", "2.00", { baseUnit: "piece" });
    const second = finalize([{ description: "برغي", unitLabel: "كيس (50PCS)", unitPrice: "2.00" }]);
    expect(() => h.invoices.updateCatalogFromInvoice(second.queue[0]!.id, { fields: ["base_unit"] })).toThrow(
      /does not map to a catalog unit/,
    );
    // 🔴 The operator's explicit choice, never a guess.
    h.invoices.updateCatalogFromInvoice(second.queue[0]!.id, { fields: ["base_unit"], canonicalUnit: "pack" });
    expect(reload(q.id).base_unit).toBe("pack");
  });

  it("updates the Arabic name only, and refuses to invent the English one", () => {
    const p = product("مفك براغي", "5.00", { nameEn: "Screwdriver" });
    const { queue } = finalize([{ description: "مفك صليبة", unitPrice: "5.00", productId: p.id }]);

    expect(() => h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["name_en"] })).toThrow(
      /never guessed from the invoice description/,
    );

    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["name_ar"] });
    const after = reload(p.id);
    expect(after.name_ar).toBe("مفك صليبة");
    // 🔴 One free-text description never writes both language fields.
    expect(after.name_en).toBe("Screwdriver");
  });

  it("applies ONLY the selected fields when several differ", () => {
    const p = product("حبل", "5.00", { baseUnit: "piece", sku: "ROPE-1", nameEn: "Rope" });
    const { queue } = finalize([{ description: "حبل مجدول", unitLabel: "متر", unitPrice: "9.00" }]);
    expect(queue[0]!.classification).toBe("PRODUCT_NOT_FOUND");
    h.invoices.linkExistingProduct(queue[0]!.id, p.id);
    // Linking settles the item; a real queue would surface the differences on the linked product.
    h.db.prepare("UPDATE invoice_reconciliation SET status = 'PENDING' WHERE id = ?").run(queue[0]!.id);

    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor", "base_unit"] });
    const after = reload(p.id);
    expect(after.selling_price_minor).toBe(900n);
    expect(after.base_unit).toBe("meter");
    // Everything unselected is byte-identical.
    expect(after.name_ar).toBe("حبل");
    expect(after.name_en).toBe("Rope");
    expect(after.sku).toBe("ROPE-1");
  });

  it("refuses an update with no product linked, and says what to do first", () => {
    const { queue } = finalize([{ description: "مجهول تماماً", unitPrice: "1.00" }]);
    expect(() => h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] })).toThrow(
      /Link this line to a product first|Link this line to a product before/,
    );
  });

  it("refuses an empty selection and an unknown field", () => {
    product("مفك", "5.00");
    const { queue } = finalize([{ description: "مفك", unitPrice: "6.00" }]);
    expect(() => h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: [] })).toThrow(/at least one field/);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["is_active" as any] }),
    ).toThrow(/not a field reconciliation can update/);
  });
});

describe("reconciliation never activates or deactivates a product", () => {
  it("a withdrawn product stays withdrawn after a price update", () => {
    const p = product("مفك", "5.00");
    h.service.setProductActive(p.id, false);
    expect(reload(p.id).is_active).toBe(0n);
    const { queue } = finalize([{ description: "مفك", unitPrice: "6.50" }]);
    const typesBefore = auditTypes();

    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] });

    const after = reload(p.id);
    expect(after.selling_price_minor).toBe(650n);
    // 🔴 THE REGRESSION THIS TEST EXISTS FOR. `updateProduct` takes a COMPLETE draft including
    // `isActive`; building that draft from invoice data, or defaulting it to true, would have
    // silently put a withdrawn product back on sale.
    expect(after.is_active).toBe(0n);
    const typesAfter = auditTypes();
    expect(typesAfter.PRODUCT_ACTIVATED ?? 0).toBe(typesBefore.PRODUCT_ACTIVATED ?? 0);
    expect(typesAfter.PRODUCT_DEACTIVATED ?? 0).toBe(typesBefore.PRODUCT_DEACTIVATED ?? 0);
    // And `is_active` is not even in the diff, because it did not move.
    expect(JSON.parse(h.audit.listForEntity("product", p.id)[0]!.changed_json)).not.toHaveProperty("is_active");
  });

  it("an active product stays active, through every field a resolution can touch", () => {
    const p = product("حبل", "5.00", { baseUnit: "piece", nameEn: "Rope" });
    const { queue } = finalize([{ description: "حبل مجدول", unitLabel: "متر", unitPrice: "9.00", productId: p.id }]);
    h.invoices.updateCatalogFromInvoice(queue[0]!.id, {
      fields: ["selling_price_minor", "base_unit", "name_ar", "name_en"],
      nameEn: "Braided rope",
    });
    const after = reload(p.id);
    expect(after.is_active).toBe(1n);
    expect([after.name_ar, after.name_en, after.base_unit, after.selling_price_minor]).toEqual([
      "حبل مجدول",
      "Braided rope",
      "meter",
      900n,
    ]);
  });
});

describe("price_needs_review", () => {
  it("1 · an explicitly accepted invoice price clears it", () => {
    const p = importedNeedingReview("1", "برغي", "1.00");
    expect(reload(p.id).price_needs_review).toBe(1n);
    const { queue } = finalize([{ description: "برغي", unitPrice: "2.50" }]);

    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] });
    const after = reload(p.id);
    expect(after.selling_price_minor).toBe(250n);
    expect(after.price_needs_review).toBe(0n);
    // And the diff says so truthfully — the flag really did move, so the audit records it.
    expect(JSON.parse(h.audit.listForEntity("product", p.id)[0]!.changed_json).price_needs_review).toEqual({
      before: true,
      after: false,
    });
  });

  it("2 · keeping the catalog price leaves it set", () => {
    const p = importedNeedingReview("1", "برغي", "1.00");
    const { queue } = finalize([{ description: "برغي", unitPrice: "2.50" }]);
    h.invoices.keepCatalog(queue[0]!.id);
    expect(reload(p.id).price_needs_review).toBe(1n);
    expect(reload(p.id).selling_price_minor).toBe(100n);
  });

  it("3 · a FAILED update leaves it set, and the catalog untouched", () => {
    const p = importedNeedingReview("1", "برغي", "1.00");
    // A zero-priced invoice line: migration 3 requires selling_price_minor > 0, so accepting this
    // price as the catalog price is a real, natural failure rather than an injected one.
    const { queue } = finalize([{ description: "برغي", unitPrice: "0" }]);
    const before = auditCount();

    expect(() => h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] })).toThrow(
      /greater than zero/,
    );

    const after = reload(p.id);
    expect(after.selling_price_minor).toBe(100n);
    expect(after.price_needs_review).toBe(1n);
    // 🔴 Catalog mutation and audit roll back together: neither half committed.
    expect(auditCount()).toBe(before);

    const item = h.reconciliationStore.requireById(queue[0]!.id);
    expect(item.status).toBe("FAILED");
    expect(item.failure_code).toBe("INVALID_AMOUNT");
    expect(item.failure_message).toContain("greater than zero");
    expect(Number(item.attempt_count)).toBe(1);
    // It is still in the unresolved queue, and still resolvable another way.
    expect(h.invoices.reconciliationCounts().unresolved).toBe(1);
    expect(h.invoices.keepCatalog(queue[0]!.id).status).toBe("KEPT_CATALOG");
    // A succeeded resolution stops showing the message from the attempt that did not.
    expect(h.reconciliationStore.requireById(queue[0]!.id).failure_code).toBeNull();
  });

  it("4 · an unrelated name or unit change leaves it set", () => {
    const p = importedNeedingReview("1", "برغي", "1.00", "piece");
    const { queue } = finalize([{ description: "برغي مجلفن", unitLabel: "متر", unitPrice: "1.00", productId: p.id }]);

    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["name_ar", "base_unit"] });
    const after = reload(p.id);
    expect(after.name_ar).toBe("برغي مجلفن");
    expect(after.base_unit).toBe("meter");
    // 🔴 Writing a product does not confirm its price. Only accepting the price does.
    expect(after.price_needs_review).toBe(1n);
  });
});

describe("retry is idempotent, by reading the world rather than replaying the request", () => {
  /** A service whose resolution-recording step fails — the lost acknowledgement, exactly. */
  function serviceThatLosesTheAcknowledgement(): InvoiceService {
    class LosesResolve extends ReconciliationRepository {
      override resolve(): never {
        throw new Error("injected failure: the resolution could not be recorded");
      }
    }
    return new InvoiceService({
      invoices: new InvoiceRepository(h.db),
      reconciliation: new LosesResolve(h.db),
      company: h.companyStore,
      catalogStore: new CatalogRepository(h.db),
      products: h.service,
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: h.clock.now,
    });
  }

  it("the product update commits, the acknowledgement is lost, and the retry settles it with no second audit", () => {
    const p = importedNeedingReview("1", "برغي", "1.00");
    const { queue } = finalize([{ description: "برغي", unitPrice: "2.50" }]);
    const itemId = queue[0]!.id;
    const before = auditCount();

    // 1 + 2 · the product mutation commits; recording the resolution does not.
    expect(() =>
      serviceThatLosesTheAcknowledgement().updateCatalogFromInvoice(itemId, { fields: ["selling_price_minor"] }),
    ).toThrow(/injected failure/);

    const mid = reload(p.id);
    expect(mid.selling_price_minor).toBe(250n);
    expect(mid.price_needs_review).toBe(0n);
    expect(auditCount()).toBe(before + 1);
    const item = h.reconciliationStore.requireById(itemId);
    expect(item.status).toBe("PENDING");
    expect(Number(item.attempt_count)).toBe(1);

    // 3 + 4 · the retry reads the CURRENT product and finds nothing left to do.
    const resolved = h.invoices.updateCatalogFromInvoice(itemId, { fields: ["selling_price_minor"] });

    // 5 · no second audit event, and no second attempt counted, because nothing was attempted.
    expect(auditCount()).toBe(before + 1);
    expect(Number(h.reconciliationStore.requireById(itemId).attempt_count)).toBe(1);
    // 6 · and the item ends resolved.
    expect(resolved.status).toBe("UPDATED_CATALOG");
    expect(h.invoices.reconciliationCounts().unresolved).toBe(0);
  });

  it("an accepted price whose flag is still set is unfinished work, not an already-applied retry", () => {
    const p = importedNeedingReview("1", "برغي", "1.00");
    // The price already matches the invoice, but the flag was never cleared — so there IS work left.
    h.service.updateProduct(p.id, { nameAr: "برغي", nameEn: null, sku: null, price: "2.50", baseUnit: "piece" }, true);
    expect(reload(p.id).price_needs_review).toBe(1n);
    const { queue } = finalize([{ description: "برغي", unitPrice: "2.50" }]);
    expect(queue[0]!.classification).toBe("MATCHED");

    // MATCHED items are already settled, so reopen it the way a person reviewing the queue would.
    h.db.prepare("UPDATE invoice_reconciliation SET status = 'PENDING' WHERE id = ?").run(queue[0]!.id);
    const before = auditCount();
    h.invoices.updateCatalogFromInvoice(queue[0]!.id, { fields: ["selling_price_minor"] });

    expect(reload(p.id).price_needs_review).toBe(0n);
    // One real event: only the flag moved, and the diff says exactly that.
    expect(auditCount()).toBe(before + 1);
    expect(JSON.parse(h.audit.listForEntity("product", p.id)[0]!.changed_json)).toEqual({
      price_needs_review: { before: true, after: false },
    });
  });
});
