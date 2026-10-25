/**
 * Finding R1 — a receipt that COMMITTED but whose response failed afterwards must not trap the owner in a
 * blocked form.
 *
 * Trace under test: `recordAllocatedReceipt` commits; building the returned statement then fails;
 * `receiptFailureTruth` verifies the committed receipt and answers PAYMENT_RECORDED; the form blocks itself and
 * asks the ledger. The resolved attempt is no longer in `pendingReceipts`, so "absent from the open list" must
 * NOT be read as "not recorded" — the ledger's own receipt, exactly this one, is the evidence of "recorded".
 *
 * Real IPC handlers, real services, real SQLite, synthetic data. The reconciliation decision is the renderer's
 * pure `reconcileReceiptOutcome`, fed with the REAL statements the handlers return.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { reconcileReceiptOutcome } from "../../src/renderer/screens/receiptAllocation";
import type { AllocatedReceiptRequest, CustomerStatementDto } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";
import { count } from "../helpers/receiptDb";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
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
const owe = (partyId: string, ref: string, minor: bigint) =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
const n = (table: string, where = "1=1") => count(h.db, table, where);
const request = (c: { id: string }, key: string, shares: Array<[string, string]>, reference = "WH-R1"): AllocatedReceiptRequest => ({
  customerId: c.id,
  idempotencyKey: key,
  channel: "whish",
  reference,
  fundsConfirmed: true,
  currency: "USD",
  totalMinor: String(shares.reduce((s, [, a]) => s + Number(a), 0)),
  allocations: shares.map(([obligationId, amountMinor]) => ({ obligationId, amountMinor })),
});
const send = (r: AllocatedReceiptRequest) => ipc.recordAllocatedReceipt(r as never);
const getStatement = (c: { id: string }) => ipc.getCustomerStatement({ customerId: c.id });
const world = () => {
  const c = customer();
  return { c, a: owe(c.id, "A", 6000n), b: owe(c.id, "B", 4000n) };
};
/** Makes the NEXT statement construction fail, as a later step after the commit might. */
function failStatementOnce(): void {
  const real = h.ledger.statementFor.bind(h.ledger);
  let boom = true;
  h.ledger.statementFor = (id: string) => {
    if (boom) {
      boom = false;
      throw new Error("statement construction failed after the commit");
    }
    return real(id);
  };
}

