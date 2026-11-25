/**
 * TRY DEMO — the permanent banner of the DEMO process, on every screen (joint C2).
 *
 * 🔴 DISPLAY AND REQUESTS ONLY. What makes the demo what it is lives in MAIN (X2): the trusted demo
 * profile, the demo policy (DEMO_RESTRICTED), preview-only documents. This banner states the mode
 * plainly and, when main exposes the lifecycle channel (BR-C-06), asks main to leave or restart the
 * demo; main confirms natively. Without that channel it draws no buttons at all.
 *
 * The wording claims no isolation guarantee (rule E): it says what the operator is looking at.
 */
import { useT } from "../i18n";
import type { DemoAction, DemoLifecycleOutcome } from "../demoControl";

export function DemoBanner({
  canControl,
  pending,
  slow = false,
  outcome,
  onAction,
}: {
  readonly canControl: boolean;
  readonly pending: DemoAction | null;
  /** The renderer has waited past DEMO_LIFECYCLE_SLOW_MS — informational only. */
  readonly slow?: boolean;
  readonly outcome: DemoLifecycleOutcome | null;
  readonly onAction: (action: DemoAction) => void;
}) {
  const { t } = useT();
  return (
    <div className="demo-banner demo-mode-banner" role="status" data-testid="demo-mode-banner">
      <strong>{t("demo.banner")}</strong>
      <span className="demo-hint">{t("demo.previewOnly")}</span>
      {canControl && (
        <span className="demo-actions">
          <button type="button" className="btn small" disabled={pending !== null} onClick={() => onAction("reset")} data-testid="demo-reset">
            {t("demo.reset")}
          </button>
          <button type="button" className="btn small" disabled={pending !== null} onClick={() => onAction("exit")} data-testid="demo-exit">
            {t("demo.exit")}
          </button>
        </span>
      )}
      {pending !== null && (
        <span className="muted" data-testid="demo-pending">
          {t("demo.pending")}
        </span>
      )}
      {pending !== null && slow && (
        <span className="muted" data-testid="demo-still-waiting">
          {t("demo.stillWaiting")}
        </span>
      )}
      {outcome?.status === "no-answer" && (
        <span className="muted" data-testid="demo-no-answer">
          {t("demo.noAnswer")}
        </span>
      )}
      {outcome?.status === "failed" && (
        <span className="error" data-testid="demo-action-failed">
          {t("demo.actionFailed")}
        </span>
      )}
      {outcome?.status === "limit-reached" && (
        <span className="error" data-testid="demo-limit">
          {t("demo.limitReached")}
        </span>
      )}
    </div>
  );
}

/** The demo process with no session: main refused to sign the demo in. No login form is offered. */
export function DemoUnavailable({ canExit = false }: { readonly canExit?: boolean }) {
  const { t } = useT();
  return (
    <div className="center login-screen" data-testid="demo-unavailable">
      <div className="card login">
        <p className="prompt">{t("demo.unavailableTitle")}</p>
        {/* V7 §2: exit works in the trusted Demo process even without a session — the banner above carries it. */}
        <p className="muted small">{t(canExit ? "demo.unavailableBodyExit" : "demo.unavailableBody")}</p>
      </div>
    </div>
  );
}
