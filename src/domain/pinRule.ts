/**
 * What counts as a PIN. One definition, in the domain, for every path that sets one.
 *
 * 🔴 WHY THIS FILE EXISTS. The 4–8 digit rule was real but lived only in the renderer
 * (`LoginScreen.tsx`'s `PIN_MIN`/`PIN_MAX`), while the IPC boundary accepted sixteen characters of
 * anything (`ipcHandlers.ts`, `str(o.pin, "pin", 16)`). That was harmless for exactly as long as no
 * PIN could be set at runtime — a rule enforced only by the keypad that typed it is not a rule, it
 * is a habit of one screen. The moment an owner can set an employee's PIN, a seed script, a reset
 * path and a future API all meet that rule, so it has to live where they can all reach it.
 *
 * The renderer keeps its own copy as UX — it stops the operator typing a ninth digit — and that is
 * now a convenience on top of this, not the thing standing between a weak PIN and the database.
 */
import { DomainError } from "./errors";

/**
 * 🔴 SIX, NOT FOUR, AND THE FOUR WAS MEASURED RATHER THAN DISLIKED. scrypt here is fixed at
 * N=16384, r=8, p=1 (`cashierAuth.ts`), which an independent review timed on real hardware at
 * 41.8 ms per guess — so the whole four-digit space is about 418 seconds single-threaded, and it
 * recovered the seeded owner's `1111` from its real salt in 46 seconds. The salt and hash sit
 * unencrypted in the ledger file, which anyone with the physical access this product already
 * assumes can read. Four digits was therefore not a weak rule, it was no rule at all.
 *
 * Six digits is 100× that work — about 11.6 hours for the full space — which is not unbreakable
 * and is not claimed to be. It is enough that recovering a PIN stops being something done during
 * a lunch break, and it is the longest a shop will actually type on a keypad all day.
 *
 * 🔴 THIS GOVERNS NEWLY CHOSEN PINS ONLY. The seeded bootstrap credentials are 4 digits and must
 * keep VERIFYING, or migration 8 locks every shop out of its own terminal. They can, because
 * verification hashes and compares (`authenticate`) and never asks this function — the one place
 * the two could have been confused. A legacy credential buys the setup form and nothing else, and
 * the PIN chosen there must satisfy the rule below.
 */
export const PIN_MIN_DIGITS = 6;
export const PIN_MAX_DIGITS = 8;

/** Digits only. Not `\d`, which in some engines admits other scripts' digits. */
const DIGITS_ONLY = /^[0-9]+$/;

/**
 * The PIN as it will be hashed, or a DomainError naming what is wrong with it.
 *
 * 🔴 NOT TRIMMED, and that is deliberate. A space is not a digit, so " 1234" is refused rather than
 * quietly accepted as "1234" — an operator who believes their PIN has a leading space would
 * otherwise be unable to explain why it sometimes works. Every other text field in this product
 * trims; this one must not.
 */
export function assertValidPin(pin: unknown): string {
  if (typeof pin !== "string") {
    throw new DomainError("INVALID_PIN", "A PIN is required");
  }
  if (!DIGITS_ONLY.test(pin)) {
    throw new DomainError("INVALID_PIN", "A PIN may contain digits only");
  }
  if (pin.length < PIN_MIN_DIGITS || pin.length > PIN_MAX_DIGITS) {
    throw new DomainError(
      "INVALID_PIN",
      `A PIN must be between ${PIN_MIN_DIGITS} and ${PIN_MAX_DIGITS} digits`,
    );
  }
  return pin;
}

/** True when `pin` would be accepted. For the UI; the write paths use `assertValidPin`. */
export function isValidPin(pin: unknown): boolean {
  try {
    assertValidPin(pin);
    return true;
  } catch {
    return false;
  }
}
