/**
 * Opt-in lifecycle diagnostics. OFF unless ALZABT_POS_DIAG_LOG names a file; then each lifecycle
 * event is appended as one JSON line ({t, pid, ppid, event, ...}). Used by the Windows crash
 * investigation (e2e/crash-recovery.mjs) to observe what a launch actually did — including a
 * launch that exits before any window exists. Never throws; never changes behaviour.
 */
import { appendFileSync } from "node:fs";

const target = process.env.ALZABT_POS_DIAG_LOG;

export const diagEnabled = Boolean(target);

export function diag(event: string, data: Record<string, unknown> = {}): void {
  if (!target) return;
  try {
    appendFileSync(target, JSON.stringify({ t: Date.now(), pid: process.pid, ppid: process.ppid, event, ...data }) + "\n");
  } catch {
    // diagnostics must never affect the till
  }
}
