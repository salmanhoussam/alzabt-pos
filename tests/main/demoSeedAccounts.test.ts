import Database from "better-sqlite3";
import { randomBytes, randomInt, scryptSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRYPT } from "../../src/application/cashierAuth";
import { OperatorService } from "../../src/application/operatorService";
import { PosService } from "../../src/application/posService";
import { emptyCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { createSyntheticDemoRoot, openNewSyntheticDemoLedger, reserveSyntheticDemoProfile } from "../../src/main/demoProfile";
import { createSyntheticAccountSetup, SyntheticAccountSetupError } from "../../src/main/demoSeedAccounts";

const parent = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-accounts-test-"));
const fresh = () => openNewSyntheticDemoLedger(reserveSyntheticDemoProfile(createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")))));
const code = () => String(randomInt(100000, 1000000));
function setBootstrap(repo: OperatorRepository, id: string, pin: string) {
  const salt = randomBytes(8).toString("hex");
  const hash = scryptSync(pin, Buffer.from(salt, "hex"), 32, SCRYPT).toString("hex");
  repo.setPin(id, salt, hash, "2026-01-01", { mustResetPin: true });
}

describe("main-private synthetic setup ceremony", () => {
  it("uses existing OperatorService setup and audit without creating a PosService session", () => {
    const db = fresh();
    try {
      const repo = new OperatorRepository(db);
      const ownerBootstrap = code();
      const cashierBootstrap = code();
      const ownerFinal = code();
      let cashierFinal = code();
      while (cashierFinal === ownerFinal) cashierFinal = code();
      setBootstrap(repo, "cashier-01", ownerBootstrap);
      setBootstrap(repo, "cashier-02", cashierBootstrap);
      const audit = new AuditRepository(db, { appVersion: "test", schemaVersion: 20 });
      const operator = new OperatorService({ operators: repo, audit, terminal: FIXTURE_TERMINAL, transact: (fn) => db.transaction(fn).immediate() });
      const service = new PosService({
        repository: new SaleRepository(db), pinStates: new PinStateRepository(db),
        catalog: emptyCatalog(FIXTURE_TERMINAL.currency), cashiers: FIXTURE_CASHIERS, operators: operator,
        terminal: FIXTURE_TERMINAL,
      });
      const setup = createSyntheticAccountSetup(db, (id) => id === "cashier-01" ? ownerBootstrap : cashierBootstrap);
      expect(service.currentCashier()).toBeNull();
      expect(setup.completeOwner({ name: "Synthetic owner", pin: ownerFinal })).toEqual({ operatorId: "cashier-01" });
      expect(service.currentCashier()).toBeNull();
      expect(setup.completeCashier({ name: "Synthetic cashier", pin: cashierFinal })).toEqual({ operatorId: "cashier-02" });
      expect(service.currentCashier()).toBeNull();
      expect(service.currentRole()).toBeNull();
      expect(repo.terminalClaim()?.byOperatorId).toBe("cashier-01");
      expect(repo.findById("cashier-01")?.must_reset_pin).toBe(0);
      expect(repo.findById("cashier-02")?.must_reset_pin).toBe(0);
      const events = db.prepare("SELECT event_type, metadata_json, changed_json FROM audit_events").all();
      expect(events.length).toBeGreaterThan(0);
      const json = JSON.stringify(events);
      for (const secret of [ownerBootstrap, cashierBootstrap, ownerFinal, cashierFinal]) expect(json).not.toContain(secret);
      expect(() => createSyntheticAccountSetup(db, () => "")).toThrow();
    } finally { if (db.open) db.close(); }
  });

  it("rejects a non-reserved in-memory database without closing or changing it", () => {
    const db = new Database(":memory:");
    try {
      expect(() => createSyntheticAccountSetup(db, () => "")).toThrow();
      expect(db.open).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("does not retry a partially completed ceremony after a later failure", () => {
    const db = fresh();
    const repo = new OperatorRepository(db);
    const initial = code();
    setBootstrap(repo, "cashier-01", initial);
    const setup = createSyntheticAccountSetup(db, (id) => id === "cashier-01" ? initial : "wrong");
    expect(setup.completeOwner({ name: "Synthetic owner", pin: code() })).toEqual({ operatorId: "cashier-01" });
    expect(() => setup.completeCashier({ name: "Synthetic cashier", pin: code() })).toThrow(SyntheticAccountSetupError);
    expect(db.open).toBe(false);
    expect(() => createSyntheticAccountSetup(db, () => "")).toThrow();
  });

  it("refuses cashier-first without leaving a usable session or retry", () => {
    const db = fresh();
    const setup = createSyntheticAccountSetup(db, () => "wrong");
    expect(() => setup.completeCashier({ name: "Synthetic cashier", pin: code() })).toThrow(SyntheticAccountSetupError);
    expect(db.open).toBe(false);
    expect(() => setup.completeOwner({ name: "Synthetic owner", pin: code() })).toThrow(SyntheticAccountSetupError);
  });

  it("closes and consumes the fresh synthetic ledger on setup failure", () => {
    const db = fresh();
    const setup = createSyntheticAccountSetup(db, () => "not-a-real-credential");
    expect(() => setup.completeOwner({ name: "Synthetic owner", pin: code() })).toThrow(SyntheticAccountSetupError);
    expect(db.open).toBe(false);
    expect(() => createSyntheticAccountSetup(db, () => "")).toThrow();
    expect(() => setup.completeOwner({ name: "Synthetic owner", pin: code() })).toThrow(SyntheticAccountSetupError);
  });
});
