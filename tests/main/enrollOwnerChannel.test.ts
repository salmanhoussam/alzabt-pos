/**
 * O-1 Phase 1: the PUBLIC `enrollOwner` channel, through the real IPC handler and the real PosService.
 *
 * Public means «reachable before a session», never «authoritative»: the handler only bounds the payload, and
 * OperatorService.enrollOwner decides (unclaimed AND empty, inside its transaction). Demo denies the channel.
 * Synthetic ledgers only.
 */
import { describe, expect, it } from "vitest";
import { OperatorService } from "../../src/application/operatorService";
import { PosService } from "../../src/application/posService";
import { emptyCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { CHANNEL_POLICY } from "../../src/main/channelPolicy";
import { DEMO_CHANNEL_POLICY } from "../../src/main/demoPolicy";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { ledgerEmptiness } from "../../src/persistence/ledgerEmptiness";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { tempDir } from "../helpers/harness";

/** A real PosService on a FRESH (unclaimed, empty) ledger, wired like main (ledgerServices passes ledgerEmpty). */
function freshTerminal(db: Db) {
  const operators = new OperatorService({
    operators: new OperatorRepository(db),
    audit: new AuditRepository(db, { appVersion: "test", schemaVersion: 21 }),
    terminal: FIXTURE_TERMINAL,
    transact: (fn) => db.transaction(fn).immediate(),
    ledgerEmpty: () => ledgerEmptiness(db).empty,
  });
  const service = new PosService({
    repository: new SaleRepository(db),
    pinStates: new PinStateRepository(db),
    catalog: emptyCatalog(FIXTURE_TERMINAL.currency),
    cashiers: FIXTURE_CASHIERS,
    operators,
    terminal: FIXTURE_TERMINAL,
  });
  return { service, handlers: createIpcHandlers(service, {}) };
}

describe("the enrollOwner channel", () => {
  it("is classified PUBLIC (the policy test pins the set) and DENIED in Demo", () => {
    expect(CHANNEL_POLICY.enrollOwner).toBe("public");
    expect((DEMO_CHANNEL_POLICY as Record<string, string>).enrollOwner).toBe("deny");
  });

  it("on a new shop: enrolls, opens the OWNER's session, and returns only the cashier DTO", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      const { service, handlers } = freshTerminal(db);
      const r = handlers.enrollOwner({ name: "حسين رقا", pin: "482613" }) as { ok: boolean; data: Record<string, unknown> };
      expect(r.ok).toBe(true);
      expect(r.data).toMatchObject({ id: "cashier-01", name: "حسين رقا" });
      expect(JSON.stringify(r)).not.toContain("482613");
      expect(service.currentCashier()).toEqual({ id: "cashier-01", name: "حسين رقا" });
      expect(service.currentRole()).toBe("owner");
      expect(new OperatorRepository(db).terminalClaimed()).toBe(true);
      // A second attempt (a stale screen, a second click) is refused by main, not by the renderer.
      expect(handlers.enrollOwner({ name: "Stranger", pin: "735190" })).toMatchObject({
        ok: false,
        error: { code: "ENROLLMENT_NOT_AVAILABLE" },
      });
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it("🔴 the payload is exact: extra fields, missing fields and over-long values are refused before the service", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      const { handlers } = freshTerminal(db);
      for (const bad of [
        { name: "x", pin: "482613", role: "owner" },
        { name: "x" },
        { pin: "482613" },
        { name: "x".repeat(61), pin: "482613" },
        { name: "x", pin: "1".repeat(17) },
        null,
      ]) expect(handlers.enrollOwner(bad)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(new OperatorRepository(db).terminalClaimed()).toBe(false);
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it("🔴 refuses a published PIN through the channel, and a shop with data", () => {
    const t = tempDir();
    const db = openDatabase(t.dbPath);
    try {
      const { handlers } = freshTerminal(db);
      expect(handlers.enrollOwner({ name: "x", pin: "1111" })).toMatchObject({ ok: false, error: { code: "INVALID_PIN" } });
      db.prepare(
        "INSERT INTO catalog_products (id, source, source_key, name_ar, selling_price_minor, currency, base_unit, price_needs_review, is_active, created_at, updated_at) VALUES ('p','manual','k','صنف',100,'USD','piece',0,1,'2026-01-01','2026-01-01')",
      ).run();
      expect(handlers.enrollOwner({ name: "x", pin: "482613" })).toMatchObject({
        ok: false,
        error: { code: "ENROLLMENT_NOT_AVAILABLE" },
      });
      expect(new OperatorRepository(db).terminalClaimed()).toBe(false);
    } finally {
      db.close();
      t.cleanup();
    }
  });
});
