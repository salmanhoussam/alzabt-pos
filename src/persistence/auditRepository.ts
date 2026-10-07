/**
 * The durable audit trail's one writer.
 *
 * 🔴 IT HAS NO TRANSACTION OF ITS OWN, AND THAT IS THE POINT. `append` must run inside the caller's
 * transaction — the same `BEGIN IMMEDIATE` that carries the business mutation — so that the two
 * commit together or not at all. If this class opened its own transaction, or used its own
 * connection, atomicity would be orchestration by convention instead of real SQLite atomicity. It
 * therefore takes the SAME `Db` handle the business repositories use; there is no second connection
 * anywhere.
 *
 * `seq` is allocated here as max(seq)+1, read inside that transaction — the identical pattern
 * `SaleRepository.nextReceiptNumber()` uses for receipt numbers, and safe for the same reason: one
 * writer, one PC, BEGIN IMMEDIATE.
 */
import { type AuditDraft, type AuditRow, buildAuditRow } from "../domain/audit";
import type { Db } from "./db";

export interface AuditContext {
  /** The build that wrote the row, so a later reader knows which conventions applied. */
  readonly appVersion: string;
  readonly schemaVersion: number;
}

export class AuditRepository {
  constructor(
    private readonly db: Db,
    private readonly context: AuditContext,
  ) {}

  /**
   * Validates the draft (fail closed — see src/domain/audit.ts) and inserts exactly one row.
   * Throws if the draft breaches the contract, which rolls back the caller's transaction.
   */
  append(draft: AuditDraft, id: string): AuditRow {
    const row = buildAuditRow(draft, {
      id,
      seq: this.nextSeq(),
      appVersion: this.context.appVersion,
      schemaVersion: this.context.schemaVersion,
    });
    this.db
      .prepare(
        `INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id, actor_name,
                                   actor_tier, occurred_at, business_date, changed_json, metadata_json,
                                   app_version, schema_version)
         VALUES (@id, @seq, @event_type, @entity_type, @entity_id, @actor_id, @actor_name,
                 @actor_tier, @occurred_at, @business_date, @changed_json, @metadata_json,
                 @app_version, @schema_version)`,
      )
      .run(row);
    return row;
  }

  private nextSeq(): number {
    const row = this.db.prepare("SELECT max(seq) AS n FROM audit_events").get() as { n: bigint | null };
    return Number(row.n ?? 0n) + 1;
  }

  // ── Read-only ───────────────────────────────────────────────────────────────────────────────────
  //
  // There is no audit screen yet; these exist so that tests and the installed-app E2E can read the
  // real trail back out of the real ledger rather than trusting what the writer said it wrote.

  /** Newest first. */
  listRecent(limit = 100): AuditRow[] {
    return this.db
      .prepare(`SELECT * FROM audit_events ORDER BY seq DESC LIMIT ?`)
      .all(Math.max(1, Math.trunc(limit)))
      .map(toRow);
  }

  /** One entity's whole history, newest first. */
  listForEntity(entityType: string, entityId: string, limit = 100): AuditRow[] {
    return this.db
      .prepare(
        `SELECT * FROM audit_events
          WHERE entity_type = ? AND entity_id = ?
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(entityType, entityId, Math.max(1, Math.trunc(limit)))
      .map(toRow);
  }

  count(): number {
    const row = this.db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: bigint };
    return Number(row.n);
  }

  countByType(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT event_type, count(*) AS n FROM audit_events GROUP BY event_type")
      .all() as Array<{ event_type: string; n: bigint }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.event_type] = Number(r.n);
    return out;
  }
}

/** The connection reads every INTEGER as a bigint; `seq` and `schema_version` are counts, not money. */
function toRow(raw: unknown): AuditRow {
  const r = raw as Record<string, unknown>;
  return {
    ...(r as unknown as AuditRow),
    seq: Number(r.seq),
    schema_version: Number(r.schema_version),
  };
}
