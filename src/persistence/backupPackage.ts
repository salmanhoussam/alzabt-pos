/**
 * Full backup package — the ledger snapshot PLUS the files outside SQLite that the ledger needs.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 WHY A SECOND KIND OF BACKUP EXISTS. `snapshotDatabase()` (./backup.ts) makes a verified copy of
 * the ledger, and that copy is all `exportBackup` writes. It does NOT carry the invoice logos: a
 * finalized invoice records a CONTENT-ADDRESSED asset name in `issuer_snapshot_json.logo_asset`, and
 * the bytes live in `<userData>/branding/frozen/`. Restoring the database alone onto a machine whose
 * frozen folder is empty reprints those invoices with no logo (`invoiceLogo.ts`, kind `missing`).
 * The Tools screen says so (`tools.backupExcludes`). This module is the package that closes it.
 *
 * WHAT THE PACKAGE CARRIES — and why each piece, measured against the code, not assumed:
 *
 *   ledger.sqlite                  `snapshotDatabase()` — one consistent snapshot, WAL included.
 *                                  Product photos are BLOBs inside it; they need nothing separate.
 *   branding/frozen/<hash>.<ext>   every asset a finalized invoice in THAT snapshot names in
 *                                  `logo_asset`. The name is sha256(bytes) cut to 32 hex chars plus
 *                                  the lowercased extension (main.ts `freezeLogo`), so the content
 *                                  is checked against the name, not just the name's shape.
 *   branding/live/<name>           the shop's CURRENT logo: the company profile's `logo_path`,
 *                                  which the next finalized invoice will freeze.
 *                                  🔴 NOT the `logo_path` of an old invoice without a `logo_asset`.
 *                                  Until Track 2 phase 3 those were required too, because
 *                                  `resolveInvoiceLogo` printed today's live file for them. It no
 *                                  longer does (`unverified`: no logo, a warning) — so such a file
 *                                  is not needed to reproduce any document, and requiring it made a
 *                                  backup "incomplete" over a file nothing prints. The two modules
 *                                  now agree: required here = printed there.
 *   settings.json                  OPTIONAL — operator preferences (language). Never required.
 *   manifest.json                  written LAST; lists every file above with its size and SHA-256.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 WHAT "COMPLETE" MEANS. A logo the snapshot references but that is NOT on this machine (deleted,
 * corrupt, unsafe name) cannot be put in the package. Refusing the whole backup would leave the shop
 * with no copy of its money ledger, which is worse, so the package is still written — but the
 * absence is RECORDED in `missingAssets` with its reason, and the package reports `complete: false`.
 * Only a package with no missing asset is a full backup. The verifier recomputes the references
 * from the snapshot itself, so a package cannot hide a missing asset by leaving it out of the list.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 WHAT IS GUARANTEED, AND WHAT IS NOT.
 *
 *   ✓ A package is assembled in a sibling `<dest>.partial-<random>` folder, verified in full there,
 *     and only then renamed to `<dest>`. A failure at any step removes the partial folder and
 *     throws; nothing is published. An existing `<dest>` is never replaced.
 *   ✓ The manifest is written last, so a folder whose assembly stopped early has no manifest (or a
 *     temp one) and is refused by `verifyBackupPackage`.
 *   ✗ NOT guaranteed: that a package survives a power cut. Files are fsync'd where the platform
 *     allows it, but a directory rename is only as durable as the file system makes it, and exFAT
 *     (the usual USB format) journals nothing. After a power cut the folder may be absent, partial
 *     or present — and `verifyBackupPackage` is what decides which; never the folder's name.
 *   ✗ NOT guaranteed: atomicity across volumes. The rename is within ONE parent folder by
 *     construction; the package is never moved between drives here.
 *   ✗ NOT a tamper seal. SHA-256 in an unsigned manifest detects corruption, not someone who edits
 *     a file AND its manifest line. The ledger still has to pass integrity, foreign-key, schema and
 *     count checks, which is as far as an offline, unsigned package can go.
 *
 * 🔴 RESTORE IS NOT HERE. This module builds and verifies a package; it never writes into
 * `<userData>`. What a restore must still solve is listed at the end of this file.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import Database from "better-sqlite3";
import { snapshotDatabase } from "./backup";
import { type Db, SchemaNewerThanAppError, verifyAppliedMigrations } from "./db";
import { MIGRATIONS, type Migration } from "./migrations";

export const FULL_BACKUP_FORMAT = "alzabt-pos-full-backup";
export const FULL_BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
export const LEDGER_ENTRY = "ledger.sqlite";
export const SETTINGS_ENTRY = "settings.json";
export const FROZEN_ENTRY_DIR = "branding/frozen";
export const LIVE_ENTRY_DIR = "branding/live";

/**
 * Where these files live under `<userData>`. 🔴 DUPLICATED ON PURPOSE, for now: the same names are
 * private constants in main.ts (`BRANDING_DIR`, `FROZEN_DIR`) and settingsStore.ts (`SETTINGS_FILE`),
 * and persistence must not import from main. The derived test pins them to those files' text.
 */
