/**
 * Quantity — exact, scaled, never a float.
 *
 * DECISION (migration 4): a quantity is an integer count of THOUSANDTHS of one sale unit, held as a
 * JavaScript `number` that is always a safe integer and as a SQLite `INTEGER` in a STRICT table.
 *
 *     1 piece   -> 1000        2.5 meter -> 2500
 *     12 pieces -> 12000       0.333 kg  ->  333
 *
 * A `number` is safe here, unlike for money, because the whole range (1 .. 9_999_000) is far inside
 * `Number.MAX_SAFE_INTEGER` and every operation on it is integer-only. The moment a quantity meets
 * money it is widened to `bigint`, so the multiplication itself never touches floating point.
 *
 * `sale_unit` decides whether a fraction is allowed at all, and it is the unit the line was SOLD in
 * — a snapshot, not the product's current `base_unit`. The two are equal in V1 and will stop being
 * equal when pack pricing arrives; see docs/plans/exact-quantity-contract.md §18.
 */
import { DomainError } from "./errors";
import { type Money, money } from "./money";

/** Thousandths: one sale unit is 1000. */
export const QUANTITY_SCALE = 1000;

/** Most sale units one line may carry. */
export const MAX_QUANTITY_UNITS = 9999;

/** Therefore the largest stored quantity. */
export const MAX_QUANTITY_MILLI = MAX_QUANTITY_UNITS * QUANTITY_SCALE; // 9_999_000

/** Decimal places a fractional unit accepts — exactly the scale's digits. */
export const MAX_QUANTITY_DECIMALS = 3;

/**
 * 🔴 The largest unit price the ledger accepts, and the reason is arithmetic, not policy.
 *
 * SQLite does NOT raise on 64-bit integer overflow: it silently converts the result to REAL, which
 * would make the line-total CHECK evaluate in floating point without any error. Measured:
 *
 *     9999000 * 922429446630 + 500  ->  9223372036853371000   typeof=integer
 *     9999000 * 922429446631 + 500  ->  9223372036863370000   typeof=real     🔴
 *
 * So the bound is exactly floor((2^63 - 1 - 500) / MAX_QUANTITY_MILLI): the largest price for which
 * `quantity_milli * unit_price_minor + 500` stays inside signed 64-bit INTEGER for EVERY valid
 * quantity. `MAX_MINOR` in money.ts is 10^15, about 1084x past this, so this is the tighter rule and
 * the one the sale path must apply. The same constant is the CHECK in migration 4.
 */
export const MAX_UNIT_PRICE_MINOR = 922_429_446_630n;

/** Sale units whose quantities may carry a fraction. Everything else is whole-only. */
export const FRACTIONAL_SALE_UNITS: ReadonlyArray<string> = Object.freeze(["kg", "meter"]);

/**
 * Fails CLOSED: a unit this list does not name is whole-only. A unit added to BASE_UNITS tomorrow
 * therefore cannot smuggle in a fraction, which is the direction that stays safe without a
 * migration. The database's CHECK is spelled the same way, for the same reason.
 */
export function isFractionalUnit(saleUnit: string): boolean {
  return FRACTIONAL_SALE_UNITS.includes(saleUnit);
}

/** True when this quantity is a whole number of sale units. */
export function isWholeQuantity(quantityMilli: number): boolean {
  return quantityMilli % QUANTITY_SCALE === 0;
}

/**
 * The one check every quantity passes, wherever it came from. Range first, then the unit's rule:
 * a whole-only unit REJECTS a fraction rather than rounding it.
 */
export function assertQuantityMilli(quantityMilli: number, saleUnit: string): void {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli < 1 || quantityMilli > MAX_QUANTITY_MILLI) {
    throw new DomainError(
      "INVALID_QUANTITY",
      `A quantity must be between 0.001 and ${MAX_QUANTITY_UNITS} sale units`,
    );
  }
  if (!isFractionalUnit(saleUnit) && !isWholeQuantity(quantityMilli)) {
    throw new DomainError(
      "FRACTION_NOT_ALLOWED",
      `'${saleUnit}' is sold in whole units; ${formatQuantity(quantityMilli)} is not a whole number`,
    );
  }
}

