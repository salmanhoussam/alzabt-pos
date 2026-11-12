/**
 * DAILY MONEY IN / OUT — a pure function of one business day's ledger rows.
 *
 * Six things the owner must never see blended, kept apart here:
 *   1. Sales revenue      what was SOLD (Σ totals of the sales not voided). Not money.
 *   2. Money received     what the LEDGER proves came in, per channel (Cash, Whish …): sales tenders
 *                         (voided sales INCLUDED, on their own line — F2: a void is not a refund, and no
 *                         sale refund exists in the ledger) + debt collections + advances + corrections.
 *   3. Debt collections   money that arrived against an existing customer debt.
 *   4. Customer advances  money that arrived ahead of any sale.
 *   5. Corrections        an audited re-classification of an EARLIER receipt, on the correction's
 *                         own day: never new money (a pure re-link nets to 0 per channel total).
 *   6. Money out          cash refunded from an advance (REF-) and supplier payments.
 *
 * An advance APPLIED to a debt is none of these: its money arrived on the advance's own day. It is
 * reported as a non-money movement so the owner sees the debt went down without seeing cash twice.
 *
 * One currency per report: rows in more than one currency make the report FAIL rather than add
 * pounds to dollars (the same rule as Today's Sales).
 */
import { DomainError } from "./errors";

export type DailyMoneySection =
  | "sale_received"
  | "sale_voided"
  | "collection"
  | "advance_received"
  | "advance_correction"
  | "advance_refund"
  | "supplier_payment"
  | "advance_applied";

/**
 * How the money moved. `whish` and `bank_transfer` are the providers of an external payment;
 * `external` is an external payment whose provider was never recorded (pre-M17 history); `card` and
 * `other` exist only in history (P3: no new card/other money); `unspecified` is a historic
 * invoice whose paid figure was typed without a method.
 */
export type DailyMoneyChannel = "cash" | "whish" | "bank_transfer" | "external" | "card" | "other" | "unspecified";

export interface DailyMoneyRow {
  readonly section: DailyMoneySection;
  readonly channel: DailyMoneyChannel;
  readonly currency: string;
  /** Signed: only an advance correction can be negative. */
  readonly amountMinor: bigint;
  readonly operatorId: string;
  readonly operatorName: string;
  /** The document that carries the money, for the drill-down (sale id, settlement id, ADV id …). */
  readonly sourceId: string;
  /**
   * Corrections only: WHO RECORDED the correction (audit). The money of a correction belongs to the
   * original RECEIVER (operatorId) — never to the person who corrected the record (F2 review).
   */
  readonly recordedById?: string | null;
  readonly recordedByName?: string | null;
}

/** F1: a void dated on a later day than its sale (foreign data only). Reported, never applied. */
export interface LateVoid {
  readonly saleId: string;
  readonly saleDate: string;
  readonly totalMinor: bigint;
  readonly currency: string;
}

export interface DailySalesFigures {
  readonly currency: string;
  readonly count: number;
  readonly voidedCount: number;
  /** Σ total of the sales that are not voided — revenue, not money. */
  readonly revenueMinor: bigint;
  readonly voidedTotalMinor: bigint;
  /** Σ balance due of the sales that are not voided — new customer debt, not money. */
  readonly onAccountMinor: bigint;
}


export type ChannelAmounts = Readonly<Record<DailyMoneyChannel, bigint>>;

export const MONEY_CHANNELS: readonly DailyMoneyChannel[] = [
  "cash",
  "whish",
  "bank_transfer",
  "external",
  "card",
  "other",
  "unspecified",
];

export interface MoneyPart {
  /** How many distinct documents (sale, settlement, receipt, ADV, correction, REF) contributed. */
  readonly count: number;
  readonly byChannel: ChannelAmounts;
  readonly totalMinor: bigint;
}

export interface OperatorMoney {
  readonly operatorId: string;
  readonly operatorName: string;
  readonly sales: ChannelAmounts;
  /** Tenders this operator took on sales later voided — still in the drawer as far as the ledger knows. */
  readonly voidedSales: ChannelAmounts;
  readonly collections: ChannelAmounts;
  readonly advances: ChannelAmounts;
  readonly corrections: ChannelAmounts;
  readonly moneyIn: ChannelAmounts;
  readonly moneyOut: ChannelAmounts;
}

export interface DailyMoneyReport {
  readonly date: string;
  readonly currency: string;
  readonly sales: {
    readonly count: number;
    readonly voidedCount: number;
    readonly revenueMinor: bigint;
    readonly voidedTotalMinor: bigint;
    readonly onAccountMinor: bigint;
    readonly received: MoneyPart;
    /**
     * F2: tenders of sales voided the same day. STILL MONEY RECEIVED (the ledger records no refund of a
     * sale); shown on their own line so the owner checks whether it was handed back outside the POS.
     */
    readonly voidedReceived: MoneyPart;
  };
  readonly collections: MoneyPart;
  readonly advances: MoneyPart;
  readonly corrections: MoneyPart;
  readonly moneyIn: MoneyPart;
  readonly refunds: MoneyPart;
  readonly supplierPayments: MoneyPart;
  readonly moneyOut: MoneyPart;
  readonly net: { readonly byChannel: ChannelAmounts; readonly totalMinor: bigint };
  readonly advanceApplied: MoneyPart;
  readonly byOperator: readonly OperatorMoney[];
  /** F2: who RECORDED the day's corrections (audit only — their money stays with the original receiver). */
  readonly correctionsBy: ReadonlyArray<{ readonly operatorId: string; readonly operatorName: string; readonly count: number }>;
  /** F1: voids dated today for a sale of another day (foreign data). Not applied to any day's money. */
  readonly lateVoids: readonly LateVoid[];
}

