/**
 * DAILY MONEY IN / OUT — the raw rows of one business day, read straight from the ledger.
 *
 * Read-only. Every row below is one immutable ledger row (or one immutable correction) dated on the
 * requested business day, so asking for a past day twice returns the same answer forever: nothing
 * here is cached, re-dated or recomputed from "current" state.
 *
 * WHAT EACH SECTION IS (and, as importantly, what it is NOT):
 *   sale_received      the tender(s) of a sale that is NOT voided — real money at the till.
 *                      A split sale contributes one row per tender (cash + Whish), a partial sale its
 *                      paid part only; the unpaid part is debt, never money.
 *   sale_voided        the tender(s) of a VOIDED sale. Not counted as money received. Shown
 *                      separately because the POS does not know whether the money went back (a Whish
 *                      void is never an automatic refund — owner decision, DEC-35 option A).
 *   collection         money that ARRIVED against a customer debt: a direct settlement of a
 *                      receivable (receipt_id IS NULL), or a receipt (one real transfer). The
 *                      allocation rows of a receipt are NOT money (they would count it twice), and a
 *                      settlement written by an advance APPLICATION is not money either.
 *   advance_received   a customer advance whose origin is 'receipt' — money that arrived.
 *   advance_correction a correction, on the CORRECTION's day: − the original, + its successor (if
 *                      any). A pure re-link nets to 0; "not received" is − the original. Never a receipt.
 *   advance_refund     cash handed back from an advance (REF-) — money OUT.
 *   supplier_payment   a direct settlement of a PAYABLE — money OUT to a supplier.
 *   advance_applied    a settlement paid FROM an advance. Not money in, not money out: the cash came
 *                      in on the advance's own day. Shown so the owner sees the debt went down.
 */
import type Database from "better-sqlite3";
import type { DailyMoneyChannel, DailyMoneyRow, DailyMoneySection, DailySalesFigures } from "../domain/dailyMoney";

const CHANNEL = (m: string, p: string) =>
  `CASE WHEN ${m} = 'external' THEN coalesce(${p}, 'external') ELSE ${m} END`;

const minor = (v: bigint | number): bigint => (typeof v === "bigint" ? v : BigInt(v));

export class DailyMoneyRepository {
  constructor(private readonly db: Database.Database) {}

  rows(businessDate: string): DailyMoneyRow[] {
    const d = businessDate;
    const rows = this.db
      .prepare(
        `
        WITH sale_money AS (
          -- A sealed tender set (one or more tenders).
          SELECT s.id AS sale_id, s.currency, ${CHANNEL("t.method", "t.provider")} AS channel, t.amount_minor AS amount,
                 s.cashier_id AS op_id, s.cashier_name AS op_name
            FROM sales AS s JOIN sale_tenders AS t ON t.sale_id = s.id
           WHERE s.business_date = @d AND s.tender_count > 0
          UNION ALL
          -- History: no tender rows; the sale's own method (NULL on an invoice typed without one).
          SELECT s.id, s.currency, CASE WHEN s.payment_method IS NULL THEN 'unspecified'
                                        WHEN s.payment_method = 'external' THEN 'external'
                                        ELSE s.payment_method END,
                 s.paid_minor, s.cashier_id, s.cashier_name
            FROM sales AS s
           WHERE s.business_date = @d AND s.tender_count = 0 AND s.paid_minor > 0
        )
        SELECT CASE WHEN v.id IS NULL THEN 'sale_received' ELSE 'sale_voided' END AS section,
               m.channel, m.currency, m.amount, m.op_id, m.op_name, m.sale_id AS source_id, NULL AS audit_id, NULL AS audit_name
          -- F1 (DEC-35x review): a void counts ONLY when dated on its sale's own day (the service allows no
          -- other). A void dated later — possible only in data this build did not write — never re-states
          -- a past day; it is reported on its own day as an anomaly (lateVoids), with no money effect.
          FROM sale_money AS m LEFT JOIN voids AS v ON v.sale_id = m.sale_id AND v.business_date = @d

        UNION ALL
        SELECT CASE WHEN EXISTS (SELECT 1 FROM advance_applications AS aa WHERE aa.settlement_id = st.id) THEN 'advance_applied'
                    WHEN o.direction = 'payable' THEN 'supplier_payment'
                    ELSE 'collection' END,
               ${CHANNEL("st.method", "st.provider")}, st.currency, st.amount_minor,
               st.settled_by, coalesce(op.name, st.settled_by), st.id, NULL, NULL
          FROM settlements AS st
          JOIN obligations AS o ON o.id = st.obligation_id
          LEFT JOIN operators AS op ON op.id = st.settled_by
         WHERE st.business_date = @d AND st.receipt_id IS NULL

        UNION ALL
        SELECT 'collection', r.provider, r.currency, r.amount_minor, r.received_by, coalesce(op.name, r.received_by), r.id, NULL, NULL
          FROM receipts AS r LEFT JOIN operators AS op ON op.id = r.received_by
         WHERE r.business_date = @d

        UNION ALL
        SELECT 'advance_received', ${CHANNEL("a.method", "a.provider")}, a.currency, a.amount_minor,
               a.received_by, coalesce(op.name, a.received_by), a.id, NULL, NULL
          FROM customer_advances AS a LEFT JOIN operators AS op ON op.id = a.received_by
         WHERE a.business_date = @d AND a.origin = 'receipt'

        UNION ALL
        SELECT 'advance_correction', ${CHANNEL("o.method", "o.provider")}, o.currency, -o.amount_minor,
               o.received_by, coalesce(op.name, o.received_by), c.id, c.corrected_by, coalesce(cb.name, c.corrected_by)
          FROM advance_corrections AS c
          JOIN customer_advances AS o ON o.id = c.advance_id
          LEFT JOIN operators AS op ON op.id = o.received_by
          LEFT JOIN operators AS cb ON cb.id = c.corrected_by
         WHERE c.business_date = @d
        UNION ALL
        SELECT 'advance_correction', ${CHANNEL("s.method", "s.provider")}, s.currency, s.amount_minor,
               s.received_by, coalesce(op.name, s.received_by), c.id, c.corrected_by, coalesce(cb.name, c.corrected_by)
          FROM advance_corrections AS c
          JOIN customer_advances AS s ON s.id = c.successor_advance_id
          LEFT JOIN operators AS op ON op.id = s.received_by
          LEFT JOIN operators AS cb ON cb.id = c.corrected_by
         WHERE c.business_date = @d

        UNION ALL
        SELECT 'advance_refund', f.method, a.currency, f.amount_minor, f.refunded_by, coalesce(op.name, f.refunded_by), f.id, NULL, NULL
          FROM advance_refunds AS f
          JOIN customer_advances AS a ON a.id = f.advance_id
          LEFT JOIN operators AS op ON op.id = f.refunded_by
         WHERE f.business_date = @d
        `,
      )
      .all({ d }) as Array<{
      section: string;
      channel: string;
      currency: string;
      amount: bigint | number;
      op_id: string;
      op_name: string;
      source_id: string;
      audit_id: string | null;
      audit_name: string | null;
    }>;
    return rows.map((r) => ({
      section: r.section as DailyMoneySection,
      channel: r.channel as DailyMoneyChannel,
      currency: r.currency,
      amountMinor: minor(r.amount),
      operatorId: r.op_id,
      operatorName: r.op_name,
      sourceId: r.source_id,
      recordedById: r.audit_id,
      recordedByName: r.audit_name,
    }));
  }

