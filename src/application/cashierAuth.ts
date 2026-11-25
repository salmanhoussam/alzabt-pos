import { scryptSync, timingSafeEqual } from "node:crypto";

export interface Cashier {
  readonly id: string;
  readonly name: string;
}

/**
 * The scrypt parameters every PIN in this product has ever been hashed with.
 *
 * 🔴 EXPORTED, NOT COPIED. Migration 8 hashes new PINs in `OperatorService`, and the two bootstrap
 * rows carry hashes made with these exact parameters. A second literal elsewhere that drifted by
 * one would silently stop every existing PIN from matching.
 */
export const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/**
 * Just enough of an account to verify a PIN: a salt and a hash.
 *
 * Widened from `CashierFixture` by migration 8 — an `operators` ROW satisfies this shape just as
 * the compiled-in fixture did, so the verification logic did not have to change at all.
 */
export interface PinCredential {
  readonly pinSaltHex: string;
  readonly pinHashHex: string;
}

/** Every stored PIN hash is this long (OperatorService and the fixtures both write 32 bytes). */
const PIN_HASH_BYTES = 32;
/** A fixed, public salt for work done on behalf of no account. It protects nothing; it only costs the same. */
const NO_ACCOUNT_SALT = Buffer.from("a1b2c3d4e5f60718", "hex");
/** Input longer than this is never a PIN; it is cut before hashing so the work stays bounded. */
const MAX_HASHED_INPUT = 64;

/**
 * True only if `pin` matches the cashier's stored scrypt hash (constant-time compare). A PIN that
 * is not 4–8 digits never matches. Lockout bookkeeping is the caller's job (PosService.login).
 *
 * 🔴 O-1 P1-T (owner decision O-14g, contract v3.1 R3, 2026-11-25): EXACTLY ONE scrypt runs on every call — also
 * for malformed input, which used to return before hashing. The verdict is decided after the work, so a malformed
 * PIN does no less work than a wrong one. This is "the same work on every path", NOT a proven constant-time
 * guarantee: no timing measurement backs it, and none is claimed.
 */
export function pinMatches(cashier: PinCredential, pin: string): boolean {
  const wellFormed = typeof pin === "string" && /^\d{4,8}$/.test(pin);
  const expected = Buffer.from(cashier.pinHashHex, "hex");
  const actual = scryptSync(hashInput(pin), Buffer.from(cashier.pinSaltHex, "hex"), PIN_HASH_BYTES, SCRYPT);
  return wellFormed && expected.length === PIN_HASH_BYTES && timingSafeEqual(actual, expected);
}

/**
 * P1-T: the same scrypt work for a sign-in that has NO account to check against (unknown or inactive operator).
 * The result is discarded. Callers still refuse with their usual neutral answer.
 */
export function pinCheckWithoutAccount(pin: unknown): void {
  scryptSync(hashInput(pin), NO_ACCOUNT_SALT, PIN_HASH_BYTES, SCRYPT);
}

function hashInput(pin: unknown): string {
  return typeof pin === "string" ? pin.slice(0, MAX_HASHED_INPUT) : "";
}
