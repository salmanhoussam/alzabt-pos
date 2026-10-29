/**
 * The `receipts`, `receipt_attempts` and `receipt_attempt_lines` tables (migration 18), and the
 * allocation settlements that point at a receipt. Prepared statements, no business rules.
 *
 * 🔴 WHAT THIS FILE REFUSES TO DECIDE. Whether an owner may record a receipt, whether a repeat is a
 * retry, and what an operator is told are `LedgerService`'s decisions. This file only writes and
 * reads; the database triggers of migration 18 are the authority on the invariants (exact
 * allocation, one reference once, immutability).
 *
 * 🔴 NOTHING HERE UPDATES OR DELETES except the one-time resolution of an attempt, which the
 * `receipt_attempts_resolve_once` trigger already restricts to exactly that.
 */
import type { Db } from "./db";

export type ReceiptProvider = "whish" | "bank_transfer";

export interface ReceiptAttemptLine {
  readonly obligationId: string;
  readonly amountMinor: bigint;
}

export interface NewReceiptAttempt {
  readonly key: string;
  readonly customerId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly provider: ReceiptProvider;
  readonly reference: string;
  readonly fingerprint: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly lines: ReadonlyArray<ReceiptAttemptLine>;
}

export interface StoredReceiptAttempt extends NewReceiptAttempt {
  readonly resolution: "recorded" | "not_recorded" | null;
}

export interface NewReceipt {
  readonly id: string;
  readonly customerId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly provider: ReceiptProvider;
  readonly reference: string;
  readonly allocationCount: number;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly businessDate: string;
}

export interface ReceiptRecord extends Omit<NewReceipt, "fingerprint"> {}

export interface NewAllocation {
  readonly id: string;
  readonly receiptId: string;
  readonly obligationId: string;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly amountMinor: bigint;
  readonly settledBy: string;
  readonly settledAt: string;
  readonly businessDate: string;
}

export interface AllocationRecord {
  readonly settlementId: string;
  readonly obligationId: string;
  readonly amountMinor: bigint;
}

interface AttemptRow {
  readonly idempotency_key: string;
  readonly customer_id: string;
  readonly currency: string;
  readonly amount_minor: bigint | number;
  readonly provider: ReceiptProvider;
  readonly reference: string;
  readonly request_fingerprint: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly resolution: "recorded" | "not_recorded" | null;
}

interface ReceiptRow {
  readonly id: string;
  readonly customer_id: string;
  readonly currency: string;
  readonly amount_minor: bigint | number;
  readonly provider: ReceiptProvider;
  readonly reference: string;
  readonly allocation_count: bigint | number;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly received_by: string;
  readonly received_at: string;
  readonly business_date: string;
}

const minor = (v: bigint | number): bigint => (typeof v === "bigint" ? v : BigInt(v));
const A_COLS = `idempotency_key, customer_id, currency, amount_minor, provider, reference, request_fingerprint,
                created_by, created_at, resolution`;
const R_COLS = `id, customer_id, currency, amount_minor, provider, reference, allocation_count, idempotency_key,
                request_fingerprint, received_by, received_at, business_date`;

export class ReceiptRepository {
  constructor(private readonly db: Db) {}

  // ── Attempts ────────────────────────────────────────────────────────────────────────────────
  insertAttempt(a: NewReceiptAttempt): void {
    this.db
      .prepare(
        `INSERT INTO receipt_attempts (idempotency_key, customer_id, currency, amount_minor, provider, reference,
                                       funds_confirmed, allocation_count, request_fingerprint, created_by, created_at)
         VALUES (@key, @customerId, @currency, @amountMinor, @provider, @reference, 1, @count, @fingerprint, @createdBy, @createdAt)`,
      )
      .run({ ...a, count: a.lines.length });
    const line = this.db.prepare(
      "INSERT INTO receipt_attempt_lines (idempotency_key, obligation_id, amount_minor) VALUES (?, ?, ?)",
    );
    for (const l of a.lines) line.run(a.key, l.obligationId, l.amountMinor);
  }

  private hydrate(row: AttemptRow): StoredReceiptAttempt {
    const lines = (
      this.db
        .prepare("SELECT obligation_id, amount_minor FROM receipt_attempt_lines WHERE idempotency_key = ? ORDER BY obligation_id")
        .all(row.idempotency_key) as Array<{ obligation_id: string; amount_minor: bigint | number }>
    ).map((l) => ({ obligationId: l.obligation_id, amountMinor: minor(l.amount_minor) }));
    return {
      key: row.idempotency_key,
      customerId: row.customer_id,
      currency: row.currency,
      amountMinor: minor(row.amount_minor),
      provider: row.provider,
      reference: row.reference,
      fingerprint: row.request_fingerprint,
      createdBy: row.created_by,
      createdAt: row.created_at,
      resolution: row.resolution,
      lines,
    };
  }

