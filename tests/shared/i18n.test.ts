import { describe, expect, it } from "vitest";
import { BASE_UNITS } from "../../src/domain/catalog";
import { LANGUAGES, allKeys, dirFor, translate, unitLabel } from "../../src/shared/i18n";

describe("the i18n foundation", () => {
  it("🔴 every key exists in BOTH languages — a missing Arabic string is a missing text, not a default", () => {
    const missing: string[] = [];
    for (const key of allKeys()) {
      if (key === "products.colActions") continue; // deliberately empty in both: an actions column has no header
      for (const lang of LANGUAGES) {
        if (translate(lang, key) === key) missing.push(`${lang}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("returns the key itself for an unknown key, so a gap is visible rather than silent", () => {
    expect(translate("ar", "nope.missing")).toBe("nope.missing");
    expect(translate("en", "nope.missing")).toBe("nope.missing");
  });

  it("maps each language to its writing direction", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });

  it("every sellable unit has an Arabic and an English label", () => {
    expect(unitLabel("ar", "piece")).toBe("حبة");
    expect(unitLabel("ar", "kg")).toBe("كيلو");
    expect(unitLabel("en", "kg")).toBe("kg");
    for (const unit of BASE_UNITS) {
      expect(translate("ar", `unit.${unit}`), `ar:unit.${unit}`).not.toBe(`unit.${unit}`);
      expect(translate("en", `unit.${unit}`), `en:unit.${unit}`).not.toBe(`unit.${unit}`);
    }
  });

  it("an unknown unit from an older build is shown verbatim, never translated away", () => {
    expect(unitLabel("ar", "litre")).toBe("litre");
  });

  it("no displayed string carries Arabic-Indic digits — displays stay 0-9", () => {
    const offenders = allKeys()
      .flatMap((k) => LANGUAGES.map((l) => `${l}:${k}=${translate(l, k)}`))
      .filter((s) => /[٠-٩۰-۹]/.test(s));
    expect(offenders).toEqual([]);
  });

  it("the Arabic dictionary is really Arabic — not English text under an 'ar' key", () => {
    const suspicious = ["nav.sell", "nav.products", "action.save", "form.nameAr", "products.title"].filter(
      (k) => !/[؀-ۿ]/.test(translate("ar", k)),
    );
    expect(suspicious).toEqual([]);
  });
});
