/**
 * Migration 4 — the single-table rebuild of sale_lines.
 *
 * Everything here runs against a ledger whose rows were written in the OLD shape by raw SQL
 * (tests/helpers/legacyLedger.ts), because a ledger written through today's repository is not a
 * legacy ledger at all.
 *
 * Synthetic data only: no merchant name, price or invoice appears anywhere.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadCatalog } from "../../src/domain/catalog";
import { MAX_QUANTITY_MILLI, MAX_UNIT_PRICE_MINOR } from "../../src/domain/quantity";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { insertLegacySale, insertLegacyVoid, seedLegacyLedger } from "../helpers/legacyLedger";
import { type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/** The schema version migration 4 upgrades FROM. */
const V3 = 3;
/** Migration 4 is the subject here, so this file always migrates to EXACTLY v4, never to latest. */
const V4 = 4;

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

/** A v3 ledger holding two legacy sales and a void, closed and ready to be upgraded. */
function legacyV3Ledger(): void {
  const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V3));
  expect(schemaVersion(db)).toBe(V3);
  seedLegacyLedger(db);
  db.close();
}

const lines = (db: Db) =>
  db
    .prepare(
      `SELECT id, sale_id, line_no, product_id, sku, product_name, sale_unit,
              quantity_milli, unit_price_minor, line_total_minor
         FROM sale_lines ORDER BY sale_id, line_no`,
    )
    .all() as Array<Record<string, unknown>>;

const columns = (db: Db) =>
  (db.prepare("PRAGMA table_info(sale_lines)").all() as Array<{ name: string }>).map((c) => c.name);

const triggers = (db: Db) =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sale_lines' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

