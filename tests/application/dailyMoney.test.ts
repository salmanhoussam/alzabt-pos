/**
 * DAILY MONEY IN / OUT (DEC-35x) — on a REAL SQLite ledger, written through the product's own
 * services (sales, split, partial, credit, void, collections, a shared Whish receipt, advances,
 * corrections). Three rows have no writer yet and are inserted the way their future writer must
 * write them (an advance APPLICATION, a cash REFUND, a supplier payment), so the report already
 * classifies them correctly the day those slices land.
 *
 * 🔴 WHAT THESE PROTECT:
 *   · Revenue, money received, collections, advances, corrections and money out are kept apart.
 *   · An advance applied to a debt is NEVER new money (its settlement would otherwise look like a
 *     plain cash collection — measured below: the naive collections sum is wrong by exactly that).
 *   · A shared Whish receipt is counted once; a voided sale's tender is excluded and shown apart.
 *   · Every total reconciles to the ledger by an INDEPENDENT query, not by re-adding the report.
 *   · A past day never changes when later days add or correct money.
 *   · Owner only — at the service AND the channel.
 *
 * Synthetic data only. Amounts in minor units (USD cents). Harness clock: 2026-10-04, Beirut.
 */
import { TEST_OWNER_PIN, TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AdvanceService } from "../../src/application/advanceService";
import { DailyMoneyService } from "../../src/application/dailyMoneyService";
import { buildDailyMoney, type DailyMoneyReport } from "../../src/domain/dailyMoney";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { DailyMoneyRepository } from "../../src/persistence/dailyMoneyRepository";
import type { IpcResult } from "../../src/shared/ipcContract";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let dm: DailyMoneyService;
let ipc: ReturnType<typeof syncHandlers>;

