/**
 * DEC-35z+ REF — CASH REFUND OF A CUSTOMER ADVANCE'S UNUSED BALANCE (owner only). Real SQLite, real services.
 *
 * 🔴 THE RULES THESE PROTECT (D-P5a FINAL + owner decision DEC-35z+):
 *   · owner only — service, channel AND trigger; a refused refund leaves NO trace (not even a number)
 *   · CASH only, even for a Whish advance (no Whish reference re-registered, nothing "sent back by Whish")
 *   · within the UNUSED balance (amount − applications − refunds); partial and repeated partial allowed
 *   · a reason is mandatory; a numbered REF- issued in order, never consumed by a failed transaction
 *   · the ADV row is never changed; a corrected advance has no balance to refund
 *   · idempotent: a lost reply returns the SAME REF-; the same key for other details is refused
 *   · crash-safe (REAL process death) and race-safe (two REAL processes)
 *   · Daily Money: an independent CASH OUT line; not a new receipt, not a reduced collection or revenue
 *   · the statement lists it; a backup/restore keeps it and continues the numbering
 *
 * Synthetic data only. Amounts in minor units (USD cents). Harness clock: 2026-10-04, Beirut.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdvanceService } from "../../src/application/advanceService";
import { DailyMoneyService } from "../../src/application/dailyMoneyService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { renderRefundDocument } from "../../src/main/refundDocument";
import { snapshotDatabase } from "../../src/persistence/backup";
import { AdvanceRepository } from "../../src/persistence/advanceRepository";
import { DailyMoneyRepository } from "../../src/persistence/dailyMoneyRepository";
import type { AdvanceRefundDto, AdvanceStatementDto, IpcResult, RefundAdvanceResponse } from "../../src/shared/ipcContract";
import { advanceDeps, makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let dm: DailyMoneyService;
let ipc: ReturnType<typeof syncHandlers>;
let printed: string[];
const DAY = "2026-10-04";

function wire() {
  adv = makeAdvances(h);
  dm = new DailyMoneyService({
    repository: new DailyMoneyRepository(h.db),
    actor: () => {
      const c = h.service.currentCashier();
      const role = h.service.currentRole();
      return c && role ? { id: c.id, role } : null;
    },
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone, currency: FIXTURE_TERMINAL.currency },
    now: h.clock.now,
  });
  printed = [];
  ipc = syncHandlers(
    createIpcHandlers(h.service, {
      parties: h.parties,
      ledger: h.ledger,
      advances: adv,
      dailyMoney: dm,
      printAdvanceRefund: async (id) => (printed.push(id), "printed"),
    }),
  );
}

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  wire();
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const errCode = (r: IpcResult<unknown>) => (r.ok ? "OK" : r.error.code);
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "OK";
};
const count = (table: string, where = "1=1") => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
const refNo = () => Number((h.db.prepare("SELECT last_no FROM document_numbers WHERE kind = 'advance_refund'").get() as { last_no: bigint }).last_no);
/** Every money-bearing table + the REF counter, so "nothing written" is checked everywhere at once. */
const footprint = () => [
  ...["settlements", "advance_applications", "receipts", "customer_advances", "advance_refunds", "external_references", "sales", "sale_tenders"].map((x) => count(x)),
  refNo(),
];
const customer = (name: string) => h.parties.create({ kind: "customer", displayName: name }).party;
const asCashier = () => {
  h.service.logout();
  h.service.login("cashier-02", "2222");
};
const advance = (customerId: string, minor: bigint, channel: "cash" | "whish" = "cash", reference?: string) => {
  const k = newKey();
  const r = adv.record({ customerId, amountMinor: minor, channel, ...(reference ? { reference, fundsConfirmed: true } : {}), idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
};
const refund = (advanceId: string, amountMinor: bigint, reason = "الزبون طلب استرداد الباقي", idempotencyKey = newKey(), confirmRepeat?: boolean) =>
  adv.refund({ advanceId, amountMinor, reason, idempotencyKey, ...(confirmRepeat === undefined ? {} : { confirmRepeat }) });
/** TRANSITION (DEC-35zz++ Option A): a 2nd+ refund of the SAME advance on the SAME day now needs confirmRepeat; old: none. */
const again = (advanceId: string, amountMinor: bigint, reason?: string) => refund(advanceId, amountMinor, reason, newKey(), true);
const advRow = (id: string) => h.db.prepare("SELECT * FROM customer_advances WHERE id = ?").get(id);

describe("REF — the happy paths", () => {
  it("FULL refund of a cash advance: REF-000001, cash, owner, reason, balance 0 — the ADV row untouched", () => {
    const c = customer("زبون الاسترداد");
    const a = advance(c.id, 1000n);
    const before = advRow(a.id);
    const r = refund(a.id, 1000n);
    expect([r.duplicate, r.unusedMinor, r.refund.docNo, r.refund.method, r.refund.refundedBy]).toEqual([false, 0n, 1, "cash", "cashier-01"]);
    expect(adv.refundView(r.refund).number).toBe("REF-000001");
    expect(h.db.prepare("SELECT amount_minor AS m, method, reason, business_date AS d FROM advance_refunds").get()).toEqual({
      m: 1000n,
      method: "cash",
      reason: "الزبون طلب استرداد الباقي",
      d: DAY,
    });
    expect(advRow(a.id)).toEqual(before);
    expect([count("settlements"), count("receipts"), count("sales")]).toEqual([0, 0, 0]);
  });

  it("PARTIAL, then MULTIPLE partials: REF-1/2/3 in order, never above the balance", () => {
    const c = customer("زبون جزئي");
    const a = advance(c.id, 1000n);
    expect(refund(a.id, 300n).unusedMinor).toBe(700n);
    // TRANSITION (DEC-35zz++ Option A): a 2nd+ refund of the SAME advance on the SAME day now needs confirmRepeat; old: none.
    expect(again(a.id, 300n).unusedMinor).toBe(400n); // the SAME amount twice is two genuine refunds (two keys)
    const fp = footprint();
    expect(codeOf(() => again(a.id, 401n))).toBe("ADVANCE_REFUND_ABOVE_BALANCE");
    expect(footprint()).toEqual(fp);
    const last = again(a.id, 400n);
    expect([last.unusedMinor, last.refund.docNo]).toEqual([0n, 3]);
    expect(codeOf(() => again(a.id, 1n))).toBe("ADVANCE_REFUND_ABOVE_BALANCE");
    expect(h.db.prepare("SELECT doc_no AS n, amount_minor AS m FROM advance_refunds ORDER BY doc_no").all()).toEqual([
      { n: 1n, m: 300n },
      { n: 2n, m: 300n },
      { n: 3n, m: 400n },
    ]);
  });

  it("an APPLIED advance refunds only what is left after the application", () => {
    const c = customer("زبون مطبّق");
    const a = advance(c.id, 1000n);
    const d = h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "P-1", currency: "USD", amountMinor: 600n }).record;
    adv.applyToDebt({ advanceId: a.id, obligationId: d.id, amountMinor: 600n, idempotencyKey: newKey() });
    expect(codeOf(() => refund(a.id, 401n))).toBe("ADVANCE_REFUND_ABOVE_BALANCE");
    expect(refund(a.id, 400n).unusedMinor).toBe(0n);
    // …and an application can no longer take what was refunded.
    const d2 = h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "P-2", currency: "USD", amountMinor: 100n }).record;
    expect(codeOf(() => adv.applyToDebt({ advanceId: a.id, obligationId: d2.id, amountMinor: 1n, idempotencyKey: newKey() }))).toBe("ADVANCE_APPLY_ABOVE_BALANCE");
  });

  it("🔴 a WHISH advance is refunded in CASH: no reference registered again, the ADV keeps its reference", () => {
    const c = customer("زبون ويش");
    const a = advance(c.id, 2000n, "whish", "WH-REF-77");
    const refs = h.db.prepare("SELECT * FROM external_references").all();
    const r = refund(a.id, 500n);
    expect(r.refund.method).toBe("cash");
    expect(h.db.prepare("SELECT * FROM external_references").all()).toEqual(refs);
    const v = adv.refundView(r.refund);
    expect([v.advance.record.provider, v.advance.record.reference]).toEqual(["whish", "WH-REF-77"]);
    // Daily Money: Whish IN on the advance, CASH out on the refund — never a Whish out.
    const day = dm.day(DAY);
    expect([day.advances.byChannel.whish, day.refunds.byChannel.cash, day.refunds.byChannel.whish]).toEqual([2000n, 500n, 0n]);
  });
});

