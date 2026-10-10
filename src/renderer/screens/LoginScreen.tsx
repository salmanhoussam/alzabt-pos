import { useCallback, useEffect, useState } from "react";
import type { CashierDto, LoginResponse } from "../../shared/ipcContract";
import { BRAND } from "../../shared/i18n";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/** The product's real rule, preserved: entry caps at 8, submit unlocks at 4. Not a fixed length. */
const PIN_MAX = 8;
const PIN_MIN = 4;

/**
 * 🔴 `onOutcome`, NOT `onLogin`. Since migration 8 a correct PIN may be a LEGACY BOOTSTRAP
 * credential, which yields a setup ticket and NO session. This screen must not assume it signed
 * anybody in, so it hands the outcome up and App decides which screen comes next.
 */
export function LoginScreen({ onOutcome }: { onOutcome: (r: LoginResponse) => void }) {
  const { t, lang, setLanguage } = useT();
  const [cashiers, setCashiers] = useState<CashierDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call(pos().listCashiers()).then(setCashiers).catch((e) => setError(errorText(e)));
  }, []);

  const press = useCallback((key: (typeof KEYS)[number]) => {
    setError(null);
    if (key === "clear") setPin("");
    else if (key === "back") setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < PIN_MAX ? p + key : p));
  }, []);

  const submit = useCallback(async () => {
    if (!selected || pin.length < PIN_MIN) return;
    setBusy(true);
    try {
      onOutcome(await call(pos().login({ cashierId: selected, pin })));
    } catch (e) {
      setError(errorText(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  }, [onOutcome, pin, selected]);

  /**
   * The physical keyboard mirrors the on-screen pad.
   *
   * 🔴 ONE PIN STATE, NEVER TWO PATHS. Both the keypad buttons and these keys go through the same
   * `press`/`setPin`, so the two inputs can never disagree about what has been typed — which is
   * the way a parallel "keyboard buffer" would eventually desynchronise from the dots on screen.
   *
   * 🔴 INPUT PARITY, NOT AN AUTHENTICATION CHANGE. Enter submits only through `submit`, which
   * enforces the same `pin.length < PIN_MIN` guard the button does; nothing about what counts as a
   * valid PIN moves. A cashier typing on the physical keyboard was previously unable to log in at
   * all without reaching for the mouse.
   */
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // `e.key` is "0".."9" for both the top row and the Numpad, so one branch covers both.
      if (e.key >= "0" && e.key <= "9" && e.key.length === 1) {
        e.preventDefault();
        press(e.key as (typeof KEYS)[number]);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        press("back");
      } else if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPin("");
      }
      // Every other printable key is ignored: letters must not enter PIN data.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, selected, submit]);

  return (
    <div className="center login-screen">
      {/* 🔴 THE LANGUAGE CONTROL BELONGS BEFORE AUTHENTICATION. It used to live only in the
          signed-in shell, so the first screen an Arabic-only cashier ever saw was English with no
          way to change it. A segmented pair shows which language is active, rather than a single
          button labelled with the other one. */}
      <div className="lang-switch" role="group" aria-label={t("lang.toggle")} data-testid="login-lang">
        <button
          className={lang === "ar" ? "btn small selected" : "btn small"}
          aria-pressed={lang === "ar"}
          lang="ar"
          onClick={() => setLanguage("ar")}
        >
          العربية
        </button>
        <button
          className={lang === "en" ? "btn small selected" : "btn small"}
          aria-pressed={lang === "en"}
          lang="en"
          onClick={() => setLanguage("en")}
        >
          English
        </button>
      </div>
      <div className="card login">
        {/* The brand is never translated; the Arabic interface label sits under it. */}
        <h1 className="wordmark"><bdi dir="ltr">{BRAND}</bdi></h1>
        <p className="muted small">{t("app.name")}</p>
        <hr className="rule" />

        {!selected && <p className="prompt" data-testid="select-cashier">{t("login.selectCashier")}</p>}
        {selected && (
          <>
            <p className="prompt">{cashiers.find((c) => c.id === selected)?.name}</p>
            <button
              className="btn ghost small"
              data-testid="change-cashier"
              onClick={() => {
                setSelected(null);
                setPin("");
                setError(null);
              }}
            >
              {t("login.changeCashier")}
            </button>
          </>
        )}

        {!selected && (
          <div className="cashiers">
            {cashiers.map((c) => (
              <button
                key={c.id}
                className="btn big"
                onClick={() => {
                  setSelected(c.id);
                  setPin("");
                  setError(null);
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {selected && (
          <>
            <div className="pin" aria-label={t("login.pin")} data-testid="pin-display">
              {pin.length ? "•".repeat(pin.length) : <span className="muted">{t("login.enterPin")}</span>}
            </div>
            {/* 🔴 numeric-layout = dir:ltr. A keypad is a PHYSICAL layout, not text: under RTL the
                grid flows 3-2-1 and the backspace glyph mirrors with it. Every phone, ATM and card
                terminal is 1-2-3 left to right, and that layout is in the operator's hand. */}
            <div className="keypad numeric-layout">
              {KEYS.map((k) => (
                <button
                  key={k}
                  className="btn key"
                  aria-label={k === "clear" ? t("login.clear") : k === "back" ? t("login.backspace") : k}
                  onClick={() => press(k)}
                >
                  {k === "clear" ? t("login.clear") : k === "back" ? "⌫" : k}
                </button>
              ))}
            </div>
            <button
              className="btn primary big wide"
              disabled={busy || pin.length < PIN_MIN}
              data-testid="login-submit"
              onClick={() => void submit()}
            >
              {t("login.submit")}
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
