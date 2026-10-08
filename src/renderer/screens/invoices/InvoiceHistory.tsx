/**
 * Invoice history and reprint.
 *
 * 🔴 REOPENING A FINALIZED INVOICE SHOWS IT AS IT WAS ISSUED. The sheet renders the invoice's own
 * frozen issuer snapshot and its own stored line values — not today's shop details and not today's
 * catalog prices. The screen says so in a line the operator reads, because "why is the old invoice
 * showing the old phone number" is a question that otherwise gets asked as a bug report.
 */
import { useCallback, useEffect, useState } from "react";
import type { InvoiceDto, ReconciliationDto } from "../../../shared/ipcContract";
import { call, errorText, fmt, pos } from "../../api";
import { useT } from "../../i18n";

export function InvoiceHistory({ onOpen }: { readonly onOpen: (invoiceId: string) => void }) {
  const { t } = useT();
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [pending, setPending] = useState<Map<string, number>>(new Map());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const rows =
        term.trim() === ""
          ? await call(pos().listInvoices({ term: null, limit: 100 }))
          : await call(pos().searchInvoices({ term, limit: 100 }));
      setInvoices(rows);
      // How many review items each invoice still has open — the indicator in the list.
      const queue = await call(pos().listReconciliationQueue({ filter: "unresolved", limit: 500 }));
      const counts = new Map<string, number>();
      for (const item of queue.items) counts.set(item.invoiceId, (counts.get(item.invoiceId) ?? 0) + 1);
      setPending(counts);
      setError(null);
    } catch (e) {
      setInvoices([]);
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload("");
  }, [reload]);

  /** A bare number opens that invoice directly — the number printed on the paper in hand. */
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const asNumber = Number(query.trim());
    if (query.trim() !== "" && Number.isSafeInteger(asNumber) && asNumber > 0) {
      try {
        const found = await call(pos().findInvoiceByNumber({ invoiceNumber: asNumber }));
        if (found) {
          onOpen(found.invoice.id);
          return;
        }
      } catch {
        // fall through to the text search, which will simply show no rows
      }
    }
    await reload(query);
  };

  return (
    <div className="inv-history">
      <header className="admin-head">
        <h2>{t("inv.history.title")}</h2>
        <form onSubmit={submit}>
          <input
            className="admin-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("inv.history.search")}
            aria-label={t("inv.history.search")}
            data-testid="history-search"
          />
        </form>
      </header>
      <p className="muted small" data-testid="history-frozen-note">
        {t("inv.history.frozen")}
      </p>

      {error && <p className="error">{error}</p>}
      {loading && invoices.length === 0 && <div className="center muted">…</div>}

      {!loading && invoices.length === 0 ? (
        <p className="muted center" data-testid="history-empty">
          {t("inv.history.empty")}
        </p>
      ) : (
        <table className="admin-table" data-testid="history-table">
          <thead>
            <tr>
              <th>{t("inv.history.colNumber")}</th>
              <th>{t("inv.history.colDate")}</th>
              <th>{t("inv.history.colCustomer")}</th>
              <th>{t("inv.history.colTotal")}</th>
              <th>{t("inv.history.colReview")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => {
              const open = pending.get(inv.id) ?? 0;
              return (
                <tr key={inv.id} data-testid="history-row">
                  <td dir="ltr">#{inv.invoiceNumber}</td>
                  <td dir="ltr">{inv.invoiceDate}</td>
                  <td>{inv.customerName ?? "—"}</td>
                  <td dir="ltr">
                    <bdi>{fmt(inv.total)}</bdi>
                  </td>
                  <td>
                    {open > 0 ? (
                      <span className="badge draft" data-testid="history-review-pending">
                        <bdi dir="ltr">{open}</bdi> {t("inv.history.reviewPending")}
                      </span>
                    ) : (
                      <span className="muted small">{t("inv.history.reviewClear")}</span>
                    )}
                  </td>
                  <td className="actions">
                    <button className="btn small" onClick={() => onOpen(inv.id)} data-testid="history-open">
                      {t("inv.history.open")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function InvoiceDrafts({ onOpen }: { readonly onOpen: (invoiceId: string) => void }) {
  const { t } = useT();
  const [drafts, setDrafts] = useState<InvoiceDto[] | null>(null);

  useEffect(() => {
    call(pos().listInvoiceDrafts({ term: null, limit: 100 }))
      .then(setDrafts)
      .catch(() => setDrafts([]));
  }, []);

  if (drafts === null) return <div className="center muted">…</div>;
  if (drafts.length === 0)
    return (
      <p className="muted center" data-testid="drafts-empty">
        {t("inv.drafts.empty")}
      </p>
    );

  return (
    <table className="admin-table" data-testid="drafts-table">
      <thead>
        <tr>
          <th>{t("inv.history.colDate")}</th>
          <th>{t("inv.history.colCustomer")}</th>
          <th>{t("inv.history.colTotal")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {drafts.map((inv) => (
          <tr key={inv.id} data-testid="draft-row">
            <td dir="ltr">{inv.updatedAt.slice(0, 10)}</td>
            <td>{inv.customerName ?? "—"}</td>
            <td dir="ltr">
              <bdi>{fmt(inv.total)}</bdi>
            </td>
            <td className="actions">
              <button className="btn small" onClick={() => onOpen(inv.id)} data-testid="draft-open">
                {t("inv.drafts.open")}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Unused ReconciliationDto import guard — kept out of the bundle by TypeScript's erasure. */
export type { ReconciliationDto };