describe("refusals — each its own code, NOTHING written (not even a REF number)", () => {
  it("🔴 a cashier is refused by the service AND the channel; the trigger refuses a forged row", async () => {
    const c = customer("زبون");
    const a = advance(c.id, 1000n);
    const own = refund(a.id, 100n);
    asCashier();
    const fp = footprint();
    expect(codeOf(() => refund(a.id, 100n))).toBe("NOT_AUTHORIZED");
    expect(errCode(ipc.refundAdvance({ advanceId: a.id, amountMinor: "100", reason: "سبب صحيح", idempotencyKey: newKey() }))).toBe("NOT_AUTHORIZED");
    const all = createIpcHandlers(h.service, { advances: adv, printAdvanceRefund: async (id) => (printed.push(id), "printed") });
    expect(errCode(await all.printAdvanceRefund({ refundId: own.refund.id }))).toBe("NOT_AUTHORIZED");
    expect(errCode(await all.saveAdvanceRefundPdf({ refundId: own.refund.id }))).toBe("NOT_AUTHORIZED");
    expect(printed).toEqual([]);
    expect(() =>
      h.db.transaction(() => {
        h.db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance_refund'").run();
        h.db
          .prepare(
            `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint, refunded_by, refunded_at, business_date)
             VALUES ('forged', 2, ?, 100, 'cash', 'forged by hand', 'forged-key-0001', 'fp', 'cashier-02', '2026-10-04T09:00:00.000Z', ?)`,
          )
          .run(a.id, DAY);
      })(),
    ).toThrow(/owner/);
    expect(footprint()).toEqual(fp);
  });

  it("a reason is mandatory (3 to 200 characters, trimmed)", () => {
    const a = advance(customer("زبون").id, 1000n);
    const fp = footprint();
    for (const r of ["", "  ", "ab", " ab ", "x".repeat(201)]) expect(codeOf(() => refund(a.id, 100n, r)), JSON.stringify(r)).toBe("INVALID_REASON");
    expect(codeOf(() => adv.refund({ advanceId: a.id, amountMinor: 100n, reason: 42, idempotencyKey: newKey() }))).toBe("INVALID_REASON");
    expect(footprint()).toEqual(fp);
    expect(refund(a.id, 100n, "  طلب  ").refund.reason).toBe("طلب");
  });

  it("zero / negative / non-exact / unknown advance / bad key", () => {
    const a = advance(customer("زبون").id, 1000n);
    const fp = footprint();
    expect(codeOf(() => refund(a.id, 0n))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => refund(a.id, -5n))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => refund("no-such-adv", 100n))).toBe("ADVANCE_NOT_FOUND");
    expect(codeOf(() => adv.refund({ advanceId: a.id, amountMinor: 100n, reason: "سبب", idempotencyKey: "short" }))).toBe("INVALID_INPUT");
    expect(codeOf(() => adv.refund({ advanceId: a.id, amountMinor: "1.5", reason: "سبب", idempotencyKey: newKey() }))).not.toBe("OK");
    expect(footprint()).toEqual(fp);
  });

  it("🔴 a CORRECTED advance has no balance to refund (not received, or replaced); its successor does", () => {
    const c = customer("زبون مصحَّح");
    const right = customer("الزبون الصحيح");
    const gone = advance(c.id, 1000n);
    adv.correct({ advanceId: gone.id, kind: "not_received", reason: "لم يدفع", confirmNotReceived: true, idempotencyKey: newKey() });
    const moved = advance(c.id, 800n);
    const corr = adv.correct({ advanceId: moved.id, kind: "replaced", reason: "على الزبون الخطأ", customerId: right.id, idempotencyKey: newKey() });
    const fp = footprint();
    expect(codeOf(() => refund(gone.id, 1n))).toBe("ADVANCE_CORRECTED_NOT_REFUNDABLE");
    expect(codeOf(() => refund(moved.id, 1n))).toBe("ADVANCE_CORRECTED_NOT_REFUNDABLE");
    expect(footprint()).toEqual(fp);
    expect(refund(corr.successor!.id, 800n).unusedMinor).toBe(0n);
    // …and once refunded, the successor can no longer be corrected (it is in use).
    expect(codeOf(() => adv.correct({ advanceId: corr.successor!.id, kind: "not_received", reason: "خطأ", confirmNotReceived: true, idempotencyKey: newKey() }))).toBe("ADVANCE_IN_USE");
  });

  it("🔴 a failure AFTER the REF number was issued rolls the number back: the next refund is still REF-000001", () => {
    const a = advance(customer("زبون").id, 1000n);
    class FailAfterNumber extends AdvanceService {
      protected override afterRefundNumberIssued(): void {
        throw new Error("disk full (simulated)");
      }
    }
    const broken = new FailAfterNumber(advanceDeps(h));
    expect(() => broken.refund({ advanceId: a.id, amountMinor: 100n, reason: "سبب صحيح", idempotencyKey: "refund-fail-key-01" })).toThrow(/disk full/);
    expect([refNo(), count("advance_refunds")]).toEqual([0, 0]);
    const r = refund(a.id, 100n, "سبب صحيح", "refund-fail-key-01"); // the same key now succeeds, once
    expect([r.refund.docNo, r.duplicate]).toEqual([1, false]);
  });
});

