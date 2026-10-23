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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { ApiError, call, errorText } from "../../src/renderer/api";
import { parseQuantity } from "../../src/domain/quantity";
import { saleOutcomeError } from "../../src/main/saleOutcomeText";

describe("errorText", () => {
  it("localizes only the typed customer-payment overpayment context with its validated amount", () => {
    const context = {
      reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING",
      outstandingMinor: "3000",
      currency: "USD",
    };
    const refusal = new ApiError("INVALID_AMOUNT", "That is more than is owed; 30.00 USD remains", context);
    expect(errorText(refusal, "en")).toBe("That is more than is owed; 30.00 USD remains");
    expect(errorText(refusal, "ar")).toBe("المبلغ المدخل أكبر من المتبقي على هذا الدَّين. المتبقي: \u206830.00 USD\u2069.");

    expect(
      errorText(
        new ApiError("INVALID_AMOUNT", "The selling price must be greater than zero"),
        "ar",
      ),
    ).toBe("The selling price must be greater than zero");
    expect(
      errorText(
        new ApiError("INVALID_AMOUNT", "Unrelated amount error", {
          reason: "SOME_OTHER_REASON",
          outstandingMinor: "3000",
          currency: "USD",
        }),
        "ar",
      ),
    ).toBe("Unrelated amount error");
  });

  it("ignores absent or malformed optional overpayment context without fabricating money", () => {
    const base = "That is more than is owed; 30.00 USD remains";
    for (const context of [
      undefined,
      { reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING", outstandingMinor: "30.00", currency: "USD" },
      { reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING", outstandingMinor: "3000", currency: "XXX" },
      { reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING", outstandingMinor: "1000000000000001", currency: "USD" },
      {
        reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING",
        outstandingMinor: "3000",
        currency: "USD",
        message: "injected",
      },
    ]) {
      const error = new ApiError("INVALID_AMOUNT", base, context);
      expect(errorText(error, "ar")).toBe(base);
      expect(errorText(error, "en")).toBe(base);
    }
  });

  it("shows the main process's message for an ApiError", () => {
    // 🔴 TRANSITION. This asserted the English sentence from the no-argument call:
    //   errorText(new ApiError("TOTAL_MISMATCH", "The displayed total no longer matches"))
    //     === "The displayed total no longer matches"
    // `TOTAL_MISMATCH` is now one of the 18 codes with an Arabic sentence, and with no DOM the
    // language falls back to DEFAULT_TERMINAL_LANGUAGE (Arabic). The old English value is preserved
    // and is asserted on the next line, explicitly in English.
    expect(errorText(new ApiError("TOTAL_MISMATCH", "The displayed total no longer matches"), "en")).toBe(
      "The displayed total no longer matches",
    );
    // An UNMAPPED code still shows exactly what main sent, in either language — which is what this
    // test was really protecting.
    expect(errorText(new ApiError("DUPLICATE_SKU", "'SKU-1' already exists"), "ar")).toBe("'SKU-1' already exists");
    expect(errorText(new ApiError("DUPLICATE_SKU", "'SKU-1' already exists"), "en")).toBe("'SKU-1' already exists");
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

/**
 * The merchant-facing error AREA, not just the helper that formats the string.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS BLOCK IS FOR, AND WHAT IT HONESTLY CANNOT DO. `vitest.config.mts` is
 * `environment: "node"` and this repository has no DOM harness — `tests/renderer/appScreen.test.ts`
 * says so in its own header. So nothing here mounts React, and no assertion below should be read as
 * "the pixels were checked".
 *
 * What it DOES prove is the whole chain from the main process's envelope to the string the error
 * element is handed: a real `IpcResult` carrying the Arabic sentence goes through the real `call()`,
 * becomes a real `ApiError`, and `errorText` hands the sentence on UNCHANGED. The one way this
 * slice could fail silently is a renderer that quietly substitutes its own English text for a
 * message main already localized — and that is exactly what the first two tests refuse.
 *
 * The structural test at the end names the single line that carries it onto the screen, so a
 * refactor that routes the checkout catch somewhere other than the rendered error area fails here
 * rather than in a shop.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("a localized sale outcome reaching the merchant-facing error area", () => {
  /** Exactly the shape the preload bridge resolves with. */
  const envelope = (code: string, message: string) =>
    Promise.resolve({ ok: false as const, error: { code, message } });

  it("🔴 the Arabic 'sale WAS recorded' sentence survives call() → ApiError → errorText intact", async () => {
    const outcome = saleOutcomeError("ar", "recorded", 7);
    let shown = "";
    try {
      await call(envelope(outcome.code, outcome.message));
    } catch (e) {
      shown = errorText(e);
    }
    // Byte-for-byte what main composed — the renderer adds nothing and drops nothing.
    expect(shown).toBe(outcome.message);
    // And the two things that protect the merchant are still in the text the element receives.
    expect(shown).toContain("إيصال رقم 7");
    expect(shown).toContain("لا تُعِد إدخالها");
    expect(shown).not.toBe("Unexpected error");
  });

  it("🔴 all five outcomes arrive in Arabic — none degrades to the English fallback", async () => {
    for (const kind of ["internal", "not_recorded", "not_recorded_retry", "recorded", "unknown"] as const) {
      const outcome = saleOutcomeError("ar", kind, 3);
      let shown = "";
      try {
        await call(envelope(outcome.code, outcome.message));
      } catch (e) {
        shown = errorText(e);
      }
      expect(shown, kind).toBe(outcome.message);
      expect(shown, kind).toMatch(/[\u0600-\u06FF]/);
      expect(shown, kind).not.toBe("Unexpected error");
    }
  });

  it("the code travels with it, so a caller that wants to branch still can", async () => {
    const outcome = saleOutcomeError("ar", "recorded", 2);
    let code = "";
    try {
      await call(envelope(outcome.code, outcome.message));
    } catch (e) {
      code = e instanceof ApiError ? e.code : "";
    }
    expect(code).toBe("SALE_RECORDED");
  });

  it("🔴 the Sell checkout really routes its refusal into the rendered error element", () => {
    const src = readFileSync(join(process.cwd(), "src/renderer/screens/SellScreen.tsx"), "utf8");
    // The catch that handles a failed checkout, and the element that displays it. If either line
    // moves, this slice's Arabic sentence stops reaching the cashier and nothing else would notice.
    expect(src).toContain("setError(errorText(e))");
    expect(src).toMatch(/<p className="error">\{error\}<\/p>/);
  });
});
