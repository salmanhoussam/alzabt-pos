/**
 * R2 · What a shop is TOLD when the phone refuses a photo.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THESE TESTS PIN. The bridge forwarded `err.message` straight to the phone, and
 * those messages are written in English by `photoNormalize.ts` — so an Arabic page told a merchant
 * "Choose a JPEG or PNG image (an iPhone HEIC photo must be saved as JPEG first)". Nothing was
 * broken; the shop simply could not read it.
 *
 * 🔴 AND THE RULE THAT REPLACED IT, stated as a test rather than a convention: a merchant-facing
 * media message carries NO Latin letters, because every one of them in this path would be a leak
 * of the developer-facing sentence. That is a stronger check than comparing to a fixed string —
 * it fails for an English message nobody has written yet.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { phonePhotoRefusalText } from "../../src/main/phoneMediaText";
import type { PhotoRefusal } from "../../src/main/photoNormalize";
import { renderPhoneFormPage } from "../../src/main/phonePage";
import { translate } from "../../src/shared/i18n";
import type { PhoneFormData } from "../../src/application/posService";

const REFUSALS: readonly PhotoRefusal[] = [
  "PHOTO_EMPTY",
  "PHOTO_TOO_MANY_BYTES",
  "PHOTO_UNSUPPORTED_FORMAT",
  "PHOTO_UNREADABLE",
  "PHOTO_TOO_MANY_PIXELS",
  "PHOTO_PREPARE_FAILED",
];

/** Latin letters at all — the signature of a developer-facing sentence reaching a merchant. */
const hasLatin = (s: string) => /[A-Za-z]/.test(s);
const hasArabic = (s: string) => /[\u0600-\u06ff]/.test(s);

describe("every photo refusal reaches the shop in Arabic", () => {
  for (const reason of REFUSALS) {
    it(`${reason} is said in Arabic, with no English left in it`, () => {
      const text = phonePhotoRefusalText(reason);
      expect(text.length).toBeGreaterThan(0);
      expect(hasArabic(text)).toBe(true);
      expect(hasLatin(text), text).toBe(false);
      // 🔴 AND IT IS NOT THE TAG. A mapping that fell through to its own key would satisfy
      // "non-empty" and tell the merchant nothing.
      expect(text).not.toContain(reason);
    });
  }

  it("🔴 each refusal says what to DO, not only what went wrong", () => {
    // Every message ends on an instruction — the merchant is holding a phone, mid-task.
    for (const reason of REFUSALS) {
      const text = phonePhotoRefusalText(reason);
      expect(/التقط|احفظ|اختر|أعد/u.test(text), `${reason}: ${text}`).toBe(true);
    }
  });
});

describe("🔴 an unknown refusal is still safe", () => {
  for (const [label, input] of [
    ["a tag nobody has mapped yet", "PHOTO_SOMETHING_NEW"],
    ["no tag at all", undefined],
    ["a path-shaped value", "C:/Users/merchant/AppData/ledger.sqlite"],
    ["a token-shaped value", "b".repeat(64)],
    ["base64-shaped bytes", "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ"],
  ] as const) {
    it(`${label} falls back to Arabic and echoes nothing`, () => {
      const text = phonePhotoRefusalText(input);
      expect(hasArabic(text)).toBe(true);
      expect(hasLatin(text), text).toBe(false);
      if (input !== undefined) expect(text).not.toContain(input);
      expect(text).not.toContain("base64");
      expect(text).not.toContain("sqlite");
    });
  }
});

const FORM: PhoneFormData = {
  action: "NEW_PRODUCT",
  units: ["piece", "kg"],
  currency: "USD",
  categories: [{ id: "c1", nameAr: "أدوات", nameEn: "Tools", isActive: true }],
  brands: ["Stanley"],
  product: null,
  master: { categoryId: "", barcode: "", brand: "", descriptionAr: "", descriptionEn: "", isOnlineVisible: false },
};

describe("R2-A · the merchant-facing photo copy explains nothing technical", () => {
  it("the phone page no longer teaches image encoding", () => {
    // 🔴 WHAT THE MERCHANT CAN READ, NOT THE FILE. The first version of this check searched the
    // whole served document and failed on a developer comment inside the page's own <script> —
    // true, and about nobody's experience. Copy is what renders, so the script, the styles and
    // the HTML comments come out before the question is asked.
    const visible = renderPhoneFormPage(FORM)
      .replace(/<script>[\s\S]*?<\/script>/g, "")
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    for (const jargon of ["HEIC", "heic", "آيفون", "iPhone", "codec"]) {
      expect(visible, `the phone page still shows a shop the word ${jargon}`).not.toContain(jargon);
    }
    // And the hint that remains is still THERE — removing the jargon must not remove the guidance.
    expect(visible).toContain("صورة واضحة للصنف");
  });

  it("the desktop hint keeps the REAL limit and drops the explanation", () => {
    for (const lang of ["ar", "en"] as const) {
      const hint = translate(lang, "form.photoFormats");
      expect(hint.length).toBeGreaterThan(0);
      // The limit itself is real and stays — a shop that picks a WEBP needs to know what works.
      expect(hint).toContain("JPEG");
      expect(hint).toContain("PNG");
      // What goes is the exposition about one phone's encoding.
      for (const jargon of ["HEIC", "آيفون", "iPhone"]) {
        expect(hint, `${lang}: ${hint}`).not.toContain(jargon);
      }
    }
  });

  it("🔴 English is still English and Arabic is still Arabic", () => {
    expect(hasArabic(translate("ar", "form.photoFormats"))).toBe(true);
    const en = translate("en", "form.photoFormats");
    expect(hasLatin(en)).toBe(true);
    expect(hasArabic(en)).toBe(false);
  });
});
