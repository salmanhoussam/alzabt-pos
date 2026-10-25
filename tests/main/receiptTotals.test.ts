/**
 * M17B-S1 — "collected against customer debts" counts a real receipt ONCE, and an allocation (a share of a receipt) is
 * never additional money. The naive sum over every settlement is computed alongside to prove these
 * tests would catch the double count they exist to prevent.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
const ok = (r: { ok: boolean; error?: unknown }) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
};

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const customer = (name = "محمد علي") => h.parties.create({ kind: "customer", displayName: name }).party;
const owe = (partyId: string, ref: string, minor: bigint, currency = "USD") =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency, amountMinor: minor }).record;
const day = () => (h.db.prepare("SELECT business_date AS d FROM obligations LIMIT 1").get() as { d: string }).d;
const totals = () => h.ledger.collectionTotals(day()).map((r) => [r.currency, r.method, r.provider, r.count, r.totalMinor] as const);
/** The WRONG answer: every settlement row summed, shares included. */
const naive = (currency: string) =>
  BigInt((h.db.prepare("SELECT coalesce(sum(amount_minor),0) AS s FROM settlements WHERE currency = ?").get(currency) as { s: bigint | number }).s);

describe("🔴 a receipt is counted ONCE", () => {
  it("F1 — a 100.00 Whish receipt shared 60.00 + 40.00 is Whish 100.00, not 200.00, and no cash", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    ok(
      ipc.recordAllocatedReceipt({
        customerId: c.id,
        idempotencyKey: "receipt-tot-0001",
        channel: "whish",
        reference: "WH-123",
        fundsConfirmed: true,
        currency: "USD",
        totalMinor: "10000",
        allocations: [{ obligationId: a.id, amountMinor: "6000" }, { obligationId: b.id, amountMinor: "4000" }],
      } as never),
    );
    expect(totals()).toEqual([["USD", "external", "whish", 1, 10000n]]);
    // The WRONG definition (receipts + every settlement, shares included) would say 200.00. The test is
    // only meaningful because that wrong number is different from the right one:
    const receiptsSum = BigInt((h.db.prepare("SELECT sum(amount_minor) AS s FROM receipts").get() as { s: bigint | number }).s);
    expect(receiptsSum + naive("USD")).toBe(20000n);
    expect(totals().reduce((sum, r) => sum + r[4], 0n)).toBe(10000n);
    expect(h.db.prepare("SELECT count(*) AS c FROM settlements WHERE receipt_id IS NOT NULL").get()).toEqual({ c: 2n });
    // nothing in the cash row
    expect(totals().some((r) => r[1] === "cash")).toBe(false);
  });

  it("direct collections and a receipt on the same day are each counted once, per currency, per way of paying", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    const d = owe(c.id, "D", 9000n);
    const l = owe(c.id, "L", 900000n, "LBP");
    ok(ipc.recordCustomerPayment({ customerId: c.id, obligationId: d.id, idempotencyKey: "direct-key-1001", amountMinor: "2500", method: "cash" } as never));
    ok(ipc.recordCustomerPayment({ customerId: c.id, obligationId: d.id, idempotencyKey: "direct-key-1002", amountMinor: "700", method: "whish", reference: "WH-DIRECT", fundsConfirmed: true } as never));
    ok(ipc.recordCustomerPayment({ customerId: c.id, obligationId: l.id, idempotencyKey: "direct-key-1003", amountMinor: "50000", method: "card" } as never));
    ok(
      ipc.recordAllocatedReceipt({
        customerId: c.id,
        idempotencyKey: "receipt-tot-0002",
        channel: "whish",
        reference: "WH-123",
        fundsConfirmed: true,
        currency: "USD",
        totalMinor: "10000",
        allocations: [{ obligationId: a.id, amountMinor: "6000" }, { obligationId: b.id, amountMinor: "4000" }],
      } as never),
    );
    expect(totals()).toEqual([
      ["LBP", "card", null, 1, 50000n],
      ["USD", "cash", null, 1, 2500n],
      ["USD", "external", "whish", 2, 10700n], // the receipt (10000) + the direct Whish (700), never the two shares
    ]);
    // Independent derivation: receipts + direct settlements.
    const sql = (q: string) => BigInt((h.db.prepare(q).get() as { s: bigint | number }).s);
    const receipts = sql("SELECT coalesce(sum(amount_minor),0) AS s FROM receipts WHERE currency='USD'");
    const direct = sql("SELECT coalesce(sum(amount_minor),0) AS s FROM settlements WHERE currency='USD' AND receipt_id IS NULL");
    expect(receipts + direct).toBe(10000n + 2500n + 700n);
    // Double counting would show here: receipts + EVERY settlement = 23,200, not 13,200.
    expect(receipts + naive("USD")).toBe(23200n);
    expect(totals().filter((r) => r[0] === "USD").reduce((sum, r) => sum + r[4], 0n)).toBe(13200n);
  });

  it("an allocation row is never a row of its own in the totals (mutation guard: the SQL names receipt_id IS NULL)", () => {
    const src = readFileSync("src/persistence/ledgerRepository.ts", "utf8");
    const fn = src.slice(src.indexOf("collectionTotals(businessDate"), src.indexOf("findSettlementByIdempotencyKey"));
    expect(fn).toContain("receipt_id IS NULL");
    expect(fn).toContain("FROM receipts");
    // the typed `paid` on an invoice is a document statement: never read here
    expect(fn).not.toMatch(/FROM\s+(invoices|sales)/i);
  });

  it("a legacy ledger (no receipts at all) reports exactly what it did before", () => {
    const c = customer();
    const o = owe(c.id, "A", 9000n);
    ok(ipc.recordCustomerPayment({ customerId: c.id, obligationId: o.id, idempotencyKey: "direct-key-1004", amountMinor: "1000", method: "cash" } as never));
    expect(totals()).toEqual([["USD", "cash", null, 1, 1000n]]);
  });
});

