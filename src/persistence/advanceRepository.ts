/**
 * Customer advances (migrations 19 + 20) — SQL only. Every rule that protects money is a database
 * trigger (see migrations 19/20); this repository reads and writes rows and decides nothing.
 */
import type { Db } from "./db";
import { M19_REF_KEY } from "./migrations";

export type AdvanceChannel = "cash" | "whish";

export interface AdvanceIntent {
  readonly key: string;
  readonly customerId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly channel: AdvanceChannel;
  readonly reference: string | null;
  readonly fundsConfirmed: boolean;
  readonly fingerprint: string;
  readonly createdBy: string;
}

export interface AdvanceAttemptRecord extends AdvanceIntent {
  readonly createdAt: string;
  readonly resolution: "recorded" | "not_recorded" | null;
  readonly resolvedAt: string | null;
  readonly acknowledgedAt: string | null;
}

export interface AdvanceRecord {
  readonly id: string;
  readonly docNo: number;
  readonly customerId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly method: "cash" | "external";
  readonly provider: "whish" | null;
  readonly reference: string | null;
  readonly key: string;
  readonly fingerprint: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly businessDate: string;
  /** Migration 20: 'receipt' (money received) or 'correction' (a restatement of an earlier advance). */
  readonly origin?: "receipt" | "correction";
  readonly correctsAdvanceId?: string | null;
}

export interface AdvanceCorrectionRecord {
  readonly id: string;
  readonly advanceId: string;
  readonly kind: "not_received" | "replaced";
  readonly successorAdvanceId: string | null;
  readonly fundsNotReceived: boolean;
  readonly reason: string;
  readonly correctedBy: string;
  readonly correctedAt: string;
  readonly businessDate: string;
  readonly key: string;
  readonly fingerprint: string;
}

/** One line of the daily money view for advances, per method (minor units, signed). */
export interface AdvanceDayMoney {
  readonly method: "cash" | "external";
  /** Money received that day as advances (origin = 'receipt' only). */
  readonly receivedMinor: bigint;
  /** Corrections dated that day: − corrected originals + their successors. Never a receipt. */
  readonly correctionMinor: bigint;
}

interface CorrectionRow {
  id: string;
  advance_id: string;
  kind: string;
  successor_advance_id: string | null;
  funds_not_received: bigint | number | null;
  reason: string;
  corrected_by: string;
  corrected_at: string;
  business_date: string;
  idempotency_key: string;
  request_fingerprint: string;
}

interface AttemptRow {
  idempotency_key: string;
  customer_id: string;
  currency: string;
  amount_minor: bigint | number;
  channel: string;
  reference: string | null;
  funds_confirmed: bigint | number | null;
  request_fingerprint: string;
  created_by: string;
  created_at: string;
  resolution: string | null;
  resolved_at: string | null;
  acknowledged_at: string | null;
}

interface AdvanceRow {
  id: string;
  doc_no: bigint | number;
  customer_id: string;
  currency: string;
  amount_minor: bigint | number;
  method: string;
  provider: string | null;
  reference: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  received_by: string;
  received_at: string;
  business_date: string;
  origin: string;
  corrects_advance_id: string | null;
}

const minor = (v: bigint | number): bigint => (typeof v === "bigint" ? v : BigInt(v));

const AT_COLS = `idempotency_key, customer_id, currency, amount_minor, channel, reference, funds_confirmed,
  request_fingerprint, created_by, created_at, resolution, resolved_at, acknowledged_at`;
const AD_COLS = `id, doc_no, customer_id, currency, amount_minor, method, provider, reference, idempotency_key,
  request_fingerprint, received_by, received_at, business_date, origin, corrects_advance_id`;
const CO_COLS = `id, advance_id, kind, successor_advance_id, funds_not_received, reason, corrected_by, corrected_at,
  business_date, idempotency_key, request_fingerprint`;

function correction(r: CorrectionRow): AdvanceCorrectionRecord {
  return {
    id: r.id,
    advanceId: r.advance_id,
    kind: r.kind as AdvanceCorrectionRecord["kind"],
    successorAdvanceId: r.successor_advance_id,
    fundsNotReceived: r.funds_not_received !== null && Number(r.funds_not_received) === 1,
    reason: r.reason,
    correctedBy: r.corrected_by,
    correctedAt: r.corrected_at,
    businessDate: r.business_date,
    key: r.idempotency_key,
    fingerprint: r.request_fingerprint,
  };
}

