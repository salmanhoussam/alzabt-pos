/**
 * The four invoice-outcome sentences, in both languages.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 IT IS A TRANSITION, NOT AN INVARIANT, AND THE OLD VALUE WAS ONE SENTENCE FOR ALL FOUR CASES.
 * Before this slice `finalizeInvoice` had no `onInternal`, so every unexpected fault — before the
 * commit, during it, or after it — produced `GENERIC_INTERNAL`:
 *   "Unexpected error. Please try again; if it keeps happening, contact support."
 * For a fault after the commit that was false in the costly direction: the invoice already had a
 * number and the sale was already in the ledger, and the operator was being invited to issue it
 * again. There is no English wording being replaced here, because there was none to replace.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { type InvoiceOutcomeKind, invoiceOutcomeError, isInvoiceNumber } from "../../src/main/invoiceOutcomeText";
import { LANGUAGES } from "../../src/shared/i18n";

const KINDS: readonly InvoiceOutcomeKind[] = ["not_finalized", "not_finalized_retry", "finalized", "unknown"];

/** The phrase that sends the merchant to the right screen — the INVOICE list, not sales History. */
const INVOICE_LIST = { ar: "قائمة الفواتير", en: "the invoice list" } as const;
/** Must never appear beside an invoice that was issued. */
const INVITES_RETRY = { ar: "يمكنك إعادة المحاولة", en: "You can try again" } as const;
/** The do-not-issue-again instruction. */
const DO_NOT_REISSUE = { ar: "لا تُصدرها مرّة أخرى", en: "do not issue it again" } as const;

