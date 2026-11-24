import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareTrialProfile, TRIAL_APP_NAME } from "../../src/main/trialIsolation";
import { openDatabase } from "../../src/persistence/db";
import { planLedgerOpen, recordLedger } from "../../src/main/ledgerGuard";
import { existsSync, renameSync } from "node:fs";

describe("trial profile preflight on disposable synthetic directories", () => {
  let root: string;
  let production: string;
  const input = () => ({ appData: root, env: {}, argv: [], packaged: true,
    appName: TRIAL_APP_NAME, executablePath: join(root, `${TRIAL_APP_NAME}.exe`) });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "alzabt-trial-isolation-"));
    production = join(root, "Alzabt POS");
    mkdirSync(production);
    writeFileSync(join(production, "alzabt-pos-ledger.sqlite"), "SYNTHETIC MERCHANT SENTINEL");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates and reuses only its marked profile while leaving the production sentinel intact", () => {
    const profile = prepareTrialProfile(input());
    expect(profile).toBe(join(root, "Alzabt POS TRIAL Test Data"));
    expect(prepareTrialProfile(input())).toBe(profile);
    expect(readFileSync(join(production, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("SYNTHETIC MERCHANT SENTINEL");
  });
  it("refuses production profile and diagnostic overrides before creating a profile", () => {
    expect(() => prepareTrialProfile({ ...input(), env: { ALZABT_POS_USER_DATA: production } })).toThrow();
    expect(() => prepareTrialProfile({ ...input(), env: { ALZABT_POS_DIAG_LOG: join(production, "x") } })).toThrow();
    expect(() => prepareTrialProfile({ ...input(), argv: [`--user-data-dir=${production}`] })).toThrow();
    expect(() => prepareTrialProfile({ ...input(), appData: production })).toThrow(/production profile/);
    expect(readFileSync(join(production, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("SYNTHETIC MERCHANT SENTINEL");
  });
  it.each(["ELECTRON_LOG_FILE", "ELECTRON_ENABLE_LOGGING", "CHROME_LOG_FILE"])("refuses %s before JS profile creation", (key) => {
    expect(() => prepareTrialProfile({ ...input(), env: { [key]: join(production, "sentinel.log") } })).toThrow(/overrides/);
    expect(readFileSync(join(production, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("SYNTHETIC MERCHANT SENTINEL");
  });
  it.each(["user-data-dir", "disk-cache-dir", "app-data-dir", "log-file", "log-net-log", "enable-logging", "diagnostic-dir"])("refuses --%s before JS profile creation", (flag) => {
    expect(() => prepareTrialProfile({ ...input(), argv: [`--${flag}=${production}`] })).toThrow(/overrides/);
  });
  it("refuses a production identity and unexpected executable", () => {
    expect(() => prepareTrialProfile({ ...input(), appName: "Alzabt POS" })).toThrow();
    expect(() => prepareTrialProfile({ ...input(), executablePath: join(root, "Alzabt POS.exe") })).toThrow();
  });
  it("refuses a nonempty unmarked profile instead of adopting an existing ledger", () => {
    const path = join(root, "Alzabt POS TRIAL Test Data");
    mkdirSync(path);
    writeFileSync(join(path, "alzabt-pos-ledger.sqlite"), "UNRECOGNIZED");
    expect(() => prepareTrialProfile(input())).toThrow(/production ledger/);
    expect(readFileSync(join(path, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("UNRECOGNIZED");
  });
  it("does not adopt a renamed ledger in an unmarked profile", () => {
    const profile = join(root, "Alzabt POS TRIAL Test Data");
    mkdirSync(profile);
    const ledger = join(profile, "alzabt-pos-trial-only-ledger.sqlite");
    writeFileSync(ledger, "SYNTHETIC UNRECOGNIZED LEDGER");
    expect(() => prepareTrialProfile(input())).toThrow(/Unrecognized trial profile/);
    expect(readFileSync(ledger, "utf8")).toBe("SYNTHETIC UNRECOGNIZED LEDGER");
  });
  it("refuses a production-named ledger even in an already marked profile", () => {
    const profile = prepareTrialProfile(input());
    writeFileSync(join(profile, "alzabt-pos-ledger.sqlite"), "COPIED SYNTHETIC SENTINEL");
    expect(() => prepareTrialProfile(input())).toThrow(/production ledger/);
    expect(readFileSync(join(profile, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("COPIED SYNTHETIC SENTINEL");
  });
  it("refuses a trial-named ledger without its ledger record in a marked profile", () => {
    const profile = prepareTrialProfile(input());
    const ledger = join(profile, "alzabt-pos-trial-only-ledger.sqlite");
    writeFileSync(ledger, "SYNTHETIC UNRECOGNIZED LEDGER");
    expect(() => prepareTrialProfile(input())).toThrow(/ledger record is missing or invalid/);
    expect(readFileSync(ledger, "utf8")).toBe("SYNTHETIC UNRECOGNIZED LEDGER");
  });
  it("reopens a synthetic SQLite ledger in its marked profile without touching the production sentinel", () => {
    const fs = { exists: existsSync, writeAtomic: (path: string, contents: string) => {
      writeFileSync(`${path}.tmp`, contents); renameSync(`${path}.tmp`, path);
    } };
    const profile = prepareTrialProfile(input());
    const first = planLedgerOpen(profile, fs);
    expect(first.existing).toBe(false);
    const db = openDatabase(first.ledgerPath);
    db.exec("CREATE TABLE synthetic_restart_probe (value TEXT NOT NULL); INSERT INTO synthetic_restart_probe VALUES ('trial only')");
    recordLedger(first, fs, { appVersion: "test", now: new Date("2026-01-01T00:00:00Z") });
    db.close();
    expect(prepareTrialProfile(input())).toBe(profile);
    const next = planLedgerOpen(profile, fs);
    expect(next.existing).toBe(true);
    const reopened = openDatabase(next.ledgerPath, undefined, { fileMustExist: true });
    expect(reopened.prepare("SELECT value FROM synthetic_restart_probe").get()).toEqual({ value: "trial only" });
    reopened.close();
    expect(readFileSync(join(production, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("SYNTHETIC MERCHANT SENTINEL");
  });
  it("does not silently create a replacement after the trial ledger goes missing", () => {
    const profile = prepareTrialProfile(input());
    writeFileSync(join(profile, "ledger.json"), "{}");
    expect(() => planLedgerOpen(profile, { exists: existsSync, writeAtomic: () => { throw new Error("unexpected write"); } })).toThrow(/ledger file is missing/);
    expect(existsSync(join(profile, "alzabt-pos-trial-only-ledger.sqlite"))).toBe(false);
  });
  it.each(["-wal", "-shm", "-journal"])("refuses an orphan trial ledger sidecar %s", (suffix) => {
    const profile = prepareTrialProfile(input());
    const path = join(profile, `alzabt-pos-trial-only-ledger.sqlite${suffix}`);
    writeFileSync(path, "SYNTHETIC SIDECAR");
    expect(() => prepareTrialProfile(input())).toThrow(/orphan SQLite sidecars/);
    expect(readFileSync(path, "utf8")).toBe("SYNTHETIC SIDECAR");
  });
  it("refuses a hard-linked production sentinel and pending restore", () => {
    const profile = prepareTrialProfile(input());
    linkSync(join(production, "alzabt-pos-ledger.sqlite"), join(profile, "collision.sqlite"));
    expect(() => prepareTrialProfile(input())).toThrow(/hard-linked/);
    rmSync(join(profile, "collision.sqlite"));
    mkdirSync(join(profile, "restore"));
    writeFileSync(join(profile, "restore", "journal.json"), "{}");
    expect(() => prepareTrialProfile(input())).toThrow(/pending restore/);
    expect(readFileSync(join(production, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("SYNTHETIC MERCHANT SENTINEL");
  });
  it("refuses a junction from the trial profile into the production sentinel directory", () => {
    const profile = prepareTrialProfile(input());
    symlinkSync(production, join(profile, "redirect"), "junction");
    expect(() => prepareTrialProfile(input())).toThrow(/link or junction/);
    expect(readFileSync(join(production, "alzabt-pos-ledger.sqlite"), "utf8")).toBe("SYNTHETIC MERCHANT SENTINEL");
  });
});
