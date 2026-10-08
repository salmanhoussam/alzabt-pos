/**
 * Ledger backups: consistent snapshots of a LIVE WAL database, pre-migration safety, daily
 * de-duplication and retention.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupError, COUNTED_TABLES, DAILY_RETENTION, createPreMigrationBackup, ensureDailyBackup, snapshotDatabase } from "../../src/persistence/backup";
import { openDatabase, schemaVersion } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { insertLegacySale } from "../helpers/legacyLedger";
import { PosService } from "../../src/application/posService";
import { loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

function sell(h: ReturnType<typeof makeHarness>, n: number): void {
  for (let i = 0; i < n; i++) {
    h.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [{ productId: "prod-0003", quantityMilli: 1000 }],
      expectedTotalMinor: 199n,
    });
  }
}

function readCounts(path: string): { sales: number; lines: number; voids: number } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  try {
    return countRows(db);
  } finally {
    db.close();
  }
}

describe("snapshotDatabase (export backup)", () => {
  it("captures sales still sitting in the WAL — a consistent snapshot, not a raw file copy", () => {
    const h = makeHarness(t.dbPath);
    h.db.pragma("wal_autocheckpoint = 0"); // keep every commit in the -wal file
    sell(h, 5);
    expect(existsSync(`${t.dbPath}-wal`)).toBe(true);

    const dest = join(t.dir, "export.sqlite");
    const snap = snapshotDatabase(h.db, dest);
    expect(snap.counts.sales).toBe(5);
    expect(readCounts(dest)).toEqual({ sales: 5, lines: 5, voids: 0 });
    const copy = new Database(dest, { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    copy.close();
    h.db.close();
  });

  /**
   * 🔴 A v5 backup that does not verify `audit_events` is not a verified backup. `tableCounts()`
   * SKIPS a table it was not told about, silently, so leaving the audit trail out of
   * COUNTED_TABLES would have produced snapshots that looked verified while proving nothing about
   * the one table migration 5 added.
   */
  it("verifies the durable audit trail's row count too", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct({ nameAr: "صنف", nameEn: "Item", sku: "SYN-1", price: "4.00", baseUnit: "piece" });
    const row = h.service.listProducts()[0]!;
    h.service.setProductActive(row.id, false);
    expect(h.audit.count()).toBe(2);

    const dest = join(t.dir, "with-audit.sqlite");
    const snap = snapshotDatabase(h.db, dest);
    expect(snap.counts.audit_events).toBe(2);

    const copy = new Database(dest, { readonly: true });
    expect(Number((copy.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }).n)).toBe(2);
    // And it is still append-only inside the snapshot: the triggers travelled with the schema.
    expect(() => copy.prepare("DELETE FROM audit_events").run()).toThrow();
    copy.close();
    h.db.close();
  });

  it("replaces an existing file only with a verified snapshot and leaves no partial file", () => {
    const h = makeHarness(t.dbPath);
    sell(h, 1);
    const dest = join(t.dir, "export.sqlite");
    writeFileSync(dest, "old");
    snapshotDatabase(h.db, dest);
    expect(readCounts(dest).sales).toBe(1);
    expect(readdirSync(t.dir).some((f) => f.endsWith(".partial"))).toBe(false);
    h.db.close();
  });

  it("fails loudly (BackupError) and leaves nothing behind when the destination is not writable", () => {
    const h = makeHarness(t.dbPath);
    const dest = join(t.dir, "no-such-folder", "export.sqlite");
    expect(() => snapshotDatabase(h.db, dest)).toThrow(BackupError);
    expect(existsSync(dest)).toBe(false);
    h.db.close();
  });
});

/** A ledger exactly as 0.1.0 left it: schema v2 (no local catalog table), with `n` real sales. */
/**
 * A v2 ledger holding real sales, written in the OLD row shape with raw SQL.
 *
 * It used to drive PosService against the v2 schema, which worked only while today's columns and
 * the old ones coincided. Since migration 4 they do not — the repository writes quantity_milli and
 * sale_unit, which a v2 table has never heard of — and writing through today's code was never
 * really exercising an old ledger anyway. insertLegacySale writes what an old build wrote.
 */
function v2LedgerWithSales(path: string, n: number): void {
  const db = openDatabase(path, MIGRATIONS.slice(0, 2));
  for (let i = 0; i < n; i++) {
    insertLegacySale(db, {
      id: `legacy-${i + 1}`,
      receiptNumber: i + 1,
      lines: [{ productId: "prod-0001", sku: "SYN-ESP", productName: "Espresso", quantity: 1, unitPriceMinor: 250 }],
    });
  }
  db.close();
}

