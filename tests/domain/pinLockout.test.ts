import { describe, expect, it } from "vitest";
import {
  CLEAR_PIN_STATE,
  PIN_LOCKOUT_POLICY,
  afterFailure,
  attemptsRemaining,
  checkLock,
  minutesRemaining,
} from "../../src/domain/pinLockout";

const T0 = new Date("2026-10-04T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("PIN lockout policy (pure)", () => {
  it("is defined once: 5 consecutive failures, 5-minute lock", () => {
    expect(PIN_LOCKOUT_POLICY).toEqual({ maxConsecutiveFailures: 5, lockDurationMs: 300000 });
    expect(Object.isFrozen(PIN_LOCKOUT_POLICY)).toBe(true);
  });

  it("counts failures and locks exactly at the threshold", () => {
    let s = CLEAR_PIN_STATE;
    for (let i = 1; i < PIN_LOCKOUT_POLICY.maxConsecutiveFailures; i++) {
      s = afterFailure(s, T0);
      expect(s).toEqual({ failedAttempts: i, lockedUntil: null });
      expect(checkLock(s, T0).locked).toBe(false);
    }
    expect(attemptsRemaining(s)).toBe(1);
    s = afterFailure(s, T0);
    expect(s.lockedUntil).toBe(at(300000).toISOString());
    expect(checkLock(s, T0)).toMatchObject({ locked: true, remainingMs: 300000 });
  });

  it("the lock ends exactly at lockedUntil, and the next run of failures starts from zero", () => {
    let s = CLEAR_PIN_STATE;
    for (let i = 0; i < 5; i++) s = afterFailure(s, T0);
    expect(checkLock(s, at(299999)).locked).toBe(true);
    expect(checkLock(s, at(300000)).locked).toBe(false);
    expect(afterFailure(s, at(300000))).toEqual({ failedAttempts: 1, lockedUntil: null });
  });

  it("rounds remaining time up to whole minutes for the message", () => {
    expect(minutesRemaining(300000)).toBe(5);
    expect(minutesRemaining(240001)).toBe(5);
    expect(minutesRemaining(1)).toBe(1);
  });
});
