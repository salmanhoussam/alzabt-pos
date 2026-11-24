/**
 * TILL-PRINT (owner decisions D-TP1/D-TP2/D-TP3, DEC-35zz++) — ONE read model of a till receipt, from the ledger by
 * sale id, used by the on-screen receipt (completion + History), the PDF and the print. So the three can never
 * disagree: every figure is a fact recorded with the sale.
 *
 * 🔴 HISTORICAL FACTS, NEVER LIVE BALANCES (F4). The customer is the name SNAPSHOT taken at sale time; the amount
 *    left on account is the sale's own balance due minus the advance applied IN THE SAME TRANSACTION. A later
 *    collection or application to that debt does not change a reprint.
 * 🔴 WHO (D-TP2): the owner may read any sale; anyone else only a sale they can already see in History (the same
 *    latest-N window, the same order). Re-read from the live session on every call — never from the screen.
 * 🔴 READ-ONLY. Printing or reprinting writes nothing.
 */
import { DomainError } from "../domain/errors";
import type { SaleRecord, VoidRecord } from "../domain/sale";
import type { SaleReceiptRepository } from "../persistence/saleReceiptRepository";

export interface SaleReceiptView {
  readonly sale: SaleRecord;
  readonly void: VoidRecord | null;
  /** The customer named on the sale at the moment it was recorded (null for an ordinary sale). */
  readonly customerName: string | null;
  /** The advance applied WITH this sale, and what stayed on account at that moment (null otherwise). */
  readonly advanceAtSale: { readonly number: string; readonly appliedMinor: bigint; readonly leftOnAccountMinor: bigint } | null;
}

export interface SaleReceiptServiceDeps {
  readonly reads: SaleReceiptRepository;
  readonly getSale: (saleId: string) => { readonly sale: SaleRecord; readonly void: VoidRecord | null };
  /** The live role, re-read on every call; null when nobody is signed in. */
  readonly role: () => "owner" | "admin" | "cashier" | null;
  /** History's window (posService MAX_HISTORY). */
  readonly historyWindow: number;
  readonly formatAdvanceNo: (docNo: number) => string;
}

export class SaleReceiptService {
  constructor(private readonly deps: SaleReceiptServiceDeps) {}

  receipt(saleId: unknown): SaleReceiptView {
    const role = this.deps.role();
    if (!role) throw new DomainError("NOT_LOGGED_IN", "Sign in first");
    if (typeof saleId !== "string" || saleId.length === 0 || saleId.length > 64) throw new DomainError("INVALID_INPUT", "A sale id is required");
    if (!this.deps.reads.exists(saleId)) throw new DomainError("SALE_NOT_FOUND", "Sale not found");
    if (role !== "owner" && !this.deps.reads.withinHistory(saleId, this.deps.historyWindow)) {
      throw new DomainError("NOT_AUTHORIZED", "That sale is outside what this account may see");
    }
    const { sale, void: v } = this.deps.getSale(saleId);
    const adv = this.deps.reads.advanceAtSale(saleId);
    return {
      sale,
      void: v,
      customerName: sale.customerNameSnapshot,
      advanceAtSale: adv
        ? { number: this.deps.formatAdvanceNo(adv.docNo), appliedMinor: adv.amountMinor, leftOnAccountMinor: sale.balanceDue.minor - adv.amountMinor }
        : null,
    };
  }
}