describe("migration 4 — v3 to v4", () => {
  it("is the fourth migration, and 1-3 are not touched by it", () => {
    // Was exactly [1, 2, 3, 4] until migration 5 (durable_local_audit) was appended. Migration 4's
    // own position and content are what this file is about, and neither moved.
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect(MIGRATIONS[3]!.name).toBe("exact_sale_quantity");
    // Migration 5 is additive and must not reach into this one's table either.
    expect(MIGRATIONS[4]!.name).toBe("durable_local_audit");
    expect(MIGRATIONS[4]!.sql).not.toMatch(/sale_lines/i);
    // Nothing in migration 4's own SQL alters an earlier table's definition.
    for (const forbidden of [/ALTER TABLE sales\b/i, /DROP TABLE sales\b/i, /catalog_products/i, /cashier_pin_state/i]) {
      expect(MIGRATIONS[3]!.sql, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("converts every whole quantity to thousandths and preserves every other value", () => {
    legacyV3Ledger();
    const before = (() => {
      const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V3), { fileMustExist: true });
      const rows = db
        .prepare("SELECT id, sale_id, line_no, product_id, sku, product_name, quantity, unit_price_minor, line_total_minor FROM sale_lines ORDER BY sale_id, line_no")
        .all() as Array<Record<string, unknown>>;
      const sales = db.prepare("SELECT id, receipt_number, total_minor, subtotal_minor FROM sales ORDER BY receipt_number").all();
      db.close();
      return { rows, sales };
    })();

    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V4), { fileMustExist: true });
    expect(schemaVersion(db)).toBe(V4);
    const after = lines(db);

    expect(after).toHaveLength(before.rows.length);
    expect(after).toHaveLength(3); // two sales, three lines
    after.forEach((row, i) => {
      const old = before.rows[i]!;
      expect(row.id, "line id").toBe(old.id);
      expect(row.sale_id, "sale id").toBe(old.sale_id);
      expect(row.line_no).toBe(old.line_no);
      expect(row.product_id, "product id").toBe(old.product_id);
      expect(row.sku, "sku snapshot").toBe(old.sku);
      expect(row.product_name, "name snapshot").toBe(old.product_name);
      expect(row.unit_price_minor, "unit price").toBe(old.unit_price_minor);
      // 🔴 the total is COPIED, never recomputed from today's catalog
      expect(row.line_total_minor, "line total").toBe(old.line_total_minor);
      expect(Number(row.quantity_milli)).toBe(Number(old.quantity) * 1000);
    });

    // the quantities themselves, named
    expect(after.map((r) => Number(r.quantity_milli))).toEqual([3000, 1000, 7000]);

    // headers and the void are untouched
    expect(db.prepare("SELECT id, receipt_number, total_minor, subtotal_minor FROM sales ORDER BY receipt_number").all()).toEqual(before.sales);
    expect(db.prepare("SELECT count(*) AS n FROM voids").get()).toEqual({ n: 1n });
    db.close();
  });

  it("leaves the historical unit UNKNOWN rather than inventing one", () => {
    legacyV3Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    expect(lines(db).map((r) => r.sale_unit)).toEqual([null, null, null]);
    db.close();
  });

  it("replaces the quantity column rather than keeping both", () => {
    legacyV3Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    const cols = columns(db);
    expect(cols).toContain("quantity_milli");
    expect(cols).toContain("sale_unit");
    expect(cols).not.toContain("quantity");
    // one table, not two, and no compatibility view
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sale_lines_v4'").get()).toEqual({ n: 0n });
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'view'").get()).toEqual({ n: 0n });
    db.close();
  });

  it("leaves the database structurally sound, with foreign keys still on", () => {
    legacyV3Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(Number(db.pragma("foreign_keys", { simple: true }))).toBe(1);
    db.close();
  });

  it("recreates the index and all four triggers", () => {
    legacyV3Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    expect(triggers(db)).toEqual([
      "sale_lines_closed_sale",
      "sale_lines_immutable_delete",
      "sale_lines_immutable_update",
      "sale_lines_require_unit",
    ]);
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sale_lines' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toEqual(["sale_lines_sale_id"]);
    db.close();
  });

  it("still refuses UPDATE and DELETE on a migrated line", () => {
    legacyV3Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    expect(() => db.prepare("UPDATE sale_lines SET quantity_milli = 1000").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM sale_lines").run()).toThrow(/cannot be deleted/);
    expect(lines(db)).toHaveLength(3);
    db.close();
  });

  it("a crash part-way through the migration leaves the v3 table exactly as it was", () => {
    legacyV3Ledger();
    // A fifth migration that fails AFTER migration 4 has run inside its own transaction proves the
    // per-migration boundary; to prove migration 4's OWN rollback, corrupt its final step instead.
    const broken = [
      ...MIGRATIONS.slice(0, 3),
      { ...MIGRATIONS[3]!, sql: `${MIGRATIONS[3]!.sql}\nSELECT raise_that_does_not_exist();` },
    ];
    expect(() => openDatabase(t.dbPath, broken, { fileMustExist: true })).toThrow();

    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V3), { fileMustExist: true });
    expect(schemaVersion(db)).toBe(V3);
    const cols = columns(db);
    expect(cols).toContain("quantity");
    expect(cols).not.toContain("quantity_milli");
    expect(cols).not.toContain("sale_unit");
    const rows = db.prepare("SELECT id, quantity FROM sale_lines ORDER BY sale_id, line_no").all() as Array<{ id: string; quantity: bigint }>;
    expect(rows.map((r) => Number(r.quantity))).toEqual([3, 1, 7]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sale_lines_v4'").get()).toEqual({ n: 0n });
    expect(triggers(db)).toEqual([
      "sale_lines_closed_sale",
      "sale_lines_immutable_delete",
      "sale_lines_immutable_update",
    ]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("an impossible legacy quantity makes the migration FAIL loudly instead of writing a bad row", () => {
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V3));
    // 9999 units is the maximum, so 10000 cannot be scaled into range. The old schema allowed it.
    insertLegacySale(db, {
      id: "legacy-huge",
      receiptNumber: 1,
      lines: [{ productId: "p", sku: "SYN", productName: "Huge", quantity: 10_000, unitPriceMinor: 1 }],
    });
    db.close();
    expect(() => openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true })).toThrow(/CHECK constraint failed/);
    // and the ledger is still readable at v3, unharmed
    const after = openDatabase(t.dbPath, MIGRATIONS.slice(0, V3), { fileMustExist: true });
    expect(schemaVersion(after)).toBe(V3);
    expect(columns(after)).toContain("quantity");
    after.close();
  });
});

