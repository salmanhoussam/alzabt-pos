/**
 * Matching an invoice line to the catalog, and classifying the disagreement.
 *
 * Every classification is tested on its own, and the two rules that matter most are tested as
 * properties rather than examples: fuzzy similarity never produces a match, and nothing in this
 * module writes anything.
 *
 * Synthetic products and prices only.
 */
import { describe, expect, it } from "vitest";
import {
  type CatalogCandidate,
  type InvoiceLineObservation,
  RECONCILIATION_CLASSIFICATIONS,
  RESOLUTION_STATES,
  classifyInvoiceLine,
  differencesFor,
  isUnresolved,
  matchInvoiceLine,
} from "../../src/domain/invoiceMatching";

const product = (over: Partial<CatalogCandidate> & { id: string }): CatalogCandidate => ({
  sku: null,
  nameAr: "صنف",
  nameEn: null,
  sellingPriceMinor: 1000n,
  baseUnit: "piece",
  isActive: true,
  ...over,
});

const line = (over: Partial<InvoiceLineObservation> = {}): InvoiceLineObservation => ({
  description: "صنف",
  unitLabel: "حبة",
  unitPriceMinor: 1000n,
  productId: null,
  ...over,
});

const HAMMER = product({ id: "manual:000001", sku: "SYN-H", nameAr: "شاكوش", nameEn: "Hammer", sellingPriceMinor: 1200n });
const WIRE = product({ id: "manual:000002", nameAr: "نايلون شفاف", sellingPriceMinor: 260n, baseUnit: "kg" });
const CATALOG = [HAMMER, WIRE];

describe("match tiers, strongest identifier first", () => {
  it("1 · the product the operator explicitly chose wins over everything", () => {
    const m = matchInvoiceLine(line({ description: "نايلون شفاف", productId: HAMMER.id }), CATALOG);
    expect(m.tier).toBe("explicit");
    expect(m.product?.id).toBe(HAMMER.id);
  });

  it("🔴 an explicit id that is no longer in the catalog does NOT fall through to a weaker tier", () => {
    const m = matchInvoiceLine(line({ description: "شاكوش", productId: "manual:999999" }), CATALOG);
    expect(m.tier).toBe("none");
    expect(m.product).toBeNull();
    // Falling back to the name would silently re-point the line at a different product.
  });

  it("2 · an exact SKU", () => {
    const m = matchInvoiceLine(line({ description: "SYN-H" }), CATALOG);
    expect(m.tier).toBe("sku");
    expect(m.product?.id).toBe(HAMMER.id);
  });

  it("3 · an exact normalized Arabic name, hamza and spacing tolerant", () => {
    expect(matchInvoiceLine(line({ description: "شاكوش" }), CATALOG).tier).toBe("name_ar");
    expect(matchInvoiceLine(line({ description: "  شاكوش  " }), CATALOG).product?.id).toBe(HAMMER.id);
  });

  it("4 · an exact normalized English name", () => {
    const m = matchInvoiceLine(line({ description: "Hammer" }), CATALOG);
    expect(m.tier).toBe("name_en");
    expect(m.product?.id).toBe(HAMMER.id);
  });

  it("5 · 🔴 similarity NEVER matches — it only suggests", () => {
    const m = matchInvoiceLine(line({ description: "شاكوش عمار سكاي هاي 900 جرام" }), CATALOG);
    expect(m.tier).toBe("none");
    expect(m.product).toBeNull();
    expect(m.candidates.map((c) => c.id)).toContain(HAMMER.id); // offered, not chosen
  });
});

