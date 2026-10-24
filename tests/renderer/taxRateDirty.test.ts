import { describe, expect, it } from "vitest";
import { isTypedTaxRateUnsaved } from "../../src/renderer/screens/invoices/taxRateDirty";

// The service's own authoritative parser is separately covered in invoice tax tests.
describe("unblurred invoice tax rate — never silently discard a refused entry", () => {
  it("treats valid equivalents as unchanged at basis-point precision", () => {
    for (const text of ["11", "11.0", "11.00", " 11.0 "]) {
      expect(isTypedTaxRateUnsaved(text, 1100)).toBe(false);
    }
    expect(isTypedTaxRateUnsaved("0.01", 1)).toBe(false);
    expect(isTypedTaxRateUnsaved("100", 10000)).toBe(false);
  });

  it("detects genuine changed rates", () => {
    expect(isTypedTaxRateUnsaved("12", 1100)).toBe(true);
    expect(isTypedTaxRateUnsaved("0", 1100)).toBe(true);
  });

  it("detects numerically equivalent text that the backend refuses", () => {
    for (const invalid of ["11.000", "11e0", "0xB", "+11", "11.", "11,0", "0011", ""]) {
      expect(isTypedTaxRateUnsaved(invalid, 1100)).toBe(true);
    }
    expect(isTypedTaxRateUnsaved("100.01", 10000)).toBe(true);
  });
});
