/**
 * The `obligations` and `settlements` tables. Prepared statements, no business rules.
 *
 * 🔴 WHAT THIS FILE REFUSES TO DECIDE. It does not decide who may post a debt, whether a repeat
 * submission is a retry or a second payment, or whether an amount is affordable — those are
 * business rules and they live in `ledgerService`. It exposes the lookups that service needs
 * (`findBySource`, `findByIdempotencyKey`) separately so the whole decision can be taken inside
 * ONE transaction and this file stays statements.
 *
 * 🔴 AND IT NEVER WRITES A BALANCE, because there is no balance column to write. `outstanding()`
 * in `src/domain/ledger.ts` is the only definition, computed from the rows every time.
 *
 * 🔴 NOTHING HERE UPDATES OR DELETES. Both tables forbid UPDATE and DELETE by trigger (migration
 * 13), so there is deliberately no update method to call by accident — a correction is a new row
 * in a future slice, never a rewrite of a posted one.
 */
import type { Db } from "./db";
import type {
  ObligationDirection,
  ObligationRecord,
  ObligationSource,
  SettlementMethod,
  SettlementProvider,
  SettlementRecord,
} from "../domain/ledger";

interface ObligationRow {
  readonly id: string;
  readonly party_id: string;
  readonly party_kind: string;
  readonly direction: string;
  readonly source_kind: string;
  readonly source_ref: string;
  readonly sale_id: string | null;
  readonly currency: string;
  readonly amount_minor: bigint | number;
  readonly posted_by: string;
  readonly posted_at: string;
  readonly business_date: string;
}

interface SettlementRow {
  readonly id: string;
  readonly obligation_id: string;
  readonly currency: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly amount_minor: bigint | number;
  readonly method: string;
  readonly provider: string | null;
  readonly reference: string | null;
  readonly funds_confirmed: bigint | number | null;
  readonly settled_by: string;
  readonly settled_at: string;
  readonly business_date: string;
}

const O_COLS = `id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency,
                amount_minor, posted_by, posted_at, business_date`;
const S_COLS = `id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor,
                method, provider, reference, funds_confirmed, settled_by, settled_at, business_date`;

/** Minor units come back from SQLite as bigint under the safe-integer threshold or beyond it. */
const minor = (v: bigint | number): bigint => (typeof v === "bigint" ? v : BigInt(v));

function obligation(row: ObligationRow | undefined): ObligationRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    partyId: row.party_id,
    partyKind: row.party_kind as "customer" | "supplier",
    direction: row.direction as ObligationDirection,
    sourceKind: row.source_kind as ObligationSource,
    sourceRef: row.source_ref,
    saleId: row.sale_id,
    currency: row.currency,
    amountMinor: minor(row.amount_minor),
    postedBy: row.posted_by,
    postedAt: row.posted_at,
    businessDate: row.business_date,
  };
}

function settlement(row: SettlementRow | undefined): SettlementRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    obligationId: row.obligation_id,
    currency: row.currency,
    idempotencyKey: row.idempotency_key,
    amountMinor: minor(row.amount_minor),
    method: row.method as SettlementMethod,
    provider: (row.provider ?? null) as SettlementProvider | null,
    reference: row.reference ?? null,
    fundsConfirmed: row.funds_confirmed === null || row.funds_confirmed === undefined ? null : Number(row.funds_confirmed) === 1,
    settledBy: row.settled_by,
    settledAt: row.settled_at,
    businessDate: row.business_date,
  };
}

export interface NewObligation {
  readonly id: string;
  readonly partyId: string;
  readonly partyKind: "customer" | "supplier";
  readonly direction: ObligationDirection;
  readonly sourceKind: ObligationSource;
  readonly sourceRef: string;
  readonly saleId: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly postedBy: string;
  readonly postedAt: string;
  readonly businessDate: string;
}

export interface NewSettlement {
  readonly id: string;
  readonly obligationId: string;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly amountMinor: bigint;
  readonly method: SettlementMethod;
  /** Migration 17 details; absent means a plain, historical-shape settlement. */
  readonly provider?: SettlementProvider | null;
  readonly reference?: string | null;
  readonly fundsConfirmed?: boolean | null;
  readonly settledBy: string;
  readonly settledAt: string;
  readonly businessDate: string;
}

