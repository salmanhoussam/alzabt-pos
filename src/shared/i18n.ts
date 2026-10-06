/**
 * The i18n / RTL foundation — the shared half (no React, no Electron, so main and renderer and the
 * tests all use the same one).
 *
 * TWO LANGUAGES, KEPT SEPARATE, which is an approved decision and not an implementation detail:
 *   terminalLanguage   what the OPERATOR reads — menus, forms, errors
 *   receiptLanguage    what the CUSTOMER reads — the receipt and, later, the A4 invoice
 * A shop may well want an Arabic till and an English receipt, or the reverse, so one setting could
 * never stand for both.
 *
 * DIGITS STAY 0-9 in every display, in both languages — approved, and the reason Arabic-Indic
 * digits are normalised on INPUT (src/domain/arabic.ts) but never produced on output.
 *
 * STANDING RULE: a new screen is bilingual on its first commit. A key with no Arabic is a missing
 * text, not a neutral default, so `t()` returns the key itself when a string is absent — loudly
 * visible in review instead of silently falling back to English.
 */
export const LANGUAGES = ["ar", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_TERMINAL_LANGUAGE: Language = "ar";
export const DEFAULT_RECEIPT_LANGUAGE: Language = "ar";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as ReadonlyArray<string>).includes(value);
}

export function dirFor(lang: Language): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

/** Operator-facing settings. Persisted outside the ledger — see src/main/settingsStore.ts. */
export interface TerminalSettings {
  readonly terminalLanguage: Language;
  readonly receiptLanguage: Language;
}

export const DEFAULT_SETTINGS: TerminalSettings = Object.freeze({
  terminalLanguage: DEFAULT_TERMINAL_LANGUAGE,
  receiptLanguage: DEFAULT_RECEIPT_LANGUAGE,
});

type Dict = Readonly<Record<string, string>>;

/** Arabic first, because Arabic is the default and a missing Arabic string must be obvious. */
const AR: Dict = {
  "app.name": "صندوق الزبط",
  "nav.sell": "بيع",
  "nav.today": "مبيعات اليوم",
  "nav.history": "السجل",
  "nav.products": "الأصناف",
  "nav.tools": "أدوات",
  "action.logout": "خروج",
  "action.save": "حفظ",
  "action.cancel": "إلغاء",
  "action.ok": "حسناً",
  "action.add": "إضافة صنف",
  "action.edit": "تعديل",
  "action.activate": "تفعيل",
  "action.deactivate": "إيقاف",
  "lang.toggle": "English",
  "products.title": "الأصناف",
  "products.search": "ابحث بالاسم أو الرمز",
  "products.searchHint": "البحث يتجاهل التشكيل والتطويل، ويوحّد أ إ آ مع ا، و ى مع ي، والأرقام العربية مع 0-9.",
  "products.count": "صنفاً",
  "products.countShown": "معروض",
  "products.empty": "لا أصناف بعد. أضف أوّل صنف.",
  "products.noMatch": "لا نتائج لهذا البحث.",
  "products.colName": "الاسم",
  "products.colSku": "الرمز",
  "products.colPrice": "السعر",
  "products.colUnit": "الوحدة",
  "products.colState": "الحالة",
  "products.colActions": "",
  "products.active": "مفعَّل",
  "products.inactive": "موقوف",
  "products.priceNeedsReview": "السعر للمراجعة",
  "products.source.manual": "يدوي",
  "products.source.import": "مستورد",
  "products.wholeUnitsOnly": "تُباع بوحداتٍ كاملةٍ فقط حتى الآن — الكمّيّات الكسريّة مهمّةٌ منفصلة.",
  "form.addTitle": "صنف جديد",
  "form.editTitle": "تعديل صنف",
  "form.nameAr": "الاسم بالعربية",
  "form.nameArRequired": "الاسم بالعربية مطلوب",
  "form.nameEn": "الاسم بالإنجليزية (اختياري)",
  "form.sku": "الرمز SKU (اختياري)",
  "form.price": "سعر البيع",
  "form.unit": "الوحدة",
  "form.required": "مطلوب",
  "form.optional": "اختياري",
  "form.state": "الحالة",
  "unit.piece": "حبة",
  "unit.box": "علبة",
  "unit.pack": "كيس",
  "unit.kg": "كيلو",
  "unit.meter": "متر",
  "unit.other": "أخرى",
  "msg.created": "تمّت إضافة الصنف.",
  "msg.updated": "تمّ حفظ التعديل.",
  "msg.deactivated": "أُوقف الصنف. لا يظهر في البيع، ولم يُحذف.",
  "msg.activated": "أُعيد تفعيل الصنف.",
  "msg.historyUntouched": "تعديلُ السعر لا يغيّر أيَّ فاتورةٍ سابقة.",
  "err.title": "لم يُحفظ",
};