export const SOURCE_BRANDING_DIR = "branding";
export const SOURCE_FROZEN_DIR = "frozen";
export const SOURCE_SETTINGS_FILE = "settings.json";

/** The extensions a logo may have — the same list main.ts accepts (`LOGO_EXTENSIONS`). */
export const LOGO_EXTENSIONS: ReadonlyArray<string> = [".png", ".jpg", ".jpeg", ".webp"];

/** Resource limits. A package outside them is refused before anything large is read. */
export const LIMITS = {
  manifestBytes: 8 * 1024 * 1024,
  /** A logo is refused above 4 MB when it is chosen; 16 MB leaves room without being unbounded. */
  assetBytes: 16 * 1024 * 1024,
  settingsBytes: 64 * 1024,
  entries: 10_000,
} as const;

/** The content-addressed asset name, exactly as main.ts `freezeLogo` builds it. */
const FROZEN_NAME_RE = /^[0-9a-f]{32}\.(png|jpg|jpeg|webp)$/;
/** A live branding file name: one plain segment, no path, no leading dot. */
const LIVE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Windows device names, which cannot be files there whatever the extension. */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/**
 * OS litter a USB folder can collect when it is browsed or copied (Windows Explorer, macOS). It is
 * IGNORED — never read, never copied into a restore — rather than refused, so that opening the
 * folder on another computer does not make a good backup unusable. Anything else not in the
 * manifest is refused.
 */
const IGNORED_LITTER_RE = /^(Thumbs\.db|desktop\.ini|\.DS_Store|\._.+)$/;

export type FileRole = "ledger" | "frozen-logo" | "live-logo" | "settings";

export interface ManifestFile {
  /** Package-relative, forward slashes. Never trusted on read: it is re-parsed against the roles. */
  readonly path: string;
  readonly role: FileRole;
  readonly size: number;
  readonly sha256: string;
}

export type MissingReason =
  | "absent-at-source"
  | "not-a-regular-file"
  | "unsafe-name"
  | "content-mismatch"
  | "too-large"
  /** The source's bytes kept changing while it was copied (e.g. the logo was being replaced). */
  | "changed-during-backup";

export interface MissingAsset {
  readonly kind: "frozen-logo" | "live-logo";
  /** The name exactly as the ledger records it. It is data, never used as a path. */
  readonly name: string;
  readonly reason: MissingReason;
}

/**
 * settings.json is OPTIONAL (a language preference): none of these states affects `complete`, and
 * none of them is a reason to refuse a backup of the money ledger.
 */
export type SettingsState = "included" | "absent" | "invalid-at-source" | "changed-during-backup";

export interface BackupManifest {
  readonly format: typeof FULL_BACKUP_FORMAT;
  readonly formatVersion: typeof FULL_BACKUP_FORMAT_VERSION;
  readonly createdAt: string;
  readonly appVersion: string;
  /** From the snapshot's own `schema_migrations`, not from the app that wrote it. */
  readonly schemaVersion: number;
  /** Row count of EVERY table in the snapshot (not only `COUNTED_TABLES`), read from the snapshot. */
  readonly tableCounts: Readonly<Record<string, number>>;
  /** The company profile's `logo_path` in the snapshot — the live logo a restore must put back. */
  readonly liveLogo: string | null;
  readonly settings: SettingsState;
  readonly files: ReadonlyArray<ManifestFile>;
  readonly missingAssets: ReadonlyArray<MissingAsset>;
}

export type BackupPackageErrorCode =
  | "DESTINATION_EXISTS"
  | "NOT_A_PACKAGE"
  | "MANIFEST_INVALID"
  | "UNSUPPORTED_FORMAT"
  | "UNSAFE_PATH"
  | "DUPLICATE_ENTRY"
  | "UNDECLARED_ENTRY"
  | "SYMLINK"
  | "MISSING_FILE"
  | "TOO_LARGE"
  | "CHECKSUM_MISMATCH"
  | "CONTENT_ADDRESS_MISMATCH"
  | "SETTINGS_INVALID"
  | "LEDGER_NOT_STANDALONE"
  | "LEDGER_CORRUPT"
  | "FOREIGN_KEY_VIOLATION"
  | "SCHEMA_NEWER"
  | "SCHEMA_MISMATCH"
  | "COUNT_MISMATCH"
  | "REFERENCE_MISMATCH"
  | "CREATE_FAILED";

/** Every refusal carries a code, so a later UI can word it without parsing English. */
export class BackupPackageError extends Error {
  constructor(
    readonly code: BackupPackageErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackupPackageError";
  }
}

// ── The file system, as a port ────────────────────────────────────────────────────────────────

export interface EntryStat {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly size: number;
}

/**
 * The operations this module performs on disk, injectable so a test can fail any one of them.
 * `stat` never follows a link (lstat): a symlink is reported as one, never as its target.
 */