const DAY1 = "2026-10-04";
const DAY2 = "2026-10-06";
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
const scalar = (sql: string, ...p: unknown[]): bigint => {
  const v = Object.values(h.db.prepare(sql).get(...p) as Record<string, bigint | number | null>)[0];
  return v === null || v === undefined ? 0n : BigInt(v);
};
const customer = (name: string) => h.parties.create({ kind: "customer", displayName: name }).party;
const owe = (partyId: string, ref: string, minor: bigint) =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
const asOwner = () => {
  h.service.logout();
  h.service.login("cashier-01", TEST_OWNER_PIN);
};
const asCashier = () => {
  h.service.logout();
  h.service.login("cashier-02", TEST_CASHIER_PIN);
};
const advance = (customerId: string, minor: bigint, channel: "cash" | "whish", reference?: string) => {
  const k = newKey();
  const r = adv.record({ customerId, amountMinor: minor, channel, ...(reference ? { reference, fundsConfirmed: true } : {}), idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
};

/**
 * The future APPLY-TO-DEBT writer's exact shape (M19 `advance_applications_shape`): a settlement in
 * the advance's own method, no receipt, no provider, no reference — then the application row.
 */
function applyAdvanceBySql(advanceId: string, obligationId: string, minor: bigint, method: string) {
  const at = h.clock.now().toISOString();
  const sid = `set-app-${newKey()}`;
  h.db.transaction(() => {
    h.db
      .prepare(
        `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date)
         VALUES (?, ?, 'USD', ?, 'fp', ?, ?, 'cashier-01', ?, ?)`,
      )
      .run(sid, obligationId, `app-${newKey()}`, minor, method, at, at.slice(0, 10));
    h.db
      .prepare(`INSERT INTO advance_applications (id, advance_id, settlement_id, amount_minor, idempotency_key, applied_by, applied_at) VALUES (?, ?, ?, ?, ?, 'cashier-01', ?)`)
      .run(`app-${newKey()}`, advanceId, sid, minor, `appk-${newKey()}`, at);
  })();
}
function refundAdvanceBySql(advanceId: string, minor: bigint) {
  const at = h.clock.now().toISOString();
  h.db.transaction(() => {
    h.db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance_refund'").run();
    const no = scalar("SELECT last_no FROM document_numbers WHERE kind = 'advance_refund'");
    h.db
      .prepare(
        `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint, refunded_by, refunded_at, business_date)
         VALUES (?, ?, ?, ?, 'cash', 'customer asked', ?, 'fp', 'cashier-01', ?, ?)`,
      )
      .run(`ref-${newKey()}`, no, advanceId, minor, `refk-${newKey()}`, at, at.slice(0, 10));
  })();
}
function supplierPaymentBySql(minor: bigint) {
  const s = h.parties.create({ kind: "supplier", displayName: "مورد الاختبار" }).party;
  const o = h.ledger.postObligation({ partyId: s.id, direction: "payable", sourceKind: "manual", sourceRef: `BILL-${newKey()}`, currency: "USD", amountMinor: 10000n }).record;
  const at = h.clock.now().toISOString();
  h.db
    .prepare(
      `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date)
       VALUES (?, ?, 'USD', ?, 'fp', ?, 'cash', 'cashier-01', ?, ?)`,
    )
    .run(`set-sup-${newKey()}`, o.id, `sup-${newKey()}`, minor, at, at.slice(0, 10));
}

/** One full, varied business day (DAY1). Returns the ids later scenarios need. */
function seedDay1() {
  const a = customer("زبون الصباح");
  const b = customer("زبون المساء");
  // Owner (cashier-01, "Cashier One")
  h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...X2 }); // cash 5.00
  h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "external", whish: { reference: "WH-DM-S1", fundsConfirmed: true }, ...X2 }); // whish 5.00
  h.service.createSplitSale({ idempotencyKey: newKey(), ...X2, cashMinor: 200n, whishMinor: 300n, whish: { reference: "WH-DM-SPLIT", fundsConfirmed: true } });
  const partial = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: a.id, ...X2, downPayment: { amountMinor: 100n, method: "cash" } }); // 1.00 cash, 4.00 debt
  const credit = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: b.id, ...X2 }); // 5.00 debt
  const voided = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...X2 });
  h.service.voidSale(voided.sale.id, "wrong item rung up");

  // A cashier ("Cashier Two") sells and takes an advance.
  asCashier();
  h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...X2 });
  const cashAdv = advance(a.id, 3000n, "cash");
  asOwner();

  // Debt collections: cash 1.00 on the partial sale, Whish 2.00 on the credit sale, one Whish
  // transfer of 3.00 shared across two manual debts (counted ONCE).
  const partialDebt = h.ledger.findSaleObligation(partial.sale.id)!;
  const creditDebt = h.ledger.findSaleObligation(credit.sale.id)!;
  ok(ipc.recordCustomerPayment({ customerId: a.id, obligationId: partialDebt.id, idempotencyKey: newKey(), amountMinor: "100", method: "cash" } as never));
  ok(ipc.recordCustomerPayment({ customerId: b.id, obligationId: creditDebt.id, idempotencyKey: newKey(), amountMinor: "200", method: "whish", reference: "WH-DM-C1", fundsConfirmed: true } as never));
  const d1 = owe(b.id, "PAPER-1", 2000n);
  const d2 = owe(b.id, "PAPER-2", 2000n);
  ok(
    ipc.recordAllocatedReceipt({
      customerId: b.id,
      idempotencyKey: newKey(),
      channel: "whish",
      reference: "WH-DM-R1",
      fundsConfirmed: true,
      currency: "USD",
      totalMinor: "300",
      allocations: [{ obligationId: d1.id, amountMinor: "100" }, { obligationId: d2.id, amountMinor: "200" }],
    } as never),
  );
  const whishAdv = advance(b.id, 5000n, "whish", "WH-DM-A1");

  // Not new money: 10.00 of the cash advance applied to a debt; 5.00 of it refunded in cash; a
  // supplier paid 7.00 cash.
  const paper3 = owe(a.id, "PAPER-3", 1500n);
  applyAdvanceBySql(cashAdv.id, paper3.id, 1000n, "cash");
  refundAdvanceBySql(cashAdv.id, 500n);
  supplierPaymentBySql(700n);
  return { a, b, cashAdv, whishAdv };
}

