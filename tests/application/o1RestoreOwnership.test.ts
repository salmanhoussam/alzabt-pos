/**
 * O-1 investigation (owner, 2026-11-25): does a CLAIMED owner keep their own credentials across a backup restore,
 * and does the published bootstrap PIN stop working there? SYNTHETIC ledgers only; no merchant data.
 *
 * A full backup's ledger is `snapshotDatabase()` (VACUUM INTO): one SQLite file with every table, so the operators
 * (scrypt salt + hash), terminal_security_state and audit_events travel with it. The restore engine swaps that file
 * in at startup; opening the snapshot directly is the same database the restored till opens.
 *
 * TRANSITION (O-1 Phase 1, owner decisions D-O1/D-O2 + R9, 2026-11-25). Tests 2 and 3 pinned the VULNERABLE
 * behaviour on purpose (investigation evidence, `1856c37`). Phase 1 flips them; they are kept, not deleted:
 *   2 · was «2222 still yields a setup ticket after the claim» → now: enrollment RETIRES the seeded cashier (D-O2)
 *       and 2222 is a wrong PIN (P1), even if an owner re-activates that row.
 *   3 · was «an unclaimed ledger WITH data is claimable with 1111» → now: 1111 is a wrong PIN (P1) and new-shop
 *       enrollment refuses a ledger with data. That shop's legitimate path is the signed recovery (Phase 3), which
 *       is not built yet — Phase 1 ships ONLY together with Phase 3 (R9).
 * Test 1 used to claim through «1111 → setup»; it now claims through the real new-shop path, `enrollOwner`.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperatorService } from "../../src/application/operatorService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { snapshotDatabase } from "../../src/persistence/backup";
import { ledgerEmptiness } from "../../src/persistence/ledgerEmptiness";
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
    ledgerEmpty: () => ledgerEmptiness(db).empty,
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
      // TRANSITION: was authenticate(1111) → setup → completeSetup. The published PIN no longer reaches setup.
      expect(outcome(() => svc.authenticate("cashier-01", "1111"))).toBe("INVALID_CREDENTIALS");
      svc.enrollOwner("Real Owner", "482613");
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

  it("🔴 R-A2 CLOSED (TRANSITION, D-O2 + P1): after enrollment the seeded Cashier Two is retired and 2222 never yields a ticket", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      const svc = service(db);
      const owner = svc.enrollOwner("Real Owner", "482613");
      // Was: «setup» — anyone who knew the published 2222 could choose a private PIN for an ACTIVE cashier account.
      expect(svc.listAll().find((o) => o.id === "cashier-02")!.isActive, "D-O2: retired at enrollment").toBe(false);
      expect(outcome(() => svc.authenticate("cashier-02", "2222"))).toBe("INVALID_CREDENTIALS");
      // Even if the owner re-activates that row, the published credential still opens nothing (P1).
      svc.setActive(owner, "cashier-02", true);
      expect(outcome(() => svc.authenticate("cashier-02", "2222"))).toBe("INVALID_CREDENTIALS");
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it("🔴 O-1 blocker CLOSED (TRANSITION, P1 + D-O1): an UNCLAIMED ledger WITH data is NOT claimable with 1111, nor enrollable", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      // Business data present, nobody ever claimed (what a pre-v8 shop looks like after migrating to v21).
      db.prepare(
        "INSERT INTO catalog_products (id, source, source_key, name_ar, selling_price_minor, currency, base_unit, price_needs_review, is_active, created_at, updated_at) VALUES ('legacy-1','manual','k','صنف',100,'USD','piece',0,1,'2026-01-01','2026-01-01')",
      ).run();
      expect(claimed(db)).toBe(0);
      // Was: «setup» — the public PIN reached the owner setup of a shop with history.
      expect(outcome(() => service(db).authenticate("cashier-01", "1111")), "public PIN is a wrong PIN").toBe("INVALID_CREDENTIALS");
      expect(outcome(() => service(db).enrollOwner("Stranger", "482613")), "not a new shop").toBe("ENROLLMENT_NOT_AVAILABLE");
      expect(claimed(db)).toBe(0);
    } finally {
      db.close();
      t.cleanup();
    }
  });
});
