/**
 * G2 — CORRECTING A MISTAKEN ADVANCE (migration 20 part 2; owner approval DEC-35s).
 *
 * 🔴 THE ONE RULE THESE PROTECT: no correction may create money that was not received, nor a second
 * usable balance for one payment. Proven three ways for every scenario:
 *   · the daily money view (receipts on their day, corrections on the correction's day as
 *     − original + successor, per method) never shows a correction as a new receipt;
 *   · the live balances: after a correction exactly ONE advance of the pair can be used;
 *   · the reference registry: a Whish reference is held once, never registered twice.
 *
 * Owner scenarios (DEC-35s): customer only · Cash → Whish · Whish → Cash · amount lowered · amount
 * RAISED (refused, owner review) · an already corrected advance · a repeat after a crash / lost reply ·
 * a reference already held · an applied or refunded advance · not received.
 * Plus the database itself refusing every bypass (direct SQL), so the UI is never the only guard.
 *
 * Synthetic data only; real SQLite; amounts in MINOR units (USD cents).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AdvanceService, formatAdvanceNo } from "../../src/application/advanceService";
import { AdvanceRepository } from "../../src/persistence/advanceRepository";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let repo: AdvanceRepository;
let n = 0;
const key = () => `adv-corr-key-${String(++n).padStart(4, "0")}`;
const RECEIVED_AT = "2026-10-04T09:00:00.000Z"; // the harness clock: 2026-10-04, Beirut
const DAY1 = "2026-10-04";
const DAY2 = "2026-10-06";

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  repo = new AdvanceRepository(h.db);
  adv = makeAdvances(h, repo);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const customer = (name: string) => h.parties.create({ kind: "customer", displayName: name }).party;
const count = (table: string, where = "1=1") =>
  Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
const lastNo = () => Number((h.db.prepare("SELECT last_no FROM document_numbers WHERE kind = 'advance'").get() as { last_no: bigint }).last_no);
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const sqlError = (fn: () => unknown): string => {
  try {
    fn();
    return "NO ERROR";
  } catch (e) {
    return String((e as Error).message);
  }
};

/** Record an advance on DAY1 and acknowledge it (the receipt was seen). */
function recordCash(customerId: string, minor = 5000n) {
  const k = key();
  const r = adv.record({ customerId, amountMinor: minor, channel: "cash", idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
}
function recordWhish(customerId: string, reference: string, minor = 5000n) {
  const k = key();
  const r = adv.record({ customerId, amountMinor: minor, channel: "whish", reference, fundsConfirmed: true, idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
}
/** The correction happens two days later, so its money effect is visibly on ITS day. */
const laterDay = () => h.clock.set("2026-10-06T09:00:00.000Z");

/** {cash, whish}: received + correction for one day. */
function day(d: string) {
  const out: Record<string, { received: bigint; correction: bigint }> = {};
  for (const m of repo.dayMoney(d)) out[m.method === "cash" ? "cash" : "whish"] = { received: m.receivedMinor, correction: m.correctionMinor };
  return out as { cash: { received: bigint; correction: bigint }; whish: { received: bigint; correction: bigint } };
}
/** 🔴 The invariant: Σ over every day of (received + correction) per method == Σ LIVE balances per method. */
function moneyInvariantHolds(): void {
  const days = (h.db.prepare("SELECT business_date AS d FROM customer_advances UNION SELECT business_date FROM advance_corrections").all() as { d: string }[]).map((r) => r.d);
  const total = { cash: 0n, external: 0n } as Record<string, bigint>;
  for (const d of days) for (const m of repo.dayMoney(d)) total[m.method] = (total[m.method] ?? 0n) + m.receivedMinor + m.correctionMinor;
  const live = { cash: 0n, external: 0n } as Record<string, bigint>;
  for (const r of h.db.prepare("SELECT id, method FROM customer_advances").all() as { id: string; method: string }[]) {
    live[r.method] = (live[r.method] ?? 0n) + repo.unusedMinor(r.id);
  }
  expect(total).toEqual(live);
}
const registryRows = () => count("external_references", "legacy = 0");

describe("G2 — case A: the money was NOT received", () => {
  it("owner only, with reason and explicit declaration; balance 0; no refund, no REF; history kept", () => {
    const c = customer("زبون أ");
    const a = recordCash(c.id);
    laterDay();
    const before = h.db.prepare("SELECT * FROM customer_advances WHERE id = ?").get(a.id);
    const r = adv.correct({ advanceId: a.id, kind: "not_received", reason: "لم يدفع الزبون", confirmNotReceived: true, idempotencyKey: key() });
    expect(r.successor).toBeNull();
    expect(r.correction).toMatchObject({ kind: "not_received", fundsNotReceived: true, correctedBy: "cashier-01", businessDate: DAY2 });
    expect(repo.unusedMinor(a.id)).toBe(0n);
    expect(h.db.prepare("SELECT * FROM customer_advances WHERE id = ?").get(a.id)).toEqual(before); // never edited
    expect(count("advance_refunds")).toBe(0);
    expect(Number((h.db.prepare("SELECT last_no FROM document_numbers WHERE kind = 'advance_refund'").get() as { last_no: bigint }).last_no)).toBe(0);
    expect(lastNo()).toBe(1); // no ADV number used either
    expect(day(DAY1).cash).toEqual({ received: 5000n, correction: 0n }); // the receipt day is untouched history
    expect(day(DAY2).cash).toEqual({ received: 0n, correction: -5000n }); // shown on the correction date
    moneyInvariantHolds();
  });

  it("refused without the declaration, without a reason, or by a cashier — leaving nothing", () => {
    const c = customer("زبون أ");
    const a = recordCash(c.id);
    expect(code(() => adv.correct({ advanceId: a.id, kind: "not_received", reason: "لم يدفع", idempotencyKey: key() }))).toBe("INVALID_INPUT");
    expect(code(() => adv.correct({ advanceId: a.id, kind: "not_received", reason: " ", confirmNotReceived: true, idempotencyKey: key() }))).toBe("INVALID_REASON");
    h.service.login("cashier-02", "2222");
    expect(code(() => adv.correct({ advanceId: a.id, kind: "not_received", reason: "لم يدفع", confirmNotReceived: true, idempotencyKey: key() }))).toBe("NOT_AUTHORIZED");
    expect(count("advance_corrections")).toBe(0);
  });

  it("a Whish advance not received keeps its reference consumed (never reusable)", () => {
    const c = customer("زبون أ");
    const a = recordWhish(c.id, "WH-70001");
    adv.correct({ advanceId: a.id, kind: "not_received", reason: "التحويل لم يصل", confirmNotReceived: true, idempotencyKey: key() });
    expect(code(() => recordWhish(c.id, "WH-70001"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    moneyInvariantHolds();
  });
});

describe("G2 — case B: the money WAS received, its details were wrong", () => {
  it("🔴 Whish on the WRONG customer: re-linked, same reference not registered again, daily money nets to 0", () => {
    const wrong = customer("زبون خطأ");
    const right = customer("زبون صحيح");
    h.service.login("cashier-02", "2222"); // the cashier really received it
    const a = recordWhish(wrong.id, "WH-80001");
    h.service.login("cashier-01", "1111");
    const regBefore = registryRows();
    laterDay();
    const r = adv.correct({ advanceId: a.id, kind: "replaced", customerId: right.id, reason: "سُجّل على الزبون الخطأ", idempotencyKey: key() });
    const s = r.successor!;
    expect(formatAdvanceNo(s.docNo)).toBe("ADV-000002");
    expect(s).toMatchObject({
      customerId: right.id, amountMinor: 5000n, method: "external", provider: "whish", reference: "WH-80001",
      origin: "correction", correctsAdvanceId: a.id,
      receivedBy: "cashier-02", receivedAt: RECEIVED_AT, businessDate: DAY1, // who and when — copied
    });
    expect(registryRows()).toBe(regBefore); // no second registration of WH-80001
    expect(repo.unusedMinor(a.id)).toBe(0n);
    expect(repo.unusedMinor(s.id)).toBe(5000n);
    expect(day(DAY2).whish).toEqual({ received: 0n, correction: 0n }); // no new money movement
    expect(day(DAY2).cash).toEqual({ received: 0n, correction: 0n });
    // statements: the wrong customer sees the correction, the right one sees ADV-2 «تصحيح لـADV-1»
    expect(adv.statement(wrong.id)).toEqual([expect.objectContaining({ unusedMinor: 0n, successorNo: 2, correctsNo: null })]);
    expect(adv.statement(right.id)).toEqual([expect.objectContaining({ unusedMinor: 5000n, correctsNo: 1, successorNo: null })]);
    expect(code(() => recordWhish(right.id, "WH-80001"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    moneyInvariantHolds();
  });

  it("Cash → Whish: needs the confirmation and a free reference; the day moves the amount between methods", () => {
    const c = customer("زبون");
    const a = recordCash(c.id);
    laterDay();
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", channel: "whish", reference: "WH-81001", reason: "كان ويش", idempotencyKey: key() }))).toBe("FUNDS_NOT_CONFIRMED");
    const r = adv.correct({ advanceId: a.id, kind: "replaced", channel: "whish", reference: "WH-81001", fundsConfirmed: true, reason: "كان ويش", idempotencyKey: key() });
    expect(r.successor).toMatchObject({ method: "external", provider: "whish", reference: "WH-81001" });
    expect(count("external_references", "owner_kind = 'advance' AND owner_id = '" + r.successor!.id + "'")).toBe(1);
    expect(day(DAY2)).toEqual({ cash: { received: 0n, correction: -5000n }, whish: { received: 0n, correction: 5000n } });
    moneyInvariantHolds();
  });

  it("Whish → Cash: the original keeps its reference (still consumed); the day moves the amount", () => {
    const c = customer("زبون");
    const a = recordWhish(c.id, "WH-82001");
    laterDay();
    const r = adv.correct({ advanceId: a.id, kind: "replaced", channel: "cash", reason: "دفع نقداً", idempotencyKey: key() });
    expect(r.successor).toMatchObject({ method: "cash", provider: null, reference: null });
    expect(day(DAY2)).toEqual({ cash: { received: 0n, correction: 5000n }, whish: { received: 0n, correction: -5000n } });
    expect(code(() => recordWhish(c.id, "WH-82001"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    moneyInvariantHolds();
  });

  it("a mistyped Whish reference: corrected once; the new one registered; a reference held elsewhere refused", () => {
    const c = customer("زبون");
    recordWhish(c.id, "WH-83002", 1000n); // someone else's transfer already holds WH-83002
    const a = recordWhish(c.id, "WH-83001");
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", reference: "WH-83002", fundsConfirmed: true, reason: "رقم خطأ", idempotencyKey: key() }))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(lastNo()).toBe(2); // the refusal consumed no ADV number
    expect(count("advance_corrections")).toBe(0);
    const r = adv.correct({ advanceId: a.id, kind: "replaced", reference: "WH-83009", fundsConfirmed: true, reason: "رقم خطأ", idempotencyKey: key() });
    expect(r.successor!.reference).toBe("WH-83009");
    moneyInvariantHolds();
  });

  it("the same reference written differently counts as the SAME reference (nothing registered, no confirmation asked)", () => {
    const wrong = customer("أ");
    const right = customer("ب");
    const a = recordWhish(wrong.id, "WH-84001");
    const reg = registryRows();
    const r = adv.correct({ advanceId: a.id, kind: "replaced", customerId: right.id, reference: "wh 84001", reason: "زبون خطأ", idempotencyKey: key() });
    expect(r.successor!.customerId).toBe(right.id);
    expect(registryRows()).toBe(reg);
    moneyInvariantHolds();
  });

  it("amount recorded HIGHER than received: lowered with the explicit declaration; the day shows only the difference", () => {
    const c = customer("زبون");
    const a = recordCash(c.id, 5000n);
    laterDay();
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", amountMinor: 3000n, reason: "المبلغ أقل", idempotencyKey: key() }))).toBe("INVALID_INPUT");
    const r = adv.correct({ advanceId: a.id, kind: "replaced", amountMinor: 3000n, confirmNotReceived: true, reason: "المبلغ أقل", idempotencyKey: key() });
    expect(r.correction.fundsNotReceived).toBe(true);
    expect(repo.unusedMinor(r.successor!.id)).toBe(3000n);
    expect(day(DAY2).cash).toEqual({ received: 0n, correction: -2000n });
    moneyInvariantHolds();
  });

  it("🔴 a real Whish amount LARGER than recorded is refused (owner review); the same reference cannot be reused for the extra", () => {
    const c = customer("زبون");
    const a = recordWhish(c.id, "WH-85001", 4000n);
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", amountMinor: 6000n, reason: "المبلغ أكبر", idempotencyKey: key() }))).toBe("ADVANCE_CORRECTION_ABOVE_ORIGINAL");
    expect(code(() => recordWhish(c.id, "WH-85001", 2000n))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(count("advance_corrections")).toBe(0);
    expect(lastNo()).toBe(1);
    moneyInvariantHolds();
  });

  it("a correction that changes nothing, an unknown advance, Card / Other are refused", () => {
    const c = customer("زبون");
    const a = recordCash(c.id);
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", reason: "لا شيء", idempotencyKey: key() }))).toBe("INVALID_INPUT");
    expect(code(() => adv.correct({ advanceId: "nope", kind: "not_received", reason: "لا شيء", confirmNotReceived: true, idempotencyKey: key() }))).toBe("ADVANCE_NOT_FOUND");
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", channel: "card", reason: "بطاقة", idempotencyKey: key() }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(count("advance_corrections")).toBe(0);
  });
});

describe("G2 — one payment, one balance", () => {
  it("an already corrected advance cannot be corrected again; its successor can (a chain), one live balance throughout", () => {
    const [x, y, z] = [customer("س"), customer("ص"), customer("ع")];
    const a = recordWhish(x.id, "WH-86001");
    const r1 = adv.correct({ advanceId: a.id, kind: "replaced", customerId: y.id, reason: "زبون خطأ", idempotencyKey: key() });
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", customerId: z.id, reason: "مرة ثانية", idempotencyKey: key() }))).toBe("ADVANCE_ALREADY_CORRECTED");
    const r2 = adv.correct({ advanceId: r1.successor!.id, kind: "replaced", customerId: z.id, reason: "زبون خطأ ثانية", idempotencyKey: key() });
    expect([repo.unusedMinor(a.id), repo.unusedMinor(r1.successor!.id), repo.unusedMinor(r2.successor!.id)]).toEqual([0n, 0n, 5000n]);
    expect(registryRows()).toBe(1); // WH-86001 registered exactly once in the whole chain
    moneyInvariantHolds();
  });

  it("an advance already refunded (in part) cannot be corrected", () => {
    const c = customer("زبون");
    const a = recordCash(c.id);
    h.db.transaction(() => {
      h.db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance_refund'").run();
      h.db.prepare(
        `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint, refunded_by, refunded_at, business_date)
         VALUES ('rf1', 1, ?, 1000, 'cash', 'طلب الزبون', 'ref-key-0001', 'fp', 'cashier-01', ?, ?)`,
      ).run(a.id, RECEIVED_AT, DAY1);
    })();
    expect(code(() => adv.correct({ advanceId: a.id, kind: "not_received", reason: "خطأ", confirmNotReceived: true, idempotencyKey: key() }))).toBe("ADVANCE_IN_USE");
    // and the database refuses it too, whatever the caller
    expect(sqlError(() => h.db.prepare(
      `INSERT INTO advance_corrections (id, advance_id, kind, funds_not_received, reason, corrected_by, corrected_at, business_date, idempotency_key, request_fingerprint)
       VALUES ('c1', ?, 'not_received', 1, 'خطأ', 'cashier-01', ?, ?, 'corr-key-sql-1', 'fp')`).run(a.id, RECEIVED_AT, DAY1))).toMatch(/fully unused/);
  });

  it("🔴 the database refuses applying or refunding a corrected advance", () => {
    const c = customer("زبون");
    const a = recordCash(c.id);
    adv.correct({ advanceId: a.id, kind: "not_received", reason: "لم يدفع", confirmNotReceived: true, idempotencyKey: key() });
    const refund = () =>
      h.db.transaction(() => {
        h.db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance_refund'").run();
        h.db.prepare(
          `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint, refunded_by, refunded_at, business_date)
           VALUES ('rf1', 1, ?, 1000, 'cash', 'طلب الزبون', 'ref-key-0001', 'fp', 'cashier-01', ?, ?)`,
        ).run(a.id, RECEIVED_AT, DAY1);
      })();
    expect(sqlError(refund)).toMatch(/corrected advance has no balance to refund/);
    // apply: a perfectly shaped cash settlement of this customer's own debt — refused only for the correction
    const apply = () =>
      h.db.transaction(() => {
        h.db.prepare(
          `INSERT INTO obligations (id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency, amount_minor, posted_by, posted_at, business_date)
           VALUES ('o1', ?, 'customer', 'receivable', 'manual', 'REF-o1', NULL, 'USD', 1000, 'cashier-01', ?, ?)`,
        ).run(c.id, RECEIVED_AT, DAY1);
        h.db.prepare(
          `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, provider, reference, funds_confirmed, settled_by, settled_at, business_date)
           VALUES ('st1', 'o1', 'USD', 'apply-settle-0001', 'fp', 1000, 'cash', NULL, NULL, NULL, 'cashier-01', ?, ?)`,
        ).run(RECEIVED_AT, DAY1);
        h.db.prepare(
          "INSERT INTO advance_applications (id, advance_id, settlement_id, amount_minor, idempotency_key, applied_by, applied_at) VALUES ('ap1', ?, 'st1', 1000, 'apply-key-0001', 'cashier-01', ?)",
        ).run(a.id, RECEIVED_AT);
      })();
    expect(sqlError(apply)).toMatch(/corrected advance has no balance to apply/);
    expect(count("advance_applications") + count("advance_refunds")).toBe(0);
  });
});

describe("G2 — repeats, crashes, and the database as the last guard", () => {
  it("the same request again (lost reply) returns the SAME correction and writes nothing; a different payload under the key is refused", () => {
    const [x, y] = [customer("س"), customer("ص")];
    const a = recordCash(x.id);
    const k = key();
    const first = adv.correct({ advanceId: a.id, kind: "replaced", customerId: y.id, reason: "زبون خطأ", idempotencyKey: k });
    const again = adv.correct({ advanceId: a.id, kind: "replaced", customerId: y.id, reason: "زبون خطأ", idempotencyKey: k });
    expect(again.duplicate).toBe(true);
    expect(again.successor!.docNo).toBe(first.successor!.docNo);
    expect(count("advance_corrections")).toBe(1);
    expect(lastNo()).toBe(2);
    expect(code(() => adv.correct({ advanceId: a.id, kind: "replaced", customerId: y.id, reason: "سبب آخر", idempotencyKey: k }))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("a successor cannot exist without its correction, nor exceed, nor rewrite who received the money (direct SQL)", () => {
    const [x, y] = [customer("س"), customer("ص")];
    const a = recordCash(x.id);
    const successor = (over: { amount?: number; by?: string; withCorrection?: boolean }) =>
      h.db.transaction(() => {
        if (over.withCorrection) {
          h.db.prepare(
            `INSERT INTO advance_corrections (id, advance_id, kind, successor_advance_id, reason, corrected_by, corrected_at, business_date, idempotency_key, request_fingerprint)
             VALUES ('c1', ?, 'replaced', 's1', 'زبون خطأ', 'cashier-01', ?, ?, 'corr-key-sql-1', 'fp')`,
          ).run(a.id, RECEIVED_AT, DAY1);
        }
        h.db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance'").run();
        h.db.prepare(
          `INSERT INTO customer_advances (id, doc_no, customer_id, currency, amount_minor, method, idempotency_key, request_fingerprint, received_by, received_at, business_date, origin, corrects_advance_id)
           VALUES ('s1', 2, ?, 'USD', ?, 'cash', 'corr-key-sql-1', 'fp', ?, ?, ?, 'correction', ?)`,
        ).run(y.id, over.amount ?? 5000, over.by ?? "cashier-01", RECEIVED_AT, DAY1, a.id);
      })();
    expect(sqlError(() => successor({}))).toMatch(/restate its original under its own correction/);
    expect(sqlError(() => successor({ withCorrection: true, amount: 9000 }))).toMatch(/restate its original/);
    expect(sqlError(() => successor({ withCorrection: true, by: "cashier-02" }))).toMatch(/restate its original/);
    expect(count("customer_advances")).toBe(1);
    expect(count("advance_corrections")).toBe(0);
    // a 'replaced' correction whose successor never arrives fails at COMMIT and leaves nothing
    expect(sqlError(() => h.db.transaction(() => h.db.prepare(
      `INSERT INTO advance_corrections (id, advance_id, kind, successor_advance_id, reason, corrected_by, corrected_at, business_date, idempotency_key, request_fingerprint)
       VALUES ('c2', ?, 'replaced', 'ghost', 'زبون خطأ', 'cashier-01', ?, ?, 'corr-key-sql-2', 'fp')`).run(a.id, RECEIVED_AT, DAY1))())).toMatch(/FOREIGN KEY/);
    expect(count("advance_corrections")).toBe(0);
    expect(repo.unusedMinor(a.id)).toBe(5000n);
  });

  it("a correction is immutable and undeletable; a cashier row cannot correct even by direct SQL; a receipt cannot carry a link", () => {
    const c = customer("زبون");
    const a = recordCash(c.id);
    adv.correct({ advanceId: a.id, kind: "not_received", reason: "لم يدفع", confirmNotReceived: true, idempotencyKey: key() });
    expect(sqlError(() => h.db.prepare("UPDATE advance_corrections SET reason = 'تعديل'").run())).toMatch(/immutable/);
    expect(sqlError(() => h.db.prepare("DELETE FROM advance_corrections").run())).toMatch(/cannot be deleted/);
    const b = recordCash(c.id);
    expect(sqlError(() => h.db.prepare(
      `INSERT INTO advance_corrections (id, advance_id, kind, funds_not_received, reason, corrected_by, corrected_at, business_date, idempotency_key, request_fingerprint)
       VALUES ('cx', ?, 'not_received', 1, 'خطأ', 'cashier-02', ?, ?, 'corr-key-sql-3', 'fp')`).run(b.id, RECEIVED_AT, DAY1))).toMatch(/only the owner/);
    expect(sqlError(() => h.db.prepare(
      `INSERT INTO advance_corrections (id, advance_id, kind, funds_not_received, reason, corrected_by, corrected_at, business_date, idempotency_key, request_fingerprint)
       VALUES ('cy', ?, 'not_received', 1, 'خطأ', 'cashier-01', ?, ?, 'corr-key-sql-4', 'fp')`).run(a.id, RECEIVED_AT, DAY1))).toMatch(/already corrected/);
    expect(sqlError(() => h.db.transaction(() => {
      h.db.prepare("INSERT INTO advance_attempts (idempotency_key, customer_id, currency, amount_minor, channel, request_fingerprint, created_by, created_at) VALUES ('link-key-0001', ?, 'USD', 100, 'cash', 'fp', 'cashier-01', ?)").run(c.id, RECEIVED_AT);
      h.db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance'").run();
      h.db.prepare(
        `INSERT INTO customer_advances (id, doc_no, customer_id, currency, amount_minor, method, idempotency_key, request_fingerprint, received_by, received_at, business_date, corrects_advance_id)
         VALUES ('lk', 3, ?, 'USD', 100, 'cash', 'link-key-0001', 'fp', 'cashier-01', ?, ?, ?)`).run(c.id, RECEIVED_AT, DAY1, b.id);
    })())).toMatch(/only a correction advance may name/);
  });
});
