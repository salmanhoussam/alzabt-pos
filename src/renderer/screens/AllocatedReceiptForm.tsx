/**
 * M17B-S1 — ONE real Whish or bank-transfer payment shared across TWO OR MORE debts of ONE customer.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE PLACE THIS SCREEN ADDS UP MONEY, AND WHY IT IS ONLY A SCREEN AID. "Left to allocate" is
 * the total minus the shares typed so far, so the owner can see when the shares are complete. It is
 * computed in BIGINT minor units with the domain's own `parseDecimal`/`formatDecimal` and decides
 * nothing: Confirm stays disabled until it reaches exactly zero, but the rule that matters — the
 * shares equal the total EXACTLY, one customer, one currency, no debt twice, nothing over what is
 * owed, one reference once — is enforced again in main and again by the database. A wrong figure
 * here can only make the owner's own screen disagree with the ledger, never change the ledger.
 *
 * 🔴 ONE KEY PER ATTEMPT, REPLACED WHEN ANYTHING THAT DEFINES THE PAYMENT CHANGES (total, share,
 * reference, provider, confirmation), RETAINED ACROSS A FAILURE so a retry replays the same key. An
 * outcome that is UNKNOWN locks this form (fields, Cancel and Confirm) until the ledger answers.
 *
 * 🔴 THE REFERENCE IS THE PROVIDER'S OWN, ONCE. This form has a single reference field; there is no
 * way to type a per-debt reference, and nothing here derives one.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import { ApiError, call, errorText, fmt, newIdempotencyKey, pos } from "../api";
import { formatDecimal, money } from "../../domain/money";
import { type ReceiptReconciliation, allocationState, sharableCurrencies } from "./receiptAllocation";
import { useT } from "../i18n";
import type { AllocatedReceiptRequest, CustomerStatementDto, StatementObligationDto } from "../../shared/ipcContract";

/** The two outcomes after which a second recording must NOT be offered (same as a collection). */
const UNSAFE_TO_RETRY: ReadonlySet<string> = new Set(["PAYMENT_RECORDED", "PAYMENT_STATUS_UNKNOWN"]);
const OWN_CODES: ReadonlySet<string> = new Set(["RECEIPT_ALLOCATION_MISMATCH", "RECEIPT_NEEDS_TWO_DEBTS", "RECEIPT_CHANNEL_NOT_ALLOWED"]);
const COLLECT_CODES: ReadonlySet<string> = new Set(["FUNDS_NOT_CONFIRMED", "DUPLICATE_PAYMENT_REFERENCE", "COLLECTION_UNRESOLVED"]);

type Provider = "whish" | "bank_transfer";

interface Props {
  readonly customerId: string;
  readonly statement: CustomerStatementDto;
  /** The statement main recomputed after the commit; the parent swaps it in whole. */
  readonly onRecorded: (statement: CustomerStatementDto, duplicate: boolean) => void;
  readonly onClose: () => void;
  /**
   * Asks the ledger (through a fresh statement) what became of an attempt. READ-ONLY: it never sends a
   * receipt. `recorded` carries the statement that proves it, so the form can leave safely.
   */
  readonly onAskLedger: (
    key: string,
    request: AllocatedReceiptRequest,
  ) => Promise<{ readonly status: ReceiptReconciliation; readonly statement: CustomerStatementDto | null }>;
}

