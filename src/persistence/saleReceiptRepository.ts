/**
 * TILL-PRINT — the facts a printed or reprinted till receipt needs that the sale row itself does not carry.
 * SQL only, READ-ONLY. Every value is a fact OF THE SALE (fixed when it was recorded), never a live balance.
 */
import type { Db } from "./db";

export class SaleReceiptRepository {
  constructor(private readonly db: Db) {}

  exists(saleId: string): boolean {
    return this.db.prepare("SELECT 1 FROM sales WHERE id = ?").get(saleId) !== undefined;
  }

  /** Is this sale among the latest `limit` sales — the SAME window and order History shows (listSales)? */
  withinHistory(saleId: string, limit: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM (SELECT id FROM sales ORDER BY receipt_number DESC LIMIT ?) WHERE id = ?")
        .get(limit, saleId) !== undefined
    );
  }

  /**
   * The advance applied WITH this sale (sell on advance: the application key is `<sale key>-adv`, written in the
   * sale's own transaction). A later application to the same debt is NOT a fact of the sale and is never returned.
   */
  advanceAtSale(saleId: string): { readonly docNo: number; readonly amountMinor: bigint } | null {
    const row = this.db
      .prepare(
        `SELECT a.doc_no AS n, aa.amount_minor AS m
           FROM sales AS s
           JOIN advance_applications AS aa ON aa.idempotency_key = s.idempotency_key || '-adv'
           JOIN customer_advances AS a ON a.id = aa.advance_id
          WHERE s.id = ?`,
      )
      .get(saleId) as { n: bigint | number; m: bigint | number } | undefined;
    if (!row) return null;
    return { docNo: Number(row.n), amountMinor: typeof row.m === "bigint" ? row.m : BigInt(row.m) };
  }
}
