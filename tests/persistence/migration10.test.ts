/**
 * Migration 10 — the audit vocabulary widening, run against a POPULATED v9 database.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS MIGRATION REBUILDS THE ONE TABLE THAT MAY NEVER LOSE A ROW.
 *
 * `audit_events` is append-only and immutable by trigger: it is the shop's answer to "who changed
 * this price, and when". Three of its CHECKs ENUMERATE the event and entity types, and SQLite
 * cannot widen an enumerated CHECK in place — so adding CATEGORY_* and PRODUCT_IMAGE_* means
 * CREATE / INSERT ... SELECT * / DROP / RENAME, which is to say: every historical row is copied by
 * hand and the original is destroyed. If that copy is wrong, the evidence is gone and nothing
 * notices.
 *
 * So the database here is POPULATED FIRST, for the reason migration 7's own comment records: a
 * rebuild that leaned on `defer_foreign_keys` passed every test on an EMPTY ledger and failed
 * instantly on a real one, because the implicit DELETE inside DROP TABLE counts one deferred
 * violation per referencing child row. An empty table cannot see that class of defect at all.
 *
 * And the preservation check is COLUMN BY COLUMN on every row, not a count. A count survives a
 * copy that silently normalised a timestamp, dropped a metadata_json, or renumbered a seq.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Synthetic throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { type TempDir, tempDir } from "../helpers/harness";

const V9 = MIGRATIONS.filter((m) => m.version <= 9);
const V10 = MIGRATIONS.filter((m) => m.version <= 10);

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => {
  t.cleanup();
});

const rows = (db: Db, sql: string, ...args: unknown[]) =>
  db.prepare(sql).all(...args) as Array<Record<string, unknown>>;

/**
 * A v9 database carrying real audit history of EVERY kind the old vocabulary admitted — all three
 * entity types, an event with an empty diff (an operator PIN reset), one with null metadata, and
 * one carrying a full metadata summary. If the copy mangles any shape, one of these is where it
 * shows.
 */
