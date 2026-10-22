/**
 * Find or add a customer — the panel Sell opens over its own cart, and the directory reuses.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 IT IS AN OVERLAY, NOT A ROUTE, AND THAT IS WHAT PRESERVES THE CART. `SellScreen` keeps its
 * cart, its search text, its quantity drafts and its idempotency key in `useState`; rendering this
 * beside them leaves every one of those mounted and untouched. Navigating away and back would
 * remount SellScreen and lose all four — which is why this is a panel and the cart needed no
 * restructuring at all.
 *
 * 🔴 NO AMOUNT, NO BALANCE, NO DEBT IS SHOWN HERE, because none exists. S1B creates a directory
 * record. Printing "0.00" beside a new customer would be a fabricated accounting statement.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useRef, useState } from "react";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";
import type { CustomerDto } from "../../shared/ipcContract";
import { disambiguator, nameIsValid, sameNamed } from "../customerDirectory";

interface Props {
  readonly onPick: (customer: CustomerDto) => void;
  readonly onClose: () => void;
}

export function CustomerFinder({ onPick, onClose }: Props) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<readonly CustomerDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ displayName: "", phone: "", address: "", note: "" });
  const [sameName, setSameName] = useState<readonly CustomerDto[]>([]);
  // 🔴 ONE FLAG GUARDS THE SAVE, and it is set BEFORE the await. A double-tapped Save on a till
  // with a slow disk is the ordinary way a duplicate record gets created, and the service has no
  // way to tell two deliberate same-named customers from one impatient operator.
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    call(pos().searchCustomers({ query, includeArchived: false }))
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setRows([]);
          setError(errorText(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Escape closes, like the Sell photo preview already does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (saving || !nameIsValid(form.displayName)) return;
    setSaving(true);
    setError(null);
    try {
      const created = await call(
        pos().createCustomer({
          displayName: form.displayName.trim(),
          phone: form.phone.trim() || null,
          address: form.address.trim() || null,
          note: form.note.trim() || null,
        }),
      );
      setSameName(created.sameName);
      // 🔴 THE PANEL STAYS OPEN WHEN THERE IS A SAME-NAME WARNING, so the operator reads it before
      // returning to the cart. Nothing was merged and nothing was refused — the account exists.
      if (created.sameName.length === 0) onPick(created.customer);
      else {
        setCreating(false);
        setRows(null);
        setQuery(created.customer.displayName);
      }
    } catch (e) {
      // The form stays filled and editable: a refused name must not cost the operator their typing.
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" data-testid="customer-finder" role="dialog" aria-modal="true">
      <div className="panel customer-panel">
        <header className="panel-head">
          <h2>{creating ? t("customers.new") : t("sell.chooseCustomer")}</h2>
          <button className="btn ghost" onClick={onClose} data-testid="customer-finder-close">
            {t("customers.cancel")}
          </button>
        </header>

        {sameName.length > 0 && (
          <p className="warn" data-testid="customer-same-name">
            {t("customers.sameName")} <span className="muted">{t("customers.sameNameHint")}</span>
          </p>
        )}

        {creating ? (
          <form
            className="customer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              {t("customers.name")} <em className="muted">({t("customers.nameRequired")})</em>
              <input
                dir="auto"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                data-testid="customer-field-name"
                maxLength={120}
                autoFocus
              />
            </label>
            {(["phone", "address", "note"] as const).map((field) => (
              <label key={field}>
                {t(`customers.${field}`)} <em className="muted">({t("customers.optional")})</em>
                <input
                  dir="auto"
                  value={form[field]}
                  onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                  data-testid={`customer-field-${field}`}
                />
              </label>
            ))}
            {!nameIsValid(form.displayName) && (
              <p className="error" data-testid="customer-name-invalid">
                {t("customers.nameRequired")}
              </p>
            )}
            {error && <p className="error" data-testid="customer-finder-error">{error}</p>}
            <div className="panel-actions">
              <button
                className="btn primary"
                type="submit"
                disabled={saving || !nameIsValid(form.displayName)}
                data-testid="customer-save"
              >
                {saving ? t("customers.saving") : t("customers.save")}
              </button>
              <button className="btn ghost" type="button" onClick={() => setCreating(false)}>
                {t("customers.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <input
              ref={searchRef}
              className="customer-search"
              dir="auto"
              placeholder={t("customers.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="customer-search"
            />
            {error && <p className="error" data-testid="customer-finder-error">{error}</p>}
            {rows === null ? (
              <p className="muted" data-testid="customer-loading">
                {t("customers.loading")}
              </p>
            ) : rows.length === 0 ? (
              <p className="muted" data-testid="customer-empty">
                {query.trim().length === 0 ? t("customers.none") : t("customers.noMatch")}
              </p>
            ) : (
              <ul className="customer-list">
                {rows.map((c) => {
                  const twins = sameNamed(rows, c.displayName, c.id);
                  return (
                    <li key={c.id}>
                      <button
                        className="customer-row"
                        onClick={() => onPick(c)}
                        data-testid="customer-row"
                        data-customer={c.id}
                      >
                        <span>
                          <bdi>{c.displayName}</bdi>
                        </span>
                        {/* Shown only when it is needed to tell two same-named people apart. */}
                        {twins.length > 0 && (
                          <span className="muted small" data-testid="customer-disambiguator">
                            <bdi>{disambiguator(c)}</bdi>
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="panel-actions">
              <button
                className="btn"
                onClick={() => {
                  setForm({ displayName: query.trim(), phone: "", address: "", note: "" });
                  setSameName([]);
                  setCreating(true);
                }}
                data-testid="customer-new"
              >
                {t("customers.new")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
