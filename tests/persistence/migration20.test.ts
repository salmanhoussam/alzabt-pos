/**
 * Migration 20 (`advance_safety_attempts_voids`, DRAFT part 1 — the durable intent). Upgrade safety:
 *
 *   1 v19 → v20 on a ledger that already holds a v19-era advance: every row unchanged, checksums of
 *     1–19 unchanged, the new table empty, the backup list knows it
 *   2 the existing (pre-intent) advance keeps working: an owner cash refund is still accepted
 *   3 from v20 on, a NEW advance without its intent is refused, even by direct SQL
 *   4 a v19 build refuses a v20 ledger and leaves the file byte-for-byte untouched
 *
 * Synthetic data only; real SQLite.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../../src/persistence/db";
import { COUNTED_TABLES } from "../../src/persistence/backup";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";
import { AT, DAY, addParty } from "../helpers/receiptDb";

const V19 = MIGRATIONS.slice(0, 19);
const V20 = MIGRATIONS.slice(0, 20);
let t: TempDir;
beforeEach(() => (t = tempDir()));
afterEach(() => t.cleanup());

const one = (db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as Record<string, unknown>;
const owner = (db: Db) => one(db, "SELECT id FROM operators WHERE role = 'owner' ORDER BY id LIMIT 1").id as string;

/** A v19 ledger with one customer and one advance written the v19 way (no intent existed then). */
function v19Ledger(): void {
  const db = openDatabase(t.dbPath, V19);
  addParty(db, "c1");
  db.transaction(() => {
    db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance'").run();
    db.prepare(
      `INSERT INTO customer_advances (id, doc_no, customer_id, currency, amount_minor, method, idempotency_key, request_fingerprint,
                                      received_by, received_at, business_date) VALUES ('a-v19', 1, 'c1', 'USD', 3000, 'cash', 'adv-key-v19-1', 'fp', ?, ?, ?)`,
    ).run(owner(db), AT, DAY);
  })();
  db.close();
}