export interface BackupFs {
  stat(path: string): EntryStat | null;
  list(dir: string): string[];
  mkdir(path: string): void;
  /** Copies a regular file and flushes the copy to disk where the platform allows it. */
  copyFile(from: string, to: string): void;
  /** Writes and flushes a small file. */
  writeFile(path: string, data: string): void;
  readFile(path: string): Buffer;
  /** SHA-256 of a file, read in chunks so a large ledger never sits in memory at once. */
  sha256(path: string): string;
  rename(from: string, to: string): void;
  removeTree(path: string): void;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const nodeBackupFs: BackupFs = {
  stat(path) {
    try {
      const s = lstatSync(path);
      const kind = s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "directory" : "other";
      return { kind, size: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  list: (dir) => readdirSync(dir),
  mkdir: (path) => mkdirSync(path),
  copyFile(from, to) {
    copyFileSync(from, to);
    fsyncPath(to);
  },
  writeFile(path, data) {
    writeFileSync(path, data, "utf8");
    fsyncPath(path);
  },
  readFile: (path) => readFileSync(path),
  sha256(path) {
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(path, "r");
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        hash.update(buf.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    return hash.digest("hex");
  },
  rename: (from, to) => renameSync(from, to),
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
};

// ── Names ─────────────────────────────────────────────────────────────────────────────────────

export function isFrozenAssetName(name: string): boolean {
  return FROZEN_NAME_RE.test(name);
}

export function isLiveLogoName(name: string): boolean {
  if (!LIVE_NAME_RE.test(name) || name.includes("..")) return false;
  if (!LOGO_EXTENSIONS.includes(extname(name).toLowerCase())) return false;
  return !WINDOWS_RESERVED_RE.test(name.split(".")[0]!);
}

/** The asset name `freezeLogo` gives these bytes: sha256 cut to 32 hex chars + the extension. */
export function frozenAssetNameFor(sha256Hex: string, ext: string): string {
  return `${sha256Hex.slice(0, 32)}${ext.toLowerCase()}`;
}

/**
 * Parses a package-relative path into its role, or null. This is the ONLY way a manifest path is
 * accepted: four exact shapes, forward slashes, no other characters — so `..`, a drive letter, a
 * leading slash or a backslash cannot match anything.
 */
export function classifyEntryPath(path: string): { role: FileRole; name: string } | null {
  if (path === LEDGER_ENTRY) return { role: "ledger", name: path };
  if (path === SETTINGS_ENTRY) return { role: "settings", name: path };
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null;
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (dir === FROZEN_ENTRY_DIR && isFrozenAssetName(name)) return { role: "frozen-logo", name };
  if (dir === LIVE_ENTRY_DIR && isLiveLogoName(name)) return { role: "live-logo", name };
  return null;
}

/** Package folder name for a backup made at `now`, e.g. alzabt-pos-fullbackup-20261027T091500Z. */
export function fullBackupFolderName(now: Date): string {
  return `alzabt-pos-fullbackup-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

// ── What a snapshot references ────────────────────────────────────────────────────────────────

interface References {
  /** `logo_asset` names on finalized invoices. */
  readonly frozen: ReadonlySet<string>;
  /** The shop's current logo (the company profile's logo_path), if it has one. */
  readonly live: ReadonlySet<string>;
  readonly liveLogo: string | null;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function readReferences(db: Database.Database): References {
  const tables = new Set(tableNames(db));
  const frozen = new Set<string>();
  const live = new Set<string>();
  let liveLogo: string | null = null;
  if (tables.has("company_profile")) {
    const row = db
      .prepare("SELECT logo_path FROM company_profile WHERE logo_path IS NOT NULL ORDER BY rowid LIMIT 1")
      .get() as { logo_path: string } | undefined;
    if (row) {
      liveLogo = row.logo_path;
      live.add(row.logo_path);
    }
  }
  if (tables.has("invoices")) {
    const rows = db
      .prepare("SELECT issuer_snapshot_json AS j FROM invoices WHERE issuer_snapshot_json IS NOT NULL")
      .all() as Array<{ j: string }>;
    for (const { j } of rows) {
      let issuer: unknown;
      try {
        issuer = JSON.parse(j);
      } catch {
        issuer = null;
      }
      // The column's CHECK requires a JSON object, but a CHECK is not re-proven by integrity_check.
      if (!isRecord(issuer)) throw new BackupPackageError("LEDGER_CORRUPT", "An invoice's issuer snapshot is not a JSON object");
      // Mirrors resolveInvoiceLogo: only a recorded asset is ever printed. An invoice without one
      // prints no logo (`unverified`), so its `logo_path` names nothing this backup must carry.
      if (typeof issuer.logo_asset === "string") frozen.add(issuer.logo_asset);
    }
  }
  return { frozen, live, liveLogo };
}

function countAllTables(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tableNames(db)) {
    const row = db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`).get() as { n: bigint | number };
    counts[table] = Number(row.n);
  }
  return counts;
}

function schemaVersionOf(db: Database.Database): number {
  if (!tableNames(db).includes("schema_migrations")) return 0;
  const row = db.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: bigint | number | null };
  return row.v === null ? 0 : Number(row.v);
}

/** Opens a ledger file strictly read-only. It must be a standalone (rollback-journal) file. */
function openLedgerReadOnly(fs: BackupFs, path: string): Database.Database {
  // Header bytes 18/19 are the read/write format versions: 1 = rollback journal, 2 = WAL. A WAL
  // file could need a -wal the package does not carry, and opening it may create a -shm beside it.
  // `VACUUM INTO` writes a standalone file, so anything else is not a package snapshot.
  const header = fs.readFile(path).subarray(0, 100);
  if (header.length < 100 || header.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") {
    throw new BackupPackageError("LEDGER_CORRUPT", "ledger.sqlite is not an SQLite database");
  }
  if (header[18] !== 1 || header[19] !== 1) {
    throw new BackupPackageError("LEDGER_NOT_STANDALONE", "ledger.sqlite is not a standalone snapshot (WAL header)");
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  return db;
}

// ── Verify ────────────────────────────────────────────────────────────────────────────────────

export interface VerifiedPackage {
  readonly manifest: BackupManifest;
  /** True only when no referenced asset is missing. */
  readonly complete: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(message: string): never {
  throw new BackupPackageError("MANIFEST_INVALID", message);
}

const ROLES: ReadonlyArray<FileRole> = ["ledger", "frozen-logo", "live-logo", "settings"];
const REASONS: ReadonlyArray<MissingReason> = [
  "absent-at-source",
  "not-a-regular-file",
  "unsafe-name",
  "content-mismatch",
  "too-large",
  "changed-during-backup",
];
const SETTINGS_STATES: ReadonlyArray<SettingsState> = ["included", "absent", "invalid-at-source", "changed-during-backup"];

/** Shape check only — every value is re-proven against the files and the ledger afterwards. */
function parseManifest(text: string): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid("manifest.json is not valid JSON");
  }
  if (!isRecord(raw)) return invalid("manifest.json is not an object");
  if (raw.format !== FULL_BACKUP_FORMAT) {
    throw new BackupPackageError("UNSUPPORTED_FORMAT", "Not an Alzabt POS full backup");
  }
  if (raw.formatVersion !== FULL_BACKUP_FORMAT_VERSION) {
    throw new BackupPackageError("UNSUPPORTED_FORMAT", `Unsupported backup format version ${String(raw.formatVersion)}`);
  }
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : invalid(`${k} must be a string`));
  const createdAt = str("createdAt");
  const appVersion = str("appVersion");
  const schemaVersion = raw.schemaVersion;
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) invalid("schemaVersion must be a positive integer");
  if (!isRecord(raw.tableCounts)) invalid("tableCounts must be an object");
  const tableCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.tableCounts)) {
    if (!Number.isSafeInteger(v) || (v as number) < 0) invalid(`tableCounts.${k} must be a non-negative integer`);
    tableCounts[k] = v as number;
  }
  if (raw.liveLogo !== null && typeof raw.liveLogo !== "string") invalid("liveLogo must be a string or null");
  if (!SETTINGS_STATES.includes(raw.settings as SettingsState)) invalid("settings has an unknown value");
  if (!Array.isArray(raw.files)) invalid("files must be an array");
  if (raw.files.length > LIMITS.entries) throw new BackupPackageError("TOO_LARGE", "Too many files in the manifest");
  const files: ManifestFile[] = raw.files.map((f: unknown) => {
    if (!isRecord(f)) return invalid("a files entry is not an object");
    if (typeof f.path !== "string") return invalid("files[].path must be a string");
    if (!ROLES.includes(f.role as FileRole)) return invalid("files[].role has an unknown value");
    if (!Number.isSafeInteger(f.size) || (f.size as number) < 0) return invalid("files[].size must be a non-negative integer");
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) return invalid("files[].sha256 must be 64 hex chars");
    return { path: f.path, role: f.role as FileRole, size: f.size as number, sha256: f.sha256 };
  });
  if (!Array.isArray(raw.missingAssets)) invalid("missingAssets must be an array");
  if (raw.missingAssets.length > LIMITS.entries) throw new BackupPackageError("TOO_LARGE", "Too many missing assets");
  const missingAssets: MissingAsset[] = raw.missingAssets.map((m: unknown) => {
    if (!isRecord(m)) return invalid("a missingAssets entry is not an object");
    if (m.kind !== "frozen-logo" && m.kind !== "live-logo") return invalid("missingAssets[].kind has an unknown value");
    if (typeof m.name !== "string") return invalid("missingAssets[].name must be a string");
    if (!REASONS.includes(m.reason as MissingReason)) return invalid("missingAssets[].reason has an unknown value");
    return { kind: m.kind, name: m.name, reason: m.reason as MissingReason };
  });
  return {
    format: FULL_BACKUP_FORMAT,
    formatVersion: FULL_BACKUP_FORMAT_VERSION,
    createdAt,
    appVersion,
    schemaVersion: schemaVersion as number,
    tableCounts,
    liveLogo: raw.liveLogo as string | null,
    settings: raw.settings as SettingsState,
    files,
    missingAssets,
  };
}

