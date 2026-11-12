/**
 * DAILY MONEY IN / OUT — the OWNER's view of a business day's money (DEC-35x). Rendered only for the
 * owner; the channel is owner-classified and the service re-reads the live role, so hiding it here
 * is courtesy, not the gate. Every figure is read from main — nothing is computed here except which
 * channel columns have anything to show and one operator's money-out sum.
 */
import { useEffect, useState } from "react";
import type { ChannelAmountsDto, DailyMoneyChannelDto, DailyMoneyDto, MoneyPartDto } from "../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../api";
import { useT } from "../i18n";

const ALL: readonly DailyMoneyChannelDto[] = ["cash", "whish", "bank_transfer", "external", "card", "other", "unspecified"];

export function DailyMoneyPanel() {
  const { t } = useT();
  const [date, setDate] = useState<string | undefined>(undefined);
  const [today, setToday] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<DailyMoneyDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (d: string | undefined) => {
    setError(null);
    call(pos().getDailyMoney(d === undefined ? {} : { date: d }))
      .then((r) => {
        setReport(r);
        if (d === undefined) {
          setDate(r.date);
          setToday(r.date);
        }
      })
      .catch((e) => setError(errorText(e)));
  };
  useEffect(() => load(undefined), []);

  if (error) return <div className="card dm-panel error" data-testid="dm-error">{error}</div>;
  if (!report) return null;

  // 🔴 SIGNED (DEC-35z+ finding F3): a day's net, or a correction line, can be NEGATIVE — e.g. a Whish
  // advance refunded in cash puts the cash column below zero. `fmt` takes only whole non-negative minor
  // units and threw, unmounting the whole app (a blank window). The sign is shown, never dropped.
  const m = (minor: string) => (minor.startsWith("-") ? `−${fmt({ minor: minor.slice(1), currency: report.currency })}` : fmt({ minor, currency: report.currency }));
  // Cash and Whish always; any other channel only on a day that actually has it (history).
  const parts: ChannelAmountsDto[] = [
    report.sales.received.byChannel,
    report.sales.voidedReceived.byChannel,
    report.collections.byChannel,
    report.advances.byChannel,
    report.corrections.byChannel,
    report.moneyOut.byChannel,
    report.advanceApplied.byChannel,
  ];
  const channels = ALL.filter((c) => c === "cash" || c === "whish" || parts.some((p) => p[c] !== "0"));

  const row = (key: string, label: string, p: { byChannel: ChannelAmountsDto; total: { minor: string } }, cls = "") => (
    <tr key={key} className={cls} data-testid={`dm-row-${key}`}>
      <th scope="row">{label}</th>
      {channels.map((c) => (
        <td key={c} data-testid={`dm-${key}-${c}`}>
          <bdi dir="ltr">{m(p.byChannel[c])}</bdi>
        </td>
      ))}
      <td className="dm-total" data-testid={`dm-${key}-total`}>
        <bdi dir="ltr">{m(p.total.minor)}</bdi>
      </td>
    </tr>
  );
  const count = (p: MoneyPartDto) => (p.count > 0 ? ` (${p.count})` : "");

  return (
    <div className="card dm-panel" data-testid="dm-panel">
      <div className="dm-head">
        <h2>{t("dm.title")}</h2>
        <input
          type="date"
          dir="ltr"
          value={date ?? ""}
          max={today}
          onChange={(e) => {
            const d = e.target.value || undefined;
            setDate(d);
            load(d);
          }}
          data-testid="dm-date"
        />
      </div>

      {/* Revenue is not money: shown apart, above the money table. */}
      <p className="dm-revenue muted small" data-testid="dm-revenue">
        {t("dm.revenue")} <bdi dir="ltr">{m(report.sales.revenue.minor)}</bdi>
        {/* F2: why revenue can be 0 while money received is not — the voided sales are named here. */}
        {report.sales.voidedCount > 0 && (
          <>
            {" · "}
            {t("dm.voidedSales")} <bdi dir="ltr" data-testid="dm-revenue-voided">{m(report.sales.voidedTotal.minor)}</bdi>
          </>
        )}
        {" · "}
        {t("dm.onAccount")}{" "}
        <bdi dir="ltr" data-testid="dm-on-account">{m(report.sales.onAccount.minor)}</bdi>
      </p>

      <div className="dm-scroll">
        <table className="dm-table">
          <thead>
            <tr>
              <th />
              {channels.map((c) => (
                <th key={c} scope="col">{t(`dm.ch.${c}`)}</th>
              ))}
              <th scope="col">{t("dm.total")}</th>
            </tr>
          </thead>
          <tbody>
            {row("sales", t("dm.salesReceived") + count(report.sales.received), report.sales.received)}
            {/* F2: a void is not a refund — these tenders are still money the ledger proves was received. */}
            {report.sales.voidedReceived.count > 0 && row("voided", t("dm.voided") + count(report.sales.voidedReceived), report.sales.voidedReceived, "dm-voided-row")}
            {row("collections", t("dm.collections") + count(report.collections), report.collections)}
            {row("advances", t("dm.advances") + count(report.advances), report.advances)}
            {report.corrections.count > 0 && row("corrections", t("dm.corrections") + count(report.corrections), report.corrections, "dm-correction")}
            {row("in", t("dm.moneyIn"), report.moneyIn, "dm-sum")}
            {report.refunds.count > 0 && row("refunds", t("dm.refunds") + count(report.refunds), report.refunds)}
            {report.supplierPayments.count > 0 && row("supplier", t("dm.supplier") + count(report.supplierPayments), report.supplierPayments)}
            {row("out", t("dm.moneyOut"), report.moneyOut, "dm-sum")}
            {row("net", t("dm.net"), report.net, "dm-net")}
          </tbody>
        </table>
      </div>

      {report.corrections.count > 0 && <p className="muted small">{t("dm.correctionsNote")}</p>}
      {report.advanceApplied.count > 0 && (
        <p className="muted small" data-testid="dm-applied">
          {t("dm.applied")} ({report.advanceApplied.count}) <bdi dir="ltr">{m(report.advanceApplied.total.minor)}</bdi> — {t("dm.notMoney")}
        </p>
      )}
      {report.sales.voidedReceived.count > 0 && (
        <p className="muted small" data-testid="dm-voided">
          {t("dm.voidedNote")}
        </p>
      )}
      {report.correctionsBy.length > 0 && (
        <p className="muted small" data-testid="dm-corrections-by">
          {t("dm.correctionsBy")} {report.correctionsBy.map((c) => `${c.operatorName} (${c.count})`).join(" · ")}
        </p>
      )}
      {report.lateVoids.length > 0 && (
        <p className="error small" data-testid="dm-late-voids">
          {t("dm.lateVoids")} {report.lateVoids.map((v) => `${v.saleDate} ${m(v.total.minor)}`).join(" · ")}
        </p>
      )}

      {report.byOperator.length > 0 && (
        <div className="dm-scroll">
          <table className="dm-table dm-ops" data-testid="dm-operators">
            <thead>
              <tr>
                <th scope="col">{t("dm.operator")}</th>
                {channels.map((c) => (
                  <th key={c} scope="col">{t("dm.in")} · {t(`dm.ch.${c}`)}</th>
                ))}
                <th scope="col">{t("dm.moneyOut")}</th>
              </tr>
            </thead>
            <tbody>
              {report.byOperator.map((o) => (
                <tr key={o.operatorId} data-testid="dm-op-row" data-operator={o.operatorName}>
                  <th scope="row"><bdi>{o.operatorName}</bdi></th>
                  {channels.map((c) => (
                    <td key={c} data-testid={`dm-op-in-${c}`}><bdi dir="ltr">{m(o.moneyIn[c])}</bdi></td>
                  ))}
                  <td><bdi dir="ltr">{m(ALL.reduce((a, c) => a + BigInt(o.moneyOut[c]), 0n).toString())}</bdi></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
