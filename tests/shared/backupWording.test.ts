/**
 * The merchant must be able to tell a PRICE LIST from a BACKUP by reading the screen.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY COPY IS WORTH A TEST FILE. Three artifacts exist and only one of them is a backup:
 *
 *   legacy CSV           merchant-csv-origin ACTIVE rows, 7 columns. No manual products, no
 *                        photos, no sales, no invoices.
 *   database backup      every table in the ledger, including photo BLOBs — but NOT the frozen
 *                        invoice-logo files, which live outside the .sqlite file.
 *   full cold copy       the whole userData folder with the application CLOSED. The only complete
 *                        one, and deliberately not a button: WAL mode makes a live copy unsafe.
 *
 * The old labels were "تصدير الأصناف" / "Export catalog" and "تصدير نسخة احتياطيّة" / "Export
 * backup". A merchant reading the first as "my products are saved" can lose every hand-typed
 * product and every photo while believing otherwise — and the second promises more than it
 * delivers. That is a data-safety defect expressed in words, so it is fixed in words and held by
 * assertions on the words.
 *
 * These assertions test MEANING, not phrasing: each one names the fact the sentence must carry.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { LANGUAGES, translate } from "../../src/shared/i18n";

const KEYS = [
  "tools.exportCatalog",
  "tools.catalogNote",
  "tools.catalogNotBackup",
  "tools.exportBackup",
  "tools.backupNote",
  "tools.backupExcludes",
  "tools.coldCopyNote",
  "tools.noticeTag",
] as const;

describe("the backup / export distinction a merchant reads", () => {
  it("every key of this slice exists in BOTH languages", () => {
    const missing = KEYS.flatMap((k) => LANGUAGES.filter((l) => translate(l, k) === k).map((l) => `${l}:${k}`));
    expect(missing).toEqual([]);
  });

  it("🔴 the CSV button says PRICE LIST and says CSV — it no longer says 'export the products'", () => {
    const ar = translate("ar", "tools.exportCatalog");
    const en = translate("en", "tools.exportCatalog");
    expect(ar).toContain("قائمة الأسعار");
    expect(ar).toContain("CSV");
    expect(en.toLowerCase()).toContain("price list");
    expect(en).toContain("CSV");
    // The old label, in both languages, must be gone.
    expect(ar).not.toBe("تصدير الأصناف");
    expect(en).not.toBe("Export catalog");
  });

  it("🔴 the CSV note states it is NOT a backup, and names what it leaves out", () => {
    const ar = translate("ar", "tools.catalogNotBackup");
    const en = translate("en", "tools.catalogNotBackup");
    expect(ar).toContain("ليس نسخة احتياطيّة");
    expect(ar).toContain("يدويّاً"); // manually added products
    expect(ar).toContain("الصور"); // photos
    expect(en.toLowerCase()).toContain("not a backup");
    expect(en.toLowerCase()).toContain("manually added");
    expect(en.toLowerCase()).toContain("photos");
  });

  it("🔴 the backup button says DATABASE, so it does not promise the whole shop", () => {
    expect(translate("ar", "tools.exportBackup")).toContain("قاعدة البيانات");
    expect(translate("en", "tools.exportBackup").toLowerCase()).toContain("database");
    expect(translate("ar", "tools.exportBackup")).not.toBe("تصدير نسخة احتياطيّة");
    expect(translate("en", "tools.exportBackup")).not.toBe("Export backup");
  });

  it("🔴 the backup note names the ONE thing it excludes: the archived invoice logo", () => {
    const ar = translate("ar", "tools.backupExcludes");
    const en = translate("en", "tools.backupExcludes");
    expect(ar).toContain("شعار الفواتير");
    expect(ar).toContain("خارج قاعدة البيانات");
    expect(en.toLowerCase()).toContain("invoice-logo");
    expect(en.toLowerCase()).toContain("outside the database");
  });

  it("and it states what it DOES contain, so the exclusion is not read as 'it has nothing'", () => {
    const ar = translate("ar", "tools.backupNote");
    const en = translate("en", "tools.backupNote");
    expect(ar).toContain("المبيعات");
    expect(ar).toContain("الفواتير");
    expect(ar).toContain("صور الأصناف");
    expect(en.toLowerCase()).toContain("every sale");
    expect(en.toLowerCase()).toContain("invoice");
    expect(en.toLowerCase()).toContain("product photo");
  });

  it("🔴 the third artifact is described: close the program, copy the whole folder", () => {
    const ar = translate("ar", "tools.coldCopyNote");
    const en = translate("en", "tools.coldCopyNote");
    expect(ar).toContain("أغلق البرنامج");
    expect(ar).toContain("انسخ");
    expect(ar).toContain("شعار الفواتير"); // it is the copy that DOES include it
    expect(en.toLowerCase()).toContain("close the program");
    expect(en.toLowerCase()).toContain("copy");
    expect(en.toLowerCase()).toContain("archived invoice logo");
  });

  it("the three artifacts are described by three DIFFERENT sentences, in both languages", () => {
    for (const lang of LANGUAGES) {
      const three = [
        translate(lang, "tools.catalogNotBackup"),
        translate(lang, "tools.backupExcludes"),
        translate(lang, "tools.coldCopyNote"),
      ];
      expect(new Set(three).size, `${lang}: one sentence reused for two artifacts`).toBe(3);
    }
  });

  it("the Arabic strings are really Arabic, not English under an 'ar' key", () => {
    const notArabic = KEYS.filter((k) => !/[؀-ۿ]/.test(translate("ar", k)));
    expect(notArabic).toEqual([]);
  });

  it("the invoice-logo warning exists in both languages and promises no data change", () => {
    const ar = translate("ar", "inv.sheet.logoMissing");
    const en = translate("en", "inv.sheet.logoMissing");
    expect(ar).toContain("غير موجود");
    // 🔴 It must say the current logo was NOT substituted — that is the whole reassurance.
    expect(ar).toContain("لم يُستبدل");
    expect(ar).toContain("لم تتغيّر");
    expect(en.toLowerCase()).toContain("missing");
    expect(en.toLowerCase()).toContain("not substituted");
    expect(en.toLowerCase()).toContain("unchanged");
  });
});