/** Walks the package and refuses anything that is not a declared file or an expected folder. */
function checkTree(fs: BackupFs, root: string, declared: ReadonlySet<string>): void {
  const expectedDirs = new Set(["", "branding", FROZEN_ENTRY_DIR, LIVE_ENTRY_DIR]);
  let seen = 0;
  const walk = (rel: string) => {
    for (const name of fs.list(rel === "" ? root : join(root, ...rel.split("/")))) {
      seen += 1;
      if (seen > LIMITS.entries) throw new BackupPackageError("TOO_LARGE", "Too many entries in the package");
      const child = rel === "" ? name : `${rel}/${name}`;
      const st = fs.stat(join(root, ...child.split("/")));
      if (!st) throw new BackupPackageError("MISSING_FILE", `${child} vanished while it was being read`);
      if (st.kind === "symlink") throw new BackupPackageError("SYMLINK", `${child} is a link`);
      if (st.kind === "file" && IGNORED_LITTER_RE.test(name)) continue;
      if (st.kind === "directory" && expectedDirs.has(child)) {
        walk(child);
        continue;
      }
      if (st.kind === "file" && (child === MANIFEST_FILE || declared.has(child))) continue;
      throw new BackupPackageError("UNDECLARED_ENTRY", `${child} is not part of this backup`);
    }
  };
  walk("");
}

