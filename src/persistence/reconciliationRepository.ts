/**
 * The catalog review queue — SQL only.
 *
 * 🔴 THIS IS OPERATIONAL STATE, NOT A LEDGER, and that is why its rows are UPDATED as a person
 * works through them. The durable, immutable record of what actually changed in the catalog lives
 * in `audit_events` (migration 5), written by `PosService` inside the same transaction as the
 * product mutation. This table records the DECISION and its outcome; it is not the audit trail and
 * must never be read as one.
 *
 * 🔴 AND A DECISION HERE NEVER TOUCHES THE INVOICE IT CAME FROM. The finalized invoice and its
 * lines are immutable by trigger. Resolving a line means recording what was decided about the
 * CATALOG, including the product this line turned out to refer to — `matched_product_id` — rather
 * than rewriting the document.
 *
 * No transaction of its own: the service composes these calls.
 */
import type { Db } from "./db";

export interface ReconciliationRow {
  readonly id: string;
  readonly invoice_id: string;
  readonly invoice_line_id: string;
  readonly classification: string;
  readonly match_tier: string;
  readonly matched_product_id: string | null;
  readonly candidates_json: string | null;
  readonly differences_json: string;
  readonly status: string;
  readonly selected_fields_json: string | null;
  readonly resolved_at: string | null;
  readonly resolution_actor_id: string | null;
  readonly resolution_actor_name: string | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly attempt_count: bigint;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One classified line, as finalization produces it. */
export interface NewReconciliation {
  readonly invoiceId: string;
  readonly invoiceLineId: string;
  readonly classification: string;
  readonly matchTier: string;
  readonly matchedProductId: string | null;
  /**
   * The catalog rows OBSERVED at reconciliation time, matched product first.
   *
   * 🔴 This is the snapshot of "what the catalog said when we looked", and it is deliberately kept
   * even for a MATCHED line, where `differences_json` is empty and would otherwise record nothing.
   * A review opened six weeks later can then show the values that were compared, not the values the
   * catalog happens to hold that day.
   */
  readonly candidatesJson: string | null;
  readonly differencesJson: string;
  readonly status: string;
  readonly resolvedAt: string | null;
  readonly resolutionActorId: string | null;
  readonly resolutionActorName: string | null;
}

const COLUMNS = `id, invoice_id, invoice_line_id, classification, match_tier, matched_product_id,
  candidates_json, differences_json, status, selected_fields_json, resolved_at,
  resolution_actor_id, resolution_actor_name, failure_code, failure_message, attempt_count,
  created_at, updated_at`;

export class ReconciliationRepository {
  constructor(private readonly db: Db) {}

  insert(id: string, input: NewReconciliation, now: Date): ReconciliationRow {
    const stamp = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO invoice_reconciliation (${COLUMNS})
         VALUES (@id, @invoiceId, @invoiceLineId, @classification, @matchTier, @matchedProductId,
                 @candidatesJson, @differencesJson, @status, NULL, @resolvedAt,
                 @resolutionActorId, @resolutionActorName, NULL, NULL, 0, @now, @now)`,
      )
      .run({
        id,
        invoiceId: input.invoiceId,
        invoiceLineId: input.invoiceLineId,
        classification: input.classification,
        matchTier: input.matchTier,
        matchedProductId: input.matchedProductId,
        candidatesJson: input.candidatesJson,
        differencesJson: input.differencesJson,
        status: input.status,
        resolvedAt: input.resolvedAt,
        resolutionActorId: input.resolutionActorId,
        resolutionActorName: input.resolutionActorName,
        now: stamp,
      });
    return this.requireById(id);
  }

  findById(id: string): ReconciliationRow | null {
    return (
      (this.db.prepare(`SELECT ${COLUMNS} FROM invoice_reconciliation WHERE id = ?`).get(id) as
        | ReconciliationRow
        | undefined) ?? null
    );
  }

  requireById(id: string): ReconciliationRow {
    const row = this.findById(id);
    if (!row) throw new Error(`reconciliation: no item '${id}'`);
    return row;
  }

  listForInvoice(invoiceId: string): ReconciliationRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM invoice_reconciliation WHERE invoice_id = ? ORDER BY created_at, id`)
      .all(invoiceId) as ReconciliationRow[];
  }

  /** The work queue: everything a person still has to decide, oldest first. */
  listUnresolved(limit = 200): ReconciliationRow[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM invoice_reconciliation
          WHERE status IN ('PENDING', 'FAILED') ORDER BY created_at, id LIMIT ?`,
      )
      .all(limit) as ReconciliationRow[];
  }

  countUnresolved(): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM invoice_reconciliation WHERE status IN ('PENDING', 'FAILED')",
      )
      .get() as { n: bigint };
    return Number(row.n);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, count(*) AS n FROM invoice_reconciliation GROUP BY status")
      .all() as Array<{ status: string; n: bigint }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  /** Increments the attempt counter. Called before a resolution is tried, so a failure still counts. */
  recordAttempt(id: string, now: Date): ReconciliationRow {
    this.db
      .prepare(
        "UPDATE invoice_reconciliation SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(now.toISOString(), id);
    return this.requireById(id);
  }

  /**
   * Records a successful decision. `failure_code`/`failure_message` are cleared, because a retry
   * that succeeded must not keep showing the message from the attempt that did not.
   */
  resolve(
    id: string,
    input: {
      readonly status: string;
      readonly matchedProductId: string | null;
      readonly selectedFieldsJson: string | null;
      readonly actorId: string;
      readonly actorName: string;
    },
    now: Date,
  ): ReconciliationRow {
    const stamp = now.toISOString();
    this.db
      .prepare(
        `UPDATE invoice_reconciliation
            SET status = @status, matched_product_id = @matchedProductId,
                selected_fields_json = @selectedFieldsJson, resolved_at = @now,
                resolution_actor_id = @actorId, resolution_actor_name = @actorName,
                failure_code = NULL, failure_message = NULL, updated_at = @now
          WHERE id = @id`,
      )
      .run({
        id,
        status: input.status,
        matchedProductId: input.matchedProductId,
        selectedFieldsJson: input.selectedFieldsJson,
        actorId: input.actorId,
        actorName: input.actorName,
        now: stamp,
      });
    return this.requireById(id);
  }

  /**
   * Records a failed attempt. The item stays in the unresolved queue and keeps WHY, so the person
   * who retries it is told what went wrong rather than guessing.
   */
  fail(id: string, code: string, message: string, now: Date): ReconciliationRow {
    const stamp = now.toISOString();
    this.db
      .prepare(
        `UPDATE invoice_reconciliation
            SET status = 'FAILED', failure_code = @code, failure_message = @message,
                resolved_at = NULL, resolution_actor_id = NULL, resolution_actor_name = NULL,
                updated_at = @now
          WHERE id = @id`,
      )
      .run({ id, code, message: message.slice(0, 500), now: stamp });
    return this.requireById(id);
  }
}
