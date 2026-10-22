/**
 * The Customer directory. Identity only — no balance, no debt, no amount, because none exists yet.
 *
 * 🔴 THE EDIT AND ARCHIVE CONTROLS ARE OWNER-ONLY, AND HIDING THEM IS NOT THE GUARD. `channelPolicy`
 * classifies `updateCustomerContact` and `setCustomerActive` as "owner" and `PartyService` re-reads
 * the live role, so a cashier reaching the channel directly through `window.pos` is refused. The
 * `mayMutateCustomers` check below only avoids offering a button that would be refused.
 */
import { useCallback, useEffect, useState } from "react";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";
import type { CustomerDto } from "../../shared/ipcContract";
import { contactPatch, disambiguator, mayMutateCustomers, nameIsValid, sameNamed } from "../customerDirectory";
import { CustomerFinder } from "./CustomerFinder";

interface Props {
  // `role` is optional on CashierDto, so it is optional here; `mayMutateCustomers` treats an
  // absent role as "not an owner", which is the fail-closed reading.
  readonly operator: { readonly id: string; readonly name: string; readonly role?: string };
}

const EMPTY = { displayName: "", phone: "", address: "", note: "" };

export function CustomersScreen({ operator }: Props) {
  const { t } = useT();
  const mayMutate = mayMutateCustomers(operator.role);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [rows, setRows] = useState<readonly CustomerDto[] | null>(null);
  const [selected, setSelected] = useState<CustomerDto | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setRows(await call(pos().searchCustomers({ query, includeArchived })));
    } catch (e) {
      setRows([]);
      setError(errorText(e));
    }
  }, [query, includeArchived]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const beginEdit = (c: CustomerDto) => {
    setForm({
      displayName: c.displayName,
      phone: c.phone ?? "",
      address: c.address ?? "",
      note: c.note ?? "",
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (busy || !selected || !nameIsValid(form.displayName)) return;
    const patch = contactPatch(selected, form);
    // Nothing changed: no round trip, and no contact-history row.
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await call(pos().updateCustomerContact({ customerId: selected.id, patch }));
      setSelected(updated);
      setEditing(false);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    if (busy || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await call(pos().setCustomerActive({ customerId: selected.id, isActive: !selected.isActive }));
      setSelected(updated);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="customers-screen">
      <div className="customers-list-pane">
        <div className="customers-toolbar">
          <input
            className="customer-search"
            dir="auto"
            placeholder={t("customers.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="customers-search"
          />
          <button className="btn" onClick={() => setAdding(true)} data-testid="customers-add">
            {t("customers.new")}
          </button>
          <label className="muted small">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              data-testid="customers-show-archived"
            />
            {t("customers.showArchived")}
          </label>
        </div>

        {error && <p className="error" data-testid="customers-error">{error}</p>}

        {rows === null ? (
          <p className="muted" data-testid="customers-loading">
            {t("customers.loading")}
          </p>
        ) : rows.length === 0 ? (
          <p className="muted" data-testid="customers-empty">
            {query.trim().length === 0 ? t("customers.none") : t("customers.noMatch")}
          </p>
        ) : (
          <ul className="customer-list" data-testid="customers-list">
            {rows.map((c) => {
              const twins = sameNamed(rows, c.displayName, c.id);
              return (
                <li key={c.id}>
                  <button
                    className={selected?.id === c.id ? "customer-row selected" : "customer-row"}
                    onClick={() => {
                      setSelected(c);
                      setEditing(false);
                      setError(null);
                    }}
                    data-testid="customers-row"
                    data-customer={c.id}
                  >
                    <span dir="auto">{c.displayName}</span>
                    {twins.length > 0 && (
                      <span className="muted small" dir="auto" data-testid="customers-disambiguator">
                        {disambiguator(c)}
                      </span>
                    )}
                    {c.isActive ? null : <span className="badge warn">{t("customers.archived")}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="customers-detail-pane">
        {selected === null ? (
          <p className="muted center">{t("customers.title")}</p>
        ) : editing ? (
          <form
            className="customer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
            data-testid="customers-edit-form"
          >
            <label>
              {t("customers.name")}
              <input
                dir="auto"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                data-testid="customers-edit-name"
                maxLength={120}
              />
            </label>
            {(["phone", "address", "note"] as const).map((field) => (
              <label key={field}>
                {t(`customers.${field}`)} <em className="muted">({t("customers.optional")})</em>
                <input
                  dir="auto"
                  value={form[field]}
                  onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                  data-testid={`customers-edit-${field}`}
                />
              </label>
            ))}
            {!nameIsValid(form.displayName) && <p className="error">{t("customers.nameRequired")}</p>}
            <div className="panel-actions">
              <button className="btn primary" type="submit" disabled={busy} data-testid="customers-edit-save">
                {busy ? t("customers.saving") : t("customers.save")}
              </button>
              <button className="btn ghost" type="button" onClick={() => setEditing(false)}>
                {t("customers.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div className="customer-detail" data-testid="customers-detail" data-customer={selected.id}>
            <h2 dir="auto">{selected.displayName}</h2>
            <dl>
              <dt>{t("customers.phone")}</dt>
              <dd dir="auto" data-testid="customers-detail-phone">
                {selected.phone ?? "—"}
              </dd>
              <dt>{t("customers.address")}</dt>
              <dd dir="auto">{selected.address ?? "—"}</dd>
              <dt>{t("customers.note")}</dt>
              <dd dir="auto">{selected.note ?? "—"}</dd>
            </dl>
            {/* 🔴 NO BALANCE LINE. S1B has no financial data to put in one. */}
            {mayMutate ? (
              <div className="panel-actions">
                <button className="btn" onClick={() => beginEdit(selected)} data-testid="customers-edit">
                  {t("customers.edit")}
                </button>
                <button className="btn ghost" onClick={() => void toggleActive()} data-testid="customers-archive">
                  {selected.isActive ? t("customers.archive") : t("customers.restore")}
                </button>
              </div>
            ) : (
              <p className="muted small" data-testid="customers-owner-only">
                {t("customers.ownerOnly")}
              </p>
            )}
          </div>
        )}
      </div>

      {adding && (
        <CustomerFinder
          onClose={() => {
            setAdding(false);
            void reload();
          }}
          onPick={(c) => {
            setAdding(false);
            setSelected(c);
            void reload();
          }}
        />
      )}
    </div>
  );
}