const empty = (): Record<DailyMoneyChannel, bigint> =>
  Object.fromEntries(MONEY_CHANNELS.map((c) => [c, 0n])) as Record<DailyMoneyChannel, bigint>;

const sum = (m: ChannelAmounts): bigint => MONEY_CHANNELS.reduce((a, c) => a + m[c], 0n);

function plus(...ms: ChannelAmounts[]): ChannelAmounts {
  const out = empty();
  for (const m of ms) for (const c of MONEY_CHANNELS) out[c] += m[c];
  return out;
}

function minus(a: ChannelAmounts, b: ChannelAmounts): ChannelAmounts {
  const out = empty();
  for (const c of MONEY_CHANNELS) out[c] = a[c] - b[c];
  return out;
}

function part(rows: readonly DailyMoneyRow[]): MoneyPart {
  const by = empty();
  const docs = new Set<string>();
  for (const r of rows) {
    by[r.channel] += r.amountMinor;
    docs.add(r.sourceId);
  }
  return { count: docs.size, byChannel: by, totalMinor: sum(by) };
}

function combined(parts: readonly MoneyPart[]): MoneyPart {
  const by = plus(...parts.map((p) => p.byChannel));
  return { count: parts.reduce((a, p) => a + p.count, 0), byChannel: by, totalMinor: sum(by) };
}

export function buildDailyMoney(
  date: string,
  terminalCurrency: string,
  rows: readonly DailyMoneyRow[],
  sales: readonly DailySalesFigures[],
  lateVoids: readonly LateVoid[] = [],
): DailyMoneyReport {
  const currencies = new Set([...rows.map((r) => r.currency), ...sales.map((s) => s.currency)]);
  if (currencies.size > 1) {
    throw new DomainError("MIXED_CURRENCY", `Business day ${date} contains money in ${[...currencies].join(", ")}; refusing to sum them`);
  }
  const currency = [...currencies][0] ?? terminalCurrency;
  const of = (section: DailyMoneyRow["section"]) => rows.filter((r) => r.section === section);

  const received = part(of("sale_received"));
  const voidedReceived = part(of("sale_voided"));
  const collections = part(of("collection"));
  const advances = part(of("advance_received"));
  const corrections = part(of("advance_correction"));
  const refunds = part(of("advance_refund"));
  const supplierPayments = part(of("supplier_payment"));
  const moneyIn = combined([received, voidedReceived, collections, advances, corrections]);
  const moneyOut = combined([refunds, supplierPayments]);
  const net = minus(moneyIn.byChannel, moneyOut.byChannel);

  const ops = new Map<string, { name: string; s: Record<DailyMoneyChannel, bigint>; v: Record<DailyMoneyChannel, bigint>; c: Record<DailyMoneyChannel, bigint>; a: Record<DailyMoneyChannel, bigint>; k: Record<DailyMoneyChannel, bigint>; out: Record<DailyMoneyChannel, bigint> }>();
  for (const r of rows) {
    let o = ops.get(r.operatorId);
    if (!o) {
      o = { name: r.operatorName, s: empty(), v: empty(), c: empty(), a: empty(), k: empty(), out: empty() };
      ops.set(r.operatorId, o);
    }
    switch (r.section) {
      case "sale_received":
        o.s[r.channel] += r.amountMinor;
        break;
      case "sale_voided":
        o.v[r.channel] += r.amountMinor;
        break;
      case "collection":
        o.c[r.channel] += r.amountMinor;
        break;
      case "advance_received":
        o.a[r.channel] += r.amountMinor;
        break;
      case "advance_correction":
        o.k[r.channel] += r.amountMinor;
        break;
      case "advance_refund":
      case "supplier_payment":
        o.out[r.channel] += r.amountMinor;
        break;
      default:
        break; // an advance application is not money of the day
    }
  }
  const byOperator = [...ops.entries()]
    .map(([operatorId, o]) => ({
      operatorId,
      operatorName: o.name,
      sales: o.s,
      voidedSales: o.v,
      collections: o.c,
      advances: o.a,
      corrections: o.k,
      moneyIn: plus(o.s, o.v, o.c, o.a, o.k),
      moneyOut: o.out,
    }))
    .sort((a, b) => a.operatorName.localeCompare(b.operatorName));

  const s = sales[0];
  return {
    date,
    currency,
    sales: {
      count: s?.count ?? 0,
      voidedCount: s?.voidedCount ?? 0,
      revenueMinor: s?.revenueMinor ?? 0n,
      voidedTotalMinor: s?.voidedTotalMinor ?? 0n,
      onAccountMinor: s?.onAccountMinor ?? 0n,
      received,
      voidedReceived,
    },
    collections,
    advances,
    corrections,
    moneyIn,
    refunds,
    supplierPayments,
    moneyOut,
    net: { byChannel: net, totalMinor: sum(net) },
    advanceApplied: part(of("advance_applied")),
    byOperator,
    correctionsBy: (() => {
      const by = new Map<string, { operatorName: string; ids: Set<string> }>();
      for (const r of of("advance_correction")) {
        const id = r.recordedById ?? r.operatorId;
        const e = by.get(id) ?? { operatorName: r.recordedByName ?? r.operatorName, ids: new Set<string>() };
        e.ids.add(r.sourceId);
        by.set(id, e);
      }
      return [...by.entries()].map(([operatorId, e]) => ({ operatorId, operatorName: e.operatorName, count: e.ids.size }));
    })(),
    lateVoids: lateVoids.filter((v) => v.currency === currency || currencies.size === 0),
  };
}
