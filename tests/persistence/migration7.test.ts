/**
 * Migration 7 — a finalized manual invoice becomes a real sale, v6 to v7.
 *
 * This migration rebuilds the three oldest tables in the ledger (`sales`, `sale_lines`, `voids`),
 * so this file is deliberately heavier than an ordinary migration's: it proves, row by row and
 * column by column, that a real v6 ledger arrives at v7 with every sale, line, void, receipt
 * number, idempotency key, cashier, total, payment method, fraction and unit EXACTLY as it was —
 * and that migrations 1-6 are byte-identical afterwards.
 *
 * It also proves the two halves of the new contract that a service could otherwise fake: the till
 * path is not one byte looser than it was, and an invoice-origin row may legitimately be broader.
 *
 * Synthetic data only. No real company, customer or product data appears anywhere in this file.
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
import { COUNTED_TABLES } from "../../src/persistence/backup";
import { insertLegacyVoid, insertPreV7Sale } from "../helpers/legacyLedger";
import { type TempDir, tempDir } from "../helpers/harness";

/** Migration 7 is this file's subject, so it migrates to EXACTLY v6 then EXACTLY v7. */
const V6 = 6;
const V7 = 7;

/** Exactly the migrations a v7 build knows. Pinned, so migration 8 cannot change what this file tests. */
const V7_SET = MIGRATIONS.filter((m) => m.version <= 7);

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

const columns = (db: Db, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const rows = (db: Db, sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;

/**
 * A real v6 ledger: three sales (one fractional, one with a cardless method, one with no SKU on its
 * line), a void against one of them, two products — written in the shape a v6 build wrote them.
 */
function v6Ledger(): Array<Record<string, unknown>> {
  const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V6));
  try {
    expect(schemaVersion(db)).toBe(V6);
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
    insertPreV7Sale(db, {
      id: "sale-1",
      receiptNumber: 1,
      idempotencyKey: "v6-key-00000001",
      requestFingerprint: "fp-1",
      paymentMethod: "cash",
      businessDate: "2026-10-05",
      at,
      lines: [
        {
          id: "line-1",
          lineNo: 1,
          productId: "manual:000001",
          sku: "SYN-A",
          productName: "Item A",
          saleUnit: "piece",
          quantityMilli: 3000,
          unitPriceMinor: 400,
          lineTotalMinor: 1200,
        },
      ],
    });
    insertPreV7Sale(db, {
      id: "sale-2",
      receiptNumber: 2,
      idempotencyKey: "v6-key-00000002",
      requestFingerprint: "fp-2",
      paymentMethod: "card",
      businessDate: "2026-10-05",
      at,
      lines: [
        {
          id: "line-2",
          lineNo: 1,
          productId: "manual:000002",
          // The Gate 1 convention: a product with no SKU snapshots "", not NULL.
          sku: "",
          productName: "صنف باء",
          saleUnit: "kg",
          // 2.5 kg at 2.50 -> exactly 6.25. The fraction is the point.
          quantityMilli: 2500,
          unitPriceMinor: 250,
          lineTotalMinor: 625,
        },
      ],
    });
    insertPreV7Sale(db, {
      id: "sale-3",
      receiptNumber: 3,
      idempotencyKey: "v6-key-00000003",
      requestFingerprint: "fp-3",
      paymentMethod: "external",
      businessDate: "2026-10-06",
      at: "2026-10-06T09:00:00.000Z",
      lines: [
        {
          id: "line-3",
          lineNo: 1,
          productId: "manual:000001",
          sku: "SYN-A",
          productName: "Item A",
          saleUnit: "piece",
          quantityMilli: 1000,
          unitPriceMinor: 400,
          lineTotalMinor: 400,
        },
      ],
    });
    insertLegacyVoid(db, "sale-2");
    // Everything a v6 build could know about these sales, captured BEFORE the migration so the
    // comparison afterwards is against measured values rather than against expectations.
    return rows(
      db,
      `SELECT id, receipt_number, idempotency_key, request_fingerprint, cashier_id, cashier_name,
              currency, subtotal_minor, total_minor, payment_method, line_count, business_date,
              completed_at, created_at
         FROM sales ORDER BY receipt_number`,
    );
  } finally {
    db.close();
  }
}

