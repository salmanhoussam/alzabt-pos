import { describe, expect, it } from "vitest";
import { matchesSearch, normalizeForSearch } from "../../src/domain/arabic";

describe("Arabic search normalisation", () => {
  it("removes tashkeel without touching the letters", () => {
    expect(normalizeForSearch("عَلَمٌ أَحْمَر")).toBe("علم احمر");
    expect(normalizeForSearch("مِفْتَاحْ")).toBe("مفتاح");
  });

  it("removes tatweel", () => {
    expect(normalizeForSearch("مفـــتاح")).toBe("مفتاح");
  });

  it("folds every alef form to ا", () => {
    for (const form of ["أحمر", "إحمر", "آحمر", "ٱحمر"]) {
      expect(normalizeForSearch(form)).toBe("احمر");
    }
  });

  it("folds alef maqsura to yeh", () => {
    expect(normalizeForSearch("مصطفى")).toBe("مصطفي");
    expect(normalizeForSearch("على")).toBe("علي");
  });

  it("reads Arabic-Indic and extended Arabic-Indic digits as 0-9", () => {
    expect(normalizeForSearch("مقاس ٥٠ سم")).toBe("مقاس 50 سم");
    expect(normalizeForSearch("۱۲۳")).toBe("123");
  });

  it("lowercases English and collapses whitespace", () => {
    expect(normalizeForSearch("  Red   WRENCH ")).toBe("red wrench");
  });

  it("is idempotent — normalising twice changes nothing", () => {
    const once = normalizeForSearch("عَلَمٌ أَحْمَر ٥٠");
    expect(normalizeForSearch(once)).toBe(once);
  });

  // 🔴 The approved exclusion, asserted as its own case so a future "tidy-up" that adds ة→ه fails
  // here rather than silently making one product findable under another's name.
  it("does NOT fold ة to ه — they are different letters that change the meaning", () => {
    expect(normalizeForSearch("مكتبة")).toBe("مكتبة");
    expect(normalizeForSearch("مكتبه")).toBe("مكتبه");
    expect(normalizeForSearch("مكتبة")).not.toBe(normalizeForSearch("مكتبه"));
  });
});

describe("matchesSearch", () => {
  const fields = ["مفتاح أحمر كبير", "Red Wrench", "SKU-001"];

  it("matches an Arabic name typed without the hamza", () => {
    expect(matchesSearch(fields, "مفتاح احمر")).toBe(true);
  });

  it("matches the English name case-insensitively", () => {
    expect(matchesSearch(fields, "red")).toBe(true);
  });

  it("matches the SKU", () => {
    expect(matchesSearch(fields, "sku-001")).toBe(true);
  });

  it("ANDs the terms — every term must appear somewhere", () => {
    expect(matchesSearch(fields, "مفتاح كبير")).toBe(true);
    expect(matchesSearch(fields, "مفتاح اصفر")).toBe(false);
  });

  it("allows a term to match one field while another matches a different field", () => {
    expect(matchesSearch(fields, "مفتاح wrench")).toBe(true);
  });

  it("an empty query matches everything — a search box must not hide the list", () => {
    expect(matchesSearch(fields, "")).toBe(true);
    expect(matchesSearch(fields, "   ")).toBe(true);
  });

  it("ignores absent optional fields instead of throwing", () => {
    expect(matchesSearch(["اسم", null, undefined], "اسم")).toBe(true);
    expect(matchesSearch([null, undefined], "اسم")).toBe(false);
  });
});
