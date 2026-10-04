/**
 * Money — the one exact representation used everywhere in Alzabt POS.
 *
 * DECISION: an amount is an integer count of the currency's MINOR unit (cents for USD, fils for
 * JOD, ...), held as a JavaScript `bigint` in memory and as a SQLite `INTEGER` (in STRICT tables)
 * on disk. It is never a JavaScript `number` and never a SQL `REAL`.
 *
 * Why `bigint` and not "integers in a number":
 *   - A `number` holding cents is exact only by discipline; one `/ 100` or `* 1.1` anywhere silently
 *     produces a float. Mixing `bigint` with `number` in arithmetic THROWS a TypeError, so a float
 *     can never leak into a money calculation unnoticed — the type system and the runtime both
 *     refuse it.
 *   - It maps 1:1 onto SQLite's 64-bit INTEGER when the driver is in safe-integer mode.
 *
 * Across the Electron IPC boundary an amount travels as a decimal STRING of minor units
 * (see `src/shared/dto.ts`), never as a number.
 *
 * Currency is always explicit. The exponent (number of minor-unit digits) comes from the table
 * below; an unknown currency code is rejected rather than guessed. No exchange rates exist here.
 */

import { DomainError } from "./errors";

/** ISO-4217 minor-unit exponents for the currencies this terminal may be configured with. */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  LBP: 2, // ISO 4217 lists 2; Lebanese practice is whole pounds — a product decision, not made here.
  SAR: 2,
  AED: 2,
  JOD: 3,
  KWD: 3,
});

/** Largest amount (in minor units) the ledger accepts — far below SQLite's 64-bit INTEGER limit. */
export const MAX_MINOR = 10n ** 15n;

export interface Money {
  readonly minor: bigint;
  readonly currency: string;
}

export function currencyExponent(currency: string): number {
  const exp = CURRENCY_EXPONENT[currency];
  if (exp === undefined) {
    throw new DomainError("UNKNOWN_CURRENCY", `Unsupported currency code '${currency}'`);
  }
  return exp;
}

export function assertCurrency(currency: string): void {
  currencyExponent(currency);
}

function assertMinor(minor: bigint): void {
  if (typeof minor !== "bigint") {
    throw new DomainError("NOT_EXACT", "Money minor units must be a bigint");
  }
  if (minor < 0n || minor > MAX_MINOR) {
    throw new DomainError("MONEY_OUT_OF_RANGE", `Amount ${minor} is outside the accepted range`);
  }
}

export function money(minor: bigint, currency: string): Money {
  assertCurrency(currency);
  assertMinor(minor);
  return Object.freeze({ minor, currency });
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

/**
 * Parses a decimal string such as "12.50" into exact minor units.
 * Rejects excess precision ("1.005" for USD), signs, exponents and anything that is not a plain
 * decimal. This is the ONLY way a human-written price enters the system.
 */
export function parseDecimal(text: string, currency: string): Money {
  const exp = currencyExponent(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new DomainError("INVALID_AMOUNT", `'${text}' is not a plain decimal amount`);
  }
  const whole = match[1]!;
  const frac = match[2] ?? "";
  if (frac.length > exp) {
    throw new DomainError(
      "INVALID_AMOUNT",
      `'${text}' has more than ${exp} decimal places for ${currency}`,
    );
  }
  const minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, "0") || "0");
  return money(minor, currency);
}

/** Formats exact minor units as a plain decimal string ("1250" USD -> "12.50"). No rounding exists. */
export function formatDecimal(m: Money): string {
  const exp = currencyExponent(m.currency);
  if (exp === 0) return m.minor.toString();
  const digits = m.minor.toString().padStart(exp + 1, "0");
  return `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new DomainError("MIXED_CURRENCY", `Cannot add ${a.currency} to ${b.currency}`);
  }
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new DomainError("MIXED_CURRENCY", `Cannot subtract ${b.currency} from ${a.currency}`);
  }
  return money(a.minor - b.minor, a.currency);
}

/** Unit price x integer quantity. Quantity is validated as a positive safe integer first. */
export function multiply(unit: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new DomainError("INVALID_QUANTITY", `Quantity must be a positive integer, got ${quantity}`);
  }
  return money(unit.minor * BigInt(quantity), unit.currency);
}