function attempt(r: AttemptRow): AdvanceAttemptRecord {
  return {
    key: r.idempotency_key,
    customerId: r.customer_id,
    currency: r.currency,
    amountMinor: minor(r.amount_minor),
    channel: r.channel as AdvanceChannel,
    reference: r.reference,
    fundsConfirmed: r.funds_confirmed !== null && Number(r.funds_confirmed) === 1,
    fingerprint: r.request_fingerprint,
    createdBy: r.created_by,
    createdAt: r.created_at,
    resolution: r.resolution as AdvanceAttemptRecord["resolution"],
    resolvedAt: r.resolved_at,
    acknowledgedAt: r.acknowledged_at,
  };
}

function advance(r: AdvanceRow): AdvanceRecord {
  return {
    id: r.id,
    docNo: Number(r.doc_no),
    customerId: r.customer_id,
    currency: r.currency,
    amountMinor: minor(r.amount_minor),
    method: r.method as AdvanceRecord["method"],
    provider: r.provider as AdvanceRecord["provider"],
    reference: r.reference,
    key: r.idempotency_key,
    fingerprint: r.request_fingerprint,
    receivedBy: r.received_by,
    receivedAt: r.received_at,
    businessDate: r.business_date,
    origin: r.origin as "receipt" | "correction",
    correctsAdvanceId: r.corrects_advance_id,
  };
}

export class AdvanceRepository {
  constructor(private readonly db: Db) {}

  // ── Attempts (migration 20) ────────────────────────────────────────────────────────────────

