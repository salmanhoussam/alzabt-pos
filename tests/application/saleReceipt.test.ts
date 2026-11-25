/**
 * TILL-PRINT + F4 (owner decisions D-TP1/2/3, DEC-35zz++) — ONE till receipt read from the ledger by sale id; the
 * screen (completion + History), the PDF and the print all render it. Real SQLite, real services.
 *
 *   · every case states its own facts: Cash · Whish (+reference) · Split · On account (customer) · Partial · Paid
 *     from an advance (sale total / ADV / left on account) · Voided
 *   · 🔴 F4: an advance-applied sale reopened later is NEVER «amount due = sale total», and LATER payments or
 *     applications to its debt do not change what its receipt says (facts of the sale, not live balances)
 *   · 🔴 D-TP2: owner any sale; anyone else only a sale inside History's window — in the SERVICE and the channel
 *   · 🔴 printing / PDF / reprint write NOTHING; «no printer» is an answer, not a crash
 *   · the document: Arabic + English, 80 mm and A5, «نسخة / COPY» on a reprint, every figure = the DTO's
 * Synthetic data only. Harness clock: 2026-10-04, Beirut.
 */
import { TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AdvanceService, formatAdvanceNo } from "../../src/application/advanceService";
import { MAX_HISTORY } from "../../src/application/posService";
import { SaleReceiptService } from "../../src/application/saleReceiptService";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { renderSaleReceiptDocument } from "../../src/main/saleReceiptDocument";
import { SaleReceiptRepository } from "../../src/persistence/saleReceiptRepository";
import type { IpcResult, SaleReceiptDto } from "../../src/shared/ipcContract";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let receipts: SaleReceiptService;
let ipc: ReturnType<typeof syncHandlers>;
let jobs: Array<{ receipt: number; layout: string; copy: boolean }>;
let printers = 1;
const X2 = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };

const service = (window = MAX_HISTORY) =>
  new SaleReceiptService({ reads: new SaleReceiptRepository(h.db), getSale: (id) => h.service.getSale(id), role: () => h.service.currentRole(), historyWindow: window, formatAdvanceNo });
const handlers = (s = receipts) =>
  createIpcHandlers(h.service, {
    parties: h.parties,
    ledger: h.ledger,
    advances: adv,
    saleReceipts: s,
    printSaleReceipt: async (d, layout, copy) => (printers === 0 ? "no-printer" : (jobs.push({ receipt: d.sale.receiptNumber, layout, copy }), "printed")),
    saveSaleReceiptPdf: async (d, layout, copy) => (jobs.push({ receipt: d.sale.receiptNumber, layout: `pdf-${layout}`, copy }), { fileName: "r.pdf" }),
  });
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  adv = makeAdvances(h);
  receipts = service();
  ipc = syncHandlers(handlers());
  jobs = [];
  printers = 1;
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const code = (r: IpcResult<unknown>) => (r.ok ? "OK" : r.error.code);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return "OK";
};
const n = (sql: string) => Number(Object.values(h.db.prepare(sql).get() as Record<string, unknown>)[0]);
const footprint = () => ["sales", "sale_tenders", "settlements", "obligations", "advance_applications", "advance_refunds", "receipts", "voids"].map((x) => n(`SELECT count(*) FROM ${x}`));
const customer = (name: string) => h.parties.create({ kind: "customer", displayName: name }).party;
const get = (saleId: string) => ok<SaleReceiptDto>(ipc.getSaleReceipt({ saleId }));
const doc = (r: SaleReceiptDto, copy = false, layout: "thermal80" | "a5" = "a5") => renderSaleReceiptDocument({ receipt: r, layout, copy, shopName: "محل الاختبار", timeZone: "Asia/Beirut" });

