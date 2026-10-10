/**
 * Mandatory first-run setup. An operator who signed in with a LEGACY BOOTSTRAP credential sets
 * their real name and their own private PIN here, and cannot reach the application until they do.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCREEN IS NOT WHAT ENFORCES THE RULE. There is no session yet — the main process returned
 * a setup ticket and assigned nobody — so every other channel refuses with NOT_LOGGED_IN whatever
 * this renderer does. A reload shows this screen again because the flag is on disk and the ticket
 * is not; closing the app loses the ticket and the operator signs in with the bootstrap PIN again.
 * The screen is the courtesy; `must_reset_pin` is the rule.
 *
 * 🔴 AND IT NEVER SHOWS THE OLD PIN, because there is nothing to show: it is a scrypt hash. The
 * screen says so rather than implying the old PIN could have been recovered.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useState } from "react";
import type { CashierDto } from "../../shared/ipcContract";
import { BRAND } from "../../shared/i18n";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";

/** The same bounds `domain/pinRule.ts` enforces. UX only — the service is what refuses. */
const PIN_MIN = 4;
const PIN_MAX = 8;

const digitsOnly = (v: string) => v.replace(/[^0-9]/g, "").slice(0, PIN_MAX);

export function SetupScreen({
  ticket,
  operatorName,
  onReady,
}: {
  readonly ticket: string;
  readonly operatorName: string;
  readonly onReady: (c: CashierDto) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(operatorName);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameOk = name.trim().length > 0;
  const pinOk = pin.length >= PIN_MIN && pin.length <= PIN_MAX;
  const matches = pin === confirm;
  const ready = nameOk && pinOk && matches;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onReady(await call(pos().completeBootstrapSetup({ ticket, name: name.trim(), pin })));
    } catch (e) {
      // 🔴 The PIN fields are cleared, the NAME is kept. A refused PIN is a typo to retype; making
      // the operator re-enter their name as well would be punishment for the app's own error.
      setError(errorText(e));
      setPin("");
      setConfirm("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup" data-testid="setup-screen">
      <header className="setup-head">
        <h1>{BRAND}</h1>
        <p className="muted">{t("setup.title")}</p>
      </header>

      <form
        className="card setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="notice" data-testid="setup-why">
          {t("setup.why")}
        </p>

        <label className="field">
          <span>{t("setup.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="setup-name" autoFocus />
        </label>

        <label className="field">
          <span>{t("setup.pin")}</span>
          <input
            dir="ltr"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(e) => setPin(digitsOnly(e.target.value))}
            data-testid="setup-pin"
          />
        </label>

        <label className="field">
          <span>{t("setup.confirm")}</span>
          <input
            dir="ltr"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(digitsOnly(e.target.value))}
            data-testid="setup-confirm"
          />
        </label>

        <p className="muted small">{t("setup.pinRule")}</p>
        {pin.length > 0 && !pinOk && (
          <p className="error small" data-testid="setup-pin-invalid">
            {t("setup.pinRule")}
          </p>
        )}
        {confirm.length > 0 && !matches && (
          <p className="error small" data-testid="setup-mismatch">
            {t("setup.mismatch")}
          </p>
        )}
        {error && (
          <p className="error" data-testid="setup-error">
            {error}
          </p>
        )}

        <button className="btn primary big wide" type="submit" disabled={busy || !ready} data-testid="setup-submit">
          {t("setup.submit")}
        </button>
        {/* No skip, no "remind me later", and no way back to the till. */}
        <p className="muted small" data-testid="setup-no-skip">
          {t("setup.noSkip")}
        </p>
      </form>
    </div>
  );
}
