/**
 * O-1 Phase 1 (contract v3.1 §2 + review R4): «an empty shop» is a CLOSED, enumerated list, and anything it does not
 * know makes the answer «not empty». New-shop enrollment trusts this answer, so a wrong «empty» would let a stranger
 * enroll as the owner of a shop with history. Synthetic ledgers only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatorService } from "../../src/application/operatorService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import {
  BUSINESS_TABLES,
  COUNTER_TABLES,
  SYSTEM_TABLES,
  ledgerEmptiness,
  presentTables,
} from "../../src/persistence/ledgerEmptiness";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const KNOWN = new Set<string>([...BUSINESS_TABLES, ...COUNTER_TABLES, ...SYSTEM_TABLES]);

describe("ledgerEmptiness — the classification is complete", () => {
  it("🔴 every table the CURRENT schema creates is classified (a new migration's table fails here by name)", () => {
    const unclassified = presentTables(db).filter((name) => !KNOWN.has(name));
    expect(unclassified).toEqual([]);
  });

  it("the three lists do not overlap", () => {
    const all = [...BUSINESS_TABLES, ...COUNTER_TABLES, ...SYSTEM_TABLES];
    expect(new Set(all).size).toBe(all.length);
  });

  it("a freshly migrated ledger is empty", () => {
    expect(ledgerEmptiness(db)).toEqual({ empty: true, reasons: [] });
  });

  it("🔴 every HISTORICAL schema (each migration prefix, 1..n) is fully classified and reads empty when fresh", () => {
    for (let n = 1; n <= MIGRATIONS.length; n++) {
      const legacy = tempDir();
      const old = openDatabase(legacy.dbPath, MIGRATIONS.slice(0, n));
      try {
        expect(presentTables(old).filter((name) => !KNOWN.has(name)), `schema v${n}`).toEqual([]);
        expect(ledgerEmptiness(old), `schema v${n}`).toEqual({ empty: true, reasons: [] });
      } finally {
        old.close();
        legacy.cleanup();
      }
    }
  });
});

describe("ledgerEmptiness — fails CLOSED", () => {
  it("🔴 an UNKNOWN table makes the ledger not empty, even with zero rows", () => {
    db.exec("CREATE TABLE some_future_feature (id TEXT PRIMARY KEY)");
    expect(ledgerEmptiness(db)).toEqual({ empty: false, reasons: ["unclassified table some_future_feature"] });
  });

  it("🔴 an unknown table on an OLD schema fails closed too", () => {
    const legacy = tempDir();
    const old = openDatabase(legacy.dbPath, MIGRATIONS.slice(0, 7));
    try {
      old.exec("CREATE TABLE hand_made_notes (x TEXT)");
      expect(ledgerEmptiness(old).empty).toBe(false);
    } finally {
      old.close();
      legacy.cleanup();
    }
  });

  it("a business row makes it not empty (catalog)", () => {
    db.prepare(
      "INSERT INTO catalog_products (id, source, source_key, name_ar, selling_price_minor, currency, base_unit, price_needs_review, is_active, created_at, updated_at) VALUES ('p1','manual','k','صنف',100,'USD','piece',0,1,'2026-01-01','2026-01-01')",
    ).run();
    expect(ledgerEmptiness(db)).toEqual({ empty: false, reasons: ["catalog_products has rows"] });
  });

  it("🔴 an AUDIT row alone makes it not empty — any operator event is shop history", () => {
    // A real event through the real service: the owner (as an actor) creates an operator.
    const svc = new OperatorService({
      operators: new OperatorRepository(db),
      audit: new AuditRepository(db, { appVersion: "test", schemaVersion: MIGRATIONS.length }),
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: () => new Date("2026-11-25T12:00:00.000Z"),
      newId: () => "op-x",
    });
    svc.create({ id: "cashier-01", name: "Cashier One", role: "owner" }, { name: "جعفر", role: "cashier", pin: "567812" });
    const report = ledgerEmptiness(db);
    expect(report.empty).toBe(false);
    expect(report.reasons).toContain("audit_events has rows");
  });

  it("🔴 a non-zero document counter makes it not empty, though the counter rows themselves are allowed", () => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM document_numbers").get()).toEqual({ n: 3n });
    db.prepare("UPDATE document_numbers SET last_no = 1 WHERE kind = 'collection'").run();
    expect(ledgerEmptiness(db)).toEqual({ empty: false, reasons: ["document_numbers has issued numbers"] });
  });

  it("system tables never decide emptiness: sign-in attempts and the operators themselves", () => {
    db.prepare("INSERT INTO cashier_pin_state (cashier_id, failed_attempts, locked_until, updated_at) VALUES ('cashier-01', 3, NULL, '2026-01-01')").run();
    db.prepare("UPDATE operators SET name = 'x' WHERE id = 'cashier-02'").run();
    expect(ledgerEmptiness(db).empty).toBe(true);
  });

  it("reports every reason, not just the first", () => {
    db.exec("CREATE TABLE zz_unknown (x TEXT)");
    db.prepare("UPDATE document_numbers SET last_no = 1 WHERE kind = 'advance'").run();
    expect(ledgerEmptiness(db).reasons).toEqual(["unclassified table zz_unknown", "document_numbers has issued numbers"]);
  });
});
