/**
 * DEC-35z+ COL — numbered COL- receipts for customer collections (cash / Whish) and shared Whish
 * receipts. Real SQLite, real services, through the real IPC handlers where it matters.
 *
 * 🔴 THE RULES THESE PROTECT (D-P4a/b + owner decision DEC-35z+):
 *   · ONE COL- per real money arrival, issued INSIDE the money transaction (atomic, never a gap)
 *   · a shared transfer gets ONE COL- (not one per debt); a replay answers the SAME COL-
 *   · no COL- for an advance application, a sale on an advance, or a supplier payment
 *   · the document is READ-ONLY: printing records no payment and registers no reference again
 *   · no double counting in Daily Money; history is never numbered retroactively
 *   · owner only, like the collection itself (no new cashier right)
 *   · crash-safe (REAL process death) and backup/restore keeps the numbering
 *
 * Synthetic data only. Amounts in minor units (USD cents). Harness clock: 2026-10-04, Beirut.
 */
import { TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyMoneyService } from "../../src/application/dailyMoneyService";
import { type LedgerService, formatCollectionNo } from "../../src/application/ledgerService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { renderCollectionDocument } from "../../src/main/collectionDocument";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { snapshotDatabase } from "../../src/persistence/backup";
import { DailyMoneyRepository } from "../../src/persistence/dailyMoneyRepository";
import type { CollectionDocumentDto, CustomerStatementDto, IpcResult, RecordPaymentResponse } from "../../src/shared/ipcContract";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
let dm: DailyMoneyService;
let printed: string[];
const DAY = "2026-10-04";

function wire() {
  printed = [];
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
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger, advances: makeAdvances(h), dailyMoney: dm }));
}
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  wire();
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const errCode = (r: IpcResult<unknown>) => (r.ok ? "OK" : r.error.code);
const count = (table: string, where = "1=1") => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
const colNo = () => Number((h.db.prepare("SELECT last_no FROM document_numbers WHERE kind = 'collection'").get() as { last_no: bigint }).last_no);
const footprint = () => [...["settlements", "receipts", "collection_documents", "external_references", "advance_applications"].map((x) => count(x)), colNo()];
const customer = (name = "زبون التحصيل") => h.parties.create({ kind: "customer", displayName: name }).party;
const owe = (partyId: string, ref: string, minor = 1000n) =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
const pay = (c: { id: string }, o: { id: string }, amountMinor: string, key = newKey(), extra: Record<string, unknown> = {}) =>
  ipc.recordCustomerPayment({ customerId: c.id, obligationId: o.id, idempotencyKey: key, amountMinor, method: "cash", ...extra } as never);
const payWhish = (c: { id: string }, o: { id: string }, amountMinor: string, reference: string, key = newKey()) =>
  pay(c, o, amountMinor, key, { method: "whish", reference, fundsConfirmed: true });
const shared = (c: { id: string }, a: { id: string }, b: { id: string }, reference: string, key = newKey()) =>
  ipc.recordAllocatedReceipt({
    customerId: c.id,
    idempotencyKey: key,
    channel: "whish",
    reference,
    fundsConfirmed: true,
    currency: "USD",
    totalMinor: "500",
    allocations: [
      { obligationId: a.id, amountMinor: "300" },
      { obligationId: b.id, amountMinor: "200" },
    ],
  } as never);

