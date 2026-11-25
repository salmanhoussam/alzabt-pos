import { createHash, randomBytes, randomInt, scryptSync } from "node:crypto";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRYPT } from "../../src/application/cashierAuth";
import { OperatorService } from "../../src/application/operatorService";
import { PosService } from "../../src/application/posService";
import { emptyCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { CategoryRepository } from "../../src/persistence/categoryRepository";
import { openDatabase } from "../../src/persistence/db";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { ProductImageRepository } from "../../src/persistence/productImageRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";

const parent = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-audit-golden-test-"));

describe("normal-mode deterministic audit golden", () => {
  it("covers each auditDraft site for an owner and allowed cashier", () => {
    const file = join(mkdtempSync(join(parent, "case-")), "synthetic.sqlite");
    closeSync(openSync(file, "wx"));
    const db = openDatabase(file, undefined, { fileMustExist: true });
    try {
      const repo = new OperatorRepository(db);
      const pins = [String(randomInt(100000, 1000000)), String(randomInt(100000, 1000000))];
      for (const [index, id] of ["cashier-01", "cashier-02"].entries()) {
        const salt = randomBytes(8).toString("hex");
        repo.setPin(id, salt, scryptSync(pins[index]!, Buffer.from(salt, "hex"), 32, SCRYPT).toString("hex"), "2026-01-01T00:00:00.000Z", { mustResetPin: false });
      }
      repo.claimTerminal("cashier-01", "2026-01-01T00:00:00.000Z");
      const audit = new AuditRepository(db, { appVersion: "test", schemaVersion: 20 });
      const transact = <T>(fn: () => T): T => db.transaction(fn).immediate();
      const operators = new OperatorService({ operators: repo, audit, terminal: FIXTURE_TERMINAL, transact });
      let seq = 0;
      const service = new PosService({
        repository: new SaleRepository(db), pinStates: new PinStateRepository(db),
        catalog: emptyCatalog(FIXTURE_TERMINAL.currency), cashiers: FIXTURE_CASHIERS,
        operators, terminal: FIXTURE_TERMINAL, auditStore: audit, transact,
        catalogStore: new CatalogRepository(db), categories: new CategoryRepository(db),
        productImages: new ProductImageRepository(db),
        now: () => new Date("2026-01-02T00:00:00.000Z"),
        newId: () => "synthetic-" + (++seq),
      });
      const csv = (key: string) => new TextEncoder().encode("source_id,name_ar,name_en,price,currency,base_unit,price_needs_review" + String.fromCharCode(10) + key + ",Synthetic,,1.00,USD,piece,0");
      const draft = { nameAr: "Synthetic item", nameEn: null, sku: null, price: "1.00", baseUnit: "piece" };
      service.login("cashier-01", pins[0]!);
      service.importCatalogCsv("synthetic.csv", csv("one"));
      const product = service.createProduct(draft);
      service.updateProduct(product.id, { ...draft, nameAr: "Updated" }, true);
      service.setProductActive(product.id, false);
      const cat = service.createCategory("Synthetic category", null);
      service.renameCategory(cat.id, "Renamed category", null);
      service.setCategoryActive(cat.id, false);
      service.deleteCategoryIfUnused(cat.id);
      service.setProductPrimaryImage({ productId: product.id, bytes: Buffer.from([1, 2, 3]), mime: "image/png", widthPx: 1, heightPx: 1, origin: "desktop" });
      service.removeProductPrimaryImage(product.id);
      service.logout();
      repo.setMayCreateProducts("cashier-02", true, "2026-01-02T00:00:00.000Z");
      service.login("cashier-02", pins[1]!);
      const cashierProduct = service.createProduct({ ...draft, nameAr: "Cashier item" });
      service.updateProduct(cashierProduct.id, { ...draft, nameAr: "Cashier updated" }, true);
      repo.setMayCreateProducts("cashier-02", false, "2026-01-02T00:00:00.000Z");
      expect(() => service.createProduct(draft)).toThrow();
      const rows = db.prepare("SELECT event_type, actor_id, actor_name, actor_tier, changed_json FROM audit_events ORDER BY seq").all();
      const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      expect(digest).toBe("82f73650d7b84ef911f13f2ee8daf090d0bad6e628da55b5fdb8ccd49870014b");
      expect(rows.length).toBe(13);
    } finally { db.close(); }
  });
});
