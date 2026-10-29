/**
 * What an OWNER reads when recording a customer payment ends in an unexpected error — in the
 * shop's own language.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE ONLY QUESTION THAT MATTERS AFTER A FAILED COLLECTION IS "DID THE MONEY GO IN?", and the
 * one honest way to answer it is to ASK THE LEDGER by the idempotency key the caller sent. Not to
 * guess from the exception — an error thrown after the commit looks identical to one thrown before
 * it. A shop told "the payment was not recorded" when it WAS will collect the same debt twice, and
 * the customer has no way to prove otherwise.
 *
 * 🔴 THIS IS DELIBERATELY `saleOutcomeText.ts`'s SHAPE, NOT A NEW IDEA. That module already
 * established the five truthful answers for a sale; a collection has exactly the same structure,
 * so it gets the same one rather than a second, subtly different vocabulary. The one real
 * difference: a settlement has no receipt number to print, so the recorded wording carries the
 * amount it recorded instead — read off the row, never parsed back out of a sentence.
 *
 * 🔴 `not_recorded` AND `not_recorded_retry` SHARE ONE CODE AND SAY DIFFERENT THINGS, for the same
 * reason they do for sales: without a key the ledger cannot be asked, so no retry is offered; with
 * a key that the ledger answered for, a retry is explicitly safe. Collapsed into one message the
 * owner loses the only fact that decides whether pressing the button again takes the money twice.
 *
 * 🔴 NOTHING FROM THE THROWN ERROR REACHES HERE. A language, an outcome kind and at most an
 * already-formatted amount — no stack, no path, no SQL fragment can be interpolated into a
 * merchant-facing sentence.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { type Language, translate } from "../shared/i18n";

/** The five things that can truthfully be said about a collection attempt. */
export type PaymentOutcomeKind =
  /** An unexpected fault that says nothing at all about payments. */
  | "internal"
  /** No idempotency key, so the ledger cannot be asked. No retry is offered. */
  | "not_recorded"
  /** The ledger was read and holds no such payment. A retry is safe and is offered. */
  | "not_recorded_retry"
  /** The ledger HAS the payment. Never invites a retry. */
  | "recorded"
  /** Even the lookup failed. The honest answer is "unknown" — and it says: do not collect again. */
  | "unknown";

const CODE: Readonly<Record<PaymentOutcomeKind, string>> = Object.freeze({
  internal: "INTERNAL",
  not_recorded: "PAYMENT_NOT_RECORDED",
  not_recorded_retry: "PAYMENT_NOT_RECORDED",
  recorded: "PAYMENT_RECORDED",
  unknown: "PAYMENT_STATUS_UNKNOWN",
});

const KEY: Readonly<Record<PaymentOutcomeKind, string>> = Object.freeze({
  internal: "outcome.internal",
  not_recorded: "outcome.paymentNotRecorded",
  not_recorded_retry: "outcome.paymentNotRecordedRetry",
  recorded: "outcome.paymentRecorded",
  unknown: "outcome.paymentStatusUnknown",
});

/**
 * An amount is printed only when it really is one.
 *
 * 🔴 NEVER INVENTED, NEVER DEFAULTED, NEVER COERCED. An empty string, a number, null and an object
 * all fail this, and the caller then gets the recorded wording WITHOUT a figure — still true, and
 * still carrying the do-not-collect-again instruction. Falling back to "unknown" would be worse
 * than useless: it would downgrade a payment we KNOW is in the ledger to one we are unsure about,
 * and invite exactly the second collection this message exists to prevent.
 */
export function isPrintableAmount(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 40;
}

/** The code and the sentence, together, in the operator's language. */
export function paymentOutcomeError(
  lang: Language,
  kind: PaymentOutcomeKind,
  amountText?: unknown,
): { readonly code: string; readonly message: string } {
  if (kind === "recorded") {
    return isPrintableAmount(amountText)
      ? {
          code: CODE.recorded,
          // Digits stay 0-9 in both languages — the standing i18n rule.
          message: translate(lang, KEY.recorded).replace("{amount}", amountText),
        }
      : { code: CODE.recorded, message: translate(lang, "outcome.paymentRecordedNoAmount") };
  }
  return { code: CODE[kind], message: translate(lang, KEY[kind]) };
}
