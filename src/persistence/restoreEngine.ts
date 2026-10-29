/**
 * Restore engine — puts a verified full backup package (./backupPackage.ts) in place of the live
 * ledger and its branding, at STARTUP, with a journal that makes every step safe to repeat.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 TWO CALLS, TWO MOMENTS.
 *
 *   stageRestore()          while the app runs. Verifies the package, checks the owner's consent
 *                           against what was previewed, copies the package into
 *                           <userData>/restore/staging-<id>, verifies that copy, and writes the
 *                           journal (state `staged`). It touches NOTHING the till uses.
 *   applyPendingRestore()   at the next start, after every SQLite connection is closed and BEFORE
 *                           the ledger is opened (and before ledgerGuard runs). Swaps the files.
 *
 * A live ledger is never replaced under an open connection: the app holds one `db` shared by every
 * repository and the phone server, so the only safe moment is before any of them exists. This
 * module is not wired to the app yet; that is a later phase.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 THE JOURNAL — <userData>/restore/journal.json, replaced atomically (temp + rename).
 *
 *   staged        Package copied and verified. Live state untouched. On apply the staged copy is
 *                 verified AGAIN (it sat on disk between two runs); if it fails, the restore is
 *                 ABORTED and nothing was touched.
 *   preserving    The live entries that exist (ledger, its -wal/-shm/-journal, branding/,
 *                 settings.json) are recorded in `inventory`, then each is MOVED into
 *                 restore/pre-restore-<id>/. Separate renames, not one atomic step — the inventory
 *                 is what makes a half-done move resumable and a lost entry detectable.
 *   installing    Every package file is moved from staging into place and checked against the
 *                 manifest's SHA-256. Then the result is checked again as a whole.
 *   rolling-back  Entered on the first real FAILURE (not on a crash). Anything installed is moved
 *                 into restore/quarantine-<id>/, then the preserved entries are moved back.
 *
 * A CRASH (power cut, killed process) leaves the journal in a forward state, and the next start
 * resumes FORWARD: every step is idempotent (a move whose source is gone and whose target holds
 * the expected bytes is already done). A FAILURE (conflict, lost entry, bad bytes, rename refused)
 * switches the direction to BACK, durably, before anything else is undone. If even the rollback
 * cannot finish, the outcome is `halted`: the journal stays, and the till must not start.
 *
 * The end state is therefore either the ORIGINAL state or the RESTORED state, never a mixture —
 * or, when neither can be reached, a refusal to run. That is proven by tests that crash the engine
 * at every file operation; it is NOT proven against a real power cut or Windows file locking.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 WHAT IS KEPT, AND WHAT IS NOT TOUCHED.
 *
 *   - The pre-restore copy (restore/pre-restore-<id>/) is kept after a successful restore. Never
 *     deleted automatically.
 *   - ledger.json (ledgerGuard's marker) is never moved or rewritten: "this profile owns a ledger"
 *     is as true after a restore as before. While the ledger is moved aside the marker makes a
 *     startup that SKIPS this engine refuse to create an empty ledger — the right failure.
 *   - No migration runs here. The restored ledger is opened read-only only through
 *     verifyBackupPackage; an older schema is migrated later by the normal startup path.
 *   - The whole branding/ folder is swapped, not merged: the restored ledger is paired with the
 *     package's logos only, and the current ones are kept in the pre-restore copy.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 AN INCOMPLETE PACKAGE (owner decision, 2026-10-28). Refused by default. Accepted only with a
 * consent that names the exact manifest (its SHA-256) AND repeats its exact `missingAssets` list —
 * so a consent given for one preview cannot be replayed against another package, or against the
 * same package after it changed. Checking that the person consenting IS the owner belongs to the
 * caller in main/application; this module only refuses a consent that does not match.
 */
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import {
  type BackupFs,
  type BackupManifest,
  BackupPackageError,
  type BackupPackageErrorCode,
  MANIFEST_FILE,
  type MissingAsset,
  SOURCE_BRANDING_DIR,
  SOURCE_FROZEN_DIR,
  SOURCE_SETTINGS_FILE,
  classifyEntryPath,
  nodeBackupFs,
  verifyBackupPackage,
} from "./backupPackage";
import { MIGRATIONS, type Migration } from "./migrations";

