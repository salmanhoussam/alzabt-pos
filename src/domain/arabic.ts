/**
 * Arabic text normalisation for SEARCH ONLY. Pure: no I/O, no state.
 *
 * 🔴 This NEVER touches stored data. A product's `name_ar` is stored exactly as the merchant wrote
 * it (migration 3 requires it non-empty and the import stores it verbatim); normalisation happens
 * on a COPY, at query time, on both the haystack and the needle. So "عَلَم" keeps its fatha on the
 * receipt and on the invoice, and still matches a search for "علم".
 *
 * The rules are the ones approved for this product, and the EXCLUSION is as deliberate as the
 * inclusions:
 *
 *   tashkeel        removed      َ ُ ِ ّ ْ ً ٌ ٍ ٰ and the Quranic marks above them
 *   tatweel         removed      ـ (U+0640), a typographic stretch, never part of a word
 *   أ إ آ ٱ    →   ا            merchants type any of them for the same word
 *   ى          →   ي            alef maqsura and yeh are interchangeable in practice
 *   ٠١٢…  ۰۱۲… →   0-9          Arabic-Indic and Extended Arabic-Indic digits
 *   A-Z        →   a-z          so an English name matches case-insensitively
 *   whitespace      collapsed    one space, trimmed
 *
 *   ة → ه          🔴 NOT APPLIED, ON PURPOSE. They are different letters that change meaning
 *                  (مكتبة a library vs مكتبه his desk). Folding them would make a search for one
 *                  product return the other, which is worse than a miss.
 */

/** Combining marks removed before matching: tashkeel, superscript alef, and the Quranic set. */
const TASHKEEL = /[ً-ْٰٓ-ٕٖ-ٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ALEF_FORMS = /[أإآٱ]/g; // أ إ آ ٱ
const ALEF_MAQSURA = /ى/g; // ى
const ARABIC_INDIC = /[٠-٩]/g; // ٠-٩
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g; // ۰-۹

/**
 * The search form of a string. Idempotent: normalizing an already-normalized string returns it
 * unchanged, which is what lets a cached haystack be compared against a freshly typed needle.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFC")
    .replace(TASHKEEL, "")
    .replace(TATWEEL, "")
    .replace(ALEF_FORMS, "ا")
    .replace(ALEF_MAQSURA, "ي")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when every whitespace-separated term of the query appears in at least one of the fields.
 * Terms are ANDed so "مفتاح احمر" finds a product named "مفتاح أحمر كبير"; fields are ORed so a term
 * may match the Arabic name while another matches the SKU.
 *
 * An empty or whitespace-only query matches everything — a search box that hides every row until
 * something is typed is a worse product than one that lists them.
 */
export function matchesSearch(fields: ReadonlyArray<string | null | undefined>, query: string): boolean {
  const needle = normalizeForSearch(query);
  if (needle === "") return true;
  const haystack = fields.filter((f): f is string => typeof f === "string" && f !== "").map(normalizeForSearch);
  return needle.split(" ").every((term) => haystack.some((field) => field.includes(term)));
}
