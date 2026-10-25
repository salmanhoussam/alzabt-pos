/**
 * Migration 18 — an external receipt shared across several debts, added to a populated v17 ledger
 * and then attacked with RAW SQL (no service in the way).
 *
 * Synthetic data only. Part 1: what must NOT change. Part 2: the database ITSELF refuses a receipt
 * that is not exactly allocated, a reference used twice (either direction), an allocation after the
 * seal, a closed attempt posting money, and every edit or delete.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { snapshotDatabase } from "../../src/persistence/backup";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";
import { AT, DAY, addObligation, addParty, child, count, directSettlement, operatorId, seal } from "../helpers/receiptDb";

const V17 = 17;
const V18 = 18;
const MIGRATIONS_V17 = MIGRATIONS.slice(0, V17);
let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type Row = Record<string, unknown>;
const TABLES = ["settlements", "obligations", "parties", "sales", "invoices", "operators", "collection_attempts"];
const rows = (db: Db): Record<string, Row[]> =>
  Object.fromEntries(TABLES.map((n) => [n, db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all() as Row[]]));
const checksums = (db: Db) =>
  db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version <= 17 ORDER BY version").all() as Row[];
const NEW_OBJECTS = [
  "receipts",
  "receipt_attempts",
  "receipt_attempt_lines",
  "receipt_attempts_open",
  "receipts_provider_reference",
  "settlements_receipt",
  "receipts_seal",
  "receipts_reference_vs_settlements",
  "settlements_reference_vs_receipts",
  "settlements_receipt_sealed",
  "receipts_closed_attempt",
  "receipts_match_intent",
  "receipts_immutable_update",
  "receipts_immutable_delete",
  "receipt_attempts_resolve_once",
  "receipt_attempts_resolution_truth",
  "receipt_attempts_no_delete",
  "receipt_attempt_lines_open_only",
  "receipt_attempt_lines_immutable_update",
  "receipt_attempt_lines_immutable_delete",
];
const objects = (db: Db) =>
  (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Row[])
    .filter((o) => !NEW_OBJECTS.includes(String(o.name)) && o.name !== "settlements" && !String(o.name).startsWith("sqlite_autoindex"));

function seedV17(path: string): void {
  const db = openDatabase(path, MIGRATIONS_V17);
  try {
    addParty(db, "cust-1");
    addObligation(db, "o1", "cust-1", "USD", 5000);
    directSettlement(db, "hist-key-0001", "o1", "USD", 1000, null, null); // an old untagged external
    directSettlement(db, "hist-key-0002", "o1", "USD", 500, "whish", "WH-OLD-1");
    db.prepare(
      `INSERT INTO collection_attempts (idempotency_key, customer_id, obligation_id, currency, amount_minor, channel, reference, funds_confirmed, request_fingerprint, created_by, created_at)
       VALUES ('open-attempt-01', 'cust-1', 'o1', 'USD', 100, 'whish', 'WH-OPEN', 1, 'fp', ?, ?)`,
    ).run(operatorId(db), AT);
  } finally {
    db.close();
  }
}

/** A fresh v18 ledger: two USD debts and an LBP debt for c1, a debt for c2, a supplier payable. */
function fresh(): Db {
  const db = openDatabase(t.dbPath, MIGRATIONS);
  addParty(db, "c1");
  addParty(db, "c2");
  addParty(db, "sup", "supplier");
  addParty(db, "gone", "customer", 0);
  addObligation(db, "A", "c1", "USD", 6000);
  addObligation(db, "B", "c1", "USD", 4000);
  addObligation(db, "F", "c1", "USD", 90000);
  addObligation(db, "G", "c1", "USD", 90000);
  addObligation(db, "L", "c1", "LBP", 900000000);
  addObligation(db, "D2", "c2", "USD", 5000);
  addObligation(db, "P", "sup", "USD", 5000, "supplier");
  addObligation(db, "X", "gone", "USD", 5000);
  return db;
}