export const RESTORE_DIR = "restore";
export const JOURNAL_FILE = "journal.json";
export const LAST_RESTORE_FILE = "last-restore.json";
/**
 * The live ledger's name. 🔴 DUPLICATED from src/main/ledgerGuard.ts (`LEDGER_FILE_NAME`) because
 * persistence does not import from main; the test pins it to that file's text.
 */
export const LIVE_LEDGER_FILE = "alzabt-pos-ledger.sqlite";
/** SQLite's companion files. A stale -wal beside a restored ledger would be replayed into it. */
const LEDGER_COMPANIONS = ["-wal", "-shm", "-journal"].map((s) => `${LIVE_LEDGER_FILE}${s}`);
/** Everything a restore moves aside, in this order. ledger.json is deliberately absent. */
export const LIVE_ENTRIES: ReadonlyArray<string> = [LIVE_LEDGER_FILE, ...LEDGER_COMPANIONS, SOURCE_BRANDING_DIR, SOURCE_SETTINGS_FILE];

const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/;
/** The marker in a folder name that says "assembled, never published" (createFullBackup). */
const UNPUBLISHED_RE = /\.partial-/;

export type RestoreErrorCode =
  | "PACKAGE_UNPUBLISHED"
  | "PACKAGE_INVALID"
  | "PACKAGE_CHANGED"
  | "CONSENT_MISMATCH"
  | "INCOMPLETE_NOT_ACCEPTED"
  | "RESTORE_PENDING"
  | "STAGE_FAILED"
  | "JOURNAL_CORRUPT"
  | "STAGING_INVALID"
  | "CONFLICT"
  | "ENTRY_LOST"
  | "INSTALL_MISMATCH";

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
    /** When the package itself was refused: the verifier's own code. */
    readonly packageCode: BackupPackageErrorCode | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RestoreError";
  }
}

// ── Preview and consent ───────────────────────────────────────────────────────────────────────

export interface RestorePreview {
  readonly manifest: BackupManifest;
  readonly complete: boolean;
  readonly missingAssets: ReadonlyArray<MissingAsset>;
  /** What a consent must name. The manifest lists every file's hash, so this pins the package. */
  readonly manifestSha256: string;
}

/** What the owner agreed to, as the caller recorded it from a preview. */
export interface RestoreConsent {
  readonly manifestSha256: string;
  /** Must repeat the preview's `missingAssets` exactly. Empty for a complete package. */
  readonly acceptedMissingAssets: ReadonlyArray<MissingAsset>;
}

interface Options {
  readonly fs?: BackupFs;
  readonly migrations?: ReadonlyArray<Migration>;
}

function verifyAsRestore(dir: string, fs: BackupFs, migrations: ReadonlyArray<Migration>, code: RestoreErrorCode) {
  try {
    return verifyBackupPackage(dir, { fs, migrations });
  } catch (err) {
    if (err instanceof BackupPackageError) throw new RestoreError(code, err.message, err.code, err);
    throw err;
  }
}

/**
 * Verifies a package for display. Refuses an unpublished `.partial-` folder even when its content
 * verifies — verifyBackupPackage proves content, not publication.
 */
export function inspectRestorePackage(packageDir: string, opts: Options = {}): RestorePreview {
  const fs = opts.fs ?? nodeBackupFs;
  const migrations = opts.migrations ?? MIGRATIONS;
  if (UNPUBLISHED_RE.test(basename(packageDir))) {
    throw new RestoreError("PACKAGE_UNPUBLISHED", "This folder is an unfinished backup that was never published");
  }
  const manifestPath = join(packageDir, MANIFEST_FILE);
  const before = fs.stat(manifestPath) ? fs.sha256(manifestPath) : null;
  const verified = verifyAsRestore(packageDir, fs, migrations, "PACKAGE_INVALID");
  // The manifest that was verified is the manifest that is named: hashed on both sides of the check.
  if (before === null || fs.sha256(manifestPath) !== before) {
    throw new RestoreError("PACKAGE_CHANGED", "The backup changed while it was being checked");
  }
  return {
    manifest: verified.manifest,
    complete: verified.complete,
    missingAssets: verified.manifest.missingAssets,
    manifestSha256: before,
  };
}

