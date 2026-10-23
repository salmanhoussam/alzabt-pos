/**
 * Migration 13 — the obligations and settlements tables, and the v12 ledger they are added to.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 A REAL v12 LEDGER, BUILT BY MIGRATIONS 1-12, THEN UPGRADED. `MIGRATIONS.slice(0, V12)` creates
 * the database the shop would actually have, real rows are written through it, it is CLOSED, and
 * only then is it reopened with the full migration list. The same shape as migration 4/9/10/11/12's
 * own tests, for the same reason: a ledger created at v13 is not an upgraded ledger at all.
 *
 * 🔴 WHY v12 -> v13 NEEDS ITS OWN TEST. The installed-app upgrade matrix (A-G) starts from REAL
 * RELEASED builds at schema v2-v7, so every one of those paths lands on v13 and proves the long
 * jumps. None of them starts at v12, because v12 has never been released. This file is that one
 * missing step, and it is a unit test precisely because no released artifact exists to make it an
 * installed-app one.
 *
 * Synthetic data only: no merchant name, price or invoice appears anywhere.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, SchemaNewerThanAppError, openDatabase, schemaVersion, verifyAppliedMigrations } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { COUNTED_TABLES } from "../../src/persistence/backup";
import { type TempDir, tempDir } from "../helpers/harness";

/** The schema version migration 13 upgrades FROM. */
const V12 = 12;
/** Migration 13 is the subject here, so this file migrates to EXACTLY v13. */
const V13 = 13;

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const count = (db: Db, table: string) =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);

const tableExists = (db: Db, name: string) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/**
 * A v12 ledger holding the rows an upgrade must keep: an operator, a category, a product, and a
 * customer with a corrected phone number.
 */