/**
 * Verifies a package folder end to end without writing anything. Throws BackupPackageError on the
 * first refusal; returns the manifest and whether the package is complete.
 *
 * 🔴 THIS PROVES CONTENT, NOT PUBLICATION. A `<dest>.partial-<hex>` staging folder whose build
 * failed only at the final rename — and whose cleanup also failed (e.g. the USB drive was pulled) —
 * can hold a whole, valid package and PASS here. Only the folder name says it was never published.
 * A restore must therefore refuse a folder whose name carries `.partial-` (requirement 8 below).
 */
export function verifyBackupPackage(
  dir: string,
  opts: { fs?: BackupFs; migrations?: ReadonlyArray<Migration> } = {},
): VerifiedPackage {
  const fs = opts.fs ?? nodeBackupFs;
  const migrations = opts.migrations ?? MIGRATIONS;

  const rootStat = fs.stat(dir);
  if (!rootStat) throw new BackupPackageError("NOT_A_PACKAGE", "The backup folder does not exist");
  if (rootStat.kind === "symlink") throw new BackupPackageError("SYMLINK", "The backup folder is a link");
  if (rootStat.kind !== "directory") throw new BackupPackageError("NOT_A_PACKAGE", "The backup is not a folder");

  const manifestPath = join(dir, MANIFEST_FILE);
  const mStat = fs.stat(manifestPath);
  if (!mStat) throw new BackupPackageError("NOT_A_PACKAGE", "manifest.json is missing (the backup is incomplete)");
  if (mStat.kind === "symlink") throw new BackupPackageError("SYMLINK", "manifest.json is a link");
  if (mStat.kind !== "file") throw new BackupPackageError("NOT_A_PACKAGE", "manifest.json is not a file");
  if (mStat.size > LIMITS.manifestBytes) throw new BackupPackageError("TOO_LARGE", "manifest.json is too large");
  const manifest = parseManifest(fs.readFile(manifestPath).toString("utf8"));

  // 1 · Every declared path is one of the four shapes, once, case-insensitively (Windows and exFAT
  //     do not distinguish case, so A.png and a.png would be one file there).
  const declared = new Set<string>();
  const folded = new Set<string>();
  const byRole = new Map<FileRole, ManifestFile[]>(ROLES.map((r) => [r, []]));
  for (const f of manifest.files) {
    const parsed = classifyEntryPath(f.path);
    if (!parsed || parsed.role !== f.role) throw new BackupPackageError("UNSAFE_PATH", `Refused path in manifest: ${JSON.stringify(f.path)}`);
    const key = f.path.toLowerCase();
    if (folded.has(key)) throw new BackupPackageError("DUPLICATE_ENTRY", `Listed twice: ${f.path}`);
    folded.add(key);
    declared.add(f.path);
    byRole.get(f.role)!.push(f);
  }
  if (byRole.get("ledger")!.length !== 1) throw new BackupPackageError("MANIFEST_INVALID", "A backup must list exactly one ledger");
  if ((byRole.get("settings")!.length === 1) !== (manifest.settings === "included")) {
    throw new BackupPackageError("MANIFEST_INVALID", "settings state does not match the files listed");
  }

  // 2 · Nothing on disk that the manifest does not declare (OS litter aside), and no links.
  checkTree(fs, dir, declared);

  // 3 · Every declared file: present, regular, within limits, exact size, exact SHA-256.
  for (const f of manifest.files) {
    const path = join(dir, ...f.path.split("/"));
    const st = fs.stat(path);
    if (!st) throw new BackupPackageError("MISSING_FILE", `${f.path} is missing`);
    if (st.kind === "symlink") throw new BackupPackageError("SYMLINK", `${f.path} is a link`);
    if (st.kind !== "file") throw new BackupPackageError("MISSING_FILE", `${f.path} is not a file`);
    const cap = f.role === "settings" ? LIMITS.settingsBytes : f.role === "ledger" ? Number.MAX_SAFE_INTEGER : LIMITS.assetBytes;
    if (st.size > cap) throw new BackupPackageError("TOO_LARGE", `${f.path} is too large`);
    if (st.size !== f.size) throw new BackupPackageError("CHECKSUM_MISMATCH", `${f.path} has the wrong size`);
    const sha = fs.sha256(path);
    if (sha !== f.sha256) throw new BackupPackageError("CHECKSUM_MISMATCH", `${f.path} does not match its checksum`);
    if (f.role === "frozen-logo") {
      const name = basename(f.path);
      if (frozenAssetNameFor(sha, extname(name)) !== name) {
        throw new BackupPackageError("CONTENT_ADDRESS_MISMATCH", `${f.path} does not hold the content its name addresses`);
      }
    }
    if (f.role === "settings") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFile(path).toString("utf8"));
      } catch {
        throw new BackupPackageError("SETTINGS_INVALID", "settings.json is not valid JSON");
      }
      if (!isRecord(parsed)) throw new BackupPackageError("SETTINGS_INVALID", "settings.json is not an object");
    }
  }

  // 4 · The ledger, opened read-only: integrity, foreign keys, schema, every table's count.
  const ledger = byRole.get("ledger")![0]!;
  const db = openLedgerReadOnly(fs, join(dir, ledger.path));
  let refs: References;
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new BackupPackageError("LEDGER_CORRUPT", `integrity_check: ${String(integrity)}`);
    const fk = db.pragma("foreign_key_check") as unknown[];
    if (fk.length > 0) throw new BackupPackageError("FOREIGN_KEY_VIOLATION", `${fk.length} foreign-key violation(s)`);
    try {
      verifyAppliedMigrations(db, migrations);
    } catch (err) {
      const newer = err instanceof SchemaNewerThanAppError;
      throw new BackupPackageError(newer ? "SCHEMA_NEWER" : "SCHEMA_MISMATCH", err instanceof Error ? err.message : String(err), err);
    }
    const version = schemaVersionOf(db);
    if (version !== manifest.schemaVersion) {
      throw new BackupPackageError("SCHEMA_MISMATCH", `Ledger is at schema ${version}, manifest says ${manifest.schemaVersion}`);
    }
    const counts = countAllTables(db);
    const want = Object.keys(manifest.tableCounts).sort();
    const have = Object.keys(counts).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      throw new BackupPackageError("COUNT_MISMATCH", "The ledger's tables differ from the manifest's");
    }
    for (const t of have) {
      if (counts[t] !== manifest.tableCounts[t]) {
        throw new BackupPackageError("COUNT_MISMATCH", `${t}: ledger has ${counts[t]}, manifest says ${manifest.tableCounts[t]}`);
      }
    }
    refs = readReferences(db);
  } finally {
    db.close();
  }

  // 5 · References, recomputed from the ledger: each is in the package or declared missing — and
  //     nothing is declared missing that the ledger does not reference, or that is present anyway.
  if (refs.liveLogo !== manifest.liveLogo) throw new BackupPackageError("REFERENCE_MISMATCH", "liveLogo differs from the ledger");
  const included = {
    "frozen-logo": new Set(byRole.get("frozen-logo")!.map((f) => basename(f.path))),
    "live-logo": new Set(byRole.get("live-logo")!.map((f) => basename(f.path))),
  };
  const wanted = { "frozen-logo": refs.frozen, "live-logo": refs.live };
  const missing = {
    "frozen-logo": new Set(manifest.missingAssets.filter((m) => m.kind === "frozen-logo").map((m) => m.name)),
    "live-logo": new Set(manifest.missingAssets.filter((m) => m.kind === "live-logo").map((m) => m.name)),
  };
  for (const kind of ["frozen-logo", "live-logo"] as const) {
    for (const name of wanted[kind]) {
      const isIn = included[kind].has(name);
      const isMissing = missing[kind].has(name);
      if (isIn === isMissing) {
        throw new BackupPackageError("REFERENCE_MISMATCH", `${kind} ${JSON.stringify(name)} is ${isIn ? "both included and declared missing" : "neither included nor declared missing"}`);
      }
    }
    for (const name of [...included[kind], ...missing[kind]]) {
      if (!wanted[kind].has(name)) throw new BackupPackageError("REFERENCE_MISMATCH", `${kind} ${JSON.stringify(name)} is not referenced by the ledger`);
    }
  }
  if (manifest.missingAssets.length !== missing["frozen-logo"].size + missing["live-logo"].size) {
    throw new BackupPackageError("DUPLICATE_ENTRY", "A missing asset is listed twice");
  }

  return { manifest, complete: manifest.missingAssets.length === 0 };
}

