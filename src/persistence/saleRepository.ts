/**
 * The only module that writes or reads the ledger tables. Fixed, parameterised statements only —
 * no caller can pass SQL in.
 *
 * Atomicity: `commitSale` writes the header and every line inside ONE `BEGIN IMMEDIATE`
 * transaction and verifies, before COMMIT, that what was written adds up (line count and the sum
 * of line totals match the header). Any exception inside — a constraint, a thrown fault, the
 * verification itself — rolls the whole transaction back, so a half-written sale cannot exist.
 * A process that dies mid-transaction never reaches COMMIT; SQLite discards the partial write on
 * the next open. Both are proven by behavioural tests (tests/persistence/*).
 */
import { DomainError } from "../domain/errors";
import { money } from "../domain/money";
import type {
  ExternalPaymentEvidence,
  PaymentMethod,
  PaymentStatus,
  SaleLineRecord,
  SaleRecord,
  SaleTender,
  SaleSourceType,
  VoidRecord,
} from "../domain/sale";
import type { Db } from "./db";

/**
 * P1 · PAYMENT RECORDS (owner, 2026-11-07; payment model v3 on migration 19).
 *
 * A NEW sale paid by ONE method that needs no external evidence — cash, card or "other" — is written
 * with ONE `sale_tenders` row carrying that method and the amount paid, in the SAME transaction, and
 * the sale row seals it (`tender_count = 1`; the migration's `sales_tender_seal` trigger refuses any
 * mismatch). `payment_method` stays exactly as before, so every screen, receipt, report and statement
 * reads the same values: this slice changes what is RECORDED, not what the merchant sees.
 *
 * Deliberately NO tender (legacy shape, `tender_count = 0`) for:
 *  - nothing paid (a customer-credit sale, an unpaid invoice) — there is no payment to record;
 *  - an invoice sale — it captures no method today (`payment_method` NULL), and none is invented;
 *  - an `external` till sale WITHOUT evidence — migration 19 requires provider, reference and funds
 *    confirmation on an external tender, and inventing them is forbidden.
 * Historic sales are never touched (migration 19 already kept them at `tender_count = 0`).
 *
 * P2 (owner, 2026-11-07): an `external` till sale WITH evidence — today only Whish Money, its reference
 * and the operator's explicit "the money arrived" — gets ONE `external` tender carrying the provider,
 * the reference and `funds_confirmed = 1`, written in the same transaction. The tender's own trigger
 * registers the reference in `external_references`, whose unique key refuses the same Whish reference
 * a second time anywhere in the ledger (collection, receipt, sale or advance) — the whole sale rolls back.
 */
export type SingleTender =
  | { readonly method: "cash" | "card" | "other"; readonly amountMinor: bigint }
  | { readonly method: "external"; readonly amountMinor: bigint; readonly provider: "whish"; readonly reference: string };

export function singleTenderFor(
  header: Pick<NewSaleHeader, "paymentMethod" | "paidMinor" | "sourceType"> & Partial<Pick<NewSaleHeader, "externalPayment">>,
): SingleTender | null {
  if (header.sourceType !== "pos" || header.paidMinor <= 0n) return null;
  const m = header.paymentMethod;
  if (m === "cash" || m === "card" || m === "other") return { method: m, amountMinor: header.paidMinor };
  const e = header.externalPayment;
  if (m === "external" && e && e.provider === "whish" && e.fundsConfirmed === true && e.reference.length > 0) {
    return { method: "external", amountMinor: header.paidMinor, provider: "whish", reference: e.reference };
  }
  return null;
}

export interface NewSaleHeader {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly sourceType: SaleSourceType;
  /** Required when sourceType is "invoice", null otherwise. The database CHECK enforces both ways. */
  readonly invoiceId: string | null;
  /** Null for ordinary paid checkout and invoice-origin sales. */
  readonly customerId: string | null;
  /** Sale-time customer name; null with customerId for non-credit sales. */
  readonly customerNameSnapshot: string | null;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly currency: string;
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly balanceDueMinor: bigint;
  readonly paymentStatus: PaymentStatus;
  /** Null for an invoice with no captured method or a fully unpaid customer-credit POS sale. */
  readonly paymentMethod: PaymentMethod | null;
  /**
   * P2: the evidence of an `external` till payment (Whish Money only). The service sets it only after
   * the operator typed a reference and explicitly confirmed the money arrived; absent otherwise.
   */
  readonly externalPayment?: { readonly provider: "whish"; readonly reference: string; readonly fundsConfirmed: true } | null;
  /**
   * SELL-SPLIT-CASH-WHISH (owner, 2026-11-09): a sale paid by TWO OR MORE tenders (today: cash + Whish
   * Money, the full total, no debt). `paymentMethod` is then NULL — migration 19 requires it — and these
   * rows ARE the record of how the money arrived, written in `seq` order and sealed by the sale row
   * (`sales_tender_seal`: their count and their sum must equal `tender_count` and `paid_minor`).
   * Absent → the single-tender rule above, unchanged.
   */
  readonly tenders?: ReadonlyArray<SingleTender> | null;
  readonly businessDate: string;
  readonly completedAt: string;
  readonly createdAt: string;
}