/**
 * THE parsing boundary: human text becomes an exact integer here and nowhere else. A whole-only unit
 * refuses a fraction outright, so the operator is told rather than silently given a rounded number.
 *
 * Accepts "2", "2.5", "0.333", "34". Rejects "2.5555" (too precise), "0", "-1", "", " ", "2.",
 * ".5", "1e3", "٢٫٥" (Arabic-Indic digits are not accepted here — the quantity field is 0-9).
 */
export function parseQuantity(text: unknown, saleUnit: string): number {
  if (typeof text !== "string") {
    throw new DomainError("INVALID_QUANTITY", "A quantity is required");
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) {
    throw new DomainError("INVALID_QUANTITY", `'${text}' is not a plain decimal quantity`);
  }
  const frac = match[2] ?? "";
  if (frac.length > MAX_QUANTITY_DECIMALS) {
    throw new DomainError(
      "INVALID_QUANTITY",
      `'${text}' has more than ${MAX_QUANTITY_DECIMALS} decimal places`,
    );
  }
  const whole = Number(match[1]!);
  if (!Number.isSafeInteger(whole) || whole > MAX_QUANTITY_UNITS) {
    throw new DomainError("INVALID_QUANTITY", `A quantity may not exceed ${MAX_QUANTITY_UNITS} sale units`);
  }
  const quantityMilli = whole * QUANTITY_SCALE + Number(frac.padEnd(MAX_QUANTITY_DECIMALS, "0") || "0");
  assertQuantityMilli(quantityMilli, saleUnit);
  return quantityMilli;
}

/**
 * THE formatter: one integer, one string, no trailing zeros, digits 0-9 only. Later invoice printing
 * reuses this rather than inventing a second rendering.
 *
 *     1000 -> "1"      2500 -> "2.5"      333 -> "0.333"      3125 -> "3.125"
 */
export function formatQuantity(quantityMilli: number): string {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli < 0) {
    throw new DomainError("INVALID_QUANTITY", `'${quantityMilli}' is not a storable quantity`);
  }
  const whole = Math.trunc(quantityMilli / QUANTITY_SCALE);
  const frac = quantityMilli % QUANTITY_SCALE;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(MAX_QUANTITY_DECIMALS, "0").replace(/0+$/, "")}`;
}

/** A unit price the ledger can multiply by any valid quantity without leaving INTEGER range. */
export function assertUnitPriceMinor(unitPriceMinor: bigint): void {
  if (unitPriceMinor < 0n || unitPriceMinor > MAX_UNIT_PRICE_MINOR) {
    throw new DomainError(
      "PRICE_OUT_OF_RANGE",
      `A unit price must be between 0 and ${MAX_UNIT_PRICE_MINOR} minor units`,
    );
  }
}

/**
 * The line total — the ONE arithmetic, in exact integers, rounding half up:
 *
 *     line_total_minor = (quantity_milli * unit_price_minor + 500) / 1000
 *
 * `bigint` division truncates toward zero, and both operands are non-negative, so this is identical
 * to SQLite's integer division on the same values — which is what makes the database CHECK admit
 * exactly this result and no other. A total that rounds to zero is REFUSED: a completed line that
 * charges nothing is not a sale, and the CHECK cannot catch it because 0 is a valid integer.
 */
export function lineTotal(unitPrice: Money, quantityMilli: number, saleUnit: string): Money {
  assertQuantityMilli(quantityMilli, saleUnit);
  assertUnitPriceMinor(unitPrice.minor);
  const total = (BigInt(quantityMilli) * unitPrice.minor + 500n) / BigInt(QUANTITY_SCALE);
  if (total === 0n) {
    throw new DomainError(
      "ZERO_VALUE_LINE",
      `${formatQuantity(quantityMilli)} ${saleUnit} at this price rounds to zero; the line was refused`,
    );
  }
  return money(total, unitPrice.currency);
}