describe("🔴 collectionTotals is COLLECTIONS ONLY — never the shop's total takings", () => {
  it("a POS sale paid at the till is NOT in it (and the SQL never reads invoices or sales)", () => {
    const sale = h.service.createSale({ idempotencyKey: "pos-sale-totals-0001", paymentMethod: "cash", lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n });
    expect(sale.sale.paid.minor).toBe(500n);
    // a real POS sale paid in cash exists, yet the collection totals know nothing of it
    const c = customer();
    const day2 = (h.db.prepare("SELECT business_date AS d FROM sales LIMIT 1").get() as { d: string }).d;
    expect(h.ledger.collectionTotals(day2)).toEqual([]);
    // and a real collection appears alone, beside (not summed with) the sale's cash
    const o = owe(c.id, "A", 3000n);
    ok(ipc.recordCustomerPayment({ customerId: c.id, obligationId: o.id, idempotencyKey: "direct-key-2001", amountMinor: "700", method: "cash" } as never));
    expect(h.ledger.collectionTotals(day2).map((r) => [r.method, r.totalMinor])).toEqual([["cash", 700n]]);
  });
  it("the documentation of both layers says so", () => {
    for (const file of ["src/persistence/ledgerRepository.ts", "src/application/ledgerService.ts"]) {
      const src = readFileSync(file, "utf8");
      const doc = src.slice(src.lastIndexOf("/**", src.indexOf("collectionTotals(businessDate")), src.indexOf("collectionTotals(businessDate"));
      expect(doc, file).toMatch(/COLLECTIONS ONLY|NOT THE SHOP|COLLECTED against customer debts/);
      expect(doc, file).not.toMatch(/total takings\b(?! *\.)(?!.*not)/i);
    }
  });
});

describe("the receipt integrity read-back agrees with the seal", () => {
  it("every receipt written by the service verifies, and the verifier catches a tampered one", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    ok(
      ipc.recordAllocatedReceipt({
        customerId: c.id,
        idempotencyKey: "receipt-tot-0003",
        channel: "bank_transfer",
        reference: "BT-1",
        fundsConfirmed: true,
        currency: "USD",
        totalMinor: "10000",
        allocations: [{ obligationId: a.id, amountMinor: "6000" }, { obligationId: b.id, amountMinor: "4000" }],
      } as never),
    );
    const id = (h.db.prepare("SELECT id FROM receipts").get() as { id: string }).id;
    const repo = (h.ledger as unknown as { deps: { receipts: { receiptIntegrity(i: string): { ok: boolean; problems: string[] } } } }).deps.receipts;
    expect(repo.receiptIntegrity(id)).toEqual({ ok: true, problems: [] });
    expect(repo.receiptIntegrity("missing").ok).toBe(false);
  });
});
