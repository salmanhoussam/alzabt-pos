/**
 * Customer advances — the two read surfaces (migration 20):
 *
 *   PendingAdvances        every advance whose outcome the operator has not seen, ANSWERED FROM THE
 *                          LEDGER (recorded → its receipt; open → finish under the SAME key, or close
 *                          as not received; unknown → never treated as "not recorded").
 *   AdvanceStatementSection  OWNER: a customer's advances, each with its live balance and how it was
 *                          corrected — a SEPARATE section from the debt (D2: never netted).
 *
 * No figure is computed here except the section total, which is a plain sum of the per-advance
 * balances main sent (all one currency per line set, summed in bigint).
 */
import { useCallback, useEffect, useState } from "react";
import { call, fmt, pos } from "../api";
import { useT } from "../i18n";
import type { AdvanceDto, AdvanceStatementDto, PendingAdvanceDto } from "../../shared/ipcContract";
import { AdvanceReceipt, advanceErrorText } from "./AdvanceSheet";

export function PendingAdvances({ refreshKey, onSettled }: { refreshKey: number; onSettled: () => void }) {
  const { t } = useT();
  const [rows, setRows] = useState<readonly PendingAdvanceDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ key: string; advance: AdvanceDto } | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await call(pos().pendingAdvances()));
      setError(null);
    } catch (err) {
      setError(advanceErrorText(err, t));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(advanceErrorText(err, t));
    }
    await load();
    onSettled();
  };

  if (rows.length === 0 && !error) return null;
  return (
    <section className="panel adv-pending" data-testid="adv-pending">
      <h3>{t("adv.pending.title")}</h3>
      <p className="muted small">{t("adv.pending.hint")}</p>
      {error && <p className="error">{error}</p>}
      <ul>
        {rows.map((r) => (
          <li key={r.key} data-testid="adv-pending-row" data-status={r.status}>
            {r.status === "recorded" ? (
              <>
                <strong>{t("adv.pending.recorded")}</strong> · <bdi dir="ltr">{r.advance.number}</bdi> · <bdi>{r.advance.customerName}</bdi> ·{" "}
                <bdi dir="ltr">{fmt(r.advance.amount)}</bdi>{" "}
                <button className="btn" data-testid="adv-pending-show" onClick={() => setShown({ key: r.key, advance: r.advance })}>
                  {t("adv.pending.show")}
                </button>
              </>
            ) : r.status === "unknown" ? (
              <strong>{t("adv.pending.unknown")}</strong>
            ) : (
              <>
                <strong>{r.status === "open" ? t("adv.pending.open") : t("adv.pending.closed")}</strong> · <bdi>{r.customerName}</bdi> ·{" "}
                <bdi dir="ltr">{fmt(r.amount)}</bdi> · {r.channel === "whish" ? t("adv.whish") : t("adv.cash")}
                {r.reference && (
                  <>
                    {" "}
                    <bdi dir="ltr">{r.reference}</bdi>
                  </>
                )}{" "}
                {r.status === "open" ? (
                  <>
                    <button
                      className="btn"
                      data-testid="adv-pending-finish"
                      onClick={() =>
                        void act(async () => {
                          const done = await call(pos().finishAdvance({ idempotencyKey: r.key }));
                          setShown({ key: r.key, advance: done.advance });
                        })
                      }
                    >
                      {t("adv.pending.finish")}
                    </button>
                    <button className="btn ghost" data-testid="adv-pending-close" onClick={() => void act(() => call(pos().closeAdvance({ idempotencyKey: r.key })))}>
                      {t("adv.pending.notReceived")}
                    </button>
                  </>
                ) : (
                  <button className="btn ghost" data-testid="adv-pending-seen" onClick={() => void act(() => call(pos().acknowledgeAdvance({ idempotencyKey: r.key })))}>
                    {t("adv.pending.seen")}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {shown && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="panel customer-panel">
            <AdvanceReceipt
              advance={shown.advance}
              duplicate={false}
              onClose={() => {
                const k = shown.key;
                setShown(null);
                void act(() => call(pos().acknowledgeAdvance({ idempotencyKey: k })));
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

export function AdvanceStatementSection({ customerId, refreshKey }: { customerId: string; refreshKey: number }) {
  const { t } = useT();
  const [data, setData] = useState<AdvanceStatementDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<AdvanceDto | null>(null);
  useEffect(() => {
    let live = true;
    call(pos().getAdvanceStatement({ customerId }))
      .then((d) => live && (setData(d), setError(null)))
      .catch((err) => live && setError(advanceErrorText(err, t)));
    return () => {
      live = false;
    };
  }, [customerId, refreshKey, t]);

  if (error) return <p className="error" data-testid="adv-stmt-error">{error}</p>;
  if (!data) return null;
  const currency = data.lines[0]?.unused.currency ?? null;
  const total = data.lines.reduce((s, l) => s + BigInt(l.unused.minor), 0n);
  return (
    <section className="statement adv-statement" data-testid="adv-statement">
      <h3>{t("adv.stmt.title")}</h3>
      {data.lines.length === 0 ? (
        <p className="muted">{t("adv.stmt.none")}</p>
      ) : (
        <>
          <table className="statement-table">
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.advance.id} data-testid="adv-stmt-line" data-number={l.advance.number} data-unused={l.unused.minor}>
                  <td>
                    <button className="link" onClick={() => setShown(l.advance)} data-testid="adv-stmt-open">
                      <bdi dir="ltr">{l.advance.number}</bdi>
                    </button>
                  </td>
                  <td>
                    <bdi dir="ltr">{l.advance.businessDate}</bdi>
                  </td>
                  <td>
                    {l.advance.channel === "whish" ? t("adv.whish") : t("adv.cash")}
                    {l.advance.reference && (
                      <>
                        {" "}
                        <bdi dir="ltr">{l.advance.reference}</bdi>
                      </>
                    )}
                  </td>
                  <td>
                    <bdi dir="ltr">{fmt(l.advance.amount)}</bdi>
                  </td>
                  <td>
                    {t("adv.stmt.balance")}: <bdi dir="ltr">{fmt(l.unused)}</bdi>
                  </td>
                  <td className="small">
                    {l.advance.origin === "correction" && (
                      <span data-testid="adv-stmt-correction-of">
                        {t("adv.stmt.correctionOf")} <bdi dir="ltr">{l.advance.correctsNumber}</bdi>
                      </span>
                    )}
                    {l.correction && (
                      <span data-testid="adv-stmt-corrected">
                        {l.correction.kind === "not_received" ? t("adv.stmt.notReceived") : `${t("adv.stmt.replacedBy")} ${l.correction.successorNumber ?? ""}`} —{" "}
                        <bdi>{l.correction.reason}</bdi>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {currency && (
            <p data-testid="adv-stmt-total">
              {t("adv.stmt.total")}: <strong><bdi dir="ltr">{fmt({ minor: total.toString(), currency })}</bdi></strong>
            </p>
          )}
          <p className="muted small">{t("adv.stmt.noNet")}</p>
        </>
      )}
      {shown && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="panel customer-panel">
            <AdvanceReceipt advance={shown} duplicate={false} onClose={() => setShown(null)} />
          </div>
        </div>
      )}
    </section>
  );
}
