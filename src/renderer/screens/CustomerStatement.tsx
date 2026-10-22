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
 * 🔴 IT CANNOT WRITE. There is no channel on the bridge that posts a debt or records a payment, so
 * this screen could not change the ledger even if it tried; opening it is a pure read. The line it
 * prints at the top says so to the merchant rather than leaving them to assume it.
 *
 * The owner gate is NOT this component rendering or not: `channelPolicy` classifies
 * `getCustomerStatement` as "owner" and `LedgerService.requireOwner` re-reads the live role, so a
 * cashier calling `window.pos.getCustomerStatement` directly is refused. Not rendering it merely
 * avoids offering a panel that would be refused.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useState } from "react";
import { call, errorText, fmt, pos } from "../api";
import { useT } from "../i18n";
import type { CustomerStatementDto } from "../../shared/ipcContract";

interface Props {
  readonly customerId: string;
}

export function CustomerStatement({ customerId }: Props) {
  const { t } = useT();
  const [statement, setStatement] = useState<CustomerStatementDto | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
