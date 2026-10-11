/**
 * Offline product management at the persistence layer — and the proof that it needed NO schema
 * change. Migration 3's `catalog_products` already carried every column a product editor writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogRepository, MANUAL_SOURCE } from "../../src/persistence/catalogRepository";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type Db, openDatabase } from "../../src/persistence/db";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const NOW = new Date("2026-10-07T09:00:00.000Z");
const LATER = new Date("2026-10-07T10:00:00.000Z");

function repo(): CatalogRepository {
  return new CatalogRepository(db);
}

const wrench = {
  nameAr: "مفتاح أحمر",
  nameEn: "Red Wrench",
  sku: "SKU-001",
  priceMinor: 400n,
  currency: "USD",
  baseUnit: "piece",
};

// ── The schema proof ────────────────────────────────────────────────────────────────────────────
//
// Offline product management added no migration, and these tests are what makes that claim
// checkable instead of stated: every later addition fails them BY NAME, and the reviewer sees it.
//
// 🔴 AND THAT IS EXACTLY WHAT HAPPENED, TWICE. Migration 8 (operator accounts) moved the list, and
// migration 9 (product_master) is the first to touch THIS FILE'S OWN TABLE — five additive columns
// on `catalog_products`. The describe title said "schema is unchanged by this feature" and still
// does, because "this feature" is product administration, not the schema in general; the two tests
// below now state what changed, when, and what must STILL be absent.

describe("schema is unchanged by this feature", () => {
  it("has exactly nine migrations, and offline product management still contributed none of them", () => {
    // Was three until migration 4 (exact_sale_quantity), four until migration 5
    // (durable_local_audit), five until migration 6 (manual_invoices), and six until migration 7
    // (invoice_sales_integration), and seven until migration 8 (operator_accounts).
    // Product administration itself still adds no migration — that is
    // what this file proves, and 1-3 below are byte-identical to the ones it shipped against. This
    // list failing by name on every addition is the whole point of the test, not a nuisance.
    expect(MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, "initial_ledger"],
      [2, "cashier_pin_lockout"],
      [3, "local_catalog"],
      [4, "exact_sale_quantity"],
      [5, "durable_local_audit"],
      [6, "manual_invoices"],
      [7, "invoice_sales_integration"],
      [8, "operator_accounts"],
      [9, "product_master"],
    ]);
  });

  it("catalog_products has migration 3's columns PLUS migration 9's six — no more, no fewer", () => {
    const columns = (db.prepare("PRAGMA table_info(catalog_products)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toEqual([
      "id",
      "source",
      "source_key",
      "sku",
      "name_ar",
      "name_en",
      "selling_price_minor",
      "currency",
      "base_unit",
      "price_needs_review",
      "is_active",
      "created_at",
      "updated_at",
      // 🔴 TRANSITION — migration 9 (product_master). This list ended at `updated_at` until then.
      // All five are additive and nullable-or-defaulted, so every existing product keeps selling
      // the moment the migration lands: online content is enrichment, never a precondition.
      "category_id",
      // 🔴 TRANSITION within migration 9 itself: barcode was approved into it while it was still
      // unmerged, rather than becoming a migration 10 for one adjacent Product Master field.
      "barcode",
      "brand",
      "description_ar",
      "description_en",
      "is_online_visible",
    ]);
    // Named explicitly, because each one is a documented follow-up PR rather than an oversight.
    // 🔴 `category_id`, `barcode` and `description` all LEFT this list — the first two because
    // they now exist, and `description` because it never will under that bare name: the approved
    // model is one description PER LANGUAGE, so a bare `description` column appearing would mean
    // somebody had reintroduced the short+long shape the study rejected.
    //
    // `stock_qty` staying absent is the one that matters most: inventory is a separate business
    // domain, and a quantity column arriving here is how a POS quietly becomes a stock system.
    for (const absent of ["description", "unit_needs_review", "stock_qty", "image_url", "barcodes"]) {
      expect(columns, `${absent} must still be absent`).not.toContain(absent);
    }
  });

  it("the sales ledger carries the migration-4 quantity, and nothing product administration added", () => {
    const lineColumns = (db.prepare("PRAGMA table_info(sale_lines)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // This assertion is REVERSED from the one offline product management shipped, which read
    // `toContain("quantity")` / `not.toContain("quantity_milli")`. Migration 4 rebuilt the table:
    // the whole-unit column is gone and the exact one replaced it.
    expect(lineColumns).toContain("quantity_milli");
    expect(lineColumns).not.toContain("quantity");
    expect(lineColumns).toContain("sale_unit");
    // Still nothing a product-administration feature would have needed.
    for (const absent of ["category_id", "barcode", "discount_minor", "tax_minor"]) {
      expect(lineColumns, `${absent} must still be absent`).not.toContain(absent);
    }
  });
});

describe("createManual", () => {
  it("stores the product under the manual source with a padded sequential key", () => {
    const row = repo().createManual(wrench, NOW);
    expect(row.source).toBe(MANUAL_SOURCE);
    expect(row.source_key).toBe("000001");
    expect(row.id).toBe("manual:000001");
    expect(row.name_ar).toBe("مفتاح أحمر");
    expect(row.name_en).toBe("Red Wrench");
    expect(row.selling_price_minor).toBe(400n);
    expect(row.base_unit).toBe("piece");
    expect(row.is_active).toBe(1n);
    // A typed price is a real price, never a placeholder.
    expect(row.price_needs_review).toBe(0n);
    expect(row.created_at).toBe(NOW.toISOString());
  });

  it("numbers further products without reusing a key, and sorts 10 after 9", () => {
    const r = repo();
    for (let i = 0; i < 10; i += 1) {
      r.createManual({ ...wrench, sku: `SKU-${i}`, nameAr: `صنف ${i}` }, NOW);
    }
    const keys = r.listAll().map((p) => p.source_key);
    expect(keys).toEqual(["000001", "000002", "000003", "000004", "000005", "000006", "000007", "000008", "000009", "000010"]);
  });

  it("the database refuses a duplicate SKU — the guard is not only in code", () => {
    const r = repo();
    r.createManual(wrench, NOW);
    expect(() => r.createManual({ ...wrench, nameAr: "آخر" }, NOW)).toThrow(/UNIQUE|constraint/i);
  });

  it("the database refuses a zero or negative price", () => {
    expect(() => repo().createManual({ ...wrench, priceMinor: 0n }, NOW)).toThrow(/CHECK|constraint/i);
  });
});

describe("updateProduct and setActive", () => {
  it("edits the editable fields and leaves identity alone", () => {
    const r = repo();
    const created = r.createManual(wrench, NOW);
    const edited = r.updateProduct(
      created.id,
      { nameAr: "مفتاح أخضر", nameEn: null, sku: "SKU-002", priceMinor: 550n, baseUnit: "kg", isActive: true },
      LATER,
    );
    expect(edited.id).toBe(created.id);
    expect(edited.source).toBe(created.source);
    expect(edited.source_key).toBe(created.source_key);
    expect(edited.name_ar).toBe("مفتاح أخضر");
    expect(edited.name_en).toBeNull();
    expect(edited.sku).toBe("SKU-002");
    expect(edited.selling_price_minor).toBe(550n);
    expect(edited.base_unit).toBe("kg");
    expect(edited.created_at).toBe(NOW.toISOString());
    expect(edited.updated_at).toBe(LATER.toISOString());
  });

  it("deactivates without deleting, and can reactivate", () => {
    const r = repo();
    const created = r.createManual(wrench, NOW);
    expect(r.setActive(created.id, false, LATER).is_active).toBe(0n);
    expect(r.listAll()).toHaveLength(1);
    expect(r.loadActiveSource("USD")).toBeNull();
    expect(r.setActive(created.id, true, LATER).is_active).toBe(1n);
    expect(r.loadActiveSource("USD")?.products).toHaveLength(1);
  });

  it("an inactive product is absent from the sellable catalog but present in administration", () => {
    const r = repo();
    const a = r.createManual(wrench, NOW);
    r.createManual({ ...wrench, sku: "SKU-002", nameAr: "شفرة" }, NOW);
    r.setActive(a.id, false, LATER);
    expect(r.listAll()).toHaveLength(2);
    expect(r.loadActiveSource("USD")?.products.map((p) => p.id)).toEqual(["manual:000002"]);
  });
});

describe("persistence", () => {
  it("survives a restart — the row is on disk, not in memory", () => {
    repo().createManual(wrench, NOW);
    db.close();
    db = openDatabase(t.dbPath);
    const rows = repo().listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name_ar).toBe("مفتاح أحمر");
    expect(rows[0]!.selling_price_minor).toBe(400n);
  });
});
