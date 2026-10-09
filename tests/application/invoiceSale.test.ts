/**
 * A finalized manual invoice IS a sale (migration 7) — the business cases, the atomicity contract,
 * and the duplicate-sale defences.
 *
 * 🔴 WHY THIS FILE USES THE REAL REPOSITORIES. `makeHarness` injects the real `SaleRepository` and
 * the real `PosService` on the real connection, so "a sale exists" here means a committed row in
 * `sales` that the till's own history reads, not a method call on a fake. A fake would have agreed
 * with every assertion below and proved nothing about the ledger.
 *
 * Synthetic data only: no real company, customer or product values appear anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { InvoiceService, invoiceSaleIdempotencyKey } from "../../src/application/invoiceService";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

interface LineSpec {
  readonly description?: string;
  readonly unitLabel?: string;
  readonly canonicalUnit?: string | null;
  readonly unitPrice: string;
  readonly quantity?: string;
  readonly productId?: string | null;
}

const saveProfile = (over: Record<string, unknown> = {}) =>
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", ...over });

const product = (nameAr: string, price: string, extra: { sku?: string; baseUnit?: string } = {}) =>
  h.service.createProduct({
    nameAr,
    nameEn: null,
    sku: extra.sku ?? null,
    price,
    baseUnit: extra.baseUnit ?? "piece",
  });

/** A draft carrying `lines`, with an optional paid amount, NOT finalized. */
function draft(lines: ReadonlyArray<LineSpec>, paid?: string): string {
  const { invoice } = h.invoices.createDraft();
  for (const line of lines) {
    h.invoices.addLine(invoice.id, {
      description: line.description ?? "صنف اختباري",
      unitLabel: line.unitLabel === undefined ? "حبة" : line.unitLabel,
      canonicalUnit: line.canonicalUnit,
      productId: line.productId ?? null,
      quantity: line.quantity ?? "1",
      unitPrice: line.unitPrice,
    });
  }
  if (paid !== undefined) h.invoices.updateDraftHeader(invoice.id, { paid });
  return invoice.id;
}

function finalize(lines: ReadonlyArray<LineSpec>, paid?: string): string {
  const id = draft(lines, paid);
  h.invoices.finalizeInvoice(id);
  return id;
}

