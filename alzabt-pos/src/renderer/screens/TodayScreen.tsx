import { useEffect, useState } from "react";
import type { TodaySalesDto } from "../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../api";

/** Every figure here is read from the ledger by the main process — nothing is computed in the UI. */
export function TodayScreen() {
  const [report, setReport] = useState<TodaySalesDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    call(pos().getTodaySales()).then(setReport).catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  if (error) return <div className="center error">{error}</div>;
  if (!report) return <div className="center muted">Loading…</div>;

  return (
    <div className="center">
      <div className="card today">
        <h2>Today's Sales — {report.date}</h2>
        <dl className="stats">
          <dt>Completed sales</dt>
          <dd>{report.completedSalesCount}</dd>
          <dt>Voided sales</dt>
          <dd>{report.voidedSalesCount}</dd>
          <dt>Gross sales</dt>
          <dd>{fmt(report.grossSales)}</dd>
          <dt>Voids</dt>
          <dd>− {fmt(report.voidTotal)}</dd>
          <dt className="net">Net sales</dt>
          <dd className="net">{fmt(report.netSales)}</dd>
        </dl>
        <button className="btn wide" onClick={load}>
          Refresh
        </button>
      </div>
    </div>
  );
}
