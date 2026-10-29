/**
 * M17B-S1 review — the cross-flow lock and a COMMIT failure through the SERVICE.
 *
 * 🔴 PART 1. An allocated-receipt attempt that is genuinely `unknown` or `conflict` blocks every new
 * money-in for that customer AT THE SERVICE BOUNDARY — through the old `recordCustomerPayment` IPC
 * route and through the legacy `settle()` — not through the renderer. `not_recorded` and `recorded`
 * do not lock (the ledger answered), and a replay of a committed collection is never held.
 * 🔴 PART 2. A COMMIT-time failure of the receipt transaction (a real deferred-foreign-key failure on
 * the real Migration 18 schema) rolls EVERYTHING back, leaves a recoverable open attempt, and the exact
 * retry then records ONE receipt.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerService } from "../../src/application/ledgerService";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { AllocatedReceiptResponse, CustomerStatementDto, RecordPaymentResponse } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";
import { child, seal } from "../helpers/receiptDb";

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
const owe = (partyId: string, ref: string, minor: bigint) =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
const n = (table: string, where = "1=1") => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
const receiptBody = (c: { id: string }, key: string, shares: Array<[string, string]>, reference = "WH-LOCK-1") => ({
  customerId: c.id,
  idempotencyKey: key,
  channel: "whish",
  reference,
  fundsConfirmed: true,
  currency: "USD",
  totalMinor: String(shares.reduce((s, [, a]) => s + Number(a), 0)),
  allocations: shares.map(([obligationId, amountMinor]) => ({ obligationId, amountMinor })),
});
const sendReceipt = (r: unknown) => ipc.recordAllocatedReceipt(r as never);
const pay = (r: unknown) => ipc.recordCustomerPayment(r as never);
const cash = (c: { id: string }, o: { id: string }, key: string, minor = "100") => ({
  customerId: c.id,
  obligationId: o.id,
  idempotencyKey: key,
  amountMinor: minor,
  method: "cash",
});
const whish = (c: { id: string }, o: { id: string }, key: string, reference: string) => ({
  customerId: c.id,
  obligationId: o.id,
  idempotencyKey: key,
  amountMinor: "100",
  method: "whish",
  reference,
  fundsConfirmed: true,
});
const breakSeal = () => h.db.exec("CREATE TRIGGER test_seal_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
const mendSeal = () => h.db.exec("DROP TRIGGER test_seal_fault");
const statement = (c: { id: string }) => ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));

/** An open receipt attempt left behind by an internal fault: provably `not_recorded`. */
function openReceiptAttempt(c: { id: string }, a: { id: string }, b: { id: string }, key: string, reference = "WH-LOCK-1") {
  breakSeal();
  sendReceipt(receiptBody(c, key, [[a.id, "600"], [b.id, "400"]], reference));
  mendSeal();
}
/** Make the lookup of ONE key fail, as a real lost handle would: the attempt reads `unknown`. */
function failLookupFor(key: string): void {
  const real = h.receiptStore.findByKey.bind(h.receiptStore);
  h.receiptStore.findByKey = (k: string) => {
    if (k === key) throw new Error("lookup failed");
    return real(k);
  };
}
/**
 * A receipt under the key that is a DIFFERENT payment: the attempt reads `conflict`. The database seal
 * now refuses a receipt that does not match an EXISTING intent, so this damaged state is built the only
 * way it can still arise — the receipt is written FIRST (no intent yet) and a differing intent appears
 * afterwards (a restored/edited file). The service must classify it from the stored rows.
 */
function makeConflict(c: { id: string }, a: { id: string }, b: { id: string }, key: string): void {
  h.db
    .transaction(() => {
      child(h.db, "RCONF" + key, a.id, "USD", 600);
      child(h.db, "RCONF" + key, b.id, "USD", 400);
      seal(h.db, "RCONF" + key, c.id, "USD", 1000, 2, "whish", "WH-CONF-" + key, key);
    })
    .immediate();
  h.db.prepare(
    `INSERT INTO receipt_attempts (idempotency_key, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, request_fingerprint, created_by, created_at)
     VALUES (?, ?, 'USD', 1000, 'whish', ?, 1, 2, 'a-different-fingerprint', 'cashier-01', '2026-10-25T09:00:00.000Z')`,
  ).run(key, c.id, "WH-CONF-" + key);
  h.db.prepare("INSERT INTO receipt_attempt_lines (idempotency_key, obligation_id, amount_minor) VALUES (?, ?, 600), (?, ?, 400)").run(key, a.id, key, b.id);
}
function world() {
  const c = customer();
  const a = owe(c.id, "A", 6000n);
  const b = owe(c.id, "B", 4000n);
  const d = owe(c.id, "D", 9000n);
  return { c, a, b, d };
}

