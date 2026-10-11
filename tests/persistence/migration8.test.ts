/**
 * Migration 8 — operator accounts, run against a POPULATED v7 database.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE DATABASE HERE IS POPULATED, AND NOT FRESH. Migration 7's own comment records the
 * lesson this suite is built around: a rebuild strategy that leaned on `defer_foreign_keys` passed
 * every test on an EMPTY ledger and failed instantly on a real v3 one carrying a sale, its lines
 * and a void, because the implicit DELETE inside DROP TABLE counts one deferred violation per
 * referencing child row. An empty database cannot see that class of defect at all.
 *
 * So every test below seeds real v7 rows FIRST and migrates afterwards. `audit_events` is a leaf
 * table, so this migration should not hit that trap — but "should not" is a prediction, and the
 * point of seeding is to stop it being one.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Synthetic throughout. The two fixture ids are the product's own, not a merchant's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { type TempDir, tempDir } from "../helpers/harness";

const V7 = MIGRATIONS.filter((m) => m.version <= 7);
const V8 = MIGRATIONS;

let t: TempDir;

beforeEach(() => {
  t = tempDir();
});
afterEach(() => {
  t.cleanup();
});

/** A v7 database carrying a real sale, its lines, a void, an invoice and audit rows. */
function seedV7(): void {
  const db = openDatabase(t.dbPath, V7);
  try {
    expect(schemaVersion(db)).toBe(7);
    db.exec(`
      INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type,
                         invoice_id, cashier_id, cashier_name, currency, subtotal_minor, tax_minor,
                         total_minor, paid_minor, balance_due_minor, payment_status, payment_method,
                         line_count, business_date, completed_at, created_at)
      VALUES ('sale-1', 1, 'idem-0000001', 'fp-1', 'pos', NULL, 'cashier-01', 'Cashier One',
              'USD', 1000, 0, 1000, 1000, 0, 'paid', 'cash', 1, '2026-10-01',
              '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'),
             ('sale-2', 2, 'idem-0000002', 'fp-2', 'pos', NULL, 'cashier-02', 'Cashier Two',
              'USD', 500, 0, 500, 500, 0, 'paid', 'cash', 1, '2026-10-01',
              '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z');

      INSERT INTO sale_lines (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name,
                              sale_unit, unit_label, quantity_milli, unit_price_minor,
                              line_total_minor)
      VALUES ('line-1', 'sale-1', 1, NULL, 'p-1', 'SKU-1', 'صنف اختباري', 'piece', 'حبة',
              1000, 1000, 1000),
             ('line-2', 'sale-2', 1, NULL, 'p-2', 'SKU-2', 'صنف آخر', 'piece', 'حبة',
              1000, 500, 500);

      -- A void, so 'sales' has a referencing child exactly as it did when migration 7 was written.
      INSERT INTO voids (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at)
      VALUES ('void-1', 'sale-2', 'cashier-01', 'Cashier One', 'wrong item', '2026-10-01',
              '2026-10-01T10:05:00.000Z');

      -- Two audit rows, both 'unspecified', which is what every real row carries today.
      INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id, actor_name,
                                actor_tier, occurred_at, business_date, changed_json, metadata_json,
                                app_version, schema_version)
      VALUES ('audit-1', 1, 'PRODUCT_CREATED', 'product', 'p-1', 'cashier-01', 'Cashier One',
              'unspecified', '2026-10-01T08:00:00.000Z', '2026-10-01', '{"name_ar":"صنف اختباري"}',
              NULL, '0.1.1', 7),
             ('audit-2', 2, 'CATALOG_IMPORTED', 'catalog', 'catalog', 'cashier-01', 'Cashier One',
              'unspecified', '2026-10-01T08:30:00.000Z', '2026-10-01', '{"rows":2}',
              '{"file":"synthetic.csv"}', '0.1.1', 7);
    `);
  } finally {
    db.close();
  }
}

/** Opens the seeded database with the full migration set, i.e. runs migration 8. */
function upgrade(): Db {
  const db = openDatabase(t.dbPath, V8);
  expect(schemaVersion(db)).toBe(8);
  return db;
}