const sameMissing = (a: ReadonlyArray<MissingAsset>, b: ReadonlyArray<MissingAsset>) =>
  a.length === b.length && a.every((m, i) => m.kind === b[i]!.kind && m.name === b[i]!.name && m.reason === b[i]!.reason);

function checkConsent(preview: RestorePreview, consent: RestoreConsent): void {
  if (consent.manifestSha256 !== preview.manifestSha256) {
    throw new RestoreError("CONSENT_MISMATCH", "The consent was given for a different backup");
  }
  if (preview.complete) {
    if (consent.acceptedMissingAssets.length > 0) throw new RestoreError("CONSENT_MISMATCH", "The backup is complete; nothing is missing to accept");
    return;
  }
  if (consent.acceptedMissingAssets.length === 0) {
    throw new RestoreError("INCOMPLETE_NOT_ACCEPTED", "The backup is missing files and that was not accepted");
  }
  if (!sameMissing(consent.acceptedMissingAssets, preview.missingAssets)) {
    throw new RestoreError("CONSENT_MISMATCH", "The accepted missing files are not the ones this backup is missing");
  }
}

// ── Journal ───────────────────────────────────────────────────────────────────────────────────

type ForwardState = "staged" | "preserving" | "installing";
type JournalState = ForwardState | "rolling-back";

interface Journal {
  readonly journalVersion: 1;
  readonly id: string;
  readonly state: JournalState;
  readonly createdAt: string;
  readonly manifestSha256: string;
  readonly complete: boolean;
  readonly missingAssets: ReadonlyArray<MissingAsset>;
  /** Live entries that existed when preserving began; null before that. */
  readonly inventory: ReadonlyArray<string> | null;
  /** Which forward state a rollback started from; null while moving forward. */
  readonly rollbackFrom: "preserving" | "installing" | null;
  readonly failure: string | null;
}

const restoreDir = (u: string) => join(u, RESTORE_DIR);
const stagingDir = (u: string, id: string) => join(u, RESTORE_DIR, `staging-${id}`);
const safetyDir = (u: string, id: string) => join(u, RESTORE_DIR, `pre-restore-${id}`);
const quarantineDir = (u: string, id: string) => join(u, RESTORE_DIR, `quarantine-${id}`);
const journalPath = (u: string) => join(u, RESTORE_DIR, JOURNAL_FILE);

function writeAtomic(fs: BackupFs, path: string, value: unknown): void {
  fs.writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.rename(`${path}.tmp`, path);
}

function readJournal(fs: BackupFs, userDataDir: string): Journal | null {
  const path = journalPath(userDataDir);
  const st = fs.stat(path);
  if (!st) return null;
  if (st.kind !== "file" || st.size > 1024 * 1024) throw new RestoreError("JOURNAL_CORRUPT", "The restore journal is not a file");
  let j: unknown;
  try {
    j = JSON.parse(fs.readFile(path).toString("utf8"));
  } catch {
    throw new RestoreError("JOURNAL_CORRUPT", "The restore journal is not valid JSON");
  }
  const o = j as Record<string, unknown>;
  const states: JournalState[] = ["staged", "preserving", "installing", "rolling-back"];
  const ok =
    typeof j === "object" &&
    j !== null &&
    o.journalVersion === 1 &&
    typeof o.id === "string" &&
    ID_RE.test(o.id) &&
    states.includes(o.state as JournalState) &&
    typeof o.manifestSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(o.manifestSha256) &&
    typeof o.complete === "boolean" &&
    Array.isArray(o.missingAssets) &&
    (o.inventory === null || (Array.isArray(o.inventory) && o.inventory.every((e) => LIVE_ENTRIES.includes(e as string)))) &&
    (o.rollbackFrom === null || o.rollbackFrom === "preserving" || o.rollbackFrom === "installing") &&
    // 🔴 Each state's fields must agree with it. A journal past `staged` with no inventory would let
    // a rollback move NOTHING back and still report the original state as restored; a rollback
    // with no starting point would not know whether to clear installed files first.
    (o.state === "staged" ? o.inventory === null && o.rollbackFrom === null : o.inventory !== null) &&
    (o.state === "rolling-back" ? o.rollbackFrom !== null : o.rollbackFrom === null);
  if (!ok) throw new RestoreError("JOURNAL_CORRUPT", "The restore journal is not in a known shape");
  return j as Journal;
}