describe("the read model — each case states its own facts", () => {
  it("CASH and WHISH: method, Whish reference, no customer, no advance", () => {
    const cash = h.service.createSale({ idempotencyKey: newKey(), ...X2, paymentMethod: "cash" }).sale;
    const whish = h.service.createSale({ idempotencyKey: newKey(), ...X2, paymentMethod: "external", whish: { reference: "WH-TP-1", fundsConfirmed: true } }).sale;
    const c = get(cash.id);
    const w = get(whish.id);
    expect([c.sale.paymentMethod, c.customerName, c.advanceApplied, c.void]).toEqual(["cash", null, null, null]);
    expect([w.sale.externalPayment?.reference, w.customerName, w.advanceApplied]).toEqual(["WH-TP-1", null, null]);
    expect(doc(w)).toContain('data-field="reference">WH-TP-1<');
    expect(doc(c)).toMatch(/data-field="method"><th>[^<]*<span class="en">Paid by<\/span><\/th><td>نقداً/);
  });

  it("SPLIT: one row per tender, each with its own amount and the Whish reference", () => {
    const s = h.service.createSplitSale({ idempotencyKey: newKey(), ...X2, cashMinor: 200n, whishMinor: 300n, whish: { reference: "WH-TP-SPLIT", fundsConfirmed: true } }).sale;
    const r = get(s.id);
    expect(r.sale.tenders?.map((x) => [x.method, x.amount.minor, x.reference])).toEqual([
      ["cash", "200", null],
      ["external", "300", "WH-TP-SPLIT"],
    ]);
    const html = doc(r);
    expect(html).toContain('data-field="tender-1"');
    expect(html).toContain('data-field="tender-2"');
    expect(html).toContain('data-field="tender-reference">WH-TP-SPLIT<');
  });

  it("ON ACCOUNT and PARTIAL: the customer named AT SALE TIME; the amount left on account; a later rename changes nothing", () => {
    const c = customer("زبون الدين");
    const credit = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, ...X2 }).sale;
    const partial = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, ...X2, downPayment: { amountMinor: 200n, method: "cash" } }).sale;
    h.parties.updateContact("customer", c.id, { displayName: "اسم لاحق" });
    const r1 = get(credit.id);
    const r2 = get(partial.id);
    expect([r1.customerName, r1.sale.paymentStatus, r1.sale.balanceDue.minor, r1.advanceApplied]).toEqual(["زبون الدين", "unpaid", "500", null]);
    expect([r2.customerName, r2.sale.paymentStatus, r2.sale.paid.minor, r2.sale.balanceDue.minor]).toEqual(["زبون الدين", "partial", "200", "300"]);
    expect(doc(r1)).toContain('data-field="balance-due"');
    const p = doc(r2);
    expect(p).toContain('data-field="paid-now"');
    expect(p).toMatch(/data-field="balance-due">[\s\S]*3\.00/);
  });

  it("🔴 F4 — PAID FROM AN ADVANCE: sale total / ADV-x / left on account; never «amount due» = sale total; later payments change nothing", () => {
    const c = customer("زبون الدفعة");
    const k = newKey();
    const a = adv.record({ customerId: c.id, amountMinor: 300n, channel: "cash", idempotencyKey: k }).record;
    adv.acknowledge(k);
    const s = adv.sellOnAdvance({ idempotencyKey: newKey(), customerId: c.id, ...X2, advanceId: a.id, amountMinor: 300n });
    const before = get(s.sale.id);
    expect(before.advanceApplied).toEqual({ number: "ADV-000001", applied: { minor: "300", currency: "USD" }, debtLeft: { minor: "200", currency: "USD" } });
    // LATER: another advance applied to the same debt, then the rest collected — the receipt of the SALE stays the same.
    const k2 = newKey();
    const a2 = adv.record({ customerId: c.id, amountMinor: 100n, channel: "cash", idempotencyKey: k2 }).record;
    adv.acknowledge(k2);
    adv.applyToDebt({ advanceId: a2.id, obligationId: s.obligation.id, amountMinor: 100n, idempotencyKey: newKey() });
    ipc.recordCustomerPayment({ customerId: c.id, obligationId: s.obligation.id, idempotencyKey: newKey(), amountMinor: "100", method: "cash" } as never);
    expect(get(s.sale.id)).toEqual(before);
    const html = doc(before);
    expect(html).not.toContain('data-field="balance-due"');
    expect(html).not.toContain("المبلغ المستحق");
    for (const f of ['data-field="sale-total"', 'data-field="advance-number">ADV-000001<', 'data-field="advance-paid"', 'data-field="debt-left"']) expect(html, f).toContain(f);
    expect(html).toMatch(/data-field="debt-left">[\s\S]*?2\.00/);
  });

  it("VOIDED: stamped VOIDED with its reason — never «refunded»", () => {
    const s = h.service.createSale({ idempotencyKey: newKey(), ...X2, paymentMethod: "cash" }).sale;
    h.service.voidSale(s.id, "خطأ في الصنف");
    const r = get(s.id);
    expect(r.void?.reason).toBe("خطأ في الصنف");
    const html = doc(r);
    expect(html).toContain('data-field="voided"');
    expect(html).toContain("الإبطال ليس استرداداً");
    expect(html).toContain("a void is not a refund");
  });
});

