/**
 * FIRST-RUN ENTRY STATE — the renderer's side of contract J0-CODEX-1 §A (BR-C-01).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 A UX ROUTING HINT, NEVER AUTHORITY. Main computes this DTO; the renderer only chooses which
 * screen to draw from it. `firstRunEligible` is NOT proof of a fresh install or of the absence of
 * merchant data, and nothing here grants a ticket, a session or a profile. While O-1 is open the
 * Welcome screen's «إنشاء حساب» leads to the EXISTING setup path — no new authentication exists.
 *
 * 🔴 IT FAILS CLOSED TO THE LEGACY LOGIN. Until X1 binds `getEntryState` (owned by Codex in
 * ipcContract.ts / preload.ts), the channel does not exist and this adapter answers LEGACY_ENTRY —
 * so this build behaves exactly like the Candidate. A malformed answer, an error, or an unknown
 * value is treated the same way. Showing the plain login is always safe; showing «إنشاء حساب» on a
 * ledger main did not vouch for is not.
 *
 * The type mirrors the signed DTO here because `ipcContract.ts` belongs to the security owner; at
 * integration (J1) this local type is replaced by the bound one.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { EntryStateDto } from "../shared/ipcContract";

/** J1: the bound X1 DTO (ipcContract.ts, J0-CODEX-1 §A). The strict parser below still validates every answer. */
export type EntryState = EntryStateDto;

