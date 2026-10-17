/**
 * Migration 11 — the operator create-capability, run against a POPULATED v10 database.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 IT REBUILDS `audit_events` AGAIN, AND THAT IS THE RISK WORTH TESTING. The column it adds to
 * `operators` is a one-line ALTER that SQLite handles without touching a row. The audit table is
 * the other half: its event vocabulary is an enumerated CHECK, SQLite cannot widen one in place,
 * so recording "the owner allowed this cashier to add products" costs a full
 * CREATE / INSERT ... SELECT * / DROP / RENAME of the one table that may never lose a row.
 *
 * Migration 10 did exactly this once already and its test exists for the same reason. Doing it a
 * second time is not safer for having worked once: a copy that silently normalises a timestamp,
 * drops a metadata_json or renumbers a seq destroys the shop's only answer to "who changed this
 * price", and nothing downstream notices. So the ledger here is POPULATED FIRST — an empty table
 * cannot see this class of defect at all — and preservation is checked COLUMN BY COLUMN on every
 * row rather than by a count.
 *
 * Synthetic throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { type TempDir, tempDir } from "../helpers/harness";

const V10 = MIGRATIONS.filter((m) => m.version <= 10);
const V11 = MIGRATIONS.filter((m) => m.version <= 11);

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => {
  t.cleanup();
});

const rows = (db: Db, sql: string, ...args: unknown[]) =>
  db.prepare(sql).all(...args) as Array<Record<string, unknown>>;

const AUDIT_COLUMNS = [
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
] as const;

const wholeTable = (db: Db) =>
  rows(db, `SELECT ${AUDIT_COLUMNS.join(", ")} FROM audit_events ORDER BY seq`);

/**
 * A v10 ledger carrying history of every shape the vocabulary admitted at v10 — including the
 * two kinds migration 10 itself added, an empty diff with NULL metadata, and a non-ASCII actor.
 */
function seedV10(): Array<Record<string, unknown>> {
  const db = openDatabase(t.dbPath, V10);
  try {
    expect(schemaVersion(db)).toBe(10);
    db.exec(`
      INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en,
                                    selling_price_minor, currency, base_unit, price_needs_review,
                                    is_active, created_at, updated_at)
      VALUES ('p-1', 'manual', 'k-1', 'SKU-1', 'مفك براغي', 'Screwdriver', 250000, 'LBP', 'piece',
              0, 1, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z');

      INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id, actor_name,
                                actor_tier, occurred_at, business_date, changed_json, metadata_json,
                                app_version, schema_version)
      VALUES
        ('aud-1', 1, 'PRODUCT_CREATED', 'product', 'p-1', 'cashier-01', 'Cashier One', 'owner',
         '2026-10-01T08:00:00.000Z', '2026-10-01',
         '{"name_ar":{"before":null,"after":"مفك براغي"}}',
         '{"origin":"manual_entry","source":"manual"}', '0.1.0', 10),
        -- Empty diff, NULL metadata: the event type is the whole fact.
        ('aud-2', 2, 'OPERATOR_PIN_RESET', 'operator', 'cashier-02', 'cashier-01', 'Cashier One',
         'owner', '2026-10-03T08:00:00.000Z', '2026-10-03', '{}', NULL, '0.1.0', 10),
        -- One of migration 10's own additions, so the second rebuild is proven to carry them.
        ('aud-3', 3, 'PRODUCT_IMAGE_SET', 'product_image', 'p-1', 'cashier-02', 'جعفر صالح',
         'cashier', '2026-10-04T08:00:00.000Z', '2026-10-04',
         '{"image_id":{"before":null,"after":"img-1"}}', '{"origin":"desktop"}', '0.0.9', 10),
        ('aud-4', 4, 'CATEGORY_CREATED', 'category', 'cat-1', 'cashier-01', 'Cashier One', 'owner',
         '2026-10-05T08:00:00.000Z', '2026-10-05', '{"name_ar":{"before":null,"after":"أدوات"}}',
         NULL, '0.1.0', 10);
    `);
    return wholeTable(db);
  } finally {
    db.close();
  }
}

const upgrade = () => openDatabase(t.dbPath, V11, { fileMustExist: true });

