/**
 * «محل جديد» — a NEW shop's first owner (O-1 Phase 1, contract v3.1, owner R9).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 PRESENTATION ONLY. The renderer decides nothing here. `enrollOwner` is refused in main unless the terminal is
 * unclaimed AND the ledger is empty (re-read inside its transaction), and main also refuses a published or
 * out-of-rule PIN. This screen is drawn only where main's entry hint says the terminal is first-run eligible, which
 * uses the same emptiness rule — so the refusal below is the rare race, not the normal path.
 *
 * It replaces the old «إنشاء حساب» note that sent the owner to the login screen to type the published setup code:
 * that code no longer signs in (P1), so the note would have been a dead instruction.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useState } from "react";
import type { CashierDto } from "../../shared/ipcContract";
import { BRAND } from "../../shared/i18n";
import { ApiError, call, errorText, pos } from "../api";
import { useT } from "../i18n";

/** The bounds `domain/pinRule.ts` enforces for a CHOSEN PIN. UX only — main is what refuses. */
const PIN_MIN = 6;
const PIN_MAX = 8;
const digitsOnly = (v: string) => v.replace(/[^0-9]/g, "").slice(0, PIN_MAX);

export function NewShopScreen({
  onReady,
  onBack,
}: {
  readonly onReady: (c: CashierDto) => void;
  readonly onBack: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameOk = name.trim().length > 0;
  const pinOk = pin.length >= PIN_MIN && pin.length <= PIN_MAX;
  const matches = pin === confirm;
  const ready = nameOk && pinOk && matches && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onReady(await call(pos().enrollOwner({ name: name.trim(), pin })));
    } catch (e) {
      // Each refusal gets its own sentence (text follows context): «not a new shop» is not «wrong PIN».
      const code = e instanceof ApiError ? e.code : null;
      setError(
        code === "ENROLLMENT_NOT_AVAILABLE"
          ? t("newShop.notNew")
          : code === "NOT_AVAILABLE"
            ? t("newShop.unavailable")
            : code === "INVALID_PIN"
              ? t("newShop.pinRule")
              : errorText(e),
      );
      // The PIN fields are cleared, the NAME is kept.
      setPin("");
      setConfirm("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup" data-testid="new-shop-screen">
      <header className="setup-head">
        <h1>{BRAND}</h1>
        <p className="muted">{t("newShop.title")}</p>
      </header>

      <form
        className="card setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="notice" data-testid="new-shop-why">
          {t("newShop.why")}
        </p>

        <label className="field">
          <span>{t("newShop.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="new-shop-name" autoFocus />
        </label>

        <label className="field">
          <span>{t("newShop.pin")}</span>
          <input
            dir="ltr"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(e) => setPin(digitsOnly(e.target.value))}
            data-testid="new-shop-pin"
          />
        </label>

        <label className="field">
          <span>{t("newShop.confirm")}</span>
          <input
            dir="ltr"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(digitsOnly(e.target.value))}
            data-testid="new-shop-confirm"
          />
        </label>

        <p className="muted small">{t("newShop.pinRule")}</p>
        {pin.length > 0 && !pinOk && (
          <p className="error small" data-testid="new-shop-pin-invalid">
            {t("newShop.pinRule")}
          </p>
        )}
        {confirm.length > 0 && !matches && (
          <p className="error small" data-testid="new-shop-mismatch">
            {t("newShop.mismatch")}
          </p>
        )}
        {error && (
          <p className="error" role="alert" data-testid="new-shop-error">
            {error}
          </p>
        )}

        <div className="row">
          <button type="submit" className="btn primary big" disabled={!ready} data-testid="new-shop-submit">
            {busy ? t("newShop.busy") : t("newShop.submit")}
          </button>
          <button type="button" className="btn" onClick={onBack} disabled={busy} data-testid="new-shop-back">
            {t("welcome.back")}
          </button>
        </div>
      </form>
    </div>
  );
}
