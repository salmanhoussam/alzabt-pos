/**
 * DEC-35z — STRICT calendar validation for the Daily Money date. A non-existent date must be REFUSED,
 * never rolled over to another day (the bug `Date.parse` would have allowed). Business day and terminal
 * time zone are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyMoneyService, isCalendarDate } from "../../src/application/dailyMoneyService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { DailyMoneyRepository } from "../../src/persistence/dailyMoneyRepository";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

describe("isCalendarDate", () => {
  it.each(["2026-02-31", "2026-02-29", "2026-04-31", "2026-06-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-1-05", "2026-01-5", "20260105", "2026-01-05T00:00", " 2026-01-05", ""])(
    "refuses %j",
    (text) => expect(isCalendarDate(text)).toBe(false),
  );
  it.each(["2028-02-29", "2024-02-29", "2026-02-28", "2026-04-30", "2026-12-31", "2000-02-29"])("accepts %j", (text) => expect(isCalendarDate(text)).toBe(true));
  it("1900 and 2100 are not leap years; 2000 is", () => {
    expect([isCalendarDate("1900-02-29"), isCalendarDate("2100-02-29"), isCalendarDate("2000-02-29")]).toEqual([false, false, true]);
  });
});

describe("DailyMoneyService.day — the strict check is the one in force", () => {
  let t: TempDir;
  let h: Harness;
  let dm: DailyMoneyService;
  beforeEach(() => {
    t = tempDir();
    h = makeHarness(t.dbPath);
    dm = new DailyMoneyService({
      repository: new DailyMoneyRepository(h.db),
      actor: () => {
        const c = h.service.currentCashier();
        const role = h.service.currentRole();
        return c && role ? { id: c.id, role } : null;
      },
      terminal: { timeZone: FIXTURE_TERMINAL.timeZone, currency: FIXTURE_TERMINAL.currency },
      now: h.clock.now,
    });
  });
  afterEach(() => {
    h.db.close();
    t.cleanup();
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
      return "OK";
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };

  it("past but non-existent dates are refused (not rolled to March / May)", () => {
    for (const d of ["2026-02-31", "2026-02-29", "2026-04-31"]) expect(code(() => dm.day(d)), d).toBe("INVALID_INPUT");
  });

  it("2028-02-29 is a real day: accepted once it is not in the future, and reported AS that day", () => {
    h.clock.set("2028-03-01T09:00:00.000Z");
    expect(dm.day("2028-02-29").date).toBe("2028-02-29");
  });

  it("today (no date) still follows the terminal's business day", () => {
    expect(dm.day().date).toBe("2026-10-04");
  });
});
