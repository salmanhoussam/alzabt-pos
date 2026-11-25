/**
 * K-3 (contract J0-CODEX-1 §C) — the demo refusal, in the operator's language.
 *
 * Main (Codex, X1 `demoPolicy.ts`) answers every channel the demo policy denies with
 * `{ code: "DEMO_RESTRICTED", message: "This operation is unavailable in demo mode." }`. That English
 * sentence IS the agreed English wording, so English mode shows main's message unchanged (the same
 * guarantee refusalText.ts gives). Arabic mode shows the agreed Arabic sentence below.
 *
 * 🔴 WHY THIS IS NOT AN ENTRY IN refusalText.ts's `AR` MAP. That map's own audit requires every mapped
 * code to be THROWN as a `DomainError` somewhere in src/ ("a typo would never fire"), and pins its
 * size. `DEMO_RESTRICTED` is not thrown — it is a frozen IPC result returned by the demo policy before
 * any handler runs — so adding it there would break that (Codex-owned) inventory test for a reason
 * that is not a defect. Keeping the demo sentence here leaves that file and its test untouched; the
 * wording is exactly the signed one. (Recorded for Codex's review in CLAUDE-G2-HANDOFF.md.)
 *
 * The sentence claims nothing beyond the refusal itself (rule E: no isolation promise).
 */
import type { Language } from "../shared/i18n";

export const DEMO_RESTRICTED_CODE = "DEMO_RESTRICTED";

/** The signed wording (J0-CODEX-1 §C). */
export const DEMO_RESTRICTED_TEXT: Readonly<Record<Language, string>> = Object.freeze({
  ar: "هذه العملية غير متاحة في وضع التجربة.",
  en: "This operation is unavailable in demo mode.",
});

/** Arabic for DEMO_RESTRICTED; `null` for any other code and in English (main's message stands). */
export function demoRefusal(lang: Language, code: string): string | null {
  if (code !== DEMO_RESTRICTED_CODE) return null;
  return lang === "ar" ? DEMO_RESTRICTED_TEXT.ar : null;
}
