/**
 * The owner's operator list, inside Tools.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS NOT AUTHORIZATION. It renders for an owner and is hidden from a cashier, and that is a
 * COURTESY. Every channel it calls is classified `owner` in `src/main/channelPolicy.ts` and refused
 * below this boundary, so a cashier who reaches `window.pos.createOperator` directly — which an E2E
 * test does, deliberately — is refused by the main process, not by this file's absence.
 *
 * 🔴 NO PIN IS EVER DISPLAYED, and none can be: a PIN is a scrypt hash with a per-operator salt, so
 * there is nothing to reveal. The screen says that in words rather than leaving the owner to wonder
 * why there is no "show PIN" button. PIN management is RESET only.
 *
 * An operator is never deleted. Deactivation is the lifecycle, because a past sale names this person
 * and that name must stay resolvable — the same reason products deactivate rather than disappear.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useState } from "react";
import type { OperatorDto } from "../../shared/ipcContract";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";

const digitsOnly = (v: string) => v.replace(/[^0-9]/g, "").slice(0, 8);

type Draft = { readonly kind: "create" } | { readonly kind: "rename" | "pin"; readonly op: OperatorDto };

export function OperatorsSection({ selfId }: { readonly selfId: string }) {
  const { t } = useT();
  const [list, setList] = useState<OperatorDto[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    call(pos().listOperators())
      .then((r) => setList([...r]))
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    void reload();
  }, []);

  /** Every mutation goes through here, so a refusal always reaches the screen rather than a console. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDraft(null);
      setName("");
      setPin("");
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (r: string) => t(r === "owner" ? "ops.role.owner" : "ops.role.cashier");

  return (
    <section className="card ops" data-testid="operators-section">
      <h2>{t("ops.title")}</h2>
      <p className="muted small" data-testid="ops-no-pin-shown">
        {t("ops.noPinShown")}
      </p>

      {error && (
        <p className="error" data-testid="ops-error">
          {error}
        </p>
      )}

      {list === null ? (
        <p className="muted">…</p>
      ) : (
        <table className="admin-table" data-testid="ops-table">
          <thead>
            <tr>
              <th>{t("ops.colName")}</th>
              <th>{t("ops.colRole")}</th>
              <th>{t("ops.colStatus")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((op) => (
              <tr key={op.id} data-testid="ops-row" data-operator-id={op.id} data-role={op.role}>
                <td dir="auto">{op.name}</td>
                <td data-testid="ops-row-role">{roleLabel(op.role)}</td>
                <td>
                  <span className={op.isActive ? "badge ok" : "badge warn"} data-testid="ops-row-status">
                    {op.isActive ? t("ops.active") : t("ops.inactive")}
                  </span>
                  {op.mustResetPin && (
                    <span className="muted small" data-testid="ops-row-pending">
                      {" "}
                      {t("ops.pending")}
                    </span>
                  )}
                </td>
                <td className="row-actions">
                  <button
                    className="btn ghost small"
                    disabled={busy}
                    onClick={() => {
                      setDraft({ kind: "rename", op });
                      setName(op.name);
                    }}
                    data-testid="ops-rename"
                  >
                    {t("ops.rename")}
                  </button>
                  <button
                    className="btn ghost small"
                    disabled={busy}
                    onClick={() => {
                      setDraft({ kind: "pin", op });
                      setPin("");
                    }}
                    data-testid="ops-reset-pin"
                  >
                    {t("ops.resetPin")}
                  </button>
                  {/* 🔴 Not offered on yourself. The service refuses it anyway — this only avoids
                      presenting an action that cannot succeed. */}
                  {op.id !== selfId && (
                    <button
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          call(
                            pos().setOperatorRole({
                              operatorId: op.id,
                              role: op.role === "owner" ? "cashier" : "owner",
                            }),
                          ),
                        )
                      }
                      data-testid="ops-toggle-role"
                    >
                      {t(op.role === "owner" ? "ops.makeCashier" : "ops.makeOwner")}
                    </button>
                  )}
                  <button
                    className={op.isActive ? "btn danger ghost small" : "btn ghost small"}
                    disabled={busy}
                    onClick={() =>
                      void act(() => call(pos().setOperatorActive({ operatorId: op.id, isActive: !op.isActive })))
                    }
                    data-testid="ops-toggle-active"
                  >
                    {t(op.isActive ? "ops.deactivate" : "ops.activate")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="inv-actions">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setDraft({ kind: "create" });
            setName("");
            setPin("");
          }}
          data-testid="ops-add"
        >
          + {t("ops.add")}
        </button>
      </div>

      {draft && (
        <div className="overlay">
          <form
            className="card dialog"
            data-testid="ops-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.kind === "create") {
                void act(() => call(pos().createOperator({ name: name.trim(), role: "cashier", pin })));
              } else if (draft.kind === "rename") {
                void act(() => call(pos().renameOperator({ operatorId: draft.op.id, name: name.trim() })));
              } else {
                void act(() => call(pos().resetOperatorPin({ operatorId: draft.op.id, pin })));
              }
            }}
          >
            <h3>{t(draft.kind === "create" ? "ops.add" : draft.kind === "rename" ? "ops.rename" : "ops.resetPin")}</h3>

            {draft.kind !== "pin" && (
              <label className="field">
                <span>{t("ops.newName")}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} data-testid="ops-name" autoFocus />
              </label>
            )}

            {draft.kind !== "rename" && (
              <label className="field">
                <span>{t("ops.newPin")}</span>
                <input
                  dir="ltr"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={pin}
                  onChange={(e) => setPin(digitsOnly(e.target.value))}
                  data-testid="ops-pin"
                  autoFocus={draft.kind === "pin"}
                />
              </label>
            )}

            <p className="muted small">{t("setup.pinRule")}</p>

            <div className="inv-actions">
              <button className="btn primary" type="submit" disabled={busy} data-testid="ops-dialog-save">
                {t("ops.save")}
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
                data-testid="ops-dialog-cancel"
              >
                {t("ops.cancel")}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
