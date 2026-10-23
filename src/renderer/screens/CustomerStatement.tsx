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
import type { CustomerStatementDto, StatementObligationDto } from "../../shared/ipcContract";

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

interface Props {
  readonly customerId: string;
}

export function CustomerStatement({ customerId }: Props) {
  const { t } = useT();
  const [statement, setStatement] = useState<CustomerStatementDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which debt the owner is collecting against, or null when no form is open. */
  const [payingId, setPayingId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
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
  const [notice, setNotice] = useState<"done" | "duplicate" | null>(null);

  const closeForm = () => {
    setPayingId(null);
    setAmountText("");
    setPayError(null);
    setBlocked(false);
    setAttemptKey(newIdempotencyKey());
  };

  const openForm = (obligationId: string) => {
    setPayingId(obligationId);
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
    setBusy(true);
    setPayError(null);
    try {
      const result = await call(
        pos().recordCustomerPayment({
          customerId,
          obligationId: o.id,
          idempotencyKey: attemptKey,
          amountMinor,
          method: "cash",
        }),
      );
      // 🔴 THE STATEMENT IS REPLACED, NEVER PATCHED. Main recomputed it from the ledger after the
      // commit, so nothing here subtracts a payment from a balance.
      setStatement(result.statement);
      setNotice(result.duplicate ? "duplicate" : "done");
      setPayingId(null);
      setAmountText("");
      setAttemptKey(newIdempotencyKey());
    } catch (err) {
      setPayError(errorText(err));
      // 🔴 THE KEY IS NOT REGENERATED HERE. Retrying the same amount must replay the same key.
      if (err instanceof ApiError && UNSAFE_TO_RETRY.has(err.code)) setBlocked(true);
    } finally {
      setBusy(false);
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

  return (
    <section className="customer-statement" data-testid="customer-statement" data-customer={statement.customer.id}>
      <h3>{t("statement.title")}</h3>
      <p className="muted small" data-testid="statement-read-only">
        {t("statement.readOnly")}
      </p>

      {notice !== null && (
        /* 🔴 "ALREADY RECORDED" IS NOT "RECORDED AGAIN". A replayed key returns the committed
           payment, and the owner is told the money was taken ONCE — never that a second one
           succeeded, which would invite them to hand back change twice. */
        <p className="notice" data-testid={notice === "duplicate" ? "collect-duplicate" : "collect-done"}>
          {t(notice === "duplicate" ? "collect.alreadyDone" : "collect.done")}
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
                          <span className="muted small">{t(`statement.method.${s.method}`)}</span>{" "}
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
                          onChange={(e) => {
                            setAmountText(e.target.value);
                            setPayError(null);
                            setBlocked(false);
                            // A different amount is a different payment, so it gets its own key.
                            setAttemptKey(newIdempotencyKey());
                          }}
                        />
                      </label>
                      <div className="statement-row">
                        <span className="muted">{t("collect.method")}</span>
                        {/* Cash only in S3C, so it is stated rather than chosen. */}
                        <span data-testid="collect-method">{t("collect.methodCash")}</span>
                      </div>
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
                        <button className="btn ghost" type="button" onClick={closeForm} data-testid="collect-cancel">
                          {t("collect.cancel")}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button className="btn" type="button" onClick={() => openForm(o.id)} data-testid="collect-open">
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