const saleOf = (invoiceId: string) => h.invoices.saleForInvoice(invoiceId);
const saleCount = () => Number((h.db.prepare("SELECT count(*) AS c FROM sales").get() as { c: bigint }).c);
const lineCount = () => Number((h.db.prepare("SELECT count(*) AS c FROM sale_lines").get() as { c: bigint }).c);

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  h.service.login("cashier-01", "1111");
  saveProfile();
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("the sale a finalized invoice is", () => {
  it("A · a fully UNPAID invoice becomes an unpaid sale, with NO invented payment method", () => {
    const id = finalize([{ unitPrice: "100.00" }]);
    const sale = saleOf(id);
    expect(sale).toBeDefined();
    expect(sale!.sourceType).toBe("invoice");
    expect(sale!.invoiceId).toBe(id);
    expect(sale!.subtotal.minor).toBe(10_000n);
    expect(sale!.tax.minor).toBe(0n);
    expect(sale!.total.minor).toBe(10_000n);
    expect(sale!.paid.minor).toBe(0n);
    expect(sale!.balanceDue.minor).toBe(10_000n);
    expect(sale!.paymentStatus).toBe("unpaid");
    // 🔴 THE POINT OF THE WHOLE MIGRATION. Not 'cash', not 'other' — nothing was received, and the
    // ledger says so rather than naming a method that never happened.
    expect(sale!.paymentMethod).toBeNull();
  });

  it("B · a PARTIALLY paid invoice becomes a partial sale", () => {
    const id = finalize([{ unitPrice: "100.00" }], "30.00");
    const sale = saleOf(id)!;
    expect([sale.paid.minor, sale.balanceDue.minor, sale.total.minor]).toEqual([3_000n, 7_000n, 10_000n]);
    expect(sale.paymentStatus).toBe("partial");
    expect(sale.paymentMethod).toBeNull();
  });

  it("C · a FULLY paid invoice becomes a paid sale — and still invents no method", () => {
    const id = finalize([{ unitPrice: "100.00" }], "100.00");
    const sale = saleOf(id)!;
    expect([sale.paid.minor, sale.balanceDue.minor]).toEqual([10_000n, 0n]);
    expect(sale.paymentStatus).toBe("paid");
    // Paid in full, but HOW is still not recorded by a manual invoice in this patch.
    expect(sale.paymentMethod).toBeNull();
  });

  it("D · a TAX-ENABLED invoice carries its frozen tax into the sale, exactly", () => {
    saveProfile({ taxEnabled: true, taxRatePercent: "11", taxLabel: "VAT" });
    const id = finalize([{ unitPrice: "100.00" }]);
    const invoice = h.invoices.getInvoice(id).invoice;
    const sale = saleOf(id)!;
    // 100.00 + 11% = 111.00, and the sale's three numbers are the invoice's three numbers.
    expect([invoice.subtotal_minor, invoice.tax_minor, invoice.total_minor]).toEqual([10_000n, 1_100n, 11_100n]);
    expect([sale.subtotal.minor, sale.tax.minor, sale.total.minor]).toEqual([10_000n, 1_100n, 11_100n]);
    // The pre-v7 ledger could not hold this at all: verifySale demanded total === subtotal.
    expect(sale.total.minor).toBe(sale.subtotal.minor + sale.tax.minor);
  });

  it("E · a PRODUCT_NOT_FOUND line becomes a sale line with no product, immediately", () => {
    const id = finalize([{ description: "صنف لا يعرفه الكاتالوج", unitPrice: "7.50" }]);
    const sale = saleOf(id)!;
    expect(sale.lines).toHaveLength(1);
    const line = sale.lines[0]!;
    // 🔴 NULL, not a fabricated id and not an empty-string SKU: the catalog genuinely has no such
    // product. "" means a POS product without a SKU, which is a different statement.
    expect(line.productId).toBeNull();
    expect(line.sku).toBeNull();
    expect(line.productName).toBe("صنف لا يعرفه الكاتالوج");
    expect(line.lineTotal.minor).toBe(750n);

    // The sale exists NOW — reconciliation has not run and must not be a precondition.
    const queue = h.invoices.listReconciliation(id);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.classification).toBe("PRODUCT_NOT_FOUND");
    expect(queue[0]!.status).toBe("PENDING");
  });

  it("F · a free-text unit survives into the sale line verbatim", () => {
    const id = finalize([{ description: "شامبو", unitLabel: "كيس (50PCS)", unitPrice: "12.00" }]);
    const line = saleOf(id)!.lines[0]!;
    expect(line.unitLabel).toBe("كيس (50PCS)");
    // It maps to no base unit, and nothing guessed one.
    expect(line.saleUnit).toBeNull();
  });

  it("F · a fractional quantity on a whole-only unit is preserved, not rounded or refused", () => {
    // 2.5 حبة — canonical 'piece'. domain/invoice.ts permits it, so the ledger must store it; the
    // till's own fraction rule still refuses 2.5 pieces, which the migration tests prove.
    const id = finalize([{ description: "صنف كسري", unitLabel: "حبة", unitPrice: "4.00", quantity: "2.5" }]);
    const line = saleOf(id)!.lines[0]!;
    expect(line.quantityMilli).toBe(2500);
    expect(line.saleUnit).toBe("piece");
    expect(line.unitLabel).toBe("حبة");
    expect(line.lineTotal.minor).toBe(1_000n);
  });

  it("the sale appears in the ordinary sales history, with its invoice number", () => {
    const id = finalize([{ unitPrice: "20.00" }]);
    const invoiceNumber = Number(h.invoices.getInvoice(id).invoice.invoice_number);
    const history = h.service.getSaleHistory(10);
    expect(history).toHaveLength(1);
    const row = history[0]!;
    expect(row.sale.sourceType).toBe("invoice");
    expect(row.sale.invoiceId).toBe(id);
    // The link resolves back to the document from the sale alone.
    expect(h.invoices.getInvoice(row.sale.invoiceId!).invoice.invoice_number).toBe(BigInt(invoiceNumber));
  });

  it("a till sale and an invoice sale share one receipt sequence and stay distinguishable", () => {
    h.service.createSale({
      idempotencyKey: "till-key-00000001",
      lines: [{ productId: "prod-0001", quantityMilli: 1000 }],
      paymentMethod: "cash",
      expectedTotalMinor: 250n,
    });
    const id = finalize([{ unitPrice: "20.00" }]);
    const rows = h.db
      .prepare("SELECT receipt_number, source_type, payment_method, payment_status FROM sales ORDER BY receipt_number")
      .all() as Array<{ receipt_number: bigint; source_type: string; payment_method: string | null; payment_status: string }>;
    expect(rows.map((r) => [Number(r.receipt_number), r.source_type, r.payment_method, r.payment_status])).toEqual([
      [1, "pos", "cash", "paid"],
      [2, "invoice", null, "unpaid"],
    ]);
    expect(saleOf(id)!.receiptNumber).toBe(2);
  });

  it("every line of a multi-line invoice becomes one sale line, in order, and the totals agree", () => {
    const id = finalize([
      { description: "أول", unitPrice: "10.00", quantity: "2" },
      { description: "ثاني", unitPrice: "3.50", quantity: "4" },
      { description: "ثالث", unitPrice: "1.25", quantity: "1" },
    ]);
    const sale = saleOf(id)!;
    expect(sale.lines.map((l) => [l.lineNo, l.productName, l.quantityMilli, l.lineTotal.minor])).toEqual([
      [1, "أول", 2000, 2_000n],
      [2, "ثاني", 4000, 1_400n],
      [3, "ثالث", 1000, 125n],
    ]);
    // The header is the sum of the lines, checked by the repository before COMMIT.
    expect(sale.subtotal.minor).toBe(3_525n);
    expect(sale.total.minor).toBe(3_525n);
    // And each sale line names the invoice line it froze.
    const invoiceLines = h.invoices.getInvoice(id).lines;
    expect(sale.lines.map((l) => l.invoiceLineId)).toEqual(invoiceLines.map((l) => l.id));
  });
});

