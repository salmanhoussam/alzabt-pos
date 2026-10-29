/**
 * M17B-S1 — ONE real Whish/bank receipt shared across TWO OR MORE debts of ONE customer.
 *
 * Through the real IPC handlers, the real services and a real SQLite ledger (synthetic data only).
 * Every refusal asserts that NOTHING was written, and the money-received arithmetic is checked in
 * receiptTotals.test.ts. `amountMinor` is MINOR units: "6000" is 60.00.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { COUNTED_TABLES, snapshotDatabase } from "../../src/persistence/backup";
import type { AllocatedReceiptResponse, CustomerStatementDto, RecordPaymentResponse } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";
import { openDatabase } from "../../src/persistence/db";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;

const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code);

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
const n = (table: string, where = "1=1") => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
const receiptReq = (
  c: { id: string },
  key: string,
  total: string,
  shares: Array<[string, string]>,
  over: Record<string, unknown> = {},
) => ({
  customerId: c.id,
  idempotencyKey: key,
  channel: "whish",
  reference: "WH-123",
  fundsConfirmed: true,
  currency: "USD",
  totalMinor: total,
  allocations: shares.map(([obligationId, amountMinor]) => ({ obligationId, amountMinor })),
  ...over,
});
const send = (r: unknown) => ipc.recordAllocatedReceipt(r as never);
const statement = (c: { id: string }) => ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
const outstanding = (c: { id: string }, id: string) => statement(c).obligations.find((o) => o.id === id)!.outstanding;

/** Nothing money-related changed. */
function snapshotCounts() {
  return { receipts: n("receipts"), settlements: n("settlements"), obligations: n("obligations"), sales: n("sales"), invoices: n("invoices") };
}

describe("the happy path — USD (60.00 + 40.00 = 100.00, one Whish receipt)", () => {
  it("🔴 records ONE receipt, TWO allocations, settles both debts and creates no debt", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    const before = snapshotCounts();
    const r = ok<AllocatedReceiptResponse>(send(receiptReq(c, "receipt-key-0001", "10000", [[a.id, "6000"], [b.id, "4000"]])));
    expect(r.duplicate).toBe(false);
    expect(r.receipt).toMatchObject({ total: { minor: "10000", currency: "USD" }, provider: "whish", reference: "WH-123", allocationCount: 2 });
    expect(n("receipts")).toBe(1);
    expect(n("settlements", "receipt_id IS NOT NULL")).toBe(2);
    expect(n("settlements")).toBe(before.settlements + 2);
    // no debt created, nothing about a sale or invoice touched
    expect(n("obligations")).toBe(before.obligations);
    expect(n("sales")).toBe(before.sales);
    expect(n("invoices")).toBe(before.invoices);
    expect(outstanding(c, a.id)).toEqual({ minor: "0", currency: "USD" });
    expect(outstanding(c, b.id)).toEqual({ minor: "0", currency: "USD" });
    // the statement says each settlement is a SHARE of the receipt, with the reference stored once
    const shares = statement(c).obligations.flatMap((o) => o.settlements);
    expect(shares).toHaveLength(2);
    for (const s of shares) {
      expect(s.receipt).toMatchObject({ provider: "whish", reference: "WH-123", total: { minor: "10000", currency: "USD" } });
      expect(s.reference).toBeNull(); // the share carries no reference of its own
      expect(s.provider).toBeNull();
    }
    expect(statement(c).pendingReceipts).toEqual([]);
    expect(h.db.prepare("SELECT resolution FROM receipt_attempts").all()).toEqual([{ resolution: "recorded" }]);
  });

  it("🔴 the same key again is a DUPLICATE: still one receipt, two allocations — never counted twice", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    const body = receiptReq(c, "receipt-key-0002", "10000", [[a.id, "6000"], [b.id, "4000"]]);
    ok(send(body));
    const again = ok<AllocatedReceiptResponse>(send(body));
    expect(again.duplicate).toBe(true);
    expect(n("receipts")).toBe(1);
    expect(n("settlements", "receipt_id IS NOT NULL")).toBe(2);
  });

  it("partial: 80.00 and 50.00 owed, a 100.00 receipt shared 60.00 + 40.00 leaves 20.00 and 10.00", () => {
    const c = customer();
    const a = owe(c.id, "A", 8000n);
    const b = owe(c.id, "B", 5000n);
    ok(send(receiptReq(c, "receipt-key-0003", "10000", [[a.id, "6000"], [b.id, "4000"]], { reference: "WH-124" })));
    expect(outstanding(c, a.id)).toEqual({ minor: "2000", currency: "USD" });
    expect(outstanding(c, b.id)).toEqual({ minor: "1000", currency: "USD" });
  });

  it("LBP stays LBP: a bank transfer of 5,000,000.00 LBP shared 3,000,000.00 + 2,000,000.00; USD debts untouched", () => {
    const c = customer();
    const l1 = owe(c.id, "L1", 300000000n, "LBP");
    const l2 = owe(c.id, "L2", 200000000n, "LBP");
    const usd = owe(c.id, "U", 1234n);
    ok(send(receiptReq(c, "receipt-key-0004", "500000000", [[l1.id, "300000000"], [l2.id, "200000000"]], { channel: "bank_transfer", reference: "BT-77", currency: "LBP" })));
    expect(outstanding(c, l1.id)).toEqual({ minor: "0", currency: "LBP" });
    expect(outstanding(c, l2.id)).toEqual({ minor: "0", currency: "LBP" });
    expect(outstanding(c, usd.id)).toEqual({ minor: "1234", currency: "USD" });
    expect(h.db.prepare("SELECT currency, provider, amount_minor FROM receipts").all()).toEqual([{ currency: "LBP", provider: "bank_transfer", amount_minor: 500000000n }]);
  });
});

