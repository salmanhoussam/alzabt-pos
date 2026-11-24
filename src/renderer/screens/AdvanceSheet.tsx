/**
 * ADV-RECORD-CASH-WHISH (migration 20) — receive a customer advance: form → REVIEW → record → receipt.
 *
 * 🔴 THE REQUEST KEY IS THE ONLY IDENTITY. One key per reviewed request: going back to edit makes a
 *    new key; "try again" after a lost reply re-sends the SAME key, so main answers with the SAME ADV
 *    receipt and the money is never recorded twice. "Same customer, same amount, same day" decides
 *    nothing — a genuine second advance is a new request with a new key.
 * 🔴 THE RECEIPT IS ACKNOWLEDGED ONLY AFTER IT WAS SHOWN. Closing the receipt tells main the
 *    operator saw it; until then a crash leaves it listed under «دفعات لم تُحسم» with its receipt.
 * 🔴 NO AMOUNT IS COMPUTED HERE. The amount typed is parsed once into minor units; every figure on the
 *    receipt is the one main read back from the ledger.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiError, call, errorText, fmt, newIdempotencyKey, pos } from "../api";
import { minorOf } from "./receiptAllocation";
import { stamp } from "../format";
import { useT } from "../i18n";
import type { AdvanceDto } from "../../shared/ipcContract";

export function advanceErrorText(err: unknown, t: (k: string) => string): string {
  if (err instanceof ApiError) {
    const key = `adv.err.${err.code}`;
    const own = t(key);
    if (own !== key) return own;
  }
  return errorText(err);
}

/** Codes that PROVE nothing was written for this request: the operator may edit and try again. */
const REFUSALS = new Set([
  "INVALID_INPUT",
  "INVALID_AMOUNT",
  "NOT_EXACT",
  "MONEY_OUT_OF_RANGE",
  "PAYMENT_METHOD_NOT_ACCEPTED",
  "FUNDS_NOT_CONFIRMED",
  "DUPLICATE_PAYMENT_REFERENCE",
  "PARTY_NOT_FOUND",
  "NOT_AUTHORIZED",
  "NOT_LOGGED_IN",
  "ADVANCE_UNRESOLVED",
  "IDEMPOTENCY_CONFLICT",
]);