/** The durable intent of one collection (migration 17). */
export interface AttemptRecord {
  readonly key: string;
  readonly customerId: string;
  readonly obligationId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly channel: "cash" | "card" | "whish" | "bank_transfer" | "other";
  readonly reference: string | null;
  readonly fundsConfirmed: boolean | null;
  readonly fingerprint: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** A read-back attempt carries its durable terminal state, unlike a new intent being inserted. */
export interface StoredAttemptRecord extends AttemptRecord {
  readonly resolution: "recorded" | "not_recorded" | null;
}

interface AttemptRow {
  readonly idempotency_key: string;
  readonly customer_id: string;
  readonly obligation_id: string;
  readonly currency: string;
  readonly amount_minor: bigint | number;
  readonly channel: string;
  readonly reference: string | null;
  readonly funds_confirmed: bigint | number | null;
  readonly request_fingerprint: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly resolution: "recorded" | "not_recorded" | null;
}

const A_COLS = `idempotency_key, customer_id, obligation_id, currency, amount_minor, channel, reference,
                funds_confirmed, request_fingerprint, created_by, created_at, resolution`;

function attempt(row: AttemptRow): StoredAttemptRecord {
  return {
    key: row.idempotency_key,
    customerId: row.customer_id,
    obligationId: row.obligation_id,
    currency: row.currency,
    amountMinor: minor(row.amount_minor),
    channel: row.channel as AttemptRecord["channel"],
    reference: row.reference,
    fundsConfirmed: row.funds_confirmed === null ? null : Number(row.funds_confirmed) === 1,
    fingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    resolution: row.resolution,
  };
}

export class LedgerRepository {
  constructor(private readonly db: Db) {}

  insertObligation(o: NewObligation): void {
    this.db
      .prepare(
        `INSERT INTO obligations (${O_COLS})
         VALUES (@id, @partyId, @partyKind, @direction, @sourceKind, @sourceRef, @saleId, @currency,
                 @amountMinor, @postedBy, @postedAt, @businessDate)`,
      )
      .run(o);
  }

  findObligationById(id: string): ObligationRecord | null {
    return obligation(this.db.prepare(`SELECT ${O_COLS} FROM obligations WHERE id = ?`).get(id) as ObligationRow | undefined);
  }

  /**
   * The duplicate-posting lookup.
   *
   * 🔴 THE SECOND OF TWO DEFENCES, the same shape migration 7 used for a duplicate sale. The first
   * is `UNIQUE (source_kind, source_ref)` in the schema, which makes a second obligation for one
   * source impossible whatever a caller does. This one makes a repeat RECOGNISABLE before it is
   * attempted, so the service can answer "already posted" instead of surfacing a constraint error.
   */
  findObligationBySource(sourceKind: ObligationSource, ref: string): ObligationRecord | null {
    return obligation(
      this.db
        .prepare(`SELECT ${O_COLS} FROM obligations WHERE source_kind = ? AND source_ref = ?`)
        .get(sourceKind, ref) as ObligationRow | undefined,
    );
  }

  /** Every obligation of one party, scoped by direction IN THE QUERY so the two can never mix. */
  listObligations(partyId: string, direction: ObligationDirection): ObligationRecord[] {
    const rows = this.db
      .prepare(`SELECT ${O_COLS} FROM obligations WHERE party_id = ? AND direction = ? ORDER BY posted_at, id`)
      .all(partyId, direction) as ObligationRow[];
    return rows.map((r) => obligation(r) as ObligationRecord);
  }

  insertSettlement(s: NewSettlement): void {
    this.db
      .prepare(
        `INSERT INTO settlements (${S_COLS})
         VALUES (@id, @obligationId, @currency, @idempotencyKey, @requestFingerprint, @amountMinor,
                 @method, @provider, @reference, @fundsConfirmed, @settledBy, @settledAt, @businessDate)`,
      )
      .run({
        ...s,
        provider: s.provider ?? null,
        reference: s.reference ?? null,
        fundsConfirmed: s.fundsConfirmed ? 1 : null,
      });
  }

