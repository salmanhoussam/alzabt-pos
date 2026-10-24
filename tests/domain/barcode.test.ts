/**
 * The barcode normalization contract.
 *
 * 🔴 THE TEST THIS FILE EXISTS FOR is the UPC-A / EAN-13 equivalence. It was found by EXECUTION
 * during the mobile-LAN study — a typed UPC-A came back from the decoder as a zero-prefixed EAN-13
 * — and it is the one way a shop could end up with two products for one box.
 *
 * Real-world numbers are used throughout and each one's check digit is genuine, because a test
 * built on made-up barcodes would pass against an implementation that ignores check digits
 * entirely.
 */
import { describe, expect, it } from "vitest";
import { barcodesMatch, gs1CheckDigit, hasValidCheckDigit, normalizeBarcode } from "../../src/domain/barcode";

describe("the UPC-A / EAN-13 equivalence", () => {
  it("🔴 stores a 12-digit UPC-A as its 13-digit EAN-13 form, and says it did", () => {
    const n = normalizeBarcode("036000291452")!;
    expect(n.value).toBe("0036000291452");
    expect(n.kind).toBe("EAN13");
    expect(n.paddedFromUpcA).toBe(true);
  });

  it("🔴 the typed UPC-A and the decoded EAN-13 are ONE barcode, not two", () => {
    // This is the whole point. The merchant types the number off the box; the phone photographs
    // the same box and the decoder returns the zero-prefixed form. Both must land on one row.
    expect(normalizeBarcode("036000291452")!.value).toBe(normalizeBarcode("0036000291452")!.value);
    expect(barcodesMatch("036000291452", "0036000291452")).toBe(true);
  });

  it("padding is only ever applied to 12 digits, in one direction", () => {
    // A 13-digit value is already canonical and is NOT stripped: EAN-13 is the superset, so
    // padding is total where stripping would not be.
    const thirteen = normalizeBarcode("5901234123457")!;
    expect(thirteen.value).toBe("5901234123457");
    expect(thirteen.paddedFromUpcA).toBe(false);
    // An 8-digit EAN-8 is its own symbology and is never padded towards 13.
    const eight = normalizeBarcode("96385074")!;
    expect(eight.value).toBe("96385074");
    expect(eight.kind).toBe("EAN8");
  });

  it("🔴 and two DIFFERENT barcodes do not become one", () => {
    // The negative control for the rule above: normalization must not collapse things that only
    // look similar. 5901234123457 and 0590123412345 differ, and must keep differing.
    expect(barcodesMatch("5901234123457", "0590123412345")).toBe(false);
    expect(barcodesMatch("96385074", "0000096385074")).toBe(false);
  });
});

describe("the GS1 check digit", () => {
  it("is computed with weights that alternate from the RIGHT", () => {
    // 🔴 The common wrong implementation fixes the weights to the string's start, which passes for
    // one length and fails for the other. These two lengths are what catch it.
    expect(gs1CheckDigit("590123412345")).toBe(7);  // EAN-13 → 5901234123457
    expect(gs1CheckDigit("9638507")).toBe(4);       // EAN-8  → 96385074
    // 🔴 An ODD-length body, which is where a weights-from-the-left implementation diverges. I
    // first wrote `0` here from arithmetic in my head and the test caught me; 3 is what two
    // independent implementations agree on (forward-walking with alternating weights, and
    // reverse-then-index), so the number is measured rather than asserted.
    expect(gs1CheckDigit("00360002914")).toBe(3);   // 11 digits
    expect(gs1CheckDigit("03600029145")).toBe(2);   // 11 digits, different body
  });

  it("accepts real barcodes and rejects a single altered digit", () => {
    expect(hasValidCheckDigit("5901234123457")).toBe(true);
    expect(hasValidCheckDigit("96385074")).toBe(true);
    expect(hasValidCheckDigit("0036000291452")).toBe(true);
    // One digit changed in the middle — the check digit must notice.
    expect(hasValidCheckDigit("5901234123458")).toBe(false);
    expect(hasValidCheckDigit("5901244123457")).toBe(false);
    expect(hasValidCheckDigit("96385075")).toBe(false);
  });

  it("refuses a wrong check digit with a message naming the last digit", () => {
    expect(() => normalizeBarcode("5901234123458")).toThrow(/check digit/);
    expect(() => normalizeBarcode("036000291453")).toThrow(/check digit/);
    expect(() => normalizeBarcode("96385075")).toThrow(/check digit/);
  });
});

describe("what is NOT transformed", () => {
  it("🔴 preserves case, because Code 128 is case-sensitive", () => {
    // Two different physical symbols. Folding them would merge two real products.
    expect(normalizeBarcode("ALZ-7781-A")!.value).toBe("ALZ-7781-A");
    expect(normalizeBarcode("alz-7781-a")!.value).toBe("alz-7781-a");
    expect(barcodesMatch("ALZ-7781-A", "alz-7781-a")).toBe(false);
  });

  it("removes whitespace anywhere, because a scanner or a keyboard can introduce it", () => {
    expect(normalizeBarcode("  5901234123457 ")!.value).toBe("5901234123457");
    expect(normalizeBarcode("5901 2341 23457")!.value).toBe("5901234123457");
    expect(normalizeBarcode("\t96385074\n")!.value).toBe("96385074");
  });

  it("treats a numeric string of an unretail length as a Code 128 payload, unpadded", () => {
    // Guessing which symbology a 10-digit number meant would be inventing a fact about a label
    // nobody here can see. It is stored as what it is.
    const n = normalizeBarcode("1234567890")!;
    expect(n.value).toBe("1234567890");
    expect(n.kind).toBe("CODE128");
    expect(n.paddedFromUpcA).toBe(false);
  });

  it("no barcode is the ordinary state, and is not an error", () => {
    expect(normalizeBarcode(null)).toBeNull();
    expect(normalizeBarcode(undefined)).toBeNull();
    expect(normalizeBarcode("")).toBeNull();
    expect(normalizeBarcode("   ")).toBeNull();
    // And a missing barcode never "matches" another missing one — two unbarcoded products are not
    // duplicates of each other, which is what the partial UNIQUE index relies on being true.
    expect(barcodesMatch(null, null)).toBe(false);
    expect(barcodesMatch("", "")).toBe(false);
  });

  it("refuses what cannot be a barcode at all", () => {
    expect(() => normalizeBarcode(12345)).toThrow(/must be text/);
    expect(() => normalizeBarcode({})).toThrow(/must be text/);
    expect(() => normalizeBarcode("x".repeat(49))).toThrow(/longer than/);
    // A control character would make an exported JSON string or a CSV cell lie about its content.
    expect(() => normalizeBarcode("ALZ\u0000123")).toThrow(/control characters/);
    expect(() => normalizeBarcode("ALZ\u001b[31m")).toThrow(/control characters/);
  });
});
