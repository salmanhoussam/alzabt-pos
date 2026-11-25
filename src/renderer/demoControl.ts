/**
 * DEMO LIFECYCLE — the renderer's side of BR-C-06 V7 (CLAUDE-PROPOSED-G2-BINDING-ADDENDUM-LIFECYCLE-V7.md,
 * SHA-256 2bb14326…; binding only once BOTH agents sign that exact hash). Entering, leaving and restarting the demo are MAIN's decisions (X2: trusted
 * profile choice before any database opens; F04: the confirmation is a main-side native dialog, never
 * this renderer's). The renderer only ASKS.
 *
 * Proposed channel (Codex owns ipcContract/preload/policy):
 *     requestDemoLifecycle(req: { action: "enter" | "exit" | "reset" })
 *       → IpcResult<{ status: "restarting" } | { status: "cancelled" }>
 *     The retention limit is a REFUSAL (error code DEMO_RETENTION_LIMIT), never a success status (V7 §7).
 *
 * 🔴 FAILS CLOSED AND QUIET. Until the channel exists this adapter reports it unavailable, and the
 * shell then draws NO demo action at all (no button that does nothing). Any malformed answer, error or
 * timeout becomes a neutral `failed` — never a raw message, path or exception text.
 */

export type DemoAction = "enter" | "exit" | "reset";
export type DemoLifecycleOutcome =
  | { readonly status: "restarting" }
  | { readonly status: "cancelled" }
  | { readonly status: "limit-reached" }
  | { readonly status: "unavailable" }
  | { readonly status: "failed" }
  /** The renderer stopped waiting. INFORMATIONAL ONLY (V7 §5): Main may still be showing its confirmation. */
  | { readonly status: "no-answer" };

/**
 * V7 §5: Main bounds its own native confirmation at 60 s and latches the outcome. The renderer waits LONGER
 * and its timeout never cancels, retries or decides anything — it only changes what the screen says.
 */
export const DEMO_LIFECYCLE_TIMEOUT_MS = 75_000;
/** After this the screen adds a neutral "still waiting" line (the confirmation may simply be open). */
export const DEMO_LIFECYCLE_SLOW_MS = 10_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether the bound channel exists. Presence is not permission: main still decides and confirms. */
export function demoLifecycleAvailable(api: unknown): boolean {
  return isRecord(api) && typeof api.requestDemoLifecycle === "function";
}

export async function requestDemoLifecycle(
  api: unknown,
  action: DemoAction,
  timeoutMs: number = DEMO_LIFECYCLE_TIMEOUT_MS,
  onSlow?: () => void,
  slowMs: number = DEMO_LIFECYCLE_SLOW_MS,
): Promise<DemoLifecycleOutcome> {
  if (!demoLifecycleAvailable(api)) return { status: "unavailable" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slowTimer = onSlow ? setTimeout(onSlow, slowMs) : undefined;
  const timeout = new Promise<DemoLifecycleOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "no-answer" }), timeoutMs);
  });
  const answer = (async (): Promise<DemoLifecycleOutcome> => {
    try {
      const result: unknown = await (api as { requestDemoLifecycle: (r: unknown) => Promise<unknown> }).requestDemoLifecycle({ action });
      if (!isRecord(result)) return { status: "failed" };
      if (result.ok !== true) {
        const code = isRecord(result.error) ? result.error.code : undefined;
        return code === "DEMO_RETENTION_LIMIT" ? { status: "limit-reached" } : { status: "failed" };
      }
      const data = result.data;
      if (!isRecord(data) || Object.keys(data).length !== 1) return { status: "failed" };
      if (data.status === "restarting" || data.status === "cancelled") return { status: data.status };
      return { status: "failed" };
    } catch {
      return { status: "failed" };
    }
  })();
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (slowTimer !== undefined) clearTimeout(slowTimer);
  }
}

/** What the demo shell shows, decided purely from main's hint and the session. */
export type DemoShell = "not-demo" | "demo-session" | "demo-no-session";

export function demoShellFor(profile: "real" | "demo", hasSession: boolean): DemoShell {
  if (profile !== "demo") return "not-demo";
  // D-6: main signs the demo in before the window loads. No session means main refused it (failed
  // seed, unverified ledger, …): the renderer must NOT offer a login form as a way around that.
  return hasSession ? "demo-session" : "demo-no-session";
}