describe("🔴 idempotency — the request key IS the refund", () => {
  it("a lost reply: the SAME key returns the SAME REF- and writes nothing — even after the balance is gone", () => {
    const a = advance(customer("زبون").id, 1000n);
    const first = refund(a.id, 1000n, "سبب الاسترداد", "refund-key-lost-01");
    const fp = footprint();
    const again = refund(a.id, 1000n, "سبب الاسترداد", "refund-key-lost-01");
    expect([again.duplicate, again.refund.id, again.refund.docNo, again.unusedMinor]).toEqual([true, first.refund.id, 1, 0n]);
    expect(footprint()).toEqual(fp);
  });

  it("the same key with another amount / reason / advance is IDEMPOTENCY_CONFLICT; nothing written", () => {
    const c = customer("زبون");
    const a = advance(c.id, 1000n);
    const b = advance(c.id, 1000n);
    refund(a.id, 300n, "سبب أول", "refund-key-conf-01");
    const fp = footprint();
    expect(codeOf(() => refund(a.id, 301n, "سبب أول", "refund-key-conf-01"))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => refund(a.id, 300n, "سبب آخر", "refund-key-conf-01"))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => refund(b.id, 300n, "سبب أول", "refund-key-conf-01"))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toEqual(fp);
  });

  it("🔴 the SAME key found only INSIDE the write lock (a racing twin committed first) answers duplicate — never a second REF-, never a conflict", () => {
    const a = advance(customer("زبون التوأم").id, 1000n);
    const first = refund(a.id, 300n, "سبب السباق", "refund-twin-key-01");
    // The twin's view BEFORE the lock: it has not seen the committed row yet (deterministic stand-in for the race).
    class BlindFirstLook extends AdvanceRepository {
      private looks = 0;
      override findRefundByKey(key: string) {
        this.looks += 1;
        return this.looks === 1 ? null : super.findRefundByKey(key);
      }
    }
    const twin = new AdvanceService(advanceDeps(h, new BlindFirstLook(h.db)));
    const fp = footprint();
    const r = twin.refund({ advanceId: a.id, amountMinor: 300n, reason: "سبب السباق", idempotencyKey: "refund-twin-key-01" });
    expect([r.duplicate, r.refund.id, r.unusedMinor]).toEqual([true, first.refund.id, 700n]);
    expect(footprint()).toEqual(fp);
    // …and the twin with OTHER details is a conflict, still writing nothing.
    const twin2 = new AdvanceService(advanceDeps(h, new BlindFirstLook(h.db)));
    expect(codeOf(() => twin2.refund({ advanceId: a.id, amountMinor: 200n, reason: "سبب السباق", idempotencyKey: "refund-twin-key-01" }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toEqual(fp);
  });

  it("through the CHANNEL: strict payload, duplicate answered with the same REF-", () => {
    const a = advance(customer("زبون القناة").id, 1000n);
    const req = { advanceId: a.id, amountMinor: "250", reason: "طلب الزبون", idempotencyKey: "refund-ipc-key-01" };
    expect(errCode(ipc.refundAdvance({ ...req, method: "whish" }))).toBe("INVALID_INPUT");
    const r1 = ok<RefundAdvanceResponse>(ipc.refundAdvance(req));
    const r2 = ok<RefundAdvanceResponse>(ipc.refundAdvance(req));
    expect([r1.refund.number, r1.unused.minor, r1.duplicate]).toEqual(["REF-000001", "750", false]);
    expect([r2.refund.number, r2.refund.id, r2.duplicate]).toEqual(["REF-000001", r1.refund.id, true]);
    expect(r1.refund).toMatchObject({ method: "cash", advanceNumber: "ADV-000001", advanceChannel: "cash", reason: "طلب الزبون", amount: { minor: "250", currency: "USD" } });
  });
});

describe("Daily Money — an independent CASH OUT; nothing else moves", () => {
  it("🔴 money out = the refund; money in, revenue, collections and advances unchanged; net reconciles; owner attributed", () => {
    const c = customer("زبون التقرير");
    const a = advance(c.id, 3000n);
    h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n });
    const before = dm.day(DAY);
    refund(a.id, 1200n);
    again(a.id, 300n); // TRANSITION (DEC-35zz++ Option A): a 2nd+ refund of the SAME advance on the SAME day now needs confirmRepeat; old: none.
    const after = dm.day(DAY);
    expect(after.moneyIn).toEqual(before.moneyIn);
    expect(after.sales).toEqual(before.sales);
    expect(after.collections).toEqual(before.collections);
    expect(after.advances).toEqual(before.advances);
    expect([after.refunds.count, after.refunds.totalMinor, after.refunds.byChannel.cash]).toEqual([2, 1500n, 1500n]);
    expect(after.moneyOut.totalMinor).toBe(before.moneyOut.totalMinor + 1500n);
    expect(after.net.byChannel.cash).toBe(before.net.byChannel.cash - 1500n);
    expect(after.net.totalMinor).toBe(after.moneyIn.totalMinor - after.moneyOut.totalMinor);
    const owner = after.byOperator.find((o) => o.operatorId === "cashier-01")!;
    expect(owner.moneyOut.cash).toBe(1500n);
    // The ledger agrees with the report, row for row.
    const ledgerOut = Number((h.db.prepare("SELECT sum(amount_minor) AS s FROM advance_refunds WHERE business_date = ?").get(DAY) as { s: bigint }).s);
    expect(after.refunds.totalMinor).toBe(BigInt(ledgerOut));
    // The balance the statement shows = amount − refunds, read from the ledger.
    expect(adv.statement(c.id)[0]!.unusedMinor).toBe(1500n);
  });

  it("a past day never changes: a refund dated today does not touch yesterday's report", () => {
    const a = advance(customer("زبون").id, 1000n);
    const yesterday = dm.day(DAY);
    h.clock.set("2026-10-05T09:00:00.000Z");
    refund(a.id, 400n);
    h.clock.set("2026-10-05T10:00:00.000Z");
    expect(dm.day(DAY)).toEqual(yesterday);
    expect(dm.day("2026-10-05").refunds.totalMinor).toBe(400n);
  });
});

