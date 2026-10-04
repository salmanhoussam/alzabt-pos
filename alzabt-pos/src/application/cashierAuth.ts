import { scryptSync, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors";
import type { CashierFixture } from "../fixtures/cashiers";

export interface Cashier {
  readonly id: string;
  readonly name: string;
}

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/** Verifies a cashier PIN against its stored scrypt hash in constant time. */
export function verifyCashierPin(
  cashiers: ReadonlyArray<CashierFixture>,
  cashierId: string,
  pin: string,
): Cashier {
  const cashier = cashiers.find((c) => c.id === cashierId);
  // Same generic error for unknown cashier and wrong PIN.
  const fail = () => new DomainError("INVALID_CREDENTIALS", "Cashier or PIN is incorrect");
  if (!cashier || !/^\d{4,8}$/.test(pin)) throw fail();
  const expected = Buffer.from(cashier.pinHashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(cashier.pinSaltHex, "hex"), expected.length, SCRYPT);
  if (!timingSafeEqual(actual, expected)) throw fail();
  return { id: cashier.id, name: cashier.name };
}