const ch = (r: DailyMoneyReport["moneyIn"]) => ({ cash: r.byChannel.cash, whish: r.byChannel.whish });

describe("DAY 1 — every kind of money, kept apart", () => {
  it("revenue, money received, collections, advances and money out are separate figures", () => {
    seedDay1();
    const r = dm.day(DAY1);
    expect(r.date).toBe(DAY1);
    // Revenue is not money: 6 live sales × 5.00; the void apart; 4.00 + 5.00 left on account.
    expect([r.sales.count, r.sales.voidedCount, r.sales.revenueMinor, r.sales.voidedTotalMinor, r.sales.onAccountMinor]).toEqual([7, 1, 3000n, 500n, 900n]);
    // Sales tenders: cash 5 + 2 (split) + 1 (down payment) + 5 (cashier) = 13.00; Whish 5 + 3 = 8.00.
    expect(ch(r.sales.received)).toEqual({ cash: 1300n, whish: 800n });
    expect(r.sales.voidedReceived.byChannel.cash).toBe(500n);
    // Collections: cash 1.00; Whish 2.00 + ONE shared receipt of 3.00 (not 3.00 + its two shares).
    expect(ch(r.collections)).toEqual({ cash: 100n, whish: 500n });
    expect(r.collections.count).toBe(3);
    expect(ch(r.advances)).toEqual({ cash: 3000n, whish: 5000n });
    expect(r.corrections.count).toBe(0);
    // F2 (review): the voided cash sale's 5.00 is STILL money received — no refund exists in the ledger.
    // TRANSITION: cash 4400 -> 4900 (old value excluded voided tenders).
    expect(ch(r.moneyIn)).toEqual({ cash: 4900n, whish: 6300n });
    expect(ch(r.refunds)).toEqual({ cash: 500n, whish: 0n });
    expect(ch(r.supplierPayments)).toEqual({ cash: 700n, whish: 0n });
    expect(ch(r.moneyOut)).toEqual({ cash: 1200n, whish: 0n });
    expect({ cash: r.net.byChannel.cash, whish: r.net.byChannel.whish }).toEqual({ cash: 3700n, whish: 6300n }); // TRANSITION 3200 -> 3700
    expect(r.net.totalMinor).toBe(10000n); // TRANSITION 9500 -> 10000
    // No legacy channel appears on a day that has none.
    for (const c of ["bank_transfer", "external", "card", "other", "unspecified"] as const) expect(r.moneyIn.byChannel[c]).toBe(0n);
  });

  it("🔴 an advance APPLIED to a debt is not new money — and the naive sum would have counted it", () => {
    seedDay1();
    const r = dm.day(DAY1);
    expect(r.advanceApplied.count).toBe(1);
    expect(r.advanceApplied.totalMinor).toBe(1000n);
    // The WRONG definition (every direct receivable settlement is a collection) would say cash 11.00.
    const naiveCash = scalar(
      `SELECT sum(s.amount_minor) FROM settlements s JOIN obligations o ON o.id = s.obligation_id
        WHERE s.business_date = ? AND s.receipt_id IS NULL AND o.direction = 'receivable' AND s.method = 'cash'`,
      DAY1,
    );
    expect(naiveCash).toBe(1100n);
    expect(r.collections.byChannel.cash).toBe(100n);
  });

  it("🔴 every total reconciles to the ledger by an INDEPENDENT query", () => {
    seedDay1();
    const r = dm.day(DAY1);
    const liveSales = "FROM sales s WHERE s.business_date = ? AND NOT EXISTS (SELECT 1 FROM voids v WHERE v.sale_id = s.id)";
    expect(r.sales.received.totalMinor).toBe(scalar(`SELECT sum(s.paid_minor) ${liveSales}`, DAY1));
    expect(r.sales.revenueMinor).toBe(scalar(`SELECT sum(s.total_minor) ${liveSales}`, DAY1));
    expect(r.sales.onAccountMinor).toBe(scalar(`SELECT sum(s.balance_due_minor) ${liveSales}`, DAY1));
    // Revenue = paid now + left on account, for the live sales.
    expect(r.sales.revenueMinor).toBe(r.sales.received.totalMinor + r.sales.onAccountMinor);
    expect(r.collections.totalMinor).toBe(
      scalar("SELECT sum(amount_minor) FROM receipts WHERE business_date = ?", DAY1) +
        scalar(
          `SELECT sum(s.amount_minor) FROM settlements s JOIN obligations o ON o.id = s.obligation_id
            WHERE s.business_date = ? AND s.receipt_id IS NULL AND o.direction = 'receivable'
              AND NOT EXISTS (SELECT 1 FROM advance_applications a WHERE a.settlement_id = s.id)`,
          DAY1,
        ),
    );
    expect(r.advances.totalMinor).toBe(scalar("SELECT sum(amount_minor) FROM customer_advances WHERE business_date = ? AND origin = 'receipt'", DAY1));
    expect(r.refunds.totalMinor).toBe(scalar("SELECT sum(amount_minor) FROM advance_refunds WHERE business_date = ?", DAY1));
    expect(r.sales.voidedReceived.totalMinor).toBe(scalar("SELECT sum(s.paid_minor) FROM sales s JOIN voids v ON v.sale_id = s.id AND v.business_date = s.business_date WHERE s.business_date = ?", DAY1));
    expect(r.moneyIn.totalMinor).toBe(r.sales.received.totalMinor + r.sales.voidedReceived.totalMinor + r.collections.totalMinor + r.advances.totalMinor + r.corrections.totalMinor);
    expect(r.net.totalMinor).toBe(r.moneyIn.totalMinor - r.moneyOut.totalMinor);
    // Per operator sums back to the day: nothing is lost or counted twice by the split.
    const opIn = r.byOperator.reduce((a, o) => a + o.moneyIn.cash + o.moneyIn.whish, 0n);
    expect(opIn).toBe(r.moneyIn.totalMinor);
  });

  it("names WHO took the money: the cashier's sale and advance are theirs, the rest the owner's", () => {
    seedDay1();
    const r = dm.day(DAY1);
    const two = r.byOperator.find((o) => o.operatorId === "cashier-02")!;
    const one = r.byOperator.find((o) => o.operatorId === "cashier-01")!;
    expect([two.sales.cash, two.advances.cash, two.moneyIn.cash, two.moneyIn.whish]).toEqual([500n, 3000n, 3500n, 0n]);
    // TRANSITION (F2): owner cash 900 -> 1400 — the voided sale's 5.00 is still money the owner took.
    expect([one.moneyIn.cash, one.moneyIn.whish, one.moneyOut.cash, one.voidedSales.cash]).toEqual([1400n, 6300n, 1200n, 500n]);
    expect(two.operatorName).not.toBe(one.operatorName);
  });
});

