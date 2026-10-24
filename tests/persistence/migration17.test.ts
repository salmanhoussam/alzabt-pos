/**
 * Migration 17 — collection details on settlements, added to a populated v16 ledger.
 *
 * Synthetic data only. What must NOT change: every historical settlement, obligation, invoice and
 * earlier-migration checksum; and what must hold afterwards: the database itself refuses an
 * inconsistent method/provider/reference shape and a repeated provider reference.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { snapshotDatabase } from "../../src/persistence/backup";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";

const V16 = 16;
const V17 = 17;
const MIGRATIONS_V16 = MIGRATIONS.slice(0, V16);
let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type Row = Record<string, unknown>;
const TABLES = ["settlements", "obligations", "parties", "sales", "invoices", "operators"];
const rows = (db: Db): Record<string, Row[]> =>
  Object.fromEntries(TABLES.map((n) => [n, db.prepare(`SELECT * FROM ${n} ORDER BY id`).all() as Row[]]));
const checksums = (db: Db) =>
  db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version <= 16 ORDER BY version").all() as Row[];
const NEW_OBJECTS = [
  "settlements_provider_reference",
  "settlements_collection_shape",
  "collection_attempts",
  "collection_attempts_open",
  "collection_attempts_resolve_once",
  "collection_attempts_no_delete",
  "settlements_closed_collection_attempt",
];
const objects = (db: Db) =>
  (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Row[])
    .filter((o) => !NEW_OBJECTS.includes(String(o.name)) && o.name !== "settlements");

function seedV16(path: string): void {
  const db = openDatabase(path, MIGRATIONS_V16);
  try {
    const op = (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
    const at = "2026-10-22T09:00:00.000Z";
    db.prepare(
      "INSERT INTO parties (id, kind, display_name, is_active, created_by, created_at, updated_at) VALUES ('cust-1','customer','زبون',1,?,?,?)",
    ).run(op, at, at);
    db.prepare(
      `INSERT INTO obligations (id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency, amount_minor, posted_by, posted_at, business_date)
       VALUES ('o1','cust-1','customer','receivable','manual','FIX-1',NULL,'USD',5000,?,?,'2026-10-22')`,
    ).run(op, at);
    const ins = db.prepare(
      `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date)
       VALUES (?, 'o1', 'USD', ?, 'fp', ?, ?, ?, ?, '2026-10-22')`,
    );
    ins.run("s-cash", "hist-key-0001", 1000, "cash", op, at);
    ins.run("s-ext", "hist-key-0002", 500, "external", op, at); // an old 'external' with no provider
  } finally {
    db.close();
  }
}

describe("migration 17 on a populated v16 ledger", () => {
  it("adds three NULL columns and leaves every historical row, object and checksum untouched", () => {
    seedV16(t.dbPath);
    const pre = openDatabase(t.dbPath, MIGRATIONS_V16);
    const before = { rows: rows(pre), objects: objects(pre), sums: checksums(pre) };
    pre.close();

    const backup = `${t.dir}/pre-m17.sqlite`;
    const db = openDatabase(t.dbPath, MIGRATIONS, {
      beforeMigrations: (conn, pending) => {
        expect(pending).toEqual({ fromVersion: V16, toVersion: V17 });
        snapshotDatabase(conn, backup);
      },
    });
    try {
      expect(schemaVersion(db)).toBe(V17);
      const after = rows(db);
      for (const table of TABLES) {
        const cols = Object.keys(before.rows[table]![0] ?? {});
        const projected = after[table]!.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
        expect(projected, table).toEqual(before.rows[table]);
      }
      // 🔴 Every historical settlement keeps NULL details — an old 'external' is NOT retro-labelled Whish.
      const s = db.prepare("SELECT id, method, provider, reference, funds_confirmed FROM settlements ORDER BY id").all();
      expect(s).toEqual([
        { id: "s-cash", method: "cash", provider: null, reference: null, funds_confirmed: null },
        { id: "s-ext", method: "external", provider: null, reference: null, funds_confirmed: null },
      ]);
      expect(objects(db)).toEqual(before.objects);
      expect(checksums(db)).toEqual(before.sums); // M1–M16 byte-identical
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(() => db.prepare("UPDATE settlements SET reference = 'x'").run()).toThrow(/immutable/);
    } finally {
      db.close();
    }
    const restored = openDatabase(backup, MIGRATIONS_V16, { fileMustExist: true });
    try {
      expect(schemaVersion(restored)).toBe(V16);
      expect(rows(restored)).toEqual(before.rows);
    } finally {
      restored.close();
    }
  });

  it("🔴 the database itself refuses an inconsistent collection shape and a repeated provider reference", () => {
    seedV16(t.dbPath);
    const db = openDatabase(t.dbPath, MIGRATIONS);
    try {
      const op = (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
      const at = "2026-10-22T10:00:00.000Z";
      const insert = (key: string, method: string, provider: string | null, reference: string | null, confirmed: number | null) =>
        db
          .prepare(
            `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, provider, reference, funds_confirmed, settled_by, settled_at, business_date)
             VALUES (?, 'o1', 'USD', ?, 'fp', 100, ?, ?, ?, ?, ?, ?, '2026-10-22')`,
          )
          .run(`id-${key}`, key, method, provider, reference, confirmed, op, at);
      expect(() => insert("key-shape-0001", "cash", "whish", "R", 1)).toThrow(/inconsistent/); // provider on cash
      expect(() => insert("key-shape-0002", "external", "whish", null, 1)).toThrow(/inconsistent/); // no reference
      expect(() => insert("key-shape-0003", "external", "whish", "R", null)).toThrow(/inconsistent/); // no confirmation
      expect(() => insert("key-shape-0004", "cash", null, "R", null)).toThrow(/inconsistent/); // cash with a reference
      expect(() => insert("key-shape-0005", "external", "paypal", "R", 1)).toThrow(); // unknown provider
      expect(() => insert("key-shape-0006", "external", "whish", "x".repeat(65), 1)).toThrow(); // too long
      expect(() => insert("key-shape-0007", "external", "whish", " padded", 1)).toThrow(); // not trimmed
      expect(() => insert("key-shape-0008", "external", "whish", "R", 2)).toThrow(); // confirmation is 1 or NULL
      insert("key-shape-0009", "external", "whish", "WH-1", 1);
      expect(() => insert("key-shape-0010", "external", "whish", "WH-1", 1)).toThrow(/UNIQUE/i);
      insert("key-shape-0011", "external", "bank_transfer", "WH-1", 1); // the rule is per provider
      insert("key-shape-0012", "card", null, "WH-1", null);
    } finally {
      db.close();
    }
  });

  it("🔴 collection_attempts starts empty, is bookkeeping only, and cannot be edited or deleted", () => {
    seedV16(t.dbPath);
    const db = openDatabase(t.dbPath, MIGRATIONS);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM collection_attempts").get()).toEqual({ n: 0n });
      const op = (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
      const insert = (key: string, channel: string, amount: number, ref: string | null = null, conf: number | null = null) =>
        db
          .prepare(
            `INSERT INTO collection_attempts (idempotency_key, customer_id, obligation_id, currency, amount_minor, channel, reference, funds_confirmed, request_fingerprint, created_by, created_at)
             VALUES (?, 'cust-1', 'o1', 'USD', ?, ?, ?, ?, 'fp', ?, '2026-10-24T08:00:00.000Z')`,
          )
          .run(key, amount, channel, ref, conf, op);
      insert("attempt-key-001", "whish", 100, "WH-1", 1);
      expect(() => insert("attempt-key-002", "credit", 100)).toThrow(); // not a channel
      expect(() => insert("attempt-key-003", "cash", 0)).toThrow(); // not positive
      expect(() => insert("short", "cash", 100)).toThrow(); // key length
      expect(() => insert("attempt-key-004", "cash", 100, " padded")).toThrow();
      expect(() => db.prepare("UPDATE collection_attempts SET amount_minor = 1").run()).toThrow(/resolved, once/);
      expect(() => db.prepare("UPDATE collection_attempts SET resolved_at = 'now'").run()).toThrow(); // CHECK pairs both
      db.prepare("UPDATE collection_attempts SET resolved_at = '2026-10-24T09:00:00.000Z', resolution = 'recorded'").run();
      expect(() => db.prepare("UPDATE collection_attempts SET resolution = 'not_recorded'").run()).toThrow(/resolved, once/);
      expect(() => db.prepare("DELETE FROM collection_attempts").run()).toThrow(/cannot be deleted/);
      // It never touches money: the ledger tables are exactly as seeded.
      expect(db.prepare("SELECT count(*) AS n FROM settlements").get()).toEqual({ n: 2n });
    } finally {
      db.close();
    }
  });

  it("rolls a failed migration back completely", () => {
    seedV16(t.dbPath);
    const failed = { ...MIGRATIONS[V16]!, sql: `${MIGRATIONS[V16]!.sql}\nINSERT INTO deliberately_missing_m17 VALUES (1);` };
    expect(() => openDatabase(t.dbPath, [...MIGRATIONS_V16, failed])).toThrow(/deliberately_missing_m17/);
    const db = openDatabase(t.dbPath, MIGRATIONS_V16);
    try {
      expect(schemaVersion(db)).toBe(V16);
      expect((db.pragma("table_info('settlements')") as Array<{ name: string }>).map((c) => c.name)).not.toContain("provider");
    } finally {
      db.close();
    }
  });

  it("a fresh install reaches v17 and reopening does not migrate again", () => {
    const fresh = openDatabase(`${t.dir}/fresh.sqlite`);
    try {
      expect(schemaVersion(fresh)).toBe(V17);
      expect(fresh.pragma("foreign_key_check")).toEqual([]);
      expect((fresh.pragma("table_info('settlements')") as Array<{ name: string }>).map((c) => c.name)).toEqual(
        expect.arrayContaining(["provider", "reference", "funds_confirmed"]),
      );
    } finally {
      fresh.close();
    }
    let calls = 0;
    openDatabase(`${t.dir}/fresh.sqlite`, MIGRATIONS, { beforeMigrations: () => void (calls += 1) }).close();
    expect(calls).toBe(0);
  });
});