// ── Create ────────────────────────────────────────────────────────────────────────────────────

export interface CreateFullBackupOptions {
  /** The app's userData folder: where branding/ and settings.json live. Only read. */
  readonly userDataDir: string;
  /** The package folder to create. Must not exist; its parent must. */
  readonly destDir: string;
  readonly appVersion: string;
  readonly now: Date;
  readonly fs?: BackupFs;
  readonly migrations?: ReadonlyArray<Migration>;
}

export interface CreatedPackage extends VerifiedPackage {
  readonly path: string;
}

/** Copies one referenced logo into the package, or says why it cannot. */
function takeAsset(
  fs: BackupFs,
  kind: MissingAsset["kind"],
  name: string,
  source: string,
  target: string,
): MissingReason | null {
  const nameOk = kind === "frozen-logo" ? isFrozenAssetName(name) : isLiveLogoName(name);
  if (!nameOk) return "unsafe-name";
  const st = fs.stat(source);
  if (!st) return "absent-at-source";
  if (st.kind !== "file") return "not-a-regular-file";
  if (st.size > LIMITS.assetBytes) return "too-large";
  const copied = copyStable(fs, source, target);
  if (copied === null) return "changed-during-backup";
  // The COPY is what is checked: it is what the package will carry.
  if (kind === "frozen-logo" && frozenAssetNameFor(copied, extname(name)) !== name) {
    fs.removeTree(target);
    return "content-mismatch";
  }
  return null;
}

