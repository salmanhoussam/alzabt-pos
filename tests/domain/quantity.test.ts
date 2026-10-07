/**
 * The exact-quantity contract, in one place: parsing, formatting, the unit rule, and the single
 * rounding arithmetic — including the two boundaries that exist because SQLite does not raise on
 * 64-bit overflow.
 *
 * Every price here is SYNTHETIC. No merchant price appears in this repository.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { money } from "../../src/domain/money";
import {
  MAX_QUANTITY_MILLI,
  MAX_QUANTITY_UNITS,
  MAX_UNIT_PRICE_MINOR,
  QUANTITY_SCALE,
  assertQuantityMilli,
  assertUnitPriceMinor,
  formatQuantity,
  isFractionalUnit,
  isWholeQuantity,
  lineTotal,
  parseQuantity,
} from "../../src/domain/quantity";

const usd = (minor: bigint) => money(minor, "USD");
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    return `NOT_A_DOMAIN_ERROR:${String(e)}`;
  }
  return "NO_ERROR";
};

describe("the scale", () => {
  it("is thousandths, and the maximum is 9999 sale units", () => {
    expect(QUANTITY_SCALE).toBe(1000);
    expect(MAX_QUANTITY_UNITS).toBe(9999);
    expect(MAX_QUANTITY_MILLI).toBe(9_999_000);
  });
});

describe("parsing — the one boundary where text becomes an integer", () => {
  it("accepts a whole number, a half, three decimals and a large value", () => {
    expect(parseQuantity("2", "piece")).toBe(2000);
    expect(parseQuantity("2.5", "kg")).toBe(2500);
    expect(parseQuantity("0.333", "kg")).toBe(333);
    expect(parseQuantity("34", "kg")).toBe(34000);
    expect(parseQuantity("3.125", "meter")).toBe(3125);
    expect(parseQuantity("  7  ", "piece")).toBe(7000); // surrounding space only
    expect(parseQuantity("2.50", "kg")).toBe(2500); // a trailing zero is not extra precision
  });

  it("refuses excess precision rather than rounding it away", () => {
    expect(code(() => parseQuantity("2.5555", "kg"))).toBe("INVALID_QUANTITY");
    expect(() => parseQuantity("2.5555", "kg")).toThrow(/more than 3 decimal places/);
  });

  it("refuses zero, negatives, malformed text and anything that is not a plain decimal", () => {
    for (const bad of ["0", "0.000", "-1", "-0.5", "", " ", "2.", ".5", "1e3", "2,5", "٢٫٥", "abc", "1 2", "+2", "Infinity", "NaN"]) {
      expect(code(() => parseQuantity(bad, "kg")), JSON.stringify(bad)).toBe("INVALID_QUANTITY");
    }
    expect(code(() => parseQuantity(undefined, "kg"))).toBe("INVALID_QUANTITY");
    expect(code(() => parseQuantity(2.5 as unknown, "kg"))).toBe("INVALID_QUANTITY");
  });

  it("refuses more than the maximum, at the exact boundary", () => {
    expect(parseQuantity(String(MAX_QUANTITY_UNITS), "piece")).toBe(MAX_QUANTITY_MILLI);
    expect(code(() => parseQuantity(String(MAX_QUANTITY_UNITS + 1), "piece"))).toBe("INVALID_QUANTITY");
    expect(code(() => parseQuantity("9999.001", "kg"))).toBe("INVALID_QUANTITY");
  });

  it("refuses a fraction typed against a whole-only unit instead of rounding it", () => {
    expect(code(() => parseQuantity("2.5", "piece"))).toBe("FRACTION_NOT_ALLOWED");
    expect(() => parseQuantity("2.5", "piece")).toThrow(/whole units/);
  });
});

describe("the unit rule — fractional units are named, everything else is whole-only", () => {
  it("names kg and meter, and nothing else", () => {
    expect(isFractionalUnit("kg")).toBe(true);
    expect(isFractionalUnit("meter")).toBe(true);
    for (const whole of ["piece", "box", "pack", "other"]) expect(isFractionalUnit(whole), whole).toBe(false);
  });

  it("fails CLOSED: a unit nobody declared fractional is whole-only", () => {
    expect(isFractionalUnit("litre")).toBe(false);
    expect(code(() => assertQuantityMilli(2500, "litre"))).toBe("FRACTION_NOT_ALLOWED");
  });

  it("accepts a fraction on kg and meter", () => {
    expect(() => assertQuantityMilli(2500, "kg")).not.toThrow();
    expect(() => assertQuantityMilli(333, "kg")).not.toThrow();
    expect(() => assertQuantityMilli(3125, "meter")).not.toThrow();
  });

  it("rejects a fraction on every whole-only unit", () => {
    for (const whole of ["piece", "box", "pack", "other"]) {
      expect(code(() => assertQuantityMilli(2500, whole)), whole).toBe("FRACTION_NOT_ALLOWED");
      expect(code(() => assertQuantityMilli(1, whole)), whole).toBe("FRACTION_NOT_ALLOWED");
      expect(() => assertQuantityMilli(2000, whole), whole).not.toThrow();
    }
  });

  it("rejects a quantity outside the range whatever the unit", () => {
    for (const q of [0, -1000, 1.5, Number.NaN, MAX_QUANTITY_MILLI + 1]) {
      expect(code(() => assertQuantityMilli(q, "kg")), String(q)).toBe("INVALID_QUANTITY");
    }
    expect(isWholeQuantity(2000)).toBe(true);
    expect(isWholeQuantity(2500)).toBe(false);
  });
});

describe("formatting — one formatter, no trailing zeros, digits 0-9", () => {
  it("renders exactly the contract's examples", () => {
    expect(formatQuantity(1000)).toBe("1");
    expect(formatQuantity(2500)).toBe("2.5");
    expect(formatQuantity(333)).toBe("0.333");
    expect(formatQuantity(34000)).toBe("34");
    expect(formatQuantity(3125)).toBe("3.125");
    expect(formatQuantity(1)).toBe("0.001");
    expect(formatQuantity(2050)).toBe("2.05");
    expect(formatQuantity(MAX_QUANTITY_MILLI)).toBe("9999");
    expect(formatQuantity(0)).toBe("0");
  });

  it("round-trips every parseable value", () => {
    for (const text of ["1", "2.5", "0.333", "34", "3.125", "0.001", "2.05", "9999"]) {
      expect(formatQuantity(parseQuantity(text, "kg")), text).toBe(text);
    }
  });

  it("never emits an Arabic-Indic digit", () => {
    for (const q of [1, 333, 1000, 2500, 3125, MAX_QUANTITY_MILLI]) {
      expect(formatQuantity(q)).toMatch(/^[0-9.]+$/);
    }
  });
});

describe("the line total — exact integer round-half-up", () => {
  it("multiplies a whole quantity exactly", () => {
    expect(lineTotal(usd(400n), 1000, "piece").minor).toBe(400n);
    expect(lineTotal(usd(400n), 12000, "piece").minor).toBe(4800n);
  });

  it("the 34 kg example, at a synthetic price", () => {
    // 34 kg at 2.50 is exactly 85.00 — no rounding is involved at all.
    expect(lineTotal(usd(250n), 34000, "kg").minor).toBe(8500n);
  });

  it("0.333 kg rounds its own half UP", () => {
    // 0.333 x 15.00 = 4.995 -> 499.5 minor -> 500
    expect(lineTotal(usd(1500n), 333, "kg").minor).toBe(500n);
  });

  it("rounds below half down, exactly half up, and above half up", () => {
    expect(lineTotal(usd(1n), 1499, "kg").minor).toBe(1n); // 1.499 -> down
    expect(lineTotal(usd(1n), 1500, "kg").minor).toBe(2n); // 1.500 -> the tie goes UP
    expect(lineTotal(usd(1n), 1501, "kg").minor).toBe(2n); // 1.501 -> up
    expect(lineTotal(usd(500n), 1, "kg").minor).toBe(1n); // 0.001 x 5.00 = exactly half -> up
    expect(lineTotal(usd(501n), 1, "kg").minor).toBe(1n);
  });

  it("REFUSES a line whose total rounds to zero", () => {
    // 0.001 x 4.99 = 0.499 minor -> 0. The database cannot catch this: 0 is a valid integer.
    expect(code(() => lineTotal(usd(499n), 1, "kg"))).toBe("ZERO_VALUE_LINE");
    expect(() => lineTotal(usd(499n), 1, "kg")).toThrow(/rounds to zero/);
    expect(code(() => lineTotal(usd(0n), 2500, "kg"))).toBe("ZERO_VALUE_LINE");
  });

  it("the largest price whose LINE TOTAL is storable at the maximum quantity, and the next one up", () => {
    // 100,010,001,000 is exactly the largest unit price whose total at 9999 units still fits
    // MAX_MINOR. It is derived here rather than asserted as a magic number.
    // (q*p + 500) / 1000 <= MAX_MINOR, with integer division, means q*p + 500 <= MAX_MINOR*1000 + 999.
    const biggest = (10n ** 15n * 1000n + 999n - 500n) / BigInt(MAX_QUANTITY_MILLI);
    expect(biggest).toBe(100_010_001_000n);
    const total = lineTotal(usd(biggest), MAX_QUANTITY_MILLI, "piece");
    expect(total.minor).toBe(999_999_999_999_000n);
    expect(total.minor).toBeLessThanOrEqual(10n ** 15n);
    expect(code(() => lineTotal(usd(biggest + 1n), MAX_QUANTITY_MILLI, "piece"))).toBe("MONEY_OUT_OF_RANGE");
  });
});

/**
 * 🔴 TWO DIFFERENT GUARDS, and they must not be conflated.
 *
 *   A · the PRICE OVERFLOW guard — MAX_UNIT_PRICE_MINOR. Its only job is to keep
 *       `quantity_milli * unit_price_minor + 500` inside signed 64-bit INTEGER, because SQLite does
 *       not raise on overflow: it silently yields a REAL, and a money CHECK would then be evaluated
 *       in floating point.
 *
 *   B · the BUSINESS LINE-TOTAL guard — money.ts's MAX_MINOR (10^15). Its job is to bound an amount
 *       the ledger is willing to record at all.
 *
 * A price at exactly bound A is a VALID PRICE. It does not follow that it forms a valid sale LINE:
 * at the maximum quantity its total is 9.2x past bound B, so guard B refuses it. That refusal is
 * expected and correct — it is NOT an overflow-guard failure, and nothing here weakens MAX_MINOR.
 */
