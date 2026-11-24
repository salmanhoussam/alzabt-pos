/**
 * INV-PARTIAL-DEBT · HISTORIC AUDIT (owner, DEC-35h §1) — READ-ONLY.
 *
 * Lists FINAL invoices that still show an amount to pay (balance_due > 0) but have NO customer
 * receivable recorded against their sale. Before Option B a part-paid invoice could be issued with
 * its remainder untracked, and an ordinary unpaid invoice never creates a debt by design — both
 * appear here, labelled, so the owner can decide case by case.
 *
 * 🔴 IT NEVER WRITES. It does not create, change or "repair" any invoice, sale or debt: inventing a
 * debt from an old document would state something the shop never recorded. Open the ledger
 * read-only:
 *
 *   npx tsx scripts/untrackedInvoiceBalances.ts <path-to-alzabt-pos-ledger.sqlite>
 */
import Database from "better-sqlite3";

export interface UntrackedInvoiceBalance {
  readonly invoiceNumber: number;
  readonly invoiceDate: string | null;
  readonly customerName: string | null;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly balanceDueMinor: bigint;
  /** "partial" — something was paid and the rest is untracked; "unpaid" — nothing was paid. */
  readonly kind: "partial" | "unpaid";
}

export function listUntrackedInvoiceBalances(db: Database.Database): UntrackedInvoiceBalance[] {
  const rows = db
    .prepare(
      `SELECT i.invoice_number AS num, i.invoice_date AS date, i.customer_name AS name, i.currency AS cur,
              i.total_minor AS total, i.paid_minor AS paid, i.balance_due_minor AS balance
         FROM invoices i
         JOIN sales s ON s.invoice_id = i.id
        WHERE i.status = 'final'
          AND i.balance_due_minor > 0
          AND NOT EXISTS (SELECT 1 FROM obligations o WHERE o.sale_id = s.id AND o.direction = 'receivable')
        ORDER BY i.invoice_number`,
    )
    .safeIntegers(true)
    .all() as Array<{ num: bigint; date: string | null; name: string | null; cur: string; total: bigint; paid: bigint; balance: bigint }>;
  return rows.map((r) => ({
    invoiceNumber: Number(r.num),
    invoiceDate: r.date,
    customerName: r.name,
    currency: r.cur,
    totalMinor: r.total,
    paidMinor: r.paid,
    balanceDueMinor: r.balance,
    kind: r.paid > 0n ? "partial" : "unpaid",
  }));
}

const isMain = typeof process !== "undefined" && process.argv[1] !== undefined && /untrackedInvoiceBalances\.ts$/.test(process.argv[1]);
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: npx tsx scripts/untrackedInvoiceBalances.ts <ledger.sqlite>");
    process.exit(2);
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const list = listUntrackedInvoiceBalances(db);
    for (const r of list) {
      console.log([r.invoiceNumber, r.invoiceDate ?? "", r.kind, r.currency, r.totalMinor, r.paidMinor, r.balanceDueMinor, r.customerName ?? ""].join("\t"));
    }
    console.log(`untracked balances: ${list.length} (partial ${list.filter((r) => r.kind === "partial").length}, unpaid ${list.filter((r) => r.kind === "unpaid").length}) — read-only, nothing changed`);
  } finally {
    db.close();
  }
}
