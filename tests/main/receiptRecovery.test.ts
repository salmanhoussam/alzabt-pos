/**
 * M17B-S1 — recovery of an UNKNOWN receipt outcome, and the owner role re-read inside BOTH write
 * transactions. A receipt attempt is recovered from the ledger under its ORIGINAL key across a lost
 * response, a closed window and a restart; a failed lookup is never "not recorded"; a closed
 * not-recorded attempt can never post money. Synthetic data, real SQLite, minor units.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerService } from "../../src/application/ledgerService";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { ReceiptRepository } from "../../src/persistence/receiptRepository";
import type { AllocatedReceiptResponse, CustomerStatementDto } from "../../src/shared/ipcContract";
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

function open(): void {
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
}
beforeEach(() => {
  t = tempDir();
  open();
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const customer = (name = "محمد علي") => h.parties.create({ kind: "customer", displayName: name }).party;
const owe = (partyId: string, ref: string, minor: bigint) =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
const n = (table: string, where = "1=1") => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
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
const attempts = () => h.db.prepare("SELECT * FROM receipt_attempts ORDER BY created_at, idempotency_key").all() as Array<Record<string, unknown>>;
/** An unexpected INTERNAL fault while the receipt is being sealed (not a business refusal). */
const breakSeal = () => h.db.exec("CREATE TRIGGER test_seal_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
const mendSeal = () => h.db.exec("DROP TRIGGER test_seal_fault");

function twoDebts() {
  const c = customer();
  return { c, a: owe(c.id, "A", 6000n), b: owe(c.id, "B", 4000n) };
}

describe("the intent is durable before the money can move", () => {
  it("🔴 an internal fault rolls the allocations AND the seal back, leaves the ORIGINAL attempt open, and reports it from the ledger", () => {
    const { c, a, b } = twoDebts();
    breakSeal();
    const r = send(body(c, "receipt-orig-001", [[a.id, "6000"], [b.id, "4000"]]));
    expect(r.ok).toBe(false);
    expect(errCode(r)).toBe("PAYMENT_NOT_RECORDED"); // the ledger was asked: nothing recorded under that key
    expect(n("receipts")).toBe(0);
    expect(n("settlements", "receipt_id IS NOT NULL")).toBe(0); // the allocations rolled back with the seal
    const row = attempts()[0]!;
    expect([row.idempotency_key, row.customer_id, row.currency, Number(row.amount_minor), row.provider, row.reference, Number(row.funds_confirmed), Number(row.allocation_count)]).toEqual([
      "receipt-orig-001", c.id, "USD", 10000, "whish", "WH-123", 1, 2,
    ]);
    expect(row.resolved_at).toBeNull();
    const p = statement(c).pendingReceipts;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ idempotencyKey: "receipt-orig-001", total: { minor: "10000", currency: "USD" }, provider: "whish", reference: "WH-123", status: "not_recorded" });
    expect(p[0]!.allocations.map((x) => [x.obligationId, x.amount.minor]).sort()).toEqual([[a.id, "6000"], [b.id, "4000"]].sort());
  });

  it("🔴 it survives a closed window AND a restart, and the exact repeat then records ONE receipt under the original key", () => {
    const { c, a, b } = twoDebts();
    breakSeal();
    send(body(c, "receipt-orig-002", [[a.id, "6000"], [b.id, "4000"]]));
    mendSeal();
    h.db.close();
    open(); // a restart: nothing of the screen's memory exists any more
    expect(statement(c).pendingReceipts.map((x) => [x.idempotencyKey, x.status])).toEqual([["receipt-orig-002", "not_recorded"]]);
    const repeat = ok<AllocatedReceiptResponse>(send(body(c, "receipt-orig-002", [[a.id, "6000"], [b.id, "4000"]])));
    expect(repeat.duplicate).toBe(false);
    expect(n("receipts")).toBe(1);
    expect(n("settlements", "receipt_id IS NOT NULL")).toBe(2);
    expect(statement(c).pendingReceipts).toEqual([]);
    expect(attempts()[0]!.resolution).toBe("recorded");
    // a further repeat (a lost acknowledgement) is a duplicate, not a second receipt
    expect(ok<AllocatedReceiptResponse>(send(body(c, "receipt-orig-002", [[a.id, "6000"], [b.id, "4000"]]))).duplicate).toBe(true);
    expect(n("receipts")).toBe(1);
    expect(n("settlements", "receipt_id IS NOT NULL")).toBe(2);
  });

  it("🔴 opening a statement with a pending attempt records NOTHING", () => {
    const { c, a, b } = twoDebts();
    breakSeal();
    send(body(c, "receipt-orig-003", [[a.id, "6000"], [b.id, "4000"]]));
    mendSeal();
    const before = [n("receipts"), n("settlements")];
    statement(c);
    statement(c);
    expect([n("receipts"), n("settlements")]).toEqual(before);
  });
});