  // ── Collection attempts (migration 17) ─────────────────────────────────────────────────────────
  insertAttempt(a: AttemptRecord, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO collection_attempts (idempotency_key, customer_id, obligation_id, currency, amount_minor,
                                          channel, reference, funds_confirmed, request_fingerprint, created_by, created_at)
         VALUES (@key, @customerId, @obligationId, @currency, @amountMinor, @channel, @reference,
                 @fundsConfirmed, @fingerprint, @createdBy, @now)`,
      )
      .run({ ...a, fundsConfirmed: a.fundsConfirmed ? 1 : null, now: now.toISOString() });
  }

  findAttempt(key: string): StoredAttemptRecord | null {
    const row = this.db.prepare(`SELECT ${A_COLS} FROM collection_attempts WHERE idempotency_key = ?`).get(key) as
      | AttemptRow
      | undefined;
    return row ? attempt(row) : null;
  }

  /** Attempts for one customer that have not been closed, oldest first. */
  listOpenAttempts(customerId: string): AttemptRecord[] {
    return (
      this.db
        .prepare(`SELECT ${A_COLS} FROM collection_attempts WHERE customer_id = ? AND resolved_at IS NULL ORDER BY created_at, idempotency_key`)
        .all(customerId) as AttemptRow[]
    ).map(attempt);
  }

  /** Closes an open attempt, once. A no-op for an attempt that is missing or already closed. */
  resolveAttempt(key: string, resolution: "recorded" | "not_recorded", now: Date): void {
    this.db
      .prepare(`UPDATE collection_attempts SET resolved_at = ?, resolution = ? WHERE idempotency_key = ? AND resolved_at IS NULL`)
      .run(now.toISOString(), resolution, key);
  }

  /** Migration 17. The settlement already carrying this provider transaction reference, if any. */
  findSettlementByProviderReference(provider: string, reference: string): SettlementRecord | null {
    const row = this.db
      .prepare(`SELECT ${S_COLS} FROM settlements WHERE provider = ? AND reference = ?`)
      .get(provider, reference) as SettlementRow | undefined;
    return settlement(row);
  }

  /**
   * Collected totals for ONE business day, per currency and per way of paying. Cash, card and each
   * provider stay separate rows — a Whish receipt is never inside the cash total.
   */
  collectionTotals(businessDate: string): Array<{
    readonly currency: string;
    readonly method: SettlementMethod;
    readonly provider: SettlementProvider | null;
    readonly count: number;
    readonly totalMinor: bigint;
  }> {
    const rows = this.db
      .prepare(
        `SELECT currency, method, provider, count(*) AS n, sum(amount_minor) AS total
           FROM settlements WHERE business_date = ?
          GROUP BY currency, method, provider ORDER BY currency, method, provider`,
      )
      .all(businessDate) as Array<{
      currency: string;
      method: string;
      provider: string | null;
      n: bigint | number;
      total: bigint | number;
    }>;
    return rows.map((r) => ({
      currency: r.currency,
      method: r.method as SettlementMethod,
      provider: (r.provider ?? null) as SettlementProvider | null,
      count: Number(r.n),
      totalMinor: minor(r.total),
    }));
  }

  /**
   * The retry lookup. Returns the fingerprint alongside the row so the service can tell a genuine
   * retry (same key, same money) from a key reused for different money.
   */
  findSettlementByIdempotencyKey(key: string): { settlement: SettlementRecord; fingerprint: string } | null {
    const row = this.db.prepare(`SELECT ${S_COLS} FROM settlements WHERE idempotency_key = ?`).get(key) as
      | SettlementRow
      | undefined;
    if (!row) return null;
    return { settlement: settlement(row) as SettlementRecord, fingerprint: row.request_fingerprint };
  }

  listSettlements(obligationId: string): SettlementRecord[] {
    const rows = this.db
      .prepare(`SELECT ${S_COLS} FROM settlements WHERE obligation_id = ? ORDER BY settled_at, id`)
      .all(obligationId) as SettlementRow[];
    return rows.map((r) => settlement(r) as SettlementRecord);
  }

  /**
   * What has been paid on one obligation, as a single SUM.
   *
   * Used by the service to check an incoming settlement before the trigger would refuse it, so the
   * merchant reads a sentence rather than a constraint message. The trigger remains the authority.
   */
  settledTotal(obligationId: string): bigint {
    const row = this.db
      .prepare(`SELECT coalesce(sum(amount_minor), 0) AS paid FROM settlements WHERE obligation_id = ?`)
      .get(obligationId) as { paid: bigint | number };
    return minor(row.paid);
  }
}