describe("pre-migration backup", () => {
  it("snapshots an older ledger at its OLD schema before migrating; data survives the migration", () => {
    v2LedgerWithSales(t.dbPath, 3);
    const backups = join(t.dir, "backups");
    const db = openDatabase(t.dbPath, MIGRATIONS, {
      fileMustExist: true,
      beforeMigrations: (d, pending) => {
        expect(pending).toEqual({ fromVersion: 2, toVersion: MIGRATIONS.length });
        createPreMigrationBackup(d, backups, pending, new Date("2026-10-05T10:00:00Z"));
      },
    });
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(countRows(db).sales).toBe(3);
    db.close();

    const files = readdirSync(backups);
    expect(files).toEqual([`pre-migration-v2-to-v${MIGRATIONS.length}-20261005T100000Z.sqlite`]);
    const copy = new Database(join(backups, files[0]!), { readonly: true });
    copy.defaultSafeIntegers(true);
    expect(schemaVersion(copy)).toBe(2); // the state BEFORE the migration
    expect(countRows(copy).sales).toBe(3);
    copy.close();
  });

  it("a failed backup blocks the migration: schema and data stay exactly as they were", () => {
    v2LedgerWithSales(t.dbPath, 2);
    expect(() =>
      openDatabase(t.dbPath, MIGRATIONS, {
        beforeMigrations: () => {
          throw new BackupError("disk full");
        },
      }),
    ).toThrow(BackupError);
    const db = openDatabase(t.dbPath, MIGRATIONS.slice(0, 2));
    expect(schemaVersion(db)).toBe(2);
    expect(countRows(db).sales).toBe(2);
    db.close();
  });

  it("no pre-migration backup for a brand-new ledger or one that is already current", () => {
    let calls = 0;
    const hook = () => {
      calls += 1;
    };
    openDatabase(t.dbPath, MIGRATIONS, { beforeMigrations: hook }).close(); // fresh
    openDatabase(t.dbPath, MIGRATIONS, { beforeMigrations: hook }).close(); // current
    expect(calls).toBe(0);
  });

  it("fileMustExist: a missing ledger is NOT silently re-created", () => {
    expect(() => openDatabase(join(t.dir, "missing.sqlite"), MIGRATIONS, { fileMustExist: true })).toThrow();
    expect(existsSync(join(t.dir, "missing.sqlite"))).toBe(false);
  });
});

describe("daily backup", () => {
  it("makes at most one snapshot per business day", () => {
    const h = makeHarness(t.dbPath);
    sell(h, 1);
    const dir = join(t.dir, "backups");
    const first = ensureDailyBackup(h.db, dir, "2026-10-05");
    expect(first.created?.counts.sales).toBe(1);
    sell(h, 1);
    const again = ensureDailyBackup(h.db, dir, "2026-10-05");
    expect(again.created).toBeNull(); // same day: deduplicated
    expect(readCounts(join(dir, "daily-2026-10-05.sqlite")).sales).toBe(1);
    expect(ensureDailyBackup(h.db, dir, "2026-10-06").created?.counts.sales).toBe(2);
    h.db.close();
  });

  it(`keeps the newest ${DAILY_RETENTION} daily snapshots and never prunes pre-migration ones`, () => {
    const h = makeHarness(t.dbPath);
    const dir = join(t.dir, "backups");
    createPreMigrationBackup(h.db, dir, { fromVersion: 1, toVersion: 2 }, new Date("2026-01-01T00:00:00Z"));
    for (let day = 1; day <= DAILY_RETENTION + 3; day++) {
      ensureDailyBackup(h.db, dir, `2026-03-${String(day).padStart(2, "0")}`);
    }
    const files = readdirSync(dir).sort();
    const dailies = files.filter((f) => f.startsWith("daily-"));
    expect(dailies).toHaveLength(DAILY_RETENTION);
    expect(dailies[0]).toBe("daily-2026-03-04.sqlite"); // 01..03 pruned
    expect(files.some((f) => f.startsWith("pre-migration-"))).toBe(true);
    h.db.close();
  });

  it("rejects a malformed business date instead of writing a stray file", () => {
    const h = makeHarness(t.dbPath);
    expect(() => ensureDailyBackup(h.db, join(t.dir, "backups"), "05/10/2026")).toThrow(BackupError);
    h.db.close();
  });
});

describe("the verified-backup contract covers EVERY durable table", () => {
  /**
   * 🔴 A DERIVED CHECK, not a list of names, and that distinction is the whole point.
   *
   * A backup is verified by comparing row counts between the live ledger and the snapshot, and
   * `COUNTED_TABLES` is what gets compared. A table absent from that list is SILENTLY SKIPPED: a
   * snapshot missing every row of it would still verify as a good backup.
   *
   * Migration 5 had to add `audit_events` to the list by hand. Migration 6 had to add four more,
   * and that omission survived the whole local suite and a Windows gate — because nothing asserted
   * the relationship. This test asserts it against the real schema instead, so the NEXT migration
   * cannot forget: adding a table without listing it here fails here, by name.
   */
  it("every table a fully migrated ledger has is counted", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      const present = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      const missing = present.filter((name) => !(COUNTED_TABLES as ReadonlyArray<string>).includes(name));
      expect(missing).toEqual([]);
      // And nothing is listed that does not exist, which would be a stale entry.
      const stale = (COUNTED_TABLES as ReadonlyArray<string>).filter((name) => !present.includes(name));
      expect(stale).toEqual([]);
      // The four migration-6 tables specifically, named so the intent is readable.
      for (const table of ["company_profile", "invoices", "invoice_lines", "invoice_reconciliation"]) {
        expect(COUNTED_TABLES as ReadonlyArray<string>).toContain(table);
      }
    } finally {
      db.close();
      t.cleanup();
    }
  });
});