describe("🔴 D-TP2 — who may read / print a receipt (service AND channel)", () => {
  it("the owner reads any sale; a cashier only a sale inside History's window; nobody signed in → refused", () => {
    const sales = [1, 2, 3].map(() => h.service.createSale({ idempotencyKey: newKey(), ...X2, paymentMethod: "cash" }).sale);
    const narrow = service(2); // History shows the latest 2
    expect(narrow.receipt(sales[0]!.id).sale.receiptNumber).toBe(1); // owner: any
    h.service.logout();
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect(narrow.receipt(sales[2]!.id).sale.receiptNumber).toBe(3);
    expect(codeOf(() => narrow.receipt(sales[0]!.id))).toBe("NOT_AUTHORIZED");
    const nIpc = syncHandlers(handlers(narrow));
    expect(code(nIpc.getSaleReceipt({ saleId: sales[0]!.id }))).toBe("NOT_AUTHORIZED");
    expect(code(nIpc.getSaleReceipt({ saleId: sales[1]!.id }))).toBe("OK");
    expect(codeOf(() => narrow.receipt("no-such-sale"))).toBe("SALE_NOT_FOUND");
    h.service.logout();
    expect(codeOf(() => narrow.receipt(sales[2]!.id))).toBe("NOT_LOGGED_IN");
  });
});

describe("print / PDF / reprint — nothing written; «no printer» is an answer", () => {
  it("print 80 mm + A5 + PDF, original and copy, pass the SAME ledger DTO; the ledger footprint is unchanged", async () => {
    const s = h.service.createSale({ idempotencyKey: newKey(), ...X2, paymentMethod: "cash" }).sale;
    const all = handlers();
    const fp = footprint();
    expect(ok<{ status: string }>(await all.printSaleReceipt({ saleId: s.id, layout: "thermal80", copy: false }))).toEqual({ status: "printed" });
    expect(ok<{ status: string }>(await all.printSaleReceipt({ saleId: s.id, layout: "a5", copy: true }))).toEqual({ status: "printed" });
    expect(ok<{ status: string }>(await all.saveSaleReceiptPdf({ saleId: s.id, layout: "a5", copy: true }))).toEqual({ status: "saved", fileName: "r.pdf" });
    expect(jobs).toEqual([
      { receipt: 1, layout: "thermal80", copy: false },
      { receipt: 1, layout: "a5", copy: true },
      { receipt: 1, layout: "pdf-a5", copy: true },
    ]);
    expect(footprint()).toEqual(fp);
    printers = 0;
    expect(ok<{ status: string }>(await all.printSaleReceipt({ saleId: s.id, layout: "thermal80", copy: false }))).toEqual({ status: "no-printer" });
    expect(code(await all.printSaleReceipt({ saleId: s.id, layout: "a4", copy: false }))).toBe("INVALID_INPUT");
    expect(code(await all.printSaleReceipt({ saleId: s.id, layout: "a5", copy: "yes" }))).toBe("INVALID_INPUT");
    expect(code(await all.printSaleReceipt({ saleId: s.id, layout: "a5", copy: false, html: "<b>" }))).toBe("INVALID_INPUT");
    const bare = createIpcHandlers(h.service, { saleReceipts: receipts });
    expect(ok<{ status: string }>(await bare.printSaleReceipt({ saleId: s.id, layout: "a5", copy: false }))).toEqual({ status: "unavailable" });
    expect(footprint()).toEqual(fp);
  });
});

describe("the document — Arabic + English, two layouts, COPY, every figure from the DTO", () => {
  it("80 mm vs A5 page rules; «نسخة / COPY» only on a reprint, same receipt number; stable; escaped", () => {
    const s = h.service.createSale({ idempotencyKey: newKey(), lines: [{ productId: "prod-0001", quantityMilli: 3000 }], expectedTotalMinor: 750n, paymentMethod: "cash" }).sale;
    const r = get(s.id);
    const thermal = doc(r, false, "thermal80");
    const a5 = doc(r, true, "a5");
    expect(thermal).toContain("size: 80mm 297mm");
    expect(thermal).toContain('data-layout="thermal80"');
    expect(a5).toContain("size: A5");
    expect(thermal).not.toContain('data-field="copy"');
    expect(a5).toContain('data-field="copy"');
    expect(a5).toContain("نسخة");
    expect(a5).toContain("COPY");
    for (const html of [thermal, a5]) {
      expect(html).toContain('data-field="number">#1<');
      expect(html).toContain("إيصال بيع");
      expect(html).toContain("Sales receipt");
      expect(html).toContain("3 × 2.50");
      expect(html).toMatch(/data-field="total">[\s\S]*7\.50/);
    }
    expect(doc(r, true, "a5")).toBe(a5);
    // A weighed line (milli-units) prints as a decimal quantity, never a float artefact.
    const weighed = { ...r, sale: { ...r.sale, lines: [{ ...r.sale.lines[0]!, quantityMilli: 1250 }] } } as SaleReceiptDto;
    expect(doc(weighed)).toContain("1.25 × 2.50");
    const evil = { ...r, sale: { ...r.sale, cashierName: "<script>x</script>" } } as SaleReceiptDto;
    expect(doc(evil)).not.toContain("<script>x");
  });
});