const restoreId = (now: Date) =>
  `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(6).toString("hex")}`;

function ensureDir(fs: BackupFs, path: string): void {
  const st = fs.stat(path);
  if (!st) fs.mkdir(path);
  else if (st.kind !== "directory") throw new RestoreError("CONFLICT", `${basename(path)} exists and is not a folder`);
}

// ── Stage ─────────────────────────────────────────────────────────────────────────────────────

export interface StageOptions extends Options {
  readonly userDataDir: string;
  readonly packageDir: string;
  readonly consent: RestoreConsent;
  readonly now: Date;
}

/**
 * Prepares a restore for the next start. Writes only under <userData>/restore/; throws
 * RestoreError and leaves no staging behind on any refusal or failure.
 */
export function stageRestore(opts: StageOptions): { readonly id: string; readonly preview: RestorePreview } {
  const fs = opts.fs ?? nodeBackupFs;
  const migrations = opts.migrations ?? MIGRATIONS;
  if (readJournal(fs, opts.userDataDir)) throw new RestoreError("RESTORE_PENDING", "A restore is already waiting for the next start");

  const preview = inspectRestorePackage(opts.packageDir, { fs, migrations });
  checkConsent(preview, opts.consent);

  const id = restoreId(opts.now);
  const root = restoreDir(opts.userDataDir);
  const incoming = join(root, `incoming-${id}`);
  const staged = stagingDir(opts.userDataDir, id);
  try {
    ensureDir(fs, root);
    // No journal means no restore is pending, so any staging left by an interrupted stage is junk.
    for (const name of fs.list(root)) {
      if (name.startsWith("incoming-") || name.startsWith("staging-")) fs.removeTree(join(root, name));
    }
    fs.mkdir(incoming);
    // Copy ONLY what the manifest declares (OS litter in the package is left behind).
    fs.copyFile(join(opts.packageDir, MANIFEST_FILE), join(incoming, MANIFEST_FILE));
    for (const f of preview.manifest.files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) ensureDir(fs, join(incoming, ...parts.slice(0, i)));
      fs.copyFile(join(opts.packageDir, ...parts), join(incoming, ...parts));
    }
    const copy = verifyAsRestore(incoming, fs, migrations, "STAGE_FAILED");
    if (fs.sha256(join(incoming, MANIFEST_FILE)) !== preview.manifestSha256 || copy.complete !== preview.complete) {
      throw new RestoreError("PACKAGE_CHANGED", "The backup changed after it was previewed");
    }
    fs.rename(incoming, staged);
    const journal: Journal = {
      journalVersion: 1,
      id,
      state: "staged",
      createdAt: opts.now.toISOString(),
      manifestSha256: preview.manifestSha256,
      complete: preview.complete,
      missingAssets: preview.missingAssets,
      inventory: null,
      rollbackFrom: null,
      failure: null,
    };
    writeAtomic(fs, journalPath(opts.userDataDir), journal);
    return { id, preview };
  } catch (err) {
    for (const dir of [incoming, staged]) {
      try {
        fs.removeTree(dir);
      } catch {
        // A leftover staging folder without a journal is removed by the next stage.
      }
    }
    if (err instanceof RestoreError) throw err;
    throw new RestoreError("STAGE_FAILED", `Preparing the restore failed: ${err instanceof Error ? err.message : String(err)}`, null, err);
  }
}

