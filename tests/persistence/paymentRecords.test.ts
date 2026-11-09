import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/persistence/db";
import { openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type NewSaleHeader, SaleRepository, singleTenderFor } from "../../src/persistence/saleRepository";
import { type Harness, type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * P1 · PAYMENT RECORDS (owner, 2026-11-07). A new sale paid by one evidence-free method (cash, card,
 * other) carries ONE `sale_tenders` row = the amount paid, written atomically with the sale; nothing the
 * merchant sees changes. No tender is invented for an unpaid sale, an invoice sale, a till Whish / bank
 * sale (no reference captured yet — P2), or any historic sale.
 */

let t: TempDir;
let h: Harness;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

const espresso = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };
const tenders = (db: Db, saleId: string) =>
  db.prepare("SELECT seq, method, provider, reference, funds_confirmed AS fc, amount_minor AS amt FROM sale_tenders WHERE sale_id = ? ORDER BY seq").all(saleId) as Record<string, unknown>[];
const tenderCount = (db: Db, saleId: string) => Number((db.prepare("SELECT tender_count AS n FROM sales WHERE id = ?").get(saleId) as { n: bigint }).n);
const all = (db: Db) => Number((db.prepare("SELECT count(*) AS n FROM sale_tenders").get() as { n: bigint }).n);

describe("which sales get a payment record", () => {
  // TRANSITION (P3, DEC-35): was it.each(["cash", "card", "other"]). Card and Other are no longer accepted for
  // a new sale (see the next test); P1's record shape is unchanged for cash.
  it.each(["cash"] as const)("a %s sale: ONE record, the method and the amount paid, sealed; payment_method unchanged", (method) => {
    const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: method, ...espresso });
    expect(tenders(h.db, sale.id)).toEqual([{ seq: 1n, method, provider: null, reference: null, fc: null, amt: 500n }]);
    expect(tenderCount(h.db, sale.id)).toBe(1);
    expect(sale.paymentMethod).toBe(method);
    expect((h.db.prepare("SELECT payment_method AS m FROM sales WHERE id = ?").get(sale.id) as { m: string }).m).toBe(method);
  });

  it("a NEW card or other sale is refused (DEC-35) — nothing written, no record", () => {
    const before = countRows(h.db);
    for (const paymentMethod of ["card", "other"] as const) {
      expect(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod, ...espresso })).toThrow(
        expect.objectContaining({ code: "PAYMENT_METHOD_NOT_ACCEPTED" }),
      );
    }
    expect(countRows(h.db)).toEqual(before);
    expect(all(h.db)).toBe(0);
  });

  it("an external till sale WITHOUT evidence is refused — no reference is invented, nothing is written", () => {
    // TRANSITION (P2): this was "an external sale gets NO record yet" (recorded with tender_count 0).
    // P2 captures the Whish evidence, so a new external sale without it is refused instead.
    const before = countRows(h.db);
    expect(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "external", ...espresso })).toThrow(/reference/);
    expect(countRows(h.db)).toEqual(before);
    expect(all(h.db)).toBe(0);
  });

  it("an unpaid customer-credit sale: NO record — nothing was paid", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون P1" }).party;
    const r = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, ...espresso });
    expect(tenders(h.db, r.sale.id)).toEqual([]);
    expect(tenderCount(h.db, r.sale.id)).toBe(0);
  });

  // TRANSITION (INV-PAY-METHOD, owner 2026-11-09): this test was "an invoice sale: NO record — the invoice
  // captures no method, and none is invented" and finalized a paid invoice with no method (method NULL,
  // tender_count 0). A paid invoice must now SAY how it was paid at issue, and that becomes its ONE record;
  // still nothing is invented — without a method the issue is refused, and an unpaid invoice keeps none.
  it("an invoice sale: ONE record of the method GIVEN at issue — and none without one", () => {
    h.invoices.saveCompanyProfile({ nameAr: "متجر P1" });
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [{ description: "بند", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "10.00" }], "batch-p1-0001-key");
    h.invoices.updateDraftHeader(invoice.id, { paid: "10.00" });
    expect(() => h.invoices.finalizeInvoice(invoice.id)).toThrow(/how the paid amount was received/);
    h.invoices.finalizeInvoice(invoice.id, { payment: { method: "cash" } });
    const s = h.db.prepare("SELECT id, tender_count AS n, payment_method AS m FROM sales WHERE invoice_id = ?").get(invoice.id) as { id: string; n: bigint; m: string | null };
    expect(s.m).toBe("cash");
    expect(Number(s.n)).toBe(1);
    expect(tenders(h.db, s.id)).toHaveLength(1);
  });

  it("the rule itself: only a paid POS sale with cash / card / other", () => {
    expect(singleTenderFor({ sourceType: "pos", paymentMethod: "cash", paidMinor: 1n })).toEqual({ method: "cash", amountMinor: 1n });
    expect(singleTenderFor({ sourceType: "pos", paymentMethod: "external", paidMinor: 1n })).toBeNull();
    expect(singleTenderFor({ sourceType: "pos", paymentMethod: null, paidMinor: 0n })).toBeNull();
    expect(singleTenderFor({ sourceType: "pos", paymentMethod: "cash", paidMinor: 0n })).toBeNull();
    // TRANSITION (INV-PAY-METHOD): an invoice sale WITH a method given at issue now gets its record.
    // Old value: toBeNull(). One WITHOUT a method (every historic and every unpaid invoice) still gets none.
    expect(singleTenderFor({ sourceType: "invoice", paymentMethod: "cash", paidMinor: 1n })).toEqual({ method: "cash", amountMinor: 1n });
    expect(singleTenderFor({ sourceType: "invoice", paymentMethod: null, paidMinor: 1n })).toBeNull();
  });
});

