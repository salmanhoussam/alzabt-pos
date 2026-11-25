import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asDemoCatalog, emptyCatalog, loadCatalog } from "../../src/domain/catalog";
import { DomainError } from "../../src/domain/errors";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { DEMO_CATALOG_ENV, decideDemoCatalog, demoCatalogRequested, probeMerchantData } from "../../src/main/demoCatalog";
import { toCatalogDto } from "../../src/shared/dto";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * DEMO-FALLBACK (RISK-24, owner decision D-DF1 = A, 2026-11-06).
 * Merchant default: no active product ⇒ EMPTY till, a sample sale refused and nothing written.
 * Demo: only under ALZABT_POS_DEMO_CATALOG=1 AND only on a ledger with no merchant data.
 */

const NONE = { productRows: 0, parties: 0, invoices: 0, merchantSaleLines: 0 };
const SAMPLE_IDS = FIXTURE_CATALOG.products.map((p) => p.id);
const espresso = { lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: 250n };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("the demo switch", () => {
  it("is on only for the exact value 1", () => {
    expect(demoCatalogRequested({ [DEMO_CATALOG_ENV]: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
      expect(demoCatalogRequested({ [DEMO_CATALOG_ENV]: v })).toBe(false);
    }
    expect(demoCatalogRequested({})).toBe(false);
  });

  it("without the switch the mode is merchant, whatever the ledger holds", () => {
    expect(decideDemoCatalog(false, NONE)).toEqual({ mode: "merchant", demoRefused: false });
  });

  it("with the switch on an EMPTY ledger the mode is demo", () => {
    expect(decideDemoCatalog(true, NONE)).toEqual({ mode: "demo" });
  });

  it("🔴 with the switch on a ledger holding ANY merchant data, demo is REFUSED — never a demo inside a shop", () => {
    for (const probe of [
      { ...NONE, productRows: 1 },
      { ...NONE, parties: 1 },
      { ...NONE, invoices: 1 },
      { ...NONE, merchantSaleLines: 1 },
    ]) {
      expect(decideDemoCatalog(true, probe)).toEqual({ mode: "merchant", demoRefused: true, reason: "merchant-data" });
    }
  });
});

describe("the merchant-data probe and the till's fallback, on a real ledger", () => {
  let t: TempDir;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it("a fresh ledger holds no merchant data; a product, a customer or an invoice each count", () => {
    const h = makeHarness(t.dbPath);
    try {
      expect(probeMerchantData(h.db, SAMPLE_IDS)).toEqual(NONE);
      // A SAMPLE sale is not merchant data (a relaunched demo stays a demo)…
      h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
      expect(probeMerchantData(h.db, SAMPLE_IDS)).toEqual(NONE);
      h.service.createProduct({ nameAr: "صنف", nameEn: "Item", sku: "DF-1", price: "4.00", baseUnit: "piece" });
      expect(probeMerchantData(h.db, SAMPLE_IDS).productRows).toBe(1);
      h.service.setProductActive((h.db.prepare("SELECT id FROM catalog_products").get() as { id: string }).id, false);
      // An INACTIVE product is still merchant data: deactivating everything never re-enables a demo.
      expect(probeMerchantData(h.db, SAMPLE_IDS).productRows).toBe(1);
    } finally {
      h.db.close();
    }
  });

  it("🔴 a ledger with REAL sales history is a shop — even with no product row left — and refuses the demo", () => {
    // A product sold, its sale line kept; the probe reads the line, not only the product table. Using a
    // catalog that is NOT the sample makes the sold id a real one, exactly like a shop's own history.
    const real = loadCatalog({
      currency: "USD",
      products: [{ id: "shop-real-1", sku: "R-1", name: "Real", price: "1.00" }],
    });
    const h = makeHarness(t.dbPath, { catalog: real });
    try {
      h.service.createSale({
        idempotencyKey: newKey(),
        paymentMethod: "cash",
        lines: [{ productId: "shop-real-1", quantityMilli: 1000 }],
        expectedTotalMinor: 100n,
      });
      const probe = probeMerchantData(h.db, SAMPLE_IDS);
      expect(probe.productRows).toBe(0);
      expect(probe.merchantSaleLines).toBe(1);
      expect(decideDemoCatalog(true, probe)).toEqual({ mode: "merchant", demoRefused: true, reason: "merchant-data" });
    } finally {
      h.db.close();
    }
  });

  it("🔴 merchant mode: an empty till refuses a sample-catalog sale and writes NOTHING", () => {
    const h = makeHarness(t.dbPath, { catalog: emptyCatalog("USD"), fallbackCatalog: emptyCatalog("USD") });
    try {
      expect(h.service.getCatalog().products).toHaveLength(0);
      expect(toCatalogDto(h.service.getCatalog()).demo).toBe(false);
      const before = countRows(h.db);
      const auditBefore = Number((h.db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: bigint }).n);
      expect(codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso }))).toBe(
        "UNKNOWN_PRODUCT",
      );
      expect(countRows(h.db)).toEqual(before);
      expect(before.sales).toBe(0);
      expect(Number((h.db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: bigint }).n)).toBe(auditBefore);
    } finally {
      h.db.close();
    }
  });

  it("🔴 deactivating the last product falls back to the EMPTY catalog — not the sample, not a stale list", () => {
    const h = makeHarness(t.dbPath, { fallbackCatalog: emptyCatalog("USD") });
    try {
      const p = h.service.createProduct({ nameAr: "صنف", nameEn: "Item", sku: "DF-2", price: "4.00", baseUnit: "piece" });
      expect(h.service.getCatalog().products.map((x) => x.id)).toEqual([p.id]);
      h.service.setProductActive(p.id, false);
      expect(h.service.getCatalog().products).toHaveLength(0);
      expect(h.service.getCatalog().byId.has("prod-0001")).toBe(false);
      expect(codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso }))).toBe(
        "UNKNOWN_PRODUCT",
      );
    } finally {
      h.db.close();
    }
  });

  it("demo mode: the same fallback serves the sample, MARKED demo end-to-end through the DTO", () => {
    const demo = asDemoCatalog(loadCatalog(FIXTURE_CATALOG));
    const h = makeHarness(t.dbPath, { catalog: demo, fallbackCatalog: demo });
    try {
      expect(toCatalogDto(h.service.getCatalog()).demo).toBe(true);
      const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
      expect(sale.receiptNumber).toBe(1);
      // A real product ends the demo for this session: the local catalog is never marked demo.
      const p = h.service.createProduct({ nameAr: "صنف", nameEn: "Item", sku: "DF-3", price: "4.00", baseUnit: "piece" });
      expect(toCatalogDto(h.service.getCatalog()).demo).toBe(false);
      expect(h.service.getCatalog().products.map((x) => x.id)).toEqual([p.id]);
    } finally {
      h.db.close();
    }
  });

  it("the legacy path (no fallbackCatalog) is what made the stale list possible — main.ts must always pass it", () => {
    // Documents WHY the dependency exists: without it the fallback is the STARTUP catalog.
    const h = makeHarness(t.dbPath, { catalog: emptyCatalog("USD") });
    try {
      const p = h.service.createProduct({ nameAr: "صنف", nameEn: "Item", sku: "DF-4", price: "4.00", baseUnit: "piece" });
      h.service.setProductActive(p.id, false);
      expect(h.service.getCatalog().products).toHaveLength(0); // here the startup catalog happens to be empty
    } finally {
      h.db.close();
    }
    const main = readFileSync(join(__dirname, "../../src/main/main.ts"), "utf8");
    const assembly = readFileSync(join(__dirname, "../../src/main/ledgerServices.ts"), "utf8");
    expect(main).toMatch(/createLedgerServices\(db,\s*\{[\s\S]*?\bfallbackCatalog,/);
    expect(assembly).toMatch(/fallbackCatalog:\s*ports\.fallbackCatalog/);
    expect(main).toMatch(
      /decideDemoCatalog\(\s*demoCatalogRequested\(process\.env\),\s*probeMerchantData\(db, FIXTURE_CATALOG\.products\.map\(\(p\) => p\.id\)\),?\s*\)/,
    );
  });
});