// ── Apply ─────────────────────────────────────────────────────────────────────────────────────

export type ApplyOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "restored";
      readonly id: string;
      readonly preRestoreDir: string;
      readonly complete: boolean;
      readonly missingAssets: ReadonlyArray<MissingAsset>;
    }
  /** The staged copy no longer verified; nothing live was touched. */
  | { readonly kind: "aborted"; readonly id: string; readonly reason: string }
  /** A step failed; the original state is back in place. */
  | { readonly kind: "rolled-back"; readonly id: string; readonly reason: string }
  /** Neither whole state could be reached. The journal stays. THE TILL MUST NOT START. */
  | { readonly kind: "halted"; readonly id: string | null; readonly reason: string };

export interface ApplyOptions extends Options {
  readonly userDataDir: string;
  readonly now: Date;
}

/** Where a package file goes in <userData>. */
function liveTargetOf(userDataDir: string, path: string): string {
  const parsed = classifyEntryPath(path);
  if (!parsed) throw new RestoreError("STAGING_INVALID", `Refused path ${JSON.stringify(path)}`);
  switch (parsed.role) {
    case "ledger":
      return join(userDataDir, LIVE_LEDGER_FILE);
    case "settings":
      return join(userDataDir, SOURCE_SETTINGS_FILE);
    case "frozen-logo":
      return join(userDataDir, SOURCE_BRANDING_DIR, SOURCE_FROZEN_DIR, parsed.name);
    case "live-logo":
      return join(userDataDir, SOURCE_BRANDING_DIR, parsed.name);
  }
}

/**
 * Moves one live entry (file or folder) from `from` to `to`, idempotently. Already moved → done.
 * Both present → only the same file content counts as done; anything else is a conflict.
 * Neither present → the entry is LOST, which is never treated as done.
 */
function moveEntry(fs: BackupFs, from: string, to: string): void {
  const a = fs.stat(from);
  const b = fs.stat(to);
  if (a && !b) return fs.rename(from, to);
  if (!a && b) return;
  if (!a && !b) throw new RestoreError("ENTRY_LOST", `${basename(from)} is in neither place`);
  if (a!.kind === "file" && b!.kind === "file" && fs.sha256(from) === fs.sha256(to)) return fs.removeTree(from);
  throw new RestoreError("CONFLICT", `${basename(to)} already exists with different content`);
}

/** Moves one staged package file into place; its bytes must be the manifest's. */
function installFile(fs: BackupFs, from: string, to: string, sha256: string): void {
  const a = fs.stat(from);
  const b = fs.stat(to);
  if (b) {
    if (b.kind === "file" && fs.sha256(to) === sha256) {
      if (a) fs.removeTree(from);
      return;
    }
    throw new RestoreError("CONFLICT", `${basename(to)} already exists with different content`);
  }
  if (!a) throw new RestoreError("ENTRY_LOST", `${basename(from)} is missing from the staged backup`);
  fs.rename(from, to);
}

function readStagedManifest(fs: BackupFs, userDataDir: string, j: Journal): BackupManifest {
  const path = join(stagingDir(userDataDir, j.id), MANIFEST_FILE);
  if (!fs.stat(path) || fs.sha256(path) !== j.manifestSha256) {
    throw new RestoreError("STAGING_INVALID", "The staged backup's manifest is missing or changed");
  }
  return JSON.parse(fs.readFile(path).toString("utf8")) as BackupManifest;
}

/**
 * Records the outcome, then removes the journal — the moment the restore is DECIDED. Everything
 * after that is tidying: best-effort, because a failure there must not undo a finished restore.
 */
