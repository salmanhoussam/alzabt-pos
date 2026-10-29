/**
 * M17A — a customer collection records HOW the money arrived (cash · card · whish · bank transfer ·
 * other), through the real IPC handlers, the real ledger and real SQLite.
 *
 * 🔴 WHAT THESE PROTECT
 *   · cash behaves exactly as before — its stored fingerprint is byte-identical to the pre-M17 formula;
 *   · Whish and bank transfer are OPERATOR-RECORDED: they need a reference and an explicit "the money
 *     arrived", and are never counted as till cash;
 *   · one provider reference is one collection, whatever key it arrives under;
 *   · a key reused for different money — amount, method, reference, confirmation, obligation — conflicts;
 *   · an uncertain outcome is resolved by asking the ledger and never invites a second collection.
 *
 * Synthetic data only. `amountMinor` is MINOR units ("1000" = 10.00).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, paymentFailureTruth, syncHandlers } from "../../src/main/ipcHandlers";
import { snapshotDatabase } from "../../src/persistence/backup";
import { openDatabase } from "../../src/persistence/db";
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
const supplier = () => h.parties.create({ kind: "supplier", displayName: "مورّد" }).party;
const owe = (partyId: string, ref: string, minor: bigint, currency = "USD", direction: "receivable" | "payable" = "receivable") =>
  h.ledger.postObligation({ partyId, direction, sourceKind: "manual", sourceRef: ref, currency, amountMinor: minor }).record;
const becomeCashier = () => h.service.login("cashier-02", "2222");

type Req = {
  customerId: string;
  obligationId: string;
  idempotencyKey: string;
  amountMinor: string;
  method: string;
  reference?: string | null;
  fundsConfirmed?: boolean;
};
const pay = (r: Req) => ipc.recordCustomerPayment(r as never);
const base = (c: { id: string }, o: { id: string }, key: string, amountMinor: string, method: string, extra: Partial<Req> = {}): Req => ({
  customerId: c.id,
  obligationId: o.id,
  idempotencyKey: key,
  amountMinor,
  method,
  ...extra,
});
const rows = () => h.db.prepare("SELECT * FROM settlements ORDER BY settled_at, id").all() as Array<Record<string, unknown>>;
const count = () => rows().length;
const outstanding = (st: CustomerStatementDto, id: string) => st.obligations.find((o) => o.id === id)!.outstanding.minor;

describe("cash is unchanged", () => {
  it("🔴 a cash collection stores a byte-identical PRE-M17 fingerprint and no details", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    ok(pay(base(c, o, "key-cash-0001", "400", "cash")));
    const row = rows()[0]!;
    const legacy = createHash("sha256")
      .update(JSON.stringify({ obligationId: o.id, partyId: c.id, amountMinor: "400", currency: "USD", method: "cash" }))
      .digest("hex");
    expect(row.request_fingerprint).toBe(legacy);
    expect([row.method, row.provider, row.reference, row.funds_confirmed]).toEqual(["cash", null, null, null]);
  });

  it("cash refuses a reference and a confirmation", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    expect(errCode(pay(base(c, o, "key-cash-0002", "100", "cash", { reference: "X-1" })))).toBe("INVALID_INPUT");
    expect(errCode(pay(base(c, o, "key-cash-0003", "100", "cash", { fundsConfirmed: true })))).toBe("INVALID_INPUT");
    expect(count()).toBe(0);
  });
});

describe("each channel is recorded durably and distinguishably", () => {
  it("card (reference optional), whish, bank transfer and other", () => {
    const c = customer();
    const o = owe(c.id, "b1", 10_000n);
    const cases: Array<[string, Partial<Req>, [string, string | null, string | null, number | null]]> = [
      ["card", {}, ["card", null, null, null]],
      ["card", { reference: "SLIP-77" }, ["card", null, "SLIP-77", null]],
      ["whish", { reference: "WH-2026-001", fundsConfirmed: true }, ["external", "whish", "WH-2026-001", 1]],
      ["bank_transfer", { reference: "IBAN-TRX 55/9", fundsConfirmed: true }, ["external", "bank_transfer", "IBAN-TRX 55/9", 1]],
      ["other", { reference: "قسيمة رقم 12", fundsConfirmed: true }, ["other", null, "قسيمة رقم 12", 1]],
    ];
    cases.forEach(([m, extra, expected], i) => {
      const key = `key-ch-${i}-0001`;
      const r = ok<RecordPaymentResponse>(pay(base(c, o, key, "100", m, extra)));
      expect(r.duplicate).toBe(false);
      const row = h.db.prepare("SELECT * FROM settlements WHERE idempotency_key = ?").get(key) as Record<string, unknown>;
      expect([row.method, row.provider, row.reference, row.funds_confirmed === null ? null : Number(row.funds_confirmed)]).toEqual(expected);
      // The DTO says the same, so the statement can show it.
      expect([r.settlement.method, r.settlement.provider, r.settlement.reference]).toEqual([expected[0], expected[1], expected[2]]);
    });
    expect(count()).toBe(5);
  });

  it("🔴 whish, bank transfer and other REQUIRE a reference and an explicit confirmation; nothing is written without them", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    for (const m of ["whish", "bank_transfer", "other"]) {
      const k = m.replace("_", "");
      expect(errCode(pay(base(c, o, `key-${k}-nr01`, "100", m, { fundsConfirmed: true })))).toBe("INVALID_INPUT"); // no reference
      expect(errCode(pay(base(c, o, `key-${k}-nc01`, "100", m, { reference: "R-1" })))).toBe("FUNDS_NOT_CONFIRMED");
      expect(errCode(pay(base(c, o, `key-${k}-nc02`, "100", m, { reference: "R-1", fundsConfirmed: false })))).toBe("FUNDS_NOT_CONFIRMED");
    }
    expect(count()).toBe(0);
  });

  it("🔴 the confirmation must be a real boolean — a string is not consent", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    expect(errCode(pay(base(c, o, "key-bool-0001", "100", "whish", { reference: "R-1", fundsConfirmed: "yes" as never })))).toBe("INVALID_INPUT");
    expect(count()).toBe(0);
  });
});

describe("references are non-sensitive and bounded", () => {
  const attempt = (reference: string) => {
    const c = customer();
    const o = owe(c.id, `b-${Math.random()}`, 1000n);
    return errCode(pay(base(c, o, `key-ref-${Math.random().toString(36).slice(2, 10)}`, "100", "bank_transfer", { reference, fundsConfirmed: true })));
  };
  it("accepts ordinary transaction references, including Arabic", () => {
    for (const ok1 of ["A1", "WH-2026/10 #55", "trx_9.1", "مرجع 77"]) expect(attempt(ok1), ok1).toBeNull();
  });
  it("🔴 refuses a card number, a long value, a newline, symbols and a leading space-only value", () => {
    expect(attempt("4111 1111 1111 1111")).toBe("INVALID_INPUT"); // Luhn-valid PAN
    expect(attempt("4111-1111-1111-1111")).toBe("INVALID_INPUT");
    expect(attempt("AUTH-4111111111111111")).toBe("INVALID_INPUT"); // card PAN with a label
    expect(attempt("SLIP 4111 1111 1111 1111")).toBe("INVALID_INPUT");
    expect(attempt("x".repeat(65))).toBe("INVALID_INPUT");
    expect(attempt("line1\nline2")).toBe("INVALID_INPUT");
    expect(attempt("<script>")).toBe("INVALID_INPUT");
    expect(attempt("   ")).toBe("INVALID_INPUT");
  });
  it("a 16-digit number that is NOT a valid card number is an ordinary reference", () => {
    expect(attempt("1234567890123456")).toBeNull();
  });
});

describe("partial and multi-method settlement", () => {
  it("🔴 settles one debt across four ways of paying, in order, and refuses the cent after", () => {
    const c = customer();
    const o = owe(c.id, "b1", 2500n);
    const steps: Array<[string, string, Partial<Req>, string]> = [
      ["cash", "1000", {}, "1500"],
      ["whish", "500", { reference: "WH-1", fundsConfirmed: true }, "1000"],
      ["card", "700", {}, "300"],
      ["bank_transfer", "300", { reference: "BT-1", fundsConfirmed: true }, "0"],
    ];
    steps.forEach(([m, amt, extra, left], i) => {
      const r = ok<RecordPaymentResponse>(pay(base(c, o, `key-multi-${i}-001`, amt, m, extra)));
      expect(outstanding(r.statement, o.id)).toBe(left);
    });
    const st = ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
    expect(st.obligations[0]!.fullyPaid).toBe(true);
    // Same-instant rows have no defined order, so the HISTORY is compared as a set.
    expect(st.obligations[0]!.settlements.map((s) => s.provider ?? s.method).sort()).toEqual(["bank_transfer", "card", "cash", "whish"]);
    expect(errCode(pay(base(c, o, "key-multi-over-01", "1", "cash")))).toBe("INVALID_AMOUNT");
    expect(count()).toBe(4);
  });

  it("an overpayment through a non-cash channel is refused and writes nothing", () => {
    const c = customer();
    const o = owe(c.id, "b1", 500n);
    expect(errCode(pay(base(c, o, "key-over-whish-1", "501", "whish", { reference: "WH-9", fundsConfirmed: true })))).toBe("INVALID_AMOUNT");
    expect(count()).toBe(0);
  });

  it("USD and LBP stay separate: a collection never touches the other currency's debt", () => {
    const c = customer();
    const usd = owe(c.id, "u1", 1000n, "USD");
    const lbp = owe(c.id, "l1", 5_000_000n, "LBP");
    const r = ok<RecordPaymentResponse>(pay(base(c, usd, "key-cur-0000001", "1000", "card")));
    expect(r.settlement.amount.currency).toBe("USD");
    expect(outstanding(r.statement, lbp.id)).toBe("5000000");
  });
});

describe("wrong account, supplier, cashier, inactive", () => {
  it("another customer's id against this obligation is refused", () => {
    const a = customer("أ");
    const b = customer("ب");
    const o = owe(a.id, "b1", 1000n);
    expect(errCode(pay(base(b, o, "key-wrong-0001", "100", "card")))).toBe("INVALID_INPUT");
    expect(count()).toBe(0);
  });
  it("a supplier's payable can never be collected through the customer channel", () => {
    const s = supplier();
    const o = owe(s.id, "p1", 1000n, "USD", "payable");
    expect(errCode(pay({ customerId: s.id, obligationId: o.id, idempotencyKey: "key-supp-00001", amountMinor: "100", method: "whish", reference: "R", fundsConfirmed: true }))).toBe("PARTY_NOT_FOUND");
    expect(count()).toBe(0);
  });
  it("🔴 a cashier is refused every channel, at the channel", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    becomeCashier();
    for (const [m, extra] of [["cash", {}], ["card", {}], ["whish", { reference: "R", fundsConfirmed: true }]] as const) {
      expect(errCode(pay(base(c, o, `key-cashier-${m}-1`, "100", m, extra)))).toBe("NOT_AUTHORIZED");
    }
    expect(count()).toBe(0);
  });
  it("an ARCHIVED customer's debt can still be collected — they still owe it", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    h.parties.setActive("customer", c.id, false);
    expect(errCode(pay(base(c, o, "key-arch-000001", "100", "card")))).toBeNull();
  });
});

describe("durable idempotency", () => {
  it("🔴 the same key and the same intent collects ONCE and answers duplicate", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    const req = base(c, o, "key-dup-0000001", "300", "whish", { reference: "WH-DUP", fundsConfirmed: true });
    expect(ok<RecordPaymentResponse>(pay(req)).duplicate).toBe(false);
    const again = ok<RecordPaymentResponse>(pay(req));
    expect(again.duplicate).toBe(true);
    expect(outstanding(again.statement, o.id)).toBe("700");
    expect(count()).toBe(1);
  });

  it("🔴 a reused key with ANY different intent conflicts and writes nothing", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    const o2 = owe(c.id, "b2", 5000n);
    const first = base(c, o, "key-conf-000001", "300", "whish", { reference: "WH-A", fundsConfirmed: true });
    ok(pay(first));
    const variants: Array<[string, Req]> = [
      ["amount", { ...first, amountMinor: "301" }],
      ["method", { ...first, method: "bank_transfer" }],
      ["reference", { ...first, reference: "WH-B" }],
      ["obligation", { ...first, obligationId: o2.id }],
    ];
    for (const [what, v] of variants) expect(errCode(pay(v)), what).toBe("IDEMPOTENCY_CONFLICT");
    // A cash replay of a card payment's key, and a card replay with an added reference, conflict too.
    ok(pay(base(c, o, "key-conf-000002", "100", "card")));
    expect(errCode(pay(base(c, o, "key-conf-000002", "100", "cash")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(errCode(pay(base(c, o, "key-conf-000002", "100", "card", { reference: "S-1" })))).toBe("IDEMPOTENCY_CONFLICT");
    expect(count()).toBe(2);
  });

  it("🔴 one provider reference is ONE collection, under any key — and the database agrees", () => {
    const c = customer();
    const o = owe(c.id, "b1", 5000n);
    ok(pay(base(c, o, "key-ref-0000001", "100", "whish", { reference: "WH-ONCE", fundsConfirmed: true })));
    expect(errCode(pay(base(c, o, "key-ref-0000002", "100", "whish", { reference: "WH-ONCE", fundsConfirmed: true })))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    // Another provider, or card, may carry the same text: the rule is per provider.
    expect(errCode(pay(base(c, o, "key-ref-0000003", "100", "bank_transfer", { reference: "WH-ONCE", fundsConfirmed: true })))).toBeNull();
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, provider, reference, funds_confirmed, settled_by, settled_at, business_date)
           SELECT 'x1', obligation_id, currency, 'key-raw-0000001', 'f', 1, 'external', 'whish', 'WH-ONCE', 1, settled_by, settled_at, business_date FROM settlements LIMIT 1`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    expect(count()).toBe(2);
  });
});

describe("uncertain outcomes are resolved by the ledger", () => {
  it("🔴 after a recorded whish payment the failure truth says RECORDED and forbids collecting again", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    ok(pay(base(c, o, "key-truth-00001", "400", "whish", { reference: "WH-T", fundsConfirmed: true })));
    const told = paymentFailureTruth(h.ledger, { idempotencyKey: "key-truth-00001" }, "en");
    expect(told.code).toBe("PAYMENT_RECORDED");
    expect(told.message).toMatch(/4\.00 USD/);
    expect(told.message).toMatch(/do not collect|not collect/i);
  });

  it("🔴 survives a lost response AND an application restart: the replay is a duplicate, not a second collection", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    const req = base(c, o, "key-restart-0001", "250", "bank_transfer", { reference: "BT-R", fundsConfirmed: true });
    ok(pay(req)); // committed; imagine the response never arrived
    h.db.close();
    open();
    const again = ok<RecordPaymentResponse>(pay(req));
    expect(again.duplicate).toBe(true);
    expect(count()).toBe(1);
    expect(rows()[0]!.reference).toBe("BT-R");
  });
});

describe("rollback and backup", () => {
  it("🔴 a failure while inserting rolls the collection back completely, and the same key then works", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    h.db.exec("CREATE TRIGGER test_settle_fails BEFORE INSERT ON settlements BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    const r = pay(base(c, o, "key-rb-0000001", "100", "card"));
    expect(r.ok).toBe(false);
    expect(count()).toBe(0);
    h.db.exec("DROP TRIGGER test_settle_fails");
    expect(ok<RecordPaymentResponse>(pay(base(c, o, "key-rb-0000001", "100", "card"))).duplicate).toBe(false);
    expect(count()).toBe(1);
  });

  it("a verified backup carries the method, provider, reference and confirmation", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    ok(pay(base(c, o, "key-bk-0000001", "100", "whish", { reference: "WH-BK", fundsConfirmed: true })));
    const dest = `${t.dir}/backup.sqlite`;
    snapshotDatabase(h.db, dest);
    const restored = openDatabase(dest, undefined, { fileMustExist: true });
    try {
      const row = restored.prepare("SELECT method, provider, reference, funds_confirmed FROM settlements").get() as Record<string, unknown>;
      expect([row.method, row.provider, row.reference, Number(row.funds_confirmed)]).toEqual(["external", "whish", "WH-BK", 1]);
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      restored.close();
    }
  });
});

describe("history and reporting keep the channels apart", () => {
  it("🔴 till cash excludes Whish, bank and card — and each currency stays its own row", () => {
    const c = customer();
    const usd = owe(c.id, "u1", 10_000n, "USD");
    const lbp = owe(c.id, "l1", 9_000_000n, "LBP");
    ok(pay(base(c, usd, "key-rep-0000001", "1000", "cash")));
    ok(pay(base(c, usd, "key-rep-0000002", "500", "whish", { reference: "WH-R", fundsConfirmed: true })));
    ok(pay(base(c, usd, "key-rep-0000003", "700", "card")));
    ok(pay(base(c, lbp, "key-rep-0000004", "2000000", "cash")));
    const day = (h.db.prepare("SELECT business_date AS d FROM settlements LIMIT 1").get() as { d: string }).d;
    const totals = h.ledger.collectionTotals(day);
    const cashUsd = totals.filter((r) => r.currency === "USD" && r.method === "cash" && r.provider === null);
    expect(cashUsd.map((r) => r.totalMinor)).toEqual([1000n]); // not 2200n
    expect(totals.find((r) => r.provider === "whish")!.totalMinor).toBe(500n);
    expect(totals.find((r) => r.method === "card")!.totalMinor).toBe(700n);
    expect(totals.find((r) => r.currency === "LBP")!.totalMinor).toBe(2_000_000n);
    becomeCashier();
    expect(() => h.ledger.collectionTotals(day)).toThrow(/owner/i);
  });

  it("🔴 history is append-only and never rewrites the debt, the invoice or the sale", () => {
    const c = customer();
    const o = owe(c.id, "b1", 1000n);
    ok(pay(base(c, o, "key-ao-0000001", "100", "whish", { reference: "WH-AO", fundsConfirmed: true })));
    const before = h.db.prepare("SELECT * FROM obligations").all();
    expect(() => h.db.prepare("UPDATE settlements SET reference = 'x'").run()).toThrow(/immutable/);
    expect(() => h.db.prepare("DELETE FROM settlements").run()).toThrow();
    expect(h.db.prepare("SELECT * FROM obligations").all()).toEqual(before);
  });

  it("an invoice receivable is collected through Whish without touching its invoice or sale", () => {
    const c = customer("عميل الفاتورة");
    h.invoices.saveCompanyProfile({ nameAr: "متجر" });
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [{ description: "صنف", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "20.00" }], "batch-m17-000001");
    h.invoices.updateDraftHeader(invoice.id, { customerPartyId: c.id });
    h.invoices.finalizeInvoice(invoice.id, { issueOnAccount: true });
    const ob = h.db.prepare("SELECT id FROM obligations").get() as { id: string };
    const frozen = {
      invoice: h.db.prepare("SELECT * FROM invoices").all(),
      sale: h.db.prepare("SELECT * FROM sales").all(),
    };
    const r = ok<RecordPaymentResponse>(pay({ customerId: c.id, obligationId: ob.id, idempotencyKey: "key-inv-0000001", amountMinor: "2000", method: "whish", reference: "WH-INV", fundsConfirmed: true }));
    expect(outstanding(r.statement, ob.id)).toBe("0");
    expect(h.db.prepare("SELECT * FROM invoices").all()).toEqual(frozen.invoice);
    expect(h.db.prepare("SELECT * FROM sales").all()).toEqual(frozen.sale);
  });
});