const EN: Dict = {
  "app.name": "Alzabt POS",
  "nav.sell": "Sell",
  "nav.today": "Today's Sales",
  "nav.history": "History",
  "nav.products": "Products",
  "nav.tools": "Tools",
  "action.logout": "Log out",
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.ok": "OK",
  "action.add": "Add product",
  "action.edit": "Edit",
  "action.activate": "Activate",
  "action.deactivate": "Deactivate",
  "lang.toggle": "العربية",
  "products.title": "Products",
  "products.search": "Search by name or SKU",
  "products.searchHint": "Search ignores tashkeel and tatweel, folds أ إ آ to ا and ى to ي, and reads Arabic-Indic digits as 0-9.",
  "products.count": "products",
  "products.countShown": "shown",
  "products.empty": "No products yet. Add the first one.",
  "products.noMatch": "Nothing matches this search.",
  "products.colName": "Name",
  "products.colSku": "SKU",
  "products.colPrice": "Price",
  "products.colUnit": "Unit",
  "products.colState": "State",
  "products.colActions": "",
  "products.active": "Active",
  "products.inactive": "Inactive",
  "products.priceNeedsReview": "price?",
  "products.source.manual": "manual",
  "products.source.import": "imported",
  "products.wholeUnitsOnly": "Sold in whole units for now — fractional quantities are a separate task.",
  "form.addTitle": "New product",
  "form.editTitle": "Edit product",
  "form.nameAr": "Arabic name",
  "form.nameArRequired": "An Arabic name is required",
  "form.nameEn": "English name (optional)",
  "form.sku": "SKU (optional)",
  "form.price": "Selling price",
  "form.unit": "Unit",
  "form.required": "required",
  "form.optional": "optional",
  "form.state": "State",
  "unit.piece": "piece",
  "unit.box": "box",
  "unit.pack": "pack",
  "unit.kg": "kg",
  "unit.meter": "meter",
  "unit.other": "other",
  "msg.created": "Product added.",
  "msg.updated": "Changes saved.",
  "msg.deactivated": "Product deactivated. It is hidden from selling and was not deleted.",
  "msg.activated": "Product activated again.",
  "msg.historyUntouched": "A price change never alters an earlier invoice.",
  "err.title": "Not saved",
};

const DICTS: Readonly<Record<Language, Dict>> = Object.freeze({ ar: AR, en: EN });

/** Every key either language defines — used by the test that proves the two stay in step. */
export function allKeys(): string[] {
  return [...new Set([...Object.keys(AR), ...Object.keys(EN)])].sort();
}

/** Looks a string up. A missing key returns the key itself, on purpose: silence is a missing text. */
export function translate(lang: Language, key: string): string {
  return DICTS[lang][key] ?? key;
}

/** The operator-facing label for a unit, in the terminal language. */
export function unitLabel(lang: Language, baseUnit: string): string {
  const key = `unit.${baseUnit}`;
  const label = DICTS[lang][key];
  // An unknown unit (a legacy row from an older build) is shown verbatim, never translated away.
  return label ?? baseUnit;
}