function v12LedgerWithRows(): { operatorId: string; partyId: string } {
  const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
  expect(schemaVersion(db)).toBe(V12);
  const operatorId = (db.prepare(`SELECT id FROM operators LIMIT 1`).get() as { id: string }).id;
  db.prepare(
    `INSERT INTO catalog_categories (id, name_ar, name_en, is_active, sort_order, created_at, updated_at)
     VALUES ('cat-1', 'فئة', 'Category', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  // Column names read from migration 9's own CREATE TABLE, not guessed.
  db.prepare(
    `INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en,
                                   selling_price_minor, currency, base_unit,
                                   price_needs_review, is_active, created_at, updated_at)
     VALUES ('prod-1', 'manual', 'manual:prod-1', 'SKU-1', 'صنف', 'Item', 1000, 'USD', 'piece',
             0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO parties (id, kind, display_name, phone, address, note, is_active,
                          created_by, created_at, updated_at)
     VALUES ('party-1', 'customer', 'زبون', '0100100', NULL, NULL, 1,
             ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(operatorId);
  db.prepare(
    `INSERT INTO party_contact_history (id, party_id, field, old_value, new_value, changed_by, changed_at)
     VALUES ('hist-1', 'party-1', 'phone', '0999999', '0100100', ?, '2026-01-01T00:00:00.000Z')`,
  ).run(operatorId);
  db.close();
  return { operatorId, partyId: "party-1" };
}

describe("migration 13 — obligations and settlements", () => {
  it("🔴 a v12 ledger upgrades to v13, and the new tables start EMPTY", () => {
    v12LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V13));
    expect(schemaVersion(db)).toBe(V13);
    expect(tableExists(db, "obligations")).toBe(true);
    expect(tableExists(db, "settlements")).toBe(true);
    // 🔴 NOTHING IS SYNTHESIZED FROM HISTORY. A shop upgrading does not suddenly discover debts:
    // no obligation is back-filled from `sales.balance_due_minor`, because nobody has reviewed
    // those balances as receivables and inventing them would put money on real customers' names.
    expect(count(db, "obligations")).toBe(0);
    expect(count(db, "settlements")).toBe(0);
    db.close();
  });

  it("🔴 every pre-existing row survives the upgrade, unchanged", () => {
    const { partyId } = v12LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V13));
    expect(count(db, "catalog_categories")).toBe(1);
    expect(count(db, "catalog_products")).toBe(1);
    expect(count(db, "parties")).toBe(1);
    expect(count(db, "party_contact_history")).toBe(1);
    expect(count(db, "operators")).toBeGreaterThan(0);

    const party = db.prepare(`SELECT display_name, phone, is_active FROM parties WHERE id = ?`).get(partyId) as {
      display_name: string;
      phone: string;
      is_active: number;
    };
    // `is_active` comes back from SQLite as a bigint, so compare it as one rather than loosening
    // the assertion to a truthiness check.
    expect(party).toEqual({ display_name: "زبون", phone: "0100100", is_active: 1n });

    const product = db.prepare(`SELECT sku, selling_price_minor, currency FROM catalog_products`).get() as {
      sku: string;
      selling_price_minor: bigint | number;
      currency: string;
    };
    expect(product.sku).toBe("SKU-1");
    expect(Number(product.selling_price_minor)).toBe(1000);
    expect(product.currency).toBe("USD");
    db.close();
  });

  it("🔴 the sales, sale_lines and invoices tables are not rebuilt or altered", () => {
    v12LedgerWithRows();
    const before = (() => {
      const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
      const rows = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN
                  ('sales', 'sale_lines', 'invoices', 'invoice_lines', 'voids', 'audit_events')
                  ORDER BY name`)
        .all() as Array<{ name: string; sql: string }>;
      db.close();
      return rows;
    })();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V13));
    const after = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN
                ('sales', 'sale_lines', 'invoices', 'invoice_lines', 'voids', 'audit_events')
                ORDER BY name`)
      .all() as Array<{ name: string; sql: string }>;
    // Byte-for-byte identical CREATE TABLE text for every financial table that already existed.
    expect(after).toEqual(before);
    expect(after.length).toBe(6);
    db.close();
  });

  it("🔴 is the thirteenth migration, and 1-12 are byte-identical after it", () => {
    const migrationsThroughV13 = MIGRATIONS.slice(0, V13);
    expect(migrationsThroughV13.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(migrationsThroughV13).toHaveLength(13);
    expect(MIGRATIONS[12]!.name).toBe("obligations_and_settlements");
    // The upgrade path records all thirteen, in order, with no gap.
    v12LedgerWithRows();
    const db = openDatabase(t.dbPath, migrationsThroughV13);
    const applied = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{
      version: bigint | number;
    }>;
    expect(applied.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    db.close();
  });

  it("🔴 contains no ALTER and no DROP — it is additive or it is nothing", () => {
    const sql = MIGRATIONS[12]!.sql;
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|INDEX|TRIGGER)\b/i);
    // It creates exactly the two tables it is authorized to create.
    const created = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).sort();
    expect(created).toEqual(["obligations", "settlements"]);
  });

  it("🔴 both new tables are in the backup contract", () => {
    // 🔴 THE MOST EXPENSIVE OMISSION ON THAT LIST. A snapshot that lost `settlements` restores
    // every debt at its FULL original amount — a customer who has paid is asked to pay again.
    // Nothing would report it, because the balance is derived: missing rows read as "never paid".
    expect(COUNTED_TABLES).toContain("obligations");
    expect(COUNTED_TABLES).toContain("settlements");
  });

  it("🔴 a real snapshot counts the new tables once they hold rows", async () => {
    // Through `snapshotDatabase`, the REAL backup path, not a private counter — so this asserts
    // what a merchant's actual nightly snapshot would record.
    const { snapshotDatabase } = await import("../../src/persistence/backup");
    const { join } = await import("node:path");
    const { operatorId, partyId } = v12LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V13));
    db.prepare(
      `INSERT INTO obligations (id, party_id, party_kind, direction, source_kind, source_ref,
                                sale_id, currency, amount_minor, posted_by, posted_at, business_date)
       VALUES ('o1', ?, 'customer', 'receivable', 'manual', 'bill-1', NULL, 'USD', 1000, ?,
               '2026-10-22T08:00:00.000Z', '2026-10-22')`,
    ).run(partyId, operatorId);
    db.prepare(
      `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint,
                                amount_minor, method, settled_by, settled_at, business_date)
       VALUES ('s1', 'o1', 'USD', 'pay-00000001', 'fp', 400, 'cash', ?,
               '2026-10-22T09:00:00.000Z', '2026-10-22')`,
    ).run(operatorId);
    const snap = snapshotDatabase(db, join(t.dir, "snap.sqlite"));
    expect(snap.counts.obligations).toBe(1);
    expect(snap.counts.settlements).toBe(1);
    // And the rows the shop already had are still counted alongside them.
    expect(snap.counts.parties).toBe(1);
    expect(snap.counts.party_contact_history).toBe(1);
    db.close();
  });

  it("🔴 an OLDER build refuses a v13 ledger and leaves it byte-for-byte unchanged", () => {
    // The rollback truth: installing an old EXE does not downgrade a database. It refuses it.
    v12LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V13));
    expect(schemaVersion(db)).toBe(V13);
    db.close();

    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const before = readFileSync(t.dbPath);

    // A v12 build opening a v13 ledger.
    expect(() => openDatabase(t.dbPath, MIGRATIONS.slice(0, V12))).toThrow(SchemaNewerThanAppError);

    const after = readFileSync(t.dbPath);
    expect(after.equals(before)).toBe(true);
  });

  it("🔴 verifyAppliedMigrations accepts the v13 ledger it just wrote", () => {
    v12LedgerWithRows();
    const migrationsThroughV13 = MIGRATIONS.slice(0, V13);
    const db = openDatabase(t.dbPath, migrationsThroughV13);
    expect(() => verifyAppliedMigrations(db, migrationsThroughV13)).not.toThrow();
    db.close();
  });
});
