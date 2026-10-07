/**
 * Local catalog end to end below the UI: strict file → SQLite → live catalog → sale snapshot.
 * Synthetic Arabic data and fake prices only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startupCatalog } from "../../src/application/posService";
import { loadCatalog } from "../../src/domain/catalog";
import { IMPORT_HEADER } from "../../src/domain/catalogImport";
import { DomainError } from "../../src/domain/errors";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import { CSV_SOURCE, CatalogRepository, productIdFor } from "../../src/persistence/catalogRepository";
import { openDatabase } from "../../src/persistence/db";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const bytes = (...rows: string[]) => new TextEncoder().encode([IMPORT_HEADER.join(","), ...rows].join("\r\n") + "\r\n");
const FILE = bytes(
  "10,بيبسي 330 مل,,1.00,USD,piece,0",
  "11,مياه,Water,0.50,USD,piece,0",
  '12,"علبة بسكويت 2""",,12.00,USD,box,0',
  "13,شيبس,,0.01,USD,piece,1",
);
const pepsi = productIdFor(CSV_SOURCE, "10");
const screw = productIdFor(CSV_SOURCE, "12");

function imported(r: ReturnType<ReturnType<typeof makeHarness>["service"]["importCatalogCsv"]>) {
  if (r.status !== "imported") throw new Error(JSON.stringify(r));
  return r;
}

describe("local catalog import", () => {
  it("imports into SQLite, replaces the fixture at runtime, and Arabic survives byte-for-byte", () => {
    const h = makeHarness(t.dbPath);
    expect(h.service.getCatalog().byId.has("prod-0001")).toBe(true); // fixture before import
    const r = imported(h.service.importCatalogCsv("catalog.csv", FILE));
    expect(r).toMatchObject({ rowCount: 4, inserted: 4, updated: 0, unchanged: 0, deactivated: 0, placeholderPrices: 1 });

    const live = h.service.getCatalog();
    expect(live.byId.has("prod-0001")).toBe(false); // fixture gone
    expect(live.products.map((p) => [p.name, p.price.minor, p.sku, p.baseUnit, p.priceNeedsReview])).toEqual([
      ["بيبسي 330 مل", 100n, null, "piece", false],
      ["Water", 50n, null, "piece", false],
      ['علبة بسكويت 2"', 1200n, null, "box", false],
      ["شيبس", 1n, null, "piece", true],
    ]);
    const raw = h.db.prepare("SELECT name_ar, name_en, selling_price_minor FROM catalog_products WHERE id = ?").get(pepsi) as {
      name_ar: string;
      name_en: string | null;
      selling_price_minor: bigint;
    };
    expect(raw).toEqual({ name_ar: "بيبسي 330 مل", name_en: null, selling_price_minor: 100n });
    expect(Buffer.from(raw.name_ar, "utf8").equals(Buffer.from("بيبسي 330 مل", "utf8"))).toBe(true);
    h.db.close();
  });

  it("re-importing the same file changes nothing and duplicates nothing", () => {
    const h = makeHarness(t.dbPath);
    imported(h.service.importCatalogCsv("catalog.csv", FILE));
    const again = imported(h.service.importCatalogCsv("catalog.csv", FILE));
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 4, deactivated: 0 });
    const n = h.db.prepare("SELECT count(*) AS c FROM catalog_products").get() as { c: bigint };
    expect(n.c).toBe(4n);
    const runs = h.db.prepare("SELECT count(*) AS c FROM catalog_imports").get() as { c: bigint };
    expect(runs.c).toBe(2n);
    h.db.close();
  });

  it("a changed file updates by source_id and hides rows it no longer lists (never deletes)", () => {
    const h = makeHarness(t.dbPath);
    imported(h.service.importCatalogCsv("catalog.csv", FILE));
    const next = bytes("10,بيبسي 330 مل,,1.25,USD,piece,0", "11,مياه,Water,0.50,USD,piece,0", "13,شيبس,,2.00,USD,piece,0");
    expect(imported(h.service.importCatalogCsv("catalog.csv", next))).toMatchObject({
      inserted: 0,
      updated: 2,
      unchanged: 1,
      deactivated: 1,
      placeholderPrices: 0,
    });
    const live = h.service.getCatalog();
    expect(live.byId.get(pepsi)!.price.minor).toBe(125n);
    expect(live.byId.has(screw)).toBe(false);
    const hidden = h.db.prepare("SELECT is_active FROM catalog_products WHERE id = ?").get(screw) as { is_active: bigint };
    expect(hidden.is_active).toBe(0n);
    h.db.close();
  });

  it("one bad row refuses the whole file: nothing written, live catalog unchanged", () => {
    const h = makeHarness(t.dbPath);
    const r = h.service.importCatalogCsv("bad.csv", bytes("10,بيبسي 330 مل,,1.00,USD,piece,0", "11,مياه,,1.005,USD,piece,0"));
    expect(r).toEqual({ status: "rejected", rejected: [{ line: 3, reason: expect.stringMatching(/price/) }] });
    const n = h.db.prepare("SELECT count(*) AS c FROM catalog_products").get() as { c: bigint };
    expect(n.c).toBe(0n);
    expect(h.service.getCatalog().byId.has("prod-0001")).toBe(true);
    h.db.close();
  });

  it("import requires a logged-in cashier", () => {
    const h = makeHarness(t.dbPath, { login: false });
    expect(() => h.service.importCatalogCsv("catalog.csv", FILE)).toThrow(DomainError);
    h.db.close();
  });

  it("a sale of imported products snapshots the Arabic name; older fixture sales stay untouched", () => {
    const h = makeHarness(t.dbPath);
    const before = h.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [{ productId: "prod-0001", quantityMilli: 1000 }],
      expectedTotalMinor: 250n,
    }).sale;
    imported(h.service.importCatalogCsv("catalog.csv", FILE));
    const { sale } = h.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [
        { productId: pepsi, quantityMilli: 3000 },
        { productId: screw, quantityMilli: 2000 },
      ],
      expectedTotalMinor: 2700n,
    });
    expect(sale.lines.map((l) => [l.productName, l.sku, l.quantityMilli, l.unitPrice.minor, l.lineTotal.minor])).toEqual([
      ["بيبسي 330 مل", "", 3000, 100n, 300n],
      ['علبة بسكويت 2"', "", 2000, 1200n, 2400n],
    ]);
    expect(h.service.getSale(before.id).sale).toEqual(before); // history not rewritten
    expect(countRows(h.db)).toEqual({ sales: 2, lines: 3, voids: 0 });
    h.db.close();
  });

  it("after a restart the till starts on the local catalog, with the sale still in the ledger", () => {
    const h = makeHarness(t.dbPath);
    imported(h.service.importCatalogCsv("catalog.csv", FILE));
    h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: pepsi, quantityMilli: 1000 }], expectedTotalMinor: 100n });
    h.db.close();

    const db = openDatabase(t.dbPath);
    const start = startupCatalog(new CatalogRepository(db), loadCatalog(FIXTURE_CATALOG), "USD");
    expect(start.origin).toBe("local");
    expect(start.catalog.byId.get(pepsi)!.name).toBe("بيبسي 330 مل");
    expect(countRows(db).sales).toBe(1);
    db.close();
  });

  it("a fresh terminal (empty local catalog) starts on the bundled demo fixture", () => {
    const db = openDatabase(t.dbPath);
    const start = startupCatalog(new CatalogRepository(db), loadCatalog(FIXTURE_CATALOG), "USD");
    expect(start.origin).toBe("fixture");
    db.close();
  });

  it("the database itself refuses a float or zero price", () => {
    const db = openDatabase(t.dbPath);
    const insert = (price: unknown) =>
      db
        .prepare(
          `INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en, selling_price_minor, currency,
             base_unit, price_needs_review, is_active, created_at, updated_at)
           VALUES ('x', 's', 'k', NULL, 'مياه', NULL, ?, 'USD', 'piece', 0, 1, 'now', 'now')`,
        )
        .run(price);
    expect(() => insert(1.5)).toThrow();
    expect(() => insert(0)).toThrow();
    db.close();
  });
});

describe("importCatalog IPC handler", () => {
  it("takes no payload, needs a login, reads only the file the main-process dialog picked", () => {
    const h = makeHarness(t.dbPath, { login: false });
    let picks = 0;
    const ipc = createIpcHandlers(h.service, {
      pickCatalogFile: () => {
        picks += 1;
        return picks === 1 ? null : { name: "catalog.csv", bytes: FILE };
      },
    });
    expect(ipc.importCatalog(undefined)).toMatchObject({ ok: false, error: { code: "NOT_LOGGED_IN" } });
    expect(picks).toBe(0); // no dialog before login
    h.service.login("cashier-01", "1111");
    expect(ipc.importCatalog({ path: "C:\\anything.csv" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(ipc.importCatalog(undefined)).toEqual({ ok: true, data: { status: "cancelled" } });
    expect(ipc.importCatalog(undefined)).toMatchObject({ ok: true, data: { status: "imported", inserted: 4 } });
    const catalog = ipc.getCatalog(undefined);
    if (!catalog.ok) throw new Error("catalog");
    expect((catalog.data as { products: Array<{ name: string; sku: string | null }> }).products[0]).toMatchObject({
      name: "بيبسي 330 مل",
      sku: null,
    });
    h.db.close();
  });

  it("without a file picker (headless) import is unavailable", () => {
    const h = makeHarness(t.dbPath);
    expect(createIpcHandlers(h.service).importCatalog(undefined)).toMatchObject({ ok: false, error: { code: "NOT_AVAILABLE" } });
    h.db.close();
  });
});
