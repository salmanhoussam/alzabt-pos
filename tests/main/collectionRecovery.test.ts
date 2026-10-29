/**
 * M17A final safety gate — an UNKNOWN collection outcome is recovered from the ledger, under the
 * ORIGINAL key, across navigation, a closed window and a restart; and the owner role is re-read
 * INSIDE the write transaction.
 *
 * 🔴 WHAT THESE PROTECT
 *   · the intent is committed BEFORE the settlement can exist, with the original key;
 *   · an attempt the ledger can answer is answered (recorded / provably not recorded) and a new
 *     collection is then allowed; one it CANNOT answer keeps new collections closed;
 *   · a failed lookup is never read as "not recorded";
 *   · the exact repeat (same key, same payload) never collects twice, with or without the attempt row;
 *   · a demoted operator can neither record nor recover, and writes nothing.
 *
 * Synthetic data only; real SQLite; `amountMinor` is MINOR units.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerService } from "../../src/application/ledgerService";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { CustomerStatementDto, RecordPaymentResponse } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

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

const customer = (name = "زبون") => h.parties.create({ kind: "customer", displayName: name }).party;
const owe = (partyId: string, ref: string, minor: bigint) =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
const req = (c: { id: string }, o: { id: string }, key: string, amountMinor: string, method = "cash", extra: Record<string, unknown> = {}) => ({
  customerId: c.id,
  obligationId: o.id,
  idempotencyKey: key,
  amountMinor,
  method,
  ...extra,
});
const pay = (r: unknown) => ipc.recordCustomerPayment(r as never);
const statement = (c: { id: string }) => ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
const settlements = () => Number((h.db.prepare("SELECT count(*) AS n FROM settlements").get() as { n: bigint }).n);
const attempts = () => h.db.prepare("SELECT * FROM collection_attempts ORDER BY created_at, idempotency_key").all() as Array<Record<string, unknown>>;
/** Make the settlement INSERT fail like an unexpected internal fault (not a business refusal). */
const breakSettlements = () =>
  h.db.exec("CREATE TRIGGER test_settle_fault BEFORE INSERT ON settlements BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
const mendSettlements = () => h.db.exec("DROP TRIGGER test_settle_fault");

describe("the intent is durable before the money can move", () => {
  it("🔴 an internal fault leaves the ORIGINAL attempt open, intact and recoverable — with nothing settled", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    const r = pay(req(c, o, "key-orig-000001", "1250", "whish", { reference: "WH-RECOVER", fundsConfirmed: true }));
    expect(r.ok).toBe(false);
    expect(settlements()).toBe(0);
    const row = attempts()[0]!;
    expect([row.idempotency_key, row.customer_id, row.obligation_id, row.currency, row.channel, row.reference, Number(row.funds_confirmed), Number(row.amount_minor)]).toEqual([
      "key-orig-000001", c.id, o.id, "USD", "whish", "WH-RECOVER", 1, 1250,
    ]);
    expect(row.resolved_at).toBeNull();
    // The statement REPORTS it, read from the ledger, with the ledger's answer.
    const p = statement(c).pendingCollections;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ idempotencyKey: "key-orig-000001", obligationId: o.id, amount: { minor: "1250", currency: "USD" }, method: "whish", reference: "WH-RECOVER", fundsConfirmed: true, status: "not_recorded" });
  });

  it("🔴 survives a closed window AND a restart, and the exact repeat then collects ONCE under the original key", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    pay(req(c, o, "key-orig-000002", "700", "bank_transfer", { reference: "BT-1", fundsConfirmed: true }));
    mendSettlements(); // the fault was transient; the attempt row is what persisted
    h.db.close();
    open(); // restart: nothing of the screen's memory exists any more
    const p = statement(c).pendingCollections;
    expect(p.map((x) => [x.idempotencyKey, x.status])).toEqual([["key-orig-000002", "not_recorded"]]);
    const repeat = ok<RecordPaymentResponse>(pay(req(c, o, "key-orig-000002", "700", "bank_transfer", { reference: "BT-1", fundsConfirmed: true })));
    expect(repeat.duplicate).toBe(false);
    expect(settlements()).toBe(1);
    expect(statement(c).pendingCollections).toEqual([]); // closed atomically with its settlement
    expect(attempts()[0]!.resolution).toBe("recorded");
    // …and a further repeat is a duplicate, not a second collection.
    expect(ok<RecordPaymentResponse>(pay(req(c, o, "key-orig-000002", "700", "bank_transfer", { reference: "BT-1", fundsConfirmed: true }))).duplicate).toBe(true);
    expect(settlements()).toBe(1);
  });

  it("a lost RESPONSE after a successful commit leaves nothing open and a replay is a duplicate", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    ok(pay(req(c, o, "key-lost-000001", "300", "card"))); // committed; imagine the answer never arrived
    expect(statement(c).pendingCollections).toEqual([]);
    expect(ok<RecordPaymentResponse>(pay(req(c, o, "key-lost-000001", "300", "card"))).duplicate).toBe(true);
    expect(settlements()).toBe(1);
  });

  it("a refused payment (a business rule) leaves NO attempt, and a clean refusal after the attempt closes it", () => {
    const c = customer();
    const o = owe(c.id, "b1", 500n);
    expect(errCode(pay(req(c, o, "key-bad-0000001", "100", "whish")))).toBe("INVALID_INPUT"); // no reference
    expect(attempts()).toHaveLength(0);
    expect(errCode(pay(req(c, o, "key-bad-0000002", "501", "card")))).toBe("INVALID_AMOUNT"); // overpayment
    expect(attempts().map((a) => [a.idempotency_key, a.resolution])).toEqual([["key-bad-0000002", "not_recorded"]]);
    expect(statement(c).pendingCollections).toEqual([]);
  });

  it("the same key with a DIFFERENT intent conflicts, whether the attempt is open or closed", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    pay(req(c, o, "key-conf-000001", "400", "card"));
    mendSettlements();
    expect(errCode(pay(req(c, o, "key-conf-000001", "401", "card")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(errCode(pay(req(c, o, "key-conf-000001", "400", "cash")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(settlements()).toBe(0);
  });
});

describe("a new collection only after a trustworthy answer", () => {
  it("🔴 an attempt the ledger proves was not recorded is closed, and then a NEW key is allowed", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    pay(req(c, o, "key-first-00001", "400", "card"));
    mendSettlements();
    ok(pay(req(c, o, "key-second-0001", "200", "card")));
    expect(attempts().map((a) => [a.idempotency_key, a.resolution]).sort()).toEqual([
      ["key-first-00001", "not_recorded"],
      ["key-second-0001", "recorded"],
    ]);
    expect(settlements()).toBe(1);
  });

  it("🔴 a closed NOT-RECORDED key cannot later post money under its original key", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    pay(req(c, o, "key-closed-00001", "400", "card"));
    mendSettlements();
    // A separate collection closes the earlier, provably unrecorded attempt.
    ok(pay(req(c, o, "key-replace-0001", "200", "card")));
    expect(attempts().find((a) => a.idempotency_key === "key-closed-00001")!.resolution).toBe("not_recorded");
    // A delayed replay must NOT turn the permanently closed attempt into another settlement.
    expect(errCode(pay(req(c, o, "key-closed-00001", "400", "card")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(settlements()).toBe(1);
    expect(attempts().find((a) => a.idempotency_key === "key-closed-00001")!.resolution).toBe("not_recorded");
    // The SQLite backstop refuses a late settlement even if the service is bypassed.
    const ownerId = (h.db.prepare("SELECT id FROM operators LIMIT 1").get() as { id: string }).id;
    expect(() => h.db.prepare(
      `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date)
       VALUES ('closed-late-01', ?, 'USD', 'key-closed-00001', 'fingerprint', 400, 'card', ?, '2026-10-24T09:00:00.000Z', '2026-10-24')`,
    ).run(o.id, ownerId)).toThrow(/closed collection attempt/);
    expect(settlements()).toBe(1);
  });

  it("🔴 a FAILED lookup is never read as 'not recorded': the status is unknown and a new key is refused", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    pay(req(c, o, "key-unk-0000001", "400", "card"));
    mendSettlements();
    const real = h.ledgerStore.findSettlementByIdempotencyKey.bind(h.ledgerStore);
    // Only THIS attempt's lookup fails; a new key's own lookup works — the refusal must come from the
    // unanswerable earlier attempt, not from a general outage.
    h.ledgerStore.findSettlementByIdempotencyKey = (k: string) => {
      if (k === "key-unk-0000001") throw new Error("lookup failed");
      return real(k);
    };
    try {
      expect(statement(c).pendingCollections.map((p) => p.status)).toEqual(["unknown"]);
      expect(errCode(pay(req(c, o, "key-new-00000001", "100", "card")))).toBe("COLLECTION_UNRESOLVED");
      expect(attempts()).toHaveLength(1); // no second attempt was minted
    } finally {
      h.ledgerStore.findSettlementByIdempotencyKey = real;
    }
    // Once the ledger can be read again the same state resolves — and nothing was ever settled in between.
    expect(statement(c).pendingCollections.map((p) => p.status)).toEqual(["not_recorded"]);
    expect(settlements()).toBe(0);
  });

  it("🔴 a settlement under the key that is a DIFFERENT payment is a conflict and keeps new collections closed", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    pay(req(c, o, "key-cfl-0000001", "400", "card"));
    mendSettlements();
    const op = (h.db.prepare("SELECT id FROM operators LIMIT 1").get() as { id: string }).id;
    h.db
      .prepare(
        `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date)
         VALUES ('s-x', ?, 'USD', 'key-cfl-0000001', 'a-different-fingerprint', 100, 'cash', ?, '2026-10-24T09:00:00.000Z', '2026-10-24')`,
      )
      .run(o.id, op);
    expect(statement(c).pendingCollections.map((p) => p.status)).toEqual(["conflict"]);
    expect(errCode(pay(req(c, o, "key-new-00000002", "100", "card")))).toBe("COLLECTION_UNRESOLVED");
  });

  it("an attempt still open although its settlement committed (damaged bookkeeping) reads as recorded and closes on the exact repeat", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    ok(pay(req(c, o, "key-dmg-0000001", "250", "cash")));
    h.db.exec("DROP TRIGGER collection_attempts_resolve_once");
    h.db.exec("UPDATE collection_attempts SET resolved_at = NULL, resolution = NULL");
    expect(statement(c).pendingCollections.map((p) => p.status)).toEqual(["recorded"]);
    expect(ok<RecordPaymentResponse>(pay(req(c, o, "key-dmg-0000001", "250", "cash"))).duplicate).toBe(true);
    expect(settlements()).toBe(1);
  });

  it("🔴 MISSING pending state cannot cause a second collection: the settlement's own key still replays", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    ok(pay(req(c, o, "key-gone-000001", "250", "cash")));
    h.db.exec("DROP TRIGGER collection_attempts_no_delete");
    h.db.exec("DELETE FROM collection_attempts");
    expect(statement(c).pendingCollections).toEqual([]);
    expect(ok<RecordPaymentResponse>(pay(req(c, o, "key-gone-000001", "250", "cash"))).duplicate).toBe(true);
    expect(settlements()).toBe(1);
    expect(attempts()).toHaveLength(0); // the settlement is the record; no attempt is invented for it
  });

  it("the attempt can only be closed, once — never edited or deleted", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    ok(pay(req(c, o, "key-imm-0000001", "250", "cash")));
    expect(() => h.db.prepare("UPDATE collection_attempts SET amount_minor = 1").run()).toThrow(/resolved, once/);
    expect(() => h.db.prepare("UPDATE collection_attempts SET resolution = 'not_recorded'").run()).toThrow(/resolved, once/);
    expect(() => h.db.prepare("DELETE FROM collection_attempts").run()).toThrow(/cannot be deleted/);
  });

  it("an attempt carries no secret: only ids, an amount, a channel and the validated reference", () => {
    const cols = (h.db.pragma("table_info('collection_attempts')") as Array<{ name: string }>).map((x) => x.name).sort();
    expect(cols).toEqual(
      ["amount_minor", "channel", "created_at", "created_by", "currency", "customer_id", "funds_confirmed", "idempotency_key", "obligation_id", "reference", "request_fingerprint", "resolution", "resolved_at"].sort(),
    );
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    expect(errCode(pay(req(c, o, "key-pan-0000001", "100", "card", { reference: "4111 1111 1111 1111" })))).toBe("INVALID_INPUT");
    expect(attempts()).toHaveLength(0); // a card number never even reaches the table
  });
});

