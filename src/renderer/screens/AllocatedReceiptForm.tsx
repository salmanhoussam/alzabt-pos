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
 *
 * 🔴 M17B-ALLOC-DEFAULT (ACC-3): OLDEST DEBT FIRST UNTIL THE OWNER TAKES OVER. While the shares are
 * automatic they are re-proposed from the total every time it changes (`oldestFirstShares`). The
 * first share the owner edits switches the form to MANUAL, and from then on nothing here rewrites a
 * share; only the explicit «re-distribute» action returns to automatic. Either way it is a proposal:
 * Confirm still needs exact completion, and main re-validates everything.
 *
 * 🔴 A TOTAL THAT LANDS ON ONE DEBT IS NOT A SHARED RECEIPT. Main refuses fewer than two debts, so the
 * form never sends one: it says so and offers the existing single-debt payment for that debt, with
 * the amount, method and reference carried over and the funds confirmation NOT carried (asked again).
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useRef, useState } from "react";
import { ApiError, call, errorText, fmt, newIdempotencyKey, pos } from "../api";
import { formatDecimal, money } from "../../domain/money";
import { type ReceiptReconciliation, allocationState, leftText, minorOf, oldestFirstShares, openDebtsOf, sharableCurrencies } from "./receiptAllocation";
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
   * ACC-3: the whole total lands on ONE debt, which a shared receipt cannot record. The parent closes
   * this form and opens the single-debt payment for that debt with these details. Nothing is sent here.
   */
  readonly onUseSingleDebt: (prefill: {
    readonly obligationId: string;
    readonly amountText: string;
    readonly method: Provider;
    readonly reference: string;
  }) => void;
  /**
   * Asks the ledger (through a fresh statement) what became of an attempt. READ-ONLY: it never sends a
   * receipt. `recorded` carries the statement that proves it, so the form can leave safely.
   */
  readonly onAskLedger: (
    key: string,
    request: AllocatedReceiptRequest,
  ) => Promise<{ readonly status: ReceiptReconciliation; readonly statement: CustomerStatementDto | null }>;
}

