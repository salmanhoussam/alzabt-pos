import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * SELL-PARTIAL-DEBT (owner, 2026-11-08) through the REAL bridge: `downPayment` is the ONE optional key of
 * the owner-only `createCustomerCreditSale` channel. The service rules are in partialDebtSale.test.ts;
 * this file proves what the renderer can and cannot send, that a cashier is stopped at the channel, and
 * that the debt then lives like any other: on the statement, collected later in cash or Whish.
 */

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

type R = { ok: boolean; data?: any; error?: { code: string } };
const code = (r: unknown) => ((r as R).ok ? "OK" : (r as R).error!.code);
const n = (table: string) => Number((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
const footprint = () => ({ sales: n("sales"), tenders: n("sale_tenders"), obligations: n("obligations"), settlements: n("settlements") });
const customer = () => h.parties.create({ kind: "customer", displayName: "زبون جزئي" }).party;
const espresso = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: "500" };
const onAccount = (customerId: string, downPayment?: unknown, key = newKey()) =>
  ipc.createCustomerCreditSale({ idempotencyKey: key, customerId, ...espresso, ...(downPayment === undefined ? {} : { downPayment }) } as never) as R;

describe("the bridge carries the money received now", () => {
  it("cash 2.00 of 5.00: a partial sale, 3.00 on the statement, then collected in cash → fully paid", () => {
    const c = customer();
    const r = onAccount(c.id, { amountMinor: "200", method: "cash" });
    expect(r.ok).toBe(true);
    expect(r.data.sale.paymentStatus).toBe("partial");
    expect(r.data.sale.paid.minor).toBe("200");
    expect(r.data.sale.balanceDue.minor).toBe("300");
    expect(footprint()).toEqual({ sales: 1, tenders: 1, obligations: 1, settlements: 0 });

    let st = (ipc.getCustomerStatement({ customerId: c.id }) as R).data;
    expect(st.obligations).toHaveLength(1);
    expect(st.obligations[0].outstanding.minor).toBe("300");
    const pay = ipc.recordCustomerPayment({ customerId: c.id, obligationId: r.data.obligationId, idempotencyKey: newKey(), amountMinor: "300", method: "cash" } as never);
    expect(code(pay)).toBe("OK");
    st = (ipc.getCustomerStatement({ customerId: c.id }) as R).data;
    expect(st.obligations[0].fullyPaid).toBe(true);
  });

  it("Whish 1.50 of 5.00 with its reference: the debt is 3.50 and is collectable later by Whish too", () => {
    const c = customer();
    const r = onAccount(c.id, { amountMinor: "150", method: "external", whish: { reference: "WH-IPC-1", fundsConfirmed: true } });
    expect(r.ok).toBe(true);
    expect(r.data.sale.externalPayment).toEqual(expect.objectContaining({ provider: "whish", reference: "WH-IPC-1" }));
    const st = (ipc.getCustomerStatement({ customerId: c.id }) as R).data;
    expect(st.obligations[0].outstanding.minor).toBe("350");
    const pay = ipc.recordCustomerPayment({
      customerId: c.id,
      obligationId: r.data.obligationId,
      idempotencyKey: newKey(),
      amountMinor: "350",
      method: "whish",
      reference: "WH-IPC-2",
      fundsConfirmed: true,
    } as never);
    expect(code(pay)).toBe("OK");
  });

  it("the same key replays the same sale through the bridge (a double click)", () => {
    const c = customer();
    const key = newKey();
    const a = onAccount(c.id, { amountMinor: "200", method: "cash" }, key);
    const b = onAccount(c.id, { amountMinor: "200", method: "cash" }, key);
    expect(b.data.duplicate).toBe(true);
    expect(b.data.sale.id).toBe(a.data.sale.id);
    expect(footprint()).toEqual({ sales: 1, tenders: 1, obligations: 1, settlements: 0 });
  });
});

describe("🔴 what the renderer cannot send — and nothing is written", () => {
  it("downPayment is exactly { amountMinor, method } (+ whish): no extra key, no other method word, no float", () => {
    const c = customer();
    for (const bad of [
      { amountMinor: "200", method: "cash", paidMinor: "200" },
      { amountMinor: "200" },
      { method: "cash" },
      { amountMinor: "200", method: "whish" },
      { amountMinor: "200", method: "card" },
      { amountMinor: 200, method: "cash" },
      { amountMinor: "2.00", method: "cash" },
      { amountMinor: "200", method: "external", whish: { reference: "WH-1", fundsConfirmed: true, extra: 1 } },
      "200",
      null,
    ]) {
      expect(code(onAccount(c.id, bad))).toBe("INVALID_INPUT");
    }
    expect(footprint()).toEqual({ sales: 0, tenders: 0, obligations: 0, settlements: 0 });
  });

  it("the amount rules come back as their own codes", () => {
    const c = customer();
    expect(code(onAccount(c.id, { amountMinor: "0", method: "cash" }))).toBe("DOWN_PAYMENT_INVALID");
    expect(code(onAccount(c.id, { amountMinor: "500", method: "cash" }))).toBe("DOWN_PAYMENT_NOT_PARTIAL");
    expect(code(onAccount(c.id, { amountMinor: "900", method: "cash" }))).toBe("DOWN_PAYMENT_NOT_PARTIAL");
    expect(footprint().sales).toBe(0);
  });

  it("a cashier is refused at the channel, with or without money received", () => {
    const c = customer();
    h.service.login("cashier-02", "2222");
    expect(code(onAccount(c.id, { amountMinor: "200", method: "cash" }))).toBe("NOT_AUTHORIZED");
    expect(code(onAccount(c.id))).toBe("NOT_AUTHORIZED");
    expect(footprint()).toEqual({ sales: 0, tenders: 0, obligations: 0, settlements: 0 });
  });
});