describe("the v4 constraints the database enforces itself", () => {
  const openFresh = () => {
    seq = 0;
    const db = openDatabase(t.dbPath, MIGRATIONS);
    db.exec(
      `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, cashier_id, cashier_name,
                          currency, subtotal_minor, total_minor, payment_method, line_count, business_date,
                          completed_at, created_at)
       VALUES ('s1', 1, 'syn-key-00000001', 'f', 'c1', 'Cashier One', 'USD', 0, 0, 'cash', 50, '2026-10-07', 't', 't')`,
    );
    return db;
  };
  let seq = 0;
  const insert = (db: Db, over: Partial<Record<string, unknown>> = {}) => {
    seq += 1;
    const row = {
      id: `l-${seq}`,
      sale_id: "s1",
      line_no: seq,
      product_id: "p",
      sku: "SYN",
      product_name: "Synthetic",
      sale_unit: "piece",
      quantity_milli: 1000,
      unit_price_minor: 400,
      line_total_minor: 400,
      ...over,
    };
    db.prepare(
      `INSERT INTO sale_lines (id, sale_id, line_no, product_id, sku, product_name, sale_unit,
                               quantity_milli, unit_price_minor, line_total_minor)
       VALUES (@id, @sale_id, @line_no, @product_id, @sku, @product_name, @sale_unit,
               @quantity_milli, @unit_price_minor, @line_total_minor)`,
    ).run(row);
  };

  it("refuses a NEW line that does not say which unit it was sold in", () => {
    const db = openFresh();
    expect(() => insert(db, { sale_unit: null })).toThrow(/must record the unit it was sold in/);
    db.close();
  });

  it("accepts a fraction on kg and meter", () => {
    const db = openFresh();
    expect(() => insert(db, { sale_unit: "kg", quantity_milli: 2500, unit_price_minor: 400, line_total_minor: 1000 })).not.toThrow();
    expect(() => insert(db, { sale_unit: "meter", quantity_milli: 3125, unit_price_minor: 320, line_total_minor: 1000 })).not.toThrow();
    db.close();
  });

  it("refuses a fraction on every whole-only unit, and on an unknown one (fails closed)", () => {
    const db = openFresh();
    for (const unit of ["piece", "box", "pack", "other", "litre"]) {
      expect(
        () => insert(db, { sale_unit: unit, quantity_milli: 2500, unit_price_minor: 400, line_total_minor: 1000 }),
        unit,
      ).toThrow(/CHECK constraint failed/);
    }
    db.close();
  });

  it("refuses a quantity of zero, and one above the maximum", () => {
    const db = openFresh();
    expect(() => insert(db, { quantity_milli: 0, line_total_minor: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, { quantity_milli: MAX_QUANTITY_MILLI + 1, unit_price_minor: 1, line_total_minor: 10_000 })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      insert(db, { quantity_milli: MAX_QUANTITY_MILLI, unit_price_minor: 1, line_total_minor: 9999 }),
    ).not.toThrow();
    db.close();
  });

  it("refuses a unit price above the overflow ceiling, and accepts the ceiling itself", () => {
    const db = openFresh();
    expect(() =>
      insert(db, {
        quantity_milli: 1000,
        unit_price_minor: Number(MAX_UNIT_PRICE_MINOR) + 1,
        line_total_minor: Number(MAX_UNIT_PRICE_MINOR) + 1,
      }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert(db, {
        quantity_milli: 1000,
        unit_price_minor: Number(MAX_UNIT_PRICE_MINOR),
        line_total_minor: Number(MAX_UNIT_PRICE_MINOR),
      }),
    ).not.toThrow();
    db.close();
  });

  it("admits exactly one line total, the half-up one", () => {
    const db = openFresh();
    // 0.333 x 15.00 -> 499.5 -> 500, and nothing else is accepted
    expect(() => insert(db, { sale_unit: "kg", quantity_milli: 333, unit_price_minor: 1500, line_total_minor: 500 })).not.toThrow();
    for (const wrong of [499, 501, 0]) {
      expect(
        () => insert(db, { sale_unit: "kg", quantity_milli: 333, unit_price_minor: 1500, line_total_minor: wrong }),
        String(wrong),
      ).toThrow(/CHECK constraint failed/);
    }
    db.close();
  });
});

describe("a fractional sale, through the whole application", () => {
  it("records exact thousandths and the unit, and both survive a restart", () => {
    // A synthetic kg product: 2.500 at 4.00 = 10.00
    const source = {
      currency: "USD",
      products: [
        { id: "syn-kg", sku: "SYN-KG", name: "Rope", price: "4.00", baseUnit: "kg" },
        { id: "syn-pc", sku: "SYN-PC", name: "Bolt", price: "0.75", baseUnit: "piece" },
      ],
    };
    const h = makeHarness(t.dbPath, { catalog: loadCatalog(source) });
    h.service.login("cashier-01", "1111");
    const { sale } = h.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [
        { productId: "syn-kg", quantityMilli: 2500 },
        { productId: "syn-pc", quantityMilli: 3000 },
      ],
      expectedTotalMinor: 1225n, // 1000 + 225
    });
    expect(sale.lines.map((l) => [l.quantityMilli, l.saleUnit, l.lineTotal.minor])).toEqual([
      [2500, "kg", 1000n],
      [3000, "piece", 225n],
    ]);
    expect(sale.total.minor).toBe(1225n);
    const receiptNumber = sale.receiptNumber;
    h.db.close();

    // Restart: a new connection, a new service, the same file.
    const again = makeHarness(t.dbPath, { catalog: loadCatalog(source) });
    const reread = again.service.getSale(sale.id).sale;
    expect(reread.lines.map((l) => [l.quantityMilli, l.saleUnit, l.lineTotal.minor])).toEqual([
      [2500, "kg", 1000n],
      [3000, "piece", 225n],
    ]);
    expect(reread.total.minor).toBe(1225n);
    expect(reread.receiptNumber).toBe(receiptNumber);
    again.db.close();
  });

  it("refuses a fraction of a whole-only product, and records nothing", () => {
    const source = { currency: "USD", products: [{ id: "syn-pc", sku: "SYN-PC", name: "Bolt", price: "0.75", baseUnit: "piece" }] };
    const h = makeHarness(t.dbPath, { catalog: loadCatalog(source) });
    h.service.login("cashier-01", "1111");
    expect(() =>
      h.service.createSale({
        idempotencyKey: newKey(),
        paymentMethod: "cash",
        lines: [{ productId: "syn-pc", quantityMilli: 2500 }],
        expectedTotalMinor: 188n,
      }),
    ).toThrow(/whole units/);
    expect(h.db.prepare("SELECT count(*) AS n FROM sales").get()).toEqual({ n: 0n });
    h.db.close();
  });

  it("refuses a line that would round to nothing, and records nothing", () => {
    // 0.001 kg at 0.04 = 0.00004 -> 0 minor units.
    const source = { currency: "USD", products: [{ id: "syn-kg", sku: "SYN-KG", name: "Sand", price: "0.04", baseUnit: "kg" }] };
    const h = makeHarness(t.dbPath, { catalog: loadCatalog(source) });
    h.service.login("cashier-01", "1111");
    expect(() =>
      h.service.createSale({
        idempotencyKey: newKey(),
        paymentMethod: "cash",
        lines: [{ productId: "syn-kg", quantityMilli: 1 }],
        expectedTotalMinor: 0n,
      }),
    ).toThrow(/rounds to zero/);
    expect(h.db.prepare("SELECT count(*) AS n FROM sales").get()).toEqual({ n: 0n });
    h.db.close();
  });

  it("a legacy sale keeps its unknown unit while a new sale carries one, in the same ledger", () => {
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V3));
    insertLegacySale(db, {
      id: "legacy-1",
      receiptNumber: 1,
      lines: [{ productId: "p-old", sku: "SYN-OLD", productName: "Older", quantity: 2, unitPriceMinor: 300 }],
    });
    insertLegacyVoid(db, "legacy-1");
    db.close();

    const source = { currency: "USD", products: [{ id: "syn-kg", sku: "SYN-KG", name: "Rope", price: "4.00", baseUnit: "kg" }] };
    const h = makeHarness(t.dbPath, { catalog: loadCatalog(source) });
    h.service.login("cashier-01", "1111");
    const { sale } = h.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [{ productId: "syn-kg", quantityMilli: 1500 }],
      expectedTotalMinor: 600n,
    });

    // Ordered by receipt number, so this reads chronologically rather than by row id.
    const all = h.db
      .prepare(
        `SELECT l.sale_unit, l.quantity_milli
           FROM sale_lines l JOIN sales s ON s.id = l.sale_id
          ORDER BY s.receipt_number, l.line_no`,
      )
      .all() as Array<{ sale_unit: string | null; quantity_milli: bigint }>;
    expect(all.map((r) => [r.sale_unit, Number(r.quantity_milli)])).toEqual([
      [null, 2000], // the legacy line: unknown unit, 2 units scaled
      ["kg", 1500], // the new line: its unit recorded
    ]);
    // the receipt sequence continued rather than restarting
    expect(sale.receiptNumber).toBe(2);
    expect(h.db.prepare("SELECT count(*) AS n FROM voids").get()).toEqual({ n: 1n });
    h.db.close();
  });
});

