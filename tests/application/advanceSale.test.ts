/**
 * DEC-35x — APPLY A CUSTOMER ADVANCE TO A NEW SALE (owner only). Real SQLite, real services: the till's
 * own credit sale (catalog pricing, owner gate) + the advance application, in ONE transaction.
 *
 * 🔴 PROTECTS: owner only · same customer · the uncovered rest stays debt · never above the advance's
 * unused balance or the sale total · no new Cash/Whish money (no tender, no reference registered, the
 * day's money in unchanged) · retry returns the SAME sale + application, never a second sale · a fault or
 * a REAL process death before COMMIT leaves neither the sale nor the application.
 *
 * Synthetic data only. Minor units (USD cents). Harness clock: 2026-10-04, Beirut.
 */
import { TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdvanceService } from "../../src/application/advanceService";
import { DailyMoneyService } from "../../src/application/dailyMoneyService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { DailyMoneyRepository } from "../../src/persistence/dailyMoneyRepository";
import type { IpcResult } from "../../src/shared/ipcContract";
import { advanceDeps, makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let dm: DailyMoneyService;
let ipc: ReturnType<typeof syncHandlers>;
const DAY = "2026-10-04";
const LINES = [{ productId: "prod-0001", quantityMilli: 2000 }]; // 2 × 2.50 = 5.00

function wire() {
  adv = makeAdvances(h);
  dm = new DailyMoneyService({
    repository: new DailyMoneyRepository(h.db),
    actor: () => {
      const c = h.service.currentCashier();
      const role = h.service.currentRole();
      return c && role ? { id: c.id, role } : null;
    },
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone, currency: FIXTURE_TERMINAL.currency },
    now: h.clock.now,
  });
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger, advances: adv, dailyMoney: dm }));
}
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  wire();
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "OK";
};
const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const count = (table: string, where = "1=1") => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
const footprint = () => ["sales", "sale_lines", "sale_tenders", "obligations", "settlements", "advance_applications", "external_references", "receipts"].map((x) => count(x));
const customer = (name: string) => h.parties.create({ kind: "customer", displayName: name }).party;
const advance = (customerId: string, minor: bigint, channel: "cash" | "whish" = "cash", reference?: string) => {
  const k = newKey();
  const r = adv.record({ customerId, amountMinor: minor, channel, ...(reference ? { reference, fundsConfirmed: true } : {}), idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
};
const sell = (customerId: string, advanceId: string, amountMinor: bigint, idempotencyKey = newKey(), over: Record<string, unknown> = {}) =>
  adv.sellOnAdvance({ idempotencyKey, customerId, lines: LINES, expectedTotalMinor: 500n, advanceId, amountMinor, ...over });

describe("sell on an advance — the happy paths", () => {
  it("part of a 5.00 sale from a 30.00 advance: the sale is on account, 2.00 applied, 3.00 stays debt; no tender", () => {
    const c = customer("زبون البيع على الدفعة");
    const a = advance(c.id, 3000n);
    const r = sell(c.id, a.id, 200n);
    expect([r.duplicate, r.sale.paymentStatus, r.sale.total.minor, r.obligation.amountMinor]).toEqual([false, "unpaid", 500n, 500n]);
    expect([r.application.unusedMinor, r.application.debtOutstandingMinor]).toEqual([2800n, 300n]);
    expect([count("sale_tenders"), count("settlements"), count("advance_applications")]).toEqual([0, 1, 1]);
    expect(h.db.prepare("SELECT method, provider, reference FROM settlements").get()).toEqual({ method: "cash", provider: null, reference: null });
  });

  it("the whole sale from the advance: nothing left owed", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const r = sell(c.id, a.id, 500n);
    expect([r.application.debtOutstandingMinor, r.application.unusedMinor]).toEqual([0n, 2500n]);
  });

  it("🔴 a WHISH advance pays a sale: no reference registered again, no Whish money in", () => {
    const c = customer("زبون ويش");
    const a = advance(c.id, 2000n, "whish", "WH-SALE-ADV-1");
    const refs = count("external_references");
    const before = dm.day(DAY);
    sell(c.id, a.id, 500n);
    expect(count("external_references")).toBe(refs);
    expect(h.db.prepare("SELECT method, provider, reference FROM settlements").get()).toEqual({ method: "external", provider: null, reference: null });
    expect(dm.day(DAY).moneyIn).toEqual(before.moneyIn);
  });
});

describe("🔴 Daily Money before and after — no new money", () => {
  it("money in unchanged; revenue 5.00 and on-account 5.00 shown; 2.00 reported as applied, not collected", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const before = dm.day(DAY);
    sell(c.id, a.id, 200n);
    const after = dm.day(DAY);
    expect(after.moneyIn).toEqual(before.moneyIn);
    expect(after.net).toEqual(before.net);
    expect([after.sales.revenueMinor, after.sales.onAccountMinor, after.sales.received.totalMinor]).toEqual([500n, 500n, 0n]);
    expect([after.advanceApplied.count, after.advanceApplied.totalMinor, after.collections.totalMinor]).toEqual([1, 200n, 0n]);
  });
});

