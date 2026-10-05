/**
 * The IPC handlers are the renderer's entire reach into the main process. These tests drive them
 * with hostile and malformed payloads exactly as the renderer could send them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL_NAMES, createIpcHandlers } from "../../src/main/ipcHandlers";
import { CHANNELS, type IpcResult } from "../../src/shared/ipcContract";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

function setup() {
  const h = makeHarness(t.dbPath, { login: false });
  return { ...h, ipc: createIpcHandlers(h.service) };
}

function errCode(r: IpcResult<unknown>): string {
  if (r.ok) throw new Error(`expected failure, got ${JSON.stringify(r)}`);
  return r.error.code;
}

const goodSale = () => ({
  idempotencyKey: newKey(),
  lines: [{ productId: "prod-0003", quantity: 3 }],
  paymentMethod: "cash",
  expectedTotalMinor: "597",
});

describe("IPC surface", () => {
  it("exposes only the fixed business channels — no SQL, query, file or generic invoke", () => {
    expect(CHANNEL_NAMES.sort()).toEqual(
      [
        "createSale",
        "currentCashier",
        "getCatalog",
        "getSaleHistory",
        "getTodaySales",
        "importCatalog",
        "listCashiers",
        "login",
        "logout",
        "voidSale",
      ].sort(),
    );
    for (const ch of Object.values(CHANNELS)) expect(ch).toMatch(/^pos:[a-zA-Z]+$/);
  });

  it("full flow through the handlers: login → sale → today → void → today", () => {
    const { db, ipc } = setup();
    expect(errCode(ipc.createSale(goodSale()))).toBe("NOT_LOGGED_IN");
    expect(ipc.login({ cashierId: "cashier-02", pin: "2222" })).toEqual({
      ok: true,
      data: { id: "cashier-02", name: "Cashier Two" },
    });

    const created = ipc.createSale(goodSale());
    if (!created.ok) throw new Error(JSON.stringify(created));
    const sale = (created.data as { sale: { id: string; total: unknown; cashierId: string } }).sale;
    expect(sale.total).toEqual({ minor: "597", currency: "USD" });
    expect(sale.cashierId).toBe("cashier-02");

    expect(ipc.getTodaySales(undefined)).toMatchObject({
      ok: true,
      data: { completedSalesCount: 1, netSales: { minor: "597", currency: "USD" } },
    });
    expect(ipc.voidSale({ saleId: sale.id, reason: "rang twice" }).ok).toBe(true);
    expect(ipc.getTodaySales(undefined)).toMatchObject({
      ok: true,
      data: { voidedSalesCount: 1, grossSales: { minor: "597" }, voidTotal: { minor: "597" }, netSales: { minor: "0" } },
    });
    expect(countRows(db)).toEqual({ sales: 1, lines: 1, voids: 1 });
    db.close();
  });

  it("the renderer cannot choose the cashier, price, name or receipt number", () => {
    const { db, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    for (const extra of [
      { cashierId: "cashier-02" },
      { unitPrice: "1" },
      { receiptNumber: 7 },
      { sql: "DELETE FROM sales" },
    ]) {
      expect(errCode(ipc.createSale({ ...goodSale(), ...extra })), JSON.stringify(extra)).toBe("INVALID_INPUT");
    }
    const lineWithPrice = { ...goodSale(), lines: [{ productId: "prod-0003", quantity: 3, unitPrice: "1" }] };
    expect(errCode(ipc.createSale(lineWithPrice))).toBe("INVALID_INPUT");
    expect(countRows(db).sales).toBe(0);
    db.close();
  });

  it("rejects malformed money, quantities and methods", () => {
    const { db, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ expectedTotalMinor: 597 }, "INVALID_INPUT"], // a number, not a string
      [{ expectedTotalMinor: "5.97" }, "INVALID_INPUT"],
      [{ expectedTotalMinor: "-597" }, "INVALID_INPUT"],
      [{ expectedTotalMinor: "5e2" }, "INVALID_INPUT"],
      [{ expectedTotalMinor: "596" }, "TOTAL_MISMATCH"],
      [{ paymentMethod: "crypto" }, "INVALID_PAYMENT_METHOD"],
      [{ lines: [] }, "INVALID_INPUT"],
      [{ lines: [{ productId: "prod-0003", quantity: 1.5 }] }, "INVALID_INPUT"],
      [{ lines: [{ productId: "prod-0003", quantity: "3" }] }, "INVALID_INPUT"],
      [{ lines: [{ productId: "prod-0003", quantity: -3 }] }, "INVALID_QUANTITY"],
      [{ lines: [{ productId: "x' OR 1=1 --", quantity: 1 }], expectedTotalMinor: "0" }, "UNKNOWN_PRODUCT"],
      [{ idempotencyKey: "short" }, "INVALID_INPUT"],
    ];
    for (const [patch, code] of cases) {
      expect(errCode(ipc.createSale({ ...goodSale(), ...patch })), JSON.stringify(patch)).toBe(code);
    }
    expect(errCode(ipc.createSale(null))).toBe("INVALID_INPUT");
    expect(errCode(ipc.createSale("DROP TABLE sales"))).toBe("INVALID_INPUT");
    expect(errCode(ipc.getTodaySales({ date: "2020-01-01" }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.getSaleHistory({ limit: 100000 }))).toBe("INVALID_INPUT");
    expect(countRows(db).sales).toBe(0);
    db.close();
  });

  it("an unexpected internal failure is reported generically, not leaked", () => {
    const { db, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    db.close(); // force a non-domain error inside the service
    const r = ipc.getTodaySales(undefined);
    expect(r).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Unexpected error — the sale was not recorded" },
    });
  });
});
