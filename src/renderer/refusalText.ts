/**
 * Arabic for the desktop refusals whose meaning is UNAMBIGUOUS — and for no others.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE AUDIT THIS FILE IS THE RESULT OF. The product throws `DomainError` in **268** places under
 * 55 distinct codes, and a code does NOT identify a meaning. Measured:
 *
 *   INVALID_INPUT      93 sites · 51 distinct literal sentences + 29 templates
 *   NOT_AVAILABLE      22 sites · 18 distinct sentences, naming 18 different subsystems
 *   NOT_AUTHORIZED      6 sites · 4 genuinely different refusals (owner-only / may not add
 *                       products / a different operator opened this phone session / the code is
 *                       already open on another phone)
 *   INVOICE_NOT_FOUND   4 sites · "This invoice no longer exists" AND "The invoice line behind
 *                       this item is gone" — two different objects
 *   OPERATOR_NOT_FOUND  3 sites · someone else's account is gone AND *your* account is gone, with
 *                       two different next actions
 *
 * Mapping any of those to one Arabic sentence would state something the merchant cannot act on, or
 * state the wrong thing outright. They are therefore ABSENT from this file, and a test asserts they
 * stay absent.
 *
 * 🔴 THE ELIGIBILITY RULE, APPLIED MECHANICALLY. A code is in this map only when
 *   (a) every throw site means the SAME thing — proven by English already using one sentence for
 *       all of them, or sentences differing only by "This"/"That"; and
 *   (b) no message interpolates data — no name, count, SKU, unit, amount or duration.
 * (b) is what excludes `INVALID_CREDENTIALS` ("… 2 attempts left before a 5-minute lock") and
 * `CASHIER_LOCKED` ("… locked — try again in 3 minutes"): the number is the actionable part, the
 * IPC envelope is `{code, message}` and carries no structured data, and reading the number back out
 * of the English sentence is prose-matching. Those two are the strongest case for a future envelope
 * change, and they are left in English rather than localized into something less useful.
 *
 * 🔴 ARABIC ONLY, AND THAT IS A GUARANTEE RATHER THAN A SHORTCUT. English mode never consults this
 * map, so the English a merchant reads is byte-identical to what the main process sent — it cannot
 * regress, including for the codes above that use two slightly different English wordings.
 *
 * 🔴 AND IT MUST NEVER TOUCH A FINANCIAL OUTCOME. `INTERNAL`, `SALE_RECORDED`, `SALE_NOT_RECORDED`,
 * `SALE_STATUS_UNKNOWN`, `INVOICE_FINALIZED`, `INVOICE_NOT_FINALIZED` and `INVOICE_STATUS_UNKNOWN`
 * are already composed in Arabic by `saleOutcomeText.ts` / `invoiceOutcomeText.ts`, where the
 * receipt and invoice numbers actually live. Re-mapping them here would overwrite an accepted
 * safety message with a generic one and could turn "we do not know" into a definite answer. They
 * are absent, and `FORBIDDEN_CODES` plus its test keep them absent.
 *
 * Same shape as `phoneMediaText.ts`: the Arabic lives beside the boundary that shows it, not in the
 * logic that raises the error, and not in the shared dictionary (whose parity rule would have
 * forced an English entry and so a rewritten English sentence).
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { Language } from "../shared/i18n";

/**
 * The codes this map may NEVER contain: each one's Arabic is already composed where the structured
 * facts are, and each one carries a financial outcome.
 */
export const FORBIDDEN_CODES: readonly string[] = Object.freeze([
  "INTERNAL",
  "SALE_RECORDED",
  "SALE_NOT_RECORDED",
  "SALE_STATUS_UNKNOWN",
  "INVOICE_FINALIZED",
  "INVOICE_NOT_FINALIZED",
  "INVOICE_STATUS_UNKNOWN",
]);

/**
 * 18 codes. Each line's English original is quoted so a reviewer can check the Arabic against what
 * it replaces without opening three other files.
 */