  findAttempt(key: string): StoredReceiptAttempt | null {
    const row = this.db.prepare(`SELECT ${A_COLS} FROM receipt_attempts WHERE idempotency_key = ?`).get(key) as
      | AttemptRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  listOpenAttempts(customerId: string): StoredReceiptAttempt[] {
    return (
      this.db
        .prepare(`SELECT ${A_COLS} FROM receipt_attempts WHERE customer_id = ? AND resolved_at IS NULL ORDER BY created_at, idempotency_key`)
        .all(customerId) as AttemptRow[]
    ).map((r) => this.hydrate(r));
  }

  /** Closes an open attempt, once. A no-op for an attempt that is missing or already closed. */
  resolveAttempt(key: string, resolution: "recorded" | "not_recorded", at: Date): void {
    this.db
      .prepare("UPDATE receipt_attempts SET resolved_at = ?, resolution = ? WHERE idempotency_key = ? AND resolved_at IS NULL")
      .run(at.toISOString(), resolution, key);
  }

  // ── Receipts and allocations ────────────────────────────────────────────────────────────────

  /** One allocation settlement, written BEFORE its receipt (the deferred foreign key allows it). */
  insertAllocation(a: NewAllocation): void {
    this.db
      .prepare(
        `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor,
                                  method, provider, reference, funds_confirmed, settled_by, settled_at, business_date, receipt_id)
         VALUES (@id, @obligationId, @currency, @idempotencyKey, @fingerprint, @amountMinor,
                 'external', NULL, NULL, NULL, @settledBy, @settledAt, @businessDate, @receiptId)`,
      )
      .run(a);
  }

  /** The SEAL: the receipt row, inserted LAST. Its trigger validates the allocations already written. */
  insertReceipt(r: NewReceipt): void {
    this.db
      .prepare(
        `INSERT INTO receipts (${R_COLS}, funds_confirmed)
         VALUES (@id, @customerId, @currency, @amountMinor, @provider, @reference, @allocationCount, @idempotencyKey,
                 @fingerprint, @receivedBy, @receivedAt, @businessDate, 1)`,
      )
      .run(r);
  }

  private toReceipt(row: ReceiptRow): ReceiptRecord {
    return {
      id: row.id,
      customerId: row.customer_id,
      currency: row.currency,
      amountMinor: minor(row.amount_minor),
      provider: row.provider,
      reference: row.reference,
      allocationCount: Number(row.allocation_count),
      idempotencyKey: row.idempotency_key,
      receivedBy: row.received_by,
      receivedAt: row.received_at,
      businessDate: row.business_date,
    };
  }

  findByKey(key: string): { receipt: ReceiptRecord; fingerprint: string } | null {
    const row = this.db.prepare(`SELECT ${R_COLS} FROM receipts WHERE idempotency_key = ?`).get(key) as ReceiptRow | undefined;
    return row ? { receipt: this.toReceipt(row), fingerprint: row.request_fingerprint } : null;
  }

  findByProviderReference(provider: string, reference: string): ReceiptRecord | null {
    const row = this.db.prepare(`SELECT ${R_COLS} FROM receipts WHERE provider = ? AND reference = ?`).get(provider, reference) as
      | ReceiptRow
      | undefined;
    return row ? this.toReceipt(row) : null;
  }

  listAllocations(receiptId: string): AllocationRecord[] {
    return (
      this.db
        .prepare("SELECT id, obligation_id, amount_minor FROM settlements WHERE receipt_id = ? ORDER BY obligation_id")
        .all(receiptId) as Array<{ id: string; obligation_id: string; amount_minor: bigint | number }>
    ).map((r) => ({ settlementId: r.id, obligationId: r.obligation_id, amountMinor: minor(r.amount_minor) }));
  }

  /** For a statement: which receipt (if any) each of these settlements is an allocation of. */
  receiptsOfSettlements(settlementIds: ReadonlyArray<string>): Map<string, ReceiptRecord> {
    const out = new Map<string, ReceiptRecord>();
    if (settlementIds.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT s.id AS sid, r.id, r.customer_id, r.currency, r.amount_minor, r.provider, r.reference, r.allocation_count,
              r.idempotency_key, r.request_fingerprint, r.received_by, r.received_at, r.business_date
         FROM settlements s JOIN receipts r ON r.id = s.receipt_id WHERE s.id = ?`,
    );
    for (const id of settlementIds) {
      const row = stmt.get(id) as (ReceiptRow & { sid: string }) | undefined;
      if (row) out.set(row.sid, this.toReceipt(row));
    }
    return out;
  }

  /**
   * Re-derives, from the stored rows alone, whether one receipt is exactly what it claims. The seal
   * trigger enforces this at write time; this is the read-side proof used by recovery and by tests.
   */
  receiptIntegrity(receiptId: string): { readonly ok: boolean; readonly problems: string[] } {
    const problems: string[] = [];
    const r = this.db.prepare(`SELECT ${R_COLS} FROM receipts WHERE id = ?`).get(receiptId) as ReceiptRow | undefined;
    if (!r) return { ok: false, problems: ["receipt not found"] };
    const kids = this.db
      .prepare(
        `SELECT s.obligation_id, s.amount_minor, s.currency, s.method, s.provider, s.reference, o.party_id, o.direction
           FROM settlements s JOIN obligations o ON o.id = s.obligation_id WHERE s.receipt_id = ?`,
      )
      .all(receiptId) as Array<{
      obligation_id: string;
      amount_minor: bigint | number;
      currency: string;
      method: string;
      provider: string | null;
      reference: string | null;
      party_id: string;
      direction: string;
    }>;
    if (kids.length !== Number(r.allocation_count)) problems.push("allocation count differs");
    if (new Set(kids.map((k) => k.obligation_id)).size !== kids.length) problems.push("a debt is allocated twice");
    if (kids.reduce((s, k) => s + minor(k.amount_minor), 0n) !== minor(r.amount_minor)) problems.push("allocations do not add up");
    for (const k of kids) {
      if (k.party_id !== r.customer_id) problems.push("allocation belongs to another customer");
      if (k.direction !== "receivable") problems.push("allocation is not a receivable");
      if (k.currency !== r.currency) problems.push("allocation currency differs");
      if (k.method !== "external" || k.provider !== null || k.reference !== null) problems.push("allocation carries its own payment details");
    }
    return { ok: problems.length === 0, problems };
  }
}