describe("🔴 an unresolved receipt blocks every new money-in for that customer, at the service", () => {
  for (const kind of ["unknown", "conflict"] as const) {
    it(`${kind}: the old recordCustomerPayment route (cash AND Whish) and the legacy settle() are refused, and write nothing`, () => {
      const { c, a, b, d } = world();
      if (kind === "unknown") {
        openReceiptAttempt(c, a, b, "receipt-lock-0001");
        failLookupFor("receipt-lock-0001");
      } else {
        makeConflict(c, a, b, "receipt-lock-0001");
      }
      const before = [n("settlements"), n("collection_attempts"), n("receipts")];
      expect(errCode(pay(cash(c, d, "direct-lock-0001")))).toBe("COLLECTION_UNRESOLVED");
      expect(errCode(pay(whish(c, d, "direct-lock-0002", "WH-DIRECT-1")))).toBe("COLLECTION_UNRESOLVED");
      expect(() =>
        h.ledger.settle({ obligationId: d.id, partyId: c.id, idempotencyKey: "legacy-lock-0001", amountMinor: 100n, method: "cash" }),
      ).toThrow(/could not be confirmed/);
      expect([n("settlements"), n("collection_attempts"), n("receipts")]).toEqual(before); // not even an attempt row
      if (kind === "unknown") expect(statement(c).pendingReceipts.map((p) => p.status)).toEqual(["unknown"]);
    });
  }

  it("another customer is not affected", () => {
    const { c, a, b } = world();
    openReceiptAttempt(c, a, b, "receipt-lock-0002");
    failLookupFor("receipt-lock-0002");
    const other = customer("زبون آخر");
    const o = owe(other.id, "X", 5000n);
    ok<RecordPaymentResponse>(pay(cash(other, o, "direct-lock-0003")));
    expect(n("settlements", "obligation_id = '" + o.id + "'")).toBe(1);
  });

  it("not_recorded and recorded do NOT lock: the ledger answered, so existing M17A behaviour is unchanged", () => {
    const { c, a, b, d } = world();
    openReceiptAttempt(c, a, b, "receipt-lock-0003"); // open, provably not recorded
    expect(statement(c).pendingReceipts.map((p) => p.status)).toEqual(["not_recorded"]);
    ok<RecordPaymentResponse>(pay(cash(c, d, "direct-lock-0004")));
    ok<RecordPaymentResponse>(pay(whish(c, d, "direct-lock-0005", "WH-DIRECT-2")));
    expect(n("settlements", "receipt_id IS NULL")).toBe(2);
    // …and with NO receipt attempt at all, a collection is exactly what it always was
    const solo = customer("بلا إيصال");
    const so = owe(solo.id, "S", 3000n);
    expect(ok<RecordPaymentResponse>(pay(cash(solo, so, "direct-lock-0006"))).duplicate).toBe(false);
  });

  it("🔴 a REPLAY of a collection that already committed is still answered while a receipt is unknown", () => {
    const { c, a, b, d } = world();
    ok(pay(cash(c, d, "direct-lock-0007")));
    openReceiptAttempt(c, a, b, "receipt-lock-0004");
    failLookupFor("receipt-lock-0004");
    const again = ok<RecordPaymentResponse>(pay(cash(c, d, "direct-lock-0007")));
    expect(again.duplicate).toBe(true);
    expect(n("settlements", "receipt_id IS NULL")).toBe(1);
  });

  it("a DIFFERENT receipt is refused while an earlier one is unknown — nothing new starts", () => {
    const { c, a, b } = world();
    openReceiptAttempt(c, a, b, "receipt-lock-0005");
    failLookupFor("receipt-lock-0005");
    // a DIFFERENT receipt is refused while the first is unknown
    const e = owe(c.id, "E", 2000n);
    const f = owe(c.id, "F", 2000n);
    expect(errCode(sendReceipt(receiptBody(c, "receipt-lock-0006", [[e.id, "500"], [f.id, "500"]], "WH-NEXT")))).toBe("COLLECTION_UNRESOLVED");
    expect(n("receipts")).toBe(0);
  });

  it("🔴 the lock is re-read INSIDE the settlement transaction: a receipt that becomes unresolved between the intent and the settlement stops the collection", () => {
    const { c, a, b, d } = world();
    openReceiptAttempt(c, a, b, "receipt-lock-0007");
    let transactions = 0;
    const racing = new LedgerService({
      ledger: h.ledgerStore,
      receipts: h.receiptStore,
      parties: h.partyStore,
      actor: () => ({ id: "cashier-01", name: "Owner", role: "owner" }),
      transact: (fn) =>
        h.db
          .transaction(() => {
            transactions += 1;
            if (transactions === 2) makeConflict(c, a, b, "receipt-race-0001"); // appears after Tx1 committed
            return fn();
          })
          .immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
    const before = n("settlements");
    expect(() =>
      racing.collect({ customerId: c.id, obligationId: d.id, partyId: c.id, idempotencyKey: "direct-race-0001", amountMinor: 100n, method: "cash", channel: "cash" }),
    ).toThrow(/could not be confirmed/);
    expect(n("settlements")).toBe(before);
    // a HOLD is not a verdict on the payment: the attempt stays OPEN so the original key can still recover
    expect(h.db.prepare("SELECT resolution FROM collection_attempts WHERE idempotency_key = 'direct-race-0001'").get()).toEqual({ resolution: null });
  });

  it("with no receipts repository wired, collections behave exactly as before (the lock is simply absent)", () => {
    const { c, d } = world();
    const legacy = new LedgerService({
      ledger: h.ledgerStore,
      parties: h.partyStore,
      actor: () => ({ id: "cashier-01", name: "Owner", role: "owner" }),
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
    expect(legacy.settle({ obligationId: d.id, partyId: c.id, idempotencyKey: "legacy-lock-0002", amountMinor: 100n, method: "cash" }).duplicate).toBe(false);
  });
});

describe("🔴 an ALREADY-OPEN, not-yet-recorded M17A attempt cannot slip a settlement in while a receipt is unresolved", () => {
  /** An open collection attempt left by an internal fault: durable intent, no settlement. */
  function openCollection(c: { id: string }, d: { id: string }, key: string, method: "cash" | "whish" = "cash", reference = "WH-OPEN-1") {
    h.db.exec("CREATE TRIGGER test_settle_fault BEFORE INSERT ON settlements WHEN NEW.receipt_id IS NULL BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
    pay(method === "cash" ? cash(c, d, key) : whish(c, d, key, reference));
    h.db.exec("DROP TRIGGER test_settle_fault");
    expect(h.db.prepare("SELECT resolution FROM collection_attempts WHERE idempotency_key = ?").get(key)).toEqual({ resolution: null });
    expect(n("settlements", "receipt_id IS NULL")).toBe(0);
  }
  for (const kind of ["unknown", "conflict"] as const) {
    it(`${kind}: the exact repeat of the open attempt is HELD, writes nothing, and recovers under its ORIGINAL key once reconciled`, () => {
      const { c, a, b, d } = world();
      openCollection(c, d, "direct-open-0001");
      const attemptBefore = h.db.prepare("SELECT * FROM collection_attempts WHERE idempotency_key = 'direct-open-0001'").get();
      let heal: (() => void) | null;
      if (kind === "unknown") {
        openReceiptAttempt(c, a, b, "receipt-open-0001");
        const real = h.receiptStore.findByKey.bind(h.receiptStore);
        let failing = true;
        h.receiptStore.findByKey = (k: string) => {
          if (failing && k === "receipt-open-0001") throw new Error("lookup failed");
          return real(k);
        };
        heal = () => {
          failing = false;
        };
      } else {
        // A conflict does not heal by itself — a different receipt really sits under that key, and the ledger is
        // immutable, so it needs a human review. The hold must therefore simply stay in force.
        makeConflict(c, a, b, "receipt-open-0002");
        heal = null;
      }
      const direct = () => n("settlements", "receipt_id IS NULL");
      const before = [direct(), n("receipts"), n("collection_attempts")];
      // the old IPC route, same key and payload
      expect(errCode(pay(cash(c, d, "direct-open-0001")))).toBe("COLLECTION_UNRESOLVED");
      // the legacy service route, same obligation
      expect(() => h.ledger.settle({ obligationId: d.id, partyId: c.id, idempotencyKey: "direct-open-0001", amountMinor: 100n, method: "cash" })).toThrow(/could not be confirmed/);
      expect([direct(), n("receipts"), n("collection_attempts")]).toEqual(before);
      // the attempt itself is untouched: still open, same intent — a HOLD is not a verdict on the payment
      expect(h.db.prepare("SELECT * FROM collection_attempts WHERE idempotency_key = 'direct-open-0001'").get()).toEqual(attemptBefore);
      // a different, NEW collection is held too
      expect(errCode(pay(cash(c, d, "direct-open-0002")))).toBe("COLLECTION_UNRESOLVED");
      expect(direct()).toBe(0);

      if (heal === null) {
        // still held after the attempts above, still byte-identical, nothing recorded
        expect(errCode(pay(cash(c, d, "direct-open-0001")))).toBe("COLLECTION_UNRESOLVED");
        expect(direct()).toBe(0);
        return;
      }
      heal();
      // reconciled: the original key and the original payload record ONCE, and a repeat is a duplicate
      const first = ok<RecordPaymentResponse>(pay(cash(c, d, "direct-open-0001")));
      expect(first.duplicate).toBe(false);
      expect(n("settlements", "receipt_id IS NULL")).toBe(1);
      expect(ok<RecordPaymentResponse>(pay(cash(c, d, "direct-open-0001"))).duplicate).toBe(true);
      expect(n("settlements", "receipt_id IS NULL")).toBe(1);
      expect(h.db.prepare("SELECT resolution FROM collection_attempts WHERE idempotency_key = 'direct-open-0001'").get()).toEqual({ resolution: "recorded" });
    });
  }

  it("a Whish attempt that is open is held the same way, and its reference is not consumed while it is held", () => {
    const { c, a, b, d } = world();
    openCollection(c, d, "direct-open-0003", "whish", "WH-OPEN-3");
    openReceiptAttempt(c, a, b, "receipt-open-0003");
    failLookupFor("receipt-open-0003");
    expect(errCode(pay(whish(c, d, "direct-open-0003", "WH-OPEN-3")))).toBe("COLLECTION_UNRESOLVED");
    expect(n("settlements")).toBe(0);
    expect(h.db.prepare("SELECT count(*) AS c FROM settlements WHERE reference = 'WH-OPEN-3'").get()).toEqual({ c: 0n });
  });

  it("a collection that is ALREADY recorded still answers its idempotent duplicate, with no mutation, while a receipt is unresolved", () => {
    const { c, a, b, d } = world();
    ok(pay(cash(c, d, "direct-open-0004")));
    openReceiptAttempt(c, a, b, "receipt-open-0004");
    failLookupFor("receipt-open-0004");
    const before = [n("settlements"), n("collection_attempts")];
    expect(ok<RecordPaymentResponse>(pay(cash(c, d, "direct-open-0004"))).duplicate).toBe(true);
    expect([n("settlements"), n("collection_attempts")]).toEqual(before);
  });

  it("the IPC payload and the fingerprint are unchanged: a cash collection hashes exactly as before and replays", () => {
    const { c, d } = world();
    ok(pay(cash(c, d, "direct-open-0005")));
    const row = h.db.prepare("SELECT request_fingerprint AS f FROM settlements WHERE idempotency_key = 'direct-open-0005'").get() as { f: string };
    const expected = require("node:crypto")
      .createHash("sha256")
      .update(JSON.stringify({ obligationId: d.id, partyId: c.id, amountMinor: "100", currency: "USD", method: "cash" }))
      .digest("hex");
    expect(row.f).toBe(expected);
  });
});

describe("🔴 a COMMIT failure of the receipt transaction, through the service on the real schema", () => {
  /** A service whose receipt transaction FAILS AT COMMIT: a dangling deferred-FK allocation is added just before it. */
  function commitFailing(c: { id: string }, spare: { id: string }): { ledger: LedgerService; armed: { on: boolean } } {
    const armed = { on: true };
    let transactions = 0;
    const ledger = new LedgerService({
      ledger: h.ledgerStore,
      receipts: h.receiptStore,
      parties: h.partyStore,
      actor: () => ({ id: "cashier-01", name: "Owner", role: "owner" }),
      transact: (fn) =>
        h.db
          .transaction(() => {
            transactions += 1;
            const result = fn();
            // the SECOND transaction of a receipt is the allocation/seal one
            if (armed.on && transactions % 2 === 0) child(h.db, "ghost-receipt", spare.id, "USD", 1); // no such receipt: fails at COMMIT
            return result;
          })
          .immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
    void c;
    return { ledger, armed };
  }
  const draft = (c: { id: string }, a: { id: string }, b: { id: string }, key: string) => ({
    customerId: c.id,
    idempotencyKey: key,
    channel: "whish",
    reference: "WH-COMMIT",
    fundsConfirmed: true,
    currency: "USD",
    totalMinor: 10000n,
    allocations: [{ obligationId: a.id, amountMinor: 6000n }, { obligationId: b.id, amountMinor: 4000n }],
  });

  it("everything rolls back atomically: no receipt, no allocation, no orphan; the attempt stays OPEN and is not_recorded", () => {
    const { c, a, b, d } = world();
    const { ledger } = commitFailing(c, d);
    let error: unknown;
    try {
      ledger.recordAllocatedReceipt(draft(c, a, b, "receipt-commit-0001"));
    } catch (e) {
      error = e;
    }
    expect(String((error as Error).message)).toMatch(/FOREIGN KEY/); // not a business refusal: an uncertain, internal failure
    expect(n("receipts")).toBe(0);
    expect(n("settlements", "receipt_id IS NOT NULL")).toBe(0); // no orphan allocation, not even the ghost
    const attempt = h.db.prepare("SELECT resolved_at, resolution FROM receipt_attempts").get() as { resolved_at: string | null; resolution: string | null };
    expect(attempt).toEqual({ resolved_at: null, resolution: null }); // open: an internal fault proves nothing
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
    expect(h.ledger.openReceipts(c.id).map((x) => x.status)).toEqual(["not_recorded"]); // the durable outcome, read back
  });

  it("the recovery screen reports it, the exact retry records ONE receipt under the original key, and a repeat is a duplicate", () => {
    const { c, a, b, d } = world();
    const failing = commitFailing(c, d);
    expect(() => failing.ledger.recordAllocatedReceipt(draft(c, a, b, "receipt-commit-0002"))).toThrow();
    expect(statement(c).pendingReceipts.map((p) => [p.idempotencyKey, p.status])).toEqual([["receipt-commit-0002", "not_recorded"]]);
    // retry, now without the sabotage
    const r = ok<AllocatedReceiptResponse>(sendReceipt(receiptBody(c, "receipt-commit-0002", [[a.id, "6000"], [b.id, "4000"]], "WH-COMMIT")));
    expect(r.duplicate).toBe(false);
    expect(n("receipts")).toBe(1);
    expect(n("settlements", "receipt_id IS NOT NULL")).toBe(2);
    expect(ok<AllocatedReceiptResponse>(sendReceipt(receiptBody(c, "receipt-commit-0002", [[a.id, "6000"], [b.id, "4000"]], "WH-COMMIT"))).duplicate).toBe(true);
    expect(n("receipts")).toBe(1);
    expect(h.db.prepare("SELECT resolution FROM receipt_attempts").get()).toEqual({ resolution: "recorded" });
  });

  it("🔴 an UNCERTAIN outcome never invites a new collection: with the lookup failing, the old route is refused", () => {
    const { c, a, b, d } = world();
    const failing = commitFailing(c, d);
    expect(() => failing.ledger.recordAllocatedReceipt(draft(c, a, b, "receipt-commit-0003"))).toThrow();
    failLookupFor("receipt-commit-0003"); // and now even the ledger cannot be asked
    expect(statement(c).pendingReceipts.map((p) => p.status)).toEqual(["unknown"]);
    expect(errCode(pay(cash(c, d, "direct-commit-0001")))).toBe("COLLECTION_UNRESOLVED");
    expect(errCode(sendReceipt(receiptBody(c, "receipt-commit-0004", [[a.id, "600"], [b.id, "400"]], "WH-OTHER")))).toBe("COLLECTION_UNRESOLVED");
    expect(n("receipts")).toBe(0);
    expect(n("settlements")).toBe(0);
  });

  it("M17A is intact around it: a direct collection before and after the failed receipt records normally", () => {
    const { c, a, b, d } = world();
    ok(pay(cash(c, d, "direct-commit-0002")));
    const failing = commitFailing(c, d);
    expect(() => failing.ledger.recordAllocatedReceipt(draft(c, a, b, "receipt-commit-0005"))).toThrow();
    ok(pay(whish(c, d, "direct-commit-0003", "WH-AFTER")));
    expect(n("settlements", "receipt_id IS NULL")).toBe(2);
    expect(n("receipts")).toBe(0);
  });
});
