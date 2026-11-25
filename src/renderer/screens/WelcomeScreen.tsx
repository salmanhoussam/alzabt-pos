/**
 * FIRST-RUN WELCOME — «إنشاء حساب» · «تسجيل الدخول» · «جرّب النظام» (joint C1, contract J0-CODEX-1).
 *
 * 🔴 PRESENTATION ONLY. This component calls no channel and decides nothing about security. App draws
 * it only when main's entry state says so (./entryState.ts, which fails closed to the plain login).
 *   - «إنشاء حساب»: App opens the «محل جديد» screen (NewShopScreen → main's `enrollOwner`, O-1 Phase 1).
 *     TRANSITION: it used to send the operator to the sign-in screen to type the published setup code, which
 *     no longer signs in (P1).
 *   - «جرّب النظام»: drawn only when `onDemo` is supplied, i.e. when main reports the demo available.
 *     Starting the demo is main's job (X2/C2), not this screen's.
 */
import { BRAND } from "../../shared/i18n";
import type { DemoLifecycleOutcome } from "../demoControl";
import { useT } from "../i18n";

export function WelcomeScreen({
  onCreateAccount,
  onLogin,
  onDemo,
  demoPending = false,
  demoSlow = false,
  demoOutcome = null,
}: {
  readonly onCreateAccount: () => void;
  readonly onLogin: () => void;
  /** Absent ⇒ no demo choice is drawn. */
  readonly onDemo?: () => void;
  /** main is starting the demo (C2 / BR-C-06). */
  readonly demoPending?: boolean;
  /** Waited past the slow mark — informational only (V7 §5). */
  readonly demoSlow?: boolean;
  readonly demoOutcome?: DemoLifecycleOutcome | null;
}) {
  const { t, lang, setLanguage } = useT();
  return (
    <div className="center login-screen" data-testid="welcome-screen">
      <div className="lang-switch" role="group" aria-label={t("lang.toggle")}>
        <button className={lang === "ar" ? "btn small selected" : "btn small"} aria-pressed={lang === "ar"} lang="ar" onClick={() => setLanguage("ar")}>
          العربية
        </button>
        <button className={lang === "en" ? "btn small selected" : "btn small"} aria-pressed={lang === "en"} lang="en" onClick={() => setLanguage("en")}>
          English
        </button>
      </div>
      <div className="card login welcome">
        <h1 className="wordmark">
          <bdi dir="ltr">{BRAND}</bdi>
        </h1>
        <p className="muted small">{t("app.name")}</p>
        <hr className="rule" />
        <p className="prompt">{t("welcome.title")}</p>
        <p className="muted small">{t("welcome.subtitle")}</p>
        <div className="welcome-choices">
          <button type="button" className="btn primary big wide welcome-choice" onClick={onCreateAccount} data-testid="welcome-create">
            <span className="choice-title">{t("welcome.create")}</span>
            <span className="choice-hint">{t("welcome.createHint")}</span>
          </button>
          <button type="button" className="btn big wide welcome-choice" onClick={onLogin} data-testid="welcome-login">
            <span className="choice-title">{t("welcome.login")}</span>
            <span className="choice-hint">{t("welcome.loginHint")}</span>
          </button>
          {onDemo && (
            <button type="button" className="btn big wide welcome-choice demo-choice" disabled={demoPending} onClick={onDemo} data-testid="welcome-demo">
              <span className="choice-title">{t("welcome.demo")}</span>
              <span className="choice-hint">{t("welcome.demoHint")}</span>
            </button>
          )}
        </div>
        <p className="muted small" data-testid="welcome-local">
          {t("welcome.local")}
        </p>
        {demoPending && (
          <p className="muted" data-testid="welcome-demo-pending">
            {t("demo.pending")}
          </p>
        )}
        {demoPending && demoSlow && (
          <p className="muted" data-testid="welcome-demo-still-waiting">
            {t("demo.stillWaiting")}
          </p>
        )}
        {demoOutcome?.status === "no-answer" && (
          <p className="muted" data-testid="welcome-demo-no-answer">
            {t("demo.noAnswer")}
          </p>
        )}
        {demoOutcome?.status === "failed" && (
          <p className="error" data-testid="welcome-demo-failed">
            {t("demo.actionFailed")}
          </p>
        )}
        {demoOutcome?.status === "limit-reached" && (
          <p className="error" data-testid="welcome-demo-limit">
            {t("demo.limitReached")}
          </p>
        )}
      </div>
    </div>
  );
}
