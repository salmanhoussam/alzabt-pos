/**
 * Invoices and their lines — SQL only.
 *
 * 🔴 NO TRANSACTION OF ITS OWN, anywhere. Every write here is composed by `InvoiceService` into one
 * service-owned `BEGIN IMMEDIATE`; finalization in particular touches this table, `invoice_lines`,
 * `company_profile` and `invoice_reconciliation` and must commit as one act or not at all. A
 * repository-level transaction would turn that into a savepoint that proves nothing — the same
 * lesson `CatalogRepository.setActive` already carries.
 *
 * 🔴 NO BUSINESS RULES HERE. Whether a draft may be finalized, what its totals are, what its words
 * read — all of that is domain and service. This file knows how to store a row and how to read one
 * back. `finalize` is handed already-computed values; it does not compute them, and it does not
 * decide whether they were allowed.
 *
 * The database is still the last guard: the five migration-6 triggers abort any UPDATE, DELETE or
 * line INSERT once `status = 'final'`, so even a bug in this file cannot edit a commercial
 * document.
 */
import type { Db } from "./db";

export interface InvoiceRow {
  readonly id: string;
  readonly status: string;
  readonly invoice_number: bigint | null;
  readonly invoice_date: string | null;
  readonly currency: string;
  readonly customer_name: string | null;
  readonly customer_address: string | null;
  readonly customer_phone: string | null;
  readonly notes: string | null;
  readonly subtotal_minor: bigint;
  readonly tax_minor: bigint;
  readonly total_minor: bigint;
  readonly paid_minor: bigint;
  readonly balance_due_minor: bigint;
  readonly amount_in_words: string | null;
  readonly issuer_snapshot_json: string | null;
  readonly tax_snapshot_json: string | null;
  readonly created_by_id: string;
  readonly created_by_name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finalized_at: string | null;
}

export interface InvoiceLineRow {
  readonly id: string;
  readonly invoice_id: string;
  readonly line_no: bigint;
  readonly description: string | null;
  readonly unit_label: string | null;
  readonly canonical_unit: string | null;
  readonly product_id: string | null;
  readonly quantity_milli: bigint;
  readonly unit_price_minor: bigint;
  readonly line_total_minor: bigint;
  readonly created_at: string;
}

/** The editable header fields of a draft. Totals are never among them — they are derived. */
export interface InvoiceHeaderEdit {
  readonly invoiceDate: string | null;
  readonly customerName: string | null;
  readonly customerAddress: string | null;
  readonly customerPhone: string | null;
  readonly notes: string | null;
  readonly paidMinor: bigint;
}

/** One line as the operator entered it. `lineTotalMinor` is computed by the domain, never by SQL. */
export interface InvoiceLineInput {
  readonly description: string | null;
  readonly unitLabel: string | null;
  readonly canonicalUnit: string | null;
  readonly productId: string | null;
  readonly quantityMilli: number;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
}

/** Everything finalization freezes onto the document, already computed and validated. */
export interface InvoiceFinalization {
  readonly invoiceNumber: number;
  readonly invoiceDate: string;
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly balanceDueMinor: bigint;
  readonly amountInWords: string;
  readonly issuerSnapshotJson: string;
  readonly taxSnapshotJson: string;
  readonly finalizedAt: string;
}

const INVOICE_COLUMNS = `id, status, invoice_number, invoice_date, currency, customer_name,
  customer_address, customer_phone, notes, subtotal_minor, tax_minor, total_minor, paid_minor,
  balance_due_minor, amount_in_words, issuer_snapshot_json, tax_snapshot_json, created_by_id,
  created_by_name, created_at, updated_at, finalized_at`;

const LINE_COLUMNS = `id, invoice_id, line_no, description, unit_label, canonical_unit, product_id,
  quantity_milli, unit_price_minor, line_total_minor, created_at`;

export class InvoiceRepository {
  constructor(private readonly db: Db) {}

