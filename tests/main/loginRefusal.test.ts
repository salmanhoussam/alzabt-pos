import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { loginRefusalContext } from "../../src/main/ipcHandlers";
import { errorText } from "../../src/renderer/api";
import { ApiError } from "../../src/renderer/api";
import { loginRefusal } from "../../src/renderer/refusalText";
import { type TempDir, TestClock, makeHarness, tempDir } from "../helpers/harness";

/**
 * I18N-LOGIN-PIN (owner finding DEC-33 #3, FIELD UAT 2026-11-06): the wrong-PIN refusal was English on
 * the Arabic login. The numbers now cross as DATA; the renderer composes the Arabic. English unchanged.
 */

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

function refusal(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("the service attaches the numbers, and the English message is unchanged", () => {
  it("a wrong PIN carries attempts left and the lock length; the 5th locks with the minutes remaining", () => {
    const clock = new TestClock();
    const h = makeHarness(t.dbPath, { clock, login: false });
    try {
      const first = refusal(() => h.service.login("cashier-01", "0000"));
      expect(first.code).toBe("INVALID_CREDENTIALS");
      expect(first.message).toBe("Cashier or PIN is incorrect. 4 attempts left before a 5-minute lock.");
      expect(first.context).toEqual({ reason: "LOGIN_PIN_WRONG", attemptsLeft: 4, lockMinutes: 5 });
      expect(loginRefusalContext(first)).toEqual({ reason: "LOGIN_PIN_WRONG", attemptsLeft: 4, lockMinutes: 5 });

      for (let i = 0; i < 3; i++) refusal(() => h.service.login("cashier-01", "0000"));
      const locked = refusal(() => h.service.login("cashier-01", "0000"));
      expect(locked.code).toBe("CASHIER_LOCKED");
      expect(locked.message).toContain("is locked — try again in 5 minutes.");
      expect(loginRefusalContext(locked)).toEqual({ reason: "LOGIN_PIN_LOCKED", minutesRemaining: 5 });
    } finally {
      h.db.close();
    }
  });

  it("an unknown operator carries only its reason — no count, no name", () => {
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const e = refusal(() => h.service.login("nobody", "0000"));
      expect(e.message).toBe("Cashier or PIN is incorrect");
      expect(loginRefusalContext(e)).toEqual({ reason: "LOGIN_UNKNOWN_OPERATOR" });
    } finally {
      h.db.close();
    }
  });

  it("🔴 any other error, or a malformed context, crosses with NO context", () => {
    expect(loginRefusalContext(new DomainError("INVALID_INPUT", "x"))).toBeNull();
    expect(
      loginRefusalContext(new DomainError("INVALID_CREDENTIALS", "x", "LOGIN_PIN_WRONG", { reason: "LOGIN_PIN_WRONG", attemptsLeft: -1, lockMinutes: 5 })),
    ).toBeNull();
    expect(
      loginRefusalContext(new DomainError("CASHIER_LOCKED", "x", "LOGIN_PIN_WRONG", { reason: "LOGIN_PIN_WRONG", attemptsLeft: 1, lockMinutes: 5 })),
    ).toBeNull();
    expect(loginRefusalContext(new DomainError("INVALID_AMOUNT", "x", "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING", { outstandingMinor: 1n, currency: "USD" }))).toBeNull();
  });
});

describe("the renderer says it in Arabic, from the numbers", () => {
  it("wrong PIN, locked, unknown operator", () => {
    expect(loginRefusal("ar", "INVALID_CREDENTIALS", { reason: "LOGIN_PIN_WRONG", attemptsLeft: 4, lockMinutes: 5 })).toBe(
      "الرمز غير صحيح. المحاولات المتبقّية قبل إيقاف الدخول مؤقّتاً: ⁨4⁩. مدّة الإيقاف بالدقائق: ⁨5⁩.",
    );
    expect(loginRefusal("ar", "CASHIER_LOCKED", { reason: "LOGIN_PIN_LOCKED", minutesRemaining: 3 })).toBe(
      "أُوقف الدخول مؤقّتاً بعد عدّة محاولات خاطئة. حاول مجدّداً بعد عدد الدقائق: ⁨3⁩.",
    );
    expect(loginRefusal("ar", "INVALID_CREDENTIALS", { reason: "LOGIN_UNKNOWN_OPERATOR" })).toBe("الكاشير أو الرمز غير صحيح.");
  });

  it("🔴 English is never composed here — the main process's sentence is shown byte-for-byte", () => {
    expect(loginRefusal("en", "INVALID_CREDENTIALS", { reason: "LOGIN_PIN_WRONG", attemptsLeft: 4, lockMinutes: 5 })).toBeNull();
    const err = new ApiError("INVALID_CREDENTIALS", "Cashier or PIN is incorrect. 4 attempts left before a 5-minute lock.", {
      reason: "LOGIN_PIN_WRONG",
      attemptsLeft: 4,
      lockMinutes: 5,
    });
    expect(errorText(err, "en")).toBe("Cashier or PIN is incorrect. 4 attempts left before a 5-minute lock.");
    expect(errorText(err, "ar")).toContain("الرمز غير صحيح");
  });

  it("🔴 a code / reason mismatch, an extra key, or a non-integer returns null (the English is shown)", () => {
    expect(loginRefusal("ar", "CASHIER_LOCKED", { reason: "LOGIN_PIN_WRONG", attemptsLeft: 4, lockMinutes: 5 })).toBeNull();
    expect(loginRefusal("ar", "INVALID_CREDENTIALS", { reason: "LOGIN_PIN_WRONG", attemptsLeft: 4, lockMinutes: 5, name: "x" })).toBeNull();
    expect(loginRefusal("ar", "INVALID_CREDENTIALS", { reason: "LOGIN_PIN_WRONG", attemptsLeft: 4.5, lockMinutes: 5 })).toBeNull();
    expect(loginRefusal("ar", "INVALID_CREDENTIALS", null)).toBeNull();
    expect(loginRefusal("ar", "INVALID_CREDENTIALS", undefined)).toBeNull();
  });
});
