/**
 * O-1 investigation (owner, 2026-11-25): does a CLAIMED owner keep their own credentials across a backup restore,
 * and does the published bootstrap PIN stop working there? SYNTHETIC ledgers only; no merchant data.
 *
 * A full backup's ledger is `snapshotDatabase()` (VACUUM INTO): one SQLite file with every table, so the operators
 * (scrypt salt + hash), terminal_security_state and audit_events travel with it. The restore engine swaps that file
 * in at startup; opening the snapshot directly is the same database the restored till opens.
 *
 * 🔴 TESTS 2 AND 3 PIN TODAY'S VULNERABLE BEHAVIOUR ON PURPOSE (investigation evidence). The O-1 implementation
 * (D-O2: retire Cashier Two at enrollment; legacy ownership binding instead of the public 1111) MUST flip them —
 * as TRANSITIONs with the decision named — never delete them.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperatorService } from "../../src/application/operatorService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { snapshotDatabase } from "../../src/persistence/backup";
import { type Db, openDatabase } from "../../src/persistence/db";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { tempDir } from "../helpers/harness";

function service(db: Db) {
  let ids = 0;
  return new OperatorService({
    operators: new OperatorRepository(db),
    audit: new AuditRepository(db, { appVersion: "test", schemaVersion: 21 }),
    transact: (fn) => db.transaction(fn).immediate(),
    terminal: FIXTURE_TERMINAL,
    now: () => new Date("2026-11-25T12:00:00.000Z"),
    newId: () => `o1-${++ids}`,
  });
}
const claimed = (db: Db) =>
  Number((db.prepare("SELECT terminal_claimed AS c FROM terminal_security_state").get() as { c: bigint | number }).c);
const outcome = (fn: () => unknown) => {
  try {
    const r = fn() as { kind: string };
    return r.kind;
  } catch (e) {
    return (e as { code?: string }).code ?? "ERROR";
  }
};

describe("O-1 — ownership across a backup restore (synthetic)", () => {
  it("a CLAIMED ledger restores with its owner: own PIN signs in, the public 1111 does not, the claim stays", () => {
    const t = tempDir();
    try {
      const live = openDatabase(t.dbPath);
      const svc = service(live);
      const first = svc.authenticate("cashier-01", "1111") as { kind: string; ticket: string };
      expect(first.kind).toBe("setup");
      svc.completeSetup(first.ticket, "Real Owner", "482613");
      expect(claimed(live)).toBe(1);
      const backup = join(t.dir, "backup-ledger.sqlite");
      snapshotDatabase(live, backup);
      live.close();

      // «restore» onto another computer/profile: the snapshot becomes the live ledger file.
      const restoredPath = join(t.dir, "restored", "alzabt-pos-ledger.sqlite");
      mkdirSync(join(t.dir, "restored"));
      copyFileSync(backup, restoredPath);
      const restored = openDatabase(restoredPath);
      try {
        const r = service(restored);
        expect(claimed(restored), "the claim travels with the ledger").toBe(1);
        expect(outcome(() => r.authenticate("cashier-01", "482613")), "the owner's OWN PIN").toBe("session");
        expect(outcome(() => r.authenticate("cashier-01", "1111")), "the published PIN no longer works").toBe("INVALID_CREDENTIALS");
      } finally {
        restored.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("R-A2 (proven by execution): after the owner claims, the seeded Cashier Two + public 2222 still yields a setup ticket", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      const svc = service(db);
      const first = svc.authenticate("cashier-01", "1111") as { kind: string; ticket: string };
      svc.completeSetup(first.ticket, "Real Owner", "482613");
      // Anyone who knows the published 2222 can now choose a private PIN for an ACTIVE cashier account.
      expect(outcome(() => svc.authenticate("cashier-02", "2222"))).toBe("setup");
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it("an UNCLAIMED ledger WITH data (the legacy case) is claimable with the published 1111 — the O-1 blocker", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      // Business data present, nobody ever claimed (what a pre-v8 shop looks like after migrating to v21).
      db.prepare(
        "INSERT INTO catalog_products (id, source, source_key, name_ar, selling_price_minor, currency, base_unit, price_needs_review, is_active, created_at, updated_at) VALUES ('legacy-1','manual','k','صنف',100,'USD','piece',0,1,'2026-01-01','2026-01-01')",
      ).run();
      expect(claimed(db)).toBe(0);
      expect(outcome(() => service(db).authenticate("cashier-01", "1111")), "public PIN reaches the owner setup").toBe("setup");
    } finally {
      db.close();
      t.cleanup();
    }
  });
});
