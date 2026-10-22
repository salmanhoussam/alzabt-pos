/**
 * The five sale-outcome sentences, in both languages.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE IS NOT "A TRANSLATION TEST". Four of the product's error codes decide whether a
 * cashier presses the button again. Getting the WORDS right is not the point; keeping the three
 * outcomes — recorded, not recorded, unknown — distinguishable, and keeping the recorded one from
 * ever reading like an invitation to retry, is the point. Those are properties, and they are
 * asserted here as properties rather than as string equality, so a future rewording cannot quietly
 * turn "do not ring it up again" into "you can try again".
 *
 * 🔴 IT IS A TRANSITION, NOT AN INVARIANT, for the Arabic half. Before this slice all five
 * sentences existed in English only, built as literals at the throw site in `ipcHandlers.ts`:
 *   "Unexpected error. Please try again; if it keeps happening, contact support."
 *   "Unexpected error — the sale was not recorded."
 *   "Unexpected error — the sale was not recorded. You can try again."
 *   "The sale WAS recorded (receipt #N) but an unexpected error followed. Check History — do not
 *    ring it up again."
 *   "Unexpected error — it is not known whether the sale was recorded. Check History before trying
 *    again."
 * Those exact English strings are PRESERVED and are asserted below, so English mode is provably
 * unchanged; Arabic is the new value.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { type SaleOutcomeKind, isReceiptNumber, saleOutcomeError } from "../../src/main/saleOutcomeText";
import { LANGUAGES, type Language } from "../../src/shared/i18n";

const KINDS: readonly SaleOutcomeKind[] = ["internal", "not_recorded", "not_recorded_retry", "recorded", "unknown"];

/** The Arabic and English phrase that tells a cashier to look at the sales log. */
const HISTORY = { ar: "راجع السجلّ", en: "Check History" } as const;
/** The Arabic and English phrase that must NEVER appear beside a recorded sale. */
const INVITES_RETRY = { ar: "يمكنك إعادة المحاولة", en: "You can try again" } as const;
/** The do-not-repeat instruction. */
const DO_NOT_REPEAT = { ar: "لا تُعِد إدخالها", en: "do not ring it up again" } as const;

