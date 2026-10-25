/**
 * M17B-S1 independent-review corrections.
 *
 * PART 1 — THE REVERSE LOCK. An already-open receipt attempt may not write allocations or seal a receipt while
 * an earlier COLLECTION attempt of that customer is `unknown` or `conflict`; the check is re-read inside the
 * receipt's own transaction before any write. A replay of a recorded receipt is still answered, a HOLD leaves
 * the attempt open and byte-identical, and after reconciliation the original key and intent retry once.
 *
 * PART 2 — RECEIPT VERSUS INTENT. A receipt is "what was intended" only if its own ROWS say so. The adversarial
 * case: an open attempt says Debt A 60.00 + Debt B 40.00; a hand-inserted receipt under its key says A 70.00 +
 * B 30.00 and carries the SAME stored fingerprint. The seal refuses it where the intent already exists, and —
 * independently — authoritative read-back classifies it `conflict`, never `recorded`, and an unexpected IPC
 * failure never claims "recorded" from it.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, receiptFailureTruth, syncHandlers } from "../../src/main/ipcHandlers";
import type { AllocatedReceiptResponse, CustomerStatementDto } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";
import { child, count, seal } from "../helpers/receiptDb";

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
const n = (table: string, where = "1=1") => count(h.db, table, where);
const world = () => {
  const c = customer();
  return { c, a: owe(c.id, "A", 6000n), b: owe(c.id, "B", 4000n), d: owe(c.id, "D", 9000n) };
};
const body = (c: { id: string }, key: string, shares: Array<[string, string]>, reference = "WH-123") => ({
  customerId: c.id,
  idempotencyKey: key,
  channel: "whish",
  reference,
  fundsConfirmed: true,
  currency: "USD",
  totalMinor: String(shares.reduce((s, [, a]) => s + Number(a), 0)),
  allocations: shares.map(([obligationId, amountMinor]) => ({ obligationId, amountMinor })),
});
const send = (r: unknown) => ipc.recordAllocatedReceipt(r as never);
const statement = (c: { id: string }) => ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
const cash = (c: { id: string }, o: { id: string }, key: string) => ({ customerId: c.id, obligationId: o.id, idempotencyKey: key, amountMinor: "100", method: "cash" });
const pay = (r: unknown) => ipc.recordCustomerPayment(r as never);
const attemptRow = (key: string) => h.db.prepare("SELECT * FROM receipt_attempts WHERE idempotency_key = ?").get(key);

/** An open receipt attempt left by an internal fault: durable intent, no receipt. */
function openReceipt(c: { id: string }, a: { id: string }, b: { id: string }, key: string, reference = "WH-123") {
  h.db.exec("CREATE TRIGGER test_seal_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
  send(body(c, key, [[a.id, "6000"], [b.id, "4000"]], reference));
  h.db.exec("DROP TRIGGER test_seal_fault");
  expect(n("receipts")).toBe(0);
}
/** An open M17A collection attempt: durable intent, no settlement. */
function openCollection(c: { id: string }, d: { id: string }, key: string) {
  h.db.exec("CREATE TRIGGER test_settle_fault BEFORE INSERT ON settlements WHEN NEW.receipt_id IS NULL BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
  pay(cash(c, d, key));
  h.db.exec("DROP TRIGGER test_settle_fault");
  expect(h.db.prepare("SELECT resolution FROM collection_attempts WHERE idempotency_key = ?").get(key)).toEqual({ resolution: null });
}
/** The collection attempt reads `unknown` (its settlement lookup fails) until `heal()`. */
function collectionUnknown(key: string): () => void {
  const real = h.ledgerStore.findSettlementByIdempotencyKey.bind(h.ledgerStore);
  let failing = true;
  h.ledgerStore.findSettlementByIdempotencyKey = (k: string) => {
    if (failing && k === key) throw new Error("lookup failed");
    return real(k);
  };
  return () => {
    failing = false;
  };
}
/** The collection attempt reads `conflict`: a DIFFERENT settlement already sits under its key. */
function collectionConflict(d: { id: string }, key: string): void {
  h.db
    .prepare(
      `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date)
       VALUES ('conflicting-settlement', ?, 'USD', ?, 'some-other-fingerprint', 777, 'cash', 'cashier-01', '2026-10-25T09:00:00.000Z', '2026-10-25')`,
  )
    .run(d.id, key);
}

/** Debts large enough that a 70/30 split of 100.00 is not refused as an overpayment — only the intent differs. */
const bigWorld = () => {
  const c = customer();
  return { c, a: owe(c.id, "A", 9000n), b: owe(c.id, "B", 9000n), d: owe(c.id, "D", 9000n) };
};

describe("🔴 the reverse lock: an open receipt cannot write while a collection is unresolved", () => {
  for (const kind of ["unknown", "conflict"] as const) {
    it(`${kind}: the exact retry of the open receipt is HELD, writes nothing and leaves the attempt byte-identical`, () => {
      const { c, a, b, d } = world();
      openCollection(c, d, "direct-rev-0001");
      openReceipt(c, a, b, "receipt-rev-0001");
      const heal = kind === "unknown" ? collectionUnknown("direct-rev-0001") : (collectionConflict(d, "direct-rev-0001"), null);
      const before = attemptRow("receipt-rev-0001");
      const counts = () => [n("receipts"), n("settlements", "receipt_id IS NOT NULL"), n("receipt_attempts")];
      const countsBefore = counts();
      // the EXACT retry, over the IPC path
      expect(errCode(send(body(c, "receipt-rev-0001", [[a.id, "6000"], [b.id, "4000"]])))).toBe("COLLECTION_UNRESOLVED");
      expect(counts()).toEqual(countsBefore); // no allocation, no seal
      expect(attemptRow("receipt-rev-0001")).toEqual(before); // open and byte-identical: a HOLD is no verdict
      // a different NEW receipt is held too (Tx1)
      const e = owe(c.id, "E", 2000n);
      const f = owe(c.id, "F", 2000n);
      expect(errCode(send(body(c, "receipt-rev-0002", [[e.id, "1000"], [f.id, "1000"]], "WH-NEXT")))).toBe("COLLECTION_UNRESOLVED");
      expect(n("receipts")).toBe(0);
      if (heal === null) {
        // a conflict does not heal by itself: the hold simply stays
        expect(errCode(send(body(c, "receipt-rev-0001", [[a.id, "6000"], [b.id, "4000"]])))).toBe("COLLECTION_UNRESOLVED");
        return;
      }
      heal();
      const r = ok<AllocatedReceiptResponse>(send(body(c, "receipt-rev-0001", [[a.id, "6000"], [b.id, "4000"]])));
      expect(r.duplicate).toBe(false);
      expect(counts()).toEqual([1, 2, 1]);
      expect(h.db.prepare("SELECT idempotency_key AS k FROM receipts").get()).toEqual({ k: "receipt-rev-0001" }); // the ORIGINAL key
      expect(attemptRow("receipt-rev-0001")).toMatchObject({ resolution: "recorded" });
      expect(ok<AllocatedReceiptResponse>(send(body(c, "receipt-rev-0001", [[a.id, "6000"], [b.id, "4000"]]))).duplicate).toBe(true);
      expect(n("receipts")).toBe(1);
    });
  }

  it("a RECORDED receipt still answers its replay (duplicate, no writes) while a collection is unresolved", () => {
    const { c, a, b, d } = world();
    ok(send(body(c, "receipt-rev-0003", [[a.id, "6000"], [b.id, "4000"]])));
    openCollection(c, d, "direct-rev-0002");
    collectionUnknown("direct-rev-0002");
    const before = [n("receipts"), n("settlements"), n("receipt_attempts")];
    expect(ok<AllocatedReceiptResponse>(send(body(c, "receipt-rev-0003", [[a.id, "6000"], [b.id, "4000"]]))).duplicate).toBe(true);
    expect([n("receipts"), n("settlements"), n("receipt_attempts")]).toEqual(before);
  });

  it("with the lookup healthy and the collection merely not recorded, the receipt proceeds exactly as before", () => {
    const { c, a, b, d } = world();
    openCollection(c, d, "direct-rev-0003"); // open, provably not recorded
    expect(ok<AllocatedReceiptResponse>(send(body(c, "receipt-rev-0004", [[a.id, "6000"], [b.id, "4000"]]))).duplicate).toBe(false);
    expect(n("receipts")).toBe(1);
  });
});

describe("🔴 a receipt must be the intent recorded under its key", () => {
  const fingerprint = (customerId: string, shares: Array<[string, string]>, total: string, reference = "WH-123") =>
    createHash("sha256")
      .update(JSON.stringify({ kind: "receipt", customerId, currency: "USD", provider: "whish", reference, fundsConfirmed: true, totalMinor: total, allocations: [...shares].sort((x, y) => (x[0] < y[0] ? -1 : 1)) }))
      .digest("hex");
  const insertAttempt = (c: { id: string }, a: { id: string }, b: { id: string }, key: string, fp: string, reference = "WH-123") => {
    h.db.prepare(
      `INSERT INTO receipt_attempts (idempotency_key, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, request_fingerprint, created_by, created_at)
       VALUES (?, ?, 'USD', 10000, 'whish', ?, 1, 2, ?, 'cashier-01', '2026-10-25T09:00:00.000Z')`,
    ).run(key, c.id, reference, fp);
    h.db.prepare("INSERT INTO receipt_attempt_lines (idempotency_key, obligation_id, amount_minor) VALUES (?, ?, 6000), (?, ?, 4000)").run(key, a.id, key, b.id);
  };
  it("the SEAL refuses A 70.00 + B 30.00 under an existing intent of A 60.00 + B 40.00, even with the SAME fingerprint — atomically", () => {
    const { c, a, b } = bigWorld();
    const F = fingerprint(c.id, [[a.id, "6000"], [b.id, "4000"]], "10000");
    insertAttempt(c, a, b, "receipt-int-0001", F);
    // build the receipt row with the intent's own fingerprint (seal() helper writes 'fp'; do it by hand)
    expect(() =>
      h.db
        .transaction(() => {
          child(h.db, "R7030", a.id, "USD", 7000);
          child(h.db, "R7030", b.id, "USD", 3000);
          h.db
            .prepare(
              `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
               VALUES ('R7030', ?, 'USD', 10000, 'whish', 'WH-123', 1, 2, 'receipt-int-0001', ?, 'cashier-01', '2026-10-25T09:00:00.000Z', '2026-10-25')`,
            )
            .run(c.id, F);
        })
        .immediate(),
    ).toThrow(/must match the intent recorded under its key/);
    expect([n("receipts"), n("settlements", "receipt_id IS NOT NULL")]).toEqual([0, 0]);
  });

  it("the seal also refuses a different reference, total, customer or fingerprint under an existing intent", () => {
    const { c, a, b } = bigWorld();
    const F = fingerprint(c.id, [[a.id, "6000"], [b.id, "4000"]], "10000");
    insertAttempt(c, a, b, "receipt-int-0002", F);
    for (const [label, ref, fp] of [["reference", "WH-OTHER", F], ["fingerprint", "WH-123", "a-different-fingerprint"]] as const) {
      expect(
        () =>
          h.db
            .transaction(() => {
              child(h.db, "RX", a.id, "USD", 6000);
              child(h.db, "RX", b.id, "USD", 4000);
              h.db
                .prepare(
                  `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
                   VALUES ('RX', ?, 'USD', 10000, 'whish', ?, 1, 2, 'receipt-int-0002', ?, 'cashier-01', '2026-10-25T09:00:00.000Z', '2026-10-25')`,
                )
                .run(c.id, ref, fp);
            })
            .immediate(),
        label,
      ).toThrow(/must match the intent/);
    }
    expect(n("receipts")).toBe(0);
    // …and the GENUINE receipt for that intent is accepted, so the guard is not a blanket refusal
    expect(
      h.db
        .transaction(() => {
          child(h.db, "RG", a.id, "USD", 6000);
          child(h.db, "RG", b.id, "USD", 4000);
          h.db
            .prepare(
              `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
               VALUES ('RG', ?, 'USD', 10000, 'whish', 'WH-123', 1, 2, 'receipt-int-0002', ?, 'cashier-01', '2026-10-25T09:00:00.000Z', '2026-10-25')`,
            )
            .run(c.id, F);
        })
        .immediate(),
    ).toBeUndefined();
    expect(n("receipts")).toBe(1);
  });

  it("the database refuses to resolve an attempt 'recorded' when the receipt under its key is NOT the intent", () => {
    const { c, a, b } = bigWorld();
    const F = fingerprint(c.id, [[a.id, "6000"], [b.id, "4000"]], "10000");
    // the damaged state: the 70/30 receipt exists FIRST, the 60/40 intent appears afterwards with the same fingerprint
    h.db
      .transaction(() => {
        child(h.db, "R7030", a.id, "USD", 7000);
        child(h.db, "R7030", b.id, "USD", 3000);
        h.db
          .prepare(
            `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
             VALUES ('R7030', ?, 'USD', 10000, 'whish', 'WH-123', 1, 2, 'receipt-int-0003', ?, 'cashier-01', '2026-10-25T09:00:00.000Z', '2026-10-25')`,
          )
          .run(c.id, F);
      })
      .immediate();
    insertAttempt(c, a, b, "receipt-int-0003", F);
    expect(() => h.db.prepare("UPDATE receipt_attempts SET resolved_at = '2026-10-25T10:00:00.000Z', resolution = 'recorded' WHERE idempotency_key = 'receipt-int-0003'").run()).toThrow(/must match the ledger/);
    expect(() => h.db.prepare("UPDATE receipt_attempts SET resolved_at = '2026-10-25T10:00:00.000Z', resolution = 'not_recorded' WHERE idempotency_key = 'receipt-int-0003'").run()).toThrow(/must match the ledger/);
    expect(attemptRow("receipt-int-0003")).toMatchObject({ resolution: null });
  });

  it("🔴 READ-BACK ALONE (independent of the seal): the 70/30 receipt with the SAME fingerprint reads 'conflict', never 'recorded'", () => {
    const { c, a, b, d } = bigWorld();
    const F = fingerprint(c.id, [[a.id, "6000"], [b.id, "4000"]], "10000");
    h.db
      .transaction(() => {
        child(h.db, "R7030", a.id, "USD", 7000);
        child(h.db, "R7030", b.id, "USD", 3000);
        h.db
          .prepare(
            `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
             VALUES ('R7030', ?, 'USD', 10000, 'whish', 'WH-123', 1, 2, 'receipt-int-0004', ?, 'cashier-01', '2026-10-25T09:00:00.000Z', '2026-10-25')`,
          )
          .run(c.id, F);
      })
      .immediate();
    insertAttempt(c, a, b, "receipt-int-0004", F);
    // the stored receipt verifies on its own (it IS exactly allocated) — only the intent comparison can tell
    expect((h.ledger as unknown as { deps: { receipts: { receiptIntegrity(i: string): { ok: boolean } } } }).deps.receipts.receiptIntegrity("R7030").ok).toBe(true);
    expect(statement(c).pendingReceipts.map((x) => x.status)).toEqual(["conflict"]);
    // it locks new money-in, and the exact original request is NOT answered as recorded
    expect(errCode(pay(cash(c, d, "direct-int-0001")))).toBe("COLLECTION_UNRESOLVED");
    const r = send(body(c, "receipt-int-0004", [[a.id, "6000"], [b.id, "4000"]]));
    expect(errCode(r)).toBe("LEDGER_INTEGRITY");
    expect(attemptRow("receipt-int-0004")).toMatchObject({ resolution: null }); // never closed 'recorded'
    expect(n("receipts")).toBe(1); // nothing else was written
  });

  it("🔴 an unexpected IPC failure never claims 'recorded' from an inconsistent receipt row", () => {
    const { c, a, b } = bigWorld();
    const F = fingerprint(c.id, [[a.id, "6000"], [b.id, "4000"]], "10000");
    h.db
      .transaction(() => {
        child(h.db, "R7030", a.id, "USD", 7000);
        child(h.db, "R7030", b.id, "USD", 3000);
        h.db
          .prepare(
            `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
             VALUES ('R7030', ?, 'USD', 10000, 'whish', 'WH-123', 1, 2, 'receipt-int-0005', ?, 'cashier-01', '2026-10-25T09:00:00.000Z', '2026-10-25')`,
          )
          .run(c.id, F);
      })
      .immediate();
    insertAttempt(c, a, b, "receipt-int-0005", F);
    const bad = receiptFailureTruth(h.ledger, { idempotencyKey: "receipt-int-0005" }, "en");
    expect(bad.code).toBe("PAYMENT_STATUS_UNKNOWN"); // not RECORDED, and not "not recorded: retry"
    expect(bad.message).toMatch(/not known whether/i);
    // the control: a CONSISTENT receipt IS reported as recorded, and a missing one as not recorded
    // (another customer: this one is correctly locked by its own conflict)
    const other = customer("زبون آخر");
    ok(send(body(other, "receipt-int-0006", [[owe(other.id, "E", 2000n).id, "1000"], [owe(other.id, "F", 2000n).id, "1000"]], "WH-GOOD")));
    expect(receiptFailureTruth(h.ledger, { idempotencyKey: "receipt-int-0006" }, "en").code).toBe("PAYMENT_RECORDED");
    expect(receiptFailureTruth(h.ledger, { idempotencyKey: "receipt-int-9999" }, "en").code).toBe("PAYMENT_NOT_RECORDED");
  });

  it("how the raw-SQL fixtures are treated: a receipt inserted with NO attempt is still allowed (the seal's own rules apply), and is reported from its rows", () => {
    const { c, a, b } = bigWorld();
    expect(
      h.db
        .transaction(() => {
          child(h.db, "RN", a.id, "USD", 6000);
          child(h.db, "RN", b.id, "USD", 4000);
          seal(h.db, "RN", c.id, "USD", 10000, 2, "whish", "WH-NOATTEMPT", "receipt-noat-0001");
        })
        .immediate(),
    ).toBeUndefined();
    expect(receiptFailureTruth(h.ledger, { idempotencyKey: "receipt-noat-0001" }, "en").code).toBe("PAYMENT_RECORDED"); // verifies from its own rows
  });
});
