/**
 * PIN lockout through the real service + SQLite, with a controlled clock (no sleeps).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type TempDir, TestClock, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

function attempt(fn: () => unknown): { code: string; message: string } | "ok" {
  try {
    fn();
    return "ok";
  } catch (err) {
    if (err instanceof DomainError) return { code: err.code, message: err.message };
    throw err;
  }
}

const MIN = 60000;

function setup(clock = new TestClock()) {
  const h = makeHarness(t.dbPath, { clock, login: false });
  const pinRow = (id: string) =>
    h.db.prepare("SELECT failed_attempts, locked_until FROM cashier_pin_state WHERE cashier_id = ?").get(id) as
      | { failed_attempts: bigint; locked_until: string | null }
      | undefined;
  return { ...h, pinRow };
}

function failTimes(service: ReturnType<typeof setup>["service"], id: string, n: number) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(attempt(() => service.login(id, "0000")));
  return results;
}

describe("cashier PIN lockout (service + SQLite)", () => {
  it("wrong PINs are counted and the message says how many attempts remain", () => {
    const { db, service, pinRow } = setup();
    const r = failTimes(service, "cashier-01", 2);
    expect(r[0]).toEqual({ code: "INVALID_CREDENTIALS", message: expect.stringContaining("4 attempts left") });
    expect(r[1]).toEqual({ code: "INVALID_CREDENTIALS", message: expect.stringContaining("3 attempts left") });
    expect(pinRow("cashier-01")).toEqual({ failed_attempts: 2n, locked_until: null });
    db.close();
  });

  it("the correct PIN works below the threshold and clears the failure count", () => {
    const { db, service, pinRow } = setup();
    failTimes(service, "cashier-01", 4);
    expect(attempt(() => service.login("cashier-01", "1111"))).toBe("ok");
    expect(pinRow("cashier-01")).toBeUndefined();
    // A cleared counter means the next lock again needs a full 5 failures.
    expect(failTimes(service, "cashier-01", 4).every((r) => typeof r === "object" && r.code === "INVALID_CREDENTIALS")).toBe(true);
    db.close();
  });

  it("the 5th failure locks; the correct PIN is then refused; the lock expires on the clock", () => {
    const clock = new TestClock();
    const { db, service } = setup(clock);
    const r = failTimes(service, "cashier-01", 5);
    expect(r[4]).toEqual({ code: "CASHIER_LOCKED", message: expect.stringContaining("try again in 5 minutes") });

    clock.set(new Date(clock.instant.getTime() + 2 * MIN).toISOString());
    expect(attempt(() => service.login("cashier-01", "1111"))).toEqual({
      code: "CASHIER_LOCKED",
      message: expect.stringContaining("try again in 3 minutes"),
    });
    expect(service.currentCashier()).toBeNull();

    // Attempts during the lock do NOT extend it.
    failTimes(service, "cashier-01", 3);
    clock.set(new Date(clock.instant.getTime() + 3 * MIN - 1).toISOString()); // 1 ms before expiry
    expect(attempt(() => service.login("cashier-01", "1111"))).toMatchObject({ code: "CASHIER_LOCKED" });

    clock.set(new Date(clock.instant.getTime() + 1).toISOString()); // exactly at expiry
    expect(attempt(() => service.login("cashier-01", "1111"))).toBe("ok");
    expect(service.currentCashier()).toEqual({ id: "cashier-01", name: "Cashier One" });
    db.close();
  });

  it("after a lock expires, a wrong PIN starts a fresh count (not an instant re-lock)", () => {
    const clock = new TestClock();
    const { db, service } = setup(clock);
    failTimes(service, "cashier-01", 5);
    clock.set(new Date(clock.instant.getTime() + 5 * MIN).toISOString());
    expect(attempt(() => service.login("cashier-01", "0000"))).toEqual({
      code: "INVALID_CREDENTIALS",
      message: expect.stringContaining("4 attempts left"),
    });
    db.close();
  });

  it("the lock survives an application restart (state lives in SQLite)", () => {
    const clock = new TestClock();
    const first = setup(clock);
    failTimes(first.service, "cashier-01", 5);
    first.db.close();

    const second = makeHarness(t.dbPath, { clock, login: false });
    expect(attempt(() => second.service.login("cashier-01", "1111"))).toMatchObject({ code: "CASHIER_LOCKED" });
    second.db.close();

    // A partial count also survives: 3 failures, restart, 2 more → locked.
    clock.set(new Date(clock.instant.getTime() + 5 * MIN).toISOString());
    const third = makeHarness(t.dbPath, { clock, login: false });
    failTimes(third.service, "cashier-01", 3);
    third.db.close();
    const fourth = makeHarness(t.dbPath, { clock, login: false });
    const r = failTimes(fourth.service, "cashier-01", 2);
    expect(r[1]).toMatchObject({ code: "CASHIER_LOCKED" });
    fourth.db.close();
  });

  it("one cashier's failures and lock never affect another cashier", () => {
    const { db, service, pinRow } = setup();
    failTimes(service, "cashier-01", 5);
    expect(attempt(() => service.login("cashier-02", "2222"))).toBe("ok");
    failTimes(service, "cashier-02", 2);
    expect(pinRow("cashier-02")).toEqual({ failed_attempts: 2n, locked_until: null });
    expect(attempt(() => service.login("cashier-01", "1111"))).toMatchObject({ code: "CASHIER_LOCKED" });
    db.close();
  });

  it("unknown cashiers and malformed PINs: generic error; unknown ids create no state", () => {
    const { db, service, pinRow } = setup();
    expect(attempt(() => service.login("cashier-99", "1111"))).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "Cashier or PIN is incorrect",
    });
    expect(pinRow("cashier-99")).toBeUndefined();
    // A malformed PIN for a real cashier counts as a failure (no free guesses via odd input).
    expect(attempt(() => service.login("cashier-01", "12'; --"))).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(pinRow("cashier-01")).toEqual({ failed_attempts: 1n, locked_until: null });
    db.close();
  });

  it("no PIN is stored: the lockout table holds counters only, and PINs exist only as scrypt hashes", () => {
    const { db, service } = setup();
    failTimes(service, "cashier-01", 2);
    const cols = (db.prepare("PRAGMA table_info(cashier_pin_state)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(["cashier_id", "failed_attempts", "locked_until", "updated_at"]);
    const everything = JSON.stringify(db.prepare("SELECT * FROM cashier_pin_state").all(), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(everything).not.toContain("0000");
    db.close();
  });
});
