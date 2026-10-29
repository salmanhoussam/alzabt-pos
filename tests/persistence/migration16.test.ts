/**
 * Migration 16 — an invoice's optional customer-account link, added to a populated v15 ledger.
 *
 * Synthetic data only. The point is what DOES NOT change: no existing row, table, trigger or earlier
 * migration checksum may differ, and no historical invoice may gain a link or a debt.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { snapshotDatabase } from "../../src/persistence/backup";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";

const V15 = 15;
const V16 = 16;
const MIGRATIONS_V15 = MIGRATIONS.slice(0, V15);
// Migration 17 landed later; this file pins v16 as a historical target, so it runs the v16 registry.
const MIGRATIONS_V16 = MIGRATIONS.slice(0, V16);
let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type Row = Record<string, unknown>;
const OLD_TABLES = ["sales", "sale_lines", "voids", "invoices", "invoice_lines", "invoice_line_batches", "parties", "obligations", "settlements", "operators"];

const rows = (db: Db): Record<string, Row[]> =>
  Object.fromEntries(OLD_TABLES.map((n) => [n, db.prepare(`SELECT * FROM ${n} ORDER BY id`).all() as Row[]]));
const NEW_OBJECTS = ["invoices_customer_party_id", "invoices_customer_link_insert", "invoices_customer_link_update", "obligations_invoice_sale_match"];
const objects = (db: Db) =>
  (db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Row[]).filter((o) => !NEW_OBJECTS.includes(String(o.name)) && o.name !== "invoices");
const checksums = (db: Db) =>
  db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version <= 15 ORDER BY version").all() as Row[];

function seedV15(path: string): void {
  const db = openDatabase(path, MIGRATIONS_V15);
  try {
    const op = (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
    const at = "2026-10-22T09:00:00.000Z";
    const insert = db.prepare(
      `INSERT INTO invoices (id, status, invoice_number, invoice_date, currency, customer_name, subtotal_minor, tax_minor,
         total_minor, paid_minor, balance_due_minor, created_by_id, created_by_name, created_at, updated_at)
       VALUES (?, 'draft', NULL, NULL, 'USD', 'اسم حر', 1000, 0, 1000, 0, 1000, ?, 'مالك اختباري', ?, ?)`,
    );
    insert.run("inv-draft", op, at, at);
    insert.run("inv-final", op, at, at);
    db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, line_no, description, unit_label, canonical_unit, product_id,
         quantity_milli, unit_price_minor, line_total_minor, created_at)
       VALUES ('line-final', 'inv-final', 1, 'بند', 'قطعة', 'piece', NULL, 1000, 1000, 1000, ?)`,
    ).run(at);
    db.prepare(
      `UPDATE invoices SET status='final', invoice_number=5, invoice_date='2026-10-22', amount_in_words='مبلغ',
         issuer_snapshot_json='{"name":"متجر"}', finalized_at=? WHERE id='inv-final'`,
    ).run(at);
    for (const [id, kind] of [["cust-1", "customer"], ["sup-1", "supplier"]] as const) {
      db.prepare(
        `INSERT INTO parties (id, kind, display_name, is_active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, kind, id, op, at, at);
    }
  } finally {
    db.close();
  }
}

describe("migration 16 on a populated v15 ledger", () => {
  it("adds one NULL column and leaves every historical row, object and checksum untouched", () => {
    seedV15(t.dbPath);
    const pre = openDatabase(t.dbPath, MIGRATIONS_V15);
    const before = { rows: rows(pre), objects: objects(pre), sums: checksums(pre) };
    pre.close();

    const backup = `${t.dir}/pre-m16.sqlite`;
    const db = openDatabase(t.dbPath, MIGRATIONS_V16, {
      beforeMigrations: (conn, pending) => {
        expect(pending).toEqual({ fromVersion: V15, toVersion: V16 });
        snapshotDatabase(conn, backup);
      },
    });
    try {
      expect(schemaVersion(db)).toBe(V16);
      // Every historical row is identical once the new column is projected away.
      const after = rows(db);
      for (const table of OLD_TABLES) {
        const cols = Object.keys(before.rows[table]![0] ?? {});
        const projected = after[table]!.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
        expect(projected, table).toEqual(before.rows[table]);
      }
      // 🔴 No historical invoice is linked, and none gained a debt.
      expect(db.prepare("SELECT count(*) AS n FROM invoices WHERE customer_party_id IS NOT NULL").get()).toEqual({ n: 0n });
      expect(db.prepare("SELECT count(*) AS n FROM obligations").get()).toEqual({ n: 0n });
      expect(objects(db)).toEqual(before.objects);
      expect(checksums(db)).toEqual(before.sums); // M1–M15 byte-identical
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // The finalized invoice is still immutable, including its (NULL) link.
      expect(() => db.prepare("UPDATE invoices SET customer_party_id = 'cust-1' WHERE id = 'inv-final'").run()).toThrow();
      // The draft may be linked to a customer but never to a supplier.
      db.prepare("UPDATE invoices SET customer_party_id = 'cust-1' WHERE id = 'inv-draft'").run();
      expect(() => db.prepare("UPDATE invoices SET customer_party_id = 'sup-1' WHERE id = 'inv-draft'").run()).toThrow(/active customer/);
    } finally {
      db.close();
    }
    const restored = openDatabase(backup, MIGRATIONS_V15, { fileMustExist: true });
    try {
      expect(schemaVersion(restored)).toBe(V15);
      expect(rows(restored)).toEqual(before.rows);
    } finally {
      restored.close();
    }
  });

  it("rolls a failed migration back completely", () => {
    seedV15(t.dbPath);
    const failed = { ...MIGRATIONS[V15]!, sql: `${MIGRATIONS[V15]!.sql}\nINSERT INTO deliberately_missing_m16 VALUES (1);` };
    expect(() => openDatabase(t.dbPath, [...MIGRATIONS_V15, failed])).toThrow(/deliberately_missing_m16/);
    const db = openDatabase(t.dbPath, MIGRATIONS_V15);
    try {
      expect(schemaVersion(db)).toBe(V15);
      const cols = db.pragma("table_info('invoices')") as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).not.toContain("customer_party_id");
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'obligations_invoice_sale_match'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("a fresh install reaches v16 and reopening does not migrate again", () => {
    const fresh = openDatabase(`${t.dir}/fresh.sqlite`, MIGRATIONS_V16);
    try {
      expect(schemaVersion(fresh)).toBe(V16);
      expect(fresh.pragma("foreign_key_check")).toEqual([]);
      expect((fresh.pragma("table_info('invoices')") as Array<{ name: string }>).map((c) => c.name)).toContain("customer_party_id");
    } finally {
      fresh.close();
    }
    let calls = 0;
    openDatabase(`${t.dir}/fresh.sqlite`, MIGRATIONS_V16, { beforeMigrations: () => void (calls += 1) }).close();
    expect(calls).toBe(0);
  });
});
