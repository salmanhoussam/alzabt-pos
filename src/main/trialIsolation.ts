import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

export const TRIAL_APP_ID = "com.alzabt.pos.trial.testonly";
export const TRIAL_APP_NAME = "Alzabt POS TRIAL TEST ONLY";
const PROFILE_NAME = "Alzabt POS TRIAL Test Data";
const MARKER = ".alzabt-trial-only";
const MARKER_CONTENT = "Alzabt POS synthetic trial profile v1\n";

/** Reject orphaned SQLite sidecars; a marked profile may contain its own trial ledger.
 * The marker prevents accidental adoption of an unknown profile; it does not authenticate
 * a ledger or prevent a same-user process from replacing files after this check.
 */
export function refuseOrphanTrialSidecars(profile: string): void {
  const ledger = "alzabt-pos-trial-only-ledger.sqlite";
  const hasLedger = existsSync(join(profile, ledger));
  if (!hasLedger && ["-wal", "-shm", "-journal"].some((suffix) => existsSync(join(profile, `${ledger}${suffix}`)))) {
    throw new Error("Trial refuses orphan SQLite sidecars");
  }
  if (hasLedger) {
    let recordedName: unknown;
    try {
      recordedName = JSON.parse(readFileSync(join(profile, "ledger.json"), "utf8")).ledgerFile;
    } catch {
      throw new Error("Trial ledger record is missing or invalid");
    }
    if (recordedName !== ledger) throw new Error("Trial ledger record is missing or invalid");
  }
}

/** Refuse links and hard links before using an existing profile. Not a defense against races. */
function checkTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Trial path contains a link or junction");
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) checkTree(join(path, entry));
  } else if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("Trial profile contains an unsupported or hard-linked file");
  }
}

function checkAncestors(path: string): void {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Trial path contains a link or junction");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function prepareTrialProfile(opts: {
  appData: string;
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
  packaged: boolean;
  appName: string;
  executablePath: string;
}): string {
  if (["ALZABT_POS_USER_DATA", "ALZABT_POS_DIAG_LOG", "ELECTRON_LOG_FILE", "ELECTRON_ENABLE_LOGGING", "CHROME_LOG_FILE"].some((key) => opts.env[key] !== undefined) ||
      opts.argv.some((arg) => /^--(?:user-data-dir|disk-cache-dir|app-data-dir|log-file|log-net-log|enable-logging|diagnostic-dir)(?:=|$)/i.test(arg))) {
    throw new Error("Trial refuses profile or diagnostic path overrides");
  }
  if (opts.packaged && (opts.appName !== TRIAL_APP_NAME || basename(opts.executablePath).toLowerCase() !== `${TRIAL_APP_NAME.toLowerCase()}.exe`)) {
    throw new Error("Trial refuses an unexpected application identity");
  }
  if (!isAbsolute(opts.appData) || resolve(opts.appData) === parse(resolve(opts.appData)).root) throw new Error("Invalid app-data root");
  if (resolve(opts.appData).split(/[\\/]+/).some((part) => /^(?:alzabt pos|alzabt-pos)$/i.test(part))) {
    throw new Error("Trial refuses a production profile as its app-data root");
  }
  const profile = join(resolve(opts.appData), PROFILE_NAME);
  checkAncestors(profile);
  if (!existsSync(profile)) mkdirSync(profile);
  checkTree(profile);
  if (["alzabt-pos-ledger.sqlite", "alzabt-pos-ledger.sqlite-wal", "alzabt-pos-ledger.sqlite-shm"].some((name) => existsSync(join(profile, name)))) {
    throw new Error("Trial refuses production ledger filenames");
  }
  if (existsSync(join(profile, "restore", "journal.json"))) throw new Error("Trial refuses a pending restore");
  const marker = join(profile, MARKER);
  if (!existsSync(marker)) {
    if (readdirSync(profile).length !== 0) throw new Error("Unrecognized trial profile");
    writeFileSync(marker, MARKER_CONTENT, { flag: "wx" });
  } else if (readFileSync(marker, "utf8") !== MARKER_CONTENT) {
    throw new Error("Invalid trial profile marker");
  }
  refuseOrphanTrialSidecars(profile);
  return profile;
}