describe("refusals — each its own code, NOTHING written (not even the sale)", () => {
  it("above the advance, above the total, another customer's advance, a corrected advance, a cashier", () => {
    const c = customer("زبون");
    const other = customer("زبون آخر");
    const a = advance(c.id, 300n);
    const theirs = advance(other.id, 3000n);
    const corrected = advance(c.id, 1000n);
    adv.correct({ advanceId: corrected.id, kind: "not_received", reason: "لم يدفع", confirmNotReceived: true, idempotencyKey: newKey() });
    const fp = footprint();
    expect(codeOf(() => sell(c.id, a.id, 301n))).toBe("ADVANCE_APPLY_ABOVE_BALANCE");
    expect(codeOf(() => sell(c.id, advance(c.id, 5000n).id, 501n))).toBe("ADVANCE_APPLY_ABOVE_DEBT");
    expect(codeOf(() => sell(c.id, theirs.id, 100n))).toBe("ADVANCE_DEBT_OTHER_CUSTOMER");
    expect(codeOf(() => sell(c.id, corrected.id, 100n))).toBe("ADVANCE_CORRECTED_NOT_APPLICABLE");
    expect(codeOf(() => sell(c.id, a.id, 0n))).toBe("INVALID_AMOUNT");
    h.service.logout();
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect(codeOf(() => sell(c.id, a.id, 100n))).toBe("NOT_AUTHORIZED");
    const r = ipc.sellOnAdvance({ idempotencyKey: newKey(), lines: LINES, expectedTotalMinor: "500", customerId: c.id, advanceId: a.id, amountMinor: "100" });
    expect(r.ok ? "OK" : r.error.code).toBe("NOT_AUTHORIZED");
    // 5.00 advance recorded above is the only new row — no sale, tender, debt or settlement anywhere.
    expect(footprint()).toEqual(fp);
  });

  it("a stale screen total is refused by the till's own check (TOTAL_MISMATCH); nothing written", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const fp = footprint();
    expect(codeOf(() => sell(c.id, a.id, 100n, newKey(), { expectedTotalMinor: 400n }))).toBe("TOTAL_MISMATCH");
    expect(footprint()).toEqual(fp);
  });
});

describe("idempotency and atomicity", () => {
  it("🔴 a retry returns the SAME sale and application — never a second sale; other details under the key are refused", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const key = "sale-adv-retry-0001";
    const first = sell(c.id, a.id, 200n, key);
    const fp = footprint();
    const again = sell(c.id, a.id, 200n, key);
    expect([again.duplicate, again.sale.id, again.application.application.id]).toEqual([true, first.sale.id, first.application.application.id]);
    expect(footprint()).toEqual(fp);
    expect(codeOf(() => sell(c.id, a.id, 300n, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toEqual(fp);
  });

  it("a key already used by a PLAIN credit sale is never extended with an application", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const key = "sale-adv-plain-0001";
    h.service.createCustomerCreditSale({ idempotencyKey: key, customerId: c.id, lines: LINES, expectedTotalMinor: 500n });
    expect(codeOf(() => sell(c.id, a.id, 200n, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(count("advance_applications")).toBe(0);
  });

  it("🔴 a fault AFTER the sale is written rolls back the sale, its debt AND its receipt number", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    class Boom extends AdvanceService {
      protected override afterSaleOnAdvanceWritten(): void {
        throw new Error("simulated fault between the sale and the application");
      }
    }
    const fp = footprint();
    expect(() => new Boom(advanceDeps(h)).sellOnAdvance({ idempotencyKey: newKey(), customerId: c.id, lines: LINES, expectedTotalMinor: 500n, advanceId: a.id, amountMinor: 200n })).toThrow(/simulated fault/);
    expect(footprint()).toEqual(fp);
    expect(sell(c.id, a.id, 200n).sale.receiptNumber).toBe(1);
  });

  it("🔴 REAL process death inside the transaction: neither sale nor application survives; the retry sells ONCE", () => {
    const c = customer("زبون الانهيار");
    const a = advance(c.id, 3000n);
    h.db.close();
    const r = spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "..", "helpers", "advanceCrashChild.ts"), "sale-inside-tx", t.dbPath, a.id, "sale-adv-crash-0001"], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, SALE_CUSTOMER: c.id },
    });
    expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
    h = makeHarness(t.dbPath);
    wire();
    expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect([count("sales"), count("obligations"), count("advance_applications")]).toEqual([0, 0, 0]);
    const done = sell(c.id, a.id, 200n, "sale-adv-crash-0001");
    expect([done.duplicate, count("sales"), count("advance_applications"), done.sale.receiptNumber]).toEqual([false, 1, 1, 1]);
  });
});

describe("the channel", () => {
  it("returns the read-back balances; a retry answers duplicate", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const req = { idempotencyKey: "sale-adv-ipc-0001", lines: LINES, expectedTotalMinor: "500", customerId: c.id, advanceId: a.id, amountMinor: "200" };
    const r = ok<{ advanceNumber: string; applied: { minor: string }; unused: { minor: string }; debtOutstanding: { minor: string }; duplicate: boolean }>(ipc.sellOnAdvance(req));
    expect([r.advanceNumber, r.applied.minor, r.unused.minor, r.debtOutstanding.minor, r.duplicate]).toEqual(["ADV-000001", "200", "2800", "300", false]);
    expect(ok<{ duplicate: boolean }>(ipc.sellOnAdvance(req)).duplicate).toBe(true);
    expect(count("sales")).toBe(1);
  });
});
