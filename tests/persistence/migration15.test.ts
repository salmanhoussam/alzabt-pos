/**
 * Migration 15 — the durable identity of an invoice-line batch, added to a populated v14 ledger.
 *
 * Every fixture is synthetic. The point is what DOES NOT change: no existing table, trigger, row or
 * earlier migration checksum may differ after the upgrade.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { snapshotDatabase } from "../../src/persistence/backup";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";

const V14 = 14;
const V15 = 15;
const MIGRATIONS_V14 = MIGRATIONS.slice(0, V14);
let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type Row = Record<string, unknown>;
const OLD_TABLES = ["sales", "sale_lines", "voids", "invoices", "invoice_lines", "parties", "obligations", "settlements", "operators"];

const rows = (db: Db): Record<string, Row[]> =>
  Object.fromEntries(OLD_TABLES.map((n) => [n, db.prepare(`SELECT * FROM ${n} ORDER BY id`).all() as Row[]]));
const objects = (db: Db) =>
  db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'invoice_line_batches%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Row[];
const checksums = (db: Db) =>
  db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version <= 14 ORDER BY version").all() as Row[];

function seedV14(path: string): void {
  const db = openDatabase(path, MIGRATIONS_V14);
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
    for (const id of ["inv-draft", "inv-final"]) {
      db.prepare(
        `INSERT INTO invoice_lines (id, invoice_id, line_no, description, unit_label, canonical_unit, product_id,
           quantity_milli, unit_price_minor, line_total_minor, created_at)
         VALUES (?, ?, 1, 'بند', 'قطعة', 'piece', NULL, 1000, 1000, 1000, ?)`,
      ).run(`line-${id}`, id, at);
    }
    db.prepare(
      `UPDATE invoices SET status='final', invoice_number=701, invoice_date='2026-10-22', amount_in_words='مبلغ',
         issuer_snapshot_json='{"name":"متجر"}', finalized_at=? WHERE id='inv-final'`,
    ).run(at);
  } finally {
    db.close();
  }
}

describe("migration 15 on a populated v14 ledger", () => {
  it("adds exactly one empty table and changes nothing else", () => {
    seedV14(t.dbPath);
    const pre = openDatabase(t.dbPath, MIGRATIONS_V14);
    const before = { rows: rows(pre), objects: objects(pre), sums: checksums(pre) };
    pre.close();

    const backup = `${t.dir}/pre-m15.sqlite`;
    const db = openDatabase(t.dbPath, MIGRATIONS, {
      beforeMigrations: (conn, pending) => {
        expect(pending).toEqual({ fromVersion: V14, toVersion: V15 });
        snapshotDatabase(conn, backup);
      },
    });
    try {
      expect(schemaVersion(db)).toBe(V15);
      expect(rows(db)).toEqual(before.rows);
      expect(objects(db)).toEqual(before.objects);
      expect(checksums(db)).toEqual(before.sums); // M1–M14 byte-identical
      expect(db.prepare("SELECT count(*) AS n FROM invoice_line_batches").get()).toEqual({ n: 0n });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // The final invoice is still immutable, and the draft still accepts a batch.
      expect(() => db.prepare("UPDATE invoices SET notes = 'x' WHERE id = 'inv-final'").run()).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO invoice_line_batches (id, invoice_id, idempotency_key, request_fingerprint, line_count, created_at) VALUES ('b1','inv-final','batch-key-0001',?,1,'t')",
          )
          .run("a".repeat(64)),
      ).toThrow(/only be recorded on a draft/);
    } finally {
      db.close();
    }
    const restored = openDatabase(backup, MIGRATIONS_V14, { fileMustExist: true });
    try {
      expect(schemaVersion(restored)).toBe(V14);
      expect(rows(restored)).toEqual(before.rows);
    } finally {
      restored.close();
    }
  });

  it("rolls a failed migration back completely", () => {
    seedV14(t.dbPath);
    const failed = { ...MIGRATIONS[V14]!, sql: `${MIGRATIONS[V14]!.sql}\nINSERT INTO deliberately_missing_m15 VALUES (1);` };
    expect(() => openDatabase(t.dbPath, [...MIGRATIONS_V14, failed])).toThrow(/deliberately_missing_m15/);
    const db = openDatabase(t.dbPath, MIGRATIONS_V14);
    try {
      expect(schemaVersion(db)).toBe(V14);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'invoice_line_batches'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("a fresh install reaches v15 and reopening does not migrate again", () => {
    const fresh = openDatabase(`${t.dir}/fresh.sqlite`);
    try {
      expect(schemaVersion(fresh)).toBe(V15);
      expect(fresh.pragma("foreign_key_check")).toEqual([]);
    } finally {
      fresh.close();
    }
    let calls = 0;
    const again = openDatabase(`${t.dir}/fresh.sqlite`, MIGRATIONS, { beforeMigrations: () => void (calls += 1) });
    expect(calls).toBe(0);
    again.close();
  });
});