describe("the same key never means two different receipts", () => {
  it("a different total, share, reference or channel under the same key is a conflict — open or recorded", () => {
    const { c, a, b } = twoDebts();
    breakSeal();
    send(body(c, "receipt-same-001", [[a.id, "6000"], [b.id, "4000"]]));
    mendSeal();
    const variants = [
      body(c, "receipt-same-001", [[a.id, "5000"], [b.id, "4000"]]),
      body(c, "receipt-same-001", [[a.id, "6000"], [b.id, "3000"]]),
      body(c, "receipt-same-001", [[a.id, "6000"], [b.id, "4000"]], "WH-OTHER"),
      { ...body(c, "receipt-same-001", [[a.id, "6000"], [b.id, "4000"]]), channel: "bank_transfer" },
    ];
    for (const v of variants) expect(errCode(send(v))).toBe("IDEMPOTENCY_CONFLICT");
    expect(n("receipts")).toBe(0);
    ok(send(body(c, "receipt-same-001", [[a.id, "6000"], [b.id, "4000"]])));
    for (const v of variants) expect(errCode(send(v))).toBe("IDEMPOTENCY_CONFLICT"); // and after it is recorded
    expect(n("receipts")).toBe(1);
  });
});

describe("🔴 open vs permanently closed 'not recorded'", () => {
  it("a refusal inside the transaction closes the attempt for good; the key can then neither retry nor post (service AND raw SQL)", () => {
    const { c, a, b } = twoDebts();
    // another receipt holds WH-123, so this one is refused INSIDE the transaction (duplicate reference)
    const e = owe(c.id, "E", 2000n);
    const f = owe(c.id, "F", 2000n);
    ok(send(body(c, "receipt-closed-0", [[e.id, "1000"], [f.id, "1000"]])));
    expect(errCode(send(body(c, "receipt-closed-1", [[a.id, "6000"], [b.id, "4000"]])))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    const closed = attempts().find((x) => x.idempotency_key === "receipt-closed-1")!;
    expect(closed.resolution).toBe("not_recorded");
    // the very same request again is refused as a closed attempt, not retried
    expect(errCode(send(body(c, "receipt-closed-1", [[a.id, "6000"], [b.id, "4000"]], "WH-FRESH")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(errCode(send(body(c, "receipt-closed-1", [[a.id, "6000"], [b.id, "4000"]])))).toBe("IDEMPOTENCY_CONFLICT");
    // a delayed raw insert under that key is refused by the database itself
    expect(() =>
      h.db
        .transaction(() => {
          child(h.db, "RX", a.id, "USD", 6000);
          child(h.db, "RX", b.id, "USD", 4000);
          seal(h.db, "RX", c.id, "USD", 10000, 2, "whish", "WH-FRESH", "receipt-closed-1");
        })
        .immediate(),
    ).toThrow(/closed receipt attempt cannot be recorded/);
    expect(n("receipts")).toBe(1);
  });

  it("an OPEN attempt provably not recorded stays exactly repeatable; a different new receipt closes it and is allowed", () => {
    const { c, a, b } = twoDebts();
    breakSeal();
    send(body(c, "receipt-open-0001", [[a.id, "6000"], [b.id, "4000"]]));
    mendSeal();
    const e = owe(c.id, "E", 2000n);
    const f = owe(c.id, "F", 2000n);
    ok(send(body(c, "receipt-open-0002", [[e.id, "1000"], [f.id, "1000"]], "WH-NEXT")));
    expect(attempts().find((x) => x.idempotency_key === "receipt-open-0001")!.resolution).toBe("not_recorded");
    // …and the first key is now permanently closed
    expect(errCode(send(body(c, "receipt-open-0001", [[a.id, "6000"], [b.id, "4000"]])))).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("🔴 an answer the ledger cannot give keeps new receipts closed", () => {
  function serviceWith(repo: ReceiptRepository): LedgerService {
    return new LedgerService({
      ledger: h.ledgerStore,
      receipts: repo,
      parties: h.partyStore,
      actor: () => ({ id: "cashier-01", name: "Owner", role: "owner" }),
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
  }
  const draft = (c: { id: string }, key: string, a: { id: string }, b: { id: string }, reference = "WH-123") => ({
    customerId: c.id,
    idempotencyKey: key,
    channel: "whish",
    reference,
    fundsConfirmed: true,
    currency: "USD",
    totalMinor: 10000n,
    allocations: [{ obligationId: a.id, amountMinor: 6000n }, { obligationId: b.id, amountMinor: 4000n }],
  });

  it("a FAILED lookup reads 'unknown' (never 'not recorded'), locks the customer and survives a retry", () => {
    const { c, a, b } = twoDebts();
    breakSeal();
    send(body(c, "receipt-lock-0001", [[a.id, "6000"], [b.id, "4000"]]));
    mendSeal();
    const repo = new ReceiptRepository(h.db);
    const realFind = repo.findByKey.bind(repo);
    repo.findByKey = (key: string) => {
      if (key === "receipt-lock-0001") throw new Error("lookup failed");
      return realFind(key);
    };
    const svc = serviceWith(repo);
    expect(svc.openReceipts(c.id).map((x) => x.status)).toEqual(["unknown"]);
    const e = owe(c.id, "E", 2000n);
    const f = owe(c.id, "F", 2000n);
    expect(() => svc.recordAllocatedReceipt(draft(c, "receipt-lock-0002", e, f, "WH-LOCK"))).toThrow(/could not be confirmed/);
    expect(n("receipts")).toBe(0);
    expect(attempts().filter((x) => x.resolved_at === null)).toHaveLength(1); // nothing was closed on a guess
  });

  it("a receipt under the key that is a DIFFERENT payment (or does not verify) reads 'conflict' and locks too", () => {
    const { c, a, b } = twoDebts();
    // The seal refuses a receipt that disagrees with an EXISTING intent, so the damaged state is built the
    // only way it can arise: the receipt first, a differing intent afterwards.
    h.db
      .transaction(() => {
        child(h.db, "RC", a.id, "USD", 6000);
        child(h.db, "RC", b.id, "USD", 4000);
        seal(h.db, "RC", c.id, "USD", 10000, 2, "whish", "WH-X", "receipt-conf-0001");
      })
      .immediate();
    h.db.prepare(
      `INSERT INTO receipt_attempts (idempotency_key, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, request_fingerprint, created_by, created_at)
       VALUES ('receipt-conf-0001', ?, 'USD', 10000, 'whish', 'WH-X', 1, 2, 'a-different-fingerprint', 'cashier-01', '2026-10-25T09:00:00.000Z')`,
    ).run(c.id);
    h.db.prepare("INSERT INTO receipt_attempt_lines (idempotency_key, obligation_id, amount_minor) VALUES ('receipt-conf-0001', ?, 6000), ('receipt-conf-0001', ?, 4000)").run(a.id, b.id);
    expect(statement(c).pendingReceipts.map((x) => x.status)).toEqual(["conflict"]);
    const e = owe(c.id, "E", 2000n);
    const f = owe(c.id, "F", 2000n);
    expect(errCode(send(body(c, "receipt-conf-0002", [[e.id, "1000"], [f.id, "1000"]], "WH-NEW")))).toBe("COLLECTION_UNRESOLVED");
  });
});

describe("🔴 the owner role is re-read inside EVERY financial transaction", () => {
  function demotedOnTransaction(k: number): LedgerService {
    let role: "owner" | "cashier" = "owner";
    let transactions = 0;
    return new LedgerService({
      ledger: h.ledgerStore,
      receipts: new ReceiptRepository(h.db),
      parties: h.partyStore,
      actor: () => ({ id: "cashier-01", name: "Owner", role }),
      transact: (fn) =>
        h.db
          .transaction(() => {
            transactions += 1;
            if (transactions === k) role = "cashier";
            return fn();
          })
          .immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
  }
  const draft = (c: { id: string }, key: string, a: { id: string }, b: { id: string }) => ({
    customerId: c.id,
    idempotencyKey: key,
    channel: "whish",
    reference: "WH-123",
    fundsConfirmed: true,
    currency: "USD",
    totalMinor: 10000n,
    allocations: [{ obligationId: a.id, amountMinor: 6000n }, { obligationId: b.id, amountMinor: 4000n }],
  });

  it("demoted before the INTENT: not authorized and NOTHING is written", () => {
    const { c, a, b } = twoDebts();
    expect(() => demotedOnTransaction(1).recordAllocatedReceipt(draft(c, "receipt-role-0001", a, b))).toThrow(/owner|operator changed/i);
    expect([n("receipt_attempts"), n("receipts"), n("settlements")]).toEqual([0, 0, 0]);
  });

  it("demoted before the RECEIPT commits: no receipt, no allocation, and the attempt is left exactly as it was", () => {
    const { c, a, b } = twoDebts();
    let code = "";
    try {
      demotedOnTransaction(2).recordAllocatedReceipt(draft(c, "receipt-role-0002", a, b));
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("NOT_AUTHORIZED");
    expect([n("receipts"), n("settlements")]).toEqual([0, 0]);
    expect(attempts()[0]!.resolved_at).toBeNull();
  });

  it("a cashier cannot RECOVER either: the statement, the pending read and the exact repeat all refuse", () => {
    const { c, a, b } = twoDebts();
    breakSeal();
    send(body(c, "receipt-role-0003", [[a.id, "6000"], [b.id, "4000"]]));
    mendSeal();
    h.service.login("cashier-02", "2222");
    expect(errCode(ipc.getCustomerStatement({ customerId: c.id }))).toBe("NOT_AUTHORIZED");
    expect(() => h.ledger.openReceipts(c.id)).toThrow(/owner/i);
    expect(errCode(send(body(c, "receipt-role-0003", [[a.id, "6000"], [b.id, "4000"]])))).toBe("NOT_AUTHORIZED");
    expect(n("receipts")).toBe(0);
  });
});

describe("a stale screen cannot overpay", () => {
  it("a direct collection that reduced a debt after the form was filled makes the whole receipt refuse and write nothing", () => {
    const { c, a, b } = twoDebts();
    ok(ipc.recordCustomerPayment({ customerId: c.id, obligationId: a.id, idempotencyKey: "direct-key-9001", amountMinor: "1000", method: "cash" } as never));
    const before = [n("receipts"), n("settlements")];
    expect(errCode(send(body(c, "receipt-stale-0001", [[a.id, "6000"], [b.id, "4000"]])))).toBe("INVALID_AMOUNT");
    expect([n("receipts"), n("settlements")]).toEqual(before);
  });
});
