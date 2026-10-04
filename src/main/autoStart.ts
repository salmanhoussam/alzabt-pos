/**
 * Auto-start with Windows — so the till comes back by itself after the merchant logs in.
 *
 * Mechanism: Electron's own app.setLoginItemSettings(), which on Windows writes a per-user value
 * under HKCU\Software\Microsoft\Windows\CurrentVersion\Run (no admin rights, no Windows Service,
 * no hand-written registry code). The value name is fixed (AUTO_START_ENTRY_NAME) so repeated
 * calls overwrite one entry instead of creating duplicates, and so the uninstaller
 * (build/installer.nsh) can remove exactly that entry.
 *
 * Decision rules (planAutoStart):
 *   - only on Windows and only in a PACKAGED build — `npm start` on a developer machine never
 *     touches the developer's startup list;
 *   - ALZABT_POS_DISABLE_AUTOSTART=1 opts out (support / kiosk images);
 *   - registered ONCE per installation profile, recorded by a small marker file. After that the
 *     app never re-registers, so a merchant who switches it off in Windows Settings › Startup
 *     apps (or Task Manager) stays switched off.
 *
 * What the merchant sees: Windows login → Alzabt POS opens → cashier PIN screen. No tray, no
 * hidden mode.
 *
 * Failure policy: any error is caught and reported; it never stops the POS from starting.
 *
 * This module imports nothing from Electron so the decision logic is tested in plain Node.
 */

export const AUTO_START_ENTRY_NAME = "AlzabtPOS";
export const AUTO_START_MARKER_FILE = "autostart.json";

export interface AutoStartEnvironment {
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly disabledByEnv: boolean;
  readonly alreadyConfigured: boolean;
}

export type AutoStartPlan =
  | { readonly action: "register" }
  | {
      readonly action: "skip";
      readonly reason: "not-windows" | "development-build" | "disabled-by-env" | "already-configured";
    };

export function planAutoStart(env: AutoStartEnvironment): AutoStartPlan {
  if (env.platform !== "win32") return { action: "skip", reason: "not-windows" };
  if (!env.isPackaged) return { action: "skip", reason: "development-build" };
  if (env.disabledByEnv) return { action: "skip", reason: "disabled-by-env" };
  if (env.alreadyConfigured) return { action: "skip", reason: "already-configured" };
  return { action: "register" };
}

/** The slice of Electron's `app` this module needs. */
export interface LoginItemApi {
  setLoginItemSettings(settings: { openAtLogin: boolean; name: string; path: string }): void;
}

/** The slice of the file system this module needs. */
export interface MarkerStore {
  exists(path: string): boolean;
  write(path: string, contents: string): void;
}

export type AutoStartResult =
  | { readonly status: "registered" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly error: string };

export function applyAutoStart(opts: {
  readonly app: LoginItemApi;
  readonly store: MarkerStore;
  readonly markerPath: string;
  readonly executablePath: string;
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
}): AutoStartResult {
  try {
    const plan = planAutoStart({
      platform: opts.platform,
      isPackaged: opts.isPackaged,
      disabledByEnv: opts.env.ALZABT_POS_DISABLE_AUTOSTART === "1",
      alreadyConfigured: opts.store.exists(opts.markerPath),
    });
    if (plan.action === "skip") return { status: "skipped", reason: plan.reason };
    opts.app.setLoginItemSettings({ openAtLogin: true, name: AUTO_START_ENTRY_NAME, path: opts.executablePath });
    // Only after the registration call succeeded: a failed attempt is retried on the next launch.
    opts.store.write(
      opts.markerPath,
      JSON.stringify({ entry: AUTO_START_ENTRY_NAME, configuredAt: opts.now().toISOString() }),
    );
    return { status: "registered" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
