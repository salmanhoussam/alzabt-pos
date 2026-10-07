/**
 * Local ledger backups — consistent SQLite snapshots, never raw file copies.
 *
 * WHY NOT COPY THE FILE: the ledger runs in WAL mode. Committed sales can live in
 * `alzabt-pos-ledger.sqlite-wal` until a checkpoint moves them into the main file, so a plain copy of
 * the `.sqlite` file can miss them (or catch a half-written page). Every backup here is made with
 * SQLite's `VACUUM INTO`, which reads ONE consistent snapshot of the database — main file and WAL
 * together — inside a read transaction and writes it as a new, self-contained database file.
 *
 * Every snapshot is VERIFIED before it is kept: opened read-only, `PRAGMA integrity_check` must say
 * "ok", and its row counts must equal the source's. A snapshot that fails is deleted and the caller
 * gets a BackupError — a bad backup is never left looking like a good one.
 *
 * Kinds (all in <userData>/backups):
 *   pre-migration-v<from>-to-v<to>-<UTC stamp>.sqlite   before any schema change; never pruned
 *   daily-<business date>.sqlite                         at most one per business day; last 14 kept
 *   (export)                                             wherever the operator chose, e.g. a USB drive
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Db, PendingMigrations } from "./db";

export const BACKUP_DIR_NAME = "backups";
/** Daily snapshots kept. Two weeks covers "it was fine last week" on a single shop PC. */
export const DAILY_RETENTION = 14;

/**
 * Tables whose row counts a snapshot must reproduce exactly before it is accepted as a backup.
 *
 * 🔴 `audit_events` is here because a v5 backup that does not verify the audit trail is not a
 * verified backup — `tableCounts()` SKIPS a table it is not told about, silently, so leaving it out
 * would have produced snapshots that looked verified while proving nothing about the one table
 * migration 5 added. The skip is also what keeps this list safe for a pre-v5 database, where the
 * table does not exist yet.
 */
const COUNTED_TABLES = [
  "sales",
  "sale_lines",
  "voids",
  "catalog_products",
  "audit_events",
  "schema_migrations",
] as const;
const DAILY_RE = /^daily-(\d{4}-\d{2}-\d{2})\.sqlite$/;

export class BackupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackupError";
  }
}

export interface Snapshot {
  readonly path: string;
  readonly bytes: number;
  readonly counts: Readonly<Record<string, number>>;
}

function tableCounts(db: Database.Database): Record<string, number> {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    if (!present.has(table)) continue;
    const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint | number };
    counts[table] = Number(row.n);
  }
  return counts;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Writes a verified, consistent snapshot of `db` to `destPath` (replacing an existing file there only
 * after the new snapshot has been verified). Throws BackupError; never leaves a partial file behind.
 */
export function snapshotDatabase(db: Db, destPath: string): Snapshot {
  const partial = `${destPath}.partial`;
  try {
    rmSync(partial, { force: true });
    const sourceCounts = tableCounts(db);
    db.prepare("VACUUM INTO ?").run(partial);

    const copy = new Database(partial, { readonly: true, fileMustExist: true });
    try {
      const integrity = copy.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new BackupError(`Snapshot failed integrity_check: ${String(integrity)}`);
      const copyCounts = tableCounts(copy);
      for (const [table, n] of Object.entries(sourceCounts)) {
        if (copyCounts[table] !== n) {
          throw new BackupError(`Snapshot row count mismatch in ${table}: source ${n}, copy ${copyCounts[table]}`);
        }
      }
    } finally {
      copy.close();
    }

    renameSync(partial, destPath);
    return { path: destPath, bytes: statSync(destPath).size, counts: sourceCounts };
  } catch (err) {
    rmSync(partial, { force: true });
    if (err instanceof BackupError) throw err;
    throw new BackupError(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Snapshot taken right before a schema migration. Throws if it cannot be made and verified. */
export function createPreMigrationBackup(db: Db, dir: string, pending: PendingMigrations, now: Date): Snapshot {
  ensureDir(dir);
  const name = `pre-migration-v${pending.fromVersion}-to-v${pending.toVersion}-${stamp(now)}.sqlite`;
  return snapshotDatabase(db, join(dir, name));
}

export interface DailyBackupResult {
  readonly created: Snapshot | null;
  /** File names of daily snapshots removed by retention. */
  readonly pruned: ReadonlyArray<string>;
}

/**
 * At most one snapshot per business day: does nothing when today's file already exists. Prunes daily
 * snapshots beyond DAILY_RETENTION (oldest first). Pre-migration and exported backups are never pruned.
 */
export function ensureDailyBackup(
  db: Db,
  dir: string,
  businessDate: string,
  retention: number = DAILY_RETENTION,
): DailyBackupResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new BackupError(`Invalid business date '${businessDate}'`);
  ensureDir(dir);
  const target = join(dir, `daily-${businessDate}.sqlite`);
  const created = existsSync(target) ? null : snapshotDatabase(db, target);

  const dailies = readdirSync(dir)
    .filter((f) => DAILY_RE.test(f))
    .sort()
    .reverse();
  const pruned: string[] = [];
  for (const old of dailies.slice(retention)) {
    rmSync(join(dir, old), { force: true });
    pruned.push(old);
  }
  return { created, pruned };
}
