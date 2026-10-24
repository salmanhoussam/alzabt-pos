/**
 * What a cashier reads when a sale ends in an unexpected error — in the shop's own language.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS LIVES IN MAIN AND NOT IN THE RENDERER.
 *
 * The approved slice asked for a renderer-side map keyed on the error code. Three of these five
 * sentences would work that way. The fourth cannot, and the reason is structural rather than a
 * matter of taste:
 *
 *   `IpcError` is `{ code, message }` (src/shared/ipcContract.ts). It carries NO receipt number,
 *   `SaleDto` carries no idempotency key, and no preload method looks a sale up by one. So a
 *   renderer asked to say "the sale WAS recorded (receipt #7)" in Arabic has exactly two ways to
 *   get the 7: parse it out of the English prose, or have the envelope grow a field. The first is
 *   forbidden outright — reading a transaction outcome out of a human sentence is how a cashier
 *   ends up being told a number that was never in the ledger. The second changes the IPC contract.
 *
 * Main has the number as a real `number`, straight off the row it just read back, and it already
 * holds the operator's language (`options.settings.get()`, wired long before this slice). So the
 * truthful sentence can be composed where both facts are already true, with no new contract, no
 * new preload method and no prose ever parsed.
 *
 * 🔴 AND A CODE→TEXT MAP WOULD HAVE COLLAPSED A DISTINCTION THAT MATTERS. `SALE_NOT_RECORDED`
 * carries TWO different sentences: one for a request with no idempotency key (nothing can be looked
 * up, so no retry is offered) and one where the ledger was read and genuinely has no such sale (a
 * retry is explicitly safe). Keyed on the code alone, those become one message, and the cashier
 * loses the only thing that tells them whether pressing the button again is safe.
 *
 * 🔴 THE CODE AND THE TEXT ARE RETURNED TOGETHER, by one function, so they cannot drift. A later
 * edit that changes the wording cannot quietly leave it under the wrong code.
 *
 * 🔴 NOTHING FROM THE THROWN ERROR REACHES HERE. This module takes a language, an outcome kind and
 * at most a receipt number — there is no parameter through which a stack, a path, a SQL fragment or
 * a token could be interpolated into a merchant-facing sentence.
 *
 * This is the same shape as `phoneMediaText.ts`: the logic stays language-free and the text is
 * chosen once, at the presentation boundary.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { type Language, translate } from "../shared/i18n";

/**
 * The five things that can truthfully be said. The two `not_recorded*` kinds share one code on
 * purpose — the code is the machine's answer, the kind is what the cashier needs.
 */
export type SaleOutcomeKind =
  /** Any channel, any unexpected fault. Says nothing about sales. */
  | "internal"
  /** No idempotency key, so the ledger cannot be asked. No retry is offered. */
  | "not_recorded"
  /** The ledger was read and has no such sale. A retry is safe and is offered. */
  | "not_recorded_retry"
  /** The ledger HAS the sale. Never invites a retry. */
  | "recorded"
  /** Even the lookup failed. The honest answer is "unknown". */
  | "unknown";

const CODE: Readonly<Record<SaleOutcomeKind, string>> = Object.freeze({
  internal: "INTERNAL",
  not_recorded: "SALE_NOT_RECORDED",
  not_recorded_retry: "SALE_NOT_RECORDED",
  recorded: "SALE_RECORDED",
  unknown: "SALE_STATUS_UNKNOWN",
});

const KEY: Readonly<Record<SaleOutcomeKind, string>> = Object.freeze({
  internal: "outcome.internal",
  not_recorded: "outcome.saleNotRecorded",
  not_recorded_retry: "outcome.saleNotRecordedRetry",
  recorded: "outcome.saleRecorded",
  unknown: "outcome.saleStatusUnknown",
});

/**
 * A receipt number is printed only when it really is one.
 *
 * 🔴 A RECEIPT NUMBER IS NEVER INVENTED, NEVER DEFAULTED AND NEVER COERCED. `undefined`, `null`,
 * `0`, `-1`, `1.5`, `NaN`, `"7"` and an object all fail this — and the caller then gets the
 * recorded wording WITHOUT a number, which is still true and still carries the do-not-repeat
 * instruction. Falling back to "unknown" would be worse than useless: it would downgrade a sale we
 * KNOW is in the ledger to one we are unsure about, and invite exactly the second charge this
 * whole message exists to prevent.
 */
export function isReceiptNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The code and the sentence, together, in the operator's language. */
export function saleOutcomeError(
  lang: Language,
  kind: SaleOutcomeKind,
  receiptNumber?: unknown,
): { readonly code: string; readonly message: string } {
  if (kind === "recorded") {
    return isReceiptNumber(receiptNumber)
      ? {
          code: CODE.recorded,
          // Digits stay 0-9 in both languages — the standing i18n rule.
          message: translate(lang, KEY.recorded).replace("{receipt}", String(receiptNumber)),
        }
      : { code: CODE.recorded, message: translate(lang, "outcome.saleRecordedNoNumber") };
  }
  return { code: CODE[kind], message: translate(lang, KEY[kind]) };
}
