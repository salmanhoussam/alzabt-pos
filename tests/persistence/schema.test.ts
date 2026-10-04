import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { openDatabase, schemaVersion } from "../../src/persistence/db";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

describe("migrations", () => {
  it("creates the schema at version 1 with WAL and FULL sync, and is idempotent on reopen", () => {
    const db = openDatabase(t.dbPath);
    expect(schemaVersion(db)).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2n); // FULL
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
    db.close();
    const again = openDatabase(t.dbPath);
    expect(schemaVersion(again)).toBe(1);
    again.close();
  });

  it("refuses to open a database whose applied migration was edited", () => {
    openDatabase(t.dbPath).close();
    const tampered = [{ ...MIGRATIONS[0]!, sql: MIGRATIONS[0]!.sql + "\n-- edited" }];
    expect(() => openDatabase(t.dbPath, tampered)).toThrow(/does not match/);
  });

  it("refuses to open a database newer than this build", () => {
    const future = [...MIGRATIONS, { version: 2, name: "future", sql: "CREATE TABLE future_t (x INTEGER) STRICT;" }];
    openDatabase(t.dbPath, future).close();
    expect(() => openDatabase(t.dbPath)).toThrow(/newer than this build/);
  });
});

describe("ledger constraints enforced by SQLite itself", () => {
  it("a STRICT money column rejects a floating-point value", () => {
    const { db, service } = makeHarness(t.dbPath);
    const { sale } = service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: "prod-0001", quantity: 1 }],
      paymentMethod: "cash",
      expectedTotalMinor: 250n,
    });
    // Insert a crafted header directly with a REAL total: the database refuses the type.
    expect(() =>
      db
        .prepare(
          `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, cashier_id, cashier_name,
            currency, subtotal_minor, total_minor, payment_method, line_count, business_date, completed_at, created_at)
           VALUES ('x', 99, 'raw-key-0001', 'f', 'c', 'n', 'USD', 2.5, 2.5, 'cash', 1, '2026-10-04', 't', 't')`,
        )
        .run(),
    ).toThrow(/cannot store REAL value in INTEGER column/);
    expect(countRows(db).sales).toBe(1);
    expect(sale.total.minor).toBe(250n);
    db.close();
  });

  it("UPDATE and DELETE on sales, sale lines and voids are aborted by triggers", () => {
    const { db, service } = makeHarness(t.dbPath);
    const { sale } = service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: "prod-0002", quantity: 2 }],
      paymentMethod: "card",
      expectedTotalMinor: 750n,
    });
    service.voidSale(sale.id, "customer changed mind");
    expect(() => db.prepare("UPDATE sales SET total_minor = 1 WHERE id = ?").run(sale.id)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM sales WHERE id = ?").run(sale.id)).toThrow(/cannot be deleted/);
    expect(() => db.prepare("UPDATE sale_lines SET quantity = 9").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM sale_lines").run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare("UPDATE voids SET reason = 'other'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM voids").run()).toThrow(/cannot be deleted/);
    expect(countRows(db)).toEqual({ sales: 1, lines: 1, voids: 1 });
    db.close();
  });

  it("a line cannot be appended to an already-complete sale", () => {
    const { db, service } = makeHarness(t.dbPath);
    const { sale } = service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: "prod-0001", quantity: 1 }],
      paymentMethod: "cash",
      expectedTotalMinor: 250n,
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_lines (id, sale_id, line_no, product_id, sku, product_name, quantity, unit_price_minor, line_total_minor)
           VALUES ('extra', ?, 2, 'prod-0001', 'COF-ESP', 'Espresso', 1, 250, 250)`,
        )
        .run(sale.id),
    ).toThrow(/already holds all of its lines/);
    db.close();
  });

  it("a line total that is not quantity x unit price is rejected", () => {
    const { db } = makeHarness(t.dbPath);
    db.exec("PRAGMA foreign_keys = OFF"); // isolate the CHECK from the FK
    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_lines (id, sale_id, line_no, product_id, sku, product_name, quantity, unit_price_minor, line_total_minor)
           VALUES ('l', 's', 1, 'p', 'S', 'n', 3, 199, 598)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });
});