describe("A · the price overflow guard — the reason the unit price has a ceiling", () => {
  it("the constant is exactly floor((2^63 - 1 - 500) / MAX_QUANTITY_MILLI)", () => {
    const derived = (2n ** 63n - 1n - 500n) / BigInt(MAX_QUANTITY_MILLI);
    expect(MAX_UNIT_PRICE_MINOR).toBe(derived);
    expect(MAX_UNIT_PRICE_MINOR).toBe(922_429_446_630n);
  });

  it("accepts the limit and rejects the very next integer", () => {
    expect(() => assertUnitPriceMinor(MAX_UNIT_PRICE_MINOR)).not.toThrow();
    expect(code(() => assertUnitPriceMinor(MAX_UNIT_PRICE_MINOR + 1n))).toBe("PRICE_OUT_OF_RANGE");
    expect(code(() => lineTotal(usd(MAX_UNIT_PRICE_MINOR + 1n), 1000, "piece"))).toBe("PRICE_OUT_OF_RANGE");
    expect(code(() => assertUnitPriceMinor(-1n))).toBe("PRICE_OUT_OF_RANGE");
  });

  it("at the limit the whole SQL expression stays INTEGER, and one above it turns REAL", () => {
    const db = new Database(":memory:");
    const typeOf = (price: bigint) =>
      db
        .prepare(`SELECT typeof(${MAX_QUANTITY_MILLI} * ${price} + 500) AS t`)
        .get() as { t: string };
    expect(typeOf(MAX_UNIT_PRICE_MINOR).t).toBe("integer");
    // 🔴 SQLite does not raise on 64-bit overflow — it silently yields a REAL, which is exactly
    // what the ceiling exists to keep out of a money CHECK.
    expect(typeOf(MAX_UNIT_PRICE_MINOR + 1n).t).toBe("real");
    db.close();
  });

  it("a normal price is nowhere near the ceiling", () => {
    for (const p of [1n, 100n, 250n, 400n, 1500n, 999_999n]) {
      expect(() => assertUnitPriceMinor(p)).not.toThrow();
      const db = new Database(":memory:");
      expect(
        (db.prepare(`SELECT typeof(${MAX_QUANTITY_MILLI} * ${p} + 500) AS t`).get() as { t: string }).t,
      ).toBe("integer");
      db.close();
    }
  });
});