describe("corrections — on the correction's day, never new money", () => {
  it("a Whish advance corrected to Cash two days later: DAY2 shows −Whish +Cash, total 0; DAY1 unchanged", () => {
    const { whishAdv } = seedDay1();
    const before = dm.day(DAY1);
    h.clock.set("2026-10-06T09:00:00.000Z");
    adv.correct({ advanceId: whishAdv.id, kind: "replaced", reason: "كان نقداً لا ويش", channel: "cash", idempotencyKey: newKey() });
    const d2 = dm.day(DAY2);
    expect(ch(d2.corrections)).toEqual({ cash: 5000n, whish: -5000n });
    expect(d2.corrections.totalMinor).toBe(0n);
    expect(d2.corrections.count).toBe(1);
    expect(d2.advances.totalMinor).toBe(0n);
    expect(d2.moneyIn.totalMinor).toBe(0n);
    // 🔴 The past day is byte-for-byte what it was.
    expect(dm.day(DAY1)).toEqual(before);
  });

  it("not received: the advance's day shows it; the correction day shows −it; no refund", () => {
    seedDay1();
    h.clock.set("2026-10-06T09:00:00.000Z");
    const c = customer("زبون لم يدفع");
    const x = advance(c.id, 2000n, "cash");
    adv.correct({ advanceId: x.id, kind: "not_received", reason: "لم يدفع", confirmNotReceived: true, idempotencyKey: newKey() });
    const d2 = dm.day(DAY2);
    expect(ch(d2.advances)).toEqual({ cash: 2000n, whish: 0n });
    expect(ch(d2.corrections)).toEqual({ cash: -2000n, whish: 0n });
    expect(d2.moneyIn.totalMinor).toBe(0n);
    expect(d2.refunds.count).toBe(0);
  });

  it("🔴 over every day, advances + corrections per channel == the live (uncorrected) advances", () => {
    const { whishAdv } = seedDay1();
    h.clock.set("2026-10-06T09:00:00.000Z");
    adv.correct({ advanceId: whishAdv.id, kind: "replaced", reason: "كان نقداً", channel: "cash", idempotencyKey: newKey() });
    const total = { cash: 0n, whish: 0n };
    for (const d of [DAY1, DAY2]) {
      const r = dm.day(d);
      total.cash += r.advances.byChannel.cash + r.corrections.byChannel.cash;
      total.whish += r.advances.byChannel.whish + r.corrections.byChannel.whish;
    }
    const live = (method: string) =>
      scalar(`SELECT sum(amount_minor) FROM customer_advances a WHERE method = ? AND NOT EXISTS (SELECT 1 FROM advance_corrections c WHERE c.advance_id = a.id)`, method);
    expect(total).toEqual({ cash: live("cash"), whish: live("external") });
  });
});

