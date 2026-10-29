/**
 * Track 2 phase 3 — the restore engine's place in startup (src/main/restoreStartup.ts), the ledger
 * guard's refusal while a restore is undecided, and what the merchant is told either way.
 *
 * main.ts calls exactly these, in exactly this order: runPendingRestore → planLedgerOpen →
 * openDatabase (with the pre-migration backup) → recordLedger. Every test here runs that order on
 * temp folders.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerRestorePendingError, planLedgerOpen, recordLedger } from "../../src/main/ledgerGuard";
import { nullLogger } from "../../src/main/logger";
import { RestoreHaltedError, restoreNoticeFor, runPendingRestore } from "../../src/main/restoreStartup";
import { classifyStartupError, startupFailureMessage } from "../../src/main/startupFailure";
import { createPreMigrationBackup } from "../../src/persistence/backup";
import { type BackupFs, createFullBackup, nodeBackupFs } from "../../src/persistence/backupPackage";
import { openDatabase, schemaVersion } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { LIVE_LEDGER_FILE, applyPendingRestore, inspectRestorePackage, stageRestore } from "../../src/persistence/restoreEngine";
import { type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

const NOW = new Date("2026-10-28T12:00:00.000Z");
let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const ledgerFs = { exists: existsSync, writeAtomic: (p: string, c: string) => writeFileSync(p, c) };

/** main.ts's startTill, minus Electron: restore first, then the guard, then the open. */
function startTill(userData: string) {
  const restore = runPendingRestore({ userDataDir: userData, now: NOW, log: nullLogger });
  const plan = planLedgerOpen(userData, ledgerFs);
  const db = openDatabase(plan.ledgerPath, MIGRATIONS, {
    fileMustExist: plan.existing,
    beforeMigrations: (openDb, pending) => void createPreMigrationBackup(openDb, join(userData, "backups"), pending, NOW),
  });
  recordLedger(plan, ledgerFs, { appVersion: "0.1.1", now: NOW });
  return { restore, plan, db };
}

/** A package of a ledger with `sales` cash sales, made at `schema` migrations. */
function packageOf(name: string, sales: number, migrations = MIGRATIONS): string {
  const dir = join(t.dir, `src-${name}`);
  mkdirSync(dir);
  let db;
  if (migrations === MIGRATIONS) {
    const h = makeHarness(join(dir, "ledger.sqlite"));
    for (let i = 0; i < sales; i++) {
      h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
    }
    db = h.db;
  } else {
    db = openDatabase(join(dir, "ledger.sqlite"), migrations);
  }
  try {
    return createFullBackup(db, { userDataDir: dir, destDir: join(t.dir, `pkg-${name}`), appVersion: "0.1.1", now: NOW }).path;
  } finally {
    db.close();
  }
}

function stage(userData: string, pkg: string): void {
  const p = inspectRestorePackage(pkg);
  stageRestore({ userDataDir: userData, packageDir: pkg, consent: { manifestSha256: p.manifestSha256, acceptedMissingAssets: [] }, now: NOW });
}

const salesIn = (db: { prepare: (s: string) => { get: () => unknown } }) => Number((db.prepare("SELECT count(*) AS n FROM sales").get() as { n: bigint }).n);

describe("normal startup is unchanged", () => {
  it("no journal → `none`, and a fresh profile opens a new ledger and records its marker", () => {
    const u = join(t.dir, "fresh");
    mkdirSync(u);
    const { restore, plan, db } = startTill(u);
    expect(restore).toEqual({ kind: "none" });
    expect(plan.existing).toBe(false);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    db.close();
    expect(existsSync(join(u, "ledger.json"))).toBe(true);
    expect(restoreNoticeFor(restore, "ar")).toBeNull();
  });
});