describe("B · the business line-total guard — a separate limit, with a separate meaning", () => {
  it("MAX_MINOR still bounds what the ledger will record, and is NOT relaxed by the overflow guard", () => {
    // The price is accepted by guard A and the line is still refused by guard B. Both are correct.
    expect(() => assertUnitPriceMinor(MAX_UNIT_PRICE_MINOR)).not.toThrow();
    expect(code(() => lineTotal(usd(MAX_UNIT_PRICE_MINOR), MAX_QUANTITY_MILLI, "piece"))).toBe(
      "MONEY_OUT_OF_RANGE",
    );
  });

  it("a refusal by guard B is reported as an AMOUNT problem, never as an overflow", () => {
    // The distinction is visible in the error code the operator's layer receives.
    expect(code(() => lineTotal(usd(MAX_UNIT_PRICE_MINOR), MAX_QUANTITY_MILLI, "piece"))).not.toBe(
      "PRICE_OUT_OF_RANGE",
    );
    expect(code(() => lineTotal(usd(MAX_UNIT_PRICE_MINOR + 1n), MAX_QUANTITY_MILLI, "piece"))).toBe(
      "PRICE_OUT_OF_RANGE",
    );
  });

  it("the two bounds are genuinely different numbers, and A is the looser one", () => {
    const storableAtMaxQuantity = (10n ** 15n * 1000n + 999n - 500n) / BigInt(MAX_QUANTITY_MILLI);
    expect(storableAtMaxQuantity).toBeLessThan(MAX_UNIT_PRICE_MINOR);
    expect(MAX_UNIT_PRICE_MINOR / storableAtMaxQuantity).toBe(9n);
  });
});

describe("the application's arithmetic is the SAME arithmetic the database checks", () => {
  it("bigint division and SQLite integer division agree on every case, ties included", () => {
    const db = new Database(":memory:");
    const sqlTotal = (q: number, p: bigint) =>
      BigInt((db.prepare(`SELECT (${q} * ${p} + 500) / 1000 AS t`).get() as { t: number }).t);

    const quantities = [1, 2, 333, 499, 500, 501, 999, 1000, 1499, 1500, 1501, 2500, 3125, 34000, 123456, MAX_QUANTITY_MILLI];
    const prices = [1n, 2n, 3n, 7n, 99n, 100n, 199n, 250n, 333n, 400n, 1500n, 100_000n];
    let compared = 0;
    for (const q of quantities) {
      for (const p of prices) {
        const expected = sqlTotal(q, p);
        if (expected === 0n) continue; // the app refuses these; the comparison is about the rounding
        expect(lineTotal(usd(p), q, "kg").minor, `${q} x ${p}`).toBe(expected);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(150);
    db.close();
  });
});
