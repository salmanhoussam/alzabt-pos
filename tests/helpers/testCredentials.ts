/**
 * TEST-ONLY operator PINs (O-1 P1, owner decision R9, 2026-11-25).
 *
 * 🔴 WHY THESE EXIST. The published defaults 1111/2222 never authenticate any more (PosService.login and
 * OperatorService.authenticate refuse them as wrong PINs). Harness-based tests exercise ordinary operation — sales,
 * invoices, permissions — so they sign in with these PRIVATE test PINs instead. They obey the production rule
 * (`assertValidPin`: 6-8 digits) and are checked by the production scrypt (`pinMatches`) — there is NO test-only
 * bypass anywhere: the product code is identical in tests and in the shipped app.
 *
 * They are not secrets (they only ever exist in synthetic test ledgers), and they are NOT the published values.
 */
import { scryptSync } from "node:crypto";
import { SCRYPT } from "../../src/application/cashierAuth";
import { PUBLISHED_DEFAULT_PINS, assertValidPin } from "../../src/domain/pinRule";

export const TEST_OWNER_PIN = "482613";
export const TEST_CASHIER_PIN = "739205";

function credential(pin: string, saltHex: string): { readonly pinSaltHex: string; readonly pinHashHex: string } {
  assertValidPin(pin);
  if (PUBLISHED_DEFAULT_PINS.has(pin)) throw new Error("a test PIN must never be a published default");
  return { pinSaltHex: saltHex, pinHashHex: scryptSync(pin, Buffer.from(saltHex, "hex"), 32, SCRYPT).toString("hex") };
}

/** Per-id test credential for the two seeded operator rows (ids are kept: sales carry them as snapshots). */
export const TEST_CREDENTIALS: Readonly<Record<string, { readonly pin: string; readonly pinSaltHex: string; readonly pinHashHex: string }>> = {
  "cashier-01": { pin: TEST_OWNER_PIN, ...credential(TEST_OWNER_PIN, "7e57a11ce0000001") },
  "cashier-02": { pin: TEST_CASHIER_PIN, ...credential(TEST_CASHIER_PIN, "7e57a11ce0000002") },
};

/**
 * The compiled fixture list (src/fixtures/cashiers.ts) with the SAME ids and names but the test credentials, for tests
 * that build PosService on the fixture path (no operators table). The published list still exists and still holds
 * 1111/2222 — which now never sign in — so a test that wants a working sign-in uses this one.
 */
export const TEST_FIXTURE_CASHIERS = (["cashier-01", "cashier-02"] as const).map((id, i) => ({
  id,
  name: i === 0 ? "Cashier One" : "Cashier Two",
  pinSaltHex: TEST_CREDENTIALS[id]!.pinSaltHex,
  pinHashHex: TEST_CREDENTIALS[id]!.pinHashHex,
}));
