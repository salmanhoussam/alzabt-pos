/**
 * The screen-side arithmetic of the shared-receipt form, as a pure module so it can be tested with
 * exact figures. It is an AID: it tells the owner when the shares are complete and enables Confirm.
 * It decides nothing — main re-validates every rule and the database seals the receipt (migration 18).
 *
 * Everything is BIGINT minor units, parsed by the domain's own `parseDecimal`. No float is involved.
 */
import { parseDecimal } from "../../domain/money";
import type { AllocatedReceiptRequest, CustomerStatementDto } from "../../shared/ipcContract";

/** Currencies with at least TWO open debts — the only ones a shared receipt can name. Sorted. */
export function sharableCurrencies(statement: Pick<CustomerStatementDto, "obligations">): string[] {
  const counts = new Map<string, number>();
  for (const o of statement.obligations) {
    if (!o.fullyPaid) counts.set(o.outstanding.currency, (counts.get(o.outstanding.currency) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([cur]) => cur)
    .sort();
}

/** Minor units of a typed amount, or null when it is empty or not a plain decimal in this currency. */
export function minorOf(text: string, currency: string): bigint | null {
  if (text.trim() === "") return null;
  try {
    return parseDecimal(text.trim(), currency).minor;
  } catch {
    return null;
  }
}

export interface AllocationState {
  readonly total: bigint | null;
  /** Only the shares the owner actually typed, in the order given. */
  readonly typed: ReadonlyArray<{ readonly id: string; readonly minor: bigint | null }>;
  readonly sum: bigint;
  /** total − sum, or null while the total is not a valid amount. */
  readonly left: bigint | null;
  /** True only when the request would be exactly allocated across at least two debts. */
  readonly complete: boolean;
}

export function allocationState(
  currency: string,
  totalText: string,
  shares: ReadonlyArray<{ readonly id: string; readonly text: string }>,
): AllocationState {
  const total = minorOf(totalText, currency);
  const typed = shares.filter((s) => s.text.trim() !== "").map((s) => ({ id: s.id, minor: minorOf(s.text, currency) }));
  const allValid = typed.every((s) => s.minor !== null && s.minor > 0n);
  const sum = typed.reduce((acc, s) => acc + (s.minor ?? 0n), 0n);
  const left = total === null ? null : total - sum;
  const complete = total !== null && total > 0n && allValid && typed.length >= 2 && left === 0n;
  return { total, typed, sum, left, complete };
}

/** What the LEDGER says about one receipt attempt. `absent` is NOT an answer: it is the lack of one. */
export type ReceiptReconciliation = "recorded" | "not_recorded" | "conflict" | "unknown" | "absent";

/**
 * Reconciles ONE receipt attempt against a statement the ledger just returned, using only that statement.
 * Pure, so it can be tested with exact figures; it never sends anything.
 *
 *   null statement                  → "unknown": the lookup itself failed, which is never "not recorded";
 *   an OPEN attempt under the key   → the ledger's own status for it — but ONLY if the attempt's stored intent
 *     is exactly this request (same provider, reference, currency, total and shares). A key that exists with a
 *     different intent is a mismatch and fails closed as "conflict";
 *   no open attempt, but the receipt is IN THE LEDGER, is exactly this one, AND was recorded under THIS ORIGINAL
 *     KEY → "recorded". A resolved attempt leaves the open-attempt list, so its absence proves nothing by itself;
 *     what proves it is a receipt carrying the same idempotency key, provider, reference (unique in the ledger),
 *     total, and exactly the requested shares on exactly the requested debts and no others. A receipt with
 *     identical details under ANOTHER key is a different payment and is never evidence for this one;
 *   otherwise                       → "absent": no evidence either way. It is never read as "not recorded".
 */
export function reconcileReceiptOutcome(
  statement: CustomerStatementDto | null,
  key: string,
  request: Pick<AllocatedReceiptRequest, "channel" | "reference" | "currency" | "totalMinor" | "allocations">,
): ReceiptReconciliation {
  if (statement === null) return "unknown";
  const sameShares = (have: ReadonlyArray<{ obligationId: string; minor: string }>): boolean => {
    if (have.length !== request.allocations.length) return false;
    const want = request.allocations.map((a) => `${a.obligationId}:${a.amountMinor}`).sort();
    const got = have.map((a) => `${a.obligationId}:${a.minor}`).sort();
    return want.every((v, i) => v === got[i]);
  };
  const open = statement.pendingReceipts.find((p) => p.idempotencyKey === key);
  if (open) {
    const intentMatches =
      open.provider === request.channel &&
      open.reference === request.reference &&
      open.total.currency === request.currency &&
      open.total.minor === request.totalMinor &&
      sameShares(open.allocations.map((a) => ({ obligationId: a.obligationId, minor: a.amount.minor })));
    // a status is only evidence about THIS request when the stored intent IS this request; otherwise fail closed
    return intentMatches ? open.status : "conflict";
  }
  const ids = new Set<string>();
  const shares: Array<{ obligationId: string; minor: string }> = [];
  for (const o of statement.obligations) {
    for (const st of o.settlements) {
      const r = st.receipt;
      if (
        r !== null &&
        r.idempotencyKey === key &&
        r.provider === request.channel &&
        r.reference === request.reference &&
        r.total.currency === request.currency &&
        r.total.minor === request.totalMinor
      ) {
        ids.add(r.id);
        shares.push({ obligationId: o.id, minor: st.amount.minor });
      }
    }
  }
  if (ids.size !== 1) return "absent";
  return sameShares(shares) ? "recorded" : "absent";
}