  /** Revenue and new debt of the day's sales, per currency. Revenue is not money. */
  sales(businessDate: string): DailySalesFigures[] {
    const rows = this.db
      .prepare(
        `SELECT s.currency,
                count(*) AS n,
                sum(v.id IS NOT NULL) AS nv,
                coalesce(sum(CASE WHEN v.id IS NULL THEN s.total_minor END), 0) AS revenue,
                coalesce(sum(CASE WHEN v.id IS NOT NULL THEN s.total_minor END), 0) AS voided,
                coalesce(sum(CASE WHEN v.id IS NULL THEN s.balance_due_minor END), 0) AS on_account
           FROM sales AS s LEFT JOIN voids AS v ON v.sale_id = s.id AND v.business_date = s.business_date
          WHERE s.business_date = ?
          GROUP BY s.currency ORDER BY s.currency`,
      )
      .all(businessDate) as Array<{
      currency: string;
      n: bigint | number;
      nv: bigint | number;
      revenue: bigint | number;
      voided: bigint | number;
      on_account: bigint | number;
    }>;
    return rows.map((r) => ({
      currency: r.currency,
      count: Number(r.n),
      voidedCount: Number(r.nv),
      revenueMinor: minor(r.revenue),
      voidedTotalMinor: minor(r.voided),
      onAccountMinor: minor(r.on_account),
    }));
  }

  /**
   * F1: voids dated on this day for a sale of ANOTHER day. The service refuses such a void, so on a
   * ledger this build wrote the list is empty; on foreign data it is reported, never silently applied.
   */
  lateVoids(businessDate: string): Array<{ saleId: string; saleDate: string; totalMinor: bigint; currency: string }> {
    return (
      this.db
        .prepare(
          `SELECT s.id AS sale_id, s.business_date AS sale_date, s.total_minor AS total, s.currency
             FROM voids AS v JOIN sales AS s ON s.id = v.sale_id
            WHERE v.business_date = ? AND s.business_date <> v.business_date ORDER BY s.business_date, s.id`,
        )
        .all(businessDate) as Array<{ sale_id: string; sale_date: string; total: bigint | number; currency: string }>
    ).map((r) => ({ saleId: r.sale_id, saleDate: r.sale_date, totalMinor: minor(r.total), currency: r.currency }));
  }
}
