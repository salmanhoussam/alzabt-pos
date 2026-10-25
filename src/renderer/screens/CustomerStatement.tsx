/**
 * One customer's account statement. Owner-only, and READ-ONLY.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS COMPONENT DOES NO MONEY ARITHMETIC. Not one addition, not one subtraction, no rounding
 * and no "0.00" substituted for a missing value. Every figure it prints — each amount, each
 * outstanding balance, each per-currency total — was computed by `LedgerService` in the main
 * process from the posted rows and arrived already formed. A screen that recomputed a balance
 * would be a second definition of what a customer owes, and the first time the two disagreed
 * nobody could say which was right.
 *
 * 🔴 AN EMPTY STATEMENT SAYS "NO POSTED DEBTS", NOT "0.00". Those are different claims. A zero is
 * an accounting statement; "nothing has been posted" is the truth about a ledger nobody has
 * written to. Printing the former would be this screen inventing the shop's books.
 *
 * 🔴 BALANCES ARE LISTED PER CURRENCY AND NEVER ADDED. There is no exchange rate anywhere in this
 * product. A customer owing 50 USD and 2,000,000 LBP owes exactly that — two facts, two lines.
 *
 * 🔴 S3C: IT CAN NOW RECORD A PAYMENT, AND IT STILL CANNOT CREATE A DEBT. The old header said
 * "IT CANNOT WRITE", true while `getCustomerStatement` was the only channel it held. It now also
 * calls `recordCustomerPayment`, which settles an EXISTING obligation. There is still no channel
 * anywhere on this bridge that posts an obligation, so the amount a customer owes can only ever go
 * down from this screen — and opening or refreshing it still writes nothing at all.
 *
 * 🔴 AND IT STILL DOES NO MONEY ARITHMETIC, INCLUDING AFTER A PAYMENT. The new balance is not the
 * old one minus what was just paid; it is the statement main recomputed from the ledger after the
 * commit and returned with the result, which this screen swaps in whole. The typed amount is
 * turned into minor units by the domain's own `parseDecimal`, not by arithmetic written here.
 *
 * 🔴 ONE IDEMPOTENCY KEY PER ATTEMPT, RETAINED ACROSS A FAILURE. If the response is lost after the
 * commit, retrying the same amount replays the same key and the ledger returns the payment it
 * already took, flagged `duplicate` — the shop is told the money went in once, never twice. The
 * key is replaced only when the amount is edited, because that is a different payment.
 *
 * The owner gate is NOT this component rendering or not: `channelPolicy` classifies BOTH
 * `getCustomerStatement` and `recordCustomerPayment` as "owner" and `LedgerService.requireOwner`
 * re-reads the live role, so a cashier calling either directly is refused. Not rendering the panel
 * merely avoids offering something that would be refused.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useState } from "react";
import { ApiError, call, errorText, fmt, newIdempotencyKey, pos } from "../api";
import { parseDecimal } from "../../domain/money";
import { useT } from "../i18n";
import { AllocatedReceiptForm } from "./AllocatedReceiptForm";
import { type ReceiptReconciliation, reconcileReceiptOutcome, sharableCurrencies } from "./receiptAllocation";
import type {
  AllocatedReceiptRequest,
  PendingReceiptDto,
  CollectionMethodDto,
  CustomerStatementDto,
  PendingCollectionDto,
  RecordPaymentRequest,
  StatementObligationDto,
} from "../../shared/ipcContract";

/**
 * 🔴 THE TWO OUTCOMES AFTER WHICH A SECOND COLLECTION MUST NOT BE OFFERED.
 *
 * `PAYMENT_RECORDED` means main read the ledger and the money IS in it. `PAYMENT_STATUS_UNKNOWN`
 * means even the lookup failed, so nobody knows. In both cases the sentence main composed already
 * says "do not collect it again" — and this screen backs that up by REMOVING the confirm button,
 * because a message telling someone not to press a button that is still sitting there is an
 * invitation with a disclaimer. Only `PAYMENT_NOT_RECORDED` (the retry half, where the ledger
 * answered "no such payment") leaves the button in place.
 */
