/**
 * J1-RECEIPT-NAMES — the name a receipt line SHOWS on screen, in the screen's language. Display only.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE SALE IS NEVER CHANGED. A sale line records `productName` (the catalogue snapshot rule,
 * domain/cart.ts) and that record is what Main prints, saves as PDF and previews. This function only
 * decides what the on-screen receipt displays; the caller keeps showing the recorded name beside it
 * whenever the two differ, so the screen can always be matched to the paper.
 *
 * 🔴 LOCALIZED ONLY WHEN IT IS VERIFIABLY THE SAME NAME. The current product's other-language name is
 * shown only when the line's recorded name is STILL one of that product's stored names. A product
 * renamed since the sale, deleted/deactivated (absent from the catalogue), or a line with no product
 * (an invoice-origin line) shows the recorded name unchanged — never today's name for yesterday's sale.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { nameForLanguage } from "../domain/catalog";

export interface NamedProduct {
  readonly name: string;
  readonly nameAr?: string;
  readonly nameEn?: string | null;
}

export interface ReceiptLineName {
  /** What the line shows. */
  readonly display: string;
  /** The recorded name, when it differs from `display`; null when they are the same text. */
  readonly recorded: string | null;
}

const same = (a: string, b: string) => a.trim() === b.trim();

export function receiptLineName(
  line: { readonly productId: string | null; readonly productName: string },
  product: NamedProduct | undefined,
  lang: "ar" | "en",
): ReceiptLineName {
  const recordedOnly = { display: line.productName, recorded: null };
  if (line.productId === null || product === undefined) return recordedOnly;
  const stored = [product.name, product.nameAr, product.nameEn].filter((n): n is string => typeof n === "string" && n.trim() !== "");
  if (!stored.some((n) => same(n, line.productName))) return recordedOnly;
  const display = nameForLanguage(product, lang);
  if (display.trim() === "") return recordedOnly;
  return same(display, line.productName) ? recordedOnly : { display, recorded: line.productName };
}