  insertAttempt(a: AdvanceIntent, at: string): void {
    this.db
      .prepare(
        `INSERT INTO advance_attempts (idempotency_key, customer_id, currency, amount_minor, channel, reference,
                                       funds_confirmed, request_fingerprint, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.key, a.customerId, a.currency, a.amountMinor, a.channel, a.reference, a.channel === "whish" ? 1 : null, a.fingerprint, a.createdBy, at);
  }

  findAttempt(key: string): AdvanceAttemptRecord | null {
    const row = this.db.prepare(`SELECT ${AT_COLS} FROM advance_attempts WHERE idempotency_key = ?`).get(key) as AttemptRow | undefined;
    return row ? attempt(row) : null;
  }

  /** Open attempts of one customer (no money row, not closed), oldest first. */
  listOpenAttempts(customerId: string): AdvanceAttemptRecord[] {
    return (
      this.db
        .prepare(`SELECT ${AT_COLS} FROM advance_attempts WHERE customer_id = ? AND resolution IS NULL ORDER BY created_at, idempotency_key`)
        .all(customerId) as AttemptRow[]
    ).map(attempt);
  }

  /** Every attempt whose outcome the operator has not yet seen: open, or resolved but not acknowledged. */
  listUnacknowledged(): AdvanceAttemptRecord[] {
    return (
      this.db
        .prepare(`SELECT ${AT_COLS} FROM advance_attempts WHERE acknowledged_at IS NULL ORDER BY created_at, idempotency_key`)
        .all() as AttemptRow[]
    ).map(attempt);
  }

  resolveAttempt(key: string, resolution: "recorded" | "not_recorded", at: string): void {
    this.db
      .prepare(`UPDATE advance_attempts SET resolved_at = ?, resolution = ? WHERE idempotency_key = ? AND resolution IS NULL`)
      .run(at, resolution, key);
  }

  acknowledgeAttempt(key: string, at: string): number {
    return Number(
      this.db
        .prepare(`UPDATE advance_attempts SET acknowledged_at = ? WHERE idempotency_key = ? AND resolution IS NOT NULL AND acknowledged_at IS NULL`)
        .run(at, key).changes,
    );
  }

  // ── Advances (migration 19) ────────────────────────────────────────────────────────────────

  /** Issues the next ADV number. MUST run inside the transaction that inserts the advance. */
  issueAdvanceNumber(): number {
    this.db.prepare(`UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance'`).run();
    const row = this.db.prepare(`SELECT last_no FROM document_numbers WHERE kind = 'advance'`).get() as { last_no: bigint | number };
    return Number(row.last_no);
  }

  insertAdvance(a: AdvanceRecord): void {
    this.db
      .prepare(
        `INSERT INTO customer_advances (id, doc_no, customer_id, currency, amount_minor, method, provider, reference,
                                        funds_confirmed, idempotency_key, request_fingerprint, received_by, received_at, business_date,
                                        origin, corrects_advance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.docNo,
        a.customerId,
        a.currency,
        a.amountMinor,
        a.method,
        a.provider,
        a.reference,
        a.method === "external" ? 1 : null,
        a.key,
        a.fingerprint,
        a.receivedBy,
        a.receivedAt,
        a.businessDate,
        a.origin ?? "receipt",
        a.correctsAdvanceId ?? null,
      );
  }

  findAdvanceById(id: string): AdvanceRecord | null {
    const row = this.db.prepare(`SELECT ${AD_COLS} FROM customer_advances WHERE id = ?`).get(id) as AdvanceRow | undefined;
    return row ? advance(row) : null;
  }

  findAdvanceByNumber(docNo: number): AdvanceRecord | null {
    const row = this.db.prepare(`SELECT ${AD_COLS} FROM customer_advances WHERE doc_no = ?`).get(docNo) as AdvanceRow | undefined;
    return row ? advance(row) : null;
  }

  /** True when any application or refund already uses this advance. */
  isUsed(advanceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT (EXISTS (SELECT 1 FROM advance_applications WHERE advance_id = ?)
                 OR EXISTS (SELECT 1 FROM advance_refunds WHERE advance_id = ?)) AS used`,
      )
      .get(advanceId, advanceId) as { used: bigint | number };
    return Number(row.used) === 1;
  }

  /** Display names for a document: the customer's and an operator's (null when the row is gone). */
  names(customerId: string, operatorId: string): { readonly customer: string | null; readonly operator: string | null } {
    const c = this.db.prepare("SELECT display_name AS n FROM parties WHERE id = ?").get(customerId) as { n: string } | undefined;
    const o = this.db.prepare("SELECT name AS n FROM operators WHERE id = ?").get(operatorId) as { n: string } | undefined;
    return { customer: c?.n ?? null, operator: o?.n ?? null };
  }

  /** Do two references normalise to the same registry key? (migration 19's own normalisation, in SQL) */
  sameReferenceKey(a: string, b: string): boolean {
    const row = this.db.prepare(`SELECT (${M19_REF_KEY("@a")} = ${M19_REF_KEY("@b")}) AS same`).get({ a, b }) as {
      same: bigint | number;
    };
    return Number(row.same) === 1;
  }

  // ── Corrections (migration 20, G2) ───────────────────────────────────────────────────────────

  /** MUST be written BEFORE the successor advance, in the same transaction (the trigger requires it). */
  insertCorrection(c: AdvanceCorrectionRecord): void {
    this.db
      .prepare(`INSERT INTO advance_corrections (${CO_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        c.id,
        c.advanceId,
        c.kind,
        c.successorAdvanceId,
        c.fundsNotReceived ? 1 : null,
        c.reason,
        c.correctedBy,
        c.correctedAt,
        c.businessDate,
        c.key,
        c.fingerprint,
      );
  }

  findCorrectionByKey(key: string): AdvanceCorrectionRecord | null {
    const row = this.db.prepare(`SELECT ${CO_COLS} FROM advance_corrections WHERE idempotency_key = ?`).get(key) as
      | CorrectionRow
      | undefined;
    return row ? correction(row) : null;
  }

  findCorrectionOf(advanceId: string): AdvanceCorrectionRecord | null {
    const row = this.db.prepare(`SELECT ${CO_COLS} FROM advance_corrections WHERE advance_id = ?`).get(advanceId) as
      | CorrectionRow
      | undefined;
    return row ? correction(row) : null;
  }

  /**
   * The advances part of one day's money, per method. A receipt counts on ITS business day; a
   * correction counts on the CORRECTION's business day as − original + successor — so a successor is
   * never a second receipt of the same money (a pure re-link nets to 0).
   */
  dayMoney(businessDate: string): AdvanceDayMoney[] {
    const rows = this.db
      .prepare(
        `WITH m(method) AS (VALUES ('cash'), ('external')),
              rec AS (SELECT method, sum(amount_minor) AS v FROM customer_advances
                       WHERE origin = 'receipt' AND business_date = ? GROUP BY method),
              cor AS (SELECT o.method AS method, -o.amount_minor AS v
                        FROM advance_corrections AS c JOIN customer_advances AS o ON o.id = c.advance_id
                       WHERE c.business_date = ?
                      UNION ALL
                      SELECT s.method AS method, s.amount_minor AS v
                        FROM advance_corrections AS c JOIN customer_advances AS s ON s.id = c.successor_advance_id
                       WHERE c.business_date = ?)
         SELECT m.method AS method,
                coalesce((SELECT v FROM rec WHERE rec.method = m.method), 0) AS received,
                coalesce((SELECT sum(v) FROM cor WHERE cor.method = m.method), 0) AS correction
           FROM m ORDER BY m.method`,
      )
      .all(businessDate, businessDate, businessDate) as { method: string; received: bigint | number; correction: bigint | number }[];
    return rows.map((r) => ({
      method: r.method as AdvanceDayMoney["method"],
      receivedMinor: minor(r.received),
      correctionMinor: minor(r.correction),
    }));
  }

  findAdvanceByKey(key: string): AdvanceRecord | null {
    const row = this.db.prepare(`SELECT ${AD_COLS} FROM customer_advances WHERE idempotency_key = ?`).get(key) as AdvanceRow | undefined;
    return row ? advance(row) : null;
  }

  listAdvances(customerId: string): AdvanceRecord[] {
    return (
      this.db.prepare(`SELECT ${AD_COLS} FROM customer_advances WHERE customer_id = ? ORDER BY doc_no`).all(customerId) as AdvanceRow[]
    ).map(advance);
  }

  /** amount − Σ applications − Σ refunds, per advance (migration 19's own definition); 0 once corrected. */
  unusedMinor(advanceId: string): bigint {
    const row = this.db
      .prepare(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM advance_corrections WHERE advance_id = a.id) THEN 0
                ELSE a.amount_minor
                - coalesce((SELECT sum(amount_minor) FROM advance_applications WHERE advance_id = a.id), 0)
                - coalesce((SELECT sum(amount_minor) FROM advance_refunds WHERE advance_id = a.id), 0) END AS unused
           FROM customer_advances AS a WHERE a.id = ?`,
      )
      .get(advanceId) as { unused: bigint | number } | undefined;
    return row ? minor(row.unused) : 0n;
  }

  // ── DEC-35x: applying an advance to an existing debt ─────────────────────────────────────────────

  /** The application row. Its settlement is written FIRST, in the same transaction (M19 trigger). */
  insertApplication(a: { id: string; advanceId: string; settlementId: string; amountMinor: bigint; key: string; appliedBy: string; appliedAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO advance_applications (id, advance_id, settlement_id, amount_minor, idempotency_key, applied_by, applied_at)
         VALUES (@id, @advanceId, @settlementId, @amountMinor, @key, @appliedBy, @appliedAt)`,
      )
      .run(a);
  }

  findApplicationByKey(key: string): AdvanceApplicationRecord | null {
    const row = this.db.prepare(`${APP_SELECT} WHERE aa.idempotency_key = ?`).get(key) as ApplicationRow | undefined;
    return row ? application(row) : null;
  }

  listApplications(advanceId: string): AdvanceApplicationRecord[] {
    return (this.db.prepare(`${APP_SELECT} WHERE aa.advance_id = ? ORDER BY aa.applied_at, aa.id`).all(advanceId) as ApplicationRow[]).map(application);
  }

  /** For a statement: which of these settlements were paid FROM an advance (display only — not money). */
  advancesOfSettlements(settlementIds: ReadonlyArray<string>): Map<string, { advanceId: string; docNo: number }> {
    const out = new Map<string, { advanceId: string; docNo: number }>();
    if (settlementIds.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT aa.settlement_id AS s, a.id AS a, a.doc_no AS n FROM advance_applications AS aa
         JOIN customer_advances AS a ON a.id = aa.advance_id WHERE aa.settlement_id = ?`,
    );
    for (const id of settlementIds) {
      const row = stmt.get(id) as { s: string; a: string; n: bigint | number } | undefined;
      if (row) out.set(row.s, { advanceId: row.a, docNo: Number(row.n) });
    }
    return out;
  }

  /** A debt raised by a sale that was later voided owes nothing usable: never apply money to it. */
  obligationSaleVoided(obligationId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM obligations AS o JOIN voids AS v ON v.sale_id = o.sale_id WHERE o.id = ?) AS v`,
      )
      .get(obligationId) as { v: bigint | number };
    return Number(row.v) === 1;
  }
}

export interface AdvanceApplicationRecord {
  readonly id: string;
  readonly advanceId: string;
  readonly settlementId: string;
  readonly obligationId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly key: string;
  /** The settlement's request fingerprint: a replay must carry the same advance, debt and amount. */
  readonly fingerprint: string;
  readonly appliedBy: string;
  readonly appliedAt: string;
  readonly businessDate: string;
}

interface ApplicationRow {
  id: string;
  advance_id: string;
  settlement_id: string;
  obligation_id: string;
  currency: string;
  amount_minor: bigint | number;
  idempotency_key: string;
  request_fingerprint: string;
  applied_by: string;
  applied_at: string;
  business_date: string;
}

const APP_SELECT = `SELECT aa.id, aa.advance_id, aa.settlement_id, s.obligation_id, s.currency, aa.amount_minor,
       aa.idempotency_key, s.request_fingerprint, aa.applied_by, aa.applied_at, s.business_date
  FROM advance_applications AS aa JOIN settlements AS s ON s.id = aa.settlement_id`;

function application(r: ApplicationRow): AdvanceApplicationRecord {
  return {
    id: r.id,
    advanceId: r.advance_id,
    settlementId: r.settlement_id,
    obligationId: r.obligation_id,
    currency: r.currency,
    amountMinor: typeof r.amount_minor === "bigint" ? r.amount_minor : BigInt(r.amount_minor),
    key: r.idempotency_key,
    fingerprint: r.request_fingerprint,
    appliedBy: r.applied_by,
    appliedAt: r.applied_at,
    businessDate: r.business_date,
  };
}
