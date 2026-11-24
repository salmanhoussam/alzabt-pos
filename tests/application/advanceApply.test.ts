/**
 * DEC-35x — APPLY A CUSTOMER ADVANCE TO AN EXISTING DEBT (owner only). Real SQLite, real services.
 *
 * 🔴 THE RULES THESE PROTECT (owner decisions D2/D3/D8 + DEC-35x):
 *   · owner only — service, channel and trigger; a refused application leaves NO trace
 *   · the SAME customer's receivable only; partial or full, within the advance's unused balance AND
 *     the debt's outstanding amount; never a settled debt, a debt of a voided sale, a supplier's
 *     payable, another currency, or a corrected advance
 *   · ONE transaction: settlement + application or nothing (also proven by real process death)
 *   · idempotent: a retry returns the SAME application; a reused key with other details is refused
 *   · NOT new money: no cash or Whish receipt is created, the Whish reference stays on the advance
 *     (registered once), the day's money in is unchanged, collections are unchanged
 *   · the statements link the debt, the ADV and the application
 *
 * Synthetic data only. Amounts in minor units (USD cents). Harness clock: 2026-10-04, Beirut.
 */
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
const X2 = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
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
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "OK";
};
const count = (table: string, where = "1=1") => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
/** Every money-bearing table, so "nothing written" is checked everywhere at once. */
const footprint = () => ["settlements", "advance_applications", "receipts", "customer_advances", "advance_refunds", "external_references", "sales", "sale_tenders"].map((x) => count(x));
const customer = (name: string) => h.parties.create({ kind: "customer", displayName: name }).party;
const owe = (partyId: string, ref: string, minor: bigint, currency = "USD") =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency, amountMinor: minor }).record;
const asCashier = () => {
  h.service.logout();
  h.service.login("cashier-02", "2222");
};
const advance = (customerId: string, minor: bigint, channel: "cash" | "whish" = "cash", reference?: string) => {
  const k = newKey();
  const r = adv.record({ customerId, amountMinor: minor, channel, ...(reference ? { reference, fundsConfirmed: true } : {}), idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
};
const apply = (advanceId: string, obligationId: string, amountMinor: bigint, idempotencyKey = newKey()) =>
  adv.applyToDebt({ advanceId, obligationId, amountMinor, idempotencyKey });
const outstanding = (obligationId: string) => h.ledger.outstandingOf(obligationId).minor;

describe("apply — the happy paths", () => {
  it("a cash advance pays part of a credit-sale debt: one settlement in CASH without reference, one application, balances read back", () => {
    const c = customer("زبون التطبيق");
    const a = advance(c.id, 3000n);
    const sale = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, ...X2 });
    const debt = h.ledger.findSaleObligation(sale.sale.id)!;
    const r = apply(a.id, debt.id, 200n);
    expect([r.duplicate, r.unusedMinor, r.debtOutstandingMinor]).toEqual([false, 2800n, 300n]);
    const st = h.db.prepare("SELECT method, provider, reference, funds_confirmed AS f, receipt_id AS r, amount_minor AS m FROM settlements").all();
    expect(st).toEqual([{ method: "cash", provider: null, reference: null, f: null, r: null, m: 200n }]);
    expect(count("advance_applications")).toBe(1);
    expect(r.application).toMatchObject({ advanceId: a.id, obligationId: debt.id, amountMinor: 200n, appliedBy: "cashier-01" });
  });

  it("full: the rest of the debt, then a second debt from what remains — never above either", () => {
    const c = customer("زبون ديون متعددة");
    const a = advance(c.id, 1000n);
    const d1 = owe(c.id, "PAPER-A", 600n);
    const d2 = owe(c.id, "PAPER-B", 900n);
    expect(apply(a.id, d1.id, 600n).debtOutstandingMinor).toBe(0n);
    expect(codeOf(() => apply(a.id, d2.id, 401n))).toBe("ADVANCE_APPLY_ABOVE_BALANCE");
    const r = apply(a.id, d2.id, 400n);
    expect([r.unusedMinor, r.debtOutstandingMinor]).toEqual([0n, 500n]);
    expect(codeOf(() => apply(a.id, d2.id, 1n))).toBe("ADVANCE_APPLY_ABOVE_BALANCE");
  });

  it("🔴 a WHISH advance: settlement 'external' with NO provider and NO reference — the reference stays registered ONCE, on the advance", () => {
    const c = customer("زبون ويش");
    const a = advance(c.id, 2000n, "whish", "WH-APPLY-1");
    const refs = count("external_references");
    const d = owe(c.id, "PAPER-W", 1500n);
    apply(a.id, d.id, 1500n);
    expect(h.db.prepare("SELECT method, provider, reference FROM settlements").get()).toEqual({ method: "external", provider: null, reference: null });
    expect(count("external_references")).toBe(refs);
    expect(count("external_references", "owner_kind = 'advance'")).toBe(1);
  });
});