const AR: Readonly<Record<string, string>> = Object.freeze({
  // "That product no longer exists" / "This product no longer exists" — 10 sites, one meaning.
  PRODUCT_NOT_FOUND: "هذا الصنف لم يبقَ موجوداً.",
  // "That category no longer exists" — 4 sites, one sentence.
  CATEGORY_NOT_FOUND: "هذه الفئة لم تبقَ موجودة.",
  // "Sign in first" / "A cashier must be logged in" — two wordings, one meaning and one action.
  NOT_LOGGED_IN: "سجّل الدخول أوّلاً.",
  // "This account has been deactivated — sign in again"
  OPERATOR_INACTIVE: "هذا الحساب مُعطَّل. سجّل الدخول من جديد.",
  // "This sale is already voided"
  ALREADY_VOIDED: "هذه الفاتورة مُلغاة أصلاً.",
  // "Sale not found"
  SALE_NOT_FOUND: "لم نجد هذه الفاتورة.",
  // "That photo is no longer stored"
  IMAGE_NOT_FOUND: "هذه الصورة لم تبقَ محفوظة.",
  // "The cart is empty"
  EMPTY_CART: "السلّة فارغة.",
  // "The displayed total no longer matches the catalog; please review the cart"
  TOTAL_MISMATCH: "الإجمالي المعروض لم يبقَ مطابقاً للأسعار. راجع السلّة.",
  // "Only sales from the current business day can be voided"
  VOID_NOT_ALLOWED: "لا يمكن إلغاء إلّا فواتير يوم العمل الحالي.",
  // "This sale comes from a finalized invoice. Invoice cancellation / credit-note workflow is not
  //  implemented yet."
  VOID_NOT_ALLOWED_FOR_INVOICE: "هذه المبيعة أتت من فاتورة صادرة، وإلغاء الفواتير غير متاح بعد.",
  // "An invoice needs at least one line"
  INVOICE_NOT_FINALIZABLE: "الفاتورة تحتاج سطراً واحداً على الأقل.",
  // "The invoice numbering cannot be changed once an invoice has been issued"
  INVOICE_NUMBERING_LOCKED: "لا يمكن تغيير ترقيم الفواتير بعد إصدار أوّل فاتورة.",
  // "This review item no longer exists"
  RECONCILIATION_NOT_FOUND: "هذا البند لم يبقَ في قائمة المراجعة.",
  // "An operator cannot change their own role"
  SELF_ROLE_CHANGE: "لا يمكن للمستخدم تغيير دوره بنفسه.",
  // "An operator cannot change their own permissions"
  SELF_PERMISSION_CHANGE: "لا يمكن للمستخدم تغيير صلاحياته بنفسه.",
  // "This account has already been set up"
  SETUP_NOT_REQUIRED: "هذا الحساب مُهيَّأ أصلاً.",
  // "Save the shop's own details first" / "… before issuing an invoice" — one action either way.
  COMPANY_PROFILE_REQUIRED: "احفظ بيانات المتجر أوّلاً.",
});

/** Every code this map answers for. Exported so a test can enumerate it rather than restate it. */
export const MAPPED_CODES: readonly string[] = Object.freeze(Object.keys(AR));

/**
 * The Arabic sentence for a code, or `null` when there is none — and `null` is the common case on
 * purpose. A caller that gets `null` must show what the main process sent.
 */
export function arabicRefusal(lang: Language, code: string): string | null {
  if (lang !== "ar") return null;
  // A forbidden code can never be answered here even if someone adds it to the map by mistake.
  if (FORBIDDEN_CODES.includes(code)) return null;
  // 🔴 `Object.hasOwn`, NOT `AR[code]`. A plain object literal inherits from `Object.prototype`, so
  // `AR["toString"]` returns a FUNCTION and `AR["constructor"]` returns a constructor — and the
  // error code is a string that arrives over the IPC bridge from the renderer's own untrusted side.
  // The first version of this function used `AR[code] ?? null` and the test for a code named
  // "toString" caught it. An own-property check closes the whole class, not just that one name.
  return Object.hasOwn(AR, code) ? (AR[code] ?? null) : null;
}
