/**
 * Cashier PIN lockout — THE single place the policy is defined. UI and service code read these
 * values; nobody else hard-codes them.
 *
 * Policy (Gate 2):
 *   - Failures are counted PER CASHIER, consecutively. One cashier's typos never lock another.
 *   - After MAX_CONSECUTIVE_FAILURES wrong PINs the cashier is locked for LOCK_DURATION_MS.
 *   - While locked, EVERY attempt is refused — the correct PIN included — and attempts made
 *     during the lock do not extend it (a passer-by cannot keep a cashier locked out forever).
 *   - The lock expires by itself; no manager or support call is needed. After expiry the counter
 *     starts fresh.
 *   - A successful login clears the counter.
 *   - The state is persisted (SQLite), so restarting the app does not reset the counter or lift a
 *     lock — otherwise the policy would mean nothing.
 *
 * Why 5 / 5 minutes: a 4–8 digit PIN on a shop terminal is a speed bump, not strong
 * authentication. Five tries absorbs honest typos at a busy till; five minutes makes guessing
 * 10,000 four-digit PINs take days at the counter while never stranding a cashier for long.
 */

export const PIN_LOCKOUT_POLICY = Object.freeze({
  maxConsecutiveFailures: 5,
  lockDurationMs: 5 * 60 * 1000,
});

export interface PinLockoutState {
  readonly failedAttempts: number;
  /** ISO-8601 instant, or null when not locked. */
  readonly lockedUntil: string | null;
}

export const CLEAR_PIN_STATE: PinLockoutState = Object.freeze({ failedAttempts: 0, lockedUntil: null });

export type LockCheck =
  | { readonly locked: false }
  | { readonly locked: true; readonly lockedUntil: Date; readonly remainingMs: number };

export function checkLock(state: PinLockoutState, now: Date): LockCheck {
  if (!state.lockedUntil) return { locked: false };
  const until = new Date(state.lockedUntil);
  const remainingMs = until.getTime() - now.getTime();
  return remainingMs > 0 ? { locked: true, lockedUntil: until, remainingMs } : { locked: false };
}

/** The state after one more wrong PIN. Call only when checkLock() says not locked. */
export function afterFailure(state: PinLockoutState, now: Date): PinLockoutState {
  // A lock that has expired is history: the next run of attempts starts from zero.
  const base = state.lockedUntil !== null ? CLEAR_PIN_STATE : state;
  const failedAttempts = base.failedAttempts + 1;
  if (failedAttempts >= PIN_LOCKOUT_POLICY.maxConsecutiveFailures) {
    return {
      failedAttempts,
      lockedUntil: new Date(now.getTime() + PIN_LOCKOUT_POLICY.lockDurationMs).toISOString(),
    };
  }
  return { failedAttempts, lockedUntil: null };
}

export function attemptsRemaining(state: PinLockoutState): number {
  return Math.max(0, PIN_LOCKOUT_POLICY.maxConsecutiveFailures - state.failedAttempts);
}

/** Whole minutes left, rounded up, for the cashier-facing message. */
export function minutesRemaining(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 60000));
}
