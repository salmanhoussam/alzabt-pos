/**
 * Today's Sales — a pure function of ledger rows. No number here comes from a model, a cache or
 * the UI: every figure is summed from the rows passed in.
 *
 * Definitions (Gate 1):
 *   completedSalesCount — sales recorded in the business day (voided ones included)
 *   voidedSalesCount    — of those, how many carry a void
 *   grossSales          — sum of totals of all those sales
 *   voidTotal           — sum of totals of the voided ones
 *   netSales            — grossSales − voidTotal
 *
 * A void is only allowed in the same business day as its sale (see PosService.voidSale), so a void
 * always lands in the same day's report as the sale it cancels.
 *
 * One currency per report. Rows in more than one currency make the report FAIL rather than add
 * pounds to dollars.
 */
import { DomainError } from "./errors";
import { type Money, add, subtract, zero } from "./money";

export interface ReportSaleRow {
  readonly total: Money;
  readonly voided: boolean;
}

export interface TodaySalesReport {
  readonly date: string;
  readonly currency: string;
  readonly completedSalesCount: number;
  readonly voidedSalesCount: number;
  readonly grossSales: Money;
  readonly voidTotal: Money;
  readonly netSales: Money;
}

export function buildTodaySales(
  date: string,
  terminalCurrency: string,
  rows: ReadonlyArray<ReportSaleRow>,
): TodaySalesReport {
  const currencies = new Set(rows.map((r) => r.total.currency));
  if (currencies.size > 1) {
    throw new DomainError(
      "MIXED_CURRENCY",
      `Business day ${date} contains sales in ${[...currencies].join(", ")}; refusing to sum them`,
    );
  }
  const currency = rows[0]?.total.currency ?? terminalCurrency;
  let gross = zero(currency);
  let voided = zero(currency);
  let voidedCount = 0;
  for (const row of rows) {
    gross = add(gross, row.total);
    if (row.voided) {
      voided = add(voided, row.total);
      voidedCount += 1;
    }
  }
  return {
    date,
    currency,
    completedSalesCount: rows.length,
    voidedSalesCount: voidedCount,
    grossSales: gross,
    voidTotal: voided,
    netSales: subtract(gross, voided),
  };
}