  // ── Drafts ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * An empty draft. Every money column starts at zero, which satisfies the table's own arithmetic
   * CHECKs (`total = subtotal + tax`, `balance = total - paid`) from the first instant — a draft is
   * never momentarily inconsistent, not even before it has a line.
   */
  createDraft(
    id: string,
    currency: string,
    createdBy: { readonly id: string; readonly name: string },
    now: Date,
  ): InvoiceRow {
    const stamp = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO invoices (${INVOICE_COLUMNS})
         VALUES (@id, 'draft', NULL, NULL, @currency, NULL, NULL, NULL, NULL,
                 0, 0, 0, 0, 0, NULL, NULL, NULL, @byId, @byName, @now, @now, NULL)`,
      )
      .run({ id, currency, byId: createdBy.id, byName: createdBy.name, now: stamp });
    return this.requireById(id);
  }

  findById(id: string): InvoiceRow | null {
    return (
      (this.db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ?`).get(id) as
        | InvoiceRow
        | undefined) ?? null
    );
  }

  requireById(id: string): InvoiceRow {
    const row = this.findById(id);
    if (!row) throw new Error(`invoice: no invoice '${id}'`);
    return row;
  }

  findByNumber(invoiceNumber: number): InvoiceRow | null {
    return (
      (this.db
        .prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE invoice_number = ?`)
        .get(invoiceNumber) as InvoiceRow | undefined) ?? null
    );
  }

  /**
   * Writes the draft's header and its recomputed money columns in one statement.
   *
   * The totals are passed in because the DATABASE checks them against each other: writing a
   * customer name without the matching totals would be rejected by the table's own arithmetic
   * CHECK. Header and money therefore move together, by the schema's design.
   */
  updateDraft(
    id: string,
    header: InvoiceHeaderEdit,
    totals: {
      readonly subtotalMinor: bigint;
      readonly taxMinor: bigint;
      readonly totalMinor: bigint;
      readonly balanceDueMinor: bigint;
    },
    now: Date,
  ): InvoiceRow {
    this.db
      .prepare(
        `UPDATE invoices
            SET invoice_date = @invoiceDate, customer_name = @customerName,
                customer_address = @customerAddress, customer_phone = @customerPhone,
                notes = @notes, subtotal_minor = @subtotal, tax_minor = @tax,
                total_minor = @total, paid_minor = @paid, balance_due_minor = @balance,
                updated_at = @now
          WHERE id = @id`,
      )
      .run({
        id,
        invoiceDate: header.invoiceDate,
        customerName: header.customerName,
        customerAddress: header.customerAddress,
        customerPhone: header.customerPhone,
        notes: header.notes,
        subtotal: totals.subtotalMinor,
        tax: totals.taxMinor,
        total: totals.totalMinor,
        paid: header.paidMinor,
        balance: totals.balanceDueMinor,
        now: now.toISOString(),
      });
    return this.requireById(id);
  }

  /** The draft -> final transition. The triggers fire on OLD.status = 'final', so this one passes. */
  finalize(id: string, f: InvoiceFinalization, now: Date): InvoiceRow {
    this.db
      .prepare(
        `UPDATE invoices
            SET status = 'final', invoice_number = @number, invoice_date = @date,
                subtotal_minor = @subtotal, tax_minor = @tax, total_minor = @total,
                paid_minor = @paid, balance_due_minor = @balance,
                amount_in_words = @words, issuer_snapshot_json = @issuer,
                tax_snapshot_json = @taxSnapshot, finalized_at = @finalizedAt, updated_at = @now
          WHERE id = @id AND status = 'draft'`,
      )
      .run({
        id,
        number: f.invoiceNumber,
        date: f.invoiceDate,
        subtotal: f.subtotalMinor,
        tax: f.taxMinor,
        total: f.totalMinor,
        paid: f.paidMinor,
        balance: f.balanceDueMinor,
        words: f.amountInWords,
        issuer: f.issuerSnapshotJson,
        taxSnapshot: f.taxSnapshotJson,
        finalizedAt: f.finalizedAt,
        now: now.toISOString(),
      });
    return this.requireById(id);
  }

  /** Discards a draft and its lines. The triggers make this impossible once final. */
  deleteDraft(id: string): void {
    this.db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").run(id);
    this.db.prepare("DELETE FROM invoices WHERE id = ?").run(id);
  }

  // ── Lines ───────────────────────────────────────────────────────────────────────────────────────

  listLines(invoiceId: string): InvoiceLineRow[] {
    return this.db
      .prepare(`SELECT ${LINE_COLUMNS} FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no`)
      .all(invoiceId) as InvoiceLineRow[];
  }

  findLine(lineId: string): InvoiceLineRow | null {
    return (
      (this.db.prepare(`SELECT ${LINE_COLUMNS} FROM invoice_lines WHERE id = ?`).get(lineId) as
        | InvoiceLineRow
        | undefined) ?? null
    );
  }

  countLines(invoiceId: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM invoice_lines WHERE invoice_id = ?")
      .get(invoiceId) as { n: bigint };
    return Number(row.n);
  }

  /** The next free line number for this invoice: max + 1, so a deletion leaves no reused number. */
  nextLineNo(invoiceId: string): number {
    const row = this.db
      .prepare("SELECT coalesce(max(line_no), 0) AS n FROM invoice_lines WHERE invoice_id = ?")
      .get(invoiceId) as { n: bigint };
    return Number(row.n) + 1;
  }

  addLine(id: string, invoiceId: string, lineNo: number, input: InvoiceLineInput, now: Date): InvoiceLineRow {
    this.db
      .prepare(
        `INSERT INTO invoice_lines (${LINE_COLUMNS})
         VALUES (@id, @invoiceId, @lineNo, @description, @unitLabel, @canonicalUnit, @productId,
                 @quantityMilli, @unitPriceMinor, @lineTotalMinor, @now)`,
      )
      .run({
        id,
        invoiceId,
        lineNo,
        description: input.description,
        unitLabel: input.unitLabel,
        canonicalUnit: input.canonicalUnit,
        productId: input.productId,
        quantityMilli: input.quantityMilli,
        unitPriceMinor: input.unitPriceMinor,
        lineTotalMinor: input.lineTotalMinor,
        now: now.toISOString(),
      });
    const row = this.findLine(id);
    if (!row) throw new Error("invoice: the line could not be read back");
    return row;
  }

  updateLine(lineId: string, input: InvoiceLineInput): InvoiceLineRow {
    this.db
      .prepare(
        `UPDATE invoice_lines
            SET description = @description, unit_label = @unitLabel, canonical_unit = @canonicalUnit,
                product_id = @productId, quantity_milli = @quantityMilli,
                unit_price_minor = @unitPriceMinor, line_total_minor = @lineTotalMinor
          WHERE id = @id`,
      )
      .run({
        id: lineId,
        description: input.description,
        unitLabel: input.unitLabel,
        canonicalUnit: input.canonicalUnit,
        productId: input.productId,
        quantityMilli: input.quantityMilli,
        unitPriceMinor: input.unitPriceMinor,
        lineTotalMinor: input.lineTotalMinor,
      });
    const row = this.findLine(lineId);
    if (!row) throw new Error(`invoice: no line '${lineId}'`);
    return row;
  }

  deleteLine(lineId: string): void {
    this.db.prepare("DELETE FROM invoice_lines WHERE id = ?").run(lineId);
  }

  // ── History ─────────────────────────────────────────────────────────────────────────────────────

  countFinalized(): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM invoices WHERE status = 'final'")
      .get() as { n: bigint };
    return Number(row.n);
  }

  /** Finalized invoices, newest number first. The reprint list. */
  listFinalized(limit = 100, offset = 0): InvoiceRow[] {
    return this.db
      .prepare(
        `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE status = 'final'
          ORDER BY invoice_number DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as InvoiceRow[];
  }

  /** Open drafts, most recently touched first. Work in progress, not documents. */
  listDrafts(limit = 100): InvoiceRow[] {
    return this.db
      .prepare(
        `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE status = 'draft'
          ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as InvoiceRow[];
  }

  /**
   * Finalized invoices whose customer name or number matches. Deliberately a plain LIKE on the
   * stored snapshot: there is no customer table to join, by decision — V1 holds a snapshot.
   */
  searchFinalized(term: string, limit = 50): InvoiceRow[] {
    // `%`, `_` and the escape character itself are escaped, so a customer called "50%" searches
    // for that string and not for "any 50 followed by anything".
    const like = `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(
        `SELECT ${INVOICE_COLUMNS} FROM invoices
          WHERE status = 'final'
            AND (customer_name LIKE ? ESCAPE '\\' OR CAST(invoice_number AS TEXT) LIKE ? ESCAPE '\\')
          ORDER BY invoice_number DESC LIMIT ?`,
      )
      .all(like, like, limit) as InvoiceRow[];
  }
}
