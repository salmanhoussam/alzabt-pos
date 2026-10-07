/**
 * Offline product management through the service — including the two properties that matter most
 * to a shop: an edit today never touches an invoice from yesterday, and a deactivated product
 * cannot be sold.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PosService } from "../../src/application/posService";
import type { AuditRow } from "../../src/domain/audit";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { TestClock, type TempDir, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
let service: PosService;
/** The DIAGNOSTIC mirror. The record of truth is `trail`, read back out of SQLite. */
let mirrored: AuditRow[];
/** The durable trail itself, on the same connection the service writes through. */
let trail: AuditRepository;
let clock: TestClock;

function build(): void {
  mirrored = [];
  clock = new TestClock();
  trail = new AuditRepository(db, { appVersion: "test", schemaVersion: MIGRATIONS.length });
  service = new PosService({
    repository: new SaleRepository(db),
    pinStates: new PinStateRepository(db),
    catalog: loadCatalog(FIXTURE_CATALOG),
    catalogStore: new CatalogRepository(db),
    auditStore: trail,
    transact: (fn) => db.transaction(fn).immediate(),
    cashiers: FIXTURE_CASHIERS,
    terminal: FIXTURE_TERMINAL,
    now: clock.now,
    audit: (row) => mirrored.push(row),
  });
  service.login("cashier-01", "1111");
}

/** Every stored event, oldest first — `seq` order, which is the only ordering authority. */
const stored = (): AuditRow[] => trail.listRecent(500).reverse();

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
  build();
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const draft = { nameAr: "مفتاح أحمر", nameEn: "Red Wrench", sku: "SKU-001", price: "4.00", baseUnit: "piece" };

describe("createProduct", () => {
  it("creates a product and makes it immediately sellable", () => {
    const row = service.createProduct(draft);
    expect(row.id).toBe("manual:000001");
    // The live catalog was refreshed, so the Sell screen and checkout see it at once.
    expect(service.getCatalog().byId.get(row.id)?.name).toBe("Red Wrench");
    const sale = service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: row.id, quantityMilli: 2000 }],
      paymentMethod: "cash",
      expectedTotalMinor: 800n,
    });
    expect(sale.sale.total.minor).toBe(800n);
  });

  it("an Arabic name is enough — English, SKU and an image are not required", () => {
    const row = service.createProduct({ nameAr: "مسامير", nameEn: null, sku: null, price: "6.50", baseUnit: "box" });
    expect(row.name_ar).toBe("مسامير");
    expect(row.name_en).toBeNull();
    expect(row.sku).toBeNull();
    // displayName falls back to the Arabic name — no translation is ever invented.
    expect(service.getCatalog().byId.get(row.id)?.name).toBe("مسامير");
  });

  it("refuses a duplicate SKU with a business error, not a database crash", () => {
    service.createProduct(draft);
    expect(() => service.createProduct({ ...draft, nameAr: "آخر" })).toThrow(/already uses the SKU/);
  });

  it("refuses an invalid price and writes nothing", () => {
    expect(() => service.createProduct({ ...draft, price: "4,00" })).toThrow();
    expect(service.listProducts()).toHaveLength(0);
  });

  it("refuses an unknown unit", () => {
    expect(() => service.createProduct({ ...draft, baseUnit: "litre" })).toThrow(/not a unit/);
  });

  it("requires a logged-in operator", () => {
    service.logout();
    expect(() => service.createProduct(draft)).toThrow(/logged in/);
  });

  it("writes a DURABLE audit event naming the actor — no PIN, no secret", () => {
    const row = service.createProduct(draft);
    const events = stored();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.event_type).toBe("PRODUCT_CREATED");
    expect(event.actor_id).toBe("cashier-01");
    expect(event.actor_name).toBe(FIXTURE_CASHIERS[0]!.name);
    // 🔴 This build has no role model, so it records that it does not know, rather than guessing.
    expect(event.actor_tier).toBe("unspecified");
    expect(event.entity_id).toBe(row.id);
    expect(event.entity_type).toBe("product");
    expect(event.seq).toBe(1);
    // The whole audited state, every `before` null — the same shape an edit uses.
    expect(JSON.parse(event.changed_json)).toEqual({
      base_unit: { before: null, after: "piece" },
      currency: { before: null, after: "USD" },
      is_active: { before: null, after: true },
      name_ar: { before: null, after: "مفتاح أحمر" },
      name_en: { before: null, after: "Red Wrench" },
      price_needs_review: { before: null, after: false },
      selling_price_minor: { before: null, after: "400" },
      sku: { before: null, after: "SKU-001" },
    });
    expect(JSON.parse(event.metadata_json!)).toEqual({ origin: "manual_entry", source: "manual" });
    const serialised = JSON.stringify(event);
    for (const secret of ["pin", "Pin", "PIN", "hash", "token", "1111"]) {
      expect(serialised, `audit must not contain '${secret}'`).not.toContain(secret);
    }
    // The diagnostic mirror saw the same committed row; it is a copy, not the record.
    expect(mirrored.map((m) => m.id)).toEqual([event.id]);
  });
});