describe("the invoice-outcome sentences", () => {
  it("🔴 maps each outcome to its own code — and does NOT borrow the sale codes", () => {
    expect(invoiceOutcomeError("ar", "not_finalized").code).toBe("INVOICE_NOT_FINALIZED");
    expect(invoiceOutcomeError("ar", "not_finalized_retry").code).toBe("INVOICE_NOT_FINALIZED");
    expect(invoiceOutcomeError("ar", "finalized", { invoiceNumber: 5, receiptNumber: 9 }).code).toBe("INVOICE_FINALIZED");
    expect(invoiceOutcomeError("ar", "unknown").code).toBe("INVOICE_STATUS_UNKNOWN");
    for (const kind of KINDS) {
      expect(invoiceOutcomeError("ar", kind).code).not.toMatch(/^SALE_/);
      expect(invoiceOutcomeError("ar", kind).code).not.toBe("INTERNAL");
    }
  });

  it("the code never depends on the language", () => {
    for (const kind of KINDS) {
      expect(invoiceOutcomeError("ar", kind, { invoiceNumber: 1, receiptNumber: 1 }).code).toBe(
        invoiceOutcomeError("en", kind, { invoiceNumber: 1, receiptNumber: 1 }).code,
      );
    }
  });

  it("🔴 issued, not-issued and unknown are three DIFFERENT sentences, in both languages", () => {
    for (const lang of LANGUAGES) {
      const texts = [
        invoiceOutcomeError(lang, "not_finalized").message,
        invoiceOutcomeError(lang, "not_finalized_retry").message,
        invoiceOutcomeError(lang, "finalized", { invoiceNumber: 2, receiptNumber: 3 }).message,
        invoiceOutcomeError(lang, "unknown").message,
      ];
      expect(new Set(texts).size, `${lang}: two outcomes read the same`).toBe(texts.length);
    }
  });

  it("🔴 only the ledger-confirmed not-issued case offers a retry", () => {
    for (const lang of LANGUAGES) {
      expect(invoiceOutcomeError(lang, "not_finalized_retry").message).toContain(INVITES_RETRY[lang]);
      expect(invoiceOutcomeError(lang, "not_finalized").message).not.toContain(INVITES_RETRY[lang]);
    }
  });

  it("🔴 an ISSUED invoice is never told to try again, and always says do not issue it again", () => {
    for (const lang of LANGUAGES) {
      for (const numbers of [
        { invoiceNumber: 418, receiptNumber: 77 },
        { invoiceNumber: 418 },
        {},
      ]) {
        const text = invoiceOutcomeError(lang, "finalized", numbers).message;
        expect(text).not.toContain(INVITES_RETRY[lang]);
        expect(text).toContain(DO_NOT_REISSUE[lang]);
        expect(text).toContain(INVOICE_LIST[lang]);
      }
    }
  });

  it("🔴 prints the REAL invoice number, and the receipt number beside it when there is one", () => {
    expect(invoiceOutcomeError("en", "finalized", { invoiceNumber: 418, receiptNumber: 77 }).message).toBe(
      "Invoice #418 WAS issued (receipt #77) but an unexpected error followed. Check the invoice list \u2014 do not issue it again.",
    );
    const ar = invoiceOutcomeError("ar", "finalized", { invoiceNumber: 418, receiptNumber: 77 }).message;
    expect(ar).toContain("الفاتورة رقم 418");
    expect(ar).toContain("إيصال رقم 77");
    for (const lang of LANGUAGES) {
      expect(invoiceOutcomeError(lang, "finalized", { invoiceNumber: 418, receiptNumber: 77 }).message)
        .not.toContain("{");
    }
  });

  it("🔴 the invoice number alone is enough — the receipt is detail, not a gate", () => {
    expect(invoiceOutcomeError("en", "finalized", { invoiceNumber: 9 }).message).toBe(
      "Invoice #9 WAS issued but an unexpected error followed. Check the invoice list \u2014 do not issue it again.",
    );
    expect(invoiceOutcomeError("ar", "finalized", { invoiceNumber: 9 }).message).toContain("الفاتورة رقم 9");
    expect(invoiceOutcomeError("en", "finalized", { invoiceNumber: 9 }).message).not.toContain("receipt");
  });

  it("🔴 accepts only a real invoice number", () => {
    expect(isInvoiceNumber(1)).toBe(true);
    expect(isInvoiceNumber(999999)).toBe(true);
    for (const bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, "7", {}, [], true, 2 ** 53]) {
      expect(isInvoiceNumber(bad), `${String(bad)} is not an invoice number`).toBe(false);
    }
  });

  it("🔴 a MISSING or malformed number is never invented, and never downgrades the outcome", () => {
    for (const lang of LANGUAGES) {
      for (const bad of [undefined, null, 0, -1, 1.5, NaN, "418", {}]) {
        const r = invoiceOutcomeError(lang, "finalized", { invoiceNumber: bad, receiptNumber: bad });
        // Still ISSUED — the sale row proved it. Not "unknown", not "not issued".
        expect(r.code).toBe("INVOICE_FINALIZED");
        expect(r.message).not.toMatch(/[0-9]/);
        expect(r.message).not.toContain("{");
        expect(r.message).not.toContain(String(bad));
        // The instruction that protects the merchant survives the missing number.
        expect(r.message).toContain(DO_NOT_REISSUE[lang]);
        expect(r.message).toContain(INVOICE_LIST[lang]);
      }
      // A receipt number with no invoice number must not print a half identity.
      const half = invoiceOutcomeError(lang, "finalized", { receiptNumber: 77 }).message;
      expect(half).not.toContain("77");
    }
  });

  it("🔴 the uncertain outcome says it is uncertain, and never claims nothing was recorded", () => {
    expect(invoiceOutcomeError("en", "unknown").message).toMatch(/not known whether/);
    expect(invoiceOutcomeError("en", "unknown").message).not.toMatch(/was not issued/);
    const ar = invoiceOutcomeError("ar", "unknown").message;
    expect(ar).toContain("لا نعرف");
    expect(ar).not.toContain("لم تُصدَر الفاتورة");
    for (const lang of LANGUAGES) {
      expect(invoiceOutcomeError(lang, "unknown").message).toContain(INVOICE_LIST[lang]);
    }
  });

  it("🔴 no sentence can carry a diagnostic, because none of them takes one", () => {
    for (const lang of LANGUAGES) {
      for (const kind of KINDS) {
        const text = invoiceOutcomeError(lang, kind, { invoiceNumber: 4, receiptNumber: 5 }).message;
        for (const leak of ["Error", "at ", ".ts", ".sqlite", "SQLITE", "SELECT", "INSERT", "C:\\", "/home/", "stack", "inv-"]) {
          expect(text, `${lang}:${kind} leaks ${leak}`).not.toContain(leak);
        }
        expect(text).not.toContain("undefined");
        expect(text).not.toContain("[object");
      }
    }
  });

  it("🔴 Arabic really is Arabic, English carries none, and no sentence is a bare key", () => {
    for (const kind of KINDS) {
      const ar = invoiceOutcomeError("ar", kind, { invoiceNumber: 3, receiptNumber: 4 }).message;
      const en = invoiceOutcomeError("en", kind, { invoiceNumber: 3, receiptNumber: 4 }).message;
      expect(ar).not.toBe(en);
      expect(ar, `ar:${kind}`).toMatch(/[\u0600-\u06FF]/);
      expect(en, `en:${kind}`).not.toMatch(/[\u0600-\u06FF]/);
      expect(ar).not.toMatch(/^outcome\./);
      expect(en).not.toMatch(/^outcome\./);
    }
  });

  it("🔴 it does not reword the SALE sentences — it names the invoice list, not History", () => {
    for (const lang of LANGUAGES) {
      for (const kind of KINDS) {
        const text = invoiceOutcomeError(lang, kind, { invoiceNumber: 1, receiptNumber: 1 }).message;
        if (lang === "en") expect(text).not.toContain("ring it up");
        else expect(text).not.toContain("لا تُعِد إدخالها");
      }
    }
  });
});