/** The safe default: a real, configured-looking terminal → the plain login, no demo offer. */
export const LEGACY_ENTRY: EntryState = Object.freeze({
  profile: "real",
  terminalClaimed: true,
  firstRunEligible: false,
  demoAvailable: false,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Strictly validates an answer. Any extra key, missing key or wrong type → LEGACY_ENTRY. Extra keys
 * are refused on purpose: a DTO that suddenly carries more (a PIN, a path) is a contract break, and
 * the renderer must not quietly start relying on it.
 */
export function parseEntryState(raw: unknown): EntryState {
  if (!isRecord(raw)) return LEGACY_ENTRY;
  const allowed = new Set(["profile", "terminalClaimed", "firstRunEligible", "demoAvailable", "demoRetention"]);
  if (Object.keys(raw).some((k) => !allowed.has(k))) return LEGACY_ENTRY;
  const { profile, terminalClaimed, firstRunEligible, demoAvailable, demoRetention } = raw;
  if (profile !== "real" && profile !== "demo") return LEGACY_ENTRY;
  if (typeof terminalClaimed !== "boolean" || typeof firstRunEligible !== "boolean" || typeof demoAvailable !== "boolean") return LEGACY_ENTRY;
  // A claimed terminal can never be first-run eligible: contradictory answers are not trusted.
  if (terminalClaimed && firstRunEligible) return LEGACY_ENTRY;
  let retention: EntryState["demoRetention"];
  if (demoRetention !== undefined) {
    if (!isRecord(demoRetention)) return LEGACY_ENTRY;
    const { retained, max, reached } = demoRetention;
    if (typeof retained !== "number" || !Number.isInteger(retained) || retained < 0 || max !== 5 || typeof reached !== "boolean") return LEGACY_ENTRY;
    if (reached !== retained >= max) return LEGACY_ENTRY;
    retention = { retained, max: 5, reached };
  }
  return {
    profile,
    terminalClaimed,
    firstRunEligible,
    // At the retention limit the demo is not offered, whatever the flag says.
    demoAvailable: demoAvailable && !(retention?.reached ?? false),
    ...(retention ? { demoRetention: retention } : {}),
  };
}

/**
 * C1-R1 (Codex cross-review): the hint is OPTIONAL, so it may never hold the app hostage. Past this
 * bound the answer is LEGACY_ENTRY (the plain login). Chosen well above a local IPC round trip and
 * well below a user's patience on a start-up screen.
 */
export const ENTRY_STATE_TIMEOUT_MS = 1500;

/**
 * Reads the entry state through the bound channel if it exists; otherwise, on any failure, or when no
 * answer arrives within `timeoutMs`, LEGACY_ENTRY. Never rejects and never waits longer than the bound.
 */
export async function readEntryState(api: unknown, timeoutMs: number = ENTRY_STATE_TIMEOUT_MS): Promise<EntryState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EntryState>((resolve) => {
    timer = setTimeout(() => resolve(LEGACY_ENTRY), timeoutMs);
  });
  const answer = (async (): Promise<EntryState> => {
    try {
      if (!isRecord(api) || typeof api.getEntryState !== "function") return LEGACY_ENTRY;
      const result: unknown = await (api.getEntryState as () => Promise<unknown>)();
      if (!isRecord(result) || result.ok !== true) return LEGACY_ENTRY;
      return parseEntryState(result.data);
    } catch {
      return LEGACY_ENTRY;
    }
  })();
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * C1-R1 / C1-R2: a late answer must never overwrite a newer decision. Each `load()` belongs to a
 * generation; `invalidate()` (after setup, at logout, on unmount) supersedes every read in flight,
 * whose result is then delivered as `null` and ignored by the caller.
 */
export class EntryStateLoader {
  private generation = 0;

  constructor(private readonly read: () => Promise<EntryState>) {}

  async load(): Promise<EntryState | null> {
    const mine = ++this.generation;
    const state = await this.read();
    return mine === this.generation ? state : null;
  }

  invalidate(): void {
    this.generation++;
  }
}

/** The logged-out entry routing, as one value so its transitions are testable without a DOM. */
export interface EntryUi {
  /** undefined = being (re-)read; the shell shows Loading, bounded by ENTRY_STATE_TIMEOUT_MS. */
  readonly entry: EntryState | undefined;
  readonly preLogin: PreLogin | null;
  /** The operator came from «إنشاء حساب» (O-1 open: the existing setup path, with its note). */
  readonly fromCreate: boolean;
}

export type EntryUiEvent =
  | { readonly type: "loaded"; readonly entry: EntryState }
  | { readonly type: "choose-create" }
  | { readonly type: "choose-login" }
  | { readonly type: "back" }
  /** C1-R2: a setup completed, so this terminal is claimed now, whatever the hint said at start-up. */
  | { readonly type: "setup-complete" }
  /** C1-R2: signed out; the hint must be read afresh, never reused from start-up. */
  | { readonly type: "logout" };

export const INITIAL_ENTRY_UI: EntryUi = Object.freeze({ entry: undefined, preLogin: null, fromCreate: false });

export function entryUiReducer(state: EntryUi, event: EntryUiEvent): EntryUi {
  switch (event.type) {
    case "loaded":
      return { ...state, entry: event.entry };
    case "choose-create":
      return { ...state, preLogin: "login", fromCreate: true };
    case "choose-login":
      return { ...state, preLogin: "login", fromCreate: false };
    case "back":
      return { ...state, preLogin: null, fromCreate: false };
    case "setup-complete":
      // Never Welcome or the Create Account note again on the strength of a start-up hint.
      return { entry: LEGACY_ENTRY, preLogin: null, fromCreate: false };
    case "logout":
      return { entry: undefined, preLogin: null, fromCreate: false };
  }
}

/** Whether the Create Account note shows above the plain login. */
export function showsCreateNote(ui: EntryUi): boolean {
  return ui.entry !== undefined && ui.fromCreate && preLoginScreen(ui.entry, null) === "welcome";
}

/** Which pre-login screen to draw. Pure, so its whole table is testable. */
export type PreLogin = "welcome" | "login";

export function preLoginScreen(entry: EntryState, chosen: PreLogin | null): PreLogin {
  // The demo process never draws the Welcome screen (its entry is C2's, and signed-in by main).
  if (entry.profile !== "real") return "login";
  if (entry.terminalClaimed || !entry.firstRunEligible) return "login";
  return chosen ?? "welcome";
}

/** The demo choice is offered only when main says so for a real process (never an authorization). */
export function offersDemo(entry: EntryState): boolean {
  return entry.profile === "real" && entry.demoAvailable;
}
