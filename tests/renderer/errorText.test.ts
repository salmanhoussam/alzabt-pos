/**
 * What the operator actually reads when something is refused.
 *
 * 🔴 Why this file exists: `errorText` only unwrapped an ApiError, so a DomainError raised inside
 * the RENDERER — which `parseQuantity` is the first to do — became the literal string "Unexpected
 * error". Typing 1.5 against a piece product therefore told the operator nothing at all, which
 * defeats the point of refusing a fraction instead of rounding it. Found by the installed-app E2E
 * on Windows (run 37614378776, step 17); this test is the cheap guard that should have caught it
 * first.
 */
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { ApiError, errorText } from "../../src/renderer/api";
import { parseQuantity } from "../../src/domain/quantity";

describe("errorText", () => {
  it("shows the main process's message for an ApiError", () => {
    expect(errorText(new ApiError("TOTAL_MISMATCH", "The displayed total no longer matches"))).toBe(
      "The displayed total no longer matches",
    );
  });

  it("shows a DomainError the renderer raised itself", () => {
    expect(errorText(new DomainError("FRACTION_NOT_ALLOWED", "'piece' is sold in whole units"))).toBe(
      "'piece' is sold in whole units",
    );
  });

  it("explains a refused fraction in words the operator can act on", () => {
    let text = "";
    try {
      parseQuantity("1.5", "piece");
    } catch (e) {
      text = errorText(e);
    }
    expect(text).not.toBe("Unexpected error");
    expect(text).toMatch(/whole units/);
    expect(text).toContain("1.5");
  });

  it("explains excess precision too", () => {
    let text = "";
    try {
      parseQuantity("2.5555", "kg");
    } catch (e) {
      text = errorText(e);
    }
    expect(text).toMatch(/decimal places/);
  });

  it("still refuses to show anything verbatim for a genuinely unexpected fault", () => {
    expect(errorText(new TypeError("x is not a function"))).toBe("Unexpected error");
    expect(errorText("a bare string")).toBe("Unexpected error");
    expect(errorText(undefined)).toBe("Unexpected error");
  });
});