describe("🔴 refusals write nothing", () => {
  function refuses(expected: string, mk: () => unknown, extra?: () => void) {
    const before = snapshotCounts();
    extra?.();
    const r = send(mk());
    expect(errCode(r), JSON.stringify(r)).toBe(expected);
    expect(snapshotCounts()).toEqual(before);
  }

  it("the shares do not add up (99.00 vs 100.00 and 101.00 vs 100.00)", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    refuses("RECEIPT_ALLOCATION_MISMATCH", () => receiptReq(c, "receipt-key-0010", "10000", [[a.id, "6000"], [b.id, "3900"]]));
    refuses("RECEIPT_ALLOCATION_MISMATCH", () => receiptReq(c, "receipt-key-0011", "10000", [[a.id, "6000"], [b.id, "4100"]]));
    expect(n("receipt_attempts")).toBe(0); // refused before any intent was written
  });

  it("a single debt cannot use this channel", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    refuses("RECEIPT_NEEDS_TWO_DEBTS", () => receiptReq(c, "receipt-key-0012", "6000", [[a.id, "6000"]]));
  });

  it("the same debt twice", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    refuses("RECEIPT_ALLOCATION_MISMATCH", () => receiptReq(c, "receipt-key-0013", "4000", [[a.id, "2000"], [a.id, "2000"]]));
  });

  it("a share above a debt's outstanding writes NOTHING — not even the share before it", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    const before = snapshotCounts();
    const r = send(receiptReq(c, "receipt-key-0014", "11000", [[a.id, "6000"], [b.id, "5000"]]));
    expect(errCode(r)).toBe("INVALID_AMOUNT");
    expect(snapshotCounts()).toEqual(before);
    expect(outstanding(c, a.id)).toEqual({ minor: "6000", currency: "USD" });
    expect(h.db.prepare("SELECT resolution FROM receipt_attempts").all()).toEqual([{ resolution: "not_recorded" }]);
  });

  it("a USD receipt naming an LBP debt (and the other way round)", () => {
    const c = customer();
    const u = owe(c.id, "U", 6000n);
    const l = owe(c.id, "L", 900000n, "LBP");
    refuses("MIXED_CURRENCY", () => receiptReq(c, "receipt-key-0015", "7000", [[u.id, "6000"], [l.id, "1000"]]));
  });

  it("another customer's debt, a supplier payable and an archived customer", () => {
    const c = customer();
    const other = customer("زبون آخر");
    const a = owe(c.id, "A", 6000n);
    const foreign = owe(other.id, "F", 4000n);
    refuses("INVALID_INPUT", () => receiptReq(c, "receipt-key-0016", "10000", [[a.id, "6000"], [foreign.id, "4000"]]));
    const sup = h.parties.create({ kind: "supplier", displayName: "مورّد" }).party;
    const payable = h.ledger.postObligation({ partyId: sup.id, direction: "payable", sourceKind: "manual", sourceRef: "P", currency: "USD", amountMinor: 4000n }).record;
    refuses("INVALID_INPUT", () => receiptReq(c, "receipt-key-0017", "10000", [[a.id, "6000"], [payable.id, "4000"]]));
    const b = owe(c.id, "B", 4000n);
    h.parties.setActive("customer", c.id, false);
    refuses("PARTY_NOT_FOUND", () => receiptReq(c, "receipt-key-0018", "10000", [[a.id, "6000"], [b.id, "4000"]]));
  });

  it("unconfirmed funds, a missing or card-number-shaped reference, a wrong channel, extra fields", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    const shares: Array<[string, string]> = [[a.id, "6000"], [b.id, "4000"]];
    refuses("FUNDS_NOT_CONFIRMED", () => receiptReq(c, "receipt-key-0019", "10000", shares, { fundsConfirmed: false }));
    refuses("INVALID_INPUT", () => receiptReq(c, "receipt-key-0020", "10000", shares, { reference: "" }));
    refuses("INVALID_INPUT", () => receiptReq(c, "receipt-key-0021", "10000", shares, { reference: "4242 4242 4242 4242" }));
    for (const channel of ["cash", "card", "other"]) {
      refuses("INVALID_INPUT", () => receiptReq(c, "receipt-key-0022", "10000", shares, { channel })); // refused at the bridge
    }
    refuses("INVALID_INPUT", () => receiptReq(c, "receipt-key-0023", "10000", shares, { currencyOverride: "LBP" }));
    refuses("INVALID_INPUT", () => receiptReq(c, "receipt-key-0024", "10000", shares, { allocations: [{ obligationId: a.id, amountMinor: "6000", extra: 1 }, { obligationId: b.id, amountMinor: "4000" }] }));
    // The service refuses the channel too, even called directly.
    expect(() => h.ledger.recordAllocatedReceipt({ customerId: c.id, idempotencyKey: "receipt-key-0025", channel: "cash", reference: null, fundsConfirmed: true, currency: "USD", totalMinor: 10000n, allocations: [{ obligationId: a.id, amountMinor: 6000n }, { obligationId: b.id, amountMinor: 4000n }] })).toThrow(/Whish or bank transfer/);
  });

  it("a zero or negative share, and a non-integer amount", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    for (const bad of ["0", "-100", "10.5", "abc"]) {
      const before = snapshotCounts();
      expect(errCode(send(receiptReq(c, "receipt-key-0026", "10000", [[a.id, "6000"], [b.id, bad]])))).not.toBeNull();
      expect(snapshotCounts()).toEqual(before);
    }
  });

  it("a CASHIER is refused, at the bridge and in the service, and nothing is written", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    h.service.login("cashier-02", "2222");
    const before = snapshotCounts();
    expect(errCode(send(receiptReq(c, "receipt-key-0027", "10000", [[a.id, "6000"], [b.id, "4000"]])))).toBe("NOT_AUTHORIZED");
    expect(() => h.ledger.openReceipts(c.id)).toThrow(/owner/i);
    expect(snapshotCounts()).toEqual(before);
    expect(n("receipt_attempts")).toBe(0);
  });
});

