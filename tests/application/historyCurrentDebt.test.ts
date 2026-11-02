/**
 * HIST-CURRENT-BALANCE (ACC-3): the OWNER's sale history shows, next to the sale's own snapshot, what
 * is CURRENTLY owed on the debt that sale posted. Through the REAL service, IPC handlers and SQLite.
 * Synthetic data.
 *
 * 🔴 WHAT MUST HOLD, AND WHY EACH ASSERTION IS HERE:
 *   - the sale's `paymentStatus` / `balanceDue` and its stored row are NEVER rewritten by a payment;
 *   - the current figure is the ledger's (`amount − settlements`), the same as the statement's;
 *   - a sale that posted no debt says so (null) — it is never shown as owing 0;
 *   - a CASHIER's response carries no current-debt key at all: main leaves it out, nothing is hidden.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { priceCart } from "../../src/domain/cart";
import { DomainError } from "../../src/domain/errors";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { CustomerStatementDto, SaleWithVoidDto } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const LINES = [{ productId: "prod-0001", quantityMilli: 2000 }] as const;
const total = () => priceCart(h.service.getCatalog(), LINES).total.minor;
let n = 0;
const key = () => `acc3-key-${String(++n).padStart(6, "0")}`;
const customer = (displayName = "زبون عليه دين") => h.parties.create({ kind: "customer", displayName }).party;
const credit = (customerId: string) =>
  h.service.createCustomerCreditSale({ idempotencyKey: key(), customerId, lines: LINES, expectedTotalMinor: total() }).sale;
const cash = (customerId?: string) =>
  h.service.createSale({ idempotencyKey: key(), lines: LINES, paymentMethod: "cash", expectedTotalMinor: total(), customerId }).sale;
const history = (): SaleWithVoidDto[] => {
  const r = ipc.getSaleHistory({ limit: 50 }) as { ok: true; data: SaleWithVoidDto[] } | { ok: false; error: { code: string } };
  if (!r.ok) throw new Error(`history refused: ${r.error.code}`);
  return r.data;
};
const entry = (saleId: string) => {
  const e = history().find((x) => x.sale.id === saleId);
  if (!e) throw new Error("sale not in history");
  return e;
};
const statement = (id: string) => {
  const r = ipc.getCustomerStatement({ customerId: id }) as { ok: true; data: CustomerStatementDto } | { ok: false; error: { code: string } };
  if (!r.ok) throw new Error(`statement refused: ${r.error.code}`);
  return r.data;
};
const obligationOf = (customerId: string, saleId: string) => statement(customerId).obligations.find((o) => o.saleId === saleId)!;
const pay = (customerId: string, obligationId: string, amountMinor: string, k = key()) => {
  const r = ipc.recordCustomerPayment({ customerId, obligationId, idempotencyKey: k, amountMinor, method: "cash" } as never) as {
    ok: boolean;
    error?: { code: string };
  };
  if (!r.ok) throw new Error(`payment refused: ${r.error?.code}`);
};
const saleRow = (id: string) => h.db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : `not-a-domain-error: ${String(e)}`;
  }
};

describe("the owner sees the CURRENT debt next to the sale's own snapshot", () => {
  it("an unpaid credit sale: current = the whole debt, snapshot = unpaid with the whole balance", () => {
    const c = customer();
    const sale = credit(c.id);
    const e = entry(sale.id);
    const t0 = total().toString();
    expect(e.sale.paymentStatus).toBe("unpaid");
    expect(e.sale.balanceDue.minor).toBe(t0);
    expect(e.currentDebt).toEqual({
      amount: { minor: t0, currency: e.sale.total.currency },
      outstanding: { minor: t0, currency: e.sale.total.currency },
      fullyPaid: false,
    });
  });

  it("🔴 partial, then successive, then full settlement move ONLY the current figure — the sale is never rewritten", () => {
    const c = customer();
    const sale = credit(c.id);
    const before = saleRow(sale.id);
    const ob = obligationOf(c.id, sale.id);
    const whole = total();
    const part = whole / 4n;

    pay(c.id, ob.id, part.toString());
    expect(entry(sale.id).currentDebt).toMatchObject({ outstanding: { minor: (whole - part).toString() }, fullyPaid: false });
    pay(c.id, ob.id, part.toString());
    expect(entry(sale.id).currentDebt).toMatchObject({ outstanding: { minor: (whole - 2n * part).toString() }, fullyPaid: false });
    pay(c.id, ob.id, (whole - 2n * part).toString());
    const settled = entry(sale.id);
    expect(settled.currentDebt).toMatchObject({ outstanding: { minor: "0" }, fullyPaid: true, amount: { minor: whole.toString() } });

    // 🔴 the historical snapshot: still "unpaid" with the original balance, in the DTO AND in the stored row
    expect(settled.sale.paymentStatus).toBe("unpaid");
    expect(settled.sale.balanceDue.minor).toBe(whole.toString());
    expect(saleRow(sale.id)).toEqual(before);
  });

  it("the current figure is the statement's own figure for that debt", () => {
    const c = customer();
    const sale = credit(c.id);
    pay(c.id, obligationOf(c.id, sale.id).id, "100");
    expect(entry(sale.id).currentDebt?.outstanding).toEqual(obligationOf(c.id, sale.id).outstanding);
  });

  it("a shared receipt across two credit sales is reflected on BOTH, and replaying its key changes nothing", () => {
    const c = customer();
    const s1 = credit(c.id);
    const s2 = credit(c.id);
    const o1 = obligationOf(c.id, s1.id);
    const o2 = obligationOf(c.id, s2.id);
    const req = {
      customerId: c.id,
      idempotencyKey: "acc3-receipt-0001",
      channel: "whish",
      reference: "WH-ACC3-1",
      fundsConfirmed: true,
      currency: o1.amount.currency,
      totalMinor: "300",
      allocations: [
        { obligationId: o1.id, amountMinor: "200" },
        { obligationId: o2.id, amountMinor: "100" },
      ],
    };
    expect((ipc.recordAllocatedReceipt(req as never) as { ok: boolean }).ok).toBe(true);
    const whole = total();
    expect(entry(s1.id).currentDebt?.outstanding.minor).toBe((whole - 200n).toString());
    expect(entry(s2.id).currentDebt?.outstanding.minor).toBe((whole - 100n).toString());
    // 🔴 the same receipt again (same key): recognised as a duplicate, nothing settled twice
    expect((ipc.recordAllocatedReceipt(req as never) as { ok: boolean }).ok).toBe(true);
    expect(entry(s1.id).currentDebt?.outstanding.minor).toBe((whole - 200n).toString());
    expect(entry(s2.id).currentDebt?.outstanding.minor).toBe((whole - 100n).toString());
  });

  it("🔴 a sale that posted no debt says so — null, never 'owes 0': a cash sale, a linked paid sale, a voided sale", () => {
    const c = customer();
    const plain = cash();
    const linked = cash(c.id);
    const voided = cash();
    h.service.voidSale(voided.id, "wrong item rung up");
    for (const id of [plain.id, linked.id, voided.id]) {
      const e = entry(id);
      expect("currentDebt" in e).toBe(true);
      expect(e.currentDebt).toBeNull();
    }
  });

  it("reading history changes nothing: the statement and every sale row are identical before and after", () => {
    const c = customer();
    const sale = credit(c.id);
    pay(c.id, obligationOf(c.id, sale.id).id, "50");
    cash(c.id);
    const statementBefore = statement(c.id);
    const salesBefore = h.db.prepare("SELECT * FROM sales ORDER BY id").all();
    history();
    history();
    expect(statement(c.id)).toEqual(statementBefore);
    expect(h.db.prepare("SELECT * FROM sales ORDER BY id").all()).toEqual(salesBefore);
  });
});

describe("🔴 a cashier receives no current-debt data at all", () => {
  it("the IPC response has NO currentDebt key on any entry — not null, not hidden: absent", () => {
    const c = customer();
    const sale = credit(c.id);
    pay(c.id, obligationOf(c.id, sale.id).id, "100");
    cash();
    h.service.logout();
    h.service.login("cashier-02", "2222");
    const rows = history();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["sale", "void"]);
      expect(JSON.stringify(r)).not.toContain("currentDebt");
    }
    // the cashier still sees the sale's own snapshot, exactly as before ACC-3
    expect(rows.find((r) => r.sale.id === sale.id)?.sale.paymentStatus).toBe("unpaid");
  });

  it("the service answers null for a cashier, and the ledger read itself refuses them", () => {
    const c = customer();
    const sale = credit(c.id);
    h.service.logout();
    h.service.login("cashier-02", "2222");
    expect(h.service.currentDebtsForHistory([sale.id])).toBeNull();
    expect(code(() => h.ledger.currentSaleDebts([sale.id]))).toBe("NOT_AUTHORIZED");
    // and nothing new was opened to them: the statement stays owner-only
    expect((ipc.getCustomerStatement({ customerId: c.id }) as { ok: boolean }).ok).toBe(false);
  });

  it("the owner signing back in sees the current figure again (decided per request, from the session)", () => {
    const c = customer();
    const sale = credit(c.id);
    h.service.logout();
    h.service.login("cashier-02", "2222");
    expect("currentDebt" in entry(sale.id)).toBe(false);
    h.service.logout();
    h.service.login("cashier-01", "1111");
    expect(entry(sale.id).currentDebt?.fullyPaid).toBe(false);
  });
});

describe("one query for the page", () => {
  it("the ledger repository reads every listed sale's debt in one call and ignores sales with none", () => {
    const c = customer();
    const a = credit(c.id);
    const b = credit(c.id);
    const p = cash();
    const found = h.ledger.currentSaleDebts([a.id, b.id, p.id]);
    expect([...found.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(h.ledger.currentSaleDebts([]).size).toBe(0);
  });
});