describe("atomicity — the invoice and its sale commit together or not at all", () => {
  /** The real service, with one injected fault between finalization and the sale. */
  function serviceWhoseSaleWriteFails(): InvoiceService {
    class ExplodingSales extends SaleRepository {
      override commitSale(): never {
        throw new Error("injected failure: the sale could not be written");
      }
    }
    return new InvoiceService({
      invoices: new InvoiceRepository(h.db),
      reconciliation: new ReconciliationRepository(h.db),
      company: h.companyStore,
      catalogStore: new CatalogRepository(h.db),
      products: h.service,
      sales: new ExplodingSales(h.db),
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: h.clock.now,
    });
  }

  /** A fault AFTER the sale is written, to prove the outer rollback removes the sale too. */
  function serviceWhoseQueueWriteFails(): InvoiceService {
    class ExplodingQueue extends ReconciliationRepository {
      override insert(): never {
        throw new Error("injected failure: the review queue could not be written");
      }
    }
    return new InvoiceService({
      invoices: new InvoiceRepository(h.db),
      reconciliation: new ExplodingQueue(h.db),
      company: h.companyStore,
      catalogStore: new CatalogRepository(h.db),
      products: h.service,
      sales: new SaleRepository(h.db),
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: h.clock.now,
    });
  }

  it("🔴 if the SALE cannot be written, the invoice stays a DRAFT and no sale exists", () => {
    const id = draft([{ unitPrice: "100.00" }]);
    const numberBefore = h.invoices.getCompanyProfile()!.next_invoice_number;

    expect(() => serviceWhoseSaleWriteFails().finalizeInvoice(id)).toThrow(/the sale could not be written/);

    const after = h.invoices.getInvoice(id).invoice;
    expect(after.status).toBe("draft");
    expect(after.invoice_number).toBeNull();
    expect(after.finalized_at).toBeNull();
    expect(saleCount()).toBe(0);
    expect(lineCount()).toBe(0);
    expect(h.invoices.listReconciliation(id)).toEqual([]);
    // Even the allocated number is rolled back — the sequence did not advance.
    expect(h.invoices.getCompanyProfile()!.next_invoice_number).toBe(numberBefore);
    // And the draft is still finalizable afterwards: the failure left nothing poisoned.
    h.invoices.finalizeInvoice(id);
    expect(h.invoices.getInvoice(id).invoice.status).toBe("final");
    expect(saleCount()).toBe(1);
  });

  it("🔴 if the REVIEW QUEUE cannot be written, neither the final invoice NOR the sale remains", () => {
    const id = draft([{ unitPrice: "100.00" }]);

    // This is the SAVEPOINT proof the brief asked for by name: commitSale ran its own
    // `BEGIN IMMEDIATE` nested inside finalizeInvoice's, which better-sqlite3 turns into a
    // SAVEPOINT. If that nesting did NOT roll back with the outer transaction, the sale written a
    // step earlier would survive this throw. It must not.
    expect(() => serviceWhoseQueueWriteFails().finalizeInvoice(id)).toThrow(/review queue could not be written/);

    expect(h.invoices.getInvoice(id).invoice.status).toBe("draft");
    expect(saleCount()).toBe(0);
    expect(lineCount()).toBe(0);
  });

  it("the negative control: the same two services succeed when nothing is injected", () => {
    // Without this, both tests above could pass because finalization never reached the sale at all.
    const id = draft([{ unitPrice: "100.00" }]);
    new InvoiceService({
      invoices: new InvoiceRepository(h.db),
      reconciliation: new ReconciliationRepository(h.db),
      company: h.companyStore,
      catalogStore: new CatalogRepository(h.db),
      products: h.service,
      sales: new SaleRepository(h.db),
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: h.clock.now,
    }).finalizeInvoice(id);
    expect(h.invoices.getInvoice(id).invoice.status).toBe("final");
    expect(saleCount()).toBe(1);
    expect(lineCount()).toBe(1);
  });
});

