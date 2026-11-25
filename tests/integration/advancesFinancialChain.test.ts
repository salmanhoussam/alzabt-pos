/**
 * ADVANCES FULL FINANCIAL INTEGRATION (owner review DEC-35zz+, 2026-11-12) — ONE connected story on ONE real
 * SQLite ledger, through the real services and IPC handlers, with real restarts, real process death and real
 * concurrent processes. After EVERY step the global invariants are re-checked:
 *
 *   I1  no advance balance is negative (amount − applications − refunds ≥ 0; a corrected advance holds 0)
 *   I2  no debt is over-settled, and a debt paid in full owes exactly 0
 *   I3  ADV- / REF- / COL- numbers are unique and contiguous 1..N (never a gap, never reused)
 *   I4  Daily Money = the ledger, independently re-derived in SQL: money in, refunds (cash out), applications
 *   I5  integrity_check ok, no foreign-key violation
 *
 * Synthetic data only. Harness clock: 2026-10-04, Beirut. Amounts in minor units (USD cents).
 */
import { TEST_OWNER_PIN, TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdvanceService } from "../../src/application/advanceService";
import { DailyMoneyService } from "../../src/application/dailyMoneyService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { snapshotDatabase } from "../../src/persistence/backup";
import { DailyMoneyRepository } from "../../src/persistence/dailyMoneyRepository";
import type { CollectionDocumentDto, CustomerStatementDto, IpcResult, RecordPaymentResponse } from "../../src/shared/ipcContract";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

const DAY = "2026-10-04";
const X2 = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };
const X1 = { lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: 250n };

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let dm: DailyMoneyService;
let ipc: ReturnType<typeof syncHandlers>;

function wire(path: string) {
  h = makeHarness(path);
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
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger, advances: adv, dailyMoney: dm }));
}
/** A real restart: the connection is closed (nothing kept in memory) and the ledger is reopened from disk. */
function restart(path = t.dbPath) {
  h.db.close();
  wire(path);
}

const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const code = (r: IpcResult<unknown>) => (r.ok ? "OK" : r.error.code);
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "OK";
};
const num = (sql: string, ...p: unknown[]): bigint => {
  const v = Object.values(h.db.prepare(sql).get(...p) as Record<string, unknown>)[0];
  return v === null || v === undefined ? 0n : BigInt(v as number | bigint);
};
const rows = (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p) as Record<string, unknown>[];
const recordAdvance = (customerId: string, minor: bigint, channel: "cash" | "whish" = "cash", reference?: string) => {
  const k = newKey();
  const r = adv.record({ customerId, amountMinor: minor, channel, ...(reference ? { reference, fundsConfirmed: true } : {}), idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
};
const creditSale = (customerId: string, draft = X2) => {
  const s = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId, ...draft });
  return h.ledger.findSaleObligation(s.sale.id)!;
};
const unused = (advanceId: string) => adv.statement(rows("SELECT customer_id AS c FROM customer_advances WHERE id = ?", advanceId)[0]!.c as string).find((l) => l.advance.id === advanceId)!.unusedMinor;
const owed = (obligationId: string) => h.ledger.outstandingOf(obligationId).minor;
/** Everything money-bearing + every counter: "nothing written" is checked everywhere at once. */
const footprint = () =>
  JSON.stringify(
    ["sales", "sale_tenders", "settlements", "receipts", "customer_advances", "advance_applications", "advance_refunds", "advance_corrections", "collection_documents", "external_references"].map((x) =>
      num(`SELECT count(*) FROM ${x}`).toString(),
    ).concat(rows("SELECT kind, last_no FROM document_numbers ORDER BY kind").map((r) => `${r.kind}=${r.last_no}`)),
  );

