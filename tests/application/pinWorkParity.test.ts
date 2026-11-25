/**
 * O-1 P1-T (owner decision O-14g, contract v3.1 R3): every PIN check does the SAME scrypt work, whatever the input or
 * the account. Proven by COUNTING scrypt calls; no timing is measured and no constant-time claim is made.
 *
 * Before P1-T, an unknown or inactive operator id and a malformed PIN returned BEFORE scrypt, so they answered
 * measurably earlier than a wrong PIN for a real account. Positive controls show that a correct PIN still signs
 * in and that the lockout still counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scrypt = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    scryptSync: (...args: Parameters<typeof real.scryptSync>) => {
      scrypt.calls += 1;
      return real.scryptSync(...args);
    },
  };
});

import { pinCheckWithoutAccount, pinMatches } from "../../src/application/cashierAuth";
import { DomainError } from "../../src/domain/errors";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";
import { TEST_CREDENTIALS, TEST_OWNER_PIN } from "../helpers/testCredentials";

/** scrypt calls made by `fn` alone. */
function work(fn: () => unknown): { calls: number; outcome: unknown } {
  const before = scrypt.calls;
  let outcome: unknown;
  try {
    outcome = fn();
  } catch (e) {
    outcome = e instanceof DomainError ? { code: e.code, message: e.message } : e;
  }
  return { calls: scrypt.calls - before, outcome };
}

const owner = TEST_CREDENTIALS["cashier-01"]!;

describe("pinMatches: one scrypt for every input", () => {
  it.each([
    ["the correct PIN", TEST_OWNER_PIN, true],
    ["a wrong well-formed PIN", "000000", false],
    ["a published PIN", "1111", false],
    ["letters", "abcdef", false],
    ["SQL-looking input", "12'; --", false],
    ["empty", "", false],
    ["too long", "1".repeat(9), false],
    ["very long (cut before hashing)", "9".repeat(10_000), false],
  ])("%s → exactly one scrypt", (_name, pin, expected) => {
    expect(work(() => pinMatches(owner, pin))).toEqual({ calls: 1, outcome: expected });
  });

  it("a non-string never matches and still costs one scrypt", () => {
    expect(work(() => pinMatches(owner, 1234 as unknown as string))).toEqual({ calls: 1, outcome: false });
  });

  it("a corrupt stored hash never matches (no throw), one scrypt", () => {
    expect(work(() => pinMatches({ pinSaltHex: owner.pinSaltHex, pinHashHex: "zz" }, TEST_OWNER_PIN))).toEqual({
      calls: 1,
      outcome: false,
    });
  });

  it("pinCheckWithoutAccount does one scrypt and nothing else", () => {
    expect(work(() => pinCheckWithoutAccount("482613"))).toEqual({ calls: 1, outcome: undefined });
    expect(work(() => pinCheckWithoutAccount(undefined))).toEqual({ calls: 1, outcome: undefined });
  });
});

describe("sign-in paths: no early answer for unknown, inactive or malformed", () => {
  let t: TempDir;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it("OperatorService.authenticate: unknown id, inactive id, malformed and wrong PIN all cost one scrypt and answer identically", () => {
    const h = makeHarness(t.dbPath, { login: true });
    try {
      h.operators.setActive({ id: "cashier-01", name: "Cashier One", role: "owner" }, "cashier-02", false);
      const wrong = work(() => h.operators.authenticate("cashier-01", "000000"));
      const unknown = work(() => h.operators.authenticate("cashier-99", "000000"));
      const inactive = work(() => h.operators.authenticate("cashier-02", "000000"));
      const malformed = work(() => h.operators.authenticate("cashier-01", "12'; --"));
      for (const r of [wrong, unknown, inactive, malformed]) {
        expect(r.calls).toBe(1);
        expect(r.outcome).toEqual({ code: "INVALID_CREDENTIALS", message: "Operator or PIN is incorrect" });
      }
      // Positive control: the right PIN still opens a session, also with one scrypt.
      const ok = work(() => h.operators.authenticate("cashier-01", TEST_OWNER_PIN));
      expect(ok.calls).toBe(1);
      expect((ok.outcome as { kind: string }).kind).toBe("session");
    } finally {
      h.db.close();
    }
  });

  it("PosService.login: an unknown id costs one scrypt, creates no lockout state, and keeps its generic refusal", () => {
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const unknown = work(() => h.service.login("cashier-99", "000000"));
      expect(unknown.calls).toBe(1);
      expect(unknown.outcome).toEqual({ code: "INVALID_CREDENTIALS", message: "Cashier or PIN is incorrect" });
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM cashier_pin_state").get()).toEqual({ n: 0n });
    } finally {
      h.db.close();
    }
  });

  it("PosService.login: a malformed PIN for a real account costs one scrypt AND is counted by the lockout", () => {
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const r = work(() => h.service.login("cashier-01", "12'; --"));
      expect(r.calls).toBe(1);
      expect(r.outcome).toMatchObject({ code: "INVALID_CREDENTIALS" });
      expect(h.db.prepare("SELECT failed_attempts AS n FROM cashier_pin_state WHERE cashier_id = 'cashier-01'").get()).toEqual({ n: 1n });
      // Positive control: the correct PIN still signs in afterwards.
      expect((work(() => h.service.login("cashier-01", TEST_OWNER_PIN)).outcome as { kind: string }).kind).toBe("session");
    } finally {
      h.db.close();
    }
  });
});