/** SELL-SPLIT-CASH-WHISH: one recorded tender of a multi-tender sale, as read back. */
export interface SaleTenderRecord {
  readonly seq: number;
  readonly method: PaymentMethod;
  readonly amountMinor: bigint;
  readonly provider: "whish" | "bank_transfer" | null;
  readonly reference: string | null;
}

export interface NewSaleLine {
  readonly id: string;
  readonly lineNo: number;
  /** Set on an invoice-origin line, null on a POS line. */
  readonly invoiceLineId: string | null;
  /** Null only on an invoice-origin line whose product the catalog does not have yet. */
  readonly productId: string | null;
  readonly sku: string | null;
  readonly productName: string;
  /** Null when the printed unit maps to no base unit. Never guessed. */
  readonly saleUnit: string | null;
  /** The unit exactly as the invoice printed it. Null on a POS line. */
  readonly unitLabel: string | null;
  readonly quantityMilli: number;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
}

interface SaleRow {
  id: string;
  receipt_number: bigint;
  idempotency_key: string;
  request_fingerprint: string;
  source_type: SaleSourceType;
  invoice_id: string | null;
  customer_id: string | null;
  customer_name_snapshot: string | null;
  cashier_id: string;
  cashier_name: string;
  currency: string;
  subtotal_minor: bigint;
  tax_minor: bigint;
  total_minor: bigint;
  paid_minor: bigint;
  balance_due_minor: bigint;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod | null;
  line_count: bigint;
  business_date: string;
  completed_at: string;
  created_at: string;
  /** Migration 19. Read with `SELECT *`; absent only on a row built by hand in a test. */
  tender_count?: bigint;
}

interface LineRow {
  id: string;
  sale_id: string;
  line_no: bigint;
  invoice_line_id: string | null;
  product_id: string | null;
  sku: string | null;
  product_name: string;
  sale_unit: string | null;
  unit_label: string | null;
  quantity_milli: bigint;
  unit_price_minor: bigint;
  line_total_minor: bigint;
}

interface VoidRow {
  id: string;
  sale_id: string;
  cashier_id: string;
  cashier_name: string;
  reason: string;
  business_date: string;
  created_at: string;
}

function toSafeNumber(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new DomainError("LEDGER_INTEGRITY", `${what} out of range: ${value}`);
  return n;
}

export class SaleRepository {
  constructor(protected readonly db: Db) {}

  // ── Writes ────────────────────────────────────────────────────────────────────────────────────

  /** Atomically records a completed sale. Returns the receipt number assigned inside the transaction. */
  commitSale(header: NewSaleHeader, lines: ReadonlyArray<NewSaleLine>): number {
    return this.db.transaction(() => this.commitSaleWithinTransaction(header, lines)).immediate();
  }

  /**
   * The transaction-aware half of sale creation, for the internal credit-sale coordinator only.
   * It deliberately does not start or commit a transaction: the caller must own the outer
   * `BEGIN IMMEDIATE` that also posts and verifies the matching obligation.
   */
  commitSaleWithinTransaction(header: NewSaleHeader, lines: ReadonlyArray<NewSaleLine>): number {
    if (!this.db.inTransaction) {
      throw new DomainError("NOT_AVAILABLE", "Atomic sale posting requires an active database transaction");
    }
    const receiptNumber = this.nextReceiptNumber();
    // P1: the tender goes in FIRST (its sale_id is a deferred foreign key); the sale row then seals it.
    // SELL-SPLIT-CASH-WHISH: with two or more tenders, each goes in, in order, and the sale seals them all.
    const many = header.tenders ?? null;
    if (many !== null && many.length >= 2) {
      if (header.paymentMethod !== null) {
        throw new DomainError("LEDGER_INTEGRITY", "A sale paid by several tenders carries no single method");
      }
      many.forEach((tender, i) => this.insertTender(header.id, i + 1, tender));
      this.insertSaleHeader(header, receiptNumber, lines.length, many.length);
      for (const line of lines) this.insertSaleLine(header.id, line);
      this.verifySale(header.id);
      return receiptNumber;
    }
    if (many !== null && many.length > 0) {
      throw new DomainError("LEDGER_INTEGRITY", "A multi-tender sale needs at least two tenders");
    }
    const tender = singleTenderFor(header);
    if (tender) this.insertTender(header.id, 1, tender);
    this.insertSaleHeader(header, receiptNumber, lines.length, tender ? 1 : 0);
    for (const line of lines) this.insertSaleLine(header.id, line);
    this.verifySale(header.id);
    return receiptNumber;
  }

