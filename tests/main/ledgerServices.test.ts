import { randomBytes, randomInt, scryptSync } from "node:crypto";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRYPT } from "../../src/application/cashierAuth";
import { emptyCatalog } from "../../src/domain/catalog";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { createLedgerServices } from "../../src/main/ledgerServices";
import { openDatabase } from "../../src/persistence/db";
import { OperatorRepository } from "../../src/persistence/operatorRepository";

describe("shared ledger service assembly", () => {
  it("keeps the service graph on one supplied synthetic ledger and honours the lifetime guard", () => {
    const root = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-assembly-test-"));
    const makeDb = (name: string) => {
      const path = join(root, name);
      closeSync(openSync(path, "wx"));
      return openDatabase(path, undefined, { fileMustExist: true });
    };
    const a = makeDb("a.sqlite");
    const b = makeDb("b.sqlite");
    try {
      const repo = new OperatorRepository(a);
      const pin = String(randomInt(100000, 1000000));
      const salt = randomBytes(8).toString("hex");
      repo.setPin("cashier-01", salt, scryptSync(pin, Buffer.from(salt, "hex"), 32, SCRYPT).toString("hex"), "2026-01-01T00:00:00.000Z", { mustResetPin: false });
      repo.claimTerminal("cashier-01", "2026-01-01T00:00:00.000Z");
      let current = true;
      const catalog = emptyCatalog(FIXTURE_TERMINAL.currency);
      const services = createLedgerServices(a, {
        catalog, fallbackCatalog: catalog, appVersion: "synthetic-test",
        logoVault: { freeze: () => null },
        isCurrentLedger: () => current, assertOpen: () => {},
        audit: () => {},
      });
      expect(services.service.currentCashier()).toBeNull();
      services.service.login("cashier-01", pin);
      services.service.createCategory("Assembly Synthetic", null);
      expect((a.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(1n);
      expect((b.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(0n);
      expect((a.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = ?").get("CATEGORY_CREATED") as {n:bigint}).n).toBe(1n);
      expect((b.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = ?").get("CATEGORY_CREATED") as {n:bigint}).n).toBe(0n);
      const operatorActor = services.service.requireOperatorSession();
      const operatorName = repo.findById("cashier-02")!.name;
      const auditBefore = (a.prepare("SELECT count(*) AS n FROM audit_events").get() as {n:bigint}).n;
      current = false;
      expect(() => services.service.operatorAccounts()!.rename(operatorActor, "cashier-02", "Must Not Rename")).toThrow("ledger is not open");
      expect(repo.findById("cashier-02")!.name).toBe(operatorName);
      expect((a.prepare("SELECT count(*) AS n FROM audit_events").get() as {n:bigint}).n).toBe(auditBefore);
      expect(() => services.service.createCategory("Must Not Persist", null)).toThrow("ledger is not open");
      expect((a.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(1n);
      current = true;
      a.exec("CREATE TRIGGER synthetic_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
      expect(() => services.service.createCategory("Audit Failure", null)).toThrow();
      expect((a.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(1n);
      expect((a.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = ?").get("CATEGORY_CREATED") as {n:bigint}).n).toBe(1n);
      a.exec("DROP TRIGGER synthetic_audit_fail");
      repo.setRole("cashier-02", "owner", "2026-01-02T00:00:00.000Z");
      repo.setRole("cashier-01", "cashier", "2026-01-02T00:00:01.000Z");
      expect(() => services.service.createCategory("Demoted Owner", null)).toThrow();
      expect((a.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(1n);
    } finally { a.close(); b.close(); }
  });
});