describe("🔴 stage → restart → restore → a correct ledger", () => {
  it("an existing profile: the restored ledger opens; ledger.json is untouched; the pre-restore copy is kept", () => {
    const u = join(t.dir, "بيانات المحل");
    mkdirSync(u);
    startTill(u).db.close(); // a real profile: ledger + marker
    const marker = readFileSync(join(u, "ledger.json"));
    stage(u, packageOf("a", 3));
    const { restore, plan, db } = startTill(u);
    expect(restore.kind).toBe("restored");
    expect(plan.existing).toBe(true);
    expect(salesIn(db)).toBe(3);
    db.close();
    expect(readFileSync(join(u, "ledger.json"))).toEqual(marker);
    expect(readdirSync(join(u, "restore")).some((n) => n.startsWith("pre-restore-"))).toBe(true);
    const notice = restoreNoticeFor(restore, "ar")!;
    expect(notice.title).toBe("تمّت استعادة النسخة الاحتياطيّة");
    expect(notice.body).toContain("لم يُحذف منها شيء");
  });

  it("a FRESH profile (no ledger, no marker): restored, and the marker is written after its first open", () => {
    const u = join(t.dir, "fresh");
    mkdirSync(u);
    stage(u, packageOf("a", 2));
    const { restore, plan, db } = startTill(u);
    expect(restore.kind).toBe("restored");
    expect(plan.existing).toBe(true); // never a new empty ledger
    expect(salesIn(db)).toBe(2);
    db.close();
    expect(existsSync(join(u, "ledger.json"))).toBe(true);
  });

  it("an OLDER backup is restored by the engine and upgraded by the NORMAL startup path, behind its pre-migration backup", () => {
    const u = join(t.dir, "profile");
    mkdirSync(u);
    startTill(u).db.close();
    stage(u, packageOf("v17", 0, MIGRATIONS.slice(0, 17)));
    const { restore, db } = startTill(u);
    expect(restore.kind).toBe("restored");
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    db.close();
    expect(readdirSync(join(u, "backups")).some((n) => n.startsWith("pre-migration-v17-to-v18-"))).toBe(true);
  });

  it("a power cut during the restore: the next start finishes it and opens the restored ledger", () => {
    const u = join(t.dir, "profile");
    mkdirSync(u);
    startTill(u).db.close();
    stage(u, packageOf("a", 4));
    let n = 0;
    let dead = false;
    const dying: BackupFs = Object.fromEntries(
      Object.entries(nodeBackupFs).map(([k, fn]) => [
        k,
        (...args: unknown[]) => {
          if (dead) throw new Error("the process is dead");
          if (["rename", "removeTree", "writeFile", "mkdir", "copyFile"].includes(k) && ++n === 5) {
            dead = true;
            throw new Error("power cut");
          }
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as BackupFs;
    expect(applyPendingRestore({ userDataDir: u, now: NOW, fs: dying }).kind).toBe("halted");
    const { restore, db } = startTill(u);
    expect(restore.kind).toBe("restored");
    expect(salesIn(db)).toBe(4);
    db.close();
  });
});

describe("🔴 an undecided restore never opens the till", () => {
  it("a halted restore throws RestoreHaltedError → RESTORE_INCOMPLETE, and the message does not claim 'not modified'", () => {
    const u = join(t.dir, "profile");
    mkdirSync(u);
    startTill(u).db.close();
    stage(u, packageOf("a", 1));
    writeFileSync(join(u, "restore", "journal.json"), "{ half");
    let thrown: unknown;
    try {
      startTill(u);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RestoreHaltedError);
    expect(classifyStartupError(thrown)).toBe("RESTORE_INCOMPLETE");
    const msg = startupFailureMessage("RESTORE_INCOMPLETE", "0.1.1 (test)");
    expect(msg.body).not.toContain("was not modified");
    expect(msg.body).not.toContain("لم يتم تعديل بيانات المبيعات");
    expect(msg.body).toContain("Nothing was deleted");
    expect(msg.body).toContain("لم يُحذف شيء");
    // Ordinary failures keep their reassurance.
    expect(startupFailureMessage("DB_CORRUPT", "x").body).toContain("was not modified");
  });

  it("🔴 the ledger guard refuses to open OR create a ledger while a journal exists — belt and braces", () => {
    const u = join(t.dir, "profile");
    mkdirSync(u);
    startTill(u).db.close();
    stage(u, packageOf("a", 1));
    // Skipping the engine (a future wiring mistake) must fail closed, with a ledger present…
    expect(() => planLedgerOpen(u, ledgerFs)).toThrow(LedgerRestorePendingError);
    expect(classifyStartupError(new LedgerRestorePendingError())).toBe("RESTORE_INCOMPLETE");
    // …and in a fresh profile, where it would otherwise create an empty ledger.
    const fresh = join(t.dir, "fresh");
    mkdirSync(fresh);
    stage(fresh, packageOf("b", 1));
    expect(() => planLedgerOpen(fresh, ledgerFs)).toThrow(LedgerRestorePendingError);
    expect(existsSync(join(fresh, LIVE_LEDGER_FILE))).toBe(false);
  });
});

describe("what the owner is told after a restore ran", () => {
  it("each outcome has its own sentence, in both languages", () => {
    const restored = { kind: "restored", id: "x", preRestoreDir: "d", complete: true, missingAssets: [] } as const;
    const incomplete = { ...restored, complete: false, missingAssets: [{ kind: "frozen-logo", name: "a.png", reason: "absent-at-source" }] } as const;
    const rolled = { kind: "rolled-back", id: "x", reason: "r" } as const;
    const aborted = { kind: "aborted", id: "x", reason: "r" } as const;
    for (const lang of ["ar", "en"] as const) {
      const bodies = [restored, rolled, aborted].map((o) => restoreNoticeFor(o, lang)!.body);
      expect(new Set(bodies).size).toBe(3);
      expect(restoreNoticeFor(incomplete, lang)!.body.length).toBeGreaterThan(restoreNoticeFor(restored, lang)!.body.length);
    }
    expect(restoreNoticeFor(rolled, "en")!.body).toContain("returned exactly");
    expect(restoreNoticeFor({ kind: "halted", id: null, reason: "x" }, "en")).toBeNull();
  });
});
