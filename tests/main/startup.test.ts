/**
 * Startup safety: build identity, the ledger guard, failure classification + the merchant-facing
 * message, and the field log (rotation + redaction). All without Electron.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLabel, readBuildInfo } from "../../src/main/buildInfo";
import { LedgerMissingError, type LedgerFs, planLedgerOpen, recordLedger } from "../../src/main/ledgerGuard";
import { LOG_FILE_NAME, createFileLogger, redact } from "../../src/main/logger";
import { classifyStartupError, startupFailureMessage } from "../../src/main/startupFailure";
import { BackupError } from "../../src/persistence/backup";
import { openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const realFs: LedgerFs = { exists: existsSync, writeAtomic: (p, c) => writeFileSync(p, c, "utf8") };

function startupError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
}

describe("build identity", () => {
  it("reads version and build from the embedded build-info file", () => {
    const f = join(t.dir, "build-info.json");
    writeFileSync(f, JSON.stringify({ version: "0.1.1", build: "1a2b3c4", builtAt: "x" }));
    const info = readBuildInfo(f, "0.1.1");
    expect(info).toEqual({ version: "0.1.1", build: "1a2b3c4" });
    expect(buildLabel(info)).toBe("Alzabt POS 0.1.1 · Build 1a2b3c4");
  });

  it("degrades to 'unknown' without hiding a stale or missing file", () => {
    expect(readBuildInfo(join(t.dir, "missing.json"), "0.1.1")).toEqual({ version: "0.1.1", build: "unknown" });
    const f = join(t.dir, "b.json");
    writeFileSync(f, JSON.stringify({ version: "0.1.0", build: "not-a-sha!" }));
    expect(readBuildInfo(f, "0.1.1")).toEqual({ version: "0.1.1 (build-info 0.1.0)", build: "unknown" });
  });

  it("package.json carries the release version used for this field release", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("0.1.1");
  });
});

describe("ledger guard", () => {
  it("fresh profile → create; after the first open a marker is recorded", () => {
    const plan = planLedgerOpen(t.dir, realFs);
    expect(plan.existing).toBe(false);
    openDatabase(plan.ledgerPath).close();
    recordLedger(plan, realFs, { appVersion: "0.1.1", now: new Date("2026-10-05T00:00:00Z") });
    expect(JSON.parse(readFileSync(plan.markerPath, "utf8"))).toMatchObject({ recordedByVersion: "0.1.1" });
    expect(planLedgerOpen(t.dir, realFs).existing).toBe(true);
  });

  it("ledger missing but the profile had one → refuse; nothing is created", () => {
    const plan = planLedgerOpen(t.dir, realFs);
    openDatabase(plan.ledgerPath).close();
    recordLedger(plan, realFs, { appVersion: "0.1.1", now: new Date() });
    t.cleanup(); // simulate a lost ledger: recreate the folder with only the marker
    t = tempDir();
    writeFileSync(join(t.dir, "ledger.json"), "{}");
    const err = startupError(() => planLedgerOpen(t.dir, realFs));
    expect(err).toBeInstanceOf(LedgerMissingError);
    expect(existsSync(join(t.dir, "alzabt-pos-ledger.sqlite"))).toBe(false);
    expect(classifyStartupError(err)).toBe("LEDGER_MISSING");
  });

  it("a 0.1.0 ledger without a marker is adopted, not treated as missing", () => {
    openDatabase(join(t.dir, "alzabt-pos-ledger.sqlite")).close();
    const plan = planLedgerOpen(t.dir, realFs);
    expect(plan.existing).toBe(true);
    recordLedger(plan, realFs, { appVersion: "0.1.1", now: new Date() });
    expect(existsSync(plan.markerPath)).toBe(true);
  });
});

describe("startup failure classification and message", () => {
  it("a ledger from a newer build → DB_NEWER_THAN_APP", () => {
    openDatabase(t.dbPath).close();
    const err = startupError(() => openDatabase(t.dbPath, MIGRATIONS.slice(0, 2)));
    expect(classifyStartupError(err)).toBe("DB_NEWER_THAN_APP");
  });

  it("a refused newer ledger is left byte-for-byte unchanged (no WAL switch, no write before the check)", () => {
    const raw = new Database(t.dbPath); // a rollback-journal file, as an older tool might leave
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)");
    const ins = raw.prepare("INSERT INTO schema_migrations VALUES (?, 'f', 'x', 'y')");
    for (let v = 1; v <= 9; v++) ins.run(v);
    raw.close();
    const before = readFileSync(t.dbPath);
    const err = startupError(() => openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true }));
    expect(classifyStartupError(err)).toBe("DB_NEWER_THAN_APP");
    expect(readFileSync(t.dbPath).equals(before)).toBe(true);
  });

  it("an edited migration → DB_MIGRATION_MISMATCH", () => {
    openDatabase(t.dbPath).close();
    const tampered = [{ ...MIGRATIONS[0]!, sql: MIGRATIONS[0]!.sql + "\n-- edited" }, ...MIGRATIONS.slice(1)];
    expect(classifyStartupError(startupError(() => openDatabase(t.dbPath, tampered)))).toBe("DB_MIGRATION_MISMATCH");
  });

  it("a damaged file → DB_CORRUPT, and the file is left byte-for-byte untouched", () => {
    const garbage = Buffer.from("this is not a sqlite database ".repeat(200));
    writeFileSync(t.dbPath, garbage);
    const err = startupError(() => openDatabase(t.dbPath, MIGRATIONS, { fileMustExist: true }));
    expect(classifyStartupError(err)).toBe("DB_CORRUPT");
    expect(readFileSync(t.dbPath).equals(garbage)).toBe(true);
  });

  it("a missing file with fileMustExist → DB_UNAVAILABLE; a backup failure → BACKUP_FAILED", () => {
    const err = startupError(() => openDatabase(join(t.dir, "nope.sqlite"), MIGRATIONS, { fileMustExist: true }));
    expect(classifyStartupError(err)).toBe("DB_UNAVAILABLE");
    expect(classifyStartupError(new BackupError("x"))).toBe("BACKUP_FAILED");
    expect(classifyStartupError(new Error("??"))).toBe("STARTUP_FAILED");
  });

  it("the merchant message is bilingual, names the code and build, and leaks no path or stack", () => {
    const m = startupFailureMessage("DB_CORRUPT", "Alzabt POS 0.1.1 · Build 1a2b3c4");
    expect(m.title).toBe("Alzabt POS — cannot start");
    expect(m.body).toContain("Alzabt POS could not open its local database.");
    expect(m.body).toContain("Your sales data was not modified.");
    expect(m.body).toContain("Please contact support.");
    expect(m.body).toContain("تعذّر على Alzabt POS فتح قاعدة البيانات المحلية.");
    expect(m.body).toContain("Code: DB_CORRUPT");
    expect(m.body).toContain("Build 1a2b3c4");
    expect(m.body).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\/|AppData|at .*\(/);
  });
});

describe("field log", () => {
  it("writes JSON lines and redacts secret-looking fields at any depth", () => {
    const log = createFileLogger(join(t.dir, "logs"), { now: () => new Date("2026-10-05T00:00:00Z") });
    log.info("login-attempt", { cashierId: "cashier-01", pin: "1111", nested: { apiToken: "abc", count: 2n } });
    const line = JSON.parse(readFileSync(join(t.dir, "logs", LOG_FILE_NAME), "utf8").trim());
    expect(line).toMatchObject({ t: "2026-10-05T00:00:00.000Z", level: "info", event: "login-attempt", cashierId: "cashier-01" });
    expect(line.pin).toBe("[redacted]");
    expect(line.nested).toEqual({ apiToken: "[redacted]", count: "2" });
    expect(JSON.stringify(redact({ password: "x", PIN: "y", secretKey: "z" }))).not.toMatch(/"x"|"y"|"z"/);
  });

  it("rotates by size and keeps a bounded number of files", () => {
    const dir = join(t.dir, "logs");
    const log = createFileLogger(dir, { maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 50; i++) log.info("tick", { i, pad: "x".repeat(40) });
    expect(existsSync(join(dir, "alzabt-pos.log"))).toBe(true);
    expect(existsSync(join(dir, "alzabt-pos.1.log"))).toBe(true);
    expect(existsSync(join(dir, "alzabt-pos.2.log"))).toBe(true);
    expect(existsSync(join(dir, "alzabt-pos.3.log"))).toBe(false);
  });

  it("never throws, even when the folder cannot be written", () => {
    writeFileSync(join(t.dir, "file-not-dir"), "x");
    const log = createFileLogger(join(t.dir, "file-not-dir", "logs"));
    expect(() => log.error("boom", { error: new Error("x") })).not.toThrow();
  });
});
