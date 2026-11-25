import { TEST_OWNER_PIN, TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { Db } from "../../src/persistence/db";
import { type Harness, type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * WHISH VOID — OWNER ONLY (DEC-35a, owner's option A, 2026-11-08).
 *
 * Voiding a sale paid by Whish Money is the owner's alone, decided by the SERVICE from the live operator
 * row (the IPC channel was already owner-only for every void; this makes the rule hold below it too).
 * The existing `voids` row is the audit record — who, when, why, which sale — immutable by trigger and
 * UNIQUE per sale, so no migration is needed. A void cancels the sale in this ledger only: the sale, its
 * tender and the registered reference are untouched, so the reference can never be used again, and
 * nothing in the ledger claims the money went back to the customer.
 */

let t: TempDir;
let h: Harness;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

const espresso = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };
const whishSale = (reference: string) =>
  h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "external", whish: { reference, fundsConfirmed: true }, ...espresso } as never).sale;
const cashSale = () => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso } as never).sale;
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "NO ERROR";
};
const voidRows = (db: Db) => db.prepare("SELECT * FROM voids").all() as Record<string, unknown>[];
const tenderOf = (db: Db, saleId: string) => db.prepare("SELECT * FROM sale_tenders WHERE sale_id = ?").all(saleId);
const registry = (db: Db) => db.prepare("SELECT * FROM external_references ORDER BY owner_id").all();
const saleRow = (db: Db, saleId: string) => db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId);
const asCashier = () => h.service.login("cashier-02", TEST_CASHIER_PIN);
const asOwner = () => h.service.login("cashier-01", TEST_OWNER_PIN);

describe("🔴 a cashier cannot void a Whish sale — refused by the service, nothing written", () => {
  it("cashier → NOT_AUTHORIZED; no void row; sale, tender and reference untouched", () => {
    const sale = whishSale("WH-VOID-1");
    const before = { sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id), refs: registry(h.db) };
    asCashier();
    expect(codeOf(() => h.service.voidSale(sale.id, "customer cancelled"))).toBe("NOT_AUTHORIZED");
    expect(voidRows(h.db)).toEqual([]);
    expect({ sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id), refs: registry(h.db) }).toEqual(before);
    expect(h.service.getTodaySales().voidedSalesCount).toBe(0);
  });

  it("the role is read LIVE: an owner demoted to cashier in the durable row is refused at once", () => {
    const sale = whishSale("WH-VOID-2");
    h.db.prepare("UPDATE operators SET role = 'cashier' WHERE id = 'cashier-01'").run();
    expect(codeOf(() => h.service.voidSale(sale.id, "customer cancelled"))).toBe("NOT_AUTHORIZED");
    expect(voidRows(h.db)).toEqual([]);
  });

  it("through the IPC bridge too (the channel was already owner-only for every void)", () => {
    const sale = whishSale("WH-VOID-3");
    const ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
    asCashier();
    const res = ipc.voidSale({ saleId: sale.id, reason: "customer cancelled" } as never) as { ok: boolean; error?: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NOT_AUTHORIZED");
    expect(voidRows(h.db)).toEqual([]);
  });

});