function seedV9(): void {
  const db = openDatabase(t.dbPath, V9);
  try {
    expect(schemaVersion(db)).toBe(9);
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
        -- A product creation: full diff, metadata present.
        ('aud-1', 1, 'PRODUCT_CREATED', 'product', 'p-1', 'cashier-01', 'Cashier One', 'owner',
         '2026-10-01T08:00:00.000Z', '2026-10-01',
         '{"name_ar":{"before":null,"after":"مفك براغي"}}',
         '{"origin":"manual_entry","source":"manual"}', '0.1.0', 9),
        -- An import: changed_json is "{}" BY DESIGN, metadata carries the whole fact.
        ('aud-2', 2, 'CATALOG_IMPORTED', 'catalog', 'catalog', 'cashier-01', 'Cashier One',
         'unspecified', '2026-10-02T08:00:00.000Z', '2026-10-02', '{}',
         '{"file_name":"prices.csv","row_count":12}', '0.1.0', 9),
        -- A PIN reset: EMPTY diff and NULL metadata. The event type is the whole fact, and there
        -- is deliberately nothing about the credential to record.
        ('aud-3', 3, 'OPERATOR_PIN_RESET', 'operator', 'cashier-02', 'cashier-01', 'Cashier One',
         'owner', '2026-10-03T08:00:00.000Z', '2026-10-03', '{}', NULL, '0.1.0', 9),
        -- Non-ASCII actor name, and an older app_version, both of which must survive verbatim.
        ('aud-4', 4, 'PRODUCT_UPDATED', 'product', 'p-1', 'cashier-02', 'جعفر صالح', 'cashier',
         '2026-10-04T08:00:00.000Z', '2026-10-04',
         '{"selling_price_minor":{"before":"250000","after":"300000"}}',
         '{"origin":"manual_entry"}', '0.0.9', 9);
    `);
  } finally {
    db.close();
  }
}

const upgrade = () => openDatabase(t.dbPath, V10, { fileMustExist: true });

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

/** Every audit row, every column, in seq order — the whole table as data. */
function wholeTable(db: Db): Array<Record<string, unknown>> {
  return rows(db, `SELECT ${AUDIT_COLUMNS.join(", ")} FROM audit_events ORDER BY seq`);
}

function insertEvent(db: Db, over: Record<string, unknown>): void {
  const seq = Number((db.prepare("SELECT coalesce(max(seq), 0) AS n FROM audit_events").get() as { n: bigint }).n) + 1;
  db.prepare(
    `INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id, actor_name,
                               actor_tier, occurred_at, business_date, changed_json, metadata_json,
                               app_version, schema_version)
     VALUES (@id, @seq, @event_type, @entity_type, @entity_id, @actor_id, @actor_name, @actor_tier,
             @occurred_at, @business_date, @changed_json, @metadata_json, @app_version,
             @schema_version)`,
  ).run({
    id: `new-${seq}`,
    seq,
    event_type: "CATEGORY_CREATED",
    entity_type: "category",
    entity_id: "cat-1",
    actor_id: "cashier-01",
    actor_name: "Cashier One",
    actor_tier: "owner",
    occurred_at: "2026-10-14T08:00:00.000Z",
    business_date: "2026-10-14",
    changed_json: '{"name_ar":{"before":null,"after":"عدد"}}',
    metadata_json: null,
    app_version: "0.1.1",
    schema_version: 10,
    ...over,
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("migration 10 — v9 to v10, on a populated ledger", () => {
  it("is the tenth migration, and 1-9 are byte-identical after it", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(MIGRATIONS).toHaveLength(10);
    expect(MIGRATIONS[9]!.name).toBe("product_master_audit");

    // 🔴 THE RELEASED FINGERPRINTS. Editing any of these would make every real ledger on a shop
    // counter refuse to open with MigrationMismatchError. Migration 9 is included: it is on this
    // branch and its shape is settled, and the whole reason migration 10 exists as its own
    // migration is that migration 9 must NOT be touched to carry this change.
    const sha = (s: string) => createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("hex");
    expect(sha(MIGRATIONS[7]!.sql)).toBe("9dfc969493221dce94a0d4fd3944be375e53c2fc953c277688963e774f2335e8");
    expect(sha(MIGRATIONS[8]!.sql)).toBe("f56b90fc2d51cf254273580c4f0a8c65336f66de527128e71b240d72edf295ce");
    // And migration 10's own, pinned so that an edit to it is a deliberate act with a new number.
    expect(sha(MIGRATIONS[9]!.sql)).toBe("6d397259c03d95cda6cfe800d5aa1d1993a9896304d046b3d6f53a5ae3e482fb");
  });

  it("🔴 EVERY HISTORICAL ROW SURVIVES, COLUMN BY COLUMN — not a count, the rows themselves", () => {
    seedV9();
    const before = (() => {
      const db = openDatabase(t.dbPath, V9, { fileMustExist: true });
      try {
        return wholeTable(db);
      } finally {
        db.close();
      }
    })();
    expect(before).toHaveLength(4);

    const db = upgrade();
    try {
      expect(schemaVersion(db)).toBe(10);
      const after = wholeTable(db);
      // 🔴 DEEP EQUALITY ON THE WHOLE TABLE. A count would pass a copy that normalised a
      // timestamp, dropped a NULL metadata_json to "{}", renumbered a seq, or lost the Arabic in
      // an actor's name. This compares all fourteen columns of all four rows.
      expect(after).toEqual(before);
      // Named explicitly, because each is a different way the copy could have been wrong:
      expect(after[1]!.changed_json).toBe("{}"); // an import's empty diff is not "fixed"
      expect(after[2]!.metadata_json).toBeNull(); // a NULL does not become "{}"
      expect(after[3]!.actor_name).toBe("جعفر صالح"); // non-ASCII survives
      expect(after[3]!.app_version).toBe("0.0.9"); // the OLD build's version is not restamped
      expect(after.map((r) => Number(r.schema_version))).toEqual([9, 9, 9, 9]); // history is not renumbered
      expect(after.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4]);
    } finally {
      db.close();
    }
  });

  it("🔴 and the append-only triggers are BACK after the rebuild — the table is still immutable", () => {
    seedV9();
    const db = upgrade();
    try {
      // The old triggers died with the old table. If they were not recreated, the shop's audit
      // trail would be silently editable from this version on.
      expect(() => db.prepare("UPDATE audit_events SET actor_name = 'x' WHERE id = 'aud-1'").run()).toThrow(
        /append-only/,
      );
      expect(() => db.prepare("DELETE FROM audit_events WHERE id = 'aud-1'").run()).toThrow(/cannot be deleted/);
      // And seq must still be monotonic.
      expect(() => insertEvent(db, { seq: 2 })).toThrow(/monotonic/);
      // Every index is back too, so the reads that existed yesterday are not full scans today.
      const names = rows(db, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_events'`)
        .map((r) => r.name as string)
        .filter((n) => !n.startsWith("sqlite_"))
        .sort();
      expect(names).toEqual([
        "audit_events_actor",
        "audit_events_date",
        "audit_events_entity",
        "audit_events_type",
      ]);
    } finally {
      db.close();
    }
  });

  it("🔴 the FIVE category events are accepted, each paired with the category entity", () => {
    seedV9();
    const db = upgrade();
    try {
      for (const event_type of [
        "CATEGORY_CREATED",
        "CATEGORY_RENAMED",
        "CATEGORY_ACTIVATED",
        "CATEGORY_DEACTIVATED",
        "CATEGORY_DELETED",
      ]) {
        expect(() => insertEvent(db, { event_type, entity_type: "category" })).not.toThrow();
      }
      expect(rows(db, `SELECT count(*) AS n FROM audit_events WHERE entity_type = 'category'`)[0]!.n).toBe(5n);
    } finally {
      db.close();
    }
  });

  it("🔴 the THREE photo events are accepted, each paired with product_image", () => {
    seedV9();
    const db = upgrade();
    try {
      for (const event_type of ["PRODUCT_IMAGE_SET", "PRODUCT_IMAGE_REPLACED", "PRODUCT_IMAGE_REMOVED"]) {
        expect(() =>
          insertEvent(db, {
            event_type,
            entity_type: "product_image",
            entity_id: "p-1",
            changed_json: '{"image_id":{"before":null,"after":"img-1"}}',
          }),
        ).not.toThrow();
      }
      expect(rows(db, `SELECT count(*) AS n FROM audit_events WHERE entity_type = 'product_image'`)[0]!.n).toBe(3n);
    } finally {
      db.close();
    }
  });

  it("🔴 AND THE DOMAIN IS STILL CLOSED — an unknown type or a crossed pairing is still refused", () => {
    seedV9();
    const db = upgrade();
    try {
      // An invented event type.
      expect(() => insertEvent(db, { event_type: "CATEGORY_MERGED", entity_type: "category" })).toThrow();
      // An invented entity type.
      expect(() => insertEvent(db, { entity_type: "brand", event_type: "CATEGORY_CREATED" })).toThrow();
      // 🔴 A CROSSED PAIRING: a real event type on the wrong entity. This is the one the column
      // CHECKs alone would let through, and the pairing CHECK is what refuses it.
      expect(() => insertEvent(db, { event_type: "CATEGORY_CREATED", entity_type: "product" })).toThrow();
      expect(() => insertEvent(db, { event_type: "PRODUCT_IMAGE_SET", entity_type: "category" })).toThrow();
      expect(() => insertEvent(db, { event_type: "PRODUCT_CREATED", entity_type: "category" })).toThrow();
      expect(() => insertEvent(db, { event_type: "OPERATOR_CREATED", entity_type: "product_image" })).toThrow();
      // Nothing above landed.
      expect(rows(db, `SELECT count(*) AS n FROM audit_events`)[0]!.n).toBe(4n);
    } finally {
      db.close();
    }
  });

  it("🔴 CONTROL — the refusals above are about the VALUE, not about a broken insert helper", () => {
    // Without this, a typo in `insertEvent` would make every "still refused" assertion above pass
    // for the wrong reason, and the widened domain would be untested.
    seedV9();
    const db = upgrade();
    try {
      expect(() => insertEvent(db, {})).not.toThrow();
      expect(rows(db, `SELECT count(*) AS n FROM audit_events`)[0]!.n).toBe(5n);
    } finally {
      db.close();
    }
  });

  it("the other v9 tables are untouched — this migration names only audit_events", () => {
    seedV9();
    const db = upgrade();
    try {
      // The product seeded at v9 is still there, with its Product Master columns.
      expect(rows(db, `SELECT id, name_ar, barcode, category_id FROM catalog_products`)).toEqual([
        { id: "p-1", name_ar: "مفك براغي", barcode: null, category_id: null },
      ]);
    } finally {
      db.close();
    }

    // And the SQL itself names no other table.
    const code = MIGRATIONS[9]!.sql.replace(/^\s*--.*$/gm, "");
    for (const table of [
      "sales",
      "sale_lines",
      "voids",
      "invoices",
      "invoice_lines",
      "operators",
      "catalog_products",
      "catalog_categories",
      "catalog_product_images",
      "terminal_security_state",
    ]) {
      expect(code, `migration 10 must not mention ${table}`).not.toMatch(new RegExp(`\\b${table}\\b`, "i"));
    }
    // It rebuilds exactly one table, and the rebuild is the whole of it.
    expect(code.match(/CREATE TABLE/gi)).toHaveLength(1);
    expect(code.match(/DROP TABLE/gi)).toHaveLength(1);
    expect(code.match(/INSERT INTO/gi)).toHaveLength(1);
    // 🔴 No UPDATE STATEMENT: history is copied, never normalised.
    //
    // The pattern is `UPDATE <table> SET`, not a bare /UPDATE\s+\w/ — which is what the first
    // draft used, and it failed on `BEFORE UPDATE ON audit_events`, the append-only TRIGGER this
    // migration is careful to recreate. Same mistake as a /file/ that matches "proFILE": a pattern
    // loose enough to hit a different grammatical construct is not evidence about statements.
    expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    // And the trigger that forbids updates IS present — the control for the line above.
    expect(code).toMatch(/BEFORE UPDATE ON audit_events/);
    // 🔴 And the copy is SELECT *, with no expression that could silently transform a column.
    expect(code).toMatch(/INSERT INTO audit_events_v10 SELECT \* FROM audit_events ORDER BY seq/);
  });

  it("registers with its own checksum, and every migration's is distinct", () => {
    seedV9();
    const db = upgrade();
    try {
      const applied = rows(db, "SELECT version, name, checksum FROM schema_migrations ORDER BY version");
      expect(applied).toHaveLength(10);
      const m10 = applied[9]! as { version: bigint; name: string; checksum: string };
      expect(Number(m10.version)).toBe(10);
      expect(m10.name).toBe("product_master_audit");
      const sums = applied.map((r) => r.checksum);
      expect(new Set(sums).size).toBe(sums.length);
    } finally {
      db.close();
    }
  });

  it("🔴 a NEWER schema is still refused — the downgrade guard survives the rebuild", () => {
    seedV9();
    const db = upgrade();
    db.close();
    // A ledger written by a future build must not be opened by this one.
    const future = openDatabase(t.dbPath, V10, { fileMustExist: true });
    future
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (11, 'from_the_future', 'deadbeef', '2026-12-01T00:00:00.000Z')`,
      )
      .run();
    future.close();
    expect(() => openDatabase(t.dbPath, V10, { fileMustExist: true })).toThrow();
  });
});
