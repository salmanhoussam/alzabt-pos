import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { MAX_MINOR, add, formatDecimal, money, multiply, parseDecimal, subtract } from "../../src/domain/money";

describe("money: exact minor-unit representation", () => {
  it("parses decimal text into exact bigint minor units", () => {
    expect(parseDecimal("12.50", "USD").minor).toBe(1250n);
    expect(parseDecimal("12.5", "USD").minor).toBe(1250n);
    expect(parseDecimal("0.01", "USD").minor).toBe(1n);
    expect(parseDecimal("7", "USD").minor).toBe(700n);
    expect(parseDecimal("1.234", "JOD").minor).toBe(1234n); // 3-decimal currency
  });

  it("rejects excess precision, signs, exponents and garbage instead of rounding", () => {
    for (const bad of ["1.005", "-1.00", "1e2", "1,50", " 1.00", "", "abc", "1."]) {
      expect(() => parseDecimal(bad, "USD"), bad).toThrow(DomainError);
    }
  });

  it("rejects unknown currencies rather than guessing an exponent", () => {
    expect(() => parseDecimal("1.00", "XXX")).toThrow(/Unsupported currency/);
    expect(() => money(1n, "usd")).toThrow(/Unsupported currency/);
  });

  it("formats without rounding", () => {
    expect(formatDecimal(money(1250n, "USD"))).toBe("12.50");
    expect(formatDecimal(money(5n, "USD"))).toBe("0.05");
    expect(formatDecimal(money(0n, "USD"))).toBe("0.00");
    expect(formatDecimal(money(1234n, "JOD"))).toBe("1.234");
  });

  it("never accepts a JavaScript number as an amount", () => {
    expect(() => money(1.5 as unknown as bigint, "USD")).toThrow(/bigint/);
    expect(() => money(150 as unknown as bigint, "USD")).toThrow(/bigint/);
  });

  it("mixing bigint money with a number fails at runtime (no silent float)", () => {
    const m = money(199n, "USD");
    expect(() => (m.minor as unknown as number) * 1.1).toThrow(TypeError);
  });

  it("multiplies by integer quantities only", () => {
    expect(multiply(money(199n, "USD"), 3).minor).toBe(597n);
    expect(() => multiply(money(199n, "USD"), 1.5)).toThrow(/Quantity/);
    expect(() => multiply(money(199n, "USD"), 0)).toThrow(/Quantity/);
    expect(() => multiply(money(199n, "USD"), -2)).toThrow(/Quantity/);
  });

  it("NEGATIVE CONTROL: the same arithmetic in floating point is wrong", () => {
    // Proves the test values would catch a float implementation. These are the fixture's real
    // prices: 2 x 2.50 + 1 x 2.25 + 3 x 4.10 — the same sale the atomicity and crash tests use.
    expect(4.1 * 3).not.toBe(12.3);
    expect(2.5 * 2 + 2.25 + 4.1 * 3).not.toBe(19.55);
    expect(0.1 + 0.2).not.toBe(0.3);
    const exact = [multiply(money(250n, "USD"), 2), multiply(money(225n, "USD"), 1), multiply(money(410n, "USD"), 3)];
    expect(exact[2]!.minor).toBe(1230n);
    expect(exact.reduce((a, b) => add(a, b)).minor).toBe(1955n);
    expect(formatDecimal(exact.reduce((a, b) => add(a, b)))).toBe("19.55");
  });

  it("refuses to combine currencies", () => {
    expect(() => add(money(1n, "USD"), money(1n, "EUR"))).toThrow(/Cannot add/);
    expect(() => subtract(money(1n, "USD"), money(1n, "EUR"))).toThrow(/Cannot subtract/);
  });

  it("enforces the accepted range (no negatives, no overflow past MAX_MINOR)", () => {
    expect(() => money(-1n, "USD")).toThrow(/range/);
    expect(() => money(MAX_MINOR + 1n, "USD")).toThrow(/range/);
    expect(() => subtract(money(1n, "USD"), money(2n, "USD"))).toThrow(/range/);
  });
});