describe("the sale-outcome sentences", () => {
  // ── 1 · code ↔ meaning ──────────────────────────────────────────────────────────────────────
  it("🔴 maps each outcome to the code the renderer and the tests already key on", () => {
    expect(saleOutcomeError("ar", "internal").code).toBe("INTERNAL");
    expect(saleOutcomeError("ar", "not_recorded").code).toBe("SALE_NOT_RECORDED");
    expect(saleOutcomeError("ar", "not_recorded_retry").code).toBe("SALE_NOT_RECORDED");
    expect(saleOutcomeError("ar", "recorded", 7).code).toBe("SALE_RECORDED");
    expect(saleOutcomeError("ar", "unknown").code).toBe("SALE_STATUS_UNKNOWN");
  });

  it("the code never depends on the language — only the words do", () => {
    for (const kind of KINDS) {
      expect(saleOutcomeError("ar", kind, 1).code).toBe(saleOutcomeError("en", kind, 1).code);
    }
  });

  // ── 2 · the three outcomes stay distinct ────────────────────────────────────────────────────
  it("🔴 recorded, not-recorded and unknown are three DIFFERENT sentences, in both languages", () => {
    for (const lang of LANGUAGES) {
      const texts = [
        saleOutcomeError(lang, "not_recorded").message,
        saleOutcomeError(lang, "not_recorded_retry").message,
        saleOutcomeError(lang, "recorded", 4).message,
        saleOutcomeError(lang, "unknown").message,
        saleOutcomeError(lang, "internal").message,
      ];
      expect(new Set(texts).size, `${lang}: two outcomes read the same`).toBe(texts.length);
    }
  });

  it("🔴 the two halves of SALE_NOT_RECORDED differ: only the ledger-confirmed one offers a retry", () => {
    for (const lang of LANGUAGES) {
      const blind = saleOutcomeError(lang, "not_recorded").message;
      const confirmed = saleOutcomeError(lang, "not_recorded_retry").message;
      expect(confirmed).toContain(INVITES_RETRY[lang]);
      expect(blind).not.toContain(INVITES_RETRY[lang]);
    }
  });

  it("the generic fault says NOTHING about sales — it fires on every channel", () => {
    expect(saleOutcomeError("en", "internal").message).not.toMatch(/sale/i);
    expect(saleOutcomeError("ar", "internal").message).not.toContain("فاتورة");
    expect(saleOutcomeError("ar", "internal").message).not.toContain("السجلّ");
  });

  // ── 3 · the real receipt number survives ────────────────────────────────────────────────────
  it("🔴 prints the REAL receipt number, in both languages, in 0-9 digits", () => {
    expect(saleOutcomeError("en", "recorded", 1).message).toContain("receipt #1");
    expect(saleOutcomeError("en", "recorded", 4096).message).toContain("receipt #4096");
    expect(saleOutcomeError("ar", "recorded", 1).message).toContain("إيصال رقم 1");
    expect(saleOutcomeError("ar", "recorded", 4096).message).toContain("إيصال رقم 4096");
    // No placeholder may survive into merchant-facing text.
    for (const lang of LANGUAGES) {
      expect(saleOutcomeError(lang, "recorded", 12).message).not.toContain("{receipt}");
    }
  });

  // ── 4 · missing or malformed optional data ──────────────────────────────────────────────────
  it("🔴 accepts only a real receipt number", () => {
    expect(isReceiptNumber(1)).toBe(true);
    expect(isReceiptNumber(999999)).toBe(true);
    for (const bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, "7", {}, [], true, 2 ** 53]) {
      expect(isReceiptNumber(bad), `${String(bad)} is not a receipt number`).toBe(false);
    }
  });

  it("🔴 a MISSING or malformed receipt number never becomes an invented one, and never downgrades the outcome", () => {
    for (const lang of LANGUAGES) {
      for (const bad of [undefined, null, 0, -1, 1.5, NaN, "7", {}]) {
        const r = saleOutcomeError(lang, "recorded", bad);
        // Still RECORDED — not "unknown". The ledger said the sale is there.
        expect(r.code).toBe("SALE_RECORDED");
        // No number at all, rather than a wrong one.
        expect(r.message).not.toMatch(/[0-9]/);
        expect(r.message).not.toContain("{receipt}");
        expect(r.message).not.toContain(String(bad));
        // And the instruction that actually protects the merchant is still there.
        expect(r.message).toContain(DO_NOT_REPEAT[lang]);
        expect(r.message).toContain(HISTORY[lang]);
      }
    }
  });

  // ── 5 · never invite a repeat of a recorded sale ────────────────────────────────────────────
  it("🔴 a RECORDED sale is never, in either language, with or without a number, told to try again", () => {
    for (const lang of LANGUAGES) {
      for (const receipt of [7, undefined]) {
        const text = saleOutcomeError(lang, "recorded", receipt).message;
        expect(text).not.toContain(INVITES_RETRY[lang]);
        expect(text).toContain(DO_NOT_REPEAT[lang]);
      }
    }
    // The English wording is unambiguous about which way round it is.
    expect(saleOutcomeError("en", "recorded", 7).message).toMatch(/WAS recorded/);
  });

  // ── 6 · the History instruction is present where it is required ─────────────────────────────
  it("🔴 every outcome whose safe next step is the sales log says so, in the reader's language", () => {
    for (const lang of LANGUAGES) {
      expect(saleOutcomeError(lang, "recorded", 3).message).toContain(HISTORY[lang]);
      expect(saleOutcomeError(lang, "unknown").message).toContain(HISTORY[lang]);
      // And where it is NOT required, it is not padded in.
      expect(saleOutcomeError(lang, "not_recorded_retry").message).not.toContain(HISTORY[lang]);
    }
  });

  it("the uncertain outcome says plainly that it is uncertain", () => {
    expect(saleOutcomeError("en", "unknown").message).toMatch(/not known whether/);
    expect(saleOutcomeError("ar", "unknown").message).toContain("لا نعرف");
  });

  // ── 7 · nothing internal can leak ───────────────────────────────────────────────────────────
  it("🔴 no sentence can carry a diagnostic, because none of them takes one", () => {
    for (const lang of LANGUAGES) {
      for (const kind of KINDS) {
        const text = saleOutcomeError(lang, kind, 5).message;
        for (const leak of ["Error", "at ", ".ts", ".sqlite", "SQLITE", "SELECT", "INSERT", "C:\\", "/home/", "stack"]) {
          expect(text, `${lang}:${kind} leaks ${leak}`).not.toContain(leak);
        }
        expect(text).not.toContain("undefined");
        expect(text).not.toContain("[object");
      }
    }
  });

  // ── 8 · language switching ──────────────────────────────────────────────────────────────────
  it("🔴 Arabic and English really are different text, and Arabic really is Arabic", () => {
    for (const kind of KINDS) {
      const ar = saleOutcomeError("ar", kind, 2).message;
      const en = saleOutcomeError("en", kind, 2).message;
      expect(ar).not.toBe(en);
      expect(ar, `ar:${kind} is not Arabic`).toMatch(/[\u0600-\u06FF]/);
      expect(en, `en:${kind} carries Arabic`).not.toMatch(/[\u0600-\u06FF]/);
    }
  });

  it("🔴 the English wording that shipped is preserved EXACTLY — English mode is unchanged", () => {
    expect(saleOutcomeError("en", "internal").message).toBe(
      "Unexpected error. Please try again; if it keeps happening, contact support.",
    );
    expect(saleOutcomeError("en", "not_recorded").message).toBe("Unexpected error \u2014 the sale was not recorded.");
    expect(saleOutcomeError("en", "not_recorded_retry").message).toBe(
      "Unexpected error \u2014 the sale was not recorded. You can try again.",
    );
    expect(saleOutcomeError("en", "recorded", 1).message).toBe(
      "The sale WAS recorded (receipt #1) but an unexpected error followed. Check History \u2014 do not ring it up again.",
    );
    expect(saleOutcomeError("en", "unknown").message).toBe(
      "Unexpected error \u2014 it is not known whether the sale was recorded. Check History before trying again.",
    );
  });

  it("no sentence is left as a bare key — a missing dictionary entry would be visible here", () => {
    for (const lang of LANGUAGES as readonly Language[]) {
      for (const kind of KINDS) {
        expect(saleOutcomeError(lang, kind, 1).message).not.toMatch(/^outcome\./);
      }
      expect(saleOutcomeError(lang, "recorded", undefined).message).not.toMatch(/^outcome\./);
    }
  });
});
