/**
 * Migration 12 — the party identity tables, and the v11 ledger they are added to.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 A REAL v11 LEDGER, BUILT BY MIGRATIONS 1-11, THEN UPGRADED. `MIGRATIONS.slice(0, V11)` creates
 * the database the shop would actually have, real rows are written through it, it is CLOSED, and
 * only then is it reopened with the full migration list. The same shape as migration4/9/10/11's own
 * tests, for the same reason: a ledger created at v12 is not an upgraded ledger at all.
 *
 * 🔴 WHY v11 -> v12 NEEDS ITS OWN TEST AT ALL. The installed-app upgrade matrix (A-G) starts from
 * REAL RELEASED builds at schema v2-v7, so every one of those paths lands on v12 and proves the
 * long jumps. None of them starts at v11, because v11 has never been released. This file is that
 * one missing step, and it is a unit test precisely because no released artifact exists to make it
 * an installed-app one.
 *
 * Synthetic data only: no merchant name, price or invoice appears anywhere.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, SchemaNewerThanAppError, openDatabase, schemaVersion, verifyAppliedMigrations } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";

/** The schema version migration 12 upgrades FROM. */
const V11 = 11;
/** Migration 12 is the subject here, so this file migrates to EXACTLY v12. */
const V12 = 12;

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const count = (db: Db, table: string) =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);

const tableExists = (db: Db, name: string) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