describe("every classification, one at a time", () => {
  it("MATCHED — same price, same unit, same name", () => {
    const c = classifyInvoiceLine(line({ description: "شاكوش", unitLabel: "حبة", unitPriceMinor: 1200n }), CATALOG);
    expect(c.classification).toBe("MATCHED");
    expect(c.differences).toEqual([]);
  });

  it("PRICE_DIFFERENCE", () => {
    const c = classifyInvoiceLine(line({ description: "شاكوش", unitLabel: "حبة", unitPriceMinor: 1400n }), CATALOG);
    expect(c.classification).toBe("PRICE_DIFFERENCE");
    expect(c.differences).toEqual([
      { field: "selling_price_minor", invoice: "1400", catalog: "1200", comparable: true },
    ]);
  });

  it("UNIT_DIFFERENCE — a known label that maps to a different base unit", () => {
    const c = classifyInvoiceLine(line({ description: "شاكوش", unitLabel: "كيلو", unitPriceMinor: 1200n }), CATALOG);
    expect(c.classification).toBe("UNIT_DIFFERENCE");
    expect(c.differences[0]).toEqual({ field: "base_unit", invoice: "كيلو", catalog: "piece", comparable: true });
  });

  it("🔴 UNIT_DIFFERENCE — an UNMAPPED label is 'we cannot tell', not 'they differ'", () => {
    const c = classifyInvoiceLine(line({ description: "شاكوش", unitLabel: "كيس (50PCS)", unitPriceMinor: 1200n }), CATALOG);
    expect(c.classification).toBe("UNIT_DIFFERENCE");
    expect(c.differences[0]).toEqual({
      field: "base_unit",
      invoice: "كيس (50PCS)",
      catalog: "piece",
      comparable: false,
    });
  });

  it("DESCRIPTION_DIFFERENCE — matched by SKU, but the words differ", () => {
    const c = classifyInvoiceLine(
      line({ description: "SYN-H", unitLabel: "حبة", unitPriceMinor: 1200n }),
      CATALOG,
    );
    expect(c.classification).toBe("DESCRIPTION_DIFFERENCE");
    expect(c.differences[0]).toMatchObject({ field: "name_ar", invoice: "SYN-H", catalog: "شاكوش" });
  });

  it("🔴 only the ARABIC name is ever offered — no English translation is inferred", () => {
    const c = classifyInvoiceLine(line({ description: "SYN-H", unitLabel: "حبة", unitPriceMinor: 1200n }), CATALOG);
    expect(c.differences.map((d) => d.field)).not.toContain("name_en");
  });

  it("MULTIPLE_DIFFERENCES", () => {
    const c = classifyInvoiceLine(line({ description: "SYN-H", unitLabel: "كيلو", unitPriceMinor: 1400n }), CATALOG);
    expect(c.classification).toBe("MULTIPLE_DIFFERENCES");
    expect(c.differences.map((d) => d.field).sort()).toEqual(["base_unit", "name_ar", "selling_price_minor"]);
  });

  it("PRODUCT_NOT_FOUND — nothing matches, and suggestions may still be offered", () => {
    const c = classifyInvoiceLine(line({ description: "رباط بلاستيك" }), CATALOG);
    expect(c.classification).toBe("PRODUCT_NOT_FOUND");
    expect(c.match.product).toBeNull();
    expect(c.differences).toEqual([]);
  });

  it("AMBIGUOUS_MATCH — two products share the same exact name", () => {
    const twins = [
      product({ id: "manual:000010", nameAr: "شريط" }),
      product({ id: "manual:000011", nameAr: "شريط", sellingPriceMinor: 250n }),
    ];
    const c = classifyInvoiceLine(line({ description: "شريط" }), twins);
    expect(c.classification).toBe("AMBIGUOUS_MATCH");
    expect(c.match.product).toBeNull();
    expect(c.match.candidates.map((x) => x.id)).toEqual(["manual:000010", "manual:000011"]);
  });

  it("two products sharing a SKU are ambiguous too, never silently picked", () => {
    const twins = [
      product({ id: "a", sku: "DUP" }),
      product({ id: "b", sku: "DUP" }),
    ];
    const c = classifyInvoiceLine(line({ description: "DUP" }), twins);
    expect(c.classification).toBe("AMBIGUOUS_MATCH");
    expect(c.match.candidates).toHaveLength(2);
  });
});

describe("properties that must hold whatever the input", () => {
  it("🔴 a candidate list is never silently promoted to a match", () => {
    const inputs = ["رباط بلاستيك", "شاكوش عمار 900", "nylon sheet", "", "   ", "شريط"];
    for (const description of inputs) {
      const m = matchInvoiceLine(line({ description }), CATALOG);
      if (m.product !== null) {
        // a product may only come from an EXACT tier
        expect(["explicit", "sku", "name_ar", "name_en"]).toContain(m.tier);
      } else {
        expect(m.tier).toBe("none");
      }
    }
  });

  it("an empty description matches nothing and suggests nothing", () => {
    const m = matchInvoiceLine(line({ description: "   " }), CATALOG);
    expect(m.product).toBeNull();
    expect(m.candidates).toEqual([]);
  });

  it("a line with no unit label produces no unit difference", () => {
    const d = differencesFor(line({ description: "شاكوش", unitLabel: null, unitPriceMinor: 1200n }), HAMMER);
    expect(d.map((x) => x.field)).not.toContain("base_unit");
  });

  it("classification is deterministic across repeated runs", () => {
    // The candidate rows carry bigint prices, which JSON.stringify refuses.
    const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    const run = () =>
      JSON.stringify(classifyInvoiceLine(line({ description: "شاكوش عمار 900 جرام" }), CATALOG), bigintSafe);
    const once = run();
    for (let i = 0; i < 20; i++) expect(run()).toBe(once);
  });

  it("the classification and state vocabularies are closed and complete", () => {
    expect([...RECONCILIATION_CLASSIFICATIONS]).toEqual([
      "MATCHED", "PRICE_DIFFERENCE", "UNIT_DIFFERENCE", "DESCRIPTION_DIFFERENCE",
      "MULTIPLE_DIFFERENCES", "PRODUCT_NOT_FOUND", "AMBIGUOUS_MATCH",
    ]);
    expect([...RESOLUTION_STATES]).toEqual([
      "PENDING", "KEPT_CATALOG", "UPDATED_CATALOG", "CREATED_PRODUCT",
      "LINKED_PRODUCT", "KEPT_INVOICE_ONLY", "FAILED",
    ]);
  });

  it("only PENDING and FAILED remain in the queue — a deliberate Keep is finished work", () => {
    expect(RESOLUTION_STATES.filter(isUnresolved)).toEqual(["PENDING", "FAILED"]);
    expect(isUnresolved("KEPT_CATALOG")).toBe(false);
    expect(isUnresolved("KEPT_INVOICE_ONLY")).toBe(false);
  });
});