/** I1..I5 — called after every step. */
function invariants(step: string) {
  // I1
  const negative = rows(
    `SELECT a.id FROM customer_advances a
      WHERE a.amount_minor - coalesce((SELECT sum(amount_minor) FROM advance_applications WHERE advance_id = a.id), 0)
                           - coalesce((SELECT sum(amount_minor) FROM advance_refunds WHERE advance_id = a.id), 0) < 0
         OR (EXISTS (SELECT 1 FROM advance_corrections c WHERE c.advance_id = a.id)
             AND (EXISTS (SELECT 1 FROM advance_applications WHERE advance_id = a.id) OR EXISTS (SELECT 1 FROM advance_refunds WHERE advance_id = a.id)))`,
  );
  expect(negative, `${step}: I1 advance balances`).toEqual([]);
  // I2
  const over = rows("SELECT o.id FROM obligations o WHERE coalesce((SELECT sum(amount_minor) FROM settlements WHERE obligation_id = o.id), 0) > o.amount_minor");
  expect(over, `${step}: I2 no over-settled debt`).toEqual([]);
  // I3
  const contiguous = (table: string, kind: string) => {
    const nos = rows(`SELECT doc_no AS n FROM ${table} ORDER BY doc_no`).map((r) => Number(r.n));
    const last = Number(num("SELECT last_no FROM document_numbers WHERE kind = ?", kind));
    expect(nos, `${step}: I3 ${kind} numbers 1..${last}`).toEqual(Array.from({ length: last }, (_, i) => i + 1));
  };
  contiguous("customer_advances", "advance");
  contiguous("advance_refunds", "advance_refund");
  contiguous("collection_documents", "collection");
  // I4 — re-derived independently, in SQL, from the rows themselves.
  const r = dm.day(DAY);
  const salesIn = num(
    `SELECT coalesce(sum(t.amount_minor),0) FROM sales s JOIN sale_tenders t ON t.sale_id = s.id WHERE s.business_date = ?`,
    DAY,
  ) + num("SELECT coalesce(sum(paid_minor),0) FROM sales WHERE business_date = ? AND tender_count = 0", DAY);
  const directCollections = num(
    `SELECT coalesce(sum(st.amount_minor),0) FROM settlements st JOIN obligations o ON o.id = st.obligation_id
      WHERE st.business_date = ? AND st.receipt_id IS NULL AND o.direction = 'receivable'
        AND NOT EXISTS (SELECT 1 FROM advance_applications aa WHERE aa.settlement_id = st.id)`,
    DAY,
  );
  const receiptsIn = num("SELECT coalesce(sum(amount_minor),0) FROM receipts WHERE business_date = ?", DAY);
  const advancesIn = num("SELECT coalesce(sum(amount_minor),0) FROM customer_advances WHERE business_date = ? AND origin = 'receipt'", DAY);
  const corrections =
    num("SELECT coalesce(sum(s.amount_minor),0) FROM advance_corrections c JOIN customer_advances s ON s.id = c.successor_advance_id WHERE c.business_date = ?", DAY) -
    num("SELECT coalesce(sum(o.amount_minor),0) FROM advance_corrections c JOIN customer_advances o ON o.id = c.advance_id WHERE c.business_date = ?", DAY);
  const refunds = num("SELECT coalesce(sum(amount_minor),0) FROM advance_refunds WHERE business_date = ?", DAY);
  const applied = num("SELECT coalesce(sum(aa.amount_minor),0) FROM advance_applications aa JOIN settlements s ON s.id = aa.settlement_id WHERE s.business_date = ?", DAY);
  expect(
    { in: r.moneyIn.totalMinor, refunds: r.refunds.totalMinor, refundsCash: r.refunds.byChannel.cash, out: r.moneyOut.totalMinor, applied: r.advanceApplied.totalMinor, net: r.net.totalMinor },
    `${step}: I4 Daily Money = ledger`,
  ).toEqual({ in: salesIn + directCollections + receiptsIn + advancesIn + corrections, refunds, refundsCash: refunds, out: refunds, applied, net: salesIn + directCollections + receiptsIn + advancesIn + corrections - refunds });
  // I5
  expect(h.db.prepare("PRAGMA integrity_check").get(), `${step}: I5`).toEqual({ integrity_check: "ok" });
  expect(h.db.prepare("PRAGMA foreign_key_check").all(), `${step}: I5 fk`).toEqual([]);
}

