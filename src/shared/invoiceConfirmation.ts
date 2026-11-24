/**
 * R5 (Abu Abbas, R4 review F3 + R5 contract invariant 3/4): the ONE description of what an issue confirmation
 * confirms — the complete material draft, as one exact, comparable string.
 *
 * 🔴 WHY THE WHOLE DRAFT. R3/R4 bound the issue to the totals, paid, balance, customer and account choice. With two
 * zero-value rows, deleting one changed what the confirmation showed («Rows 2» → «1») without changing any of those,
 * and the old confirmation issued. Every line's identity, order and content is now part of it, and so is every header
 * field that is printed on the immutable document. A same-total substitution, a zero-value deletion and an equal-count
 * edit all change this string.
 *
 * 🔴 WHY SHARED. The renderer computes it from the view it SHOWED; the service computes it again from the persisted
 * draft INSIDE the finalize transaction (`invoiceService.finalizeWithin`) and refuses on any difference. Both sides run
 * this exact function over the same DTO conversion (`toInvoiceViewDto`), so there is nothing to keep in sync by hand.
 *
 * Exact minor-unit strings and raw stored values only: nothing is rounded, formatted or translated. Volatile fields
 * that are not part of the document's content (`updatedAt`, `status`, `payment`) are deliberately left out.
 */
import type { InvoiceViewDto } from "./ipcContract";

export function confirmationDigest(view: InvoiceViewDto, onAccount: boolean): string {
  const inv = view.invoice;
  const tax = inv.taxSnapshot;
  return JSON.stringify({
    v: 1,
    id: inv.id,
    currency: inv.currency,
    invoiceDate: inv.invoiceDate ?? null,
    customer: [inv.customerPartyId ?? null, inv.customerName ?? null, inv.customerAddress ?? null, inv.customerPhone ?? null],
    notes: inv.notes ?? null,
    tax: tax ? [tax.enabled, tax.rateBasisPoints, tax.label ?? null] : null,
    money: [inv.subtotal.minor, inv.tax.minor, inv.total.minor, inv.paid.minor, inv.balanceDue.minor],
    onAccount,
    rows: view.lines.length,
    lines: view.lines.map((l) => [
      l.id,
      l.lineNo,
      l.description ?? null,
      l.productId ?? null,
      l.quantityMilli,
      l.unitLabel ?? null,
      l.canonicalUnit ?? null,
      l.unitPrice.currency,
      l.unitPrice.minor,
      l.lineTotal.minor,
    ]),
  });
}

/** The longest digest the IPC boundary accepts — generous for any real invoice, and a bound on a malformed one. */
export const CONFIRMATION_DIGEST_MAX = 2_000_000;
