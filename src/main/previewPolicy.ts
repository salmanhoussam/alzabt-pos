/**
 * OWNER-ONLY R5 PREVIEW (owner decision 2026-11-25): what the preview's NON-demo entry may do.
 *
 * In the packaged preview there is no real shop. The «real» entry exists only as the launcher for «جرّب النظام»:
 * the Welcome screen, the language, the sign-in screen and the Demo lifecycle. Everything else is refused in MAIN,
 * by an explicit ALLOWLIST (secure-delivery §B): new-shop enrollment and setup (no real-shop onboarding before
 * Phase 3), restore and import (no merchant backups), phone invoices and OCR, sales and every business write.
 *
 * Demo processes are NOT governed here: they keep `DEMO_CHANNEL_POLICY` (demoPolicy.ts) unchanged.
 */
import type { IpcResult } from "../shared/ipcContract";

/** The only channels the preview's launcher entry may call. A channel added later is refused until listed here. */
export const PREVIEW_ENTRY_ALLOWED: ReadonlySet<string> = new Set([
  "getEntryState",
  "getSettings",
  "setTerminalLanguage",
  "getAppInfo",
  "currentCashier",
  "listCashiers",
  "login",
  "logout",
]);

export const PREVIEW_REFUSAL: IpcResult<never> = Object.freeze({
  ok: false,
  error: Object.freeze({ code: "NOT_AVAILABLE", message: "Not available in the owner preview" }),
}) as IpcResult<never>;

/** Applies only to the preview build's non-demo entry; every other build and every Demo process passes through. */
export function invokeWithPreviewPolicy<T>(
  preview: boolean,
  mode: unknown,
  name: string,
  invoke: () => T,
): T | IpcResult<never> {
  if (!preview || mode === "demo") return invoke();
  if (!PREVIEW_ENTRY_ALLOWED.has(name)) return PREVIEW_REFUSAL;
  return invoke();
}
