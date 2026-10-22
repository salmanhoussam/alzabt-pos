/**
 * What a cashier reads when ISSUING a manual invoice ends in an unexpected error.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT `saleOutcomeText.ts` WITH DIFFERENT WORDS.
 *
 * Finalizing an invoice does two things in one transaction: it issues a numbered commercial
 * document, and it writes the sale that document IS (`invoiceService.createSaleForInvoice`). The
 * thing a cashier must not do twice is ISSUE THE INVOICE. So the instruction has to name the
 * invoice list, and the identity that matters first is the INVOICE NUMBER — the number printed on
 * the paper in their hand — with the receipt number as secondary detail.
 *
 * Reusing `SALE_RECORDED` here would have been cheaper and wrong in a way that costs the merchant
 * real time: it sends them to the sales History looking for a receipt number, when what they need
 * to check is whether invoice #418 exists. The APPROACH from the sale slice is reused exactly — a
 * pure composer at the presentation boundary, code and text returned together, no Arabic in the
 * logic. The CODES are new, because the meanings are new.
 *
 * 🔴 NEW CODES COST NOTHING. `IpcError.code` is `string` (src/shared/ipcContract.ts:591), not a
 * union, and no caller in the renderer branches on these values — `errorText` renders `message`.
 * So three new codes need no contract change, no preload method and no migration.
 *
 * 🔴 NOTHING FROM THE THROWN ERROR REACHES HERE. The parameters are a language, an outcome kind and
 * at most two numbers, so no stack, path, SQL fragment or id can be interpolated into a
 * merchant-facing sentence.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { type Language, translate } from "../shared/i18n";
import { isReceiptNumber } from "./saleOutcomeText";

/**
 * The four things that can truthfully be said. As with the sale outcomes, the two `not_finalized*`
 * kinds share one code: the code is the machine's answer, the kind is what the cashier needs.
 */
export type InvoiceOutcomeKind =
  /** The payload never named an invoice, so nothing could be looked up. No retry is offered. */
  | "not_finalized"
  /** The ledger was read and the invoice produced no sale. It is still a draft; a retry is safe. */
  | "not_finalized_retry"
  /** The ledger HAS the sale, so the document was issued. Never invites a second issue. */
  | "finalized"
  /** The lookup itself failed. The honest answer is "unknown". */
  | "unknown";

const CODE: Readonly<Record<InvoiceOutcomeKind, string>> = Object.freeze({
  not_finalized: "INVOICE_NOT_FINALIZED",
  not_finalized_retry: "INVOICE_NOT_FINALIZED",
  finalized: "INVOICE_FINALIZED",
  unknown: "INVOICE_STATUS_UNKNOWN",
});

/**
 * An invoice number is printed only when it really is one — same rule, and the same reasoning, as
 * `isReceiptNumber`: a number is never invented, defaulted or coerced.
 */
export function isInvoiceNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The code and the sentence, together, in the operator's language. */
export function invoiceOutcomeError(
  lang: Language,
  kind: InvoiceOutcomeKind,
  numbers: { readonly invoiceNumber?: unknown; readonly receiptNumber?: unknown } = {},
): { readonly code: string; readonly message: string } {
  if (kind !== "finalized") {
    const key =
      kind === "not_finalized"
        ? "outcome.invoiceNotFinalized"
        : kind === "not_finalized_retry"
          ? "outcome.invoiceNotFinalizedRetry"
          : "outcome.invoiceStatusUnknown";
    return { code: CODE[kind], message: translate(lang, key) };
  }

  // 🔴 AS MUCH TRUE IDENTITY AS IS AVAILABLE, AND NOT ONE DIGIT MORE. Three shapes rather than one
  // template with holes in it: both numbers, the invoice number alone, or neither. A sentence that
  // named a receipt number while silently omitting the invoice number would send the merchant to
  // search the wrong list, so the invoice number is what gates the detailed wording.
  const hasInvoice = isInvoiceNumber(numbers.invoiceNumber);
  const hasReceipt = isReceiptNumber(numbers.receiptNumber);
  if (hasInvoice && hasReceipt) {
    return {
      code: CODE.finalized,
      message: translate(lang, "outcome.invoiceFinalizedWithReceipt")
        .replace("{invoice}", String(numbers.invoiceNumber))
        .replace("{receipt}", String(numbers.receiptNumber)),
    };
  }
  if (hasInvoice) {
    return {
      code: CODE.finalized,
      message: translate(lang, "outcome.invoiceFinalized").replace("{invoice}", String(numbers.invoiceNumber)),
    };
  }
  // Still FINALIZED — the sale row proved it. Just without a number we can stand behind.
  return { code: CODE.finalized, message: translate(lang, "outcome.invoiceFinalizedNoNumber") };
}