beforeAll(() => {
  t = tempDir();
  wire(t.dbPath);
});
afterAll(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

// Shared story state (the tests below run IN ORDER on the same ledger).
type Key = "A" | "B" | "adv1" | "adv2" | "adv3" | "adv4" | "adv5" | "d1" | "d2" | "d3" | "d4" | "k2" | "k3" | "k4" | "k5" | "k5b";
const S = {} as Record<Key, string>;

describe("advances × REF × COL — one connected story on one real ledger", () => {
  it("1 · advances: cash + Whish recorded; one corrected NOT RECEIVED; one REPLACED onto another customer — before any use", () => {
    S.A = h.parties.create({ kind: "customer", displayName: "زبون التكامل أ" }).party.id;
    S.B = h.parties.create({ kind: "customer", displayName: "زبون التكامل ب" }).party.id;
    S.adv1 = recordAdvance(S.A, 5000n).id;
    S.adv2 = recordAdvance(S.A, 3000n, "whish", "WH-INT-1").id;
    S.adv3 = recordAdvance(S.B, 2000n).id;
    S.adv4 = recordAdvance(S.A, 1000n).id;
    const inBefore = dm.day(DAY).moneyIn.totalMinor;
    adv.correct({ advanceId: S.adv3, kind: "not_received", reason: "لم يدفع", confirmNotReceived: true, idempotencyKey: newKey() });
    const repl = adv.correct({ advanceId: S.adv4, kind: "replaced", reason: "على الزبون الخطأ", customerId: S.B, idempotencyKey: newKey() });
    S.adv5 = repl.successor!.id;
    // not received = −20.00; a pure re-link to another customer = 0 net
    expect(dm.day(DAY).moneyIn.totalMinor).toBe(inBefore - 2000n);
    expect([unused(S.adv3), unused(S.adv4), unused(S.adv5)]).toEqual([0n, 0n, 1000n]);
    expect(rows("SELECT count(*) AS n FROM external_references WHERE owner_kind = 'advance'")[0]!.n).toBe(1n);
    invariants("1");
  });

  it("2 · apply ADV-1 PARTLY to an existing debt (3.00 of 5.00): no new money, debt 2.00 left", () => {
    S.d1 = creditSale(S.A).id;
    const before = dm.day(DAY);
    const r = adv.applyToDebt({ advanceId: S.adv1, obligationId: S.d1, amountMinor: 300n, idempotencyKey: (S.k2 = newKey()) });
    expect([r.unusedMinor, r.debtOutstandingMinor]).toEqual([4700n, 200n]);
    const after = dm.day(DAY);
    expect([after.moneyIn.totalMinor, after.collections.totalMinor]).toEqual([before.moneyIn.totalMinor, before.collections.totalMinor]);
    expect(after.advanceApplied.totalMinor - before.advanceApplied.totalMinor).toBe(300n);
    invariants("2");
  });

  it("3 · apply the REMAINDER to a NEW sale (5.00 of what is left): one sale, no tender, nothing owed", () => {
    const before = dm.day(DAY);
    const r = adv.sellOnAdvance({ idempotencyKey: (S.k3 = newKey()), customerId: S.A, ...X2, advanceId: S.adv1, amountMinor: 500n });
    expect([r.application.unusedMinor, r.application.debtOutstandingMinor, num("SELECT count(*) FROM sale_tenders WHERE sale_id = ?", r.sale.id)]).toEqual([4200n, 0n, 0n]);
    expect(dm.day(DAY).moneyIn.totalMinor).toBe(before.moneyIn.totalMinor);
    invariants("3");
  });

  it("4 · REFUND the rest in CASH: ADV-1 42.00 → 0; the WHISH ADV-2 partly (10.00) — both cash out, never Whish out", () => {
    const before = dm.day(DAY);
    const r1 = adv.refund({ advanceId: S.adv1, amountMinor: 4200n, reason: "إغلاق الرصيد", idempotencyKey: (S.k4 = newKey()) });
    const r2 = adv.refund({ advanceId: S.adv2, amountMinor: 1000n, reason: "طلب جزئي", idempotencyKey: newKey() });
    expect([r1.refund.docNo, r1.unusedMinor, r2.refund.docNo, r2.unusedMinor]).toEqual([1, 0n, 2, 2000n]);
    expect(codeOf(() => adv.refund({ advanceId: S.adv1, amountMinor: 1n, reason: "زيادة", idempotencyKey: newKey() }))).toBe("ADVANCE_REFUND_ABOVE_BALANCE");
    expect(codeOf(() => adv.refund({ advanceId: S.adv3, amountMinor: 1n, reason: "مصحّحة", idempotencyKey: newKey() }))).toBe("ADVANCE_CORRECTED_NOT_REFUNDABLE");
    const after = dm.day(DAY);
    expect([after.refunds.byChannel.cash - before.refunds.byChannel.cash, after.refunds.byChannel.whish, after.moneyIn.totalMinor]).toEqual([5200n, 0n, before.moneyIn.totalMinor]);
    invariants("4");
  });

  it("5 · COLLECT debts: the 2.00 left on D1 in CASH (COL-1, debt closed); a shared WHISH transfer on two new debts (ONE COL-2)", () => {
    const before = dm.day(DAY);
    const c1 = ok<RecordPaymentResponse>(ipc.recordCustomerPayment({ customerId: S.A, obligationId: S.d1, idempotencyKey: (S.k5 = newKey()), amountMinor: "200", method: "cash" } as never));
    expect([c1.collection!.number, owed(S.d1)]).toEqual(["COL-000001", 0n]);
    expect(code(ipc.recordCustomerPayment({ customerId: S.A, obligationId: S.d1, idempotencyKey: newKey(), amountMinor: "1", method: "cash" } as never))).toBe("INVALID_AMOUNT");
    S.d2 = creditSale(S.A).id;
    S.d3 = creditSale(S.A, X1).id;
    const shared = ok<{ collection: CollectionDocumentDto }>(
      ipc.recordAllocatedReceipt({
        customerId: S.A,
        idempotencyKey: (S.k5b = newKey()),
        channel: "whish",
        reference: "WH-INT-2",
        fundsConfirmed: true,
        currency: "USD",
        totalMinor: "750",
        allocations: [
          { obligationId: S.d2, amountMinor: "500" },
          { obligationId: S.d3, amountMinor: "250" },
        ],
      } as never),
    );
    expect([shared.collection.number, shared.collection.lines.length, owed(S.d2), owed(S.d3)]).toEqual(["COL-000002", 2, 0n, 0n]);
    const after = dm.day(DAY);
    expect([after.collections.byChannel.cash - before.collections.byChannel.cash, after.collections.byChannel.whish - before.collections.byChannel.whish]).toEqual([200n, 750n]);
    // the reference of the transfer is registered ONCE; the advance's Whish reference still once
    expect(rows("SELECT ref_display AS r FROM external_references ORDER BY ref_display").map((x) => x.r)).toEqual(["WH-INT-1", "WH-INT-2"]);
    invariants("5");
  });

  it("6 · RESTART: every number, balance and document survives; retries of each step answer the SAME result and write nothing", () => {
    const fp = footprint();
    restart();
    expect(footprint()).toBe(fp);
    expect(adv.applyToDebt({ advanceId: S.adv1, obligationId: S.d1, amountMinor: 300n, idempotencyKey: S.k2 }).duplicate).toBe(true);
    expect(adv.refund({ advanceId: S.adv1, amountMinor: 4200n, reason: "إغلاق الرصيد", idempotencyKey: S.k4 }).duplicate).toBe(true);
    const again = ok<RecordPaymentResponse>(ipc.recordCustomerPayment({ customerId: S.A, obligationId: S.d1, idempotencyKey: S.k5, amountMinor: "200", method: "cash" } as never));
    expect([again.duplicate, again.collection!.number]).toEqual([true, "COL-000001"]);
    expect(footprint()).toBe(fp);
    invariants("6");
  });

  it("7 · statements tell one story: D1 = ADV-000001 (applied, no COL) + COL-000001 cash; D2/D3 share COL-000002; ADV-1 lists its REF-", () => {
    const st = ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: S.A }));
    const d1 = st.obligations.find((o) => o.id === S.d1)!;
    // (the harness clock is frozen, so rows of one debt tie on time: compared as a set)
    expect(d1.settlements.map((s) => [s.amount.minor, s.advance?.number ?? null, s.collection?.number ?? null]).sort()).toEqual([
      ["200", null, "COL-000001"],
      ["300", "ADV-000001", null],
    ]);
    for (const id of [S.d2, S.d3]) expect(st.obligations.find((o) => o.id === id)!.settlements.map((s) => s.collection?.number)).toEqual(["COL-000002"]);
    const advSt = ok<{ lines: { advance: { number: string }; unused: { minor: string }; refunds: { number: string }[] }[] }>(ipc.getAdvanceStatement({ customerId: S.A }));
    expect(advSt.lines.map((l) => [l.advance.number, l.unused.minor, l.refunds.map((r) => r.number)])).toEqual([
      ["ADV-000001", "0", ["REF-000001"]],
      ["ADV-000002", "2000", ["REF-000002"]],
      ["ADV-000004", "0", []],
    ]);
  });

  it("8 · REPRINTS (REF- and COL- documents, read three times) write NOTHING", () => {
    const fp = footprint();
    const refs = rows("SELECT id FROM advance_refunds").map((r) => r.id as string);
    for (let i = 0; i < 3; i++) {
      for (const id of refs) adv.refundDocument(id);
      for (const n of [1, 2]) ok(ipc.getCollectionReceipt({ collectionNo: n }));
    }
    expect(footprint()).toBe(fp);
  });

  it("9 · REAL process death inside a refund / after a collection commit, then retries — nothing doubled", () => {
    const CHILD = join(__dirname, "..", "helpers", "advanceCrashChild.ts");
    const COLCHILD = join(__dirname, "..", "helpers", "collectionCrashChild.ts");
    S.d4 = creditSale(S.A).id;
    h.db.close();
    const r1 = spawnSync(process.execPath, ["--import", "tsx", CHILD, "refund-inside-tx", t.dbPath, S.adv5, "int-ref-crash-01"], { encoding: "utf8", timeout: 60000 });
    const r2 = spawnSync(process.execPath, ["--import", "tsx", COLCHILD, "after-commit", t.dbPath, S.A, S.d4, "int-col-crash-01"], { encoding: "utf8", timeout: 60000 });
    expect([r1.stderr.includes("KILL-POINT-REACHED"), r2.stderr.includes("KILL-POINT-REACHED")]).toEqual([true, true]);
    wire(t.dbPath);
    expect([num("SELECT count(*) FROM advance_refunds WHERE advance_id = ?", S.adv5), unused(S.adv5)]).toEqual([0n, 1000n]);
    expect([num("SELECT count(*) FROM settlements WHERE obligation_id = ?", S.d4), num("SELECT last_no FROM document_numbers WHERE kind = 'collection'")]).toEqual([1n, 3n]);
    const retry = ok<RecordPaymentResponse>(ipc.recordCustomerPayment({ customerId: S.A, obligationId: S.d4, idempotencyKey: "int-col-crash-01", amountMinor: "100", method: "cash" } as never));
    expect([retry.duplicate, retry.collection!.number]).toEqual([true, "COL-000003"]);
    expect(adv.refund({ advanceId: S.adv5, amountMinor: 400n, reason: "الزبون طلب استرداد", idempotencyKey: "int-ref-crash-01" }).refund.docNo).toBe(3);
    invariants("9");
  });

  it("10 · two REAL processes refund 15.00 + 15.00 of the 20.00 left on the Whish ADV-2: exactly one wins, the balance never goes negative", async () => {
    const CHILD = join(__dirname, "..", "helpers", "advanceCrashChild.ts");
    h.db.close();
    const run = (key: string) =>
      new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
        const p = spawn(process.execPath, ["--import", "tsx", CHILD, "refund-run", t.dbPath, S.adv2, key], { env: { ...process.env, REFUND_AMOUNT: "1500", REFUND_CONFIRM_REPEAT: "1" } }); // TRANSITION (DEC-35zz++ Option A): a 2nd+ refund of the SAME advance on the SAME day now needs confirmRepeat; old: none.
        let s = "";
        p.stdout.on("data", (d) => (s += d));
        p.on("error", reject);
        p.on("close", () => resolve(JSON.parse(s.trim())));
      });
    const both = await Promise.all([run("int-race-ref-A"), run("int-race-ref-B")]);
    wire(t.dbPath);
    expect(both.filter((x) => x.ok).length).toBe(1);
    expect(both.filter((x) => !x.ok).map((x) => x.code)).toEqual(["ADVANCE_REFUND_ABOVE_BALANCE"]);
    expect(unused(S.adv2)).toBe(500n);
    invariants("10");
  }, 120000);

  it("11 · BACKUP / RESTORE: the snapshot holds the same story; the invariants hold on it; numbering continues there", () => {
    const fp = footprint();
    const dest = join(t.dir, "integration-backup.sqlite");
    snapshotDatabase(h.db, dest);
    const original = t.dbPath;
    h.db.close();
    wire(dest);
    expect(footprint()).toBe(fp);
    invariants("11-restored");
    // TRANSITION (DEC-35zz++ Option A): a 2nd+ refund of the SAME advance on the SAME day now needs confirmRepeat; old: none.
    expect(adv.refund({ advanceId: S.adv2, amountMinor: 500n, reason: "إغلاق", idempotencyKey: newKey(), confirmRepeat: true }).refund.docNo).toBe(5);
    expect(ok<RecordPaymentResponse>(ipc.recordCustomerPayment({ customerId: S.A, obligationId: S.d4, idempotencyKey: newKey(), amountMinor: "400", method: "cash" } as never)).collection!.number).toBe("COL-000004");
    invariants("11-continued");
    h.db.close();
    wire(original);
  });

  it("12 · PERMISSIONS by ROLE: the cashier records an advance (D1) and nothing else; every money read/write of the owner is refused; NOTHING written", async () => {
    h.service.logout();
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect(h.service.currentRole()).toBe("cashier");
    const fp0 = footprint();
    const k = newKey();
    expect(code(ipc.recordAdvance({ customerId: S.B, amountMinor: "100", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: k }))).toBe("OK");
    ipc.acknowledgeAdvance({ idempotencyKey: k });
    const fp = footprint();
    expect(fp).not.toBe(fp0);
    const refused = {
      statement: code(ipc.getAdvanceStatement({ customerId: S.A })),
      debtStatement: code(ipc.getCustomerStatement({ customerId: S.A })),
      dailyMoney: code(ipc.getDailyMoney({})),
      apply: code(ipc.applyAdvanceToDebt({ advanceId: S.adv5, obligationId: S.d4, amountMinor: "1", idempotencyKey: newKey() })),
      refund: code(ipc.refundAdvance({ advanceId: S.adv5, amountMinor: "1", reason: "كاشير", idempotencyKey: newKey() })),
      correct: code(ipc.correctAdvance({ advanceId: S.adv5, kind: "not_received", reason: "كاشير", confirmNotReceived: true, idempotencyKey: newKey() })),
      collect: code(ipc.recordCustomerPayment({ customerId: S.A, obligationId: S.d4, idempotencyKey: newKey(), amountMinor: "1", method: "cash" } as never)),
      colDoc: code(ipc.getCollectionReceipt({ collectionNo: 1 })),
    };
    expect(refused).toEqual({ statement: "NOT_AUTHORIZED", debtStatement: "NOT_AUTHORIZED", dailyMoney: "NOT_AUTHORIZED", apply: "NOT_AUTHORIZED", refund: "NOT_AUTHORIZED", correct: "NOT_AUTHORIZED", collect: "NOT_AUTHORIZED", colDoc: "NOT_AUTHORIZED" });
    const all = createIpcHandlers(h.service, { ledger: h.ledger, advances: adv, printAdvanceRefund: async () => "printed", printCollectionReceipt: async () => "printed" });
    expect([code(await all.printAdvanceRefund({ refundId: "x" })), code(await all.printCollectionReceipt({ collectionNo: 1 }))]).toEqual(["NOT_AUTHORIZED", "NOT_AUTHORIZED"]);
    expect(footprint()).toBe(fp);
    // 🔴 The ROLE decides, never the name: rename the cashier to "Owner" — still refused.
    h.service.logout();
    h.service.login("cashier-01", TEST_OWNER_PIN);
    h.db.prepare("UPDATE operators SET name = 'Owner (by name only)' WHERE id = 'cashier-02'").run();
    h.service.logout();
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect([h.service.currentCashier()!.name, h.service.currentRole(), code(ipc.getDailyMoney({}))]).toEqual(["Owner (by name only)", "cashier", "NOT_AUTHORIZED"]);
    h.service.logout();
    h.service.login("cashier-01", TEST_OWNER_PIN);
    expect([h.service.currentCashier()!.name, h.service.currentRole(), code(ipc.getDailyMoney({}))]).toEqual(["Cashier One", "owner", "OK"]);
    invariants("12");
  });
});
