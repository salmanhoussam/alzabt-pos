/**
 * The one barcode normalization contract.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS, AND IT IS NOT STYLE. A UPC-A is a 12-digit symbol; its EAN-13
 * representation is the same 12 digits with a leading zero. They are THE SAME BARCODE on the same
 * box. Found by execution during the mobile-LAN study: a UPC-A written as `036000291452` was read
 * back by the decoder as `0036000291452`, format EAN13.
 *
 * So without one canonical form, a shop that typed the number by hand and a shop that photographed
 * the box would end up with TWO products for one item — and the partial UNIQUE index would not stop
 * it, because the two strings genuinely differ. Uniqueness is only meaningful over a canonical
 * form, which is why normalization lives here and not in a screen.
 *
 * THE CANONICAL FORM IS THE 13-DIGIT ONE. A 12-digit all-digits value is stored zero-padded to 13.
 * That direction is chosen rather than stripping, because EAN-13 is the superset: every UPC-A has
 * an EAN-13 form, but not every EAN-13 has a UPC-A form, so padding is total and stripping is not.
 *
 * 🔴 AND NOTHING ELSE IS TRANSFORMED. No case folding (Code 128 is case-sensitive, so `ALZ-1` and
 * `alz-1` are different symbols and must stay different), no check-digit "repair", no guessing at
 * EAN-8 ↔ EAN-13, no stripping of leading zeros in any other length. Every transformation this
 * file performs is one the symbologies themselves define; anything more would be inventing data
 * about a physical label nobody here can see.
 *
 * Whitespace is removed entirely rather than trimmed: a barcode contains no spaces, and a scanner
 * or a merchant's keyboard can introduce them at either end or in the middle.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { DomainError } from "./errors";

/** The symbologies this product validates. Decoding may report others; storing them is refused. */
export type BarcodeKind = "EAN13" | "EAN8" | "CODE128";

export const MAX_BARCODE = 48;

/** What normalization decided, so a screen can tell the operator what it is holding. */
export interface NormalizedBarcode {
  /** The canonical value to store. */
  readonly value: string;
  /** What it was recognised as. CODE128 is the catch-all for a non-numeric symbol. */
  readonly kind: BarcodeKind;
  /** True when a 12-digit UPC-A was padded to its 13-digit EAN-13 form. */
  readonly paddedFromUpcA: boolean;
}

/**
 * The GS1 modulo-10 check digit, which EAN-13, EAN-8 and UPC-A all share.
 *
 * Weights alternate 3 and 1 from the RIGHTMOST data digit leftwards, which is why this walks the
 * string backwards rather than forwards — the common wrong implementation fixes the weights to the
 * string's start and then passes for even lengths and fails for odd ones.
 */
export function gs1CheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  for (let i = digitsWithoutCheck.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(digitsWithoutCheck[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when a numeric barcode's own last digit agrees with the GS1 check over the rest. */
export function hasValidCheckDigit(value: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(value)) return false;
  return gs1CheckDigit(value.slice(0, -1)) === Number(value[value.length - 1]);
}

/**
 * Normalizes a typed or decoded barcode into the one storable form.
 *
 * Returns `null` for an empty input, because "no barcode" is the ordinary state of most of this
 * shop's stock and is not an error. Throws `INVALID_INPUT` only for something that cannot be a
 * barcode at all.
 */
export function normalizeBarcode(raw: unknown): NormalizedBarcode | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new DomainError("INVALID_INPUT", "A barcode must be text");
  }
  // All whitespace, not just the ends: a scanner or a keyboard can put a space anywhere.
  const value = raw.replace(/\s+/g, "");
  if (value.length === 0) return null;
  if (value.length > MAX_BARCODE) {
    throw new DomainError("INVALID_INPUT", `A barcode cannot be longer than ${MAX_BARCODE} characters`);
  }
  // Control characters would make an exported JSON string or a CSV cell lie about its own content.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError("INVALID_INPUT", "A barcode cannot contain control characters");
  }

  if (/^\d+$/.test(value)) {
    // 🔴 THE EQUIVALENCE, APPLIED IN ONE PLACE. A 12-digit numeric symbol is a UPC-A; its EAN-13
    // form is the canonical one.
    if (value.length === 12) {
      const padded = `0${value}`;
      if (!hasValidCheckDigit(padded)) {
        throw new DomainError("INVALID_INPUT", "This 12-digit barcode's check digit is wrong — check the last digit");
      }
      return { value: padded, kind: "EAN13", paddedFromUpcA: true };
    }
    if (value.length === 13) {
      if (!hasValidCheckDigit(value)) {
        throw new DomainError("INVALID_INPUT", "This 13-digit barcode's check digit is wrong — check the last digit");
      }
      return { value, kind: "EAN13", paddedFromUpcA: false };
    }
    if (value.length === 8) {
      if (!hasValidCheckDigit(value)) {
        throw new DomainError("INVALID_INPUT", "This 8-digit barcode's check digit is wrong — check the last digit");
      }
      return { value, kind: "EAN8", paddedFromUpcA: false };
    }
    // A numeric string of some other length is NOT a retail barcode, and guessing which symbology
    // the merchant meant would be inventing a fact about a physical label. It is stored as the
    // Code 128 payload it is — Code 128 encodes digits perfectly well — and nothing is padded.
    return { value, kind: "CODE128", paddedFromUpcA: false };
  }

  // Non-numeric: a Code 128 (or Code 39) payload. Case is preserved deliberately.
  return { value, kind: "CODE128", paddedFromUpcA: false };
}

/**
 * The same contract, for comparing two barcodes without storing either.
 *
 * Used by search and by the duplicate check, so "is this the same barcode" is answered by the one
 * normalization rather than by a second, drifting copy of it.
 */
export function barcodesMatch(a: unknown, b: unknown): boolean {
  const left = safeNormalize(a);
  const right = safeNormalize(b);
  return left !== null && right !== null && left.value === right.value;
}

function safeNormalize(raw: unknown): NormalizedBarcode | null {
  try {
    return normalizeBarcode(raw);
  } catch {
    return null;
  }
}
