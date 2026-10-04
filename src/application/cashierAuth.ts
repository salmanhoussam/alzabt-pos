import { scryptSync, timingSafeEqual } from "node:crypto";
import type { CashierFixture } from "../fixtures/cashiers";

export interface Cashier {
  readonly id: string;
  readonly name: string;
}

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/**
 * True only if `pin` matches the cashier's stored scrypt hash (constant-time compare). A PIN that
 * is not 4–8 digits never matches. Lockout bookkeeping is the caller's job (PosService.login).
 */
export function pinMatches(cashier: CashierFixture, pin: string): boolean {
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) return false;
  const expected = Buffer.from(cashier.pinHashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(cashier.pinSaltHex, "hex"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}