  /** Final sale-line/arithmetic verification while a coordinating transaction is still open. */
  verifySaleWithinTransaction(saleId: string): void {
    if (!this.db.inTransaction) {
      throw new DomainError("NOT_AVAILABLE", "Sale verification requires an active database transaction");
    }
    this.verifySale(saleId);
  }

  insertVoid(record: VoidRecord): void {
    this.db.transaction(() => {
      if (this.hasSaleObligation(record.saleId)) {
        throw new DomainError(
          "NOT_AVAILABLE",
          "A sale with a receivable obligation cannot be voided before an audited reversal exists",
        );
      }
      this.db
        .prepare(
          `INSERT INTO voids (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at)
           VALUES (@id, @saleId, @cashierId, @cashierName, @reason, @businessDate, @createdAt)`,
        )
        .run(record);
    }).immediate();
  }

  /** True for any sale-sourced obligation, including one with partial settlements. */
  hasSaleObligation(saleId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM obligations WHERE source_kind = 'sale' AND source_ref = ?")
        .get(saleId),
    );
  }

  // The steps below are separate methods so the failure tests can subclass the repository and
  // inject a fault between them. Both transaction-owning entry points use these statements.

  protected nextReceiptNumber(): number {
    const row = this.db.prepare("SELECT coalesce(max(receipt_number), 0) + 1 AS n FROM sales").get() as {
      n: bigint;
    };
    return toSafeNumber(row.n, "receipt number");
  }

  protected insertTender(saleId: string, seq: number, tender: SingleTender): void {
    const external = tender.method === "external";
    this.db
      .prepare(
        `INSERT INTO sale_tenders (sale_id, seq, method, provider, reference, funds_confirmed, amount_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        saleId,
        seq,
        tender.method,
        external ? tender.provider : null,
        external ? tender.reference : null,
        external ? 1 : null,
        tender.amountMinor,
      );
  }

  protected insertSaleHeader(header: NewSaleHeader, receiptNumber: number, lineCount: number, tenderCount = 0): void {
    this.db
      .prepare(
        `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
                            customer_id, customer_name_snapshot,
                            cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor,
                            paid_minor, balance_due_minor, payment_status, payment_method, line_count,
                            business_date, completed_at, created_at, tender_count)
         VALUES (@id, @receiptNumber, @idempotencyKey, @requestFingerprint, @sourceType, @invoiceId,
                 @customerId, @customerNameSnapshot,
                 @cashierId, @cashierName, @currency, @subtotalMinor, @taxMinor, @totalMinor,
                 @paidMinor, @balanceDueMinor, @paymentStatus, @paymentMethod, @lineCount,
                 @businessDate, @completedAt, @createdAt, @tenderCount)`,
      )
      .run({ ...header, receiptNumber, lineCount, tenderCount });
  }

  protected insertSaleLine(saleId: string, line: NewSaleLine): void {
    this.db
      .prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name,
                                 sale_unit, unit_label, quantity_milli, unit_price_minor, line_total_minor)
         VALUES (@id, @saleId, @lineNo, @invoiceLineId, @productId, @sku, @productName,
                 @saleUnit, @unitLabel, @quantityMilli, @unitPriceMinor, @lineTotalMinor)`,
      )
      .run({ ...line, saleId });
  }

  /** Inside the transaction: refuse to COMMIT a sale whose lines do not add up to its header. */
  protected verifySale(saleId: string): void {
    const row = this.db
      .prepare(
        `SELECT s.line_count, s.subtotal_minor, s.tax_minor, s.total_minor, s.paid_minor,
                s.balance_due_minor,
                count(l.id) AS lines, coalesce(sum(l.line_total_minor), 0) AS line_sum
           FROM sales s LEFT JOIN sale_lines l ON l.sale_id = s.id
          WHERE s.id = ? GROUP BY s.id`,
      )
      .get(saleId) as
      | {
          line_count: bigint;
          subtotal_minor: bigint;
          tax_minor: bigint;
          total_minor: bigint;
          paid_minor: bigint;
          balance_due_minor: bigint;
          lines: bigint;
          line_sum: bigint;
        }
      | undefined;
    // Migration 7 widened this from "total === subtotal" to "total === subtotal + tax", and added
    // the paid/balance identity. It is deliberately NOT weaker: a taxless sale still must have
    // total === subtotal, because tax_minor is then 0.
    if (
      !row ||
      row.lines !== row.line_count ||
      row.line_sum !== row.subtotal_minor ||
      row.total_minor !== row.subtotal_minor + row.tax_minor ||
      row.paid_minor + row.balance_due_minor !== row.total_minor
    ) {
      throw new DomainError("LEDGER_INTEGRITY", `Sale ${saleId} does not add up; transaction rolled back`);
    }
    // P1: a sale's payment records add up to exactly what it says was paid (the migration's seal trigger
    // checks this at insert; this re-reads it before COMMIT, so a fault anywhere still rolls back).
    const t = this.db
      .prepare(
        `SELECT s.tender_count AS declared, s.paid_minor AS paid, count(t.seq) AS n, coalesce(sum(t.amount_minor), 0) AS total
           FROM sales s LEFT JOIN sale_tenders t ON t.sale_id = s.id WHERE s.id = ? GROUP BY s.id`,
      )
      .get(saleId) as { declared: bigint; paid: bigint; n: bigint; total: bigint } | undefined;
    if (!t || t.n !== t.declared || (t.declared > 0n && t.total !== t.paid)) {
      throw new DomainError("LEDGER_INTEGRITY", `Sale ${saleId} payment records do not add up; transaction rolled back`);
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────

  findByIdempotencyKey(key: string): { sale: SaleRecord; fingerprint: string } | undefined {
    const row = this.db.prepare("SELECT * FROM sales WHERE idempotency_key = ?").get(key) as SaleRow | undefined;
    return row ? { sale: this.hydrate(row), fingerprint: row.request_fingerprint } : undefined;
  }

  getSale(id: string): SaleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sales WHERE id = ?").get(id) as SaleRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * The invoice -> sale direction. There is no invoices.sale_id column on purpose: a finalized
   * invoice is immutable, so the link lives on the sale and is read back through this UNIQUE index.
   */
  findByInvoiceId(invoiceId: string): SaleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sales WHERE invoice_id = ?").get(invoiceId) as SaleRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  getVoid(saleId: string): VoidRecord | undefined {
    const row = this.db.prepare("SELECT * FROM voids WHERE sale_id = ?").get(saleId) as VoidRow | undefined;
    return row ? hydrateVoid(row) : undefined;
  }

  /** Most recent first. */
  listSales(limit: number): SaleRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sales ORDER BY receipt_number DESC LIMIT ?")
      .all(limit) as SaleRow[];
    return rows.map((r) => this.hydrate(r));
  }

  /**
   * SELL-CUSTOMER-LINK (ACC-2): the PAID till sales linked to one customer, oldest first.
   *
   * 🔴 ONLY `source_type = 'pos' AND payment_status = 'paid'`. A credit sale is shown once, as its
   * obligation, so it is excluded here — listing it twice would make one sale look like two
   * activities. Invoice sales carry no customer id (M14). No index on `customer_id` exists; at a
   * shop's volume this is a scan of one table (measured cost recorded with the slice, not guessed).
   */
  listPaidSalesForCustomer(customerId: string): SaleRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sales
          WHERE customer_id = ? AND source_type = 'pos' AND payment_status = 'paid'
          ORDER BY completed_at, receipt_number`,
      )
      .all(customerId) as SaleRow[];
    return rows.map((r) => this.hydrate(r));
  }

  listVoidsForSales(saleIds: ReadonlyArray<string>): Map<string, VoidRecord> {
    const out = new Map<string, VoidRecord>();
    const stmt = this.db.prepare("SELECT * FROM voids WHERE sale_id = ?");
    for (const id of saleIds) {
      const row = stmt.get(id) as VoidRow | undefined;
      if (row) out.set(id, hydrateVoid(row));
    }
    return out;
  }

  /** Every sale of one business day with its void flag — the input to the pure report builder. */
  reportRows(businessDate: string): Array<{ currency: string; totalMinor: bigint; voided: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT s.currency, s.total_minor, (v.id IS NOT NULL) AS voided
           FROM sales s LEFT JOIN voids v ON v.sale_id = s.id
          WHERE s.business_date = ?`,
      )
      .all(businessDate) as Array<{ currency: string; total_minor: bigint; voided: bigint }>;
    return rows.map((r) => ({ currency: r.currency, totalMinor: r.total_minor, voided: r.voided === 1n }));
  }

  /** P2: the provider + reference on an external sale's ONE tender; null for any other sale. */
  private externalPaymentOf(row: SaleRow): ExternalPaymentEvidence | null {
    if (row.payment_method !== "external") return null;
    const t = this.db
      .prepare("SELECT provider, reference FROM sale_tenders WHERE sale_id = ? AND seq = 1 AND method = 'external'")
      .get(row.id) as { provider: "whish" | "bank_transfer" | null; reference: string | null } | undefined;
    return t && t.provider && t.reference ? { provider: t.provider, reference: t.reference } : null;
  }

  /**
   * SELL-SPLIT-CASH-WHISH: `{ tenders }` for a sale sealed with two or more tenders, `{}` otherwise —
   * so every single-tender, legacy or unpaid sale keeps EXACTLY its previous record shape.
   */
  private multiTendersOf(row: SaleRow): { tenders?: SaleTender[] } {
    if (row.tender_count === undefined || row.tender_count < 2n) return {};
    const rows = this.db
      .prepare("SELECT seq, method, amount_minor, provider, reference FROM sale_tenders WHERE sale_id = ? ORDER BY seq")
      .all(row.id) as Array<{ seq: bigint; method: PaymentMethod; amount_minor: bigint; provider: "whish" | "bank_transfer" | null; reference: string | null }>;
    if (rows.length !== Number(row.tender_count)) {
      throw new DomainError("LEDGER_INTEGRITY", `Sale ${row.id} has ${rows.length} of ${row.tender_count} tenders`);
    }
    return {
      tenders: rows.map((t) => ({
        seq: toSafeNumber(t.seq, "tender seq"),
        method: t.method,
        amount: money(t.amount_minor, row.currency),
        provider: t.provider,
        reference: t.reference,
      })),
    };
  }

  private hydrate(row: SaleRow): SaleRecord {
    const lines = (
      this.db.prepare("SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY line_no").all(row.id) as LineRow[]
    ).map(
      (l): SaleLineRecord => ({
        id: l.id,
        saleId: l.sale_id,
        lineNo: toSafeNumber(l.line_no, "line number"),
        invoiceLineId: l.invoice_line_id,
        productId: l.product_id,
        sku: l.sku,
        productName: l.product_name,
        saleUnit: l.sale_unit,
        unitLabel: l.unit_label,
        quantityMilli: toSafeNumber(l.quantity_milli, "quantity"),
        unitPrice: money(l.unit_price_minor, row.currency),
        lineTotal: money(l.line_total_minor, row.currency),
      }),
    );
    if (lines.length !== Number(row.line_count)) {
      throw new DomainError("LEDGER_INTEGRITY", `Sale ${row.id} has ${lines.length} of ${row.line_count} lines`);
    }
    return {
      id: row.id,
      receiptNumber: toSafeNumber(row.receipt_number, "receipt number"),
      cashierId: row.cashier_id,
      cashierName: row.cashier_name,
      currency: row.currency,
      sourceType: row.source_type,
      invoiceId: row.invoice_id,
      customerId: row.customer_id,
      customerNameSnapshot: row.customer_name_snapshot,
      subtotal: money(row.subtotal_minor, row.currency),
      tax: money(row.tax_minor, row.currency),
      total: money(row.total_minor, row.currency),
      paid: money(row.paid_minor, row.currency),
      balanceDue: money(row.balance_due_minor, row.currency),
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      externalPayment: this.externalPaymentOf(row),
      ...this.multiTendersOf(row),
      businessDate: row.business_date,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      lines,
    };
  }
}

function hydrateVoid(row: VoidRow): VoidRecord {
  return {
    id: row.id,
    saleId: row.sale_id,
    cashierId: row.cashier_id,
    cashierName: row.cashier_name,
    reason: row.reason,
    businessDate: row.business_date,
    createdAt: row.created_at,
  };
}