describe("the live owner role is re-read INSIDE the transaction", () => {
  /**
   * A second LedgerService over the SAME database whose operator is an owner at the outer check and
   * is DEMOTED the instant a write transaction begins (counted: demote on the Nth `transact`).
   */
  function demotedOnTransaction(n: number): { ledger: LedgerService; calls: () => number } {
    let role: "owner" | "cashier" = "owner";
    let transactions = 0;
    const ledger = new LedgerService({
      ledger: h.ledgerStore,
      parties: h.partyStore,
      actor: () => ({ id: "cashier-01", name: "Owner", role }),
      transact: (fn) =>
        h.db
          .transaction(() => {
            transactions += 1;
            if (transactions === n) role = "cashier"; // demoted between the outer check and the write
            return fn();
          })
          .immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
    return { ledger, calls: () => transactions };
  }
  const draft = (c: { id: string }, o: { id: string }, key: string) => ({
    customerId: c.id,
    partyId: c.id,
    obligationId: o.id,
    idempotencyKey: key,
    amountMinor: 300n,
    method: "card",
    channel: "card",
  });

  it("🔴 demoted before the INTENT is written: not authorized, and NOTHING is written", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    const { ledger } = demotedOnTransaction(1);
    expect(() => ledger.collect(draft(c, o, "key-role-0000001"))).toThrow(/owner|operator changed/i);
    expect(attempts()).toHaveLength(0);
    expect(settlements()).toBe(0);
  });

  it("🔴 demoted before the SETTLEMENT commits: no money is recorded and the attempt is left exactly as it was", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    const { ledger } = demotedOnTransaction(2);
    let code = "";
    try {
      ledger.collect(draft(c, o, "key-role-0000002"));
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("NOT_AUTHORIZED");
    expect(settlements()).toBe(0);
    const row = attempts()[0]!;
    expect(row.resolved_at).toBeNull(); // untouched: a failed authorization writes nothing more
  });

  it("🔴 a demoted operator cannot RECOVER either: the open-collections read and the exact repeat both refuse", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    breakSettlements();
    pay(req(c, o, "key-role-0000003", "300", "card"));
    mendSettlements();
    h.service.login("cashier-02", "2222"); // a genuine cashier on the same terminal
    expect(errCode(ipc.getCustomerStatement({ customerId: c.id }))).toBe("NOT_AUTHORIZED");
    expect(errCode(pay(req(c, o, "key-role-0000003", "300", "card")))).toBe("NOT_AUTHORIZED");
    expect(settlements()).toBe(0);
    expect(attempts()[0]!.resolved_at).toBeNull();
    // The owner, signing back in, recovers it.
    h.service.login("cashier-01", "1111");
    expect(statement(c).pendingCollections.map((p) => p.status)).toEqual(["not_recorded"]);
    ok(pay(req(c, o, "key-role-0000003", "300", "card")));
    expect(settlements()).toBe(1);
  });

  it("the legacy settle() path re-reads the role in its transaction too", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    const { ledger } = demotedOnTransaction(1);
    expect(() =>
      ledger.settle({ obligationId: o.id, partyId: c.id, idempotencyKey: "key-role-0000004", amountMinor: 100n, method: "cash" }),
    ).toThrow(/owner|operator changed/i);
    expect(settlements()).toBe(0);
  });
});