describe("idempotency keys off the exact quantity", () => {
  const source = { currency: "USD", products: [{ id: "syn-kg", sku: "SYN-KG", name: "Rope", price: "4.00", baseUnit: "kg" }] };

  it("the same request retried returns the same sale, not a second one", () => {
    const h = makeHarness(t.dbPath, { catalog: loadCatalog(source) });
    h.service.login("cashier-01", "1111");
    const key = newKey();
    const first = h.service.createSale({
      idempotencyKey: key,
      paymentMethod: "cash",
      lines: [{ productId: "syn-kg", quantityMilli: 2500 }],
      expectedTotalMinor: 1000n,
    });
    const retry = h.service.createSale({
      idempotencyKey: key,
      paymentMethod: "cash",
      lines: [{ productId: "syn-kg", quantityMilli: 2500 }],
      expectedTotalMinor: 1000n,
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.sale.id).toBe(first.sale.id);
    expect(h.db.prepare("SELECT count(*) AS n FROM sales").get()).toEqual({ n: 1n });
    h.db.close();
  });

  it("a DIFFERENT quantity under the same key is a conflict — 2.5 and 2.501 cannot collide", () => {
    const h = makeHarness(t.dbPath, { catalog: loadCatalog(source) });
    h.service.login("cashier-01", "1111");
    const key = newKey();
    h.service.createSale({
      idempotencyKey: key,
      paymentMethod: "cash",
      lines: [{ productId: "syn-kg", quantityMilli: 2500 }],
      expectedTotalMinor: 1000n,
    });
    expect(() =>
      h.service.createSale({
        idempotencyKey: key,
        paymentMethod: "cash",
        lines: [{ productId: "syn-kg", quantityMilli: 2501 }],
        expectedTotalMinor: 1000n,
      }),
    ).toThrow(/already used for a different sale/);
    h.db.close();
  });
});
