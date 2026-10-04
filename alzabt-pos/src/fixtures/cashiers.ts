/**
 * Bundled TEST cashiers for Gate 1. NOT real accounts — cloud users arrive in a later gate.
 *
 * PINs are stored only as scrypt hashes (N=16384, r=8, p=1, 32-byte key, per-cashier salt).
 * For local testing: cashier-01 PIN is 1111, cashier-02 PIN is 2222.
 */
export interface CashierFixture {
  readonly id: string;
  readonly name: string;
  readonly pinSaltHex: string;
  readonly pinHashHex: string;
}

export const FIXTURE_CASHIERS: ReadonlyArray<CashierFixture> = [
  {
    id: "cashier-01",
    name: "Cashier One",
    pinSaltHex: "a1f3c9e27b4d6058",
    pinHashHex: "a8f8c45b97712daec733a8b4d198ac96376c05697b5935a7b30f965e27478bce",
  },
  {
    id: "cashier-02",
    name: "Cashier Two",
    pinSaltHex: "5c8e01d7f9a3b264",
    pinHashHex: "0ca57b50d33e8f2f395a2a636e8babd96c096120e439cc069d17a6586fb90537",
  },
];
