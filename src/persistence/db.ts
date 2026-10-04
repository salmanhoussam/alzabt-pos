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
export function openDatabase(filename: string, migrations: ReadonlyArray<Migration> = MIGRATIONS): Db {
  const db = new Database(filename);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.defaultSafeIntegers(true);
    migrate(db, migrations);
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

export function migrate(db: Db, migrations: ReadonlyArray<Migration> = MIGRATIONS): void {
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
    throw new Error(
      `Database schema version ${applied.length} is newer than this build (${migrations.length}); refusing to open`,
    );
  }
  applied.forEach((row, i) => {
    const known = migrations[i]!;
    if (Number(row.version) !== known.version || row.checksum !== checksum(known.sql)) {
      throw new Error(`Applied migration ${row.version} (${row.name}) does not match this build's migration`);
    }
  });

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const m of migrations.slice(applied.length)) {
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
