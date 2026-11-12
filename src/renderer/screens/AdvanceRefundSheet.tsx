/**
 * DEC-35z+ REF — the OWNER hands back part or all of an advance's UNUSED balance, in CASH, with a
 * reason: form → REVIEW → record → REF- receipt (print / PDF / reprint). Shown only from the owner's
 * advance statement; the gate is NOT this screen: `refundAdvance` is owner-classified, the service
 * re-reads the live role, and the migration-19 trigger refuses any other operator.
 *
 * 🔴 THE CASH LEAVES THE DRAWER AFTER THE RECEIPT IS ON SCREEN. That order is what makes a crash safe
 *    without an attempt table: before the receipt, nothing was handed over; once it is on screen, the
 *    REF- exists and is listed on the advance with its reduced balance.
 * 🔴 ONE REQUEST KEY PER REVIEWED REFUND. Editing makes a new key; "try again" after a lost reply
 *    re-sends the SAME key, so main answers with the SAME REF- and nothing is refunded twice.
 * 🔴 NO FIGURE IS COMPUTED HERE. The amount typed is parsed once into minor units; the receipt and the
 *    balance after are what main read back from the ledger.
 */
import { useRef, useState } from "react";
import { ApiError, call, fmt, newIdempotencyKey, pos } from "../api";
import { stamp } from "../format";
import { useT } from "../i18n";
import type { AdvanceDto, AdvanceRefundDto, MoneyDto, RefundAdvanceResponse } from "../../shared/ipcContract";
import { advanceErrorText } from "./AdvanceSheet";
import { minorOf } from "./receiptAllocation";
import { formatDecimal, money } from "../../domain/money";

/** Codes that PROVE nothing was written: the owner may edit and try again. */
const REFUSALS = new Set([
  "INVALID_INPUT", "INVALID_AMOUNT", "NOT_EXACT", "MONEY_OUT_OF_RANGE", "INVALID_REASON", "NOT_AUTHORIZED", "NOT_LOGGED_IN",
  "IDEMPOTENCY_CONFLICT", "ADVANCE_NOT_FOUND", "ADVANCE_REFUND_ABOVE_BALANCE", "ADVANCE_CORRECTED_NOT_REFUNDABLE",
]);