function finish(
  fs: BackupFs,
  userDataDir: string,
  j: Journal,
  outcome: string,
  now: Date,
  reason: string | null,
  alsoRemove: ReadonlyArray<string> = [],
): void {
  writeAtomic(fs, join(restoreDir(userDataDir), LAST_RESTORE_FILE), {
    id: j.id,
    outcome,
    at: now.toISOString(),
    manifestSha256: j.manifestSha256,
    complete: j.complete,
    missingAssets: j.missingAssets,
    preRestoreDir: outcome === "restored" ? `${RESTORE_DIR}/pre-restore-${j.id}` : null,
    reason,
  });
  fs.removeTree(journalPath(userDataDir));
  for (const dir of [stagingDir(userDataDir, j.id), ...alsoRemove]) {
    try {
      fs.removeTree(dir);
    } catch {
      // A leftover staging/quarantine folder without a journal is removed by the next stage.
    }
  }
}

function forward(fs: BackupFs, userDataDir: string, start: Journal, migrations: ReadonlyArray<Migration>, now: Date): ApplyOutcome {
  let j = start;
  const write = (next: Journal) => {
    writeAtomic(fs, journalPath(userDataDir), next);
    j = next;
  };

  if (j.state === "staged") {
    // Verified AGAIN: the staged copy sat on disk between two runs of the app.
    try {
      verifyAsRestore(stagingDir(userDataDir, j.id), fs, migrations, "STAGING_INVALID");
      readStagedManifest(fs, userDataDir, j);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      finish(fs, userDataDir, j, "aborted", now, reason);
      return { kind: "aborted", id: j.id, reason };
    }
    const inventory = LIVE_ENTRIES.filter((e) => fs.stat(join(userDataDir, e)) !== null);
    write({ ...j, state: "preserving", inventory });
  }

  if (j.state === "preserving") {
    const safety = safetyDir(userDataDir, j.id);
    ensureDir(fs, safety);
    for (const entry of j.inventory!) moveEntry(fs, join(userDataDir, entry), join(safety, entry));
    write({ ...j, state: "installing" });
  }

  // installing
  const manifest = readStagedManifest(fs, userDataDir, j);
  for (const companion of LEDGER_COMPANIONS) {
    if (fs.stat(join(userDataDir, companion))) {
      throw new RestoreError("CONFLICT", `${companion} appeared beside the ledger before it was restored`);
    }
  }
  if (manifest.files.some((f) => f.role === "frozen-logo" || f.role === "live-logo")) {
    ensureDir(fs, join(userDataDir, SOURCE_BRANDING_DIR));
  }
  if (manifest.files.some((f) => f.role === "frozen-logo")) {
    ensureDir(fs, join(userDataDir, SOURCE_BRANDING_DIR, SOURCE_FROZEN_DIR));
  }
  // The ledger goes LAST, so a profile that shows a restored ledger already has its branding.
  const ordered = [...manifest.files].sort((a, b) => Number(a.role === "ledger") - Number(b.role === "ledger"));
  const staging = stagingDir(userDataDir, j.id);
  for (const f of ordered) installFile(fs, join(staging, ...f.path.split("/")), liveTargetOf(userDataDir, f.path), f.sha256);
  // And the whole result, once more, from where it now lives.
  for (const f of manifest.files) {
    const target = liveTargetOf(userDataDir, f.path);
    if (fs.stat(target)?.kind !== "file" || fs.sha256(target) !== f.sha256) {
      throw new RestoreError("INSTALL_MISMATCH", `${f.path} does not hold the backed-up bytes after the restore`);
    }
  }
  finish(fs, userDataDir, j, "restored", now, null);
  return { kind: "restored", id: j.id, preRestoreDir: safetyDir(userDataDir, j.id), complete: j.complete, missingAssets: j.missingAssets };
}