describe("🔴 NOT new money", () => {
  it("the day's money in, the collections and the advances are unchanged; the application is reported apart", () => {
    const c = customer("زبون المال");
    const a = advance(c.id, 3000n);
    const d = owe(c.id, "PAPER-M", 2000n);
    const before = dm.day(DAY);
    const collectedBefore = h.ledger.collectionTotals(DAY);
    apply(a.id, d.id, 1500n);
    const after = dm.day(DAY);
    expect(after.moneyIn).toEqual(before.moneyIn);
    expect(after.collections).toEqual(before.collections);
    expect(after.advances).toEqual(before.advances);
    expect(after.net).toEqual(before.net);
    expect([after.advanceApplied.count, after.advanceApplied.totalMinor]).toEqual([1, 1500n]);
    expect(h.ledger.collectionTotals(DAY)).toEqual(collectedBefore);
    expect(count("receipts")).toBe(0);
  });
});

describe("refusals — each its own code, NOTHING written", () => {
  it("🔴 a cashier is refused (service, channel); nothing written", () => {
    const c = customer("زبون");
    const a = advance(c.id, 1000n);
    const d = owe(c.id, "P", 500n);
    asCashier();
    const fp = footprint();
    expect(codeOf(() => apply(a.id, d.id, 100n))).toBe("NOT_AUTHORIZED");
    const r = ipc.applyAdvanceToDebt({ advanceId: a.id, obligationId: d.id, amountMinor: "100", idempotencyKey: newKey() });
    expect(r.ok ? "OK" : r.error.code).toBe("NOT_AUTHORIZED");
    expect(footprint()).toEqual(fp);
  });

  it("another customer's debt / a supplier's payable / unknown ids / other currency", () => {
    const c = customer("زبون أ");
    const other = customer("زبون ب");
    const a = advance(c.id, 1000n);
    const theirs = owe(other.id, "THEIRS", 500n);
    const s = h.parties.create({ kind: "supplier", displayName: "مورد" }).party;
    const payable = h.ledger.postObligation({ partyId: s.id, direction: "payable", sourceKind: "manual", sourceRef: "BILL", currency: "USD", amountMinor: 500n }).record;
    const lbp = owe(c.id, "LBP-DEBT", 500000n, "LBP");
    const fp = footprint();
    expect(codeOf(() => apply(a.id, theirs.id, 100n))).toBe("ADVANCE_DEBT_OTHER_CUSTOMER");
    expect(codeOf(() => apply(a.id, payable.id, 100n))).toBe("ADVANCE_DEBT_NOT_FOUND");
    expect(codeOf(() => apply(a.id, "no-such-debt", 100n))).toBe("ADVANCE_DEBT_NOT_FOUND");
    expect(codeOf(() => apply("no-such-adv", theirs.id, 100n))).toBe("ADVANCE_NOT_FOUND");
    expect(codeOf(() => apply(a.id, lbp.id, 100n))).toBe("ADVANCE_DEBT_CURRENCY");
    expect(footprint()).toEqual(fp);
  });

  it("a settled debt, above the debt, zero / negative / non-exact amounts", () => {
    const c = customer("زبون");
    const a = advance(c.id, 5000n);
    const d = owe(c.id, "P", 500n);
    const paid = owe(c.id, "PAID", 300n);
    ok(ipc.recordCustomerPayment({ customerId: c.id, obligationId: paid.id, idempotencyKey: newKey(), amountMinor: "300", method: "cash" } as never));
    const fp = footprint();
    expect(codeOf(() => apply(a.id, paid.id, 100n))).toBe("ADVANCE_DEBT_NOT_OPEN");
    expect(codeOf(() => apply(a.id, d.id, 501n))).toBe("ADVANCE_APPLY_ABOVE_DEBT");
    expect(codeOf(() => apply(a.id, d.id, 0n))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => apply(a.id, d.id, -5n))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => adv.applyToDebt({ advanceId: a.id, obligationId: d.id, amountMinor: 1.5, idempotencyKey: newKey() }))).toBe("NOT_EXACT");
    expect(codeOf(() => adv.applyToDebt({ advanceId: a.id, obligationId: d.id, amountMinor: 100n, idempotencyKey: "short" }))).toBe("INVALID_INPUT");
    expect(footprint()).toEqual(fp);
  });

  it("🔴 a corrected advance cannot be applied; its successor can (one payment, one balance)", () => {
    const wrong = customer("الزبون الخطأ");
    const right = customer("الزبون الصحيح");
    const a = advance(wrong.id, 1000n);
    const d = owe(right.id, "P", 800n);
    const corr = adv.correct({ advanceId: a.id, kind: "replaced", reason: "على الزبون الخطأ", customerId: right.id, idempotencyKey: newKey() });
    expect(codeOf(() => apply(a.id, d.id, 100n))).toBe("ADVANCE_CORRECTED_NOT_APPLICABLE");
    const successor = corr.successor!;
    expect(apply(successor.id, d.id, 800n).debtOutstandingMinor).toBe(0n);
  });

  it("🔴 an applied advance can no longer be corrected (ADVANCE_IN_USE) — the correction cannot erase money already used", () => {
    const c = customer("زبون");
    const a = advance(c.id, 1000n);
    apply(a.id, owe(c.id, "P", 500n).id, 100n);
    expect(codeOf(() => adv.correct({ advanceId: a.id, kind: "not_received", reason: "خطأ", confirmNotReceived: true, idempotencyKey: newKey() }))).toBe("ADVANCE_IN_USE");
  });

  it("🔴 the database refuses a bypass above the unused balance (trigger), whatever the service does", () => {
    const c = customer("زبون");
    const a = advance(c.id, 1000n);
    const d = owe(c.id, "P", 5000n);
    apply(a.id, d.id, 900n);
    const at = h.clock.now().toISOString();
    expect(() =>
      h.db.transaction(() => {
        h.db
          .prepare(`INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date) VALUES ('s-x', ?, 'USD', 'bypass-key-01', 'fp', 200, 'cash', 'cashier-01', ?, ?)`)
          .run(d.id, at, DAY);
        h.db.prepare(`INSERT INTO advance_applications (id, advance_id, settlement_id, amount_minor, idempotency_key, applied_by, applied_at) VALUES ('a-x', ?, 's-x', 200, 'bypass-app-01', 'cashier-01', ?)`).run(a.id, at);
      })(),
    ).toThrow(/within the unused balance/);
    expect(count("advance_applications")).toBe(1);
  });
});

