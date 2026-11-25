/**
 * M5 — the Lebanese-lira DISPLAY, React half (the arithmetic is src/domain/lbpDisplay.ts).
 *
 * 🔴 DISPLAY ONLY. This file renders an INDICATIVE «≈ … ل.ل.» line next to a USD amount the screen already
 * shows. It never replaces the USD figure, never feeds an input, a payload, a receipt or a print, and never
 * changes a stored value. USD stays the accounting currency (OD-CUR-01/02, owner decision 2026-11-25).
 *
 * The toggle and the rate load from settings.json through main, exactly like the language (./i18n.tsx), so the
 * choice survives a restart. A new profile has no saved preference and shows USD only.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_DISPLAY_CURRENCY, DEFAULT_LBP_RATE, type DisplayCurrency, lbpEquivalent } from "../domain/lbpDisplay";
import { ApiError, call, pos } from "./api";
import { useT } from "./i18n";

interface LbpDisplayValue {
  readonly displayCurrency: DisplayCurrency;
  readonly lbpRate: string;
  /** F8: the owner has saved (confirmed) this rate; until then LBP display cannot be turned on. */
  readonly lbpRateConfirmed: boolean;
  readonly setDisplayCurrency: (next: DisplayCurrency) => void;
  /** F7: why the last toggle was refused (null when it was not). Shown next to the toggle, never swallowed. */
  readonly toggleError: "unconfirmed" | "not-saved" | null;
  /** Owner only (main refuses anyone else). Resolves to the canonical rate now in force, or throws the refusal. */
  readonly saveLbpRate: (typed: string) => Promise<string>;
}

const LbpDisplayContext = createContext<LbpDisplayValue | null>(null);

