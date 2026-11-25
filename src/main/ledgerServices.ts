import type { SeedActor } from "../application/seedActor";
import { MAX_HISTORY, PosService } from "../application/posService";
import { makeInvoiceCreditPort } from "../application/invoiceCreditPort";
import { InvoiceService, type LogoVault } from "../application/invoiceService";
import { PartyService } from "../application/partyService";
import { LedgerService } from "../application/ledgerService";
import { AdvanceService, formatAdvanceNo } from "../application/advanceService";
import { SaleReceiptService } from "../application/saleReceiptService";
import { DailyMoneyService } from "../application/dailyMoneyService";
import { OperatorService } from "../application/operatorService";
import { FIXTURE_CASHIERS } from "../fixtures/cashiers";
import { FIXTURE_TERMINAL } from "../fixtures/terminal";
import type { Catalog } from "../domain/catalog";
import type { AuditRow } from "../domain/audit";
import type { Db } from "../persistence/db";
import { MIGRATIONS } from "../persistence/migrations";
import { CatalogRepository } from "../persistence/catalogRepository";
import { CategoryRepository } from "../persistence/categoryRepository";
import { ProductImageRepository } from "../persistence/productImageRepository";
import { SaleRepository } from "../persistence/saleRepository";
import { AuditRepository } from "../persistence/auditRepository";
import { PinStateRepository } from "../persistence/pinStateRepository";
import { OperatorRepository } from "../persistence/operatorRepository";
import { InvoiceRepository } from "../persistence/invoiceRepository";
import { ReconciliationRepository } from "../persistence/reconciliationRepository";
import { CompanyProfileRepository } from "../persistence/companyProfileRepository";
import { PartyRepository } from "../persistence/partyRepository";
import { LedgerRepository } from "../persistence/ledgerRepository";
import { ReceiptRepository } from "../persistence/receiptRepository";
import { AdvanceRepository } from "../persistence/advanceRepository";
import { SaleReceiptRepository } from "../persistence/saleReceiptRepository";
import { DailyMoneyRepository } from "../persistence/dailyMoneyRepository";

/** Ports do not select the ledger or grant authentication. The caller owns its lifetime. */
export interface LedgerServicePorts {
  readonly seedActor?: SeedActor;
  readonly catalog: Catalog;
  readonly fallbackCatalog: Catalog;
  readonly appVersion: string;
  readonly logoVault: LogoVault;
  readonly isCurrentLedger: () => boolean;
  readonly assertOpen: () => void;
  readonly audit: (row: AuditRow) => void;
}

