import { randomBytes, randomInt, scryptSync } from "node:crypto";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SCRYPT } from "../../src/application/cashierAuth";
import { OperatorService } from "../../src/application/operatorService";
import { PosService } from "../../src/application/posService";
import { emptyCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { CategoryRepository } from "../../src/persistence/categoryRepository";
import { openDatabase } from "../../src/persistence/db";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";

it("rechecks live operator state before the audited write commits", () => {
  const root = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-audit-race-test-"));
  const path = join(root, "fresh.sqlite");
  closeSync(openSync(path, "wx"));
  const db = openDatabase(path, undefined, { fileMustExist: true });
  try {
    const operators = new OperatorRepository(db);
    const pin = String(randomInt(100000, 1000000));
    const salt = randomBytes(8).toString("hex");
    operators.setPin("cashier-01", salt, scryptSync(pin, Buffer.from(salt, "hex"), 32, SCRYPT).toString("hex"), "2026-01-01T00:00:00.000Z", {mustResetPin: false});
    operators.claimTerminal("cashier-01", "2026-01-01T00:00:00.000Z");
    const audit = new AuditRepository(db, {appVersion:"test", schemaVersion:20});
    const baseTransaction = <T>(fn: () => T): T => db.transaction(fn).immediate();
    const auth = new OperatorService({operators, audit, terminal: FIXTURE_TERMINAL, transact:baseTransaction});
    let deactivateBeforeBody = false;
    const service = new PosService({
      repository: new SaleRepository(db), pinStates: new PinStateRepository(db),
      catalog: emptyCatalog(FIXTURE_TERMINAL.currency), cashiers: FIXTURE_CASHIERS,
      operators: auth, terminal: FIXTURE_TERMINAL, auditStore:audit,
      categories: new CategoryRepository(db),
      transact: (fn) => baseTransaction(() => {
        if (deactivateBeforeBody) operators.setActive("cashier-01", false, "2026-01-02T00:00:00.000Z");
        return fn();
      }),
    });
    service.login("cashier-01", pin);
    deactivateBeforeBody = true;
    expect(() => service.createCategory("Must Roll Back", null)).toThrow();
    expect((db.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(0n);
    expect((db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = ?").get("CATEGORY_CREATED") as {n:bigint}).n).toBe(0n);
  } finally {db.close();}
});