const rows = (db: Db, sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
const one = (db: Db, sql: string) => rows(db, sql)[0]!;

describe("migration 8 on a populated v7 database", () => {
  it("upgrades a real v7 ledger to v8", () => {
    seedV7();
    const db = upgrade();
    try {
      expect(schemaVersion(db)).toBe(8);
      // 🔴 The failure mode migration 7 actually hit: a rebuild that leaves a foreign key
      // unsatisfied commits nothing and reports here.
      expect(one(db, "PRAGMA foreign_key_check")).toBeUndefined();
      expect(one(db, "PRAGMA integrity_check").integrity_check).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("🔴 leaves every historical ledger row byte for byte", () => {
    seedV7();
    const before = (() => {
      const db = openDatabase(t.dbPath, V7);
      try {
        return {
          sales: rows(db, "SELECT * FROM sales ORDER BY receipt_number"),
          lines: rows(db, "SELECT * FROM sale_lines ORDER BY id"),
          voids: rows(db, "SELECT * FROM voids ORDER BY id"),
        };
      } finally {
        db.close();
      }
    })();

    const db = upgrade();
    try {
      expect(rows(db, "SELECT * FROM sales ORDER BY receipt_number")).toEqual(before.sales);
      expect(rows(db, "SELECT * FROM sale_lines ORDER BY id")).toEqual(before.lines);
      expect(rows(db, "SELECT * FROM voids ORDER BY id")).toEqual(before.voids);
    } finally {
      db.close();
    }
  });

  it("🔴 carries every audit row across the REBUILD unchanged, seq order included", () => {
    seedV7();
    const before = (() => {
      const db = openDatabase(t.dbPath, V7);
      try {
        return rows(db, "SELECT * FROM audit_events ORDER BY seq");
      } finally {
        db.close();
      }
    })();

    const db = upgrade();
    try {
      expect(rows(db, "SELECT * FROM audit_events ORDER BY seq")).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("🔴 does NOT backfill actor_tier — history stays 'unspecified' for ever", () => {
    seedV7();
    const db = upgrade();
    try {
      const tiers = rows(db, "SELECT actor_tier AS t FROM audit_events ORDER BY seq").map((r) => r.t);
      expect(tiers).toEqual(["unspecified", "unspecified"]);
    } finally {
      db.close();
    }
  });

  it("rebuilds audit_events with its indexes and all three triggers", () => {
    seedV7();
    const db = upgrade();
    try {
      // `sql IS NOT NULL` excludes SQLite's own auto-indexes for PRIMARY KEY and UNIQUE, which are
      // real entries in sqlite_master and are not ours to assert.
      const names = (type: string) =>
        rows(
          db,
          `SELECT name FROM sqlite_master
            WHERE type = '${type}' AND tbl_name = 'audit_events' AND sql IS NOT NULL`,
        )
          .map((r) => r.name as string)
          .sort();
      expect(names("index")).toEqual([
        "audit_events_actor",
        "audit_events_date",
        "audit_events_entity",
        "audit_events_type",
      ]);
      expect(names("trigger")).toEqual([
        "audit_events_immutable_delete",
        "audit_events_immutable_update",
        "audit_events_seq_monotonic",
      ]);
      // The scaffolding table must be gone, not left beside the real one.
      expect(rows(db, "SELECT name FROM sqlite_master WHERE name = 'audit_events_v8'")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("the rebuilt audit_events is STILL append-only and still monotonic", () => {
    seedV7();
    const db = upgrade();
    try {
      expect(() => db.exec("UPDATE audit_events SET actor_name = 'x'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM audit_events")).toThrow(/cannot be deleted/);
      // seq 1 is taken, so re-using it must be refused by the recreated trigger.
      expect(() =>
        db.exec(`INSERT INTO audit_events VALUES ('a3', 1, 'PRODUCT_CREATED', 'product', 'p', 'c',
                 'C', 'owner', '2026-10-02T08:00:00.000Z', '2026-10-02', '{}', NULL, '0.1.1', 8)`),
      ).toThrow(/monotonic/);
    } finally {
      db.close();
    }
  });

  it("accepts the six operator event types, and refuses a mismatched pairing", () => {
    seedV7();
    const db = upgrade();
    try {
      const insert = (seq: number, type: string, entity: string) =>
        db.exec(`INSERT INTO audit_events VALUES ('ev-${seq}', ${seq}, '${type}', '${entity}',
                 'cashier-02', 'cashier-01', 'Cashier One', 'owner',
                 '2026-10-02T08:0${seq % 10}:00.000Z', '2026-10-02', '{}', NULL, '0.1.1', 8)`);
      const six = [
        "OPERATOR_CREATED",
        "OPERATOR_RENAMED",
        "OPERATOR_PIN_RESET",
        "OPERATOR_ACTIVATED",
        "OPERATOR_DEACTIVATED",
        "OPERATOR_ROLE_CHANGED",
      ];
      six.forEach((type, i) => insert(10 + i, type, "operator"));
      expect(rows(db, "SELECT count(*) AS n FROM audit_events WHERE entity_type = 'operator'")[0]!.n).toBe(6n);

      // 🔴 The pairing backstop: an operator event may not describe a product.
      expect(() => insert(99, "OPERATOR_CREATED", "product")).toThrow();
      // ...nor a product event an operator.
      expect(() => insert(98, "PRODUCT_CREATED", "operator")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("the bootstrap operator rows", () => {
  it("🔴 preserves BOTH fixture ids, so historical ledger references stay resolvable", () => {
    seedV7();
    const db = upgrade();
    try {
      const ops = rows(db, "SELECT id, name, role, must_reset_pin, is_active FROM operators ORDER BY id");
      expect(ops).toEqual([
        { id: "cashier-01", name: "Cashier One", role: "owner", must_reset_pin: 1n, is_active: 1n },
        { id: "cashier-02", name: "Cashier Two", role: "cashier", must_reset_pin: 1n, is_active: 1n },
      ]);
      // Every cashier id named by the ledger resolves to an operator row. This is the whole reason
      // the ids were preserved rather than regenerated.
      const orphans = rows(
        db,
        `SELECT DISTINCT cashier_id FROM sales
          WHERE cashier_id NOT IN (SELECT id FROM operators)
         UNION
         SELECT DISTINCT cashier_id FROM voids
          WHERE cashier_id NOT IN (SELECT id FROM operators)`,
      );
      expect(orphans).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("carries the legacy hashes verbatim, as bootstrap credentials only", () => {
    seedV7();
    const db = upgrade();
    try {
      const owner = one(db, "SELECT pin_salt_hex AS s, pin_hash_hex AS h FROM operators WHERE id = 'cashier-01'");
      expect(owner.s).toBe("a1f3c9e27b4d6058");
      expect(owner.h).toBe("a8f8c45b97712daec733a8b4d198ac96376c05697b5935a7b30f965e27478bce");
      // What makes them harmless is the flag, not their shape — they are 4-digit PINs that would
      // pass the PIN rule perfectly well.
      expect(one(db, "SELECT must_reset_pin AS m FROM operators WHERE id = 'cashier-01'").m).toBe(1n);
    } finally {
      db.close();
    }
  });

  it("writes timestamps in the ISO shape the rest of the schema uses", () => {
    seedV7();
    const db = upgrade();
    try {
      const { c } = one(db, "SELECT created_at AS c FROM operators WHERE id = 'cashier-01'") as { c: string };
      expect(c).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      db.close();
    }
  });

  it("refuses a second operator with the same name", () => {
    seedV7();
    const db = upgrade();
    try {
      expect(() =>
        db.exec(`INSERT INTO operators VALUES ('op-3', 'Cashier One', 'cashier',
                 '0123456789abcdef', '${"a".repeat(64)}', 0, 1,
                 '2026-10-02T08:00:00.000Z', '2026-10-02T08:00:00.000Z')`),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("refuses an unknown role, and admits the reserved 'admin' without exposing it", () => {
    seedV7();
    const db = upgrade();
    try {
      const insert = (id: string, role: string) =>
        db.exec(`INSERT INTO operators VALUES ('${id}', 'name-${id}', '${role}',
                 '0123456789abcdef', '${"b".repeat(64)}', 0, 1,
                 '2026-10-02T08:00:00.000Z', '2026-10-02T08:00:00.000Z')`);
      expect(() => insert("op-bad", "manager")).toThrow();
      // Reserved on purpose: widening this CHECK later would mean rebuilding the table.
      expect(() => insert("op-admin", "admin")).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("the migration is fingerprinted and immutable", () => {
  it("registers under the existing integrity mechanism with its own checksum", () => {
    seedV7();
    const db = upgrade();
    try {
      const applied = rows(db, "SELECT version, name, checksum FROM schema_migrations ORDER BY version");
      expect(applied).toHaveLength(8);
      const m8 = applied[7]! as { version: bigint; name: string; checksum: string };
      expect(Number(m8.version)).toBe(8);
      expect(m8.name).toBe("operator_accounts");
      expect(m8.checksum).toMatch(/^[0-9a-f]{64}$/);
      // Each migration's fingerprint is its own.
      const sums = applied.map((r) => r.checksum);
      expect(new Set(sums).size).toBe(sums.length);
    } finally {
      db.close();
    }
  });

  it("🔴 a v7 BUILD REFUSES a v8 database — this is the rollback contract, as code", () => {
    seedV7();
    upgrade().close();
    // A v7 executable sees more applied migrations than it knows and refuses to open the file.
    // Therefore rollback is: restore the pre-migration backup, THEN run the v7 build. Reinstalling
    // the old EXE alone is not a rollback, and this assertion is why that sentence is true.
    expect(() => openDatabase(t.dbPath, V7)).toThrow(/newer than this build/);
  });

  it("migrations 1-7 are untouched by this change", () => {
    // Their checksums are what an existing installation already has on disk; editing any of them
    // would make every real ledger refuse to open with MigrationMismatchError.
    expect(MIGRATIONS.filter((m) => m.version <= 7)).toHaveLength(7);
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(MIGRATIONS[7]!.name).toBe("operator_accounts");
  });
});
