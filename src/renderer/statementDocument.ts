import type { StatementDocumentDto } from "../shared/ipcContract";

/**
 * UX-REF-NUMBERS (owner finding DEC-33 #2, FIELD UAT 2026-11-06): what a merchant reads for a debt's
 * origin — never the internal id. The ids stay on the DTO and in `data-*` attributes for the accounting
 * links; this is presentation only.
 *
 * 🔴 NOTHING IS INVENTED. An invoice shows ITS number; a till sale shows ITS receipt number; a manual
 * debt shows the reference the owner typed; a sale the main process could not resolve shows a dash —
 * never an id, and never a number it does not have. An invoice number and a sale receipt number are
 * different series, so each is labelled with its own word.
 */
export function statementDocumentText(doc: StatementDocumentDto, t: (key: string) => string): string {
  switch (doc.kind) {
    case "invoice":
      return `${t("statement.docInvoice")} #${doc.number}`;
    case "sale":
      return `${t("statement.docSaleReceipt")} #${doc.receiptNumber}`;
    case "manual":
      return `${t("statement.sourceManual")} ${doc.reference}`;
    case "unresolved":
      return "—";
  }
}