describe("statement, document, print/PDF and reprint", () => {
  it("the advance statement lists every REF- with number, amount, reason, operator — and the live balance", () => {
    const c = customer("زبون الكشف");
    const a = advance(c.id, 1000n);
    refund(a.id, 300n, "سبب أول");
    again(a.id, 200n, "سبب ثاني"); // TRANSITION (DEC-35zz++ Option A): a 2nd+ refund of the SAME advance on the SAME day now needs confirmRepeat; old: none.
    const s = ok<AdvanceStatementDto>(ipc.getAdvanceStatement({ customerId: c.id }));
    expect(s.lines[0]!.unused.minor).toBe("500");
    expect(s.lines[0]!.refunds.map((r) => [r.number, r.amount.minor, r.reason, r.refundedByName, r.method])).toEqual([
      ["REF-000001", "300", "سبب أول", expect.any(String), "cash"],
      ["REF-000002", "200", "سبب ثاني", expect.any(String), "cash"],
    ]);
  });

  it("print / reprint load the SAME REF- by id and write NOTHING; an unknown id or extra key is refused", async () => {
    const a = advance(customer("زبون").id, 1000n);
    const r = refund(a.id, 300n);
    const fp = footprint();
    const all = createIpcHandlers(h.service, { advances: adv, printAdvanceRefund: async (id) => (printed.push(id), "printed") });
    expect(ok<{ status: string }>(await all.printAdvanceRefund({ refundId: r.refund.id }))).toEqual({ status: "printed" });
    expect(ok<{ status: string }>(await all.printAdvanceRefund({ refundId: r.refund.id }))).toEqual({ status: "printed" });
    expect(printed).toEqual([r.refund.id, r.refund.id]);
    expect(errCode(await all.printAdvanceRefund({ refundId: "nope" }))).toBe("ADVANCE_REFUND_NOT_FOUND");
    expect(errCode(await all.printAdvanceRefund({ refundId: r.refund.id, html: "<b>x</b>" }))).toBe("INVALID_INPUT");
    const bare = createIpcHandlers(h.service, { advances: adv });
    expect(ok<{ status: string }>(await bare.printAdvanceRefund({ refundId: r.refund.id }))).toEqual({ status: "unavailable" });
    expect(errCode(await bare.saveAdvanceRefundPdf({ refundId: r.refund.id }))).toBe("NOT_AVAILABLE");
    // 🔴 a failing printer never undoes the refund
    const failing = createIpcHandlers(h.service, { advances: adv, printAdvanceRefund: async () => Promise.reject(new Error("printer offline")) });
    expect((await failing.printAdvanceRefund({ refundId: r.refund.id })).ok).toBe(false);
    expect(footprint()).toEqual(fp);
  });

  const dto = (over: Partial<AdvanceRefundDto> = {}): AdvanceRefundDto => ({
    id: "r1",
    docNo: 1,
    number: "REF-000001",
    advanceId: "a1",
    advanceNumber: "ADV-000007",
    advanceChannel: "cash",
    advanceReference: null,
    customerName: "زبون <b>",
    amount: { minor: "1250", currency: "USD" },
    method: "cash",
    reason: "طلب الزبون & السبب",
    refundedByName: "المالك",
    refundedAt: "2026-10-04T09:30:00.000Z",
    businessDate: "2026-10-04",
    ...over,
  });

  it("the REF- document: Arabic + English, every field, escaped, CASH, no live balance, identical on reprint", () => {
    const html = renderRefundDocument({ refund: dto(), shopName: "محل <x>", timeZone: "Asia/Beirut" });
    for (const s of ["إيصال استرداد نقدي", "Cash refund receipt", "REF-000001", "ADV-000007", "12.50", "نقداً", "Cash", "المالك", "2026-10-04 12:30"]) {
      expect(html, s).toContain(s);
    }
    expect(html).toContain("زبون &lt;b&gt;");
    expect(html).toContain("طلب الزبون &amp; السبب");
    expect(html).toContain("محل &lt;x&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("ليس مصروفاً ولا تخفيضاً لإيراد المبيعات");
    expect(html).toContain("Not an expense, not a reduction of sales revenue");
    expect(html).not.toContain('data-field="whish-note"');
    // No LIVE balance line (it moves with later uses): the receipt never states what is "left".
    expect(html).not.toMatch(/المتبقّي|المتبقي|Left on|remaining/i);
    expect(renderRefundDocument({ refund: dto(), shopName: "محل <x>", timeZone: "Asia/Beirut" })).toBe(html);
  });

  it("a Whish advance's REF- says CASH and that nothing was sent back through Whish; the original reference is shown", () => {
    const html = renderRefundDocument({ refund: dto({ advanceChannel: "whish", advanceReference: "WH-55" }), shopName: null, timeZone: "Asia/Beirut" });
    expect(html).toContain('data-field="whish-note"');
    expect(html).toContain("لم يُرسَل أي مبلغ عبر ويش موني");
    expect(html).toContain("Nothing was sent back through Whish Money");
    expect(html).toContain('data-field="advance-reference">WH-55<');
    expect(html).toMatch(/data-field="method">نقداً/);
  });
});

describe("🔴 backup / restore and ledger integrity", () => {
  it("a snapshot keeps every REF- and the counter; refunding on the restored copy continues the numbering", () => {
    const c = customer("زبون النسخة");
    const a = advance(c.id, 1000n);
    refund(a.id, 300n);
    again(a.id, 200n); // TRANSITION (DEC-35zz++ Option A): a 2nd+ refund of the SAME advance on the SAME day now needs confirmRepeat; old: none.
    const dest = join(t.dir, "refund-backup.sqlite");
    snapshotDatabase(h.db, dest);
    const rows = h.db.prepare("SELECT * FROM advance_refunds ORDER BY doc_no").all();
    h.db.close();
    h = makeHarness(dest);
    wire();
    expect(h.db.prepare("SELECT * FROM advance_refunds ORDER BY doc_no").all()).toEqual(rows);
    expect(refNo()).toBe(2);
    expect(adv.statement(c.id)[0]!.unusedMinor).toBe(500n);
    const next = again(a.id, 500n);
    expect([next.refund.docNo, next.unusedMinor]).toEqual([3, 0n]);
    expect(h.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(h.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("refund rows are immutable and cannot be deleted", () => {
    const a = advance(customer("زبون").id, 1000n);
    refund(a.id, 300n);
    expect(() => h.db.prepare("UPDATE advance_refunds SET amount_minor = 1").run()).toThrow(/immutable/);
    expect(() => h.db.prepare("DELETE FROM advance_refunds").run()).toThrow(/cannot be deleted/);
  });
});

describe("🔴 REAL process death and REAL concurrency", () => {
  const CHILD = join(__dirname, "..", "helpers", "advanceCrashChild.ts");
  const runChild = (mode: string, advanceId: string, key: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx", CHILD, mode, t.dbPath, advanceId, key], { encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
  function crashAt(mode: string, advanceId: string, key: string) {
    h.db.close();
    const r = runChild(mode, advanceId, key);
    expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
    if (process.platform === "win32") expect(r.status).not.toBe(0);
    else expect(r.signal).toBe("SIGKILL");
    h = makeHarness(t.dbPath);
    wire();
  }

  it("killed INSIDE the transaction (REF number issued): nothing survives, the counter is back; the retry refunds once as REF-000001", () => {
    const a = advance(customer("زبون الانهيار").id, 1000n);
    crashAt("refund-inside-tx", a.id, "refund-crash-key-01");
    expect([count("advance_refunds"), refNo()]).toEqual([0, 0]);
    expect(adv.statement(a.customerId)[0]!.unusedMinor).toBe(1000n);
    const r = adv.refund({ advanceId: a.id, amountMinor: 400n, reason: "الزبون طلب استرداد", idempotencyKey: "refund-crash-key-01" });
    expect([r.refund.docNo, r.duplicate, r.unusedMinor]).toEqual([1, false, 600n]);
  });

  it("killed right AFTER the commit (reply lost): the REF- exists once; the retry returns the SAME REF-, nothing new", () => {
    const a = advance(customer("زبون الرد الضائع").id, 1000n);
    crashAt("refund-after-commit", a.id, "refund-crash-key-02");
    expect([count("advance_refunds"), refNo()]).toEqual([1, 1]);
    const r = adv.refund({ advanceId: a.id, amountMinor: 400n, reason: "الزبون طلب استرداد", idempotencyKey: "refund-crash-key-02" });
    expect([r.refund.docNo, r.duplicate, r.unusedMinor]).toEqual([1, true, 600n]);
    expect(count("advance_refunds")).toBe(1);
    expect(h.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("two REAL processes, two keys, 600 + 600 of a 1000 advance: exactly one refund; the other is refused with nothing written", () => {
    const a = advance(customer("زبون السباق").id, 1000n);
    h.db.close();
    const out = [runChild("refund-run", a.id, "refund-race-key-A", { REFUND_AMOUNT: "600" }), runChild("refund-run", a.id, "refund-race-key-B", { REFUND_AMOUNT: "600" })].map(
      (r) => JSON.parse(r.stdout.trim()) as { ok: boolean; code?: string; docNo?: number },
    );
    h = makeHarness(t.dbPath);
    wire();
    expect(out.filter((o) => o.ok).length).toBe(1);
    expect(out.filter((o) => !o.ok).map((o) => o.code)).toEqual(["ADVANCE_REFUND_ABOVE_BALANCE"]);
    expect([count("advance_refunds"), refNo(), adv.statement(a.customerId)[0]!.unusedMinor]).toEqual([1, 1, 400n]);
  });

  it("two REAL processes launched together on the SAME key: one REF-, the other answers duplicate", async () => {
    const a = advance(customer("زبون المفتاح").id, 1000n);
    h.db.close();
    const { spawn } = await import("node:child_process");
    const run = () =>
      new Promise<{ ok: boolean; duplicate?: boolean; docNo?: number; code?: string }>((resolve, reject) => {
        const p = spawn(process.execPath, ["--import", "tsx", CHILD, "refund-run", t.dbPath, a.id, "refund-same-key-01"], { env: { ...process.env, REFUND_AMOUNT: "400" } });
        let s = "";
        p.stdout.on("data", (d) => (s += d));
        p.on("error", reject);
        p.on("close", () => resolve(JSON.parse(s.trim())));
      });
    const both = await Promise.all([run(), run()]);
    h = makeHarness(t.dbPath);
    wire();
    expect(both.every((o) => o.ok && o.docNo === 1)).toBe(true);
    expect(both.map((o) => o.duplicate).sort()).toEqual([false, true]);
    expect([count("advance_refunds"), refNo()]).toEqual([1, 1]);
    // a third, direct check of the database itself
    const db = new Database(t.dbPath, { readonly: true });
    try {
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  }, 120000);
});
