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
import type { PaymentMethod, SaleLineRecord, SaleRecord, VoidRecord } from "../domain/sale";
import type { Db } from "./db";

export interface NewSaleHeader {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly currency: string;
  readonly subtotalMinor: bigint;
  readonly totalMinor: bigint;
  readonly paymentMethod: PaymentMethod;
  readonly businessDate: string;
  readonly completedAt: string;
  readonly createdAt: string;
}

export interface NewSaleLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
}

interface SaleRow {
  id: string;
  receipt_number: bigint;
  idempotency_key: string;
  request_fingerprint: string;
  cashier_id: string;
  cashier_name: string;
  currency: string;
  subtotal_minor: bigint;
  total_minor: bigint;
  payment_method: PaymentMethod;
  line_count: bigint;
  business_date: string;
  completed_at: string;
  created_at: string;
}

interface LineRow {
  id: string;
  sale_id: string;
  line_no: bigint;
  product_id: string;
  sku: string;
  product_name: string;
  quantity: bigint;
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
        `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, cashier_id, cashier_name,
                            currency, subtotal_minor, total_minor, payment_method, line_count, business_date,
                            completed_at, created_at)
         VALUES (@id, @receiptNumber, @idempotencyKey, @requestFingerprint, @cashierId, @cashierName,
                 @currency, @subtotalMinor, @totalMinor, @paymentMethod, @lineCount, @businessDate,
                 @completedAt, @createdAt)`,
      )
      .run({ ...header, receiptNumber, lineCount });
  }

  protected insertSaleLine(saleId: string, line: NewSaleLine): void {
    this.db
      .prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, product_id, sku, product_name, quantity,
                                 unit_price_minor, line_total_minor)
         VALUES (@id, @saleId, @lineNo, @productId, @sku, @productName, @quantity,
                 @unitPriceMinor, @lineTotalMinor)`,
      )
      .run({ ...line, saleId });
  }

  /** Inside the transaction: refuse to COMMIT a sale whose lines do not add up to its header. */
  protected verifySale(saleId: string): void {
    const row = this.db
      .prepare(
        `SELECT s.line_count, s.subtotal_minor, s.total_minor,
                count(l.id) AS lines, coalesce(sum(l.line_total_minor), 0) AS line_sum
           FROM sales s LEFT JOIN sale_lines l ON l.sale_id = s.id
          WHERE s.id = ? GROUP BY s.id`,
      )
      .get(saleId) as
      | { line_count: bigint; subtotal_minor: bigint; total_minor: bigint; lines: bigint; line_sum: bigint }
      | undefined;
    if (
      !row ||
      row.lines !== row.line_count ||
      row.line_sum !== row.subtotal_minor ||
      row.total_minor !== row.subtotal_minor
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
        productId: l.product_id,
        sku: l.sku,
        productName: l.product_name,
        quantity: toSafeNumber(l.quantity, "quantity"),
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
      subtotal: money(row.subtotal_minor, row.currency),
      total: money(row.total_minor, row.currency),
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
