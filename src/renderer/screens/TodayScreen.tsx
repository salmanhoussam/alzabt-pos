import { useEffect, useState } from "react";
import type { TodaySalesDto } from "../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../api";
import { useT } from "../i18n";

/** Every figure here is read from the ledger by the main process — nothing is computed in the UI. */
export function TodayScreen() {
  const { t } = useT();
  const [report, setReport] = useState<TodaySalesDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    call(pos().getTodaySales()).then(setReport).catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  if (error) return <div className="center error">{error}</div>;
  if (!report) return <div className="center muted">{t("common.loading")}</div>;

  const noSales = report.completedSalesCount === 0 && report.voidedSalesCount === 0;

  return (
    <div className="today-screen">
      <div className="screen-head">
        <h1>{t("today.title")}</h1>
        {/* One unambiguous date representation, isolated as a structured LTR run. */}
        <span className="datechip" data-testid="today-date"><bdi dir="ltr">{report.date}</bdi></span>
        <span className="spacer" />
        {/* Refresh is secondary utility, not the screen's action. */}
        <button className="btn ghost small" onClick={load} data-testid="today-refresh">
          {t("today.refresh")}
        </button>
      </div>

      <div className="today-wrap">
        <div className="card today">
          {/* 🔴 NET LEADS. The owner asks one question — how did today go — and the answer is net.
              The other figures explain it; five equal rows made none of them lead. */}
          <div className="today-hero">
            <span className="today-hero-label">{t("today.net")}</span>
            <strong className="today-hero-value" data-testid="today-net">
              <bdi dir="ltr">{fmt(report.netSales)}</bdi>
            </strong>
          </div>

          {noSales ? (
            <p className="today-empty" data-testid="today-empty">
              <strong>{t("today.empty")}</strong>
              <span className="muted small">{t("today.emptyHint")}</span>
            </p>
          ) : (
            <div className="today-breakdown">
              <div className="today-cell">
                <span className="muted small">{t("today.gross")}</span>
                <span className="today-cell-value"><bdi dir="ltr">{fmt(report.grossSales)}</bdi></span>
              </div>
              <div className="today-cell minus">
                <span className="muted small">{t("today.voidedAmount")}</span>
                {/* 🔴 THE MINUS LEADS, INSIDE THE RUN. Written as a bare "− {amount}" in RTL the
                    sign drifted to the far end and printed "USD 0.00 −". */}
                <span className="today-cell-value">
                  <bdi dir="ltr">{`− ${fmt(report.voidTotal)}`}</bdi>
                </span>
              </div>
            </div>
          )}

          <div className="today-counts">
            <span>
              {t("today.completedCount")} <b><bdi>{report.completedSalesCount}</bdi></b>
            </span>
            <span>
              {t("today.voidedCount")} <b><bdi>{report.voidedSalesCount}</bdi></b>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