describe("exactly one sale per finalized invoice", () => {
  it("the deterministic key is the invoice's own id, and fits the existing contract", () => {
    const id = finalize([{ unitPrice: "10.00" }]);
    const key = invoiceSaleIdempotencyKey(id);
    expect(key).toBe(`inv-${id}`);
    // The POS idempotency contract, unchanged: /^[A-Za-z0-9-]{8,100}$/
    expect(key).toMatch(/^[A-Za-z0-9-]{8,100}$/);
    const stored = h.db.prepare("SELECT idempotency_key FROM sales WHERE invoice_id = ?").get(id) as {
      idempotency_key: string;
    };
    expect(stored.idempotency_key).toBe(key);
  });

  it("🔴 a second finalize attempt is refused, and writes no second sale", () => {
    const id = finalize([{ unitPrice: "10.00" }]);
    expect(() => h.invoices.finalizeInvoice(id)).toThrow(DomainError);
    expect(saleCount()).toBe(1);
  });

  it("🔴 the database itself refuses a second sale for one invoice", () => {
    const id = finalize([{ unitPrice: "10.00" }]);
    // Bypassing the service entirely — the UNIQUE index is the structural defence, independent of
    // any check the service makes.
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
                              cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor,
                              paid_minor, balance_due_minor, payment_status, payment_method, line_count,
                              business_date, completed_at, created_at)
           VALUES ('dup', 999, 'dup-key-00000001', 'f', 'invoice', @invoiceId, 'c', 'n', 'USD', 1000, 0, 1000,
                   0, 1000, 'unpaid', NULL, 1, '2026-10-09', 't', 't')`,
        )
        .run({ invoiceId: id }),
    ).toThrow(/UNIQUE constraint failed: sales.invoice_id/);
    expect(saleCount()).toBe(1);
  });

  it("reopening, reading and reprinting a finalized invoice creates no sale", () => {
    const id = finalize([{ unitPrice: "10.00" }]);
    expect(saleCount()).toBe(1);
    h.invoices.getInvoice(id);
    h.invoices.getInvoice(id);
    h.invoices.listFinalized(10);
    h.invoices.findFinalizedByNumber(Number(h.invoices.getInvoice(id).invoice.invoice_number));
    expect(saleCount()).toBe(1);
    expect(lineCount()).toBe(1);
  });

  it("🔴 catalog reconciliation creates no second sale, and does not touch the first", () => {
    const id = finalize([{ description: "صنف جديد", unitLabel: "حبة", unitPrice: "7.50" }]);
    const before = saleOf(id)!;
    const item = h.invoices.listReconciliation(id)[0]!;

    // The real resolution path: it creates a catalog product through PosService.
    h.invoices.createProductFromInvoice(item.id, { baseUnit: "piece" });

    expect(saleCount()).toBe(1);
    expect(lineCount()).toBe(1);
    // 🔴 THE FROZEN SNAPSHOT. The catalog now has a product; the sale line still describes what
    // the document said, and still carries NULL where the catalog had nothing at the time.
    const after = saleOf(id)!;
    expect(after).toEqual(before);
    expect(after.lines[0]!.productId).toBeNull();
    expect(after.lines[0]!.sku).toBeNull();
    expect(after.lines[0]!.productName).toBe("صنف جديد");
    expect(after.lines[0]!.unitLabel).toBe("حبة");
    expect(after.lines[0]!.lineTotal.minor).toBe(750n);
  });

  it("🔴 a catalog price change after the fact never reaches the sale", () => {
    const p = product("مفك", "5.00");
    const id = finalize([{ description: "مفك", unitPrice: "5.00", productId: p.id }]);
    const before = saleOf(id)!;
    expect(before.lines[0]!.unitPrice.minor).toBe(500n);

    h.service.updateProduct(p.id, { nameAr: "مفك", nameEn: null, sku: null, price: "9.00", baseUnit: "piece" }, true);

    expect(saleOf(id)).toEqual(before);
    expect(saleOf(id)!.lines[0]!.unitPrice.minor).toBe(500n);
  });

  it("after a restart the invoice, its sale and the link are all still there", () => {
    const id = finalize([{ unitPrice: "42.00" }]);
    const receipt = saleOf(id)!.receiptNumber;
    h.db.close();

    const again = makeHarness(t.dbPath);
    try {
      again.service.login("cashier-01", "1111");
      const sale = again.invoices.saleForInvoice(id);
      expect(sale).toBeDefined();
      expect(sale!.receiptNumber).toBe(receipt);
      expect(sale!.total.minor).toBe(4_200n);
      expect(sale!.paymentStatus).toBe("unpaid");
      expect(again.invoices.getInvoice(id).invoice.status).toBe("final");
      expect(Number((again.db.prepare("SELECT count(*) AS c FROM sales").get() as { c: bigint }).c)).toBe(1);
    } finally {
      again.db.close();
    }
    // Reopen once more for afterEach's close to have something valid to close.
    h = makeHarness(t.dbPath);
  });
});

describe("an invoice-origin sale cannot be voided by the till", () => {
  it("🔴 refuses, truthfully, and leaves the invoice and the sale untouched", () => {
    const id = finalize([{ unitPrice: "10.00" }]);
    const sale = saleOf(id)!;

    let message = "";
    try {
      h.service.voidSale(sale.id, "customer changed their mind");
    } catch (err) {
      message = err instanceof DomainError ? `${err.code}:${err.message}` : String(err);
    }
    expect(message).toContain("VOID_NOT_ALLOWED_FOR_INVOICE");
    expect(message).toMatch(/credit-note workflow is not implemented yet/);

    // Nothing was half-done: no void row, the sale stands, the invoice is still final.
    expect(Number((h.db.prepare("SELECT count(*) AS c FROM voids").get() as { c: bigint }).c)).toBe(0);
    expect(saleOf(id)).toEqual(sale);
    expect(h.invoices.getInvoice(id).invoice.status).toBe("final");
  });

  it("the negative control: an ordinary till sale CAN still be voided", () => {
    // Without this, the refusal above could be passing because voiding is broken for everything.
    const { sale } = h.service.createSale({
      idempotencyKey: "till-key-00000009",
      lines: [{ productId: "prod-0001", quantityMilli: 1000 }],
      paymentMethod: "cash",
      expectedTotalMinor: 250n,
    });
    expect(() => h.service.voidSale(sale.id, "wrong item rung up")).not.toThrow();
    expect(Number((h.db.prepare("SELECT count(*) AS c FROM voids").get() as { c: bigint }).c)).toBe(1);
  });
});

describe("the till contract is not one byte looser", () => {
  it("🔴 a POS sale line still cannot omit its product, sku or unit", () => {
    // A synthetic POS header with room for many lines: a real one declares line_count = 1 and the
    // sale_lines_closed_sale trigger would refuse the probes before the shape rules were reached.
    h.db
      .prepare(
        `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
                            cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor,
                            paid_minor, balance_due_minor, payment_status, payment_method, line_count,
                            business_date, completed_at, created_at)
         VALUES ('probe', 400, 'probe-key-000001', 'f', 'pos', NULL, 'c', 'n', 'USD', 0, 0, 0,
                 0, 0, 'paid', 'cash', 50, '2026-10-09', 't', 't')`,
      )
      .run();
    const saleId = "probe";
    const base: {
      saleId: string;
      lineNo: number;
      productId: string | null;
      sku: string | null;
      productName: string;
      saleUnit: string | null;
      quantityMilli: number;
      unitPriceMinor: number;
      lineTotalMinor: number;
      invoiceLineId: string | null;
      unitLabel: string | null;
    } = {
      saleId,
      lineNo: 9,
      productId: "prod-0001",
      sku: "SKU",
      productName: "n",
      saleUnit: "piece",
      quantityMilli: 1000,
      unitPriceMinor: 100,
      lineTotalMinor: 100,
      invoiceLineId: null,
      unitLabel: null,
    };
    const insert = (over: Partial<typeof base>, id: string) =>
      h.db
        .prepare(
          `INSERT INTO sale_lines (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name,
                                   sale_unit, unit_label, quantity_milli, unit_price_minor, line_total_minor)
           VALUES (@id, @saleId, @lineNo, @invoiceLineId, @productId, @sku, @productName,
                   @saleUnit, @unitLabel, @quantityMilli, @unitPriceMinor, @lineTotalMinor)`,
        )
        .run({ ...base, ...over, id });

    // The columns are nullable now — only the source-aware trigger keeps the till strict.
    expect(() => insert({ productId: null }, "x1")).toThrow(/a POS sale line requires its product, sku and unit/);
    expect(() => insert({ sku: null }, "x2")).toThrow(/a POS sale line requires its product, sku and unit/);
    expect(() => insert({ saleUnit: null }, "x3")).toThrow(/a POS sale line requires its product, sku and unit/);
    // And a till line may not claim to come from an invoice.
    expect(() => insert({ invoiceLineId: "inv-line" }, "x4")).toThrow(
      /a POS sale line requires its product, sku and unit/,
    );
    // 🔴 The fraction rule still binds for the till: 2.5 pieces remains impossible.
    expect(() => insert({ quantityMilli: 2500, lineTotalMinor: 250 }, "x5")).toThrow(/CHECK constraint failed/);
    // The negative control — the same row, unmodified, is accepted.
    expect(() => insert({}, "x6")).not.toThrow();
  });

  it("🔴 an invoice-origin sale line must name the invoice line it froze", () => {
    const id = finalize([{ unitPrice: "10.00" }]);
    const saleId = saleOf(id)!.id;
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO sale_lines (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name,
                                   sale_unit, unit_label, quantity_milli, unit_price_minor, line_total_minor)
           VALUES ('y1', @saleId, 9, NULL, NULL, NULL, 'orphan', NULL, NULL, 1000, 100, 100)`,
        )
        .run({ saleId }),
    ).toThrow(/an invoice-origin sale line must name its invoice line/);
  });

  it("🔴 a POS sale still cannot omit its payment method", () => {
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
                              cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor,
                              paid_minor, balance_due_minor, payment_status, payment_method, line_count,
                              business_date, completed_at, created_at)
           VALUES ('nm', 500, 'nometh-00000001', 'f', 'pos', NULL, 'c', 'n', 'USD', 100, 0, 100,
                   100, 0, 'paid', NULL, 1, '2026-10-09', 't', 't')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("🔴 the payment status can never disagree with the money", () => {
    const bad = (status: string, paid: number, balance: number) => () =>
      h.db
        .prepare(
          `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
                              cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor,
                              paid_minor, balance_due_minor, payment_status, payment_method, line_count,
                              business_date, completed_at, created_at)
           VALUES (@id, @receipt, @key, 'f', 'pos', NULL, 'c', 'n', 'USD', 100, 0, 100,
                   @paid, @balance, @status, 'cash', 1, '2026-10-09', 't', 't')`,
        )
        .run({ id: `s-${status}-${paid}`, receipt: 600 + paid, key: `bad-${status}-${paid}-0001`, paid, balance, status });
    // "paid" with money still owed, "unpaid" with money received, "partial" with nothing received.
    expect(bad("paid", 40, 60)).toThrow(/CHECK constraint failed/);
    expect(bad("unpaid", 100, 0)).toThrow(/CHECK constraint failed/);
    expect(bad("partial", 0, 100)).toThrow(/CHECK constraint failed/);
    // And paid + balance must equal the total.
    expect(bad("partial", 40, 50)).toThrow(/CHECK constraint failed/);
  });
});
