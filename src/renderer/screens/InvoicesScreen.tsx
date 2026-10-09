/**
 * The Invoices tab — one screen holding the four views the feature needs, so the app's navigation
 * grows by exactly one tab.
 *
 * The company profile comes FIRST when none is saved, because finalizing without it is refused by
 * the service: a new shop would otherwise fill in a whole invoice and only then be told.
 */
import { useEffect, useState } from "react";
import type { CompanyProfileDto } from "../../shared/ipcContract";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";
import { CompanyProfileForm } from "./invoices/CompanyProfileForm";
import { InvoiceDrafts, InvoiceHistory } from "./invoices/InvoiceHistory";
import { InvoiceSheet } from "./invoices/InvoiceSheet";
import { ReconciliationQueue } from "./invoices/ReconciliationQueue";

type View = "history" | "drafts" | "review" | "company";

export function InvoicesScreen() {
  const { t } = useT();
  const [view, setView] = useState<View>("history");
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [profile, setProfile] = useState<CompanyProfileDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [choosingMode, setChoosingMode] = useState(false);

  useEffect(() => {
    call(pos().getCompanyProfile())
      .then((p) => {
        setProfile(p);
        // No shop details yet: start where the operator has to start anyway.
        if (p === null) setView("company");
      })
      .catch((e) => {
        setProfile(null);
        setError(errorText(e));
      });
  }, []);

  /**
   * Creates the OUTGOING sales invoice — the only invoice kind this build has.
   *
   * 🔴 REACHED ONLY AFTER THE OPERATOR NAMES THE INTENT. An incoming supplier invoice and an
   * outgoing customer invoice look almost identical on paper and mean opposite things: one is
   * catalog intake, the other is a sale that enters the day's takings. Nothing in `src/` implements
   * intake today, so the chooser names it and says it is not built, rather than leaving one
   * unlabelled door that an operator could walk through believing it was the other.
   */
  const newOutgoingInvoice = async () => {
    setChoosingMode(false);
    setError(null);
    try {
      const created = await call(pos().createInvoiceDraft());
      setOpenInvoice(created.invoice.id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (profile === undefined) return <div className="center muted">…</div>;

  if (openInvoice) {
    return (
      <InvoiceSheet
        invoiceId={openInvoice}
        onReviewNow={() => {
          setOpenInvoice(null);
          setView("review");
        }}
        onClosed={() => setOpenInvoice(null)}
      />
    );
  }

  return (
    <div className="inv-screen">
      <nav className="inv-nav" role="tablist">
        <button
          className="btn primary"
          onClick={() => setChoosingMode(true)}
          disabled={profile === null}
          data-testid="new-invoice"
        >
          + {t("inv.tab.new")}
        </button>
        {(
          [
            ["history", "inv.tab.history"],
            ["drafts", "inv.tab.drafts"],
            ["review", "inv.tab.review"],
            ["company", "inv.tab.company"],
          ] as ReadonlyArray<readonly [View, string]>
        ).map(([value, key]) => (
          <button
            key={value}
            role="tab"
            aria-selected={view === value}
            className={view === value ? "btn" : "btn ghost"}
            onClick={() => setView(value)}
            data-testid={`inv-tab-${value}`}
          >
            {t(key)}
          </button>
        ))}
      </nav>

      {profile === null && (
        <p className="notice" data-testid="company-required">
          {t("inv.company.required")}
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {view === "history" && <InvoiceHistory onOpen={setOpenInvoice} />}
      {view === "drafts" && <InvoiceDrafts onOpen={setOpenInvoice} />}
      {view === "review" && <ReconciliationQueue />}
      {view === "company" && <CompanyProfileForm onSaved={setProfile} />}

      {choosingMode && (
        <div className="overlay">
          <div className="card dialog" data-testid="invoice-mode-chooser">
            <h2>{t("inv.mode.title")}</h2>
            <div className="inv-modes">
              <button className="btn primary wide" onClick={() => void newOutgoingInvoice()} data-testid="mode-outgoing">
                {t("inv.mode.outgoing")}
              </button>
              <p className="muted small">{t("inv.mode.outgoingWhat")}</p>

              {/* 🔴 NAMED, NOT OFFERED. Showing the mode with its real meaning is the separation;
                  hiding it would leave the operator with one door and no way to know the other
                  exists. It is disabled because nothing in this build implements intake. */}
              <button className="btn wide" disabled data-testid="mode-incoming">
                {t("inv.mode.incoming")}
              </button>
              <p className="muted small">{t("inv.mode.incomingWhat")}</p>
              <p className="notice small" data-testid="mode-incoming-soon">{t("inv.mode.incomingSoon")}</p>
            </div>
            <div className="inv-actions">
              <button className="btn ghost" onClick={() => setChoosingMode(false)} data-testid="mode-cancel">
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