/** Assemble the real application services over one caller-supplied, already-open ledger. */
export function createLedgerServices(db: Db, ports: LedgerServicePorts) {
  const catalogStore = new CatalogRepository(db);
  const categoryStore = new CategoryRepository(db);
  const productImageStore = new ProductImageRepository(db);
  // Named rather than inlined, because the invoice stack below must share THIS object: one
  // repository, one connection, one transaction (migration 7).
  const saleStore = new SaleRepository(db);
  // ONE audit repository, shared by PosService and the operator service. Two instances would be two
  // `nextSeq()` readers on the same table, which is safe only because they run inside the same
  // BEGIN IMMEDIATE — sharing it removes the need to rely on that at all.
  const auditStore = new AuditRepository(db, {
    appVersion: ports.appVersion,
    schemaVersion: MIGRATIONS.length,
  });
  const ledger = db;
  let creditSaleServices: { readonly parties: PartyService; readonly ledger: LedgerService } | null = null;
  const service = new PosService({
    seedActor: ports.seedActor,
    repository: saleStore,
    pinStates: new PinStateRepository(db),
    catalog: ports.catalog,
    fallbackCatalog: ports.fallbackCatalog,
    catalogStore,
    categories: categoryStore,
    productImages: productImageStore,
    // 🔴 THE FIXTURE IS NO LONGER THE AUTHORITY. Migration 8 created real `operators` rows — both
    // fixture accounts preserved BY ID so every historical sales.cashier_id still resolves — and
    // `operators` below is what `login` and `listCashiers` read. The array stays only because a
    // terminal whose database predates the table would otherwise have no accounts at all; the
    // service ignores it whenever `operators` is present.
    cashiers: FIXTURE_CASHIERS,
    operators: new OperatorService({
      operators: new OperatorRepository(db),
      audit: auditStore,
      transact: (fn) => {
        if (!ports.isCurrentLedger()) throw new Error("ledger is not open");
        ports.assertOpen();
        return ledger.transaction(fn).immediate();
      },
      terminal: FIXTURE_TERMINAL,
    }),
    terminal: FIXTURE_TERMINAL,
    // The durable audit trail (migration 5) and the transaction that binds it to the business
    // mutation. Both use THIS connection — there is no second database handle anywhere, because
    // atomicity across two connections would not be atomicity.
    auditStore,
    creditSaleServices: () => creditSaleServices,
    transact: (fn) => {
      if (!ports.isCurrentLedger()) throw new Error("ledger is not open");
      ports.assertOpen();
      return db.transaction(fn).immediate();
    },
    // The rotating logfile now MIRRORS committed audit rows, for field support. It is no longer the
    // record — audit_events is — and it rotates, so it must never be treated as one.
    audit: ports.audit,
  });
  // The manual-invoice stack (migrations 6 and 7), on THIS connection and THIS transaction provider, with
  // `service` as its only route to the catalog — so an invoice can never write a product except
  // through PosService and its migration-5 audit row.
  const invoices = new InvoiceService({
    seedActor: ports.seedActor,
    invoices: new InvoiceRepository(db),
    // Migration 16: explicit customer linking and issue-on-account, through the live party and
    // ledger services (constructed just below, hence lazy).
    credit: makeInvoiceCreditPort({ session: service, parties: () => parties, ledger: () => ledgerService }),
    reconciliation: new ReconciliationRepository(db),
    company: new CompanyProfileRepository(db),
    catalogStore,
    products: service,
    logoVault: ports.logoVault,
    // The SAME repository object the till uses, on the same connection: a finalized invoice's sale
    // goes through the one module that is allowed to write the ledger (migration 7).
    sales: saleStore,
    transact: (fn) => {
      if (!ports.isCurrentLedger()) throw new Error("ledger is not open");
      ports.assertOpen();
      return db.transaction(fn).immediate();
    },
    terminal: FIXTURE_TERMINAL,
  });

  // The customer/supplier directory (migration 12), on THIS connection and THIS transaction
  // provider. Its actor comes from `service`, which owns the session and re-reads the live role —
  // so the directory has no session of its own to drift out of step with the till's.
  const parties = new PartyService({
    parties: new PartyRepository(db),
    actor: () => {
      const cashier = service.currentCashier();
      if (!cashier) return null;
      const role = service.currentRole();
      return role === null ? null : { id: cashier.id, name: cashier.name, role };
    },
    transact: (fn) => {
      if (!ports.isCurrentLedger()) throw new Error("ledger is not open");
      ports.assertOpen();
      return db.transaction(fn).immediate();
    },
  });

  // The ledger (migration 13), on the SAME connection, the SAME transaction provider and the SAME
  // actor as the directory above — so "who is acting" cannot drift between the two, and a
  // statement is read inside the same database session that wrote the rows.
  const ledgerService = new LedgerService({
    ledger: new LedgerRepository(db),
    receipts: new ReceiptRepository(db),
    parties: new PartyRepository(db),
    actor: () => {
      const cashier = service.currentCashier();
      if (!cashier) return null;
      const role = service.currentRole();
      return role === null ? null : { id: cashier.id, name: cashier.name, role };
    },
    transact: (fn) => {
      if (!ports.isCurrentLedger()) throw new Error("ledger is not open");
      ports.assertOpen();
      return db.transaction(fn).immediate();
    },
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone },
    saleCurrency: (saleId) => {
      if (!ports.isCurrentLedger()) return null;
      const row = db.prepare("SELECT currency FROM sales WHERE id = ?").get(saleId) as
        | { currency: string }
        | undefined;
      return row?.currency ?? null;
    },
  });
  creditSaleServices = { parties, ledger: ledgerService };

  // Customer advances (migration 20): the SAME connection, the SAME transaction provider and the
  // SAME live actor as the ledger above. The service owns who may record (owner + cashier) and who
  // may correct (owner); the triggers enforce both again.
  const advanceService = new AdvanceService({
    advances: new AdvanceRepository(db),
    ledger: new LedgerRepository(db),
    parties: new PartyRepository(db),
    actor: () => {
      const cashier = service.currentCashier();
      if (!cashier) return null;
      const role = service.currentRole();
      return role === null ? null : { id: cashier.id, name: cashier.name, role };
    },
    transact: (fn) => {
      if (!ports.isCurrentLedger()) throw new Error("ledger is not open");
      ports.assertOpen();
      return db.transaction(fn).immediate();
    },
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone, currency: FIXTURE_TERMINAL.currency },
    // DEC-35x: the till's own owner-only credit sale, run inside the advance transaction.
    creditSale: (input) => service.createCustomerCreditSale(input),
  });

  // TILL-PRINT (D-TP2): the SAME live role as everything else; History's own window for non-owners.
  const saleReceiptService = new SaleReceiptService({
    reads: new SaleReceiptRepository(db),
    getSale: (id) => service.getSale(id),
    role: () => service.currentRole(),
    historyWindow: MAX_HISTORY,
    formatAdvanceNo,
  });

  // DAILY MONEY IN / OUT (DEC-35x): read-only, the SAME connection and the SAME live actor. No
  // transaction provider — it never writes.
  const dailyMoney = new DailyMoneyService({
    repository: new DailyMoneyRepository(db),
    actor: () => {
      const cashier = service.currentCashier();
      if (!cashier) return null;
      const role = service.currentRole();
      return role === null ? null : { id: cashier.id, role };
    },
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone, currency: FIXTURE_TERMINAL.currency },
  });

  return { service, invoices, parties, ledgerService, advanceService, saleReceiptService, dailyMoney };
}
