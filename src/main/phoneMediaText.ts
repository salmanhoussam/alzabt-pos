/**
 * What the shop is told when the phone refuses a photo.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS AT ALL. The phone page is Arabic (`phonePage.ts` serves
 * `<html lang="ar" dir="rtl">`), and the bridge was handing it `err.message` verbatim — which is
 * written in English by `photoNormalize.ts`, because that module's messages are the developer-
 * facing record that also reaches logs and the desktop. So a merchant photographing a product with
 * an iPhone was told, in English, on an Arabic page:
 *
 *     "Choose a JPEG or PNG image (an iPhone HEIC photo must be saved as JPEG first)"
 *
 * 🔴 AND WHY THE TRANSLATION IS NOT IN `photoNormalize.ts`. That module decides what a valid photo
 * is. The language a refusal is said in is a property of the SCREEN that asked, not of the rule
 * that refused — the same refusal reaches a log, a desktop form and this phone page, and only one
 * of those three is Arabic. Mixing the two would also mean every new surface edits the decoder.
 *
 * 🔴 WHAT EACH MESSAGE HAS TO DO. Name the problem in a shop's words and say what to do next. The
 * old English prose explained an image-encoding format; a cashier holding a phone needs the next
 * action, which is why the unsupported-format case says to save the picture again from the phone
 * rather than naming the codec it arrived in.
 *
 * Nothing here names a file, a path, a token, a PIN, a byte count of the request, or any part of
 * the image — a refusal says what to do, never what the terminal knows.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PhotoRefusal } from "./photoNormalize";

/**
 * The limit in the too-large message is deliberately absent: the merchant cannot read a file's
 * size on a phone camera roll, so a number is not an action. "Take it again" is.
 */
const AR: Readonly<Record<PhotoRefusal, string>> = Object.freeze({
  PHOTO_EMPTY: "الملف فاضي. التقط الصورة من جديد.",
  PHOTO_TOO_MANY_BYTES: "الصورة كبيرة جداً. التقطها من جديد أو اختر صورة أصغر.",
  PHOTO_UNSUPPORTED_FORMAT: "هذه الصورة بصيغة لا يقبلها الصندوق. احفظها من الهاتف كصورة عادية وأعد المحاولة.",
  PHOTO_UNREADABLE: "ما قدرنا نقرأ هذه الصورة. التقط صورة جديدة وأعد المحاولة.",
  PHOTO_TOO_MANY_PIXELS: "الصورة كبيرة جداً. التقطها من جديد أو اختر صورة أصغر.",
  PHOTO_PREPARE_FAILED: "تعذّرت معالجة الصورة. التقط صورة جديدة وأعد المحاولة.",
});

/**
 * 🔴 THE FALLBACK IS THE POINT, NOT THE TAIL. A refusal this file has never heard of must still
 * reach the merchant in Arabic and must still tell them what to do — never the English sentence it
 * came with, and never a tag. A future refusal added to `photoNormalize.ts` without a line here is
 * therefore safe by construction: the shop reads this, not internals.
 */
const AR_FALLBACK = "تعذّر قبول هذه الصورة. التقط صورة جديدة وأعد المحاولة.";

/** The Arabic a merchant reads when a photo is refused. Never the raw message. */
export function phonePhotoRefusalText(reason: string | undefined): string {
  if (reason !== undefined && Object.prototype.hasOwnProperty.call(AR, reason)) {
    return AR[reason as PhotoRefusal];
  }
  return AR_FALLBACK;
}