export function AllocatedReceiptForm({ customerId, statement, onRecorded, onClose, onAskLedger }: Props) {
  const { t } = useT();
  const currencies = useMemo(() => sharableCurrencies(statement), [statement]);
  const [currency, setCurrency] = useState<string>(currencies[0] ?? "");
  const [provider, setProvider] = useState<Provider>("whish");
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [totalText, setTotalText] = useState("");
  const [shares, setShares] = useState<Record<string, string>>({});
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debts: StatementObligationDto[] = statement.obligations.filter((o) => !o.fullyPaid && o.outstanding.currency === currency);
  const edited = () => {
    setError(null);
    setAttemptKey(newIdempotencyKey());
  };

  const state = allocationState(
    currency,
    totalText,
    debts.map((d) => ({ id: d.id, text: shares[d.id] ?? "" })),
  );
  const { total, typed: typedShares, left, complete } = state;

  const errorFor = (err: unknown): string => {
    if (err instanceof ApiError && OWN_CODES.has(err.code)) return t(`allocReceipt.err.${err.code}`);
    if (err instanceof ApiError && COLLECT_CODES.has(err.code)) return t(`collect.err.${err.code}`);
    return errorText(err);
  };

  const submit = async () => {
    if (busy || blocked) return;
    if (reference.trim() === "") {
      setError(t("collect.referenceRequired"));
      return;
    }
    if (!confirmed) {
      setError(t("collect.confirmRequired"));
      return;
    }
    if (!complete || total === null) {
      setError(t("allocReceipt.err.RECEIPT_ALLOCATION_MISMATCH"));
      return;
    }
    const request: AllocatedReceiptRequest = {
      customerId,
      idempotencyKey: attemptKey,
      channel: provider,
      reference: reference.trim(),
      fundsConfirmed: confirmed,
      currency,
      totalMinor: total.toString(),
      allocations: typedShares.map((s) => ({ obligationId: s.id, amountMinor: (s.minor as bigint).toString() })),
    };
    setBusy(true);
    setError(null);
    try {
      const result = await call(pos().recordAllocatedReceipt(request));
      onRecorded(result.statement, result.duplicate);
    } catch (err) {
      setError(errorFor(err));
      // 🔴 THE KEY IS NOT REGENERATED: retrying the same payment replays the same key.
      if (err instanceof ApiError && UNSAFE_TO_RETRY.has(err.code)) {
        setBlocked(true);
        const answer = await onAskLedger(attemptKey, request);
        // 🔴 ONLY AN AUTHORITATIVE ANSWER RELEASES THE LOCK, and never by sending anything:
        //   · "recorded"      the ledger shows exactly this receipt → leave through the existing duplicate outcome;
        //   · "not_recorded"  the ledger was read and holds none → the exact retry is offered again;
        //   · unknown / conflict / absent (and any failed lookup) → stay blocked. "absent" is a lack of evidence.
        if (answer.status === "recorded" && answer.statement !== null) {
          onRecorded(answer.statement, true);
          return;
        }
        if (answer.status === "not_recorded") setBlocked(false);
      }
    } finally {
      setBusy(false);
    }
  };

  if (currencies.length === 0) {
    return (
      <div className="collect-form" data-testid="receipt-form">
        <h4>{t("allocReceipt.title")}</h4>
        <p className="muted" data-testid="receipt-needs-two">
          {t("allocReceipt.needsTwo")}
        </p>
        <button className="btn ghost" type="button" onClick={onClose} data-testid="receipt-cancel">
          {t("collect.cancel")}
        </button>
      </div>
    );
  }

  return (
    <form
      className="collect-form"
      data-testid="receipt-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h4>{t("allocReceipt.title")}</h4>
      <p className="muted small" data-testid="receipt-hint">
        {t("allocReceipt.hint")}
      </p>
      <label>
        <span className="muted">{t("allocReceipt.currency")}</span>
        <select
          data-testid="receipt-currency"
          value={currency}
          disabled={blocked || busy || currencies.length === 1}
          onChange={(e) => {
            setCurrency(e.target.value);
            setShares({});
            setTotalText("");
            edited();
          }}
        >
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="muted">{t("collect.method")}</span>
        <select
          data-testid="receipt-method"
          value={provider}
          disabled={blocked || busy}
          onChange={(e) => {
            setProvider(e.target.value as Provider);
            setConfirmed(false);
            edited();
          }}
        >
          <option value="whish">{t("collect.method.whish")}</option>
          <option value="bank_transfer">{t("collect.method.bank_transfer")}</option>
        </select>
      </label>
      <label>
        <span className="muted">{t("collect.paymentReference")}</span>
        <input
          data-testid="receipt-reference"
          type="text"
          dir="ltr"
          maxLength={64}
          value={reference}
          disabled={blocked || busy}
          onChange={(e) => {
            setReference(e.target.value);
            edited();
          }}
        />
        <span className="muted small">{t("collect.referenceHint")}</span>
      </label>
      <label>
        <span className="muted">{t("allocReceipt.total")}</span>
        <input
          data-testid="receipt-total"
          type="text"
          inputMode="decimal"
          dir="ltr"
          value={totalText}
          disabled={blocked || busy}
          onChange={(e) => {
            setTotalText(e.target.value);
            edited();
          }}
        />
      </label>
      <ul className="statement-obligations" data-testid="receipt-debts">
        {debts.map((d) => (
          <li key={d.id} data-testid="receipt-debt" data-obligation={d.id}>
            <div className="statement-row">
              <bdi dir="ltr">{d.sourceRef}</bdi>
              <span className="muted small">
                {t("statement.outstanding")} <bdi dir="ltr">{fmt(d.outstanding)}</bdi>
              </span>
            </div>
            <label>
              <span className="muted small">{t("allocReceipt.share")}</span>
              <input
                data-testid="receipt-share"
                type="text"
                inputMode="decimal"
                dir="ltr"
                value={shares[d.id] ?? ""}
                disabled={blocked || busy}
                onChange={(e) => {
                  setShares({ ...shares, [d.id]: e.target.value });
                  edited();
                }}
              />
            </label>
          </li>
        ))}
      </ul>
      <p data-testid="receipt-left" data-complete={complete ? "yes" : "no"}>
        <span className="muted">{t("allocReceipt.left")}</span>:{" "}
        <strong>
          <bdi dir="ltr">{left === null ? "—" : `${formatDecimal(money(left, currency))} ${currency}`}</bdi>
        </strong>
      </p>
      <label className="collect-confirm-funds">
        <input
          data-testid="receipt-funds-confirmed"
          type="checkbox"
          checked={confirmed}
          disabled={blocked || busy}
          onChange={(e) => {
            setConfirmed(e.target.checked);
            edited();
          }}
        />{" "}
        <span>{t("collect.fundsConfirmed")}</span>
        <span className="muted small"> {t("collect.fundsHint")}</span>
      </label>
      {error !== null && (
        <p className="error" data-testid="receipt-error">
          {error}
        </p>
      )}
      <div className="panel-actions">
        {!blocked && (
          <button className="btn" type="submit" disabled={busy || !complete} data-testid="receipt-confirm">
            {busy ? t("collect.posting") : t("collect.confirm")}
          </button>
        )}
        <button className="btn ghost" type="button" onClick={onClose} disabled={blocked || busy} data-testid="receipt-cancel">
          {t("collect.cancel")}
        </button>
      </div>
    </form>
  );
}