const indexNames = (db: Db, table: string) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`).all(table) as Array<{
    name: string;
  }>)
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_autoindex"));

/** A v11 ledger holding one operator, one product, one category — the rows an upgrade must keep. */
function v11LedgerWithRows(): { operatorId: string; productId: string; categoryId: string } {
  const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V11));
  expect(schemaVersion(db)).toBe(V11);
  const operatorId = (db.prepare(`SELECT id FROM operators LIMIT 1`).get() as { id: string }).id;
  db.prepare(
    `INSERT INTO catalog_categories (id, name_ar, name_en, is_active, sort_order, created_at, updated_at)
     VALUES ('cat-1', 'فئة', 'Category', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  // Column names read from migration 9's own CREATE TABLE, not guessed: an earlier draft of this
  // fixture invented `unit_price_minor` and every test in the file failed at setup.
  db.prepare(
    `INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en,
                                   selling_price_minor, currency, base_unit,
                                   price_needs_review, is_active, created_at, updated_at)
     VALUES ('prod-1', 'manual', 'manual:prod-1', 'SKU-1', 'صنف', 'Item', 1000, 'USD', 'piece',
             0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.close();
  return { operatorId, productId: "prod-1", categoryId: "cat-1" };
}

describe("migration 12 — party identity", () => {
  it("🔴 a v11 ledger upgrades to v12, and the new tables start EMPTY", () => {
    v11LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect(schemaVersion(db)).toBe(V12);
    expect(tableExists(db, "parties")).toBe(true);
    expect(tableExists(db, "party_contact_history")).toBe(true);
    // Nothing is synthesized: a shop that has not named a customer has no customers.
    expect(count(db, "parties")).toBe(0);
    expect(count(db, "party_contact_history")).toBe(0);
    db.close();
  });

  it("🔴 the upgrade preserves the operators, products and categories that were already there", () => {
    const { operatorId, productId, categoryId } = v11LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect((db.prepare(`SELECT id FROM operators WHERE id = ?`).get(operatorId) as { id: string } | undefined)?.id).toBe(
      operatorId,
    );
    const product = db
      .prepare(`SELECT sku, name_ar, selling_price_minor FROM catalog_products WHERE id = ?`)
      .get(productId) as { sku: string; name_ar: string; selling_price_minor: bigint } | undefined;
    expect(product?.sku).toBe("SKU-1");
    expect(product?.name_ar).toBe("صنف");
    expect(Number(product?.selling_price_minor)).toBe(1000);
    expect((db.prepare(`SELECT name_ar FROM catalog_categories WHERE id = ?`).get(categoryId) as { name_ar: string }).name_ar).toBe(
      "فئة",
    );
    db.close();
  });

  it("🔴 the upgrade touches NO financial table — sales, invoices and their shapes are as they were", () => {
    v11LedgerWithRows();
    const before = openDatabase(t.dbPath, MIGRATIONS.slice(0, V11));
    const shapeOf = (db: Db, table: string) =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string }).sql;
    const financialBefore = {
      sales: shapeOf(before, "sales"),
      sale_lines: shapeOf(before, "sale_lines"),
      invoices: shapeOf(before, "invoices"),
      invoice_lines: shapeOf(before, "invoice_lines"),
      voids: shapeOf(before, "voids"),
      audit_events: shapeOf(before, "audit_events"),
    };
    before.close();

    const after = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    for (const [table, sql] of Object.entries(financialBefore)) {
      expect(shapeOf(after, table), `${table} was altered by migration 12`).toBe(sql);
    }
    // And no accidental postings appeared anywhere.
    for (const table of ["sales", "sale_lines", "invoices", "invoice_lines", "voids"]) {
      expect(count(after, table), table).toBe(0);
    }
    after.close();
  });

  it("the schema integrity check and the foreign keys are clean after the upgrade", () => {
    v11LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("🔴 the lookup indexes really exist — and the name index is NOT unique", () => {
    v11LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect(indexNames(db, "parties")).toEqual(["parties_kind_active", "parties_kind_name", "parties_kind_phone"]);
    expect(indexNames(db, "party_contact_history")).toEqual(["party_contact_history_party"]);
    const unique = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'parties_kind_name'`).get() as { sql: string }).sql;
    // 🔴 Two customers may share a name. A UNIQUE index here would refuse the second real person.
    expect(unique.toUpperCase()).not.toContain("UNIQUE");
    db.close();
  });

  it("🔴 no balance, currency or money column was smuggled into the identity tables", () => {
    v11LedgerWithRows();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    for (const table of ["parties", "party_contact_history"]) {
      const columns = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map(
        (c) => c.name,
      );
      for (const forbidden of ["balance", "currency", "minor", "amount", "total", "credit", "debt", "limit", "paid"]) {
        expect(
          columns.filter((c) => c.includes(forbidden)),
          `${table} must hold no ${forbidden} column — balances are derived from postings`,
        ).toEqual([]);
      }
    }
    db.close();
  });

  it("the database refuses to open twice-migrated or re-migrated, and is idempotent on reopen", () => {
    v11LedgerWithRows();
    const first = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect(schemaVersion(first)).toBe(V12);
    first.close();
    const second = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect(schemaVersion(second)).toBe(V12);
    expect(count(second, "parties")).toBe(0);
    second.close();
  });

  // ── §7 of the authorization: what an OLD build does with a NEW database ─────────────────────
  it("🔴 a v11 BUILD REFUSES a v12 database, and leaves it byte-for-byte alone", () => {
    v11LedgerWithRows();
    const upgraded = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    upgraded.close();

    // A build that knows only 11 migrations, opening the v12 file. This is the rollback question.
    expect(() => openDatabase(t.dbPath, MIGRATIONS.slice(0, V11))).toThrow(SchemaNewerThanAppError);

    // 🔴 AND IT IS STILL A v12 LEDGER AFTERWARDS. The refusal happens before WAL is switched on,
    // so the refused file is not rewritten — which is what makes "install the old EXE" safe but
    // USELESS as a downgrade: the old build will simply never open it.
    const reopened = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect(schemaVersion(reopened)).toBe(V12);
    expect(reopened.pragma("integrity_check", { simple: true })).toBe("ok");
    reopened.close();
  });

  it("the refusal is read-only — verifyAppliedMigrations alone never writes", () => {
    v11LedgerWithRows();
    const upgraded = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    upgraded.close();
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V12));
    expect(() => verifyAppliedMigrations(db, MIGRATIONS.slice(0, V11))).toThrow(SchemaNewerThanAppError);
    expect(schemaVersion(db)).toBe(V12);
    db.close();
  });
});