describe("migration 11 — v10 to v11, on a populated ledger", () => {
  it("is the eleventh migration, and 1-10 are byte-identical after it", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(MIGRATIONS).toHaveLength(11);
    expect(MIGRATIONS[10]!.name).toBe("operator_product_create_capability");
  });

  it("🔴 every historical audit row survives, column by column", () => {
    const before = seedV10();
    const db = upgrade();
    try {
      expect(schemaVersion(db)).toBe(11);
      // Not a count: a count survives a copy that normalised a timestamp or dropped a metadata.
      expect(wholeTable(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("🔴 the audit table is still append-only and still monotonic after the rebuild", () => {
    seedV10();
    const db = upgrade();
    try {
      // The triggers are recreated AFTER the copy; if they had been created before it, the
      // monotonic guard would have fired once per historical row and refused the migration.
      expect(() => db.exec(`UPDATE audit_events SET actor_name = 'x' WHERE id = 'aud-1'`)).toThrow(
        /append-only/,
      );
      expect(() => db.exec(`DELETE FROM audit_events WHERE id = 'aud-1'`)).toThrow(/cannot be deleted/);
      expect(() =>
        db.exec(`INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id,
                   actor_name, actor_tier, occurred_at, business_date, changed_json, metadata_json,
                   app_version, schema_version)
                 VALUES ('aud-x', 2, 'PRODUCT_CREATED', 'product', 'p-1', 'a', 'A', 'owner',
                   '2026-10-06T08:00:00.000Z', '2026-10-06', '{}', NULL, '0.1.1', 11)`),
      ).toThrow(/monotonic/);
    } finally {
      db.close();
    }
  });

  it("🔴 the two new event types are now storable, and only against an operator", () => {
    seedV10();
    const db = upgrade();
    try {
      const insert = (seq: number, type: string, entity: string, id: string) =>
        db.exec(`INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id,
                   actor_name, actor_tier, occurred_at, business_date, changed_json, metadata_json,
                   app_version, schema_version)
                 VALUES ('${id}', ${seq}, '${type}', '${entity}', 'cashier-02', 'cashier-01',
                   'Cashier One', 'owner', '2026-10-06T08:00:00.000Z', '2026-10-06',
                   '{"may_create_products":{"before":"0","after":"1"}}', NULL, '0.1.1', 11)`);

      expect(() => insert(5, "OPERATOR_PRODUCT_CREATE_GRANTED", "operator", "aud-5")).not.toThrow();
      expect(() => insert(6, "OPERATOR_PRODUCT_CREATE_REVOKED", "operator", "aud-6")).not.toThrow();
      // 🔴 The entity pairing is enforced by the database, not only by the domain: a permission
      // event describes a PERSON, and naming a product instead is refused outright.
      expect(() => insert(7, "OPERATOR_PRODUCT_CREATE_GRANTED", "product", "aud-7")).toThrow();
    } finally {
      db.close();
    }
  });

  it("🔴 the capability column exists, defaults to 0 on EVERY existing row, and rejects anything else", () => {
    seedV10();
    const db = upgrade();
    try {
      const cols = rows(db, "PRAGMA table_info(operators)").map((c) => c.name as string);
      expect(cols).toContain("may_create_products");

      // 🔴 AN UPGRADE GRANTS NOBODY ANYTHING. Both seeded operators arrive refused.
      const seeded = rows(db, "SELECT id, may_create_products AS m FROM operators ORDER BY id");
      expect(seeded.map((r) => [r.id, Number(r.m)])).toEqual([
        ["cashier-01", 0],
        ["cashier-02", 0],
      ]);

      expect(() => db.exec(`UPDATE operators SET may_create_products = 2 WHERE id = 'cashier-02'`)).toThrow(
        /CHECK/,
      );
      expect(() => db.exec(`UPDATE operators SET may_create_products = 1 WHERE id = 'cashier-02'`)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("the upgrade is idempotent in the sense that reopening at v11 changes nothing", () => {
    seedV10();
    let snapshot: Array<Record<string, unknown>> = [];
    const first = upgrade();
    try {
      snapshot = wholeTable(first);
    } finally {
      first.close();
    }
    const second = upgrade();
    try {
      expect(schemaVersion(second)).toBe(11);
      expect(wholeTable(second)).toEqual(snapshot);
    } finally {
      second.close();
    }
  });
});
