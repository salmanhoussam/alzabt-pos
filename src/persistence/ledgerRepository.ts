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
  readonly settled_by: string;
  readonly settled_at: string;
  readonly business_date: string;
}

const O_COLS = `id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency,
                amount_minor, posted_by, posted_at, business_date`;
const S_COLS = `id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor,
                method, settled_by, settled_at, business_date`;

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
  readonly settledBy: string;
  readonly settledAt: string;
  readonly businessDate: string;
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
                 @method, @settledBy, @settledAt, @businessDate)`,
      )
      .run(s);
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