const UNSAFE_TO_RETRY: ReadonlySet<string> = new Set(["PAYMENT_RECORDED", "PAYMENT_STATUS_UNKNOWN"]);

const COLLECTION_METHODS: ReadonlyArray<CollectionMethodDto> = ["cash", "card", "whish", "bank_transfer", "other"];

interface Props {
  readonly customerId: string;
}

export function CustomerStatement({ customerId }: Props) {
  const { t } = useT();
  /** Own sentences for this slice's refusals (own codes, so the refusal-audit rules are untouched). */
  const collectErrorText = (err: unknown): string => {
    if (err instanceof ApiError && (err.code === "FUNDS_NOT_CONFIRMED" ||
        err.code === "DUPLICATE_PAYMENT_REFERENCE" ||
        err.code === "COLLECTION_UNRESOLVED")) {
      return t(`collect.err.${err.code}`);
    }
    return errorText(err);
  };
  const [statement, setStatement] = useState<CustomerStatementDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which debt the owner is collecting against, or null when no form is open. */
  const [payingId, setPayingId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  /** Migration 17. HOW the money arrived; part of what an attempt IS, exactly like the amount. */
  const [method, setMethod] = useState<CollectionMethodDto>("cash");
  const [reference, setReference] = useState("");
  /** Explicit, per attempt, never remembered: "the money really arrived". */
  const [confirmed, setConfirmed] = useState(false);
  /**
   * 🔴 ONE KEY PER ATTEMPT, AND THE AMOUNT IS PART OF WHAT AN ATTEMPT IS. Exactly SellScreen's
   * convention, which replaces its key when the cart changes. Retained across a failed submit, so
   * retrying the SAME amount replays the SAME key and the ledger hands back the payment it already
   * committed instead of taking the money twice. Replaced when the amount is edited, because that
   * is a different payment and must not collide with the first under one key.
   */
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState<"done" | "duplicate" | "receipt" | null>(null);
  /** M17B-S1: whether the "one payment for several debts" form is open. */
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);

  const resetPaymentDetails = () => {
    setMethod("cash");
    setReference("");
    setConfirmed(false);
  };

  const closeForm = () => {
    // A recorded/unknown payment needs authoritative reconciliation, not a fresh attempt key.
    if (blocked || busy) return;
    setPayingId(null);
    resetPaymentDetails();
    setAmountText("");
    setPayError(null);
    setBlocked(false);
    setAttemptKey(newIdempotencyKey());
  };

  const openForm = (obligationId: string) => {
    // Do not clear an unresolved payment by switching to another obligation in this statement.
    if (blocked || busy) return;
    setPayingId(obligationId);
    resetPaymentDetails();
    setAmountText("");
    setPayError(null);
    setBlocked(false);
    setNotice(null);
    setAttemptKey(newIdempotencyKey());
  };

  const submit = async (o: StatementObligationDto) => {
    // 🔴 THE DOUBLE-SUBMIT GUARD. `busy` is set before the await and cleared only in `finally`, so
    // a second click, an Enter key or an impatient double-tap while the first post is in flight
    // returns here and never reaches the bridge.
    if (busy || blocked) return;
    let amountMinor: string;
    try {
      // 🔴 THE DOMAIN'S OWN PARSER, not arithmetic written here. It decides what a typed amount
      // means, in the obligation's currency, and throws on anything that is not a plain decimal.
      const parsed = parseDecimal(amountText.trim(), o.outstanding.currency);
      if (parsed.minor <= 0n) {
        setPayError(t("collect.invalidAmount"));
        return;
      }
      amountMinor = parsed.minor.toString();
    } catch {
      setPayError(t("collect.invalidAmount"));
      return;
    }
    // 🔴 THE RULES ARE THE MAIN PROCESS'S; THESE ARE ONLY EARLY, HONEST REFUSALS in the owner's
    // language. A non-cash payment is recorded only once the owner says the money arrived — this
    // till never contacts Whish or a bank — and a traceable one needs its reference.
    const needsReference = method === "whish" || method === "bank_transfer" || method === "other";
    const needsConfirmation = needsReference;
    if (needsReference && reference.trim() === "") {
      setPayError(t("collect.referenceRequired"));
      return;
    }
    if (needsConfirmation && !confirmed) {
      setPayError(t("collect.confirmRequired"));
      return;
    }
    await post({
      customerId,
      obligationId: o.id,
      idempotencyKey: attemptKey,
      amountMinor,
      method,
      reference: method === "cash" ? null : reference.trim() === "" ? null : reference.trim(),
      fundsConfirmed: needsConfirmation ? confirmed : false,
    });
  };

  /**
   * The one place a collection is sent — a fresh one from the form, or the EXACT repeat of an
   * attempt the ledger says was not recorded (same key, same payload, taken from the ledger's own
   * record of the intent, never from this screen's memory).
   */
  const post = async (payload: RecordPaymentRequest) => {
    setBusy(true);
    setPayError(null);
    try {
      const result = await call(pos().recordCustomerPayment(payload));
      // 🔴 THE STATEMENT IS REPLACED, NEVER PATCHED. Main recomputed it from the ledger after the
      // commit, so nothing here subtracts a payment from a balance.
      setStatement(result.statement);
      setNotice(result.duplicate ? "duplicate" : "done");
      setPayingId(null);
      setAmountText("");
      setAttemptKey(newIdempotencyKey());
    } catch (err) {
      setPayError(collectErrorText(err));
      // 🔴 THE KEY IS NOT REGENERATED HERE. Retrying the same amount must replay the same key.
      if (err instanceof ApiError && UNSAFE_TO_RETRY.has(err.code)) {
        setBlocked(true);
        // 🔴 AND THE LEDGER IS ASKED, rather than the owner being left to guess. The statement carries
        // every collection still open with what the ledger says about it; an attempt that has closed
        // (its settlement committed) simply is not there any more.
        await resolveFromLedger(payload.idempotencyKey, err.code === "PAYMENT_RECORDED" ? "recorded" : "unknown");
      }
    } finally {
      setBusy(false);
    }
  };

  /** Leaves the form after the ledger has answered; the lock is released ONLY by an answer. */
  const releaseAfterAnswer = () => {
    setBlocked(false);
    setPayError(null);
    setPayingId(null);
    resetPaymentDetails();
    setAmountText("");
    setAttemptKey(newIdempotencyKey());
  };

  const resolveFromLedger = async (key: string, priorOutcome: "recorded" | "unknown") => {
    try {
      const next = await call(pos().getCustomerStatement({ customerId }));
      setStatement(next);
      const open = next.pendingCollections.find((p) => p.idempotencyKey === key);
      if (!open) {
        // No OPEN attempt does not prove that a settlement exists: the intent may have failed
        // before it was persisted, or it may have been closed as NOT recorded. Only the earlier
        // authoritative PAYMENT_RECORDED response justifies an "already recorded" notice here.
        // When the prior lookup failed, keep the lock and the UNKNOWN warning for manual review.
        if (priorOutcome === "recorded") {
          releaseAfterAnswer();
          setNotice("duplicate");
        }
      } else if (open.status === "recorded") {
        releaseAfterAnswer();
        setNotice("duplicate");
      } else if (open.status === "not_recorded") {
        // The ledger WAS read and holds nothing: the banner offers the exact repeat, and a new
        // payment is allowed because the earlier one is provably not recorded.
        releaseAfterAnswer();
      }
      // unknown / conflict: stay blocked. The lookup failing is never read as "not recorded".
    } catch {
      /* the lookup failed: stay blocked */
    }
  };

  /** The EXACT payment again: the ledger's own record of the intent, under the ORIGINAL key. */
  const repeatPending = async (p: PendingCollectionDto) => {
    if (busy) return;
    const customer = customerId;
    await post({
      customerId: customer,
      obligationId: p.obligationId,
      idempotencyKey: p.idempotencyKey,
      amountMinor: p.amount.minor,
      method: p.method,
      reference: p.reference,
      fundsConfirmed: p.fundsConfirmed === true,
    });
  };

  /**
   * Asks the ledger (through a fresh statement) what became of ONE receipt attempt. READ-ONLY: it never sends
   * a receipt. The answer comes from `reconcileReceiptOutcome`, which treats a lookup that failed as
   * "unknown" and a missing open attempt as "absent" (no evidence), never as "not recorded".
   */
  const askLedgerAboutReceipt = async (
    key: string,
    request: AllocatedReceiptRequest,
  ): Promise<{ status: ReceiptReconciliation; statement: CustomerStatementDto | null }> => {
    try {
      const next = await call(pos().getCustomerStatement({ customerId }));
      setStatement(next);
      return { status: reconcileReceiptOutcome(next, key, request), statement: next };
    } catch {
      return { status: "unknown", statement: null }; // a failed lookup is never "not recorded"
    }
  };

  /** The EXACT receipt again: the ledger's own record of the intent, under the ORIGINAL key. */
  const repeatPendingReceipt = async (p: PendingReceiptDto) => {
    if (receiptBusy) return;
    setReceiptBusy(true);
    const request: AllocatedReceiptRequest = {
      customerId,
      idempotencyKey: p.idempotencyKey,
      channel: p.provider,
      reference: p.reference,
      fundsConfirmed: true,
      currency: p.total.currency,
      totalMinor: p.total.minor,
      allocations: p.allocations.map((a) => ({ obligationId: a.obligationId, amountMinor: a.amount.minor })),
    };
    try {
      const result = await call(pos().recordAllocatedReceipt(request));
      setStatement(result.statement);
      setNotice("receipt");
    } catch (err) {
      setPayError(collectErrorText(err));
      // The failure may have followed a COMMIT: ask the ledger, and if exactly this receipt is in it say so.
      const answer = await askLedgerAboutReceipt(p.idempotencyKey, request);
      if (answer.status === "recorded") {
        setPayError(null);
        setNotice("duplicate");
      }
    } finally {
      setReceiptBusy(false);
    }
  };

  useEffect(() => {
    let live = true;
    setStatement(null);
    setError(null);
    void (async () => {
      try {
        const next = await call(pos().getCustomerStatement({ customerId }));
        if (live) setStatement(next);
      } catch (err) {
        if (live) setError(errorText(err));
      }
    })();
    // Selecting another customer while this read is in flight must not paint the previous one's
    // debts under the new name.
    return () => {
      live = false;
    };
  }, [customerId]);

  if (error !== null) {
    return (
      <section className="customer-statement">
        <h3>{t("statement.title")}</h3>
        <p className="error" data-testid="statement-error">
          {error}
        </p>
      </section>
    );
  }

  if (statement === null) {
    return (
      <section className="customer-statement">
        <h3>{t("statement.title")}</h3>
        <p className="muted" data-testid="statement-loading">
          {t("statement.loading")}
        </p>
      </section>
    );
  }

  // 🔴 A collection the ledger could not answer keeps NEW collections closed for this customer — also
  // after navigation or a restart, because this comes from the statement, not from screen state.
  const lockedByPending =
    statement.pendingCollections.some((p) => p.status === "unknown" || p.status === "conflict") ||
    statement.pendingReceipts.some((p) => p.status === "unknown" || p.status === "conflict");
  const canShareReceipt = sharableCurrencies(statement).length > 0;

  return (
    <section className="customer-statement" data-testid="customer-statement" data-customer={statement.customer.id}>
      <h3>{t("statement.title")}</h3>
      <p className="muted small" data-testid="statement-read-only">
        {t("statement.readOnly")}
      </p>

      {statement.pendingCollections.length > 0 && (
        /* 🔴 RECOVERED FROM THE LEDGER, NOT FROM THIS SCREEN'S MEMORY. A collection that was started and
           never confirmed survives navigation, a closed window and a restart; each is reported with
           what the ledger says, and an unanswered one keeps new collections closed. */
        <div data-testid="collect-pending-list">
          {statement.pendingCollections.map((p) => (
            <div
              key={p.idempotencyKey}
              className={p.status === "unknown" || p.status === "conflict" ? "error" : "notice"}
              data-testid="collect-pending"
              data-status={p.status}
            >
              <p>
                <bdi dir="ltr">{fmt(p.amount)}</bdi> · {t(`collect.method.${p.method}`)}
                {p.reference !== null && (
                  <>
                    {" "}
                    · <bdi dir="ltr">{p.reference}</bdi>
                  </>
                )}
              </p>
              <p>{t(`collect.pending.${p.status}`)}</p>
              {p.status === "not_recorded" && (
                <button className="btn" type="button" disabled={busy} onClick={() => void repeatPending(p)} data-testid="collect-pending-retry">
                  {t("collect.pending.retry")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {statement.pendingReceipts.length > 0 && (
        /* 🔴 RECOVERED FROM THE LEDGER, like a collection: a receipt that was started and never confirmed
           survives navigation, a closed window and a restart; an unanswered one locks new payments. */
        <div data-testid="receipt-pending-list">
          {statement.pendingReceipts.map((p) => (
            <div
              key={p.idempotencyKey}
              className={p.status === "unknown" || p.status === "conflict" ? "error" : "notice"}
              data-testid="receipt-pending"
              data-status={p.status}
            >
              <p>
                <bdi dir="ltr">{fmt(p.total)}</bdi> · {t(`collect.method.${p.provider}`)} · <bdi dir="ltr">{p.reference}</bdi>
              </p>
              <p>{t(`allocReceipt.pending.${p.status}`)}</p>
              {p.status === "not_recorded" && (
                <button className="btn" type="button" disabled={receiptBusy} onClick={() => void repeatPendingReceipt(p)} data-testid="receipt-pending-retry">
                  {t("allocReceipt.pending.retry")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {notice !== null && (
        /* 🔴 "ALREADY RECORDED" IS NOT "RECORDED AGAIN". A replayed key returns the committed
           payment, and the owner is told the money was taken ONCE — never that a second one
           succeeded, which would invite them to hand back change twice. */
        <p className="notice" data-testid={notice === "duplicate" ? "collect-duplicate" : notice === "receipt" ? "receipt-done" : "collect-done"}>
          {t(notice === "duplicate" ? "collect.alreadyDone" : notice === "receipt" ? "allocReceipt.done" : "collect.done")}
        </p>
      )}

      {statement.obligations.length === 0 ? (
        /* 🔴 NOT a zero. See the header. */
        <p className="muted" data-testid="statement-empty">
          {t("statement.none")}
        </p>
      ) : (
        <>
          <ul className="statement-balances" data-testid="statement-balances">
            {statement.balances.map((b) => (
              <li key={b.currency} data-testid="statement-balance" data-currency={b.currency}>
                <span className="muted">{t("statement.outstandingTotal")}</span>{" "}
                <strong>
                  <bdi dir="ltr">{fmt(b)}</bdi>
                </strong>
              </li>
            ))}
          </ul>

          {canShareReceipt &&
            (receiptOpen ? (
              <AllocatedReceiptForm
                customerId={customerId}
                statement={statement}
                onClose={() => setReceiptOpen(false)}
                onAskLedger={askLedgerAboutReceipt}
                onRecorded={(next, duplicate) => {
                  setStatement(next);
                  setNotice(duplicate ? "duplicate" : "receipt");
                  setReceiptOpen(false);
                }}
              />
            ) : (
              <button
                className="btn"
                type="button"
                disabled={blocked || busy || lockedByPending || payingId !== null}
                onClick={() => {
                  setNotice(null);
                  setReceiptOpen(true);
                }}
                data-testid="receipt-open"
              >
                {t("allocReceipt.action")}
              </button>
            ))}

          <ul className="statement-obligations">
            {statement.obligations.map((o) => (
              <li key={o.id} className="statement-obligation" data-testid="statement-obligation" data-obligation={o.id}>
                <div className="statement-row">
                  <span className="muted">{t("statement.amount")}</span>
                  <bdi dir="ltr" data-testid="statement-amount">
                    {fmt(o.amount)}
                  </bdi>
                </div>
                <div className="statement-row">
                  <span className="muted">{t("statement.outstanding")}</span>
                  {o.fullyPaid ? (
                    <span className="badge" data-testid="statement-settled">
                      {t("statement.paid")}
                    </span>
                  ) : (
                    <bdi dir="ltr" data-testid="statement-outstanding">
                      {fmt(o.outstanding)}
                    </bdi>
                  )}
                </div>
                <div className="statement-row">
                  <span className="muted">{t("statement.source")}</span>
                  <span data-testid="statement-source">
                    {o.sourceKind === "sale" ? t("statement.sourceSale") : t("statement.sourceManual")}{" "}
                    <bdi dir="ltr">{o.sourceRef}</bdi>
                  </span>
                </div>
                <div className="statement-row">
                  <span className="muted">{t("statement.postedAt")}</span>
                  <bdi dir="ltr">{o.postedAt.slice(0, 10)}</bdi>
                </div>

                <div className="statement-settlements">
                  <span className="muted small">{t("statement.settlements")}</span>
                  {o.settlements.length === 0 ? (
                    <p className="muted small" data-testid="statement-no-settlements">
                      {t("statement.noSettlements")}
                    </p>
                  ) : (
                    <ul>
                      {o.settlements.map((s) => (
                        <li key={s.id} data-testid="statement-settlement">
                          <bdi dir="ltr">{fmt(s.amount)}</bdi>{" "}
                          <span className="muted small" data-testid="statement-settlement-method" data-method={s.method} data-provider={s.provider ?? ""}>
                            {t(`statement.channel.${s.provider ?? s.method}`)}
                          </span>{" "}
                          {s.reference !== null && (
                            <span className="muted small" data-testid="statement-settlement-reference">
                              <bdi dir="ltr">{s.reference}</bdi>{" "}
                            </span>
                          )}
                          {s.receipt !== null && (
                            /* M17B-S1: a SHARE of one real receipt. The provider and reference are the
                               receipt's own, stated once; the amount named is the WHOLE receipt. */
                            <span className="muted small" data-testid="statement-settlement-share" data-receipt={s.receipt.id}>
                              {t(`statement.channel.${s.receipt.provider}`)} <bdi dir="ltr">{s.receipt.reference}</bdi> ·{" "}
                              {t("allocReceipt.shareOf")} <bdi dir="ltr">{fmt(s.receipt.total)}</bdi>{" "}
                            </span>
                          )}
                          <span className="muted small">
                            <bdi dir="ltr">{s.settledAt.slice(0, 10)}</bdi>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 🔴 OFFERED ONLY ON A DEBT THAT IS STILL OWED. A settled obligation has nothing
                    to collect, and the overpayment trigger would refuse it anyway — but offering
                    a button that cannot work is its own defect. */}
                {!o.fullyPaid &&
                  (payingId === o.id ? (
                    <form
                      className="collect-form"
                      data-testid="collect-form"
                      data-obligation={o.id}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submit(o);
                      }}
                    >
                      <h4>{t("collect.title")}</h4>
                      <div className="statement-row">
                        <span className="muted">{t("collect.customer")}</span>
                        <bdi data-testid="collect-customer">{statement.customer.displayName}</bdi>
                      </div>
                      <div className="statement-row">
                        <span className="muted">{t("collect.reference")}</span>
                        <bdi dir="ltr" data-testid="collect-reference">
                          {o.sourceRef}
                        </bdi>
                      </div>
                      <div className="statement-row">
                        <span className="muted">{t("collect.outstanding")}</span>
                        <bdi dir="ltr" data-testid="collect-outstanding">
                          {fmt(o.outstanding)}
                        </bdi>
                      </div>
                      <label>
                        <span className="muted">{t("collect.amount")}</span>
                        <input
                          className="collect-amount"
                          data-testid="collect-amount"
                          type="text"
                          inputMode="decimal"
                          dir="ltr"
                          autoFocus
                          value={amountText}
                          disabled={blocked || busy}
                          onChange={(e) => {
                            setAmountText(e.target.value);
                            setPayError(null);
                            setBlocked(false);
                            // A different amount is a different payment, so it gets its own key.
                            setAttemptKey(newIdempotencyKey());
                          }}
                        />
                      </label>
                      <label>
                        <span className="muted">{t("collect.method")}</span>
                        {/* Migration 17. A change of method is a different payment, so it takes a new
                            key; while an outcome is UNKNOWN the choice is frozen so the same key and
                            payload are the only thing that can be repeated. */}
                        <select
                          data-testid="collect-method"
                          value={method}
                          disabled={blocked || busy}
                          onChange={(e) => {
                            setMethod(e.target.value as CollectionMethodDto);
                            setReference("");
                            setConfirmed(false);
                            setPayError(null);
                            setAttemptKey(newIdempotencyKey());
                          }}
                        >
                          {COLLECTION_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {t(`collect.method.${m}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {method !== "cash" && (
                        <label>
                          <span className="muted">
                            {t("collect.paymentReference")}
                            {method === "card" ? ` (${t("collect.optional")})` : ""}
                          </span>
                          <input
                            data-testid="collect-payment-reference"
                            type="text"
                            dir="ltr"
                            maxLength={64}
                            value={reference}
                            disabled={blocked || busy}
                            onChange={(e) => {
                              setReference(e.target.value);
                              setPayError(null);
                              setAttemptKey(newIdempotencyKey());
                            }}
                          />
                          <span className="muted small">{t("collect.referenceHint")}</span>
                        </label>
                      )}
                      {(method === "whish" || method === "bank_transfer" || method === "other") && (
                        <label className="collect-confirm-funds">
                          <input
                            data-testid="collect-funds-confirmed"
                            type="checkbox"
                            checked={confirmed}
                            disabled={blocked || busy}
                            onChange={(e) => {
                              setConfirmed(e.target.checked);
                              setPayError(null);
                              setAttemptKey(newIdempotencyKey());
                            }}
                          />{" "}
                          <span>{t("collect.fundsConfirmed")}</span>
                          <span className="muted small"> {t("collect.fundsHint")}</span>
                        </label>
                      )}
                      {payError !== null && (
                        <p className="error" data-testid="collect-error">
                          {payError}
                        </p>
                      )}
                      <div className="panel-actions">
                        {!blocked && (
                          <button className="btn" type="submit" disabled={busy} data-testid="collect-confirm">
                            {busy ? t("collect.posting") : t("collect.confirm")}
                          </button>
                        )}
                        <button className="btn ghost" type="button" onClick={closeForm} disabled={blocked || busy} data-testid="collect-cancel">
                          {t("collect.cancel")}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      className="btn"
                      type="button"
                      disabled={blocked || busy || lockedByPending || receiptOpen}
                      onClick={() => openForm(o.id)}
                      data-testid="collect-open"
                    >
                      {t("collect.action")}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
