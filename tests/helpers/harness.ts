import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditRow } from "../../src/domain/audit";
import { PosService } from "../../src/application/posService";
import { type Catalog, type CatalogSource, loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { FIXTURE_TERMINAL, type TerminalConfig } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { OperatorService } from "../../src/application/operatorService";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { InvoiceService } from "../../src/application/invoiceService";
import { CompanyProfileRepository } from "../../src/persistence/companyProfileRepository";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";

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
  /** Real operator accounts (migration 8). `cashier-01` is the owner every harness test runs as. */
  readonly operators: OperatorService;
  readonly db: Db;
  readonly repository: SaleRepository;
  readonly service: PosService;
  readonly clock: TestClock;
  /** The real durable audit trail, on the same connection — so tests read what was really stored. */
  readonly audit: AuditRepository;
  /**
   * The manual-invoice stack (migration 6), on the SAME connection and the SAME `transact`, wired
   * to the REAL `PosService` — so a test that asserts "an audit row was written" is asserting about
   * the real product service and not about a fake that agreed with it.
   */
  readonly invoices: InvoiceService;
  readonly invoiceStore: InvoiceRepository;
  readonly reconciliationStore: ReconciliationRepository;
  readonly companyStore: CompanyProfileRepository;
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
    /** Swap in a failing audit repository, or pass null to wire none at all (fail-closed tests). */
    auditStore?: AuditRepository | null;
    /** The diagnostic mirror, if a test wants to observe it. */
    auditSink?: (row: AuditRow) => void;
    /** A deterministic id source for the invoice stack. Default: a per-harness counter. */
    ids?: () => string;
  } = {},
): Harness {
  const db = openDatabase(dbPath);
  try {
    const repository = opts.repository ? opts.repository(db) : new SaleRepository(db);
    const clock = opts.clock ?? new TestClock();
    const audit = new AuditRepository(db, { appVersion: "test", schemaVersion: MIGRATIONS.length });

    /**
     * Migration 8 gave this database real `operators` rows, and both arrive with
     * `must_reset_pin = 1` — so a plain `login` would return a SETUP outcome and no session.
     *
     * 🔴 THE FLAG IS CLEARED THROUGH THE REPOSITORY, NOT BY RUNNING SETUP. Running the real
     * bootstrap flow would write OPERATOR_RENAMED/OPERATOR_PIN_RESET rows into `audit_events` for
     * every harness-based test, and several of them assert exact audit counts — the harness would
     * be editing the thing those tests measure. Re-storing each fixture's OWN salt and hash clears
     * the flag and changes no credential, so `cashier-01` / 1111 still works exactly as every test
     * already expects. The bootstrap flow itself is tested directly, in operatorAccounts.test.ts.
     *
     * The effect is that harness tests now run under the REAL authorization path as a real owner,
     * which is stricter than the fixture path they used before, not looser.
     */
    const operatorStore = new OperatorRepository(db);
    for (const fixture of FIXTURE_CASHIERS) {
      if (operatorStore.findById(fixture.id)) {
        operatorStore.setPin(fixture.id, fixture.pinSaltHex, fixture.pinHashHex, clock.now().toISOString());
      }
    }
    const operators = new OperatorService({
      operators: operatorStore,
      audit,
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: opts.terminal ?? FIXTURE_TERMINAL,
      now: clock.now,
    });
    const service = new PosService({
      repository,
      pinStates: new PinStateRepository(db),
      catalog: opts.catalog ?? loadCatalog(opts.catalogSource ?? FIXTURE_CATALOG),
      catalogStore: new CatalogRepository(db),
      auditStore: opts.auditStore === null ? undefined : (opts.auditStore ?? audit),
      transact: (fn) => db.transaction(fn).immediate(),
      cashiers: FIXTURE_CASHIERS,
      operators,
      terminal: opts.terminal ?? FIXTURE_TERMINAL,
      now: clock.now,
      audit: opts.auditSink,
    });
    const invoiceStore = new InvoiceRepository(db);
    const reconciliationStore = new ReconciliationRepository(db);
    const companyStore = new CompanyProfileRepository(db);
    let idSeq = 0;
    const invoices = new InvoiceService({
      invoices: invoiceStore,
      reconciliation: reconciliationStore,
      company: companyStore,
      catalogStore: new CatalogRepository(db),
      products: service,
      // The REAL ledger repository, like `products` above: a passing test then means a real row in
      // `sales`, not that a method was called on a fake.
      sales: repository,
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: opts.terminal ?? FIXTURE_TERMINAL,
      now: clock.now,
      newId: opts.ids ?? (() => `id-${(idSeq += 1).toString().padStart(4, "0")}`),
    });
    if (opts.login !== false) service.login("cashier-01", "1111");
    return { db, repository, service, clock, audit, invoices, invoiceStore, reconciliationStore, companyStore, operators };
  } catch (err) {
    db.close(); // never leave a handle open on a failed setup (Windows cannot delete open files)
    throw err;
  }
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