/** The REF- receipt, from the ledger's own DTO. Used right after the refund AND for every reprint. */
export function RefundReceipt({
  refund,
  unused,
  duplicate,
  onClose,
}: {
  refund: AdvanceRefundDto;
  unused: MoneyDto | null;
  duplicate: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (err) {
      // A print / PDF failure never undoes the refund: the money row committed before any window opened.
      setNote(advanceErrorText(err, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card receipt adv-receipt" data-testid="ref-receipt" data-ref-number={refund.number}>
      <div className="receipt-ok">
        <span className="receipt-check" aria-hidden="true">✓</span>
        <h2>{t("ref.done")}</h2>
      </div>
      {duplicate && (
        <p className="warn" data-testid="ref-duplicate">
          {t("ref.duplicate")}
        </p>
      )}
      <dl className="adv-receipt-fields">
        <dt>{t("adv.number")}</dt>
        <dd data-testid="ref-number">
          <bdi dir="ltr">{refund.number}</bdi>
        </dd>
        <dt>{t("customers.name")}</dt>
        <dd data-testid="ref-customer">
          <bdi>{refund.customerName}</bdi>
        </dd>
        <dt>{t("ref.amount")}</dt>
        <dd data-testid="ref-amount">
          <bdi dir="ltr">{fmt(refund.amount)}</bdi>
        </dd>
        <dt>{t("ref.method")}</dt>
        <dd data-testid="ref-method">{t("adv.cash")}</dd>
        <dt>{t("ref.fromAdvance")}</dt>
        <dd data-testid="ref-advance">
          <bdi dir="ltr">{refund.advanceNumber}</bdi> — {refund.advanceChannel === "whish" ? t("adv.whish") : t("adv.cash")}
          {refund.advanceReference && (
            <>
              {" · "}
              <bdi dir="ltr">{refund.advanceReference}</bdi>
            </>
          )}
        </dd>
        <dt>{t("ref.reason")}</dt>
        <dd data-testid="ref-reason">
          <bdi>{refund.reason}</bdi>
        </dd>
        <dt>{t("ref.by")}</dt>
        <dd data-testid="ref-by">
          <bdi>{refund.refundedByName}</bdi>
        </dd>
        <dt>{t("ref.at")}</dt>
        <dd>
          <bdi dir="ltr">{stamp(refund.refundedAt)}</bdi>
        </dd>
        {unused && (
          <>
            <dt>{t("ref.left")}</dt>
            <dd data-testid="ref-unused">
              <bdi dir="ltr">{fmt(unused)}</bdi>
            </dd>
          </>
        )}
      </dl>
      {refund.advanceChannel === "whish" && (
        <p className="warn" data-testid="ref-whish-note">
          {t("ref.whishNote")}
        </p>
      )}
      <p className="muted small">{t("ref.what")}</p>
      {note && (
        <p className="muted" data-testid="ref-print-note">
          {note}
        </p>
      )}
      <div className="panel-actions">
        <button
          className="btn"
          disabled={busy}
          data-testid="ref-print"
          onClick={() =>
            void run(async () => {
              const r = await call(pos().printAdvanceRefund({ refundId: refund.id }));
              return r.status === "printed" ? t("adv.printed") : "";
            })
          }
        >
          {t("adv.print")}
        </button>
        <button
          className="btn"
          disabled={busy}
          data-testid="ref-pdf"
          onClick={() =>
            void run(async () => {
              const r = await call(pos().saveAdvanceRefundPdf({ refundId: refund.id }));
              return r.status === "saved" ? `${t("adv.saved")} ${r.fileName}` : "";
            })
          }
        >
          {t("adv.pdf")}
        </button>
        <button className="btn primary" disabled={busy} onClick={onClose} data-testid="ref-receipt-close">
          {t("adv.close")}
        </button>
      </div>
    </div>
  );
}

export function AdvanceRefundSheet({ advance, unused, onClose }: { advance: AdvanceDto; unused: MoneyDto; onClose: (changed: boolean) => void }) {
  const { t } = useT();
  // Prefilled with the whole balance — a real, editable value: what the owner sees is what is sent.
  const [amountText, setAmountText] = useState(() => formatDecimal(money(BigInt(unused.minor), unused.currency)));
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [done, setDone] = useState<RefundAdvanceResponse | null>(null);
  // A repeated click (two clicks before React re-renders the button disabled) sends ONE request. The
  // key would make a second one harmless anyway; this keeps the operator from seeing «already recorded».
  const inFlight = useRef(false);

  const amountMinor = amountText.trim() === "" ? null : minorOf(amountText, unused.currency);
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 200;
  const valid = amountMinor !== null && amountMinor > 0n && reasonOk;

  const edit = () => {
    setKey(newIdempotencyKey());
    setError(null);
    setReviewing(false);
  };

  const submit = async () => {
    if (!valid || amountMinor === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setDone(
        await call(pos().refundAdvance({ advanceId: advance.id, amountMinor: amountMinor.toString(), reason: reason.trim(), idempotencyKey: key })),
      );
      setUncertain(false);
    } catch (err) {
      setError(advanceErrorText(err, t));
      setUncertain(!(err instanceof ApiError && REFUSALS.has(err.code)));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="ref-sheet">
      <div className="panel customer-panel adv-apply">
        {done ? (
          <RefundReceipt refund={done.refund} unused={done.unused} duplicate={done.duplicate} onClose={() => onClose(true)} />
        ) : (
          <>
            <header className="panel-head">
              <h2>
                {t("ref.title")} <bdi dir="ltr">{advance.number}</bdi>
              </h2>
            </header>
            <div className="customer-form">
              <p className="muted small">
                {t("adv.stmt.balance")}:{" "}
                <bdi dir="ltr" data-testid="ref-available">
                  {fmt(unused)}
                </bdi>
              </p>
              {advance.channel === "whish" && (
                <p className="warn" data-testid="ref-sheet-whish-note">
                  {t("ref.whishNote")}
                </p>
              )}
              <fieldset disabled={uncertain || busy || reviewing}>
                <label>
                  {t("ref.amount")}
                  <input dir="ltr" value={amountText} onChange={(e) => (setAmountText(e.target.value), edit())} data-testid="ref-amount-input" />
                </label>
                <label>
                  {t("ref.reasonRequired")}
                  <input value={reason} maxLength={200} onChange={(e) => (setReason(e.target.value), edit())} data-testid="ref-reason-input" />
                </label>
              </fieldset>
              {reviewing && amountMinor !== null && (
                <div className="card warn" data-testid="ref-review">
                  <p>
                    <strong>{t("ref.reviewTitle")}</strong>
                  </p>
                  <p>
                    {t("ref.amount")}:{" "}
                    <bdi dir="ltr" data-testid="ref-review-amount">
                      {fmt({ minor: amountMinor.toString(), currency: unused.currency })}
                    </bdi>{" "}
                    · {t("ref.method")}: {t("adv.cash")} · {t("ref.fromAdvance")}: <bdi dir="ltr">{advance.number}</bdi>
                  </p>
                  <p>
                    {t("ref.reason")}: <bdi>{reason.trim()}</bdi>
                  </p>
                  <p className="small">{t("ref.reviewHint")}</p>
                </div>
              )}
              {error && (
                <p className="error" data-testid="ref-error">
                  {error}
                </p>
              )}
              {uncertain && <p className="muted small">{t("adv.retryHint")}</p>}
              <div className="panel-actions">
                {!reviewing ? (
                  <button className="btn primary" disabled={!valid} onClick={() => setReviewing(true)} data-testid="ref-review-open">
                    {t("adv.review")}
                  </button>
                ) : (
                  <button className="btn primary" disabled={busy || !valid} onClick={() => void submit()} data-testid="ref-confirm">
                    {busy ? t("adv.posting") : uncertain ? t("adv.retry") : t("ref.confirm")}
                  </button>
                )}
                {reviewing && !uncertain && (
                  <button className="btn ghost" disabled={busy} onClick={() => setReviewing(false)} data-testid="ref-back">
                    {t("adv.back")}
                  </button>
                )}
                {!uncertain && (
                  <button className="btn ghost" disabled={busy} onClick={() => onClose(false)} data-testid="ref-cancel">
                    {t("collect.cancel")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