describe("🔴 finding R1 — a recorded receipt does not leave the form blocked", () => {
  it("the receipt commits, the statement fails, the failure answer says RECORDED, and reconciliation confirms it from the ledger alone", () => {
    const { c, a, b } = world();
    const req = request(c, "receipt-r1-0001", [[a.id, "6000"], [b.id, "4000"]]);
    failStatementOnce();
    const r = send(req);
    // (1)–(3) the commit happened, the response failed, and the truth read from the ledger is "recorded"
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe("PAYMENT_RECORDED");
    // the database holds EXACTLY one receipt and its allocations — nothing more
    expect([n("receipts"), n("settlements", "receipt_id IS NOT NULL"), n("settlements")]).toEqual([1, 2, 2]);
    // (4)–(6) the form asks the ledger: the attempt is CLOSED, so it is absent from the open list…
    const statement = ok<CustomerStatementDto>(getStatement(c));
    expect(statement.pendingReceipts).toEqual([]);
    // …and that absence alone is NOT proof of anything, but the receipt the ledger shows IS: recorded
    expect(reconcileReceiptOutcome(statement, "receipt-r1-0001", req)).toBe("recorded");
    // (7) the owner is not trapped: the statement is the refreshed one, both debts are settled, and the exact
    // same request is answered as a DUPLICATE by the ledger — so leaving through the duplicate outcome is true
    expect(statement.obligations.map((o) => o.outstanding.minor)).toEqual(["0", "0"]);
    expect(ok<{ duplicate: boolean }>(send(req)).duplicate).toBe(true);
    // no second receipt, no second settlement, from any of it
    expect([n("receipts"), n("settlements", "receipt_id IS NOT NULL"), n("settlements")]).toEqual([1, 2, 2]);
  });

  it("the reconciliation itself writes NOTHING: reading the statement and deciding changes no row", () => {
    const { c, a, b } = world();
    const req = request(c, "receipt-r1-0002", [[a.id, "6000"], [b.id, "4000"]]);
    failStatementOnce();
    send(req);
    const before = [n("receipts"), n("settlements"), n("receipt_attempts"), n("collection_attempts")];
    for (let i = 0; i < 3; i += 1) reconcileReceiptOutcome(ok<CustomerStatementDto>(getStatement(c)), "receipt-r1-0002", req);
    expect([n("receipts"), n("settlements"), n("receipt_attempts"), n("collection_attempts")]).toEqual(before);
  });

  it("🔴 a FAILED reconciliation lookup is 'unknown' — blocked, and never a false success", () => {
    const { c, a, b } = world();
    const req = request(c, "receipt-r1-0003", [[a.id, "6000"], [b.id, "4000"]]);
    failStatementOnce();
    send(req);
    failStatementOnce(); // the reconciliation read fails too
    const lookup = getStatement(c);
    expect(lookup.ok).toBe(false);
    expect(reconcileReceiptOutcome(null, "receipt-r1-0003", req)).toBe("unknown");
    expect(n("receipts")).toBe(1); // still exactly the committed one
  });

  it("'absent' is NOT 'not recorded': a statement with no open attempt and no matching receipt gives no answer at all", () => {
    const { c, a, b } = world();
    const req = request(c, "receipt-r1-0004", [[a.id, "6000"], [b.id, "4000"]]);
    const empty = ok<CustomerStatementDto>(getStatement(c)); // nothing recorded, nothing pending
    expect(reconcileReceiptOutcome(empty, "receipt-r1-0004", req)).toBe("absent");
    expect(reconcileReceiptOutcome(empty, "receipt-r1-0004", req)).not.toBe("not_recorded");
  });

  it("only THIS receipt counts as evidence: the same reference with other shares, another total or another provider is not 'recorded'", () => {
    const { c, a, b } = world();
    ok(send(request(c, "receipt-r1-0005", [[a.id, "6000"], [b.id, "4000"]]))); // a real receipt: WH-R1, 6000+4000
    const statement = ok<CustomerStatementDto>(getStatement(c));
    const mine = request(c, "receipt-r1-0005", [[a.id, "6000"], [b.id, "4000"]]);
    expect(reconcileReceiptOutcome(statement, "receipt-r1-0005", mine)).toBe("recorded");
    // a DIFFERENT intent that happens to share the reference is not recorded evidence for it
    expect(reconcileReceiptOutcome(statement, "receipt-r1-9999", request(c, "receipt-r1-9999", [[a.id, "7000"], [b.id, "3000"]]))).toBe("absent");
    expect(reconcileReceiptOutcome(statement, "receipt-r1-9998", { ...mine, totalMinor: "10001" })).toBe("absent");
    expect(reconcileReceiptOutcome(statement, "receipt-r1-9997", { ...mine, channel: "bank_transfer" })).toBe("absent");
    expect(reconcileReceiptOutcome(statement, "receipt-r1-9996", { ...mine, allocations: [mine.allocations[0]!] })).toBe("absent");
  });

  it("genuine open outcomes keep their own answers: not_recorded re-offers the exact retry; unknown and conflict stay locked", () => {
    const { c, a, b } = world();
    const req = request(c, "receipt-r1-0006", [[a.id, "6000"], [b.id, "4000"]]);
    h.db.exec("CREATE TRIGGER test_seal_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
    send(req);
    h.db.exec("DROP TRIGGER test_seal_fault");
    const statement = ok<CustomerStatementDto>(getStatement(c));
    expect(statement.pendingReceipts.map((p) => p.status)).toEqual(["not_recorded"]);
    expect(reconcileReceiptOutcome(statement, "receipt-r1-0006", req)).toBe("not_recorded");
    // the original key still records exactly once, afterwards
    expect(ok<{ duplicate: boolean }>(send(req)).duplicate).toBe(false);
    expect(n("receipts")).toBe(1);
    // statuses reported by the ledger for an open attempt are passed through untouched
    const fake = (status: "unknown" | "conflict"): CustomerStatementDto => ({ ...statement, pendingReceipts: [{ ...(statement.pendingReceipts[0] ?? { idempotencyKey: "k", total: { minor: "1", currency: "USD" }, provider: "whish", reference: "R", allocations: [], createdAt: "" }), idempotencyKey: "receipt-r1-0007", status }] });
    expect(reconcileReceiptOutcome(fake("unknown"), "receipt-r1-0007", req)).toBe("unknown");
    expect(reconcileReceiptOutcome(fake("conflict"), "receipt-r1-0007", req)).toBe("conflict");
  });
});

describe("🔴 finding R2 — 'recorded' must be proven for the ORIGINAL idempotency key", () => {
  it("the statement carries each receipt's original key, read from the ledger", () => {
    const { c, a, b } = world();
    ok(send(request(c, "receipt-r2-0001", [[a.id, "6000"], [b.id, "4000"]])));
    const shares = ok<CustomerStatementDto>(getStatement(c)).obligations.flatMap((o) => o.settlements);
    expect(shares).toHaveLength(2);
    for (const s of shares) expect(s.receipt?.idempotencyKey).toBe("receipt-r2-0001");
  });

  it("committed receipt K1 + the SAME request under K1 → recorded; under a DIFFERENT key K2 with identical details → NOT recorded", () => {
    const { c, a, b } = world();
    const k1 = request(c, "receipt-r2-k1", [[a.id, "6000"], [b.id, "4000"]]);
    failStatementOnce();
    expect(send(k1).ok).toBe(false); // committed; the response failed
    const statement = ok<CustomerStatementDto>(getStatement(c));
    expect(reconcileReceiptOutcome(statement, "receipt-r2-k1", k1)).toBe("recorded");
    const k2 = { ...k1, idempotencyKey: "receipt-r2-k2" }; // otherwise IDENTICAL: provider, reference, total, shares
    const answer = reconcileReceiptOutcome(statement, "receipt-r2-k2", k2);
    expect(answer).not.toBe("recorded");
    expect(answer).toBe("absent"); // no evidence for K2 — and, equally, no claim that K2 was not recorded
    expect(answer).not.toBe("not_recorded");
    // and the ledger itself agrees: K2 is not recorded as a second receipt — it is refused as a duplicate reference
    const r = send(k2);
    expect(r.ok).toBe(false);
    expect([n("receipts"), n("settlements", "receipt_id IS NOT NULL")]).toEqual([1, 2]);
  });

  it("an OPEN attempt under the same key whose stored intent is NOT this request fails closed as 'conflict' (its status is not trusted)", () => {
    const { c, a, b } = world();
    h.db.exec("CREATE TRIGGER test_seal_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
    send(request(c, "receipt-r2-0002", [[a.id, "6000"], [b.id, "4000"]])); // open, provably not recorded
    h.db.exec("DROP TRIGGER test_seal_fault");
    const statement = ok<CustomerStatementDto>(getStatement(c));
    expect(statement.pendingReceipts.map((p) => p.status)).toEqual(["not_recorded"]);
    const same = request(c, "receipt-r2-0002", [[a.id, "6000"], [b.id, "4000"]]);
    expect(reconcileReceiptOutcome(statement, "receipt-r2-0002", same)).toBe("not_recorded"); // genuine: exact retry allowed
    const variants: AllocatedReceiptRequest[] = [
      { ...same, allocations: [{ obligationId: a.id, amountMinor: "7000" }, { obligationId: b.id, amountMinor: "3000" }] },
      { ...same, totalMinor: "10001" },
      { ...same, reference: "WH-OTHER" },
      { ...same, channel: "bank_transfer" },
      { ...same, currency: "LBP" },
      { ...same, allocations: [same.allocations[0]!] },
    ];
    for (const v of variants) expect(reconcileReceiptOutcome(statement, "receipt-r2-0002", v)).toBe("conflict");
    // the original key and intent still record exactly once afterwards
    expect(ok<{ duplicate: boolean }>(send(same)).duplicate).toBe(false);
    expect(n("receipts")).toBe(1);
  });

  it("the R1 behaviours still hold with the key check: failed lookup → unknown; open unknown/conflict pass through when the intent matches", () => {
    const { c, a, b } = world();
    const req = request(c, "receipt-r2-0003", [[a.id, "6000"], [b.id, "4000"]]);
    expect(reconcileReceiptOutcome(null, "receipt-r2-0003", req)).toBe("unknown");
    h.db.exec("CREATE TRIGGER test_seal_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
    send(req);
    h.db.exec("DROP TRIGGER test_seal_fault");
    const real = ok<CustomerStatementDto>(getStatement(c));
    const withStatus = (status: "unknown" | "conflict"): CustomerStatementDto => ({ ...real, pendingReceipts: real.pendingReceipts.map((p) => ({ ...p, status })) });
    expect(reconcileReceiptOutcome(withStatus("unknown"), "receipt-r2-0003", req)).toBe("unknown");
    expect(reconcileReceiptOutcome(withStatus("conflict"), "receipt-r2-0003", req)).toBe("conflict");
  });

  it("two receipts with identical details cannot both exist, but a receipt under another key is never counted for this one even if it is the only match", () => {
    const { c, a, b } = world();
    ok(send(request(c, "receipt-r2-k1b", [[a.id, "6000"], [b.id, "4000"]])));
    const statement = ok<CustomerStatementDto>(getStatement(c));
    for (const k of ["receipt-r2-k2b", "receipt-r2-", "RECEIPT-R2-K1B"]) {
      expect(reconcileReceiptOutcome(statement, k, request(c, k, [[a.id, "6000"], [b.id, "4000"]]))).toBe("absent");
    }
  });
});
