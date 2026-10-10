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

export const PIN_MIN_DIGITS = 4;
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