export function AdvanceReceipt({ advance, duplicate, onClose }: { advance: AdvanceDto; duplicate: boolean; onClose: () => void }) {
  const { t } = useT();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (err) {
      setNote(advanceErrorText(err, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card receipt adv-receipt" data-testid="adv-receipt" data-adv-number={advance.number}>
      <div className="receipt-ok">
        <span className="receipt-check" aria-hidden="true">✓</span>
        <h2>{t("adv.done")}</h2>
      </div>
      {duplicate && (
        <p className="warn" data-testid="adv-duplicate">
          {t("adv.duplicate")}
        </p>
      )}
      {advance.origin === "correction" && (
        <p className="warn" data-testid="adv-correction-of">
          {t("adv.stmt.correctionOf")} <bdi dir="ltr">{advance.correctsNumber}</bdi>
        </p>
      )}
      <dl className="adv-receipt-fields">
        <dt>{t("adv.number")}</dt>
        <dd data-testid="adv-number">
          <bdi dir="ltr">{advance.number}</bdi>
        </dd>
        <dt>{t("customers.name")}</dt>
        <dd>
          <bdi>{advance.customerName}</bdi>
        </dd>
        <dt>{t("adv.amount")}</dt>
        <dd data-testid="adv-amount">
          <bdi dir="ltr">{fmt(advance.amount)}</bdi>
        </dd>
        <dt>{t("adv.channel")}</dt>
        <dd data-testid="adv-channel">
          {advance.channel === "whish" ? t("adv.whish") : t("adv.cash")}
          {advance.reference && (
            <>
              {" · "}
              <bdi dir="ltr">{advance.reference}</bdi>
            </>
          )}
        </dd>
        <dt>{t("adv.receivedBy")}</dt>
        <dd>
          <bdi>{advance.receivedByName}</bdi>
        </dd>
        <dt>{t("adv.receivedAt")}</dt>
        <dd>
          <bdi dir="ltr">{stamp(advance.receivedAt)}</bdi>
        </dd>
      </dl>
      <p className="muted small">{t("adv.what")}</p>
      {note && (
        <p className="muted" data-testid="adv-print-note">
          {note}
        </p>
      )}
      <div className="panel-actions">
        <button
          className="btn"
          disabled={busy}
          data-testid="adv-print"
          onClick={() =>
            void run(async () => {
              const r = await call(pos().printAdvance({ advanceId: advance.id }));
              return r.status === "printed" ? t("adv.printed") : "";
            })
          }
        >
          {t("adv.print")}
        </button>
        <button
          className="btn"
          disabled={busy}
          data-testid="adv-pdf"
          onClick={() =>
            void run(async () => {
              const r = await call(pos().saveAdvancePdf({ advanceId: advance.id }));
              return r.status === "saved" ? `${t("adv.saved")} ${r.fileName}` : "";
            })
          }
        >
          {t("adv.pdf")}
        </button>
        <button className="btn primary" disabled={busy} onClick={onClose} data-testid="adv-receipt-close">
          {t("adv.close")}
        </button>
      </div>
    </div>
  );
}

export function AdvanceSheet({
  customer,
  onClose,
}: {
  customer: { readonly id: string; readonly displayName: string; readonly isActive: boolean };
  onClose: (recorded: boolean) => void;
}) {
  const { t } = useT();
  // The terminal's currency, only to parse the typed amount; main decides the stored currency itself.
  const [currency, setCurrency] = useState<string>("");
  useEffect(() => {
    call(pos().getCatalog())
      .then((c) => setCurrency(c.currency))
      .catch(() => setCurrency(""));
  }, []);
  const [step, setStep] = useState<"form" | "review" | "done">("form");
  const [amountText, setAmountText] = useState("");
  const [channel, setChannel] = useState<"cash" | "whish">("cash");
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the reply was lost: the same key must be re-sent, nothing may be edited. */
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<{ advance: AdvanceDto; duplicate: boolean } | null>(null);

  const minor = useMemo(() => (currency === "" ? null : minorOf(amountText, currency)), [amountText, currency]);
  const formError =
    minor === null || minor <= 0n
      ? t("adv.err.INVALID_AMOUNT")
      : channel === "whish" && reference.trim() === ""
        ? t("adv.err.reference")
        : channel === "whish" && !confirmed
          ? t("adv.err.FUNDS_NOT_CONFIRMED")
          : null;

  const edit = () => {
    // Any edit is a NEW request (a new key) — never while the previous one's outcome is unknown.
    setKey(newIdempotencyKey());
    setError(null);
  };

  const submit = async () => {
    if (minor === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call(
        pos().recordAdvance({
          customerId: customer.id,
          amountMinor: minor.toString(),
          channel,
          reference: channel === "whish" ? reference.trim() : null,
          fundsConfirmed: channel === "whish" ? confirmed : false,
          idempotencyKey: key,
        }),
      );
      setResult(r);
      setUncertain(false);
      setStep("done");
    } catch (err) {
      setError(advanceErrorText(err, t));
      // A proven refusal wrote nothing: back to editing. Anything else may have committed: retry SAME key.
      setUncertain(!(err instanceof ApiError && REFUSALS.has(err.code)));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (result) {
      try {
        await call(pos().acknowledgeAdvance({ idempotencyKey: key }));
      } catch {
        // Not fatal: an unacknowledged receipt stays listed as "recorded" with its receipt — never lost.
      }
    }
    onClose(result !== null);
  };

  if (!customer.isActive) {
    return (
      <div className="overlay" role="dialog" aria-modal="true" data-testid="adv-sheet">
        <div className="panel">
          <p className="error">{t("adv.inactive")}</p>
          <button className="btn ghost" onClick={() => onClose(false)}>
            {t("adv.close")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="adv-sheet" data-step={step}>
      <div className="panel customer-panel">
        <header className="panel-head">
          <h2>
            {t("adv.title")} — <bdi>{customer.displayName}</bdi>
          </h2>
        </header>

        {step === "form" && (
          <form
            className="customer-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (formError === null) setStep("review");
            }}
          >
            <p className="muted small">{t("adv.what")}</p>
            <label>
              {t("adv.amount")} ({currency})
              <input
                data-testid="adv-amount-input"
                inputMode="decimal"
                dir="ltr"
                value={amountText}
                autoFocus
                onChange={(e) => {
                  setAmountText(e.target.value);
                  edit();
                }}
              />
            </label>
            <fieldset className="adv-channel">
              <legend>{t("adv.channel")}</legend>
              {(["cash", "whish"] as const).map((c) => (
                <label key={c}>
                  <input
                    type="radio"
                    name="adv-channel"
                    data-testid={`adv-channel-${c}`}
                    checked={channel === c}
                    onChange={() => {
                      setChannel(c);
                      edit();
                    }}
                  />
                  {c === "cash" ? t("adv.cash") : t("adv.whish")}
                </label>
              ))}
            </fieldset>
            {channel === "whish" && (
              <>
                <label>
                  {t("adv.reference")}
                  <input
                    data-testid="adv-reference-input"
                    dir="ltr"
                    value={reference}
                    onChange={(e) => {
                      setReference(e.target.value);
                      edit();
                    }}
                  />
                </label>
                <label className="collect-confirm-funds">
                  <input
                    type="checkbox"
                    data-testid="adv-funds-confirmed"
                    checked={confirmed}
                    onChange={(e) => {
                      setConfirmed(e.target.checked);
                      edit();
                    }}
                  />
                  <span className="collect-confirm-text">
                    <span>{t("collect.fundsConfirmed")}</span>
                  </span>
                </label>
              </>
            )}
            {amountText.trim() !== "" && formError && (
              <p className="error small" data-testid="adv-form-error">
                {formError}
              </p>
            )}
            {error && (
              <p className="error" data-testid="adv-error">
                {error}
              </p>
            )}
            <div className="panel-actions">
              <button className="btn primary" type="submit" disabled={formError !== null} data-testid="adv-review">
                {t("adv.review")}
              </button>
              <button className="btn ghost" type="button" onClick={() => onClose(false)} data-testid="adv-cancel">
                {t("collect.cancel")}
              </button>
            </div>
          </form>
        )}

        {step === "review" && minor !== null && (
          <div data-testid="adv-review-step">
            <h3>{t("adv.reviewTitle")}</h3>
            <dl className="adv-receipt-fields">
              <dt>{t("customers.name")}</dt>
              <dd>
                <bdi>{customer.displayName}</bdi>
              </dd>
              <dt>{t("adv.amount")}</dt>
              <dd data-testid="adv-review-amount">
                <bdi dir="ltr">{fmt({ minor: minor.toString(), currency })}</bdi>
              </dd>
              <dt>{t("adv.channel")}</dt>
              <dd data-testid="adv-review-channel">
                {channel === "whish" ? t("adv.whish") : t("adv.cash")}
                {channel === "whish" && (
                  <>
                    {" · "}
                    <bdi dir="ltr">{reference.trim()}</bdi>
                  </>
                )}
              </dd>
            </dl>
            <p className="warn small">{t("adv.reviewHint")}</p>
            {error && (
              <p className="error" data-testid="adv-error">
                {error}
              </p>
            )}
            {uncertain && (
              <p className="muted small" data-testid="adv-retry-hint">
                {t("adv.retryHint")}
              </p>
            )}
            <div className="panel-actions">
              <button className="btn primary" disabled={busy} onClick={() => void submit()} data-testid="adv-confirm">
                {busy ? t("adv.posting") : uncertain ? t("adv.retry") : t("adv.confirm")}
              </button>
              {!uncertain && (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    setStep("form");
                    edit();
                  }}
                  data-testid="adv-back"
                >
                  {t("adv.back")}
                </button>
              )}
            </div>
          </div>
        )}

        {step === "done" && result && <AdvanceReceipt advance={result.advance} duplicate={result.duplicate} onClose={() => void finish()} />}
      </div>
    </div>
  );
}