describe("migration 20 — v19 → v20", () => {
  it("1 · upgrades without touching a row; 1–19 checksums unchanged; the intent table is new, empty and backed up", () => {
    v19Ledger();
    const pre = openDatabase(t.dbPath, V19);
    const advBefore = pre.prepare("SELECT * FROM customer_advances").all();
    const sumsBefore = pre.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
    pre.close();

    const db = openDatabase(t.dbPath, V20);
    try {
      expect(Number(one(db, "SELECT max(version) AS v FROM schema_migrations").v)).toBe(20);
      // TRANSITION (M20 part 2): `SELECT *` used to return exactly the v19 columns. It now also returns
      // `origin` and `corrects_advance_id` (added by ALTER). Every v19 column is still byte-identical;
      // the two new ones carry the only truthful value for an old row (test 5 asserts them).
      const after = (db.prepare("SELECT * FROM customer_advances").all() as Record<string, unknown>[]).map(
        ({ origin: _o, corrects_advance_id: _c, ...v19cols }) => v19cols,
      );
      expect(after).toEqual(advBefore);
      expect(db.prepare("SELECT version, checksum FROM schema_migrations WHERE version <= 19 ORDER BY version").all()).toEqual(sumsBefore);
      expect(Number(one(db, "SELECT count(*) AS n FROM advance_attempts").n)).toBe(0);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(COUNTED_TABLES).toContain("advance_attempts");
    } finally {
      db.close();
    }
  });

  it("2 · the advance recorded before migration 20 still works: an owner cash refund is accepted", () => {
    v19Ledger();
    const db = openDatabase(t.dbPath, V20);
    try {
      db.transaction(() => {
        db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance_refund'").run();
        db.prepare(
          `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint,
                                        refunded_by, refunded_at, business_date) VALUES ('r1', 1, 'a-v19', 1000, 'cash', 'طلب الزبون', 'ref-key-0001', 'fp', ?, ?, ?)`,
        ).run(owner(db), AT, DAY);
      })();
      expect(Number(one(db, "SELECT count(*) AS n FROM advance_refunds").n)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("3 · from v20 on, a new advance without its open, identical intent is refused, even by direct SQL", () => {
    v19Ledger();
    const db = openDatabase(t.dbPath, V20);
    try {
      const insert = () =>
        db.transaction(() => {
          db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance'").run();
          db.prepare(
            `INSERT INTO customer_advances (id, doc_no, customer_id, currency, amount_minor, method, idempotency_key, request_fingerprint,
                                            received_by, received_at, business_date) VALUES ('a-v20', 2, 'c1', 'USD', 500, 'cash', 'adv-key-v20-1', 'fp', ?, ?, ?)`,
          ).run(owner(db), AT, DAY);
        })();
      expect(insert).toThrow(/needs its open, identical attempt/);
      expect(Number(one(db, "SELECT last_no AS n FROM document_numbers WHERE kind = 'advance'").n)).toBe(1); // rolled back
    } finally {
      db.close();
    }
  });

  it("5 · G2 part: the v19 advance becomes origin 'receipt' with no link; corrections table new, empty, backed up", () => {
    v19Ledger();
    const db = openDatabase(t.dbPath, V20);
    try {
      expect(one(db, "SELECT origin, corrects_advance_id FROM customer_advances WHERE id = 'a-v19'")).toEqual({ origin: "receipt", corrects_advance_id: null });
      expect(Number(one(db, "SELECT count(*) AS n FROM advance_corrections").n)).toBe(0);
      expect(COUNTED_TABLES).toContain("advance_corrections");
      // the registry trigger was re-created, not lost: a NEW receipt-origin Whish advance still registers
      expect(Number(one(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'customer_advances_register_reference'").n)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("6 · the advance recorded BEFORE migration 20 can be corrected by the owner (not received), and then neither refunded nor corrected again", () => {
    v19Ledger();
    const db = openDatabase(t.dbPath, V20);
    try {
      const correct = (id: string, key: string) =>
        db.prepare(
          `INSERT INTO advance_corrections (id, advance_id, kind, funds_not_received, reason, corrected_by, corrected_at, business_date, idempotency_key, request_fingerprint)
           VALUES (?, 'a-v19', 'not_received', 1, 'لم يدفع', ?, ?, ?, ?, 'fp')`,
        ).run(id, owner(db), AT, DAY, key);
      correct("c1", "corr-key-v20-1");
      expect(() => correct("c2", "corr-key-v20-2")).toThrow(/already corrected/);
      expect(() =>
        db.transaction(() => {
          db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance_refund'").run();
          db.prepare(
            `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint,
                                          refunded_by, refunded_at, business_date) VALUES ('r1', 1, 'a-v19', 1000, 'cash', 'طلب الزبون', 'ref-key-0001', 'fp', ?, ?, ?)`,
          ).run(owner(db), AT, DAY);
        })(),
      ).toThrow(/corrected advance has no balance to refund/);
    } finally {
      db.close();
    }
  });

  it("7 · a FRESH ledger at v20 has every M20 object and passes integrity checks", () => {
    const db = openDatabase(t.dbPath, V20);
    try {
      expect(Number(one(db, "SELECT max(version) AS v FROM schema_migrations").v)).toBe(20);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      for (const n of [
        "advance_attempts",
        "advance_corrections",
        "advance_corrections_owner_only",
        "advance_corrections_once",
        "advance_corrections_unused_only",
        "advance_corrections_successor_issued_with_it",
        "advance_corrections_immutable_update",
        "advance_corrections_immutable_delete",
        "customer_advances_correction_shape",
        "customer_advances_receipt_has_no_link",
        "customer_advances_needs_open_attempt",
        "advance_applications_not_corrected",
        "advance_refunds_not_corrected",
      ]) {
        expect(names, n).toContain(n);
      }
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("4 · a v19 build refuses a v20 ledger and leaves the file byte-for-byte untouched", () => {
    v19Ledger();
    openDatabase(t.dbPath, V20).close();
    const sha = () => createHash("sha256").update(readFileSync(t.dbPath)).digest("hex");
    const before = sha();
    expect(() => openDatabase(t.dbPath, V19)).toThrow(/newer than this build/);
    expect(sha()).toBe(before);
  });
});
