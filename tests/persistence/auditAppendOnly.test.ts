/**
 * The audit trail is append-only, and SQLite is what enforces it — not TypeScript discipline.
 *
 * Every rejection below is asserted against the real database, through plain SQL, with no
 * application code in the way: that is the point. A bug in PosService, a future repository, or any
 * other code on this connection cannot rewrite history.
 *
 * 🔴 And the honest limit, asserted too: this protects the table against the APPLICATION. It does
 * not protect the FILE against a person who owns it — DROP TABLE does not fire BEFORE DELETE. The
 * last test states that truthfully rather than letting the others imply otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../../src/persistence/db";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;

const WELL_FORMED = {
  id: "evt-1",
  seq: 1,
  event_type: "PRODUCT_UPDATED",
  entity_type: "product",
  entity_id: "manual:000001",
  actor_id: "cashier-01",
  actor_name: "Cashier One",
  actor_tier: "unspecified",
  occurred_at: "2026-10-07T09:00:00.000Z",
  business_date: "2026-10-07",
  changed_json: '{"selling_price_minor":{"before":"400","after":"700"}}',
  metadata_json: '{"origin":"manual_entry"}',
  app_version: "test",
  schema_version: 5,
};

function insert(row: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id, actor_name,
                               actor_tier, occurred_at, business_date, changed_json, metadata_json,
                               app_version, schema_version)
     VALUES (@id, @seq, @event_type, @entity_type, @entity_id, @actor_id, @actor_name, @actor_tier,
             @occurred_at, @business_date, @changed_json, @metadata_json, @app_version, @schema_version)`,
  ).run(row);
}

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
});
afterEach(() => {
  db.close();
  t.cleanup();
});

describe("audit_events is append-only in the database itself", () => {
  it("an INSERT of a well-formed event succeeds", () => {
    insert(WELL_FORMED);
    expect(
      Number((db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: bigint }).n),
    ).toBe(1);
  });

  it("🔴 UPDATE is rejected", () => {
    insert(WELL_FORMED);
    expect(() => db.prepare("UPDATE audit_events SET actor_name = 'Someone Else'").run()).toThrow(
      /append-only/,
    );
    expect((db.prepare("SELECT actor_name FROM audit_events").get() as { actor_name: string }).actor_name).toBe(
      "Cashier One",
    );
  });

  it("🔴 DELETE is rejected", () => {
    insert(WELL_FORMED);
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/cannot be deleted/);
    expect(Number((db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: bigint }).n)).toBe(1);
  });

  it("🔴 a back-dated seq is rejected — history cannot be slotted into", () => {
    insert({ ...WELL_FORMED, id: "a", seq: 1 });
    insert({ ...WELL_FORMED, id: "b", seq: 2 });
    // This is the one forgery a CHECK is blind to: a CHECK sees only its own row.
    expect(() => insert({ ...WELL_FORMED, id: "c", seq: 2 })).toThrow();
    for (const seq of [1, 2, 0, -1]) {
      expect(() => insert({ ...WELL_FORMED, id: `x${seq}`, seq }), `seq ${seq}`).toThrow();
    }
    insert({ ...WELL_FORMED, id: "d", seq: 3 });
  });

  it("refuses an unknown event type", () => {
    expect(() => insert({ ...WELL_FORMED, event_type: "PRICE_CHANGED" })).toThrow(/CHECK/);
    expect(() => insert({ ...WELL_FORMED, event_type: "ANYTHING_AT_ALL" })).toThrow(/CHECK/);
  });

  it("refuses an event type that does not belong to its entity type", () => {
    expect(() => insert({ ...WELL_FORMED, event_type: "CATALOG_IMPORTED", entity_type: "product" })).toThrow(
      /CHECK/,
    );
    expect(() => insert({ ...WELL_FORMED, event_type: "PRODUCT_UPDATED", entity_type: "catalog" })).toThrow(
      /CHECK/,
    );
    // The legitimate pairing is accepted.
    insert({ ...WELL_FORMED, event_type: "CATALOG_IMPORTED", entity_type: "catalog", changed_json: "{}" });
  });

  it("refuses an unknown actor tier, and accepts every declared one", () => {
    expect(() => insert({ ...WELL_FORMED, actor_tier: "manager" })).toThrow(/CHECK/);
    ["owner", "admin", "cashier", "system", "unspecified"].forEach((tier, i) => {
      insert({ ...WELL_FORMED, id: `t${i}`, seq: i + 1, actor_tier: tier });
    });
  });

  it("refuses changed_json that is not a JSON object", () => {
    for (const bad of ["not json", "[1,2]", '"a string"', "42", "null"]) {
      expect(() => insert({ ...WELL_FORMED, changed_json: bad }), bad).toThrow(/CHECK/);
    }
    insert({ ...WELL_FORMED, changed_json: "{}", event_type: "CATALOG_IMPORTED", entity_type: "catalog" });
  });

  it("refuses metadata_json that is not a JSON object, but allows NULL", () => {
    expect(() => insert({ ...WELL_FORMED, metadata_json: "[1]" })).toThrow(/CHECK/);
    insert({ ...WELL_FORMED, metadata_json: null });
  });

  it("refuses a malformed timestamp or business date", () => {
    for (const bad of ["2026-10-07", "2026-10-07T09:00:00Z", "2026-10-07 09:00:00.000Z", "yesterday"]) {
      expect(() => insert({ ...WELL_FORMED, occurred_at: bad }), bad).toThrow(/CHECK/);
    }
    for (const bad of ["2026-10-7", "07/10/2026", ""]) {
      expect(() => insert({ ...WELL_FORMED, business_date: bad }), bad).toThrow(/CHECK/);
    }
  });

  it("refuses an empty entity, actor or app version", () => {
    expect(() => insert({ ...WELL_FORMED, entity_id: "" })).toThrow(/CHECK/);
    expect(() => insert({ ...WELL_FORMED, actor_id: "" })).toThrow(/CHECK/);
    expect(() => insert({ ...WELL_FORMED, actor_name: "   " })).toThrow(/CHECK/);
    expect(() => insert({ ...WELL_FORMED, app_version: "" })).toThrow(/CHECK/);
  });

  it("refuses a duplicate id or a duplicate seq", () => {
    insert(WELL_FORMED);
    expect(() => insert({ ...WELL_FORMED, seq: 2 })).toThrow(/UNIQUE/);
    expect(() => insert({ ...WELL_FORMED, id: "other" })).toThrow();
  });

  it("STRICT typing refuses a float and a non-numeric seq", () => {
    expect(() => insert({ ...WELL_FORMED, seq: 1.5 })).toThrow();
    expect(() => insert({ ...WELL_FORMED, seq: "one" })).toThrow();
    // 🔴 Measured, and stated rather than wished away: a STRICT INTEGER column DOES accept a text
    // value that is a lossless integer, converting it. That is SQLite's documented behaviour, so
    // the type system is not what keeps a string out of `seq` — `AuditRepository` allocates it as a
    // real number and nothing else writes this table.
    insert({ ...WELL_FORMED, seq: "1" });
    expect(typeof (db.prepare("SELECT seq FROM audit_events").get() as { seq: bigint }).seq).toBe("bigint");
  });

  it("🔴 states the real limit: DROP TABLE does NOT fire the delete trigger", () => {
    insert(WELL_FORMED);
    // Not a flaw being hidden — the triggers defend the trail against the application, not the file
    // against its owner. A tamper-evident hash chain would raise that bar and is not in migration 5.
    db.exec("DROP TABLE audit_events");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'audit_events'").get()).toBeUndefined();
  });
});
