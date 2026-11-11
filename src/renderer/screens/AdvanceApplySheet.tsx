/**
 * DEC-35x — the OWNER applies a customer's advance to ONE of that customer's open debts. Shown only
 * from the owner's advance statement; the gate is NOT this screen: `applyAdvanceToDebt` is
 * owner-classified, `AdvanceService.requireOwner` re-reads the live role, and the M19 trigger refuses
 * any other operator.
 *
 * NOT NEW MONEY: no cash is taken and no Whish reference is asked for — the money arrived as the ADV-.
 * One request key per reviewed application; a retry after a lost reply re-sends the SAME key and main
 * answers with the SAME application. Every figure shown afterwards is the one main read back.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiError, call, fmt, newIdempotencyKey, pos } from "../api";
import { useT } from "../i18n";
import type { AdvanceDto, ApplyAdvanceResponse, MoneyDto, StatementObligationDto } from "../../shared/ipcContract";
import { statementDocumentText } from "../statementDocument";
import { advanceErrorText } from "./AdvanceSheet";
import { minorOf } from "./receiptAllocation";
import { formatDecimal, money } from "../../domain/money";

/** Codes that PROVE nothing was written: the owner may edit and try again. */
const REFUSALS = new Set([
  "INVALID_INPUT", "INVALID_AMOUNT", "NOT_EXACT", "NOT_AUTHORIZED", "IDEMPOTENCY_CONFLICT", "ADVANCE_NOT_FOUND",
  "ADVANCE_DEBT_NOT_FOUND", "ADVANCE_DEBT_OTHER_CUSTOMER", "ADVANCE_DEBT_NOT_OPEN", "ADVANCE_DEBT_CURRENCY",
  "ADVANCE_APPLY_ABOVE_BALANCE", "ADVANCE_APPLY_ABOVE_DEBT", "ADVANCE_CORRECTED_NOT_APPLICABLE",
]);

export function AdvanceApplySheet({ advance, unused, onClose }: { advance: AdvanceDto; unused: MoneyDto; onClose: (changed: boolean) => void }) {
  const { t } = useT();
  const [debts, setDebts] = useState<readonly StatementObligationDto[] | null>(null);
  const [debtId, setDebtId] = useState<string>("");
  const [amountText, setAmountText] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [done, setDone] = useState<ApplyAdvanceResponse | null>(null);

  useEffect(() => {
    let live = true;
    call(pos().getCustomerStatement({ customerId: advance.customerId }))
      .then((s) => {
        if (!live) return;
        const open = s.obligations.filter((o) => !o.fullyPaid && o.outstanding.currency === unused.currency);
        setDebts(open);
        if (open.length > 0) setDebtId(open[0]!.id);
      })
      .catch((err) => live && setError(advanceErrorText(err, t)));
    return () => {
      live = false;
    };
  }, [advance.customerId, unused.currency, t]);

  const debt = debts?.find((d) => d.id === debtId) ?? null;
  // The suggested amount is the smaller of the two balances main reported — a suggestion only: main decides.
  const suggested = useMemo(() => {
    if (!debt) return null;
    const a = BigInt(unused.minor);
    const b = BigInt(debt.outstanding.minor);
    return { minor: (a < b ? a : b).toString(), currency: unused.currency };
  }, [debt, unused]);
  // The field is PREFILLED with the suggestion (a real, editable value): what the owner sees is exactly what is sent.
  useEffect(() => {
    if (suggested) setAmountText(formatDecimal(money(BigInt(suggested.minor), suggested.currency)));
  }, [suggested]);
  const amountMinor = amountText.trim() === "" ? null : minorOf(amountText, unused.currency);

  const edit = () => {
    setKey(newIdempotencyKey());
    setError(null);
  };

  const submit = async () => {
    if (!debt || amountMinor === null) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await call(pos().applyAdvanceToDebt({ advanceId: advance.id, obligationId: debt.id, amountMinor: amountMinor.toString(), idempotencyKey: key })));
      setUncertain(false);
    } catch (err) {
      setError(advanceErrorText(err, t));
      setUncertain(!(err instanceof ApiError && REFUSALS.has(err.code)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="adv-apply-sheet">
      <div className="panel customer-panel adv-apply">
        <header className="panel-head">
          <h2>
            {t("adv.apply.title")} <bdi dir="ltr">{advance.number}</bdi>
          </h2>
        </header>
        {done ? (
          <div data-testid="adv-apply-done">
            <p className="receipt-ok">✓ {t("adv.apply.done")}</p>
            <p data-testid="adv-apply-result">
              <bdi dir="ltr">{fmt(done.application.amount)}</bdi> → <bdi>{statementDocumentText(done.application.debtDocument, t)}</bdi>
            </p>
            <p>
              {t("adv.apply.left")}: <bdi dir="ltr" data-testid="adv-apply-unused">{fmt(done.unused)}</bdi> · {t("adv.apply.debtLeft")}:{" "}
              <bdi dir="ltr" data-testid="adv-apply-debt-left">{fmt(done.debtOutstanding)}</bdi>
            </p>
            <p className="muted small">{t("adv.apply.noMoney")}</p>
            <button className="btn primary" onClick={() => onClose(true)} data-testid="adv-apply-close">
              {t("adv.close")}
            </button>
          </div>
        ) : (
          <div className="customer-form">
            <p className="muted small">
              {t("adv.stmt.balance")}: <bdi dir="ltr" data-testid="adv-apply-available">{fmt(unused)}</bdi>
            </p>
            {debts === null ? (
              !error && <p className="muted">{t("common.loading")}</p>
            ) : debts.length === 0 ? (
              <p className="muted" data-testid="adv-apply-no-debt">{t("adv.apply.noDebt")}</p>
            ) : (
              <fieldset disabled={uncertain || busy}>
                <label>
                  {t("adv.apply.debt")}
                  <select value={debtId} onChange={(e) => (setDebtId(e.target.value), edit())} data-testid="adv-apply-debt">
                    {debts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {statementDocumentText(d.document, t)} — {t("adv.apply.owes")} {fmt(d.outstanding)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("adv.apply.amount")}
                  <input
                    dir="ltr"
                    value={amountText}
                    onChange={(e) => (setAmountText(e.target.value), edit())}
                    data-testid="adv-apply-amount"
                  />
                </label>
              </fieldset>
            )}
            {error && <p className="error" data-testid="adv-apply-error">{error}</p>}
            {uncertain && <p className="muted small">{t("adv.retryHint")}</p>}
            <div className="panel-actions">
              <button
                className="btn primary"
                disabled={busy || !debt || amountMinor === null || amountMinor <= 0n}
                onClick={() => void submit()}
                data-testid="adv-apply-confirm"
              >
                {busy ? t("adv.posting") : uncertain ? t("adv.retry") : t("adv.apply.confirm")}
              </button>
              {!uncertain && (
                <button className="btn ghost" disabled={busy} onClick={() => onClose(false)}>
                  {t("collect.cancel")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
