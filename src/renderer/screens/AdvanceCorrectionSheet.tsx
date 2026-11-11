/**
 * G2 — the OWNER corrects a mistaken advance (migration 20). Shown only from the owner's statement;
 * the gate is NOT this screen: `correctAdvance` is owner-classified, `AdvanceService.requireOwner`
 * re-reads the live role, and the database trigger refuses any other operator.
 *
 *   A · «لم يُقبض المبلغ»   the money never came: an explicit declaration + a reason. No refund, no REF.
 *   B · «تصحيح البيانات»     the money came, the details were wrong: right customer / Cash ↔ Whish /
 *                            reference / a LOWER amount (the difference declared not received).
 *                            A HIGHER amount is refused by main: the extra needs the owner's review.
 * One request key per reviewed correction; a retry after a lost reply re-sends the SAME key and main
 * answers with the SAME correction. Every figure shown afterwards is the one main read back.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiError, call, fmt, newIdempotencyKey, pos } from "../api";
import { minorOf } from "./receiptAllocation";
import { useT } from "../i18n";
import type { AdvanceDto, CorrectAdvanceResponse, CustomerDto } from "../../shared/ipcContract";
import { advanceErrorText } from "./AdvanceSheet";

const REFUSALS = new Set([
  "INVALID_INPUT", "INVALID_REASON", "INVALID_AMOUNT", "NOT_EXACT", "PAYMENT_METHOD_NOT_ACCEPTED", "FUNDS_NOT_CONFIRMED",
  "DUPLICATE_PAYMENT_REFERENCE", "PARTY_NOT_FOUND", "NOT_AUTHORIZED", "ADVANCE_NOT_FOUND", "ADVANCE_ALREADY_CORRECTED",
  "ADVANCE_IN_USE", "ADVANCE_CORRECTION_ABOVE_ORIGINAL", "IDEMPOTENCY_CONFLICT",
]);

export function AdvanceCorrectionSheet({ advance, onClose }: { advance: AdvanceDto; onClose: (changed: boolean) => void }) {
  const { t } = useT();
  const [kind, setKind] = useState<"not_received" | "replaced">("not_received");
  const [reason, setReason] = useState("");
  const [declare, setDeclare] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<readonly CustomerDto[]>([]);
  const [customerId, setCustomerId] = useState(advance.customerId);
  const [channel, setChannel] = useState(advance.channel);
  const [reference, setReference] = useState(advance.reference ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [done, setDone] = useState<CorrectAdvanceResponse | null>(null);

  useEffect(() => {
    if (kind !== "replaced") return;
    let live = true;
    call(pos().searchCustomers({ query: customerQuery, includeArchived: false }))
      .then((r) => live && setCustomers(r))
      .catch(() => live && setCustomers([]));
    return () => {
      live = false;
    };
  }, [kind, customerQuery]);

  const edit = () => {
    setKey(newIdempotencyKey());
    setError(null);
  };
  const amountMinor = useMemo(() => (amountText.trim() === "" ? null : minorOf(amountText, advance.amount.currency)), [amountText, advance.amount.currency]);
  const lower = amountMinor !== null && amountMinor < BigInt(advance.amount.minor);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = { advanceId: advance.id, kind, reason, idempotencyKey: key };
      const req =
        kind === "not_received"
          ? { ...base, confirmNotReceived: declare }
          : {
              ...base,
              ...(customerId !== advance.customerId ? { customerId } : {}),
              ...(channel !== advance.channel ? { channel } : {}),
              ...(channel === "whish" ? { reference: reference.trim() } : {}),
              ...(channel === "whish" && (advance.channel !== "whish" || reference.trim() !== (advance.reference ?? "")) ? { fundsConfirmed: confirmed } : {}),
              ...(amountMinor !== null ? { amountMinor: amountMinor.toString() } : {}),
              ...(lower ? { confirmNotReceived: declare } : {}),
            };
      setDone(await call(pos().correctAdvance(req)));
      setUncertain(false);
    } catch (err) {
      setError(advanceErrorText(err, t));
      setUncertain(!(err instanceof ApiError && REFUSALS.has(err.code)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="adv-correct-sheet">
      <div className="panel customer-panel adv-correct">
        <header className="panel-head">
          <h2>
            {t("adv.corr.title")} <bdi dir="ltr">{advance.number}</bdi>
          </h2>
        </header>
        {done ? (
          <div data-testid="adv-correct-done">
            <p className="receipt-ok">✓ {t("adv.corr.done")}</p>
            {done.successor ? (
              <p data-testid="adv-correct-successor">
                {t("adv.stmt.replacedBy")} <bdi dir="ltr">{done.successor.number}</bdi> · <bdi>{done.successor.customerName}</bdi> ·{" "}
                <bdi dir="ltr">{fmt(done.successor.amount)}</bdi>
              </p>
            ) : (
              <p>{t("adv.stmt.notReceived")}</p>
            )}
            <p className="muted small">{t("adv.corr.noMoney")}</p>
            <button className="btn primary" onClick={() => onClose(true)} data-testid="adv-correct-close">
              {t("adv.close")}
            </button>
          </div>
        ) : (
          <div className="customer-form">
            <p className="muted small">
              <bdi>{advance.customerName}</bdi> · <bdi dir="ltr">{fmt(advance.amount)}</bdi> · {advance.channel === "whish" ? t("adv.whish") : t("adv.cash")}
              {advance.reference && <> · <bdi dir="ltr">{advance.reference}</bdi></>}
            </p>
            <fieldset disabled={uncertain || busy}>
              <label>
                <input type="radio" checked={kind === "not_received"} onChange={() => (setKind("not_received"), edit())} data-testid="adv-correct-kind-not-received" />
                {t("adv.corr.notReceived")}
              </label>
              <label>
                <input type="radio" checked={kind === "replaced"} onChange={() => (setKind("replaced"), edit())} data-testid="adv-correct-kind-replaced" />
                {t("adv.corr.replaced")}
              </label>
            </fieldset>
            {kind === "replaced" && (
              <fieldset disabled={uncertain || busy}>
                <label>
                  {t("adv.corr.customer")}
                  <input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} placeholder={t("customers.search")} data-testid="adv-correct-customer-search" />
                </label>
                <select value={customerId} onChange={(e) => (setCustomerId(e.target.value), edit())} data-testid="adv-correct-customer">
                  <option value={advance.customerId}>{advance.customerName}</option>
                  {customers.filter((c) => c.id !== advance.customerId).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </select>
                <label>
                  <input type="radio" checked={channel === "cash"} onChange={() => (setChannel("cash"), edit())} /> {t("adv.cash")}
                </label>
                <label>
                  <input type="radio" checked={channel === "whish"} onChange={() => (setChannel("whish"), edit())} /> {t("adv.whish")}
                </label>
                {channel === "whish" && (
                  <>
                    <input dir="ltr" value={reference} onChange={(e) => (setReference(e.target.value), edit())} data-testid="adv-correct-reference" />
                    {/* Asked only when this transfer was not already confirmed under THIS reference. */}
                    {(advance.channel !== "whish" || reference.trim() !== (advance.reference ?? "")) && (
                    <label className="collect-confirm-funds">
                      <input type="checkbox" checked={confirmed} onChange={(e) => (setConfirmed(e.target.checked), edit())} />
                      <span>{t("collect.fundsConfirmed")}</span>
                    </label>
                    )}
                  </>
                )}
                <label>
                  {t("adv.corr.amount")}
                  <input dir="ltr" value={amountText} placeholder={fmt(advance.amount)} onChange={(e) => (setAmountText(e.target.value), edit())} data-testid="adv-correct-amount" />
                </label>
              </fieldset>
            )}
            {(kind === "not_received" || lower) && (
              <label className="collect-confirm-funds">
                <input type="checkbox" checked={declare} disabled={uncertain || busy} onChange={(e) => (setDeclare(e.target.checked), edit())} data-testid="adv-correct-declare" />
                <span>{kind === "not_received" ? t("adv.corr.declare") : t("adv.corr.declareDiff")}</span>
              </label>
            )}
            <label>
              {t("adv.corr.reason")}
              <input value={reason} disabled={uncertain || busy} onChange={(e) => (setReason(e.target.value), edit())} data-testid="adv-correct-reason" />
            </label>
            {error && <p className="error" data-testid="adv-correct-error">{error}</p>}
            {uncertain && <p className="muted small">{t("adv.retryHint")}</p>}
            <div className="panel-actions">
              <button className="btn primary" disabled={busy || reason.trim().length < 3} onClick={() => void submit()} data-testid="adv-correct-confirm">
                {busy ? t("adv.posting") : uncertain ? t("adv.retry") : t("adv.corr.confirm")}
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