describe("🔴 a CASH void is the owner's too (owner decision 2026-11-08)", () => {
  // TRANSITION: this was the INVARIANT "a CASH sale's service rule is unchanged" — a cashier's cash void
  // succeeded at the service (`cashierId` "cashier-02"). Old value: allowed. New: NOT_AUTHORIZED.
  it("cashier → NOT_AUTHORIZED, nothing written; the sale and its tender untouched", () => {
    const sale = cashSale();
    const before = { sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id) };
    asCashier();
    expect(codeOf(() => h.service.voidSale(sale.id, "wrong item"))).toBe("NOT_AUTHORIZED");
    expect(voidRows(h.db)).toEqual([]);
    expect({ sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id) }).toEqual(before);
  });
  it("a demoted owner is refused at once (live role)", () => {
    const sale = cashSale();
    h.db.prepare("UPDATE operators SET role = 'cashier' WHERE id = 'cashier-01'").run();
    expect(codeOf(() => h.service.voidSale(sale.id, "wrong item"))).toBe("NOT_AUTHORIZED");
    expect(voidRows(h.db)).toEqual([]);
  });
  it("no session → NOT_LOGGED_IN before anything is read", () => {
    const sale = cashSale();
    h.service.logout();
    expect(codeOf(() => h.service.voidSale(sale.id, "wrong item"))).toBe("NOT_LOGGED_IN");
  });
  it("the owner voids a cash sale: one audit row, the report nets it out, a second void is refused", () => {
    const sale = cashSale();
    const before = { sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id) };
    const v = h.service.voidSale(sale.id, "wrong item");
    expect(voidRows(h.db)).toEqual([expect.objectContaining({ id: v.id, sale_id: sale.id, cashier_id: "cashier-01", reason: "wrong item" })]);
    expect({ sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id) }).toEqual(before);
    expect(h.service.getTodaySales().netSales.minor).toBe(0n);
    expect(codeOf(() => h.service.voidSale(sale.id, "again"))).toBe("ALREADY_VOIDED");
    expect(voidRows(h.db)).toHaveLength(1);
  });
});

describe("the owner voids a Whish sale — the void row is the full audit record", () => {
  it("who / when / why / which sale are recorded; the sale and its tender are never edited", () => {
    const sale = whishSale("WH-VOID-4");
    const before = { sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id), refs: registry(h.db) };
    const v = h.service.voidSale(sale.id, "  customer cancelled  ");
    const rows = voidRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: v.id, sale_id: sale.id, cashier_id: "cashier-01", reason: "customer cancelled", business_date: sale.businessDate });
    expect(String(rows[0]?.cashier_name).length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(String(rows[0]?.created_at)))).toBe(false);
    expect({ sale: saleRow(h.db, sale.id), tender: tenderOf(h.db, sale.id), refs: registry(h.db) }).toEqual(before);
    const report = h.service.getTodaySales();
    expect(report.voidedSalesCount).toBe(1);
    expect(report.netSales.minor).toBe(0n);
    expect(h.service.getSaleHistory(5)[0]?.sale.externalPayment).toEqual({ provider: "whish", reference: "WH-VOID-4" });
  });

  it("🔴 the reference stays TAKEN after the void — a new Whish sale with it is refused", () => {
    const sale = whishSale("WH-VOID-5");
    h.service.voidSale(sale.id, "customer cancelled");
    const counts = countRows(h.db);
    expect(codeOf(() => whishSale("wh-void-5"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(countRows(h.db)).toEqual(counts);
  });

  it("the reason is mandatory — none / too short is refused before anything is written", () => {
    const sale = whishSale("WH-VOID-6");
    for (const bad of [undefined, "", "  ", "ok"]) {
      expect(codeOf(() => h.service.voidSale(sale.id, bad))).toBe("INVALID_REASON");
    }
    expect(voidRows(h.db)).toEqual([]);
  });

  it("no double void: the second attempt is ALREADY_VOIDED and the first record is unchanged", () => {
    const sale = whishSale("WH-VOID-7");
    h.service.voidSale(sale.id, "customer cancelled");
    const first = voidRows(h.db);
    expect(codeOf(() => h.service.voidSale(sale.id, "again"))).toBe("ALREADY_VOIDED");
    asCashier();
    expect(codeOf(() => h.service.voidSale(sale.id, "again"))).toBe("NOT_AUTHORIZED");
    asOwner();
    expect(voidRows(h.db)).toEqual(first);
  });

  it("the audit record cannot be edited or deleted (immutable by trigger)", () => {
    const sale = whishSale("WH-VOID-8");
    h.service.voidSale(sale.id, "customer cancelled");
    expect(() => h.db.prepare("UPDATE voids SET reason = 'changed'").run()).toThrow();
    expect(() => h.db.prepare("DELETE FROM voids").run()).toThrow();
    expect(voidRows(h.db)[0]?.reason).toBe("customer cancelled");
  });
});