export function LbpDisplayProvider({ children }: { children: ReactNode }) {
  const [displayCurrency, setCurrency] = useState<DisplayCurrency>(DEFAULT_DISPLAY_CURRENCY);
  const [lbpRate, setRate] = useState<string>(DEFAULT_LBP_RATE);
  const [lbpRateConfirmed, setConfirmed] = useState(false);
  const [toggleError, setToggleError] = useState<"unconfirmed" | "not-saved" | null>(null);

  useEffect(() => {
    let cancelled = false;
    call(pos().getSettings())
      .then((s) => {
        if (cancelled) return;
        if (s.displayCurrency === "USD" || s.displayCurrency === "LBP") setCurrency(s.displayCurrency);
        if (typeof s.lbpRate === "string") setRate(s.lbpRate);
        setConfirmed(s.lbpRateConfirmed === true);
      })
      // An older build or a test harness without the settings channel: USD only, which is the safe default.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // F7/F8 (owner, 2026-11-25): the display changes only AFTER main stored it. A refusal (unconfirmed rate, or a
  // write the disk refused) leaves the screen as it was and says why — it is never silently ignored.
  const setDisplayCurrency = useCallback((next: DisplayCurrency) => {
    setToggleError(null);
    call(pos().setDisplayCurrency({ currency: next }))
      .then((s) => setCurrency(s.displayCurrency === "LBP" ? "LBP" : "USD"))
      .catch((e: unknown) => {
        const code = e instanceof ApiError ? e.code : null;
        setToggleError(code === "LBP_RATE_UNCONFIRMED" ? "unconfirmed" : "not-saved");
      });
  }, []);

  const saveLbpRate = useCallback(async (typed: string) => {
    const s = await call(pos().setLbpRate({ rate: typed }));
    setRate(s.lbpRate);
    setConfirmed(s.lbpRateConfirmed === true);
    setToggleError(null);
    return s.lbpRate;
  }, []);

  const value = useMemo<LbpDisplayValue>(
    () => ({ displayCurrency, lbpRate, lbpRateConfirmed, setDisplayCurrency, toggleError, saveLbpRate }),
    [displayCurrency, lbpRate, lbpRateConfirmed, setDisplayCurrency, toggleError, saveLbpRate],
  );
  return <LbpDisplayContext.Provider value={value}>{children}</LbpDisplayContext.Provider>;
}

/** Outside the provider (a test harness rendering one screen) the display is simply off. */
export function useLbpDisplay(): LbpDisplayValue | null {
  return useContext(LbpDisplayContext);
}

/**
 * The indicative line. Renders NOTHING unless the toggle is on «ل.ل.», the amount is USD and the rate is valid —
 * a missing or corrupt rate never produces a guessed figure.
 */
export function LbpEquivalent(props: { readonly minor: bigint; readonly currency: string; readonly testid?: string }) {
  const lbp = useLbpDisplay();
  if (!lbp || lbp.displayCurrency !== "LBP") return null;
  const text = lbpEquivalent(props.minor, props.currency, lbp.lbpRate);
  if (text === null) return null;
  return (
    <span className="lbp-equivalent muted small" data-testid={props.testid ?? "lbp-equivalent"}>
      <bdi dir="ltr">{`≈ ${text} ل.ل.`}</bdi>
    </span>
  );
}

/** The header toggle: «ل.ل.» turns the indicative line on, «$» turns it off. Remembered across restarts. */
export function DisplayCurrencyToggle(props: { readonly beforeChange?: () => boolean }) {
  const { t } = useT();
  const lbp = useLbpDisplay();
  if (!lbp) return null;
  const next: DisplayCurrency = lbp.displayCurrency === "USD" ? "LBP" : "USD";
  return (
    <button
      className="btn ghost"
      data-testid="display-currency-toggle"
      data-display-currency={lbp.displayCurrency}
      aria-pressed={lbp.displayCurrency === "LBP"}
      title={t("lbp.toggle.hint")}
      onClick={() => (props.beforeChange ? props.beforeChange() : true) && lbp.setDisplayCurrency(next)}
    >
      {lbp.displayCurrency === "USD" ? t("lbp.toggle.showLbp") : t("lbp.toggle.showUsd")}
      {lbp.toggleError && (
        <span className="error small" role="alert" data-testid="display-currency-error">
          {" "}
          {t(lbp.toggleError === "unconfirmed" ? "lbp.toggle.needsRate" : "lbp.notSaved")}
        </span>
      )}
    </button>
  );
}

/** Owner-only Tools section: the LBP-per-USD rate. Main validates and refuses a non-owner regardless. */
export function LbpRateSection() {
  const { t } = useT();
  const lbp = useLbpDisplay();
  const [typed, setTyped] = useState<string>("");
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  if (!lbp) return null;
  const save = async () => {
    setMessage(null);
    try {
      const saved = await lbp.saveLbpRate(typed === "" ? lbp.lbpRate : typed);
      setTyped("");
      setMessage({ ok: true, text: `${t("lbp.rate.saved")} ${saved}` });
    } catch (e) {
      // F7: a write the disk refused is its own message — never shown as «invalid number», never as saved.
      const code = e instanceof ApiError ? e.code : null;
      setMessage({ ok: false, text: t(code === "SETTINGS_NOT_SAVED" ? "lbp.notSaved" : "lbp.rate.invalid") });
    }
  };
  return (
    <section className="card" data-testid="lbp-rate-section">
      <h2>{t("lbp.rate.title")}</h2>
      <p className="muted small">{t("lbp.rate.explain")}</p>
      <p>
        {t("lbp.rate.current")} <bdi dir="ltr" data-testid="lbp-rate-current">{`1 USD = ${lbp.lbpRate} ل.ل.`}</bdi>
      </p>
      {!lbp.lbpRateConfirmed && (
        <p className="notice small" data-testid="lbp-rate-unconfirmed">
          {t("lbp.rate.unconfirmed")}
        </p>
      )}
      <label className="field">
        <span>{t("lbp.rate.new")}</span>
        <input
          inputMode="decimal"
          dir="ltr"
          value={typed}
          placeholder={lbp.lbpRate}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="lbp-rate-input"
        />
      </label>
      <button className="btn" onClick={() => void save()} data-testid="lbp-rate-save">
        {t("lbp.rate.save")}
      </button>
      {message && (
        <p className={message.ok ? "ok" : "error"} role="status" data-testid="lbp-rate-message">
          {message.text}
        </p>
      )}
    </section>
  );
}