describe("idempotency and atomicity", () => {
  it("🔴 a retry with the SAME key returns the SAME application; nothing new; a reused key for other details is refused", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const d = owe(c.id, "P", 2000n);
    const key = "apply-key-retry-01";
    const first = apply(a.id, d.id, 700n, key);
    const fp = footprint();
    const again = apply(a.id, d.id, 700n, key);
    expect(again.duplicate).toBe(true);
    expect(again.application.id).toBe(first.application.id);
    expect(footprint()).toEqual(fp);
    expect(codeOf(() => apply(a.id, d.id, 701n, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => apply(a.id, owe(c.id, "P2", 900n).id, 700n, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(outstanding(d.id)).toBe(1300n);
  });

  it("🔴 a failure AFTER the settlement is written rolls BOTH back — no orphan settlement, no half application", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const d = owe(c.id, "P", 2000n);
    class Boom extends AdvanceService {
      protected override afterApplicationSettlementWritten(): void {
        throw new Error("simulated fault between the two inserts");
      }
    }
    const fp = footprint();
    expect(() => new Boom(advanceDeps(h)).applyToDebt({ advanceId: a.id, obligationId: d.id, amountMinor: 500n, idempotencyKey: newKey() })).toThrow(/simulated fault/);
    expect(footprint()).toEqual(fp);
    expect(outstanding(d.id)).toBe(2000n);
  });
});

describe("statements link the debt, the ADV and the application", () => {
  it("the debt statement names the advance; the advance statement names the debt", () => {
    const c = customer("زبون الكشف");
    const a = advance(c.id, 3000n);
    const sale = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, ...X2 });
    const debt = h.ledger.findSaleObligation(sale.sale.id)!;
    ok(ipc.applyAdvanceToDebt({ advanceId: a.id, obligationId: debt.id, amountMinor: "250", idempotencyKey: "apply-ipc-key-001" }));
    const stmt = ok<{ obligations: Array<{ id: string; outstanding: { minor: string }; settlements: Array<{ advance: { number: string } | null; method: string }> }> }>(
      ipc.getCustomerStatement({ customerId: c.id }),
    );
    const row = stmt.obligations.find((o) => o.id === debt.id)!;
    expect(row.outstanding.minor).toBe("250");
    expect(row.settlements).toEqual([expect.objectContaining({ advance: { advanceId: a.id, number: "ADV-000001" } })]);
    const advStmt = ok<{ lines: Array<{ unused: { minor: string }; applications: Array<{ debtDocument: unknown; amount: { minor: string }; appliedByName: string }> }> }>(
      ipc.getAdvanceStatement({ customerId: c.id }),
    );
    expect(advStmt.lines[0]!.unused.minor).toBe("2750");
    expect(advStmt.lines[0]!.applications).toEqual([
      expect.objectContaining({ debtDocument: { kind: "sale", receiptNumber: sale.sale.receiptNumber }, amount: { minor: "250", currency: "USD" } }),
    ]);
    // A retry through the channel answers duplicate, the SAME figures.
    const again = ok<{ duplicate: boolean; unused: { minor: string } }>(ipc.applyAdvanceToDebt({ advanceId: a.id, obligationId: debt.id, amountMinor: "250", idempotencyKey: "apply-ipc-key-001" }));
    expect([again.duplicate, again.unused.minor]).toEqual([true, "2750"]);
  });
});