describe("no duplicate, no partial write, no balance moved", () => {
  it("🔴 a replayed request returns the first sale and writes NO second record", () => {
    const key = newKey();
    const first = h.service.createSale({ idempotencyKey: key, paymentMethod: "cash", ...espresso });
    const again = h.service.createSale({ idempotencyKey: key, paymentMethod: "cash", ...espresso });
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    expect(all(h.db)).toBe(1);
  });

  it("🔴 a fault after the record is written rolls BOTH back — no orphan record, no sale", () => {
    class FailAfterTender extends SaleRepository {
      protected override insertSaleHeader(_h: NewSaleHeader, _r: number, _l: number, _t = 0): void {
        throw new Error("injected after the tender, before the sale header");
      }
    }
    h.db.close();
    h = makeHarness(t.dbPath, { repository: (db) => new FailAfterTender(db) });
    const before = countRows(h.db);
    expect(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso })).toThrow();
    expect(countRows(h.db)).toEqual(before);
    expect(all(h.db)).toBe(0);
  });

  it("🔴 the ledger refuses a record that does not match the sale, even written by hand", () => {
    const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
    expect(() => h.db.prepare("INSERT INTO sale_tenders (sale_id, seq, method, amount_minor) VALUES (?, 2, 'cash', 1)").run(sale.id)).toThrow(/cannot take another tender/);
    expect(() => h.db.prepare("UPDATE sale_tenders SET amount_minor = 1 WHERE sale_id = ?").run(sale.id)).toThrow(/immutable/);
  });

  it("a linked paid sale moves no customer balance (no obligation, statement unchanged)", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون رصيد" }).party;
    const before = h.ledger.statementFor(c.id).obligations.length;
    // TRANSITION (P3, DEC-35): new payments are cash or Whish only; old method here: "card".
    const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", customerId: c.id, ...espresso });
    expect(tenders(h.db, sale.id)).toHaveLength(1);
    expect(h.ledger.statementFor(c.id).obligations.length).toBe(before);
    expect(Number((h.db.prepare("SELECT count(*) AS n FROM obligations WHERE sale_id = ?").get(sale.id) as { n: bigint }).n)).toBe(0);
  });

  it("totals: Σ records = paid on every sale that has records; History reads exactly as before", () => {
    // TRANSITION (P2): the external sale carries its Whish evidence and now HAS a record (old: 4 records).
    // TRANSITION (P3, DEC-35): new payments are cash or Whish only; old list: cash, card, other, external, cash (5 records).
    for (const m of ["cash", "external", "cash"] as const) {
      h.service.createSale({ idempotencyKey: newKey(), paymentMethod: m, ...(m === "external" ? { whish: { reference: "WH-TOTALS-1", fundsConfirmed: true } } : {}), ...espresso });
    }
    const bad = h.db.prepare(
      `SELECT count(*) AS n FROM sales s WHERE s.tender_count > 0 AND (s.tender_count <> (SELECT count(*) FROM sale_tenders t WHERE t.sale_id = s.id)
         OR s.paid_minor <> (SELECT coalesce(sum(amount_minor),0) FROM sale_tenders t WHERE t.sale_id = s.id))`,
    ).get() as { n: bigint };
    expect(Number(bad.n)).toBe(0);
    expect(all(h.db)).toBe(3);
    const history = h.service.getSaleHistory(10).map((r) => r.sale.paymentMethod);
    expect([...history].sort()).toEqual(["cash", "cash", "external"]);
  });
});

describe("an upgraded v18 ledger: history untouched, new sales recorded", () => {
  it("a historic cash sale keeps tender_count 0 and gets no record; the next sale gets one", () => {
    h.db.close();
    const t2 = tempDir();
    try {
      const v18 = openDatabase(t2.dbPath, MIGRATIONS.slice(0, 18));
      v18.prepare(
        `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, cashier_id, cashier_name, currency,
           subtotal_minor, tax_minor, total_minor, paid_minor, balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at, created_at)
         VALUES ('old-cash', 1, 'old-cash-key-0001', 'fp', 'pos', 'cashier-01', 'م', 'USD', 250, 0, 250, 250, 0, 'paid', 'cash', 1, '2026-11-01', 't', 't')`,
      ).run();
      v18.prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name, sale_unit, unit_label, quantity_milli, unit_price_minor, line_total_minor)
         VALUES ('old-line', 'old-cash', 1, NULL, 'prod-0001', 'COF-ESP', 'Espresso', 'piece', 'قطعة', 1000, 250, 250)`,
      ).run();
      v18.close();
      h = makeHarness(t2.dbPath);
      expect(tenderCount(h.db, "old-cash")).toBe(0);
      expect(tenders(h.db, "old-cash")).toEqual([]);
      const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
      expect(tenders(h.db, sale.id)).toHaveLength(1);
      expect(tenders(h.db, "old-cash")).toEqual([]);
      expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(h.db.pragma("foreign_key_check")).toEqual([]);
      h.db.close();
    } finally {
      t2.cleanup();
    }
  });
});
