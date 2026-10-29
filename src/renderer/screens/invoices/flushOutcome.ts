/**
 * Whether a failed invoice-row write is KNOWN to have written nothing.
 *
 * `addInvoiceLines` carries a persisted batch key (migration 15), so the answer no longer decides
 * whether re-sending is safe — re-sending under the SAME key always is. It only decides whether the
 * frozen batch and its key may be dropped:
 *
 *   - "refused": the service refused inside its transaction, which rolled back. Nothing exists under
 *     the key; the next flush starts a fresh batch.
 *   - "uncertain": the answer is missing or untrustworthy (an unexpected fault, a lost IPC, a damaged
 *     record, a key conflict). The batch may or may not be recorded, so it is kept and re-sent as is.
 *
 * No line count or content is ever compared; the ledger's own record of the key is the only evidence.
 */
import { ApiError } from "../../api";

/** Codes that are NOT a clean rollback guarantee for this batch. */
const NOT_A_CLEAN_REFUSAL = new Set(["INTERNAL", "LEDGER_INTEGRITY", "IDEMPOTENCY_CONFLICT"]);

export type FailureKind = "refused" | "uncertain";

export function classifyFlushFailure(err: unknown): FailureKind {
  if (err instanceof ApiError && !NOT_A_CLEAN_REFUSAL.has(err.code)) return "refused";
  return "uncertain";
}
