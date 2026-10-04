import { describe, expect, it } from "vitest";
import { assertTimeZone, businessDateOf } from "../../src/domain/businessDay";
import { money } from "../../src/domain/money";
import { buildTodaySales } from "../../src/domain/report";

describe("business day (single definition)", () => {
  it("uses the terminal's zone, not UTC", () => {
    // Beirut is UTC+3 on these dates. 20:59Z = 23:59 local (Oct 3); 21:00Z = 00:00 local (Oct 4).
    expect(businessDateOf(new Date("2026-10-03T20:59:59.999Z"), "Asia/Beirut")).toBe("2026-10-03");
    expect(businessDateOf(new Date("2026-10-03T21:00:00.000Z"), "Asia/Beirut")).toBe("2026-10-04");
    // Same instants in UTC give different dates — proves the zone matters.
    expect(businessDateOf(new Date("2026-10-03T21:00:00.000Z"), "UTC")).toBe("2026-10-03");
  });

  it("rejects an invalid zone and an invalid instant", () => {
    expect(() => assertTimeZone("Mars/Olympus")).toThrow(RangeError);
    expect(() => businessDateOf(new Date("nope"), "UTC")).toThrow(RangeError);
  });
});

describe("today's sales report (pure)", () => {
  const usd = (minor: bigint) => money(minor, "USD");

  it("sums gross, voids and net exactly", () => {
    const report = buildTodaySales("2026-10-04", "USD", [
      { total: usd(1472n), voided: false },
      { total: usd(250n), voided: true },
      { total: usd(999n), voided: false },
    ]);
    expect(report).toMatchObject({
      date: "2026-10-04",
      currency: "USD",
      completedSalesCount: 3,
      voidedSalesCount: 1,
    });
    expect(report.grossSales.minor).toBe(2721n);
    expect(report.voidTotal.minor).toBe(250n);
    expect(report.netSales.minor).toBe(2471n);
  });

  it("an empty day reports zero in the terminal currency", () => {
    const report = buildTodaySales("2026-10-04", "EUR", []);
    expect(report.currency).toBe("EUR");
    expect(report.netSales.minor).toBe(0n);
  });

  it("fails explicitly on mixed currencies instead of summing them", () => {
    expect(() =>
      buildTodaySales("2026-10-04", "USD", [
        { total: usd(100n), voided: false },
        { total: money(100n, "EUR"), voided: false },
      ]),
    ).toThrow(/refusing to sum/);
  });
});