describe("updateProduct", () => {
  it("saves the edit and reprices the live catalog", () => {
    const row = service.createProduct(draft);
    const edited = service.updateProduct(row.id, { ...draft, price: "5.00", nameAr: "مفتاح أخضر" }, true);
    expect(edited.selling_price_minor).toBe(500n);
    expect(service.getCatalog().byId.get(row.id)?.price.minor).toBe(500n);
  });

  it("🔴 a later price and name change does NOT alter an earlier sale's snapshot", () => {
    const row = service.createProduct(draft);
    const sold = service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: row.id, quantityMilli: 3000 }],
      paymentMethod: "cash",
      expectedTotalMinor: 1200n,
    });
    const before = service.getSale(sold.sale.id).sale;

    service.updateProduct(row.id, { nameAr: "اسم جديد", nameEn: "New Name", sku: "SKU-999", price: "99.00", baseUnit: "kg" }, true);

    const after = service.getSale(sold.sale.id).sale;
    expect(after.lines[0]!.productName).toBe(before.lines[0]!.productName);
    expect(after.lines[0]!.sku).toBe(before.lines[0]!.sku);
    expect(after.lines[0]!.unitPrice.minor).toBe(400n);
    expect(after.lines[0]!.lineTotal.minor).toBe(1200n);
    expect(after.total.minor).toBe(1200n);
    expect(after).toEqual(before);
  });

  /**
   * 🔴 CONTRACT CHANGE, migration 5. Earlier builds emitted THREE events for one edit —
   * PRICE_CHANGED, UNIT_CHANGED and PRODUCT_UPDATED — to the rotating logfile. In a durable table
   * that is two rows restating what the third already carries, and it double-counts in any "how
   * many changes today" question. One user action is now exactly one PRODUCT_UPDATED row; the price
   * and the unit are fields inside its diff.
   */
  it("one edit is ONE PRODUCT_UPDATED row, however many fields moved", () => {
    const row = service.createProduct(draft);
    service.updateProduct(row.id, { ...draft, price: "7.00", baseUnit: "kg", nameEn: "Green Wrench" }, true);
    const events = stored();
    expect(events.map((e) => e.event_type)).toEqual(["PRODUCT_CREATED", "PRODUCT_UPDATED"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    // Exactly the fields that moved, no others, keys sorted, money as a decimal string.
    expect(events[1]!.changed_json).toBe(
      JSON.stringify({
        base_unit: { before: "piece", after: "kg" },
        name_en: { before: "Red Wrench", after: "Green Wrench" },
        selling_price_minor: { before: "400", after: "700" },
      }),
    );
  });

  it("a price that did not change is not in the diff", () => {
    const row = service.createProduct(draft);
    service.updateProduct(row.id, { ...draft, nameEn: "Wrench" }, true);
    const diff = JSON.parse(stored()[1]!.changed_json) as Record<string, unknown>;
    expect(Object.keys(diff)).toEqual(["name_en"]);
  });

  it("an edit that changes nothing writes NO audit row", () => {
    service.createProduct(draft);
    expect(stored()).toHaveLength(1);
    const row = service.listProducts()[0]!;
    service.updateProduct(row.id, draft, true);
    expect(stored()).toHaveLength(1);
  });

  it("refuses a SKU already used by a different product, but allows keeping its own", () => {
    const a = service.createProduct(draft);
    service.createProduct({ ...draft, nameAr: "ثانٍ", sku: "SKU-002" });
    expect(() => service.updateProduct(a.id, { ...draft, sku: "SKU-002" }, true)).toThrow(/already uses the SKU/);
    expect(service.updateProduct(a.id, { ...draft, price: "4.50" }, true).selling_price_minor).toBe(450n);
  });

  it("refuses an unknown product id", () => {
    expect(() => service.updateProduct("manual:999999", draft, true)).toThrow(/no longer exists/);
  });
});

