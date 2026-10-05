/**
 * Ledger guard — the app must never silently start a NEW, EMPTY ledger when the merchant's real one
 * should be there (deleted, moved, renamed, or the profile folder pointed elsewhere). SQLite would
 * happily create an empty file and the till would look "fine" with no history.
 *
 * Mechanism: after the first successful open, a marker `ledger.json` is written next to the ledger.
 *   ledger file present                 → open it (fileMustExist), adopt/refresh the marker
 *   ledger missing, marker present      → LedgerMissingError: refuse to start, create nothing
 *   ledger missing, no marker (fresh)   → create a new ledger
 * Databases from 0.1.0 (no marker yet) are adopted on their first open by 0.1.1.
 *
 * Pure decisions over an injected file-system port, so every branch is unit-tested.
 */
import { join } from "node:path";

export const LEDGER_FILE_NAME = "alzabt-pos-ledger.sqlite";
export const LEDGER_MARKER_FILE_NAME = "ledger.json";

export class LedgerMissingError extends Error {
  constructor() {
    super("The ledger file is missing but this profile already had one; refusing to create an empty ledger");
    this.name = "LedgerMissingError";
  }
}

export interface LedgerFs {
  exists(path: string): boolean;
  writeAtomic(path: string, contents: string): void;
}

export interface LedgerPlan {
  readonly ledgerPath: string;
  readonly markerPath: string;
  /** True when the ledger must already exist (open with fileMustExist). */
  readonly existing: boolean;
}

export function planLedgerOpen(userDataDir: string, fs: LedgerFs): LedgerPlan {
  const ledgerPath = join(userDataDir, LEDGER_FILE_NAME);
  const markerPath = join(userDataDir, LEDGER_MARKER_FILE_NAME);
  const ledgerExists = fs.exists(ledgerPath);
  if (!ledgerExists && fs.exists(markerPath)) throw new LedgerMissingError();
  return { ledgerPath, markerPath, existing: ledgerExists };
}

/** Records that this profile owns a ledger. Written after every successful open (cheap, idempotent). */
export function recordLedger(plan: LedgerPlan, fs: LedgerFs, info: { appVersion: string; now: Date }): void {
  if (fs.exists(plan.markerPath)) return;
  fs.writeAtomic(
    plan.markerPath,
    JSON.stringify({ ledgerFile: LEDGER_FILE_NAME, recordedAt: info.now.toISOString(), recordedByVersion: info.appVersion }, null, 2),
  );
}
