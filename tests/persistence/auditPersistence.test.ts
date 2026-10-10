/**
 * The trail is durable, the actor is a snapshot, and no secret ever reaches the table.
 *
 * Every assertion here reads the REAL rows back out of SQLite — after closing and reopening the
 * database, in the persistence tests — rather than trusting what the writer said it wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const draft = { nameAr: "صنف", nameEn: "Item", sku: "SYN-1", price: "4.00", baseUnit: "piece" };
const trailOf = (db: Db) => new AuditRepository(db, { appVersion: "test", schemaVersion: MIGRATIONS.length });

describe("the audit trail survives a restart", () => {
  it("the row, its seq, its diff and its actor are all still there after reopening", () => {
    const h = makeHarness(t.dbPath);
    const row = h.service.createProduct(draft);
    h.service.updateProduct(row.id, { ...draft, price: "9.00" }, true);
    const before = h.audit.listRecent(10);
    h.db.close();

    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    try {
      const after = trailOf(db).listRecent(10);
      expect(after).toEqual(before);
      expect(after.map((r) => r.seq)).toEqual([2, 1]);
      expect(JSON.parse(after[0]!.changed_json)).toEqual({
        selling_price_minor: { before: "400", after: "900" },
      });
      expect(after[0]!.actor_name).toBe("Cashier One");
      // A new event after the restart continues the same sequence — it does not restart at 1.
      const h2 = makeHarness(t.dbPath, { login: true });
      h2.service.setProductActive(row.id, false);
      expect(h2.audit.listRecent(1)[0]!.seq).toBe(3);
      h2.db.close();
    } finally {
      db.close();
    }
  });

  it("the trail is still append-only after a restart — the triggers came with the schema", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(draft);
    h.db.close();
    const db = openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true });
    try {
      expect(() => db.prepare("UPDATE audit_events SET actor_id = 'x'").run()).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/cannot be deleted/);
    } finally {
      db.close();
    }
  });
});

describe("the actor is a snapshot, not a reference", () => {
  it("there is no actors table to point at, so nothing can invalidate a historical row", () => {
    const h = makeHarness(t.dbPath);
    try {
      h.service.createProduct(draft);
      // No foreign key on the audit table at all.
      expect(h.db.pragma("foreign_key_list(audit_events)")).toEqual([]);
      // And there is no table a key could even reference — the cashiers are a code fixture.
      expect(
        h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%cashier%'").all(),
      ).toEqual([{ name: "cashier_pin_state" }]);
      const stored = h.audit.listRecent(1)[0]!;
      expect(stored.actor_id).toBe("cashier-01");
      expect(stored.actor_name).toBe("Cashier One");
      // 🔴 Recorded as unknown rather than guessed: this build has no role model at all.
      expect(stored.actor_tier).toBe("unspecified");
      // The row carries the build that wrote it, so a later reader knows which conventions applied.
      expect(stored.app_version).toBe("test");
      expect(stored.schema_version).toBe(MIGRATIONS.length);
    } finally {
      h.db.close();
    }
  });

  it("a future rename of the actor cannot rewrite what history says — the trigger forbids it", () => {
    const h = makeHarness(t.dbPath);
    try {
      h.service.createProduct(draft);
      expect(() =>
        h.db.prepare("UPDATE audit_events SET actor_name = 'Someone Else' WHERE actor_id = 'cashier-01'").run(),
      ).toThrow(/append-only/);
      expect(h.audit.listRecent(1)[0]!.actor_name).toBe("Cashier One");
    } finally {
      h.db.close();
    }
  });
});

describe("🔴 no secret is ever persisted", () => {
  const SECRET = /pin|password|passwd|token|secret|credential|api[_-]?key|hash/i;

  it("every stored row, walked at any depth, carries no credential-shaped key or value", () => {
    const h = makeHarness(t.dbPath);
    try {
      // Exercise every path that writes an audit row.
      const row = h.service.createProduct(draft);
      h.service.updateProduct(row.id, { ...draft, price: "7.00", baseUnit: "kg", nameEn: "Thing" }, true);
      h.service.setProductActive(row.id, false);
      h.service.setProductActive(row.id, true);
      h.service.importCatalogCsv(
        "synthetic.csv",
        new TextEncoder().encode(
          [
            "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review",
            "1,صنف ألف,,1.00,USD,piece,0",
          ].join("\n"),
        ),
      );
      const rows = h.audit.listRecent(100);
      expect(rows.length).toBeGreaterThanOrEqual(5);

      const walk = (value: unknown, path: string): void => {
        if (value === null || value === undefined) return;
        if (Array.isArray(value)) {
          value.forEach((v, i) => walk(v, `${path}[${i}]`));
          return;
        }
        if (typeof value === "object") {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            expect(SECRET.test(k), `${path}.${k} is credential-shaped`).toBe(false);
            walk(v, `${path}.${k}`);
          }
          return;
        }
        if (typeof value === "string") {
          // `file_sha256` is the only legitimate digest, and it is a FILE digest, not a credential.
          if (path.endsWith("file_sha256")) return;
          expect(SECRET.test(value), `${path} = '${value}' looks like a credential`).toBe(false);
        }
      };

      for (const r of rows) {
        walk({ ...r, changed_json: undefined, metadata_json: undefined }, r.id);
        walk(JSON.parse(r.changed_json), `${r.id}.changed_json`);
        if (r.metadata_json) walk(JSON.parse(r.metadata_json), `${r.id}.metadata_json`);
      }

      // And the raw text of the PAYLOAD COLUMNS, as a last resort check.
      //
      // 🔴 NOT the whole table. This scanned JSON.stringify(rows) for bare substrings including
      // "PIN", and it passes today only because makeHarness clears must_reset_pin through the
      // repository, so no OPERATOR_PIN_RESET row ever reaches this trail. The first test here that
      // exercises a real operator event would fail on its own event type — which is not a leak,
      // because that event type IS the fact the trail must record. The identical trap has now been
      // sprung three times in the E2E suite; this is the fourth instance, disarmed before it fires.
      //
      // The keys are already checked properly by walk() above. What this adds is a scan for a
      // secret hiding in a VALUE, so it looks only where values live.
      const payloads = rows
        .map((r) => `${r.changed_json ?? ""}|${r.metadata_json ?? ""}`)
        .join("|")
        .replace(/"file_sha256":"[0-9a-f]{64}"/g, '"file_sha256":""');
      for (const needle of ["pin", "Pin", "PIN", "hash", "token", "secret", "1111", "2222"]) {
        expect(payloads, `no audit payload may contain '${needle}'`).not.toContain(needle);
      }
    } finally {
      h.db.close();
    }
  });
});