describe("🔴 REAL process death", () => {
  const CHILD = join(__dirname, "..", "helpers", "advanceCrashChild.ts");
  function crashAt(mode: string, advanceId: string, debtId: string, key: string) {
    h.db.close();
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, mode, t.dbPath, advanceId, key], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, APPLY_DEBT: debtId },
    });
    expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
    if (process.platform === "win32") expect(r.status).not.toBe(0);
    else expect(r.signal).toBe("SIGKILL");
    h = makeHarness(t.dbPath);
    adv = makeAdvances(h);
  }

  it("killed INSIDE the transaction (settlement written): nothing survives; the retry under the same key applies once", () => {
    const c = customer("زبون الانهيار");
    const a = advance(c.id, 3000n);
    const d = owe(c.id, "P", 2000n);
    crashAt("apply-inside-tx", a.id, d.id, "apply-crash-key-01");
    expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect([count("settlements"), count("advance_applications")]).toEqual([0, 0]);
    const r = apply(a.id, d.id, 1000n, "apply-crash-key-01");
    expect([r.duplicate, r.unusedMinor, r.debtOutstandingMinor]).toEqual([false, 2000n, 1000n]);
  });

  it("killed AFTER the commit (reply lost): the retry returns the SAME application, nothing twice", () => {
    const c = customer("زبون الانهيار");
    const a = advance(c.id, 3000n);
    const d = owe(c.id, "P", 2000n);
    crashAt("apply-after-commit", a.id, d.id, "apply-crash-key-02");
    expect([count("settlements"), count("advance_applications")]).toEqual([1, 1]);
    const r = apply(a.id, d.id, 1000n, "apply-crash-key-02");
    expect([r.duplicate, r.unusedMinor, r.debtOutstandingMinor]).toEqual([true, 2000n, 1000n]);
    expect([count("settlements"), count("advance_applications")]).toEqual([1, 1]);
  });
});

