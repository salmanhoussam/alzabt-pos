import { TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * SELL-CREDIT (owner, 2026-11-08): a sale on a customer's account from the till, through the REAL bridge.
 *
 * A debt, never a payment: one sale (unpaid), its lines and ONE receivable for the full total, in one
 * transaction; no tender row; OWNER ONLY at the channel and in the service (live role); the customer must
 * be an active customer; the same key replays and never doubles. The debt is then collected like any
 * other — cash or Whish — and the statement shows it. The service itself is covered in creditSale.test.ts
 * (atomicity, rollback, repricing, live-role races); this file proves the CHANNEL that now exposes it.
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
const footprint = () => ({ sales: n("sales"), lines: n("sale_lines"), tenders: n("sale_tenders"), obligations: n("obligations"), settlements: n("settlements") });
const customer = (name = "زبون على الحساب") => h.parties.create({ kind: "customer", displayName: name }).party;
const espresso = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: "500" };
const onAccount = (customerId: string, key = newKey(), extra: Record<string, unknown> = {}) =>
  ipc.createCustomerCreditSale({ idempotencyKey: key, customerId, ...espresso, ...extra } as never) as R;

describe("the owner sells on a customer's account from the till", () => {
  it("one unpaid sale + ONE receivable equal to the total, linked to sale and customer; NO payment record", () => {
    const c = customer();
    const r = onAccount(c.id);
    expect(r.ok).toBe(true);
    const sale = r.data.sale;
    expect(sale.paymentStatus).toBe("unpaid");
    expect(sale.paymentMethod).toBeNull();
    expect(sale.paid.minor).toBe("0");
    expect(sale.balanceDue.minor).toBe("500");
    expect(r.data.duplicate).toBe(false);
    expect(footprint()).toEqual({ sales: 1, lines: 1, tenders: 0, obligations: 1, settlements: 0 });
    const o = h.db.prepare("SELECT party_id AS p, amount_minor AS a, source_kind AS k, source_ref AS s, direction AS d FROM obligations").get() as Record<string, unknown>;
    expect({ ...o, a: Number(o.a) }).toMatchObject({ p: c.id, a: 500, d: "receivable", s: sale.id });
    expect(r.data.obligationId).toBeTruthy();
  });

  it("the debt is on the customer's statement and is collected later in cash — then fully paid", () => {
    const c = customer();
    const r = onAccount(c.id);
    let st = (ipc.getCustomerStatement({ customerId: c.id }) as R).data;
    expect(st.obligations).toHaveLength(1);
    expect(st.obligations[0].outstanding.minor).toBe("500");
    expect(st.paidSales).toEqual([]); // a credit sale is a debt, never "paid activity"
    const pay = ipc.recordCustomerPayment({ customerId: c.id, obligationId: r.data.obligationId, idempotencyKey: newKey(), amountMinor: "500", method: "cash" } as never);
    expect(code(pay)).toBe("OK");
    st = (ipc.getCustomerStatement({ customerId: c.id }) as R).data;
    expect(st.obligations[0].fullyPaid).toBe(true);
  });

  it("🔴 a double click / lost reply: the same key replays the SAME sale and debt, nothing doubled", () => {
    const c = customer();
    const key = newKey();
    const first = onAccount(c.id, key);
    const again = onAccount(c.id, key);
    expect(again.ok).toBe(true);
    expect(again.data.duplicate).toBe(true);
    expect(again.data.sale.id).toBe(first.data.sale.id);
    expect(again.data.obligationId).toBe(first.data.obligationId);
    expect(footprint()).toMatchObject({ sales: 1, obligations: 1 });
  });
});

describe("🔴 refused — and a refusal writes nothing", () => {
  it("a cashier: refused at the channel; the service refuses them too", () => {
    const c = customer();
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect(code(onAccount(c.id))).toBe("NOT_AUTHORIZED");
    expect(() => h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, lines: espresso.lines, expectedTotalMinor: 500n })).toThrow(/owner/i);
    expect(footprint()).toEqual({ sales: 0, lines: 0, tenders: 0, obligations: 0, settlements: 0 });
  });

  it("the role is read live: an owner demoted in the durable row is refused at once", () => {
    const c = customer();
    h.db.prepare("UPDATE operators SET role = 'cashier' WHERE id = 'cashier-01'").run();
    expect(code(onAccount(c.id))).toBe("NOT_AUTHORIZED");
    expect(footprint().sales).toBe(0);
  });

  it("an archived customer, an unknown id, a supplier → PARTY_NOT_FOUND", () => {
    const archived = customer("زبون مؤرشف");
    h.partyStore.update(archived.id, { isActive: false }, h.clock.now().toISOString());
    const supplier = h.parties.create({ kind: "supplier", displayName: "مورّد" }).party;
    for (const id of [archived.id, "no-such-customer", supplier.id]) expect(code(onAccount(id))).toBe("PARTY_NOT_FOUND");
    expect(footprint().sales).toBe(0);
  });

  it("the bridge accepts exactly its four keys: no method, no paid amount, no name snapshot", () => {
    const c = customer();
    for (const extra of [{ paymentMethod: "cash" }, { paidMinor: "100" }, { customerNameSnapshot: "x" }]) {
      expect(code(onAccount(c.id, newKey(), extra))).toBe("INVALID_INPUT");
    }
    expect(code(ipc.createCustomerCreditSale({ idempotencyKey: newKey(), ...espresso } as never))).toBe("INVALID_INPUT");
    expect(footprint().sales).toBe(0);
  });

  it("a total that does not match today's prices is refused (main re-prices)", () => {
    const c = customer();
    expect(code(onAccount(c.id, newKey(), { expectedTotalMinor: "499" }))).not.toBe("OK");
    expect(footprint().sales).toBe(0);
  });
});
