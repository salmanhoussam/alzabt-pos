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

/**
 * True only if `pin` matches the cashier's stored scrypt hash (constant-time compare). A PIN that
 * is not 4–8 digits never matches. Lockout bookkeeping is the caller's job (PosService.login).
 */
export function pinMatches(cashier: PinCredential, pin: string): boolean {
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) return false;
  const expected = Buffer.from(cashier.pinHashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(cashier.pinSaltHex, "hex"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}
