/**
 * S3C — an OWNER recording cash against an EXISTING customer debt, over the real IPC handlers.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS GUARDING. This is the first channel in the product that moves money on a
 * customer's account, so the dangerous bugs are the ones that take money twice, take it from the
 * wrong person, or record it against the wrong debt — each of which looks perfectly ordinary in a
 * green log. Every one is asserted here against a real SQLite ledger with its real triggers.
 *
 * 🔴 THE RETRY TESTS ARE THE POINT OF THE FILE. A lost response after a successful commit is the
 * one failure a shop cannot see: the owner is told nothing happened, collects again, and the
 * customer pays twice. So the same key replayed with the same payload must return the committed
 * payment and NOT insert a second one, and the same key with a different amount must be refused.
 *
 * Driven through `createIpcHandlers`' real table, so the channel policy, the payload validation
 * and the DTO shape are exercised exactly as the renderer meets them.
 *
 * Disposable database per test. Synthetic names and amounts only — no merchant data.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers, paymentFailureTruth } from "../../src/main/ipcHandlers";
import { LedgerService } from "../../src/application/ledgerService";
import { PartyService } from "../../src/application/partyService";
import { LedgerRepository } from "../../src/persistence/ledgerRepository";
import { PartyRepository } from "../../src/persistence/partyRepository";
import { accessFor } from "../../src/main/channelPolicy";
import type { CustomerStatementDto, RecordPaymentResponse } from "../../src/shared/ipcContract";
import { call, errorText } from "../../src/renderer/api";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
let ledger: LedgerService;
let parties: PartyService;
let role: "owner" | "cashier" | null;

const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code);
const errMsg = (r: { ok: boolean; error?: { message: string } }) => (r.ok ? "" : r.error!.message);

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  role = "owner";
  let n = 0;
  const actor = () => (role === null ? null : { id: role === "owner" ? "cashier-01" : "cashier-02", name: "Op", role });
  parties = new PartyService({
    parties: new PartyRepository(h.db),
    actor,
    transact: (fn) => h.db.transaction(fn).immediate(),
    newId: () => `party-${++n}`,
  });
  ledger = new LedgerService({
    ledger: new LedgerRepository(h.db),
    parties: new PartyRepository(h.db),
    actor,
    transact: (fn) => h.db.transaction(fn).immediate(),
    terminal: { timeZone: "Asia/Beirut" },
    saleCurrency: (id) => {
      const row = h.db.prepare(`SELECT currency FROM sales WHERE id = ?`).get(id) as { currency: string } | undefined;
      return row?.currency ?? null;
    },
    newId: () => `led-${++n}`,
  });
  ipc = syncHandlers(createIpcHandlers(h.service, { parties, ledger }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

/**
 * 🔴 BECOME A REAL CASHIER, NOT JUST A TEST FLAG.
 *
 * `authorize()` in the IPC layer calls `service.requireLiveRole()`, which re-reads the DURABLE
 * operator row — it does not look at this file's `role` variable. The harness logs in as
 * `cashier-01`, whose display name says "Cashier One" and whose ROLE IS OWNER (the Migration 8
 * seed trap). So flipping `role` alone leaves the channel-policy gate wide open and tests only the
 * service's own check. Logging in as `cashier-02` — the genuinely cashier-roled fixture — engages
 * BOTH gates, which is what "direct-bridge refusal" is supposed to mean.
 *
 * My first draft did only the former, and a leak test caught it by getting two different refusal
 * messages where a cashier should never have reached the handler body at all.
 */
const becomeCashier = () => {
  role = "cashier";
  h.service.login("cashier-02", "2222");
};

const customer = (name: string, phone?: string) => parties.create({ kind: "customer", displayName: name, phone }).party;
const supplier = (name: string) => parties.create({ kind: "supplier", displayName: name }).party;

const owe = (partyId: string, ref: string, minor: bigint, currency = "USD", direction: "receivable" | "payable" = "receivable") =>
  ledger.postObligation({ partyId, direction, sourceKind: "manual", sourceRef: ref, currency, amountMinor: minor }).record;