export function AllocatedReceiptForm({ customerId, statement, onRecorded, onClose, onUseSingleDebt, onAskLedger }: Props) {
  const { t } = useT();
  const currencies = useMemo(() => sharableCurrencies(statement), [statement]);
  const [currency, setCurrency] = useState<string>(currencies[0] ?? "");
  const [provider, setProvider] = useState<Provider>("whish");
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  /** QW-COLLECT-TITLE: set only when Confirm found the "money received" box unticked; cleared by the box. */
  const [confirmMissing, setConfirmMissing] = useState(false);
  const confirmBoxRef = useRef<HTMLInputElement | null>(null);
  const [totalText, setTotalText] = useState("");
  const [shares, setShares] = useState<Record<string, string>>({});
  /** False while the shares are the oldest-first proposal; true once the owner edits any share. */
  const [manual, setManual] = useState(false);
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Oldest first (`posted_at`, then id), the order the shares are proposed AND shown in.
  const open = openDebtsOf(statement, currency);
  const byId = new Map(statement.obligations.map((o) => [o.id, o]));
  const debts: StatementObligationDto[] = open.map((d) => byId.get(d.id) as StatementObligationDto);
  const owed = new Map(open.map((d) => [d.id, d.outstandingMinor]));
  const owedTotal = open.reduce((acc, d) => acc + d.outstandingMinor, 0n);
  const edited = () => {
    setError(null);
    setAttemptKey(newIdempotencyKey());
  };

  const typedTotal = minorOf(totalText, currency);
  const proposal = manual || typedTotal === null ? null : oldestFirstShares(typedTotal, open);
  /** What each share field shows: the owner's own figures, or the oldest-first proposal. */
  const shown: Record<string, string> =
    proposal === null
      ? manual
        ? shares
        : {}
      : Object.fromEntries(proposal.shares.map((p) => [p.id, formatDecimal(money(p.minor, currency))]));

  const state = allocationState(
    currency,
    totalText,
    debts.map((d) => ({ id: d.id, text: shown[d.id] ?? "" })),
    owed,
  );
  const { total, typed: typedShares, left, complete, overDebt, singleDebt } = state;
  const totalInvalid = totalText.trim() !== "" && (total === null || total <= 0n);
  const overOwed = total !== null && total > owedTotal;

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
      // 🔴 QW-COLLECT-TITLE: SHOW WHERE, NEVER TICK. Nothing was sent; the box is focused, highlighted
      // and explained, and the total, shares, method and reference stay exactly as typed.
      setError(t("collect.confirmRequired"));
      setConfirmMissing(true);
      confirmBoxRef.current?.focus();
      confirmBoxRef.current?.scrollIntoView({ block: "nearest" });
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
            setManual(false);
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
            setConfirmMissing(false);
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
      {totalInvalid && (
        <p className="error" data-testid="receipt-invalid-total">
          {t("collect.invalidAmount")}
        </p>
      )}
      {overOwed && (
        <p className="error" data-testid="receipt-over-outstanding">
          {t("allocReceipt.overOutstanding")}
        </p>
      )}
      <div className="receipt-mode" data-testid="receipt-mode" data-mode={manual ? "manual" : "auto"}>
        <span className="muted small">{manual ? t("allocReceipt.manualNote") : t("allocReceipt.autoNote")}</span>
        {manual && (
          <button
            className="btn ghost small"
            type="button"
            disabled={blocked || busy}
            onClick={() => {
              setManual(false);
              setShares({});
              edited();
            }}
            data-testid="receipt-auto-reset"
          >
            {t("allocReceipt.autoReset")}
          </button>
        )}
      </div>
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
                value={shown[d.id] ?? ""}
                disabled={blocked || busy}
                aria-invalid={overDebt.includes(d.id)}
                onChange={(e) => {
                  // The first edit takes over from the proposal: what was shown becomes the owner's own.
                  setShares({ ...shown, [d.id]: e.target.value });
                  setManual(true);
                  edited();
                }}
              />
            </label>
            {overDebt.includes(d.id) && (
              <p className="error small" data-testid="receipt-share-over">
                {t("allocReceipt.shareOverDebt")}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p data-testid="receipt-left" data-complete={complete ? "yes" : "no"}>
        <span className="muted">{t("allocReceipt.left")}</span>:{" "}
        <strong>
          <bdi dir="ltr">{leftText(left, currency)}</bdi>
        </strong>
      </p>
      {left !== null && left < 0n && (
        <p className="error" data-testid="receipt-over-total">
          {t("allocReceipt.err.RECEIPT_ALLOCATION_MISMATCH")}
        </p>
      )}
      {singleDebt !== null && (
        <div className="receipt-single" data-testid="receipt-single-debt" data-obligation={singleDebt}>
          <p className="muted">{t("allocReceipt.singleDebt")}</p>
          <button
            className="btn ghost"
            type="button"
            disabled={blocked || busy}
            onClick={() => onUseSingleDebt({ obligationId: singleDebt, amountText: totalText.trim(), method: provider, reference })}
            data-testid="receipt-use-single"
          >
            {t("allocReceipt.useSingle")}
          </button>
        </div>
      )}
      <label className={`collect-confirm-funds${confirmMissing ? " missing" : ""}`} data-missing={confirmMissing ? "1" : "0"}>
        <input
          ref={confirmBoxRef}
          data-testid="receipt-funds-confirmed"
          type="checkbox"
          checked={confirmed}
          disabled={blocked || busy}
          aria-invalid={confirmMissing}
          aria-describedby={confirmMissing ? "receipt-confirm-missing" : undefined}
          onChange={(e) => {
            setConfirmed(e.target.checked);
            setConfirmMissing(false);
            edited();
          }}
        />{" "}
        <span>{t("collect.fundsConfirmed")}</span>
        <span className="muted small"> {t("collect.fundsHint")}</span>
      </label>
      {confirmMissing && (
        <p className="error small" id="receipt-confirm-missing" role="alert" data-testid="receipt-confirm-missing">
          {t("collect.confirmMissing")}
        </p>
      )}
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