describe("🔴 ONE provider reference is ONE record — receipts and direct collections, both ways", () => {
  it("a receipt cannot reuse a direct M17A collection's reference, nor another receipt's", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    const d = owe(c.id, "D", 9000n);
    const direct = ipc.recordCustomerPayment({ customerId: c.id, obligationId: d.id, idempotencyKey: "direct-key-0001", amountMinor: "500", method: "whish", reference: "WH-D1", fundsConfirmed: true } as never);
    ok<RecordPaymentResponse>(direct);
    const before = snapshotCounts();
    expect(errCode(send(receiptReq(c, "receipt-key-0030", "10000", [[a.id, "6000"], [b.id, "4000"]], { reference: "WH-D1" })))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(snapshotCounts()).toEqual(before);
    ok(send(receiptReq(c, "receipt-key-0031", "10000", [[a.id, "6000"], [b.id, "4000"]], { reference: "WH-NEW" })));
    const e = owe(c.id, "E", 3000n);
    const f = owe(c.id, "F", 3000n);
    expect(errCode(send(receiptReq(c, "receipt-key-0032", "2000", [[e.id, "1000"], [f.id, "1000"]], { reference: "WH-NEW" })))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    // …and the reverse: a direct collection cannot take the receipt's reference
    const dup = ipc.recordCustomerPayment({ customerId: c.id, obligationId: e.id, idempotencyKey: "direct-key-0002", amountMinor: "100", method: "whish", reference: "WH-NEW", fundsConfirmed: true } as never);
    expect(errCode(dup)).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(n("receipts")).toBe(1);
  });

  it("the same reference text under the OTHER provider is a different reference", () => {
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    ok(send(receiptReq(c, "receipt-key-0033", "10000", [[a.id, "6000"], [b.id, "4000"]], { reference: "SAME-1" })));
    const e = owe(c.id, "E", 3000n);
    const f = owe(c.id, "F", 3000n);
    ok(send(receiptReq(c, "receipt-key-0034", "2000", [[e.id, "1000"], [f.id, "1000"]], { reference: "SAME-1", channel: "bank_transfer" })));
    expect(n("receipts")).toBe(2);
  });
});

describe("existing collection behaviour is unchanged", () => {
  it("an M17A direct collection still records one settlement with its own reference, and receipt_id stays NULL", () => {
    const c = customer();
    const o = owe(c.id, "A", 6000n);
    const r = ok<RecordPaymentResponse>(ipc.recordCustomerPayment({ customerId: c.id, obligationId: o.id, idempotencyKey: "direct-key-0003", amountMinor: "1000", method: "whish", reference: "WH-ONLY", fundsConfirmed: true } as never));
    expect(r.settlement).toMatchObject({ provider: "whish", reference: "WH-ONLY" });
    expect(r.settlement).not.toHaveProperty("receipt"); // the direct response shape is unchanged
    expect(n("settlements", "receipt_id IS NULL")).toBe(1);
    expect(n("receipts")).toBe(0);
    expect(statement(c).obligations[0]!.settlements[0]!.receipt).toBeNull();
  });
});

describe("backup coverage", () => {
  it("the three receipt tables are counted, and a snapshot of a ledger with a receipt verifies and restores", () => {
    for (const table of ["receipts", "receipt_attempts", "receipt_attempt_lines"]) expect(COUNTED_TABLES as ReadonlyArray<string>).toContain(table);
    const c = customer();
    const a = owe(c.id, "A", 6000n);
    const b = owe(c.id, "B", 4000n);
    ok(send(receiptReq(c, "receipt-key-0040", "10000", [[a.id, "6000"], [b.id, "4000"]])));
    const dest = `${t.dir}/snap.sqlite`;
    snapshotDatabase(h.db, dest);
    const snap = openDatabase(dest, undefined, { fileMustExist: true });
    try {
      expect(Number((snap.prepare("SELECT count(*) AS c FROM receipts").get() as { c: bigint }).c)).toBe(1);
      expect(Number((snap.prepare("SELECT count(*) AS c FROM settlements WHERE receipt_id IS NOT NULL").get() as { c: bigint }).c)).toBe(2);
      expect(Number((snap.prepare("SELECT count(*) AS c FROM receipt_attempt_lines").get() as { c: bigint }).c)).toBe(2);
      expect(snap.pragma("foreign_key_check")).toEqual([]);
    } finally {
      snap.close();
    }
  });
});