describe("🔴 owner only", () => {
  it("a cashier is refused by the service AND by the channel", () => {
    seedDay1();
    asCashier();
    expect(codeOf(() => dm.day(DAY1))).toBe("NOT_AUTHORIZED");
    const r = ipc.getDailyMoney({});
    expect(r.ok ? "OK" : r.error.code).toBe("NOT_AUTHORIZED");
    h.service.logout();
    expect(codeOf(() => dm.day())).toBe("NOT_LOGGED_IN");
  });

  it("the owner gets the DTO through the channel; today is the default; a bad or future date is refused", () => {
    seedDay1();
    const today = ok<{ date: string; moneyIn: { byChannel: Record<string, string>; total: { minor: string } } }>(ipc.getDailyMoney({}));
    expect(today.date).toBe(DAY1);
    expect(today.moneyIn.byChannel.cash).toBe("4900"); // TRANSITION (F2) 4400 -> 4900
    expect(today.moneyIn.total.minor).toBe("11200"); // TRANSITION (F2) 10700 -> 11200
    const r1 = ipc.getDailyMoney({ date: "2026-13-01" });
    expect(r1.ok ? "OK" : r1.error.code).toBe("INVALID_INPUT");
    const r2 = ipc.getDailyMoney({ date: "2026-10-05" });
    expect(r2.ok ? "OK" : r2.error.code).toBe("INVALID_INPUT");
    const r3 = ipc.getDailyMoney({ date: DAY1, extra: 1 } as never);
    expect(r3.ok ? "OK" : r3.error.code).toBe("INVALID_INPUT");
  });

  it("an empty day is all zeros in the terminal currency", () => {
    const r = dm.day("2026-10-01");
    expect([r.currency, r.moneyIn.totalMinor, r.moneyOut.totalMinor, r.sales.count, r.byOperator.length]).toEqual(["USD", 0n, 0n, 0, 0]);
  });
});

describe("🔴 LedgerRepository.collectionTotals — collections only", () => {
  it("excludes the supplier payment (7.00 out) and the advance application (10.00), keeps cash 1.00 + Whish 2.00 + one shared receipt 3.00", () => {
    seedDay1();
    const rows = h.ledger.collectionTotals(DAY1).map((r) => [r.method, r.provider, r.count, r.totalMinor]);
    expect(rows).toEqual([["cash", null, 1, 100n], ["external", "whish", 2, 500n]]);
  });
});