/** How many times a file that changes while it is copied is tried again before giving up. */
const STABLE_COPY_ATTEMPTS = 3;

/**
 * Copies `source` and returns the copy's SHA-256 — but only if the source held the SAME bytes
 * before and after the copy, and the copy holds them too. Otherwise null (the target is removed).
 *
 * 🔴 WHY. The live logo is replaced IN PLACE (main.ts `pickInvoiceLogo` copies straight over
 * `invoice-logo.<ext>`, no temp file), so a backup taken while the owner picks a new logo could
 * copy a half-written image and still record it as a whole, checksummed file. Hashing only the
 * copy cannot see that: the manifest would faithfully describe a torn file. Hashing the source on
 * both sides of the copy can. It does NOT prove the bytes are the ones the snapshot saw — the ledger
 * stores the live logo by NAME, with no hash, so a logo replaced whole between the snapshot and the
 * copy is indistinguishable from the original. That limit is stated, not hidden.
 */
function copyStable(fs: BackupFs, source: string, target: string): string | null {
  for (let attempt = 0; attempt < STABLE_COPY_ATTEMPTS; attempt++) {
    const before = fs.sha256(source);
    fs.copyFile(source, target);
    const copy = fs.sha256(target);
    const after = fs.sha256(source);
    if (before === copy && copy === after) return copy;
  }
  fs.removeTree(target);
  return null;
}

/**
 * Builds, verifies and publishes a full backup package of the live ledger `db`.
 *
 * Order: snapshot → read references FROM THE SNAPSHOT → copy files → manifest (last) → verify the
 * whole folder → rename into place. Any failure removes the partial folder and throws
 * BackupPackageError; an existing destination is never replaced.
 */