/** Runs `fn` in one immediate transaction; returns "COMMIT" or the refusal message. */
function tx(db: Db, fn: () => void): string {
  try {
    db.transaction(fn).immediate();
    return "COMMIT";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("migration 18 on a populated v17 ledger", () => {
  it("adds only new tables, one NULL column and triggers; every historical row, object and checksum is untouched", () => {
    seedV17(t.dbPath);
    const pre = openDatabase(t.dbPath, MIGRATIONS_V17);
    const before = { rows: rows(pre), objects: objects(pre), sums: checksums(pre) };
    pre.close();

    const backup = `${t.dir}/pre-m18.sqlite`;
    const db = openDatabase(t.dbPath, MIGRATIONS, {
      beforeMigrations: (conn, pending) => {
        expect(pending).toEqual({ fromVersion: V17, toVersion: V18 });
        snapshotDatabase(conn, backup);
      },
    });
    try {
      expect(schemaVersion(db)).toBe(V18);
      const after = rows(db);
      for (const table of TABLES) {
        const cols = Object.keys(before.rows[table]![0] ?? {});
        const projected = after[table]!.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
        expect(projected, table).toEqual(before.rows[table]);
      }
      // Every historical settlement is a DIRECT collection: receipt_id NULL, nothing relabelled.
      expect(count(db, "settlements", "receipt_id IS NOT NULL")).toBe(0);
      expect(count(db, "receipts")).toBe(0);
      expect(count(db, "receipt_attempts")).toBe(0);
      expect(objects(db)).toEqual(before.objects);
      expect(checksums(db)).toEqual(before.sums); // M1–M17 byte-identical
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // M17's own guards still bite.
      expect(() => db.prepare("UPDATE settlements SET reference = 'x'").run()).toThrow(/immutable/);
    } finally {
      db.close();
    }
    const restored = openDatabase(backup, MIGRATIONS_V17, { fileMustExist: true });
    try {
      expect(schemaVersion(restored)).toBe(V17);
      expect(rows(restored)).toEqual(before.rows);
    } finally {
      restored.close();
    }
  });

  it("an older build refuses a v18 database (no downgrade)", () => {
    openDatabase(t.dbPath, MIGRATIONS).close();
    expect(() => openDatabase(t.dbPath, MIGRATIONS_V17)).toThrow(/newer than this build/);
  });
});

describe("🔴 the database itself seals a receipt exactly (raw SQL, no service)", () => {
  it("happy path: allocations first, the receipt last — one commit", () => {
    const db = fresh();
    try {
      expect(
        tx(db, () => {
          child(db, "R1", "A", "USD", 6000);
          child(db, "R1", "B", "USD", 4000);
          seal(db, "R1", "c1", "USD", 10000, 2, "whish", "WH-123");
        }),
      ).toBe("COMMIT");
      expect(count(db, "receipts")).toBe(1);
      expect(count(db, "settlements", "receipt_id = 'R1'")).toBe(2);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("a MISSING seal fails the whole transaction at COMMIT (deferred foreign key) and writes nothing", () => {
    const db = fresh();
    try {
      const r = tx(db, () => {
        child(db, "R2", "A", "USD", 1000);
        child(db, "R2", "B", "USD", 1000);
      });
      expect(r).toMatch(/FOREIGN KEY/);
      expect(count(db, "settlements", "receipt_id IS NOT NULL")).toBe(0);
    } finally {
      db.close();
    }
  });

  const refused: Array<[string, (db: Db) => void, RegExp]> = [
    ["a missing allocation (1 of 2)", (db) => { child(db, "R", "F", "USD", 1000); seal(db, "R", "c1", "USD", 2000, 2, "whish", "W-1"); }, /allocated exactly/],
    ["a surplus allocation (3 for 2)", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "G", "USD", 500); child(db, "R", "A", "USD", 500); seal(db, "R", "c1", "USD", 1500, 2, "whish", "W-2"); }, /allocated exactly/],
    ["a total that does not equal the shares (99 vs 100)", (db) => { child(db, "R", "F", "USD", 5000); child(db, "R", "G", "USD", 4900); seal(db, "R", "c1", "USD", 10000, 2, "whish", "W-3"); }, /allocated exactly/],
    ["a total larger than the shares (101 vs 100)", (db) => { child(db, "R", "F", "USD", 5000); child(db, "R", "G", "USD", 5000); seal(db, "R", "c1", "USD", 10100, 2, "whish", "W-4"); }, /allocated exactly/],
    ["the same debt twice (two rows, one debt)", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "F", "USD", 500); seal(db, "R", "c1", "USD", 1000, 2, "whish", "W-5"); }, /allocated exactly/],
    ["another customer's debt", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "D2", "USD", 500); seal(db, "R", "c1", "USD", 1000, 2, "whish", "W-6"); }, /allocated exactly/],
    ["a supplier payable", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "P", "USD", 500); seal(db, "R", "c1", "USD", 1000, 2, "whish", "W-7"); }, /allocated exactly/],
    ["a debt in another currency (LBP in a USD receipt)", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "L", "LBP", 500); seal(db, "R", "c1", "USD", 1000, 2, "whish", "W-8"); }, /allocated exactly/],
    ["an allocation that is not an external, reference-free row", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "G", "USD", 500, { method: "cash" }); seal(db, "R", "c1", "USD", 1000, 2, "whish", "W-9"); }, /allocated exactly/],
    ["an allocation carrying its own provider reference", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "G", "USD", 500, { provider: "whish", reference: "W-SUB", confirmed: 1 }); seal(db, "R", "c1", "USD", 1000, 2, "whish", "W-10"); }, /allocated exactly/],
    ["an inactive customer", (db) => { child(db, "R", "X", "USD", 500); child(db, "R", "F", "USD", 500); seal(db, "R", "gone", "USD", 1000, 2, "whish", "W-11"); }, /allocated exactly/],
    ["a single-debt receipt", (db) => { child(db, "R", "F", "USD", 500); seal(db, "R", "c1", "USD", 500, 1, "whish", "W-12"); }, /allocation_count|CHECK/i],
    ["an unknown provider", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "G", "USD", 500); seal(db, "R", "c1", "USD", 1000, 2, "paypal", "W-13"); }, /CHECK/i],
    ["an empty reference", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "G", "USD", 500); seal(db, "R", "c1", "USD", 1000, 2, "whish", ""); }, /CHECK/i],
    ["a padded reference", (db) => { child(db, "R", "F", "USD", 500); child(db, "R", "G", "USD", 500); seal(db, "R", "c1", "USD", 1000, 2, "whish", " W-14"); }, /CHECK/i],
    ["a share above a debt's outstanding (overpayment)", (db) => { child(db, "R", "A", "USD", 6001); child(db, "R", "G", "USD", 1); seal(db, "R", "c1", "USD", 6002, 2, "whish", "W-15"); }, /exceed what is owed/],
  ];
  for (const [name, fn, expected] of refused) {
    it(`refuses ${name}, atomically`, () => {
      const db = fresh();
      try {
        const settlementsBefore = count(db, "settlements");
        const r = tx(db, () => fn(db));
        expect(r).toMatch(expected);
        expect(count(db, "receipts")).toBe(0);
        expect(count(db, "settlements")).toBe(settlementsBefore); // the children rolled back with it
      } finally {
        db.close();
      }
    });
  }

  it("an overpayment is refused even when two receipts race for the same debt", () => {
    const db = fresh();
    try {
      expect(tx(db, () => { child(db, "R1", "A", "USD", 5000); child(db, "R1", "F", "USD", 100); seal(db, "R1", "c1", "USD", 5100, 2, "whish", "W-A1"); })).toBe("COMMIT");
      // A now has 1000 left; a second receipt asking 2000 of it must fail whole.
      const r = tx(db, () => { child(db, "R2", "A", "USD", 2000); child(db, "R2", "G", "USD", 100); seal(db, "R2", "c1", "USD", 2100, 2, "whish", "W-A2"); });
      expect(r).toMatch(/exceed what is owed/);
      expect(count(db, "receipts")).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("🔴 reference uniqueness across receipts and direct collections, both directions", () => {
  it("a receipt cannot reuse a reference already on a DIRECT M17 collection, and vice-versa", () => {
    const db = fresh();
    try {
      directSettlement(db, "direct-key-0001", "F", "USD", 100, "whish", "WH-DIRECT");
      expect(tx(db, () => { child(db, "R1", "F", "USD", 100); child(db, "R1", "G", "USD", 100); seal(db, "R1", "c1", "USD", 200, 2, "whish", "WH-DIRECT"); })).toMatch(/already recorded as a collection/);
      expect(tx(db, () => { child(db, "R2", "F", "USD", 100); child(db, "R2", "G", "USD", 100); seal(db, "R2", "c1", "USD", 200, 2, "whish", "WH-123"); })).toBe("COMMIT");
      expect(() => directSettlement(db, "direct-key-0002", "F", "USD", 100, "whish", "WH-123")).toThrow(/already recorded as a receipt/);
      // The rule is per provider: the same text under the other provider is a different reference.
      directSettlement(db, "direct-key-0003", "F", "USD", 100, "bank_transfer", "WH-123");
      // and a receipt cannot repeat another receipt's pair
      expect(tx(db, () => { child(db, "R3", "F", "USD", 100); child(db, "R3", "G", "USD", 100); seal(db, "R3", "c1", "USD", 200, 2, "whish", "WH-123"); })).toMatch(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it("a receipt-linked allocation cannot carry an independently reusable provider reference", () => {
    const db = fresh();
    try {
      // The seal refuses it; and a direct row with a provider reference is a different thing entirely.
      expect(tx(db, () => { child(db, "R1", "F", "USD", 100, { provider: "whish", reference: "W-X", confirmed: 1 }); child(db, "R1", "G", "USD", 100); seal(db, "R1", "c1", "USD", 200, 2, "whish", "W-REAL"); })).toMatch(/allocated exactly/);
      expect(count(db, "settlements", "reference = 'W-X'")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("an allocation settlement satisfies every existing M17 settlement-shape trigger", () => {
    const db = fresh();
    try {
      // method external + NULL provider/reference/confirmation is the historical external shape.
      expect(tx(db, () => { child(db, "R1", "F", "USD", 100); child(db, "R1", "G", "USD", 100); seal(db, "R1", "c1", "USD", 200, 2, "bank_transfer", "BT-1"); })).toBe("COMMIT");
      const a = db.prepare("SELECT method, provider, reference, funds_confirmed FROM settlements WHERE receipt_id = 'R1'").all();
      expect(a).toEqual([
        { method: "external", provider: null, reference: null, funds_confirmed: null },
        { method: "external", provider: null, reference: null, funds_confirmed: null },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("🔴 a sealed receipt is closed and immutable", () => {
  function sealedDb(): Db {
    const db = fresh();
    tx(db, () => { child(db, "R1", "A", "USD", 6000); child(db, "R1", "B", "USD", 4000); seal(db, "R1", "c1", "USD", 10000, 2, "whish", "WH-123"); });
    return db;
  }
  it("no allocation can be added after the seal", () => {
    const db = sealedDb();
    try {
      expect(() => child(db, "R1", "F", "USD", 100)).toThrow(/sealed receipt cannot take another allocation/);
    } finally {
      db.close();
    }
  });
  it("no allocation can be altered or deleted, and the receipt cannot be edited or deleted", () => {
    const db = sealedDb();
    try {
      expect(() => db.prepare("UPDATE settlements SET amount_minor = 1 WHERE receipt_id = 'R1'").run()).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE settlements SET receipt_id = NULL WHERE receipt_id = 'R1'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM settlements WHERE receipt_id = 'R1'").run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare("UPDATE receipts SET amount_minor = 1").run()).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE receipts SET reference = 'EDITED'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM receipts").run()).toThrow(/cannot be deleted/);
      expect(count(db, "receipts")).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("🔴 receipt attempts: immutable intent, truthful resolution, closed means closed", () => {
  const key = "attempt-key-0001";
  function attempt(db: Db, over: { key?: string; count?: number } = {}): void {
    db.prepare(
      `INSERT INTO receipt_attempts (idempotency_key, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, request_fingerprint, created_by, created_at)
       VALUES (?, 'c1', 'USD', 10000, 'whish', 'WH-123', 1, ?, 'fp', ?, ?)`,
    ).run(over.key ?? key, over.count ?? 2, operatorId(db), AT);
  }
  const line = (db: Db, ob: string, amt: number, k = key) =>
    db.prepare("INSERT INTO receipt_attempt_lines (idempotency_key, obligation_id, amount_minor) VALUES (?,?,?)").run(k, ob, amt);

  it("lines are bounded by the declared count and frozen; the intent cannot be edited or deleted", () => {
    const db = fresh();
    try {
      attempt(db);
      line(db, "A", 6000);
      line(db, "B", 4000);
      expect(() => line(db, "F", 1)).toThrow(/already holds all of its lines/);
      expect(() => db.prepare("UPDATE receipt_attempt_lines SET amount_minor = 1").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM receipt_attempt_lines").run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare("UPDATE receipt_attempts SET amount_minor = 1").run()).toThrow(/only be resolved, once/);
      expect(() => db.prepare("UPDATE receipt_attempts SET reference = 'EDIT'").run()).toThrow(/only be resolved, once/);
      expect(() => db.prepare("DELETE FROM receipt_attempts").run()).toThrow(/cannot be deleted/);
    } finally {
      db.close();
    }
  });

  it("the resolution cannot lie: 'recorded' needs the receipt, 'not_recorded' forbids it, and it is written once", () => {
    const db = fresh();
    try {
      attempt(db);
      line(db, "A", 6000);
      line(db, "B", 4000);
      const resolve = (r: string) => db.prepare("UPDATE receipt_attempts SET resolved_at = ?, resolution = ? WHERE idempotency_key = ?").run(AT, r, key);
      expect(() => resolve("recorded")).toThrow(/must match the ledger/); // no receipt yet
      expect(tx(db, () => { child(db, "R1", "A", "USD", 6000); child(db, "R1", "B", "USD", 4000); seal(db, "R1", "c1", "USD", 10000, 2, "whish", "WH-123", key); })).toBe("COMMIT");
      expect(() => resolve("not_recorded")).toThrow(/must match the ledger/); // the receipt exists
      resolve("recorded");
      expect(() => resolve("recorded")).toThrow(/only be resolved, once/);
    } finally {
      db.close();
    }
  });

  it("an attempt closed as NOT recorded can never post money under its key (raw SQL)", () => {
    const db = fresh();
    try {
      attempt(db);
      line(db, "A", 6000);
      line(db, "B", 4000);
      db.prepare("UPDATE receipt_attempts SET resolved_at = ?, resolution = 'not_recorded' WHERE idempotency_key = ?").run(AT, key);
      const r = tx(db, () => { child(db, "R9", "A", "USD", 6000); child(db, "R9", "B", "USD", 4000); seal(db, "R9", "c1", "USD", 10000, 2, "whish", "WH-123", key); });
      expect(r).toMatch(/closed receipt attempt cannot be recorded/);
      expect(count(db, "receipts")).toBe(0);
      expect(count(db, "settlements", "receipt_id IS NOT NULL")).toBe(0);
    } finally {
      db.close();
    }
  });
});