/**
 * 🔴 `amountMinor` IS MINOR UNITS, NOT A TYPED DECIMAL. "400" is four dollars, not four hundred.
 * The renderer turns what the owner types into this with the domain's `parseDecimal`; the contract
 * itself only ever carries minor units as a string, like every other amount in this product. My
 * first draft of this file passed "4.00" here and every single test failed with INVALID_INPUT —
 * which is the contract working, and is why the unit is spelled out here.
 */
const payReq = (customerId: string, obligationId: string, key: string, amountMinor: string) => ({
  customerId,
  obligationId,
  idempotencyKey: key,
  amountMinor,
  method: "cash" as const,
});

const settlementRows = () =>
  Number((h.db.prepare(`SELECT count(*) AS n FROM settlements`).get() as { n: number | bigint }).n);

const outstandingOf = (st: CustomerStatementDto, obligationId: string) =>
  st.obligations.find((o) => o.id === obligationId)!.outstanding.minor;

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The happy paths — and the arithmetic nobody is allowed to do twice
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("recording a payment", () => {
  it("settles a debt IN FULL and reports zero outstanding, fullyPaid", () => {
    const c = customer("أبو خالد");
    const o = owe(c.id, "bill-1", 1000n);
    const r = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-full-01", "1000")));

    expect(r.duplicate).toBe(false);
    expect(r.settlement.amount).toEqual({ minor: "1000", currency: "USD" });
    expect(r.settlement.method).toBe("cash");
    // 🔴 THE REFRESHED STATEMENT TRAVELS WITH THE RESULT, so the screen never subtracts anything.
    expect(outstandingOf(r.statement, o.id)).toBe("0");
    expect(r.statement.obligations[0]!.fullyPaid).toBe(true);
    expect(r.statement.balances).toEqual([{ minor: "0", currency: "USD" }]);
  });

  it("settles PARTIALLY and the remainder is what is left, not what was paid", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const r = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-part-01", "400")));

    expect(outstandingOf(r.statement, o.id)).toBe("600");
    expect(r.statement.obligations[0]!.fullyPaid).toBe(false);
    expect(r.statement.obligations[0]!.amount.minor).toBe("1000"); // 🔴 the ORIGINAL is untouched
  });

  it("takes SEVERAL legitimate partial payments and walks the balance down to settled", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const after = (key: string, amt: string) =>
      ok<RecordPaymentResponse>(ipc.recordCustomerPayment(payReq(c.id, o.id, key, amt)));

    expect(outstandingOf(after("key-a-0001", "250").statement, o.id)).toBe("750");
    expect(outstandingOf(after("key-b-0002", "250").statement, o.id)).toBe("500");
    const last = after("key-c-0003", "500");
    expect(outstandingOf(last.statement, o.id)).toBe("0");
    expect(last.statement.obligations[0]!.fullyPaid).toBe(true);
    // Three payments, all three in the history, in one obligation.
    expect(last.statement.obligations[0]!.settlements).toHaveLength(3);
    expect(settlementRows()).toBe(3);
  });

  it("the payment appears in the statement history with its amount, method and date", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const r = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-hist-01", "300")));
    const [s] = r.statement.obligations[0]!.settlements;
    expect(s!.amount).toEqual({ minor: "300", currency: "USD" });
    expect(s!.method).toBe("cash");
    expect(s!.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("🔴 the obligation row itself is byte-identical before and after a payment", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const before = h.db.prepare(`SELECT * FROM obligations WHERE id = ?`).get(o.id);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-imm-001", "400"));
    expect(h.db.prepare(`SELECT * FROM obligations WHERE id = ?`).get(o.id)).toEqual(before);
  });

  it("🔴 the history is DURABLE — it is on disk, not in memory", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-dur-0001", "400"));
    // Read it back through a brand-new repository over the same file.
    const fresh = new LedgerRepository(h.db);
    const rows = fresh.listSettlements(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountMinor).toBe(400n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Idempotency — the half of this slice that stops a customer paying twice
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("idempotency", () => {
  it("🔴 the SAME key with the SAME payload posts EXACTLY ONCE and says duplicate", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const req = payReq(c.id, o.id, "key-retry-01", "400");

    const first = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(req));
    const again = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(req));

    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    // 🔴 THE SAME ROW, not a second one that happens to match.
    expect(again.settlement.id).toBe(first.settlement.id);
    expect(settlementRows()).toBe(1);
    // 🔴 AND THE MONEY DID NOT MOVE TWICE.
    expect(outstandingOf(again.statement, o.id)).toBe("600");
  });

  it("🔴 a replay survives many attempts — ten retries are still one payment", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const req = payReq(c.id, o.id, "key-retry-10", "100");
    for (let i = 0; i < 10; i++) ipc.recordCustomerPayment(req);
    expect(settlementRows()).toBe(1);
    expect(outstandingOf(ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id })), o.id)).toBe("900");
  });

  it("🔴 the SAME key with a DIFFERENT amount is REFUSED — not silently re-posted", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-conflict", "400"));
    const clash = ipc.recordCustomerPayment(payReq(c.id, o.id, "key-conflict", "500"));
    expect(errCode(clash)).toBe("IDEMPOTENCY_CONFLICT");
    expect(settlementRows()).toBe(1);
  });

  it("🔴 a key is required, and a malformed one is refused before anything is written", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    for (const bad of ["", "short", "has space!", "x".repeat(101)]) {
      expect(errCode(ipc.recordCustomerPayment(payReq(c.id, o.id, bad, "100")))).toBe("INVALID_INPUT");
    }
    expect(settlementRows()).toBe(0);
  });

  it("🔴 two DIFFERENT keys are two real payments — the guard is not refusing everything", () => {
    // THE ANTI-VACUITY CONTROL for the three tests above.
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-two-0001", "100"));
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-two-0002", "100"));
    expect(settlementRows()).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The uncertain outcome — what the owner is told when nobody knows
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("an unexpected fault after the attempt", () => {
  const lang = "ar" as const;

  it("🔴 says RECORDED — never inviting a second collection — when the ledger HAS the payment", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-truth-01", "400"));
    const told = paymentFailureTruth(ledger, { idempotencyKey: "key-truth-01" }, lang);
    expect(told.code).toBe("PAYMENT_RECORDED");
    expect(told.message).toContain("لا تُحصّل");
  });

  it("🔴 offers a retry ONLY when the ledger was asked and answered 'no such payment'", () => {
    const told = paymentFailureTruth(ledger, { idempotencyKey: "key-never-used" }, lang);
    expect(told.code).toBe("PAYMENT_NOT_RECORDED");
    expect(told.message).toContain("إعادة المحاولة");
  });

  it("🔴 with NO key the ledger cannot be asked, so NO retry is offered", () => {
    const told = paymentFailureTruth(ledger, {}, lang);
    expect(told.code).toBe("PAYMENT_NOT_RECORDED");
    expect(told.message).not.toContain("إعادة المحاولة");
  });

  it("🔴 when even the lookup fails the answer is UNKNOWN, and it forbids collecting again", () => {
    // 🔴 A SEPARATE, THROWAWAY LEDGER OVER A CLOSED DATABASE. The shared one is left alone so this
    // test cannot leak a broken handle into afterEach or into the next test.
    const t2 = tempDir();
    const h2 = makeHarness(t2.dbPath);
    const broken = new LedgerService({
      ledger: new LedgerRepository(h2.db),
      parties: new PartyRepository(h2.db),
      actor: () => ({ id: "cashier-01", name: "Op", role: "owner" }),
      transact: (fn) => h2.db.transaction(fn).immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
    h2.db.close(); // every read through `broken` now throws

    const told = paymentFailureTruth(broken, { idempotencyKey: "key-truth-01" }, lang);
    expect(told.code).toBe("PAYMENT_STATUS_UNKNOWN");
    expect(told.message).toContain("لا تُحصّل");
    // 🔴 AND IT IS NOT THE RETRY SENTENCE. "Unknown" must never read as "safe to try again".
    expect(told.message).not.toBe(paymentFailureTruth(ledger, { idempotencyKey: "nope-at-all" }, lang).message);
    t2.cleanup();
  });

  it("🔴 the three answers are genuinely different sentences, in both languages", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-lang-001", "400"));
    for (const l of ["ar", "en"] as const) {
      const recorded = paymentFailureTruth(ledger, { idempotencyKey: "key-lang-001" }, l).message;
      const retry = paymentFailureTruth(ledger, { idempotencyKey: "key-unused-xx" }, l).message;
      const noKey = paymentFailureTruth(ledger, {}, l).message;
      expect(new Set([recorded, retry, noKey]).size).toBe(3);
      for (const m of [recorded, retry, noKey]) expect(m.length).toBeGreaterThan(10);
    }
  });

  it("🔴 the Arabic answers carry no English left in them", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-ar-00001", "400"));
    const msgs = [
      paymentFailureTruth(ledger, { idempotencyKey: "key-ar-00001" }, "ar").message,
      paymentFailureTruth(ledger, { idempotencyKey: "key-unused-xx" }, "ar").message,
      paymentFailureTruth(ledger, {}, "ar").message,
    ];
    // 🔴 THE ISO CURRENCY CODE IS ALLOWED TO STAY LATIN, exactly as digits stay 0-9 — it is a code,
    // not English prose. Everything else must be Arabic, so it is stripped before the check rather
    // than the check being loosened into uselessness.
    for (const m of msgs) expect(m.replace(/\b(USD|LBP)\b/g, "")).not.toMatch(/[A-Za-z]{3,}/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Data integrity — every refusal, against the real constraints
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("what the ledger refuses", () => {
  it("formats 3000 USD minor units and carries only the typed overpayment context across IPC", async () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 3000n);
    const result = ipc.recordCustomerPayment(payReq(c.id, o.id, "key-over-format-01", "3001"));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_AMOUNT",
        message: "That is more than is owed; 30.00 USD remains",
        context: {
          reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING",
          outstandingMinor: "3000",
          currency: "USD",
        },
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(settlementRows()).toBe(0);

    for (const [language, expected] of [
      ["en", "That is more than is owed; 30.00 USD remains"],
      ["ar", "المبلغ المدخل أكبر من المتبقي على هذا الدَّين. المتبقي: \u206830.00 USD\u2069."],
    ] as const) {
      let shown = "";
      try {
        await call(Promise.resolve(result));
      } catch (error) {
        shown = errorText(error, language);
      }
      expect(shown).toBe(expected);
      expect(shown).not.toContain("3000 USD");
    }
    expect(settlementRows()).toBe(0);
  });

  it("🔴 refuses OVERPAYMENT, and nothing is written", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    expect(errCode(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-over-001", "1001")))).toBe("INVALID_AMOUNT");
    expect(settlementRows()).toBe(0);
  });

  it("🔴 refuses overpayment ACROSS several payments, not just one oversized one", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-acc-0001", "600"));
    expect(errCode(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-acc-0002", "500")))).toBe("INVALID_AMOUNT");
    expect(settlementRows()).toBe(1);
  });

  it("🔴 refuses ZERO and NEGATIVE amounts", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const zero = ipc.recordCustomerPayment(payReq(c.id, o.id, "key-z-zero-01", "0"));
    expect(errCode(zero)).toBe("INVALID_AMOUNT");
    if (!zero.ok) expect(zero.error).not.toHaveProperty("context");
    for (const bad of ["0", "-100", "-1"]) {
      expect(errCode(ipc.recordCustomerPayment(payReq(c.id, o.id, `key-z-${bad}-x`, bad)))).toBeTruthy();
    }
    expect(settlementRows()).toBe(0);
  });

  it("🔴 there is NO currency parameter — a wrong-currency payment is unrepresentable", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-lbp", 1000n, "LBP");
    // Trying to smuggle one in is refused by the exact-object check, not ignored.
    const r = ipc.recordCustomerPayment({ ...payReq(c.id, o.id, "key-cur-0001", "100"), currency: "USD" });
    expect(errCode(r)).toBe("INVALID_INPUT");
    // And the honest call settles in the OBLIGATION's currency, which main chose, not the caller.
    const good = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-cur-0002", "100")));
    expect(good.settlement.amount.currency).toBe("LBP");
  });

  it("🔴 USD and LBP never mix — two debts, two balances, neither summed", () => {
    const c = customer("زبون");
    const usd = owe(c.id, "bill-usd", 5000n, "USD");
    const lbp = owe(c.id, "bill-lbp", 9000n, "LBP");
    ipc.recordCustomerPayment(payReq(c.id, usd.id, "key-mix-0001", "1000"));
    const st = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(payReq(c.id, lbp.id, "key-mix-0002", "2000"))).statement;
    expect(st.balances).toEqual([
      { minor: "7000", currency: "LBP" },
      { minor: "4000", currency: "USD" },
    ]);
    // 🔴 NOTHING EQUALS THE TWO ADDED TOGETHER.
    expect(st.balances.map((b) => b.minor)).not.toContain("11000");
  });

  it("🔴 refuses a payment aimed at ANOTHER customer's debt", () => {
    const a = customer("محمد علي", "0111111");
    const b = customer("محمد علي", "0222222"); // the same name, deliberately
    const oa = owe(a.id, "bill-a", 1000n);
    // B tries to pay A's debt: the party id is compared to the obligation's own, not the name.
    expect(errCode(ipc.recordCustomerPayment(payReq(b.id, oa.id, "key-cross-01", "100")))).toBe("INVALID_INPUT");
    expect(settlementRows()).toBe(0);
  });

  it("🔴 a SUPPLIER payable is not reachable as a customer debt", () => {
    const s = supplier("مورّد");
    const o = owe(s.id, "bill-sup", 1000n, "USD", "payable");
    const c = customer("زبون");
    expect(errCode(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-sup-0001", "100")))).toBe("INVALID_INPUT");
    // Even naming the supplier itself fails: the handler reads the party as a CUSTOMER.
    expect(errCode(ipc.recordCustomerPayment(payReq(s.id, o.id, "key-sup-0002", "100")))).toBeTruthy();
    expect(settlementRows()).toBe(0);
  });

  it("🔴 refuses a nonexistent obligation", () => {
    const c = customer("زبون");
    expect(errCode(ipc.recordCustomerPayment(payReq(c.id, "no-such", "key-ghost-01", "100")))).toBe("INVALID_INPUT");
  });

  it("🔴 a posted settlement cannot be edited or deleted — the trigger refuses", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const r = ok<RecordPaymentResponse>(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-imm-0001", "400")));
    expect(() => h.db.prepare(`UPDATE settlements SET amount_minor = 1 WHERE id = ?`).run(r.settlement.id)).toThrow();
    expect(() => h.db.prepare(`DELETE FROM settlements WHERE id = ?`).run(r.settlement.id)).toThrow();
    expect(settlementRows()).toBe(1);
  });

  it("🔴 no balance is ever STORED — the tables hold no such column", () => {
    for (const table of ["parties", "obligations", "settlements"]) {
      const cols = (h.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      for (const forbidden of ["balance", "outstanding", "owed", "running_total"]) {
        expect(cols, `${table}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("🔴 READING a statement writes nothing at all", () => {
    const c = customer("زبون");
    owe(c.id, "bill-1", 1000n);
    const before = settlementRows();
    for (let i = 0; i < 3; i++) ipc.getCustomerStatement({ customerId: c.id });
    expect(settlementRows()).toBe(before);
  });

  it("🔴 an ARCHIVED customer's history stays readable and traceable", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-arch-001", "400"));
    parties.setActive("customer", c.id, false);
    const st = ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
    expect(st.customer.isActive).toBe(false);
    expect(st.obligations[0]!.settlements).toHaveLength(1);
    expect(outstandingOf(st, o.id)).toBe("600");
  });

  it("🔴 no sale, sale line or invoice is touched by recording a payment", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const snap = () =>
      ["sales", "sale_lines", "invoices"].map(
        (tb) => (h.db.prepare(`SELECT count(*) AS n FROM ${tb}`).get() as { n: number | bigint }).n,
      );
    const before = snap();
    ipc.recordCustomerPayment(payReq(c.id, o.id, "key-nosale-01", "400"));
    expect(snap()).toEqual(before);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Authorization — enforced at the boundary, not by hiding a button
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("authorization", () => {
  it("the channel is owner-classified", () => {
    expect(accessFor("recordCustomerPayment")).toBe("owner");
  });

  it("🔴 a CASHIER calling the bridge directly is REFUSED, and nothing is written", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    becomeCashier();
    const r = ipc.recordCustomerPayment(payReq(c.id, o.id, "key-cash-0001", "100"));
    expect(errCode(r)).toBe("NOT_AUTHORIZED");
    expect(settlementRows()).toBe(0);
  });

  it("🔴 a cashier cannot read the statement either", () => {
    const c = customer("زبون");
    becomeCashier();
    expect(errCode(ipc.getCustomerStatement({ customerId: c.id }))).toBe("NOT_AUTHORIZED");
  });

  it("🔴 a cashier CAN still search and create customers — S1B is untouched", () => {
    becomeCashier();
    const made = ok<{ customer: { id: string } }>(
      ipc.createCustomer({ displayName: "زبون الكاشير", phone: null, address: null, note: null }),
    );
    expect(made.customer.id).toBeTruthy();
    expect(ok<unknown[]>(ipc.searchCustomers({ query: "زبون", includeArchived: false })).length).toBeGreaterThan(0);
  });

  it("🔴 nobody signed in posts nothing", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    role = null;
    // NOT_LOGGED_IN, not NOT_AUTHORIZED: this codebase distinguishes "nobody is signed in" from
    // "you are signed in and may not do this", and both refuse before any write.
    expect(errCode(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-anon-0001", "100")))).toBe("NOT_LOGGED_IN");
    expect(settlementRows()).toBe(0);
  });

  it("🔴 the refusal does not leak whether the debt or the customer exists", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    becomeCashier();
    const real = errMsg(ipc.recordCustomerPayment(payReq(c.id, o.id, "key-leak-0001", "100")));
    const fake = errMsg(ipc.recordCustomerPayment(payReq("no-one", "no-such", "key-leak-0002", "100")));
    expect(real).toBe(fake);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The payload contract
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the payload", () => {
  // 🔴 TRANSITION with migration 17 (M17A). This asserted CASH ONLY; the channel now takes exactly five
  // named ways of paying (cash · card · whish · bank_transfer · other). What stays an INVARIANT is
  // that nothing outside that list is reachable — 'external' (a stored value, not a channel) and
  // 'credit' (a STATE, never a way of paying) in particular.
  it("🔴 accepts exactly the five named channels — nothing else is reachable through this channel", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    for (const m of ["external", "credit", "CASH", "Whish", "wire", "bank", ""]) {
      const r = ipc.recordCustomerPayment({ ...payReq(c.id, o.id, `key-m-${m || "empty"}-1`, "100"), method: m });
      expect(errCode(r), m).toBe("INVALID_INPUT");
    }
    expect(settlementRows()).toBe(0);
  });

  it("🔴 refuses an unknown extra field rather than ignoring it", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const r = ipc.recordCustomerPayment({ ...payReq(c.id, o.id, "key-extra-001", "100"), partyKind: "supplier" });
    expect(errCode(r)).toBe("INVALID_INPUT");
  });

  it("🔴 the amount is a STRING of minor units — a number is refused", () => {
    const c = customer("زبون");
    const o = owe(c.id, "bill-1", 1000n);
    const r = ipc.recordCustomerPayment({ ...payReq(c.id, o.id, "key-num-00001", "100"), amountMinor: 100 });
    expect(errCode(r)).toBe("INVALID_INPUT");
  });
});
