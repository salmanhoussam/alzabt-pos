import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PosService } from "../../src/application/posService";
import { type Catalog, type CatalogSource, loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { FIXTURE_TERMINAL, type TerminalConfig } from "../../src/fixtures/terminal";
import { type Db, openDatabase } from "../../src/persistence/db";
import { SaleRepository } from "../../src/persistence/saleRepository";

export interface TempDir {
  readonly dir: string;
  readonly dbPath: string;
  cleanup(): void;
}

export function tempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "alzabt-pos-test-"));
  return { dir, dbPath: join(dir, "ledger.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A mutable clock for tests. Default: 2026-10-04 12:00 in Beirut (09:00 UTC). */
export class TestClock {
  constructor(public instant: Date = new Date("2026-10-04T09:00:00.000Z")) {}
  now = (): Date => new Date(this.instant.getTime());
  set(iso: string): void {
    this.instant = new Date(iso);
  }
}

export interface Harness {
  readonly db: Db;
  readonly repository: SaleRepository;
  readonly service: PosService;
  readonly clock: TestClock;
}

export function makeHarness(
  dbPath: string,
  opts: {
    catalog?: Catalog;
    catalogSource?: CatalogSource;
    clock?: TestClock;
    repository?: (db: Db) => SaleRepository;
    terminal?: TerminalConfig;
    login?: boolean;
  } = {},
): Harness {
  const db = openDatabase(dbPath);
  const repository = opts.repository ? opts.repository(db) : new SaleRepository(db);
  const clock = opts.clock ?? new TestClock();
  const service = new PosService({
    repository,
    catalog: opts.catalog ?? loadCatalog(opts.catalogSource ?? FIXTURE_CATALOG),
    cashiers: FIXTURE_CASHIERS,
    terminal: opts.terminal ?? FIXTURE_TERMINAL,
    now: clock.now,
  });
  if (opts.login !== false) service.login("cashier-01", "1111");
  return { db, repository, service, clock };
}

let keyCounter = 0;
export function newKey(): string {
  keyCounter += 1;
  return `test-key-${process.pid}-${Date.now()}-${keyCounter}`;
}

export function countRows(db: Db): { sales: number; lines: number; voids: number } {
  const n = (table: string) => Number((db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);
  return { sales: n("sales"), lines: n("sale_lines"), voids: n("voids") };
}
