/**
 * Migration 5 — the durable audit trail, v4 to v5.
 *
 * What this file proves: the migration is purely additive, migrations 1-4 are byte-identical after
 * it, a real v4 ledger keeps every sale, line, void and product, the table/indexes/triggers are
 * really there, a fault mid-migration leaves the database at v4, an older build refuses a v5 ledger
 * without writing a byte, and — deliberately — the trail starts EMPTY. No history is fabricated.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Db,
  MigrationMismatchError,
  SchemaNewerThanAppError,
  openDatabase,
  schemaVersion,
} from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { type TempDir, tempDir } from "../helpers/harness";

const V4 = 4;
/** Migration 5 is this file's subject, so it always migrates to EXACTLY v5, never to latest. */
const V5 = 5;

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const checksum = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");

const objects = (db: Db, type: string, tbl: string) =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name")
      .all(type, tbl) as Array<{ name: string }>
  ).map((r) => r.name);

const count = (db: Db, table: string) =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);

/** A real v4 ledger: two sales (one fractional), one void, and two products. */
function v4Ledger(): { sales: number; lines: number; voids: number; products: number } {
  const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V4));
  try {
    expect(schemaVersion(db)).toBe(V4);
    const sales = new SaleRepository(db);
    const store = new CatalogRepository(db);
    const at = "2026-10-05T09:00:00.000Z";
    store.createManual(
      { nameAr: "صنف ألف", nameEn: "Item A", sku: "SYN-A", priceMinor: 400n, currency: "USD", baseUnit: "piece" },
      new Date(at),
    );
    store.createManual(
      { nameAr: "صنف باء", nameEn: null, sku: null, priceMinor: 250n, currency: "USD", baseUnit: "kg" },
      new Date(at),
    );
    sales.commitSale(
      {
        id: "sale-1",
        idempotencyKey: "v4-key-00000001",
        requestFingerprint: "fp-1",
        cashierId: "cashier-01",
        cashierName: "Cashier One",
        currency: "USD",
        subtotalMinor: 1200n,
        totalMinor: 1200n,
        paymentMethod: "cash",
        businessDate: "2026-10-05",
        completedAt: at,
        createdAt: at,
      },
      [
        {
          id: "line-1",
          lineNo: 1,
          productId: "manual:000001",
          sku: "SYN-A",
          productName: "Item A",
          saleUnit: "piece",
          quantityMilli: 3000,
          unitPriceMinor: 400n,
          lineTotalMinor: 1200n,
        },
      ],
    );
    sales.commitSale(
      {
        id: "sale-2",
        idempotencyKey: "v4-key-00000002",
        requestFingerprint: "fp-2",
        cashierId: "cashier-01",
        cashierName: "Cashier One",
        currency: "USD",
        subtotalMinor: 625n,
        totalMinor: 625n,
        paymentMethod: "card",
        businessDate: "2026-10-05",
        completedAt: at,
        createdAt: at,
      },
      [
        {
          id: "line-2",
          lineNo: 1,
          productId: "manual:000002",
          sku: "",
          productName: "صنف باء",
          saleUnit: "kg",
          // 2.5 kg at 2.50 -> exactly 6.25
          quantityMilli: 2500,
          unitPriceMinor: 250n,
          lineTotalMinor: 625n,
        },
      ],
    );
    sales.insertVoid({
      id: "void-1",
      saleId: "sale-2",
      cashierId: "cashier-01",
      cashierName: "Cashier One",
      reason: "wrong item rung up",
      businessDate: "2026-10-05",
      createdAt: at,
    });
    return {
      sales: count(db, "sales"),
      lines: count(db, "sale_lines"),
      voids: count(db, "voids"),
      products: count(db, "catalog_products"),
    };
  } finally {
    db.close();
  }
}