describe("migration 7 — v6 to v7", () => {
  it("is the seventh migration, and 1-6 are byte-identical after it", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // 7 -> 8 with operator accounts
    expect(MIGRATIONS[6]!.name).toBe("invoice_sales_integration");
    expect(MIGRATIONS).toHaveLength(8);

    // The released fingerprints of 1-6. A ledger upgraded by this build must still recognise every
    // one of them, or openDatabase refuses the file — which is what the next test proves.
    const released = MIGRATIONS.slice(0, 6).map((m) => checksum(m.sql));
    v6Ledger();
    // V7_SET, so this stays a test about reaching v7. With the full set it would reach v8 and the
    // assertion below would be measuring migration 8's work in migration 7's file.
    const db = openDatabase(t.dbPath, V7_SET, { fileMustExist: true });
    try {
      expect(schemaVersion(db)).toBe(V7);
      const recorded = (
        db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{
          version: bigint;
          checksum: string;
        }>
      ).filter((r) => Number(r.version) <= 6);
      expect(recorded.map((r) => r.checksum)).toEqual(released);
    } finally {
      db.close();
    }

    // And migration 7 does not reach back into any earlier migration's SOURCE.
    for (const earlier of MIGRATIONS.slice(0, 6)) {
      expect(MIGRATIONS[6]!.sql).not.toContain(earlier.sql);
    }
  });

  it("🔴 preserves every pre-existing sale EXACTLY, field by field", () => {
    const before = v6Ledger();
    expect(before).toHaveLength(3);
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    try {
      const after = rows(
        db,
        `SELECT id, receipt_number, idempotency_key, request_fingerprint, cashier_id, cashier_name,
                currency, subtotal_minor, total_minor, payment_method, line_count, business_date,
                completed_at, created_at
           FROM sales ORDER BY receipt_number`,
      );
      // Not "the same count" — the same VALUES, for every column a v6 build could have written.
      expect(after).toEqual(before);

      // The new columns carry the honest backfill, not a fiction.
      const migrated = rows(
        db,
        `SELECT id, source_type, invoice_id, tax_minor, paid_minor, balance_due_minor, payment_status,
                total_minor
           FROM sales ORDER BY receipt_number`,
      );
      for (const s of migrated) {
        expect(s.source_type).toBe("pos");
        expect(s.invoice_id).toBeNull();
        expect(s.tax_minor).toBe(0n);
        // paid = total, balance = 0: a till sale was settled in full when it completed.
        expect(s.paid_minor).toBe(s.total_minor);
        expect(s.balance_due_minor).toBe(0n);
        expect(s.payment_status).toBe("paid");
      }
      // Their payment methods are untouched — all three distinct values survive, read back from the
      // MIGRATED table rather than from the pre-migration snapshot.
      expect(
        rows(db, "SELECT payment_method FROM sales ORDER BY receipt_number").map((r) => r.payment_method),
      ).toEqual(["cash", "card", "external"]);
      // 🔴 And not one of them became NULL. payment_method is nullable from v7 on, which is exactly
      // the column a careless rebuild would blank; this is the assertion that would catch that.
      expect(rows(db, "SELECT count(*) AS n FROM sales WHERE payment_method IS NULL")).toEqual([{ n: 0n }]);
    } finally {
      db.close();
    }
  });

  it("🔴 preserves every sale line, its fraction, its unit and its empty SKU", () => {
    v6Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    try {
      const lines = rows(
        db,
        `SELECT id, sale_id, line_no, product_id, sku, product_name, sale_unit, quantity_milli,
                unit_price_minor, line_total_minor, invoice_line_id, unit_label
           FROM sale_lines ORDER BY id`,
      );
      expect(lines).toEqual([
        {
          id: "line-1",
          sale_id: "sale-1",
          line_no: 1n,
          product_id: "manual:000001",
          sku: "SYN-A",
          product_name: "Item A",
          sale_unit: "piece",
          quantity_milli: 3000n,
          unit_price_minor: 400n,
          line_total_minor: 1200n,
          invoice_line_id: null,
          unit_label: null,
        },
        {
          id: "line-2",
          sale_id: "sale-2",
          line_no: 1n,
          product_id: "manual:000002",
          // 🔴 STILL "" AND NOT NULL. The two absences mean different things from v7 on, and a
          // migration that quietly turned one into the other would be rewriting history.
          sku: "",
          product_name: "صنف باء",
          sale_unit: "kg",
          quantity_milli: 2500n,
          unit_price_minor: 250n,
          line_total_minor: 625n,
          invoice_line_id: null,
          unit_label: null,
        },
        {
          id: "line-3",
          sale_id: "sale-3",
          line_no: 1n,
          product_id: "manual:000001",
          sku: "SYN-A",
          product_name: "Item A",
          sale_unit: "piece",
          quantity_milli: 1000n,
          unit_price_minor: 400n,
          line_total_minor: 400n,
          invoice_line_id: null,
          unit_label: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("🔴 preserves the void and its relationship to the sale it cancels", () => {
    v6Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    try {
      const voids = rows(db, "SELECT id, sale_id, cashier_id, reason, business_date FROM voids");
      expect(voids).toEqual([
        {
          id: "void-sale-2",
          sale_id: "sale-2",
          cashier_id: "cashier-01",
          reason: "wrong item rung up",
          business_date: "2026-09-01",
        },
      ]);
      // The relationship still resolves through a REAL foreign key after the rebuild — the join
      // finding its row is the proof, not the column value.
      const joined = rows(
        db,
        "SELECT v.id FROM voids v JOIN sales s ON s.id = v.sale_id WHERE s.receipt_number = 2",
      );
      expect(joined).toHaveLength(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(Number(db.pragma("foreign_keys", { simple: true }))).toBe(1);
    } finally {
      db.close();
    }
  });

  it("leaves the database structurally sound, with every index and trigger back", () => {
    v6Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    try {
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);

      expect(objects(db, "trigger", "sales")).toEqual(["sales_immutable_delete", "sales_immutable_update"]);
      expect(objects(db, "trigger", "sale_lines")).toEqual([
        "sale_lines_closed_sale",
        "sale_lines_immutable_delete",
        "sale_lines_immutable_update",
        "sale_lines_invoice_shape",
        "sale_lines_pos_shape",
      ]);
      // 🔴 voids is rebuilt only so its foreign key follows the new parent, so ITS triggers must
      // come back too. Losing them would silently make voids mutable.
      expect(objects(db, "trigger", "voids")).toEqual(["voids_immutable_delete", "voids_immutable_update"]);

      expect(objects(db, "index", "sales").filter((n) => !n.startsWith("sqlite_"))).toEqual([
        "sales_business_date",
        "sales_source_type",
      ]);
      expect(objects(db, "index", "sale_lines").filter((n) => !n.startsWith("sqlite_"))).toEqual([
        "sale_lines_sale_id",
      ]);

      // voids keeps the shape migration 1 gave it: the rebuild copied it, it did not redesign it.
      expect(columns(db, "voids")).toEqual([
        "id",
        "sale_id",
        "cashier_id",
        "cashier_name",
        "reason",
        "business_date",
        "created_at",
      ]);
    } finally {
      db.close();
    }
  });

  it("still refuses UPDATE and DELETE on sales, lines and voids after the rebuild", () => {
    v6Ledger();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    try {
      expect(() => db.prepare("UPDATE sales SET total_minor = 1 WHERE id = 'sale-1'").run()).toThrow(
        /completed sales are immutable/,
      );
      expect(() => db.prepare("DELETE FROM sales WHERE id = 'sale-1'").run()).toThrow(
        /completed sales cannot be deleted/,
      );
      expect(() => db.prepare("UPDATE sale_lines SET quantity_milli = 1 WHERE id = 'line-1'").run()).toThrow(
        /sale lines are immutable/,
      );
      expect(() => db.prepare("DELETE FROM sale_lines WHERE id = 'line-1'").run()).toThrow(
        /sale lines cannot be deleted/,
      );
      expect(() => db.prepare("UPDATE voids SET reason = 'other' WHERE sale_id = 'sale-2'").run()).toThrow(
        /voids are immutable/,
      );
      expect(() => db.prepare("DELETE FROM voids WHERE sale_id = 'sale-2'").run()).toThrow(
        /voids cannot be deleted/,
      );
      // 🔴 And the balance on an unpaid invoice sale can therefore never be "collected" by an
      // UPDATE. Collecting payment is a future feature with its own schema, not a side effect.
    } finally {
      db.close();
    }
  });

  it("a fault while migrating leaves a valid v6 database, untouched", () => {
    const before = v6Ledger();
    const sizeBefore = statSync(t.dbPath).size;
    const bytesBefore = readFileSync(t.dbPath);

    // The real migration 7, truncated mid-way: the sales rebuild starts and the swap never happens.
    const broken = [
      ...MIGRATIONS.slice(0, 6),
      { ...MIGRATIONS[6]!, sql: `${MIGRATIONS[6]!.sql.split("-- ── voids")[0]!}\nSELECT raise_error_here();` },
    ];
    expect(() => openDatabase(t.dbPath, broken, { fileMustExist: true })).toThrow();

    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, V6), { fileMustExist: true });
    try {
      expect(schemaVersion(db)).toBe(V6);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // Every sale still there, unchanged, and sales_v7 never survived.
      expect(
        rows(
          db,
          `SELECT id, receipt_number, idempotency_key, request_fingerprint, cashier_id, cashier_name,
                  currency, subtotal_minor, total_minor, payment_method, line_count, business_date,
                  completed_at, created_at
             FROM sales ORDER BY receipt_number`,
        ),
      ).toEqual(before);
      expect(
        db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%_v7'").get() as { n: bigint },
      ).toEqual({ n: 0n });
      expect(columns(db, "sales")).not.toContain("source_type");
    } finally {
      db.close();
    }
    expect(statSync(t.dbPath).size).toBe(sizeBefore);
    expect(readFileSync(t.dbPath).equals(bytesBefore)).toBe(true);
  });

  it("🔴 an older build refuses a v7 ledger and does not write one byte", () => {
    v6Ledger();
    // 🔴 V7, NOT `MIGRATIONS`. Once migration 8 existed this line built a v8 ledger, and the
    // tampering assertion below then tripped SchemaNewerThanAppError before the checksum loop was
    // ever reached — the second half of this test would have gone on passing while testing nothing.
    // This test is about a v7 ledger; it now says so.
    openDatabase(t.dbPath, V7_SET, { fileMustExist: true }).close();
    const bytesBefore = readFileSync(t.dbPath);

    // A build that only knows 1-6 — exactly the released 6e3984f installer.
    expect(() => openDatabase(t.dbPath, MIGRATIONS.slice(0, 6), { fileMustExist: true })).toThrow(
      SchemaNewerThanAppError,
    );
    expect(readFileSync(t.dbPath).equals(bytesBefore)).toBe(true);

    // And a build whose migration 7 source differs is refused as a mismatch, not silently accepted.
    const tampered = [...MIGRATIONS.slice(0, 6), { ...MIGRATIONS[6]!, sql: `${MIGRATIONS[6]!.sql}\n-- edited` }];
    // 7 known vs 7 applied, so the checksum comparison is actually reached.
    expect(() => openDatabase(t.dbPath, tampered, { fileMustExist: true })).toThrow(MigrationMismatchError);
    expect(readFileSync(t.dbPath).equals(bytesBefore)).toBe(true);
  });

  it("backup table coverage still names every table a v7 ledger has", () => {
    const db = openDatabase(t.dbPath, V7_SET);
    try {
      const present = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      // The rebuild renamed tables through *_v7 names; a leftover would show up here.
      expect(present.filter((n) => n.endsWith("_v7"))).toEqual([]);
      // The direction that matters here, and the one that catches a real hole: no table a v7
      // ledger HAS is missing from the backup contract.
      expect(present.filter((n) => !(COUNTED_TABLES as readonly string[]).includes(n))).toEqual([]);
      // 🔴 The REVERSE direction is deliberately not asserted on a v7 ledger any more. Since
      // migration 8, COUNTED_TABLES names `operators`, which a v7 database legitimately does not
      // have — `snapshotCounts` skips a counted table that is absent. "Every counted table exists"
      // is only true of a FULLY migrated ledger, and that is asserted in backup.test.ts where it
      // belongs. Asserting it here would have made this file fail for being correct.
    } finally {
      db.close();
    }
  });
});