describe("COL — one numbered receipt per real money arrival", () => {
  it("a CASH collection → COL-000001 in the same transaction: the document names the customer, the debt, the money and who took it", () => {
    const c = customer();
    const o = owe(c.id, "دفتر-12");
    const r = ok<RecordPaymentResponse>(pay(c, o, "400"));
    expect(r.collection).toMatchObject({
      docNo: 1,
      number: "COL-000001",
      customerName: "زبون التحصيل",
      total: { minor: "400", currency: "USD" },
      channel: "cash",
      reference: null,
      receivedByName: expect.any(String),
      businessDate: DAY,
    });
    expect(r.collection!.lines).toEqual([{ obligationId: o.id, debtDocument: { kind: "manual", reference: "دفتر-12" }, amount: { minor: "400", currency: "USD" } }]);
    expect(r.settlement.collection).toEqual({ docNo: 1, number: "COL-000001" });
    expect(h.db.prepare("SELECT doc_no AS n, settlement_id AS s, receipt_id AS r FROM collection_documents").all()).toEqual([{ n: 1n, s: r.settlement.id, r: null }]);
    expect(colNo()).toBe(1);
    expect(formatCollectionNo(123)).toBe("COL-000123");
  });

  it("🔴 a WHISH collection keeps its ORIGINAL reference; reading / printing the COL- registers nothing and writes no payment", async () => {
    const c = customer();
    const o = owe(c.id, "P-W");
    const r = ok<RecordPaymentResponse>(payWhish(c, o, "250", "WH-COL-1"));
    expect([r.collection!.channel, r.collection!.reference, r.collection!.number]).toEqual(["whish", "WH-COL-1", "COL-000001"]);
    const fp = footprint();
    const all = createIpcHandlers(h.service, { ledger: h.ledger, printCollectionReceipt: async (d) => (printed.push(d.number), "printed") });
    for (let i = 0; i < 3; i++) {
      ok(ipc.getCollectionReceipt({ collectionNo: 1 }));
      expect(ok<{ status: string }>(await all.printCollectionReceipt({ collectionNo: 1 }))).toEqual({ status: "printed" });
    }
    expect(printed).toEqual(["COL-000001", "COL-000001", "COL-000001"]);
    expect(footprint()).toEqual(fp);
    expect(count("external_references", "ref_display = 'WH-COL-1'")).toBe(1);
  });

  it("🔴 a SHARED transfer across two debts gets ONE COL- (not one per debt); both statement rows point at it", () => {
    const c = customer();
    const a = owe(c.id, "A", 300n);
    const b = owe(c.id, "B", 400n);
    const r = ok<{ collection: CollectionDocumentDto; statement: CustomerStatementDto }>(shared(c, a, b, "WH-SHARED-COL"));
    expect([r.collection.number, r.collection.total.minor, r.collection.lines.length, r.collection.reference]).toEqual(["COL-000001", "500", 2, "WH-SHARED-COL"]);
    expect([count("collection_documents"), count("collection_documents", "receipt_id IS NOT NULL"), colNo()]).toEqual([1, 1, 1]);
    const rows = r.statement.obligations.flatMap((o) => o.settlements.map((s) => s.collection?.number));
    expect(rows).toEqual(["COL-000001", "COL-000001"]);
  });

  it("numbers run in order across collections and receipts, never restarting", () => {
    const c = customer();
    const o1 = owe(c.id, "1");
    const a = owe(c.id, "A", 300n);
    const b = owe(c.id, "B", 400n);
    expect(ok<RecordPaymentResponse>(pay(c, o1, "100")).collection!.number).toBe("COL-000001");
    expect(ok<{ collection: CollectionDocumentDto }>(shared(c, a, b, "WH-ORDER")).collection.number).toBe("COL-000002");
    expect(ok<RecordPaymentResponse>(pay(c, o1, "100")).collection!.number).toBe("COL-000003");
  });
});

