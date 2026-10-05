import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { type Migration, MIGRATIONS } from "./migrations";

export type Db = Database.Database;

/**
 * Opens (or creates) the ledger database and brings its schema up to date.
 *
 * Pragmas, chosen for a money ledger on one PC:
 *   journal_mode = WAL     readers never block the writer; a crash leaves the main file intact and
 *                          an un-committed transaction is simply absent after recovery.
 *   synchronous  = FULL    a COMMIT is fsync'ed before it returns. With WAL, NORMAL can lose the
 *                          last committed sales on power loss; a till must not.
 *   foreign_keys = ON      sale_lines/voids cannot point at a missing sale.
 *   defaultSafeIntegers    every INTEGER is read back as a bigint — money never passes through a
 *                          JavaScript number on its way out of the database.
 */
/** The database was written by a newer build (more migrations than this build knows). */
export class SchemaNewerThanAppError extends Error {
  constructor(readonly dbVersion: number, readonly appVersion: number) {
    super(`Database schema version ${dbVersion} is newer than this build (${appVersion}); refusing to open`);
    this.name = "SchemaNewerThanAppError";
  }
}

/** An applied migration differs from this build's copy (edited migration or foreign database). */
export class MigrationMismatchError extends Error {
  constructor(readonly version: number, readonly migrationName: string) {
    super(`Applied migration ${version} (${migrationName}) does not match this build's migration`);
    this.name = "MigrationMismatchError";
  }
}

export interface PendingMigrations {
  /** Schema version the database is at now (0 for a brand-new file). */
  readonly fromVersion: number;
  /** Schema version it will be at after this build's migrations. */
  readonly toVersion: number;
}

export interface OpenOptions {
  /**
   * Refuse to create the file when it does not exist (SQLITE_CANTOPEN instead). Used when a ledger
   * is known to exist: a missing or moved ledger must never be silently replaced by an empty one.
   */
  readonly fileMustExist?: boolean;
  /**
   * Called after the applied migrations were verified and before ANY pending migration runs, only
   * for a database that already holds a schema (fromVersion > 0). If it throws, nothing is migrated
   * and the error propagates — this is where the pre-migration backup lives.
   */
  readonly beforeMigrations?: (db: Db, pending: PendingMigrations) => void;
}

export function openDatabase(
  filename: string,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
  options: OpenOptions = {},
): Db {
  const db = new Database(filename, { fileMustExist: options.fileMustExist === true });
  try {
    // Connection-level settings first: none of these writes to the file.
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.defaultSafeIntegers(true);
    // Refuse a newer or foreign schema BEFORE anything is written to the file (switching to WAL
    // rewrites the header), so a refused ledger is left byte-for-byte as it was.
    verifyAppliedMigrations(db, migrations);
    db.pragma("journal_mode = WAL");
    migrate(db, migrations, options.beforeMigrations);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Line endings are normalised before hashing: a Windows checkout with CRLF must produce the same
 * checksum as the LF build that created the database, or an update would refuse to open a real
 * ledger. (LF-only databases are unaffected — their checksum is unchanged.)
 */
function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * Read-only check of an existing database's applied migrations against this build: refuses a schema
 * newer than the build or an applied migration whose SQL differs. Writes nothing.
 */
export function verifyAppliedMigrations(db: Db, migrations: ReadonlyArray<Migration> = MIGRATIONS): void {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!hasTable) return;
  const applied = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: bigint; name: string; checksum: string }>;
  if (applied.length > migrations.length) throw new SchemaNewerThanAppError(applied.length, migrations.length);
  applied.forEach((row, i) => {
    const known = migrations[i]!;
    if (Number(row.version) !== known.version || row.checksum !== checksum(known.sql)) {
      throw new MigrationMismatchError(Number(row.version), row.name);
    }
  });
}

export function migrate(
  db: Db,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
  beforeMigrations?: OpenOptions["beforeMigrations"],
): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 1..n; found ${m.version} at ${i}`);
  });

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  ) STRICT`);

  const applied = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: bigint; name: string; checksum: string }>;

  if (applied.length > migrations.length) {
    throw new SchemaNewerThanAppError(applied.length, migrations.length);
  }
  applied.forEach((row, i) => {
    const known = migrations[i]!;
    if (Number(row.version) !== known.version || row.checksum !== checksum(known.sql)) {
      throw new MigrationMismatchError(Number(row.version), row.name);
    }
  });

  const pending = migrations.slice(applied.length);
  if (pending.length > 0 && applied.length > 0 && beforeMigrations) {
    beforeMigrations(db, { fromVersion: applied.length, toVersion: migrations.length });
  }

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, checksum(m.sql), new Date().toISOString());
    }).immediate();
  }
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: bigint | null };
  return row.v === null ? 0 : Number(row.v);
}
