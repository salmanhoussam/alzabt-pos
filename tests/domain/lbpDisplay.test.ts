/**
 * M5 — the LBP display arithmetic (owner 2026-11-25): USD × rate, 2 decimals, ROUND_HALF_UP, no rounding to
 * 1,000, exact integers only. Display only — nothing here is stored or charged.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalLbpRate,
  formatLbpMinor,
  lbpEquivalent,
  parseLbpRate,
  usdMinorToLbpMinor,
} from "../../src/domain/lbpDisplay";

describe("parseLbpRate", () => {
  it("accepts the owner's rate in the forms people type it", () => {
    expect(parseLbpRate("89000")).toBe(8_900_000n);
    expect(parseLbpRate("89,000")).toBe(8_900_000n);
    expect(parseLbpRate(" 89 000 ")).toBe(8_900_000n);
    expect(parseLbpRate("89500.5")).toBe(8_950_050n);
    expect(parseLbpRate("89500.55")).toBe(8_950_055n);
    expect(parseLbpRate("1")).toBe(100n);
    expect(parseLbpRate("10000000")).toBe(1_000_000_000n);
  });

  it("refuses everything else — never a guessed rate", () => {
    for (const bad of ["0", "0.99", "-1", "+5", "1e5", "89500.001", "", " ", "abc", "10000000.01", "89.000.5", null, 89000, undefined]) {
      expect(parseLbpRate(bad as unknown), String(bad)).toBeNull();
    }
  });

  it("stores a canonical form", () => {
    expect(canonicalLbpRate(8_900_000n)).toBe("89000");
    expect(canonicalLbpRate(8_950_050n)).toBe("89500.5");
    expect(canonicalLbpRate(8_950_055n)).toBe("89500.55");
  });
});

describe("usdMinorToLbpMinor — exact, ROUND_HALF_UP", () => {
  it("multiplies a USD price by the rate (the owner's PEPSI: 2 × 1.00 USD at 89,000)", () => {
    expect(formatLbpMinor(usdMinorToLbpMinor(200n, 8_900_000n))).toBe("178,000.00");
    expect(formatLbpMinor(usdMinorToLbpMinor(100n, 8_900_000n))).toBe("89,000.00");
    expect(formatLbpMinor(usdMinorToLbpMinor(5n, 8_900_000n))).toBe("4,450.00");
  });

  it("has no rounding to 1,000", () => {
    expect(formatLbpMinor(usdMinorToLbpMinor(1n, 8_900_000n))).toBe("890.00");
    expect(formatLbpMinor(usdMinorToLbpMinor(123_456n, 8_900_000n))).toBe("109,875,840.00");
  });

  it("rounds the half up, and only the half", () => {
    // 1 cent × 89,500.55 = 895.0055 LBP -> 895.01 (remainder 55 of 100)
    expect(formatLbpMinor(usdMinorToLbpMinor(1n, 8_950_055n))).toBe("895.01");
    // the remainder of the single division by 100: 50 or more rounds up, 49 or less rounds down
    expect(usdMinorToLbpMinor(1n, 150n)).toBe(2n); // 1.50 LBP/USD: 1 cent = 0.015 LBP = 1.5 minor -> 2
    expect(usdMinorToLbpMinor(1n, 149n)).toBe(1n); // 1.49 LBP/USD: 1.49 minor -> 1
    expect(usdMinorToLbpMinor(1n, 151n)).toBe(2n);
  });

  it("is symmetric for a negative amount (half away from zero)", () => {
    expect(usdMinorToLbpMinor(-1n, 150n)).toBe(-2n);
    expect(formatLbpMinor(usdMinorToLbpMinor(-200n, 8_900_000n))).toBe("-178,000.00");
  });

  it("uses integers only: a large total stays exact", () => {
    const usd = 999_999_999_99n; // 999,999,999.99 USD
    expect(usdMinorToLbpMinor(usd, 8_900_000n)).toBe(usd * 89_000n);
  });
});

describe("lbpEquivalent", () => {
  it("shows an equivalent for USD at a valid rate", () => {
    expect(lbpEquivalent(200n, "USD", "89000")).toBe("178,000.00");
  });
  it("shows NOTHING for another currency or an invalid rate", () => {
    expect(lbpEquivalent(200n, "LBP", "89000")).toBeNull();
    expect(lbpEquivalent(200n, "USD", "0")).toBeNull();
    expect(lbpEquivalent(200n, "USD", "garbage")).toBeNull();
  });
});