describe("F1 — a void on a LATER day never re-states a past day", () => {
  it("the service refuses it (VOID_NOT_ALLOWED) and day A is byte-for-byte unchanged", () => {
    const sale = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...X2 });
    const before = dm.day(DAY1);
    h.clock.set("2026-10-06T09:00:00.000Z");
    expect(codeOf(() => h.service.voidSale(sale.sale.id, "late void attempt"))).toBe("VOID_NOT_ALLOWED");
    expect(dm.day(DAY1)).toEqual(before);
    expect(dm.day(DAY2).lateVoids).toEqual([]);
  });

  it("FOREIGN data with a late void row (not writable by this build): day A unchanged; day B flags it with NO money effect", () => {
    const sale = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...X2 });
    const before = dm.day(DAY1);
    // Written directly, the way an older or foreign build might have: a void dated two days later.
    h.db.prepare("INSERT INTO voids (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at) VALUES ('v-late', ?, 'cashier-01', 'Cashier One', 'foreign late void', ?, '2026-10-06T09:00:00.000Z')").run(sale.sale.id, DAY2);
    h.clock.set("2026-10-06T09:00:00.000Z");
    expect(dm.day(DAY1)).toEqual(before);
    const b = dm.day(DAY2);
    expect(b.lateVoids).toEqual([{ saleId: sale.sale.id, saleDate: DAY1, totalMinor: 500n, currency: "USD" }]);
    expect([b.moneyIn.totalMinor, b.moneyOut.totalMinor, b.sales.count]).toEqual([0n, 0n, 0]);
  });
});

describe("F2 — a voided sale is not a refund; money is never invented", () => {
  it("CASH sale voided, money not handed back: revenue drops, money received stays, no cash out", () => {
    const sale = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...X2 });
    h.service.voidSale(sale.sale.id, "wrong item rung up");
    const r = dm.day(DAY1);
    expect([r.sales.revenueMinor, r.sales.voidedTotalMinor]).toEqual([0n, 500n]);
    expect([r.sales.received.byChannel.cash, r.sales.voidedReceived.byChannel.cash]).toEqual([0n, 500n]);
    expect(r.moneyIn.byChannel.cash).toBe(500n);
    expect([r.moneyOut.totalMinor, r.refunds.count]).toEqual([0n, 0]);
    expect(r.net.byChannel.cash).toBe(500n);
  });

  it("WHISH sale voided: the transfer stays received and its reference stays registered; no Whish refund invented", () => {
    const sale = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "external", whish: { reference: "WH-VOID-F2", fundsConfirmed: true }, ...X2 });
    h.service.voidSale(sale.sale.id, "customer changed mind");
    const r = dm.day(DAY1);
    expect([r.sales.voidedReceived.byChannel.whish, r.moneyIn.byChannel.whish, r.moneyOut.byChannel.whish]).toEqual([500n, 500n, 0n]);
    expect(scalar("SELECT count(*) FROM external_references WHERE owner_kind = 'sale_tender' AND legacy = 0")).toBe(1n);
  });

  it("a correction keeps the money with the RECEIVER; the corrector is listed for audit only", () => {
    const c = customer("زبون التصحيح");
    asCashier();
    const x = advance(c.id, 4000n, "whish", "WH-RECV-F2");
    asOwner();
    h.clock.set("2026-10-06T09:00:00.000Z");
    adv.correct({ advanceId: x.id, kind: "replaced", reason: "كان نقداً", channel: "cash", idempotencyKey: newKey() });
    const d2 = dm.day(DAY2);
    const two = d2.byOperator.find((o) => o.operatorId === "cashier-02")!;
    expect([two.corrections.cash, two.corrections.whish]).toEqual([4000n, -4000n]);
    expect(d2.byOperator.find((o) => o.operatorId === "cashier-01")).toBeUndefined();
    expect(d2.correctionsBy).toEqual([{ operatorId: "cashier-01", operatorName: expect.any(String), count: 1 }]);
  });
});

describe("pure fold", () => {
  it("refuses to add two currencies", () => {
    const row = (currency: string) => ({ section: "sale_received" as const, channel: "cash" as const, currency, amountMinor: 1n, operatorId: "o", operatorName: "o", sourceId: currency });
    expect(codeOf(() => buildDailyMoney(DAY1, "USD", [row("USD"), row("LBP")], []))).toBe("MIXED_CURRENCY");
  });
});