function rollback(fs: BackupFs, userDataDir: string, j: Journal, now: Date): ApplyOutcome {
  const safety = safetyDir(userDataDir, j.id);
  if (j.rollbackFrom === "installing") {
    // Preservation had finished, so every live entry now present came from the backup.
    const quarantine = quarantineDir(userDataDir, j.id);
    ensureDir(fs, quarantine);
    for (const entry of LIVE_ENTRIES) {
      const live = join(userDataDir, entry);
      if (fs.stat(live)) moveEntry(fs, live, join(quarantine, entry));
    }
  }
  for (const entry of j.inventory ?? []) {
    const kept = join(safety, entry);
    const live = join(userDataDir, entry);
    // From `preserving`, an entry not yet moved is still in place: that is its original state.
    if (!fs.stat(kept) && fs.stat(live)) continue;
    moveEntry(fs, kept, live);
  }
  const reason = j.failure ?? "unknown failure";
  // Everything preserved is back, so the pre-restore folder is empty; the quarantine holds only
  // a copy of the backup that failed to install.
  finish(fs, userDataDir, j, "rolled-back", now, reason, [quarantineDir(userDataDir, j.id), safety]);
  return { kind: "rolled-back", id: j.id, reason };
}

/**
 * Runs, resumes or rolls back a pending restore. Call at startup with NO connection to the ledger
 * open and before anything opens it. Never throws for a restore problem: returns `halted` instead,
 * and a `halted` outcome means the till must not start.
 */
export function applyPendingRestore(opts: ApplyOptions): ApplyOutcome {
  const fs = opts.fs ?? nodeBackupFs;
  const migrations = opts.migrations ?? MIGRATIONS;
  let j: Journal | null;
  try {
    j = readJournal(fs, opts.userDataDir);
  } catch (err) {
    return { kind: "halted", id: null, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!j) return { kind: "none" };

  if (j.state !== "rolling-back") {
    try {
      return forward(fs, opts.userDataDir, j, migrations, opts.now);
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err);
      let current: Journal;
      try {
        // Re-read: `forward` advanced the journal on disk; the rollback starts from where it stood.
        const onDisk = readJournal(fs, opts.userDataDir);
        if (!onDisk) {
          // `finish` removes the journal only after recording the outcome, and nothing after that
          // throws — so this is unreachable by design; if it ever happens, do not guess.
          return { kind: "halted", id: j.id, reason: `${failure}; the journal vanished` };
        }
        current = onDisk;
        if (current.state === "staged") {
          // Nothing live was moved yet.
          finish(fs, opts.userDataDir, current, "aborted", opts.now, failure);
          return { kind: "aborted", id: current.id, reason: failure };
        }
        current = {
          ...current,
          state: "rolling-back",
          rollbackFrom: current.state === "installing" ? "installing" : "preserving",
          failure,
        };
        writeAtomic(fs, journalPath(opts.userDataDir), current);
      } catch (writeErr) {
        return { kind: "halted", id: j.id, reason: `${failure}; the rollback could not begin: ${String(writeErr)}` };
      }
      j = current;
    }
  }
  try {
    return rollback(fs, opts.userDataDir, j, opts.now);
  } catch (err) {
    return { kind: "halted", id: j.id, reason: `rollback incomplete: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/*
 * ═══════════════════════════════════════════════════════════
 * WHAT WIRING THIS INTO THE APP (a later phase) MUST DO — not done here:
 *
 *   1. Call applyPendingRestore() in main.ts BEFORE planLedgerOpen() and openDatabase(), and treat
 *      `halted` as a startup failure: no window on the ledger, the reason logged and shown.
 *   2. Gate stageRestore() behind an owner check in main/application, with the consent built from
 *      the preview the owner actually saw — never from renderer-supplied hashes alone.
 *   3. Show every missingAssets entry before consent. And invoiceLogo.ts must be reviewed BEFORE an
 *      incomplete restore is enabled: a legacy invoice whose live logo is missing resolves to
 *      `none` (no logo, NO warning), and if the owner later saves a new logo under the same name
 *      (`invoice-logo.<ext>`), that legacy invoice would reprint with the NEW logo — the silent
 *      substitution the owner ruled out. A frozen asset that is missing already resolves to
 *      `missing` with a warning and is not substituted.
 *   4. Prove on the installed Windows app that renames are refused while a file is open, that
 *      antivirus locks surface as `rolled-back`/`halted`, and that the restore survives a restart.
 */
