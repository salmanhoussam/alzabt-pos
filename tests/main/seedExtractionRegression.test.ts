import { randomBytes, randomInt, scryptSync } from "node:crypto";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRYPT } from "../../src/application/cashierAuth";
import { InvoiceService, type InvoiceServiceDeps } from "../../src/application/invoiceService";
import { OperatorService } from "../../src/application/operatorService";
import { PosService } from "../../src/application/posService";
import { emptyCatalog } from "../../src/domain/catalog";
import { DomainError } from "../../src/domain/errors";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { CategoryRepository } from "../../src/persistence/categoryRepository";
import { CompanyProfileRepository } from "../../src/persistence/companyProfileRepository";
import { openDatabase } from "../../src/persistence/db";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";

const parent = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-real-regression-test-"));
const secret = () => String(randomInt(100000, 1000000));
function expectCode(fn: () => unknown, code: string): void {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error("Expected a guarded refusal.");
}

describe("shared-body extraction preserves normal authenticated behavior", () => {
  it("keeps login, live owner guard, validation, audit and invoice profile behavior", () => {
    const path = join(mkdtempSync(join(parent, "case-")), "synthetic.sqlite");
    closeSync(openSync(path, "wx"));
    const db = openDatabase(path, undefined, { fileMustExist: true });
    try {
      const repo = new OperatorRepository(db);
      const ownerPin = secret();
      const cashierPin = secret();
      for (const [id, pin] of [["cashier-01", ownerPin], ["cashier-02", cashierPin]] as const) {
        const salt = randomBytes(8).toString("hex");
        repo.setPin(id, salt, scryptSync(pin, Buffer.from(salt, "hex"), 32, SCRYPT).toString("hex"), "2026-01-01T00:00:00.000Z", { mustResetPin: false });
      }
      repo.claimTerminal("cashier-01", "2026-01-01T00:00:00.000Z");
      const audit = new AuditRepository(db, { appVersion: "test", schemaVersion: 20 });
      const transact = <T>(fn: () => T): T => db.transaction(fn).immediate();
      const operators = new OperatorService({ operators: repo, audit, terminal: FIXTURE_TERMINAL, transact });
      const catalog = new CatalogRepository(db);
      const service = new PosService({
        repository: new SaleRepository(db), pinStates: new PinStateRepository(db),
        catalog: emptyCatalog(FIXTURE_TERMINAL.currency), cashiers: FIXTURE_CASHIERS,
        operators, terminal: FIXTURE_TERMINAL, auditStore: audit, transact,
        catalogStore: catalog, categories: new CategoryRepository(db),
      });
      const invoices = new InvoiceService({
        products: service, company: new CompanyProfileRepository(db), transact,
      } as unknown as InvoiceServiceDeps);
      const csv = new TextEncoder().encode("source_id,name_ar,name_en,price,currency,base_unit,price_needs_review" + String.fromCharCode(10) + "synthetic-key,Synthetic Item,,1.00,USD,piece,0");
      const draft = { nameAr: "Updated synthetic", nameEn: null, sku: null, price: "1.50", baseUnit: "piece" };
      expectCode(() => service.importCatalogCsv("synthetic.csv", csv), "NOT_LOGGED_IN");
      expectCode(() => service.updateProduct("unused", draft, true), "NOT_LOGGED_IN");
      expectCode(() => service.createCategory("Synthetic Category", null), "NOT_LOGGED_IN");
      expectCode(() => invoices.saveCompanyProfile({ nameAr: "Synthetic Shop" }), "NOT_LOGGED_IN");
      service.login("cashier-02", cashierPin);
      expectCode(() => service.createCategory("Synthetic Category", null), "NOT_AUTHORIZED");
      service.logout();
      const wrongPin = String((Number(ownerPin) + 1) % 1000000).padStart(6, "0");
      expectCode(() => service.login("cashier-01", wrongPin), "INVALID_CREDENTIALS");
      expect(service.currentCashier()).toBeNull();
      service.login("cashier-01", ownerPin);
      expect(service.createCategory("Synthetic Category", null).name_ar).toBe("Synthetic Category");
      expect(service.importCatalogCsv("synthetic.csv", csv).status).toBe("imported");
      expect(service.updateProduct("merchant-csv:synthetic-key", draft, true).name_ar).toBe("Updated synthetic");
      expect(invoices.saveCompanyProfile({ nameAr: "Synthetic Shop" }).name_ar).toBe("Synthetic Shop");
      const events = db.prepare("SELECT event_type, actor_tier FROM audit_events").all() as Array<{ event_type: string; actor_tier: string }>;
      for (const type of ["CATEGORY_CREATED", "CATALOG_IMPORTED", "PRODUCT_UPDATED"]) {
        expect(events.some((e) => e.event_type === type && e.actor_tier === "owner")).toBe(true);
      }
      repo.setActive("cashier-01", false, "2026-01-02T00:00:00.000Z");
      expectCode(() => service.importCatalogCsv("synthetic.csv", csv), "OPERATOR_INACTIVE");
      expectCode(() => service.createCategory("Another", null), "OPERATOR_INACTIVE");
    } finally { db.close(); }
  });
});