describe("🔴 retry, refusal and rollback never mint or reuse a number", () => {
  it("a lost reply: the SAME key returns the SAME COL- (collection AND shared receipt); nothing new", () => {
    const c = customer();
    const o = owe(c.id, "P");
    const a = owe(c.id, "A", 300n);
    const b = owe(c.id, "B", 400n);
    const first = ok<RecordPaymentResponse>(pay(c, o, "400", "col-lost-key-0001"));
    const rFirst = ok<{ collection: CollectionDocumentDto }>(shared(c, a, b, "WH-LOST", "col-lost-rcpt-0001"));
    const fp = footprint();
    const again = ok<RecordPaymentResponse>(pay(c, o, "400", "col-lost-key-0001"));
    const rAgain = ok<{ collection: CollectionDocumentDto; duplicate: boolean }>(shared(c, a, b, "WH-LOST", "col-lost-rcpt-0001"));
    expect([again.duplicate, again.collection!.number, rAgain.duplicate, rAgain.collection.number]).toEqual([true, first.collection!.number, true, rFirst.collection.number]);
    expect(footprint()).toEqual(fp);
  });

  it("a refused collection (above the debt, duplicate reference, cashier) consumes NO number", () => {
    const c = customer();
    const o = owe(c.id, "P", 500n);
    payWhish(c, o, "100", "WH-TAKEN");
    const fp = footprint();
    expect(errCode(pay(c, o, "9999"))).toBe("INVALID_AMOUNT");
    expect(errCode(payWhish(c, o, "100", "wh taken"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    h.service.logout();
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect(errCode(pay(c, o, "100"))).toBe("NOT_AUTHORIZED");
    expect(errCode(ipc.getCollectionReceipt({ collectionNo: 1 }))).toBe("NOT_AUTHORIZED");
    expect(footprint()).toEqual(fp);
  });

  it("🔴 a failure AFTER the COL number was issued rolls the money AND the number back", () => {
    const c = customer();
    const o = owe(c.id, "P");
    const ledger = h.ledger as LedgerService & { afterCollectionNumberIssued: () => void };
    const original = ledger.afterCollectionNumberIssued;
    ledger.afterCollectionNumberIssued = () => {
      throw new Error("disk full (simulated)");
    };
    expect(() => h.ledger.collect({ customerId: c.id, obligationId: o.id, partyId: c.id, idempotencyKey: "col-fail-key-0001", amountMinor: 400n, method: "cash", channel: "cash" })).toThrow(/disk full/);
    ledger.afterCollectionNumberIssued = original;
    expect([count("settlements"), count("collection_documents"), colNo()]).toEqual([0, 0, 0]);
    // The attempt stayed OPEN (an internal fault proves nothing): the same key continues, once, as COL-000001.
    expect(ok<RecordPaymentResponse>(pay(c, o, "400", "col-fail-key-0001")).collection!.number).toBe("COL-000001");
  });
});

describe("🔴 NOT a collection → no COL-", () => {
  it("an advance applied to a debt, a sale on an advance, and a supplier payment get no COL-; the statement says why nothing is numbered", () => {
    const c = customer();
    const adv = makeAdvances(h);
    const k = newKey();
    const a = adv.record({ customerId: c.id, amountMinor: 3000n, channel: "cash", idempotencyKey: k }).record;
    adv.acknowledge(k);
    const d = owe(c.id, "P", 500n);
    adv.applyToDebt({ advanceId: a.id, obligationId: d.id, amountMinor: 500n, idempotencyKey: newKey() });
    adv.sellOnAdvance({ idempotencyKey: newKey(), customerId: c.id, lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n, advanceId: a.id, amountMinor: 300n });
    const s = h.parties.create({ kind: "supplier", displayName: "مورد" }).party;
    const bill = h.ledger.postObligation({ partyId: s.id, direction: "payable", sourceKind: "manual", sourceRef: "BILL", currency: "USD", amountMinor: 500n }).record;
    h.ledger.settle({ obligationId: bill.id, partyId: s.id, idempotencyKey: newKey(), amountMinor: 200n, method: "cash" });
    expect([count("settlements"), count("collection_documents"), colNo()]).toEqual([3, 0, 0]);
    const st = ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
    const rows = st.obligations.flatMap((o) => o.settlements);
    expect(rows.every((r) => r.collection === null && r.advance !== null)).toBe(true);
  });

  it("🔴 HISTORY is never numbered retroactively: a collection written before COL stays without a number, and reading it mints none", () => {
    const c = customer();
    const o = owe(c.id, "OLD");
    // A settlement as an older build wrote it: the row, no document.
    h.ledgerStore.insertSettlement({
      id: "legacy-settlement-1",
      obligationId: o.id,
      currency: "USD",
      idempotencyKey: "legacy-collect-0001",
      requestFingerprint: "fp-legacy",
      amountMinor: 200n,
      method: "cash",
      provider: null,
      reference: null,
      fundsConfirmed: null,
      settledBy: "cashier-01",
      settledAt: "2026-10-01T09:00:00.000Z",
      businessDate: "2026-10-01",
    });
    for (let i = 0; i < 2; i++) {
      const st = ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
      expect(st.obligations[0]!.settlements[0]!.collection).toBeNull();
    }
    expect([count("collection_documents"), colNo()]).toEqual([0, 0]);
    // The next real collection is still COL-000001.
    expect(ok<RecordPaymentResponse>(pay(c, o, "100")).collection!.number).toBe("COL-000001");
  });
});

describe("Daily Money — the document adds nothing", () => {
  it("🔴 money in counts each payment ONCE (a shared receipt once, not per share); documents and reprints change nothing", async () => {
    const c = customer();
    const o = owe(c.id, "P");
    const a = owe(c.id, "A", 300n);
    const b = owe(c.id, "B", 400n);
    const before = dm.day(DAY);
    pay(c, o, "400");
    shared(c, a, b, "WH-DM-COL");
    const after = dm.day(DAY);
    expect(after.collections.totalMinor - before.collections.totalMinor).toBe(900n);
    expect([after.collections.byChannel.cash - before.collections.byChannel.cash, after.collections.byChannel.whish - before.collections.byChannel.whish]).toEqual([400n, 500n]);
    expect(after.collections.count - before.collections.count).toBe(2);
    const all = createIpcHandlers(h.service, { ledger: h.ledger, printCollectionReceipt: async () => "printed" });
    await all.printCollectionReceipt({ collectionNo: 1 });
    await all.printCollectionReceipt({ collectionNo: 2 });
    expect(dm.day(DAY)).toEqual(after);
  });
});

describe("IPC surface and the printed document", () => {
  it("strict payload; unknown number; no printer; owner only", async () => {
    const c = customer();
    pay(c, owe(c.id, "P"), "100");
    const all = createIpcHandlers(h.service, { ledger: h.ledger });
    expect(errCode(ipc.getCollectionReceipt({ collectionNo: 99 }))).toBe("COLLECTION_DOCUMENT_NOT_FOUND");
    expect(errCode(ipc.getCollectionReceipt({ collectionNo: "1" }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.getCollectionReceipt({ collectionNo: 1, html: "<b>" }))).toBe("INVALID_INPUT");
    expect(ok<{ status: string }>(await all.printCollectionReceipt({ collectionNo: 1 }))).toEqual({ status: "unavailable" });
    expect(errCode(await all.saveCollectionReceiptPdf({ collectionNo: 1 }))).toBe("NOT_AVAILABLE");
    const failing = createIpcHandlers(h.service, { ledger: h.ledger, printCollectionReceipt: async () => Promise.reject(new Error("printer offline")) });
    const fp = footprint();
    expect((await failing.printCollectionReceipt({ collectionNo: 1 })).ok).toBe(false);
    expect(footprint()).toEqual(fp);
  });

  const doc = (over: Partial<CollectionDocumentDto> = {}): CollectionDocumentDto => ({
    docNo: 7,
    number: "COL-000007",
    customerId: "c1",
    customerName: "زبون <x>",
    total: { minor: "500", currency: "USD" },
    channel: "whish",
    reference: "WH-<9>",
    lines: [
      { obligationId: "o1", debtDocument: { kind: "sale", receiptNumber: 42 }, amount: { minor: "300", currency: "USD" } },
      { obligationId: "o2", debtDocument: { kind: "manual", reference: "دفتر & 3" }, amount: { minor: "200", currency: "USD" } },
    ],
    receivedByName: "المالك",
    receivedAt: "2026-10-04T09:30:00.000Z",
    businessDate: "2026-10-04",
    ...over,
  });

  it("the COL- document: Arabic + English, number, original reference, every debt line, escaped, stable on reprint", () => {
    const html = renderCollectionDocument({ doc: doc(), shopName: "محل", timeZone: "Asia/Beirut" });
    for (const s of ["إيصال تحصيل", "Collection receipt", "COL-000007", "5.00", "3.00", "2.00", "ويش موني", "Whish Money", "#42", "إيصال بيع", "المالك", "2026-10-04 12:30"]) {
      expect(html, s).toContain(s);
    }
    expect(html).toContain("WH-&lt;9&gt;");
    expect(html).toContain("زبون &lt;x&gt;");
    expect(html).toContain("دفتر &amp; 3");
    expect(html).toContain("ليس بيعاً جديداً");
    expect(html).toContain("Reprinting this receipt records no new payment");
    expect(html).not.toMatch(/المتبقّي|المتبقي|Left on|remaining/i);
    expect(renderCollectionDocument({ doc: doc(), shopName: "محل", timeZone: "Asia/Beirut" })).toBe(html);
    const cash = renderCollectionDocument({ doc: doc({ channel: "cash", reference: null }), shopName: null, timeZone: "Asia/Beirut" });
    expect(cash).toMatch(/data-field="method">نقداً/);
    expect(cash).not.toContain('data-field="reference"');
  });
});

describe("🔴 backup / restore, real process death, real concurrency", () => {
  it("a snapshot keeps every COL- and the counter; the next collection on the restored copy continues the numbering", () => {
    const c = customer();
    const o = owe(c.id, "P");
    pay(c, o, "100");
    pay(c, o, "100");
    const dest = join(t.dir, "col-backup.sqlite");
    snapshotDatabase(h.db, dest);
    const rows = h.db.prepare("SELECT * FROM collection_documents ORDER BY doc_no").all();
    h.db.close();
    h = makeHarness(dest);
    wire();
    expect(h.db.prepare("SELECT * FROM collection_documents ORDER BY doc_no").all()).toEqual(rows);
    expect(ok<RecordPaymentResponse>(pay(c, o, "100")).collection!.number).toBe("COL-000003");
    expect(h.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(h.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  const CHILD = join(__dirname, "..", "helpers", "collectionCrashChild.ts");
  const crashAt = (mode: string, c: string, o: string, key: string) => {
    h.db.close();
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, mode, t.dbPath, c, o, key], { encoding: "utf8", timeout: 60000 });
    expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
    if (process.platform === "win32") expect(r.status).not.toBe(0);
    else expect(r.signal).toBe("SIGKILL");
    h = makeHarness(t.dbPath);
    wire();
  };

  it("killed INSIDE the transaction (settlement + COL written): nothing survives; the retry under the same key collects once as COL-000001", () => {
    const c = customer();
    const o = owe(c.id, "P");
    crashAt("inside-tx", c.id, o.id, "col-crash-key-0001");
    expect([count("settlements"), count("collection_documents"), colNo()]).toEqual([0, 0, 0]);
    const r = ok<RecordPaymentResponse>(pay(c, o, "100", "col-crash-key-0001"));
    expect([r.duplicate, r.collection!.number]).toEqual([false, "COL-000001"]);
  });

  it("killed right AFTER the commit: the payment and its COL- exist once; the retry returns the SAME COL-", () => {
    const c = customer();
    const o = owe(c.id, "P");
    crashAt("after-commit", c.id, o.id, "col-crash-key-0002");
    expect([count("settlements"), count("collection_documents"), colNo()]).toEqual([1, 1, 1]);
    const r = ok<RecordPaymentResponse>(pay(c, o, "100", "col-crash-key-0002"));
    expect([r.duplicate, r.collection!.number, count("collection_documents")]).toEqual([true, "COL-000001", 1]);
  });

  it("two REAL processes collecting two debts at once: COL-000001 and COL-000002, each once", async () => {
    const c = customer();
    const o1 = owe(c.id, "P1");
    const o2 = owe(c.id, "P2");
    h.db.close();
    const run = (o: string, key: string) =>
      new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
        const p = spawn(process.execPath, ["--import", "tsx", CHILD, "run", t.dbPath, c.id, o, key]);
        let s = "";
        p.stdout.on("data", (d) => (s += d));
        p.on("error", reject);
        p.on("close", () => resolve(JSON.parse(s.trim())));
      });
    const both = await Promise.all([run(o1.id, "col-race-key-0001"), run(o2.id, "col-race-key-0002")]);
    h = makeHarness(t.dbPath);
    wire();
    // Two collections of ONE customer started together: SQLite serialises them. Either both commit, or the
    // second is HELD (COLLECTION_UNRESOLVED) by the first's open attempt — never a duplicate or skipped number.
    const settled = both.filter((x) => x.ok).length;
    expect(settled).toBeGreaterThanOrEqual(1);
    expect(both.filter((x) => !x.ok).every((x) => x.code === "COLLECTION_UNRESOLVED")).toBe(true);
    expect(h.db.prepare("SELECT doc_no AS n FROM collection_documents ORDER BY doc_no").all()).toEqual(
      Array.from({ length: settled }, (_, i) => ({ n: BigInt(i + 1) })),
    );
    expect([count("settlements"), colNo()]).toEqual([settled, settled]);
  }, 120000);
});