export function createFullBackup(db: Db, opts: CreateFullBackupOptions): CreatedPackage {
  const fs = opts.fs ?? nodeBackupFs;
  const migrations = opts.migrations ?? MIGRATIONS;
  if (fs.stat(opts.destDir)) throw new BackupPackageError("DESTINATION_EXISTS", "A backup already exists at that location");

  const staging = join(dirname(opts.destDir), `${basename(opts.destDir)}.partial-${randomBytes(6).toString("hex")}`);
  try {
    fs.mkdir(staging);
    const ledgerPath = join(staging, LEDGER_ENTRY);
    snapshotDatabase(db, ledgerPath);

    // Everything below is read from the SNAPSHOT, never the live ledger, which may move on.
    const snap = openLedgerReadOnly(fs, ledgerPath);
    let refs: References;
    let schemaVersion: number;
    let tableCounts: Record<string, number>;
    try {
      refs = readReferences(snap);
      schemaVersion = schemaVersionOf(snap);
      tableCounts = countAllTables(snap);
    } finally {
      snap.close();
    }

    const files: ManifestFile[] = [];
    const missingAssets: MissingAsset[] = [];
    const add = (path: string, role: FileRole) => {
      const abs = join(staging, ...path.split("/"));
      files.push({ path, role, size: fs.stat(abs)!.size, sha256: fs.sha256(abs) });
    };
    add(LEDGER_ENTRY, "ledger");

    const brandingSrc = join(opts.userDataDir, SOURCE_BRANDING_DIR);
    if (refs.frozen.size > 0 || refs.live.size > 0) fs.mkdir(join(staging, "branding"));
    const sets: Array<[MissingAsset["kind"], ReadonlySet<string>, string, string]> = [
      ["frozen-logo", refs.frozen, join(brandingSrc, SOURCE_FROZEN_DIR), FROZEN_ENTRY_DIR],
      ["live-logo", refs.live, brandingSrc, LIVE_ENTRY_DIR],
    ];
    for (const [kind, names, srcDir, entryDir] of sets) {
      if (names.size === 0) continue;
      fs.mkdir(join(staging, ...entryDir.split("/")));
      for (const name of [...names].sort()) {
        // takeAsset checks the name BEFORE it is joined to any path.
        const reason = takeAsset(fs, kind, name, join(srcDir, name), join(staging, ...entryDir.split("/"), name));
        if (reason) missingAssets.push({ kind, name, reason });
        else add(`${entryDir}/${name}`, kind);
      }
    }

    let settings: SettingsState = "absent";
    const settingsSrc = join(opts.userDataDir, SOURCE_SETTINGS_FILE);
    const sStat = fs.stat(settingsSrc);
    if (sStat) {
      const target = join(staging, SETTINGS_ENTRY);
      if (sStat.kind !== "file" || sStat.size > LIMITS.settingsBytes) {
        settings = "invalid-at-source";
      } else if (copyStable(fs, settingsSrc, target) === null) {
        settings = "changed-during-backup";
      } else {
        // The COPY is validated, not the source: it is what the package carries.
        let ok: boolean;
        try {
          ok = isRecord(JSON.parse(fs.readFile(target).toString("utf8")));
        } catch {
          ok = false;
        }
        if (ok) {
          add(SETTINGS_ENTRY, "settings");
          settings = "included";
        } else {
          fs.removeTree(target);
          settings = "invalid-at-source";
        }
      }
    }

    const manifest: BackupManifest = {
      format: FULL_BACKUP_FORMAT,
      formatVersion: FULL_BACKUP_FORMAT_VERSION,
      createdAt: opts.now.toISOString(),
      appVersion: opts.appVersion,
      schemaVersion,
      tableCounts,
      liveLogo: refs.liveLogo,
      settings,
      files,
      missingAssets,
    };
    // Temp-then-rename INSIDE the staging folder: a manifest.json that exists is a whole one.
    const manifestTmp = join(staging, `${MANIFEST_FILE}.tmp`);
    fs.writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rename(manifestTmp, join(staging, MANIFEST_FILE));

    const verified = verifyBackupPackage(staging, { fs, migrations });

    if (fs.stat(opts.destDir)) throw new BackupPackageError("DESTINATION_EXISTS", "A backup appeared at that location meanwhile");
    fs.rename(staging, opts.destDir);
    return { ...verified, path: opts.destDir };
  } catch (err) {
    try {
      fs.removeTree(staging);
    } catch {
      // The original failure is what the caller needs; a leftover `.partial-*` folder has no
      // manifest-verified status and is refused by verifyBackupPackage if anyone opens it.
    }
    if (err instanceof BackupPackageError) throw err;
    throw new BackupPackageError("CREATE_FAILED", `Full backup failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

/*
 * ═══════════════════════════════════════════════════════════
 * WHAT A RESTORE (phase 2) MUST STILL SOLVE — recorded here, deliberately not implemented:
 *
 *   1. Every SQLite connection to the live ledger is closed before it is replaced (the app holds
 *      one `db` shared by every repository and the phone server) — so the swap happens at startup,
 *      before `openDatabase`, not under a running till.
 *   2. The live ledger's `-wal` and `-shm` are moved aside WITH it. A stale `-wal` left beside a
 *      restored file would be replayed into it. Three renames are not one atomic step; a journal
 *      must record which have happened.
 *   3. `ledger.json` (ledgerGuard) must stay consistent: a missing ledger with a marker refuses to
 *      start, which is right for an accident and wrong mid-restore.
 *   4. The current state — ledger, -wal/-shm, branding/ and settings.json — is preserved before
 *      anything is replaced.
 *   5. Frozen assets are additive (content-addressed: the same name is the same bytes), so copying
 *      them in is safe to repeat. The live logo (`manifest.liveLogo`) and settings.json are NOT:
 *      they replace the current ones and must match the restored ledger's company_profile.
 *   6. A recovery journal makes every step safe to repeat after an interruption, ending in either
 *      the old state or the new one — never a mixture of ledger and branding.
 *   7. `verifyBackupPackage` passes BEFORE anything is touched, and no migration runs on a ledger
 *      that has not passed it; an older schema is then migrated by the normal startup path, which
 *      already takes its own pre-migration backup.
 *   8. A folder whose name contains `.partial-` is refused even when it verifies: it is a staging
 *      folder that was never published (see verifyBackupPackage).
 *   9. An INCOMPLETE package (`complete: false`) is not refused outright — refusing it would make
 *      the money ledger unrecoverable because a decorative file was lost. It is restorable only
 *      after the owner is shown every `missingAssets` entry and confirms explicitly; the affected
 *      invoices then reprint with no logo and a warning (invoiceLogo.ts kind `missing`), never with
 *      a substitute. A complete package needs no such step. This is the proposed contract; the
 *      owner decides it when the restore phase is authorized.
 *  10. The live logo in a package carries the bytes present when it was COPIED. The ledger stores it
 *      by name only, so a logo replaced whole between the snapshot and the copy cannot be detected;
 *      a logo changing DURING the copy is (`changed-during-backup`).
 */