describe("migration 5 — v4 to v5", () => {
  it("is the fifth migration, and it touches no earlier table", () => {
    // Was exactly [1, 2, 3, 4, 5] until migration 6 (manual_invoices) was appended. Migration 5's
    // own position and content are what this file is about, and neither moved.
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(MIGRATIONS[4]!.name).toBe("durable_local_audit");
    // Migration 6 is additive and must not reach into this one's table either.
    expect(MIGRATIONS[5]!.name).toBe("manual_invoices");
    expect(MIGRATIONS[5]!.sql).not.toMatch(/audit_events/i);
    const sql = MIGRATIONS[4]!.sql;
    // Additive means additive: nothing alters, drops or even mentions an existing business table.
    for (const forbidden of [
      /ALTER TABLE/i,
      /DROP TABLE/i,
      /\bsales\b/i,
      /sale_lines/i,
      /\bvoids\b/i,
      /catalog_products/i,
      /catalog_imports/i,
      /cashier_pin_state/i,
    ]) {
      expect(sql, String(forbidden)).not.toMatch(forbidden);
    }
    // And it inserts nothing: the trail is prospective, never reconstructed.
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
  });

  it("migrations 1-4 are byte-identical to the checksums they shipped with", () => {
    expect(MIGRATIONS.slice(0, 4).map((m) => checksum(m.sql))).toEqual([
      "3645a90293c7bd41e1cbb2ca4a07eedceb0063cbf01bf73d96305d86bcb311a7",
      "a139fc00efc55f625eb5547f9dd443de8dc151d029207176c6c412c56ef2522d",
      "ff4937c627b296eee07c19b17c8e2f44de1d0bb40c569d70fec0716adf63a4c4",
      "39be2c5e5250ee2ad3b86455b6d9b1a4a66aee60d90ef14d50bc2e7abc63f045",
    ]);
  });

  it("a real v4 ledger reaches v5 with every sale, line, void and product intact", () => {
    const before = v4Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V5), { fileMustExist: true });
    try {
      expect(schemaVersion(db)).toBe(V5);
      expect({
        sales: count(db, "sales"),
        lines: count(db, "sale_lines"),
        voids: count(db, "voids"),
        products: count(db, "catalog_products"),
      }).toEqual(before);
      // Migration 4's own behaviour is untouched: exact thousandths, and the sale unit snapshot.
      const line = db
        .prepare("SELECT quantity_milli, sale_unit, line_total_minor FROM sale_lines WHERE id = 'line-2'")
        .get() as { quantity_milli: bigint; sale_unit: string; line_total_minor: bigint };
      expect(line.quantity_milli).toBe(2500n);
      expect(line.sale_unit).toBe("kg");
      expect(line.line_total_minor).toBe(625n);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
      // And the recorded migration list is exactly 1..5, in order, with migration 5 last.
      expect(
        (db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
          version: bigint;
          name: string;
        }>).map((r) => [Number(r.version), r.name]),
      ).toEqual([
        [1, "initial_ledger"],
        [2, "cashier_pin_lockout"],
        [3, "local_catalog"],
        [4, "exact_sale_quantity"],
        [5, "durable_local_audit"],
      ]);
    } finally {
      db.close();
    }
  });

  it("🔴 the audit trail starts EMPTY — no pre-v5 history is invented", () => {
    v4Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V5), { fileMustExist: true });
    try {
      expect(count(db, "audit_events")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("creates the table, exactly four indexes and exactly three triggers", () => {
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V5));
    try {
      expect(
        (db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>).map((c) => c.name),
      ).toEqual([
        "id",
        "seq",
        "event_type",
        "entity_type",
        "entity_id",
        "actor_id",
        "actor_name",
        "actor_tier",
        "occurred_at",
        "business_date",
        "changed_json",
        "metadata_json",
        "app_version",
        "schema_version",
      ]);
      // STRICT: SQLite itself refuses a value of the wrong type in any column.
      expect(
        (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events'").get() as { sql: string }).sql,
      ).toMatch(/\)\s*STRICT$/);
      expect(objects(db, "index", "audit_events").filter((n) => !n.startsWith("sqlite_"))).toEqual([
        "audit_events_actor",
        "audit_events_date",
        "audit_events_entity",
        "audit_events_type",
      ]);
      expect(objects(db, "trigger", "audit_events")).toEqual([
        "audit_events_immutable_delete",
        "audit_events_immutable_update",
        "audit_events_seq_monotonic",
      ]);
    } finally {
      db.close();
    }
  });

  it("a fault while migrating leaves the database at v4 with no audit table", () => {
    v4Ledger();
    const broken = [...MIGRATIONS.slice(0, V4), { ...MIGRATIONS[4]!, sql: `${MIGRATIONS[4]!.sql}\nSELECT this_is_not_sql();` }];
    expect(() => openDatabase(t.dbPath, broken, { fileMustExist: true })).toThrow();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V4), { fileMustExist: true });
    try {
      expect(schemaVersion(db)).toBe(V4);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'audit_events'").get()).toBeUndefined();
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("🔴 an older build refuses a v5 ledger and does not write one byte", () => {
    v4Ledger();
    openDatabase(t.dbPath, MIGRATIONS.slice(0, V5), { fileMustExist: true }).close();
    const bytesBefore = readFileSync(t.dbPath);
    const sizeBefore = statSync(t.dbPath).size;

    expect(() => openDatabase(t.dbPath, MIGRATIONS.slice(0, V4), { fileMustExist: true })).toThrow(
      SchemaNewerThanAppError,
    );

    expect(statSync(t.dbPath).size).toBe(sizeBefore);
    expect(readFileSync(t.dbPath).equals(bytesBefore)).toBe(true);
  });

  it("an edited migration 5 is refused rather than silently diverging", () => {
    openDatabase(t.dbPath, MIGRATIONS.slice(0, V5)).close();
    const edited = [
      ...MIGRATIONS.slice(0, V4),
      { ...MIGRATIONS[4]!, sql: MIGRATIONS[4]!.sql.replace("audit_events_actor", "audit_events_actor_x") },
    ];
    expect(() => openDatabase(t.dbPath, edited, { fileMustExist: true })).toThrow(MigrationMismatchError);
  });

  it("opening an already-v5 ledger applies nothing and changes no checksum", () => {
    openDatabase(t.dbPath, MIGRATIONS.slice(0, V5)).close();
    const first = openDatabase(t.dbPath, MIGRATIONS.slice(0, V5), { fileMustExist: true });
    const rows = first.prepare("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version").all();
    first.close();
    const second = openDatabase(t.dbPath, MIGRATIONS.slice(0, V5), { fileMustExist: true });
    try {
      expect(
        second.prepare("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version").all(),
      ).toEqual(rows);
      expect(schemaVersion(second)).toBe(V5);
    } finally {
      second.close();
    }
  });

  it("a fresh install reaches v5 directly, with an empty trail", () => {
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V5));
    try {
      expect(schemaVersion(db)).toBe(V5);
      expect(count(db, "audit_events")).toBe(0);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  });
});
