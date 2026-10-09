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
  PaymentMethod,
  PaymentStatus,
  SaleLineRecord,
  SaleRecord,
  SaleSourceType,
  VoidRecord,
} from "../domain/sale";
import type { Db } from "./db";

export interface NewSaleHeader {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly sourceType: SaleSourceType;
  /** Required when sourceType is "invoice", null otherwise. The database CHECK enforces both ways. */
  readonly invoiceId: string | null;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly currency: string;
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly balanceDueMinor: bigint;
  readonly paymentStatus: PaymentStatus;
  /** Null ONLY for an invoice-origin sale that recorded no method. Never a fabricated value. */
  readonly paymentMethod: PaymentMethod | null;
  readonly businessDate: string;
  readonly completedAt: string;
  readonly createdAt: string;
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
    const run = this.db.transaction((): number => {
      const receiptNumber = this.nextReceiptNumber();
      this.insertSaleHeader(header, receiptNumber, lines.length);
      for (const line of lines) this.insertSaleLine(header.id, line);
      this.verifySale(header.id);
      return receiptNumber;
    });
    return run.immediate();
  }

  insertVoid(record: VoidRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO voids (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at)
           VALUES (@id, @saleId, @cashierId, @cashierName, @reason, @businessDate, @createdAt)`,
        )
        .run(record);
    }).immediate();
  }

  // The steps below are separate methods ONLY so the failure tests can subclass the repository and
  // inject a fault between them. Production code calls them exclusively through commitSale().

  protected nextReceiptNumber(): number {
    const row = this.db.prepare("SELECT coalesce(max(receipt_number), 0) + 1 AS n FROM sales").get() as {
      n: bigint;
    };
    return toSafeNumber(row.n, "receipt number");
  }

  protected insertSaleHeader(header: NewSaleHeader, receiptNumber: number, lineCount: number): void {
    this.db
      .prepare(
        `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
                            cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor,
                            paid_minor, balance_due_minor, payment_status, payment_method, line_count,
                            business_date, completed_at, created_at)
         VALUES (@id, @receiptNumber, @idempotencyKey, @requestFingerprint, @sourceType, @invoiceId,
                 @cashierId, @cashierName, @currency, @subtotalMinor, @taxMinor, @totalMinor,
                 @paidMinor, @balanceDueMinor, @paymentStatus, @paymentMethod, @lineCount,
                 @businessDate, @completedAt, @createdAt)`,
      )
      .run({ ...header, receiptNumber, lineCount });
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
      subtotal: money(row.subtotal_minor, row.currency),
      tax: money(row.tax_minor, row.currency),
      total: money(row.total_minor, row.currency),
      paid: money(row.paid_minor, row.currency),
      balanceDue: money(row.balance_due_minor, row.currency),
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
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