describe("deactivation", () => {
  it("a deactivated product cannot be sold, and is still listed for administration", () => {
    const row = service.createProduct(draft);
    service.createProduct({ ...draft, nameAr: "ثانٍ", sku: "SKU-002" });
    service.setProductActive(row.id, false);
    expect(service.listProducts()).toHaveLength(2);
    expect(service.getCatalog().byId.has(row.id)).toBe(false);
    expect(() =>
      service.createSale({
        idempotencyKey: newKey(),
        lines: [{ productId: row.id, quantityMilli: 1000 }],
        paymentMethod: "cash",
        expectedTotalMinor: 400n,
      }),
    ).toThrow(/Unknown product/);
  });

  it("a product sold before being deactivated keeps its sale intact", () => {
    const row = service.createProduct(draft);
    const sold = service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: row.id, quantityMilli: 1000 }],
      paymentMethod: "cash",
      expectedTotalMinor: 400n,
    });
    service.setProductActive(row.id, false);
    const after = service.getSale(sold.sale.id).sale;
    expect(after.lines[0]!.productName).toBe("Red Wrench");
    expect(after.lines[0]!.unitPrice.minor).toBe(400n);
  });

  it("deactivating the last product falls back to the bundled fixture, never a stale list", () => {
    const row = service.createProduct(draft);
    expect(service.getCatalog().products).toHaveLength(1);
    service.setProductActive(row.id, false);
    expect(service.getCatalog().products.map((p) => p.id)).toEqual(FIXTURE_CATALOG.products.map((p) => p.id));
  });

  it("records who deactivated it, durably", () => {
    const row = service.createProduct(draft);
    service.setProductActive(row.id, false);
    const e = stored()[1]!;
    expect(e.event_type).toBe("PRODUCT_DEACTIVATED");
    expect(e.actor_name).toBe(FIXTURE_CASHIERS[0]!.name);
    expect(JSON.parse(e.changed_json)).toEqual({ is_active: { before: true, after: false } });
  });

  it("a toggle to the state it is already in writes no event", () => {
    const row = service.createProduct(draft);
    service.setProductActive(row.id, true);
    expect(stored()).toHaveLength(1);
  });
});

describe("imported catalogs stay compatible", () => {
  const csv = [
    "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review",
    "7,صنف مستورد ألف,,1.30,USD,piece,0",
    "8,صنف مستورد باء,,3.40,USD,box,1",
  ].join("\n");

  it("an imported product can be edited, and the import's own rows keep their identity", () => {
    const result = service.importCatalogCsv("catalog.csv", new TextEncoder().encode(csv));
    expect(result.status).toBe("imported");
    const imported = service.listProducts().filter((p) => p.source === "merchant-csv");
    expect(imported).toHaveLength(2);

    const edited = service.updateProduct(
      imported[0]!.id,
      { nameAr: imported[0]!.name_ar, nameEn: "Imported A", sku: null, price: "1.45", baseUnit: "kg" },
      true,
    );
    expect(edited.source).toBe("merchant-csv");
    expect(edited.source_key).toBe("7");
    expect(edited.selling_price_minor).toBe(145n);
  });

  it("a manual product and an imported one coexist without colliding", () => {
    service.importCatalogCsv("catalog.csv", new TextEncoder().encode(csv));
    const manual = service.createProduct(draft);
    expect(manual.source).toBe("manual");
    expect(service.listProducts()).toHaveLength(3);
    expect(service.getCatalog().products).toHaveLength(3);
  });

  it("🔴 a re-import never touches a manual product", () => {
    service.importCatalogCsv("catalog.csv", new TextEncoder().encode(csv));
    const manual = service.createProduct(draft);
    // A second import listing only row 7: row 8 is deactivated, the manual product is not.
    const smaller = ["source_id,name_ar,name_en,price,currency,base_unit,price_needs_review", "7,صنف مستورد ألف,,1.30,USD,piece,0"].join("\n");
    service.importCatalogCsv("catalog2.csv", new TextEncoder().encode(smaller));
    const rows = service.listProducts();
    expect(rows.find((p) => p.id === manual.id)!.is_active).toBe(1n);
    expect(rows.find((p) => p.source_key === "8")!.is_active).toBe(0n);
  });

  it("a placeholder price imported as price_needs_review stays flagged and sellable", () => {
    service.importCatalogCsv("catalog.csv", new TextEncoder().encode(csv));
    const flagged = service.listProducts().find((p) => p.source_key === "8")!;
    expect(flagged.price_needs_review).toBe(1n);
    expect(service.getCatalog().byId.get(flagged.id)?.priceNeedsReview).toBe(true);
  });
});
