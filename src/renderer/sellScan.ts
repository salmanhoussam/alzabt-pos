/**
 * What Enter in the Sell search does — the whole decision, with no React in it, so every case is a
 * plain unit test.
 *
 * 🔴 ENTER IS THE SCANNER'S KEY, SO ENTER ONLY EVER MATCHES A BARCODE, EXACTLY. A USB scanner types
 * its code and presses Enter, and nothing reliable tells that apart from a person typing (timing is
 * hardware-dependent and was ruled out). So Enter never adds a product because its name or SKU
 * resembles, contains or even equals the text: a scan that misses must say so, never ring up a
 * different product. Choosing a product by name or SKU is done by selecting its card.
 *
 * Canonical form is decided by `normalizeBarcode` alone (src/domain/barcode.ts) — this file never
 * pads, trims, folds case or repairs a check digit of its own, so a scanned UPC-A and the EAN-13
 * the product form stored are the same string by construction.
 */
import { normalizeBarcode } from "../domain/barcode";
import type { Catalog } from "../domain/catalog";
import { MAX_QUANTITY_UNITS } from "../domain/quantity";

export type ScanOutcome =
  /** Nothing to resolve (an empty field). Enter does nothing, as before. */
  | { readonly kind: "none" }
  /** An active product carries exactly this canonical barcode. */
  | { readonly kind: "add"; readonly productId: string }
  /** The code belongs to a product taken off sale. Nothing is added. */
  | { readonly kind: "inactive" }
  /** No product carries this code. Nothing is added. */
  | { readonly kind: "unknown" }
  /** A numeric retail code whose check digit is wrong (EAN-13, EAN-8, UPC-A). Nothing is added. */
  | { readonly kind: "invalid" };

export function resolveScan(input: string, catalog: Pick<Catalog, "products" | "inactiveBarcodes">): ScanOutcome {
  let value: string;
  try {
    const normalized = normalizeBarcode(input);
    if (normalized === null) return { kind: "none" };
    value = normalized.value;
  } catch {
    // `normalizeBarcode` refuses a digits-only code only for a wrong check digit (or an absurd
    // length), so that is "invalid". Any other refusal — text longer than a barcode can be, a
    // control character — is not a check-digit failure, and an alphanumeric Code 128 payload is
    // never "invalid" for lacking an EAN check digit: it is simply a code nothing carries.
    return /^\d+$/.test(input.replace(/\s+/g, "")) ? { kind: "invalid" } : { kind: "unknown" };
  }
  const product = catalog.products.find((p) => p.barcode === value);
  if (product) return { kind: "add", productId: product.id };
  if (catalog.inactiveBarcodes.has(value)) return { kind: "inactive" };
  return { kind: "unknown" };
}

/** The i18n key of each refusal. One key per outcome: the three moments read differently. */
export const SCAN_MESSAGE_KEY = {
  unknown: "sell.scan.unknown",
  inactive: "sell.scan.inactive",
  invalid: "sell.scan.invalid",
} as const satisfies Record<Exclude<ScanOutcome["kind"], "none" | "add">, string>;

/**
 * What a keydown in the search field means.
 *
 * - `submit`  — one deliberate Enter: resolve the field once.
 * - `swallow` — an auto-repeated Enter (the key held down): consumed, resolves nothing, so holding
 *               Enter can never add the same product again and again.
 * - `ignore`  — anything else, including Enter that confirms an input-method composition, which
 *               belongs to the IME and not to the till.
 */
export function enterAction(e: {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}): "submit" | "swallow" | "ignore" {
  if (e.key !== "Enter" || e.isComposing) return "ignore";
  return e.repeat ? "swallow" : "submit";
}

/**
 * True when a keydown anywhere on the Sell screen should move focus to the search field.
 *
 * `/` is the documented key (the keycap beside the field). On the Arabic keyboard layout the same
 * physical key types «ظ», so the physical key (`code === "Slash"`) counts too. Never while the
 * operator is typing somewhere — a quantity, a dialog field — and never with a modifier, which is
 * someone else's shortcut.
 */
export function isSearchShortcut(
  e: {
    readonly key: string;
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
  },
  target: { readonly tagName?: string; readonly isContentEditable?: boolean } | null,
): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (!(e.key === "/" || (e.code === "Slash" && !e.shiftKey))) return false;
  if (target === null) return true;
  if (target.isContentEditable) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
}

/**
 * True when a keydown on the Sell screen, landing on something that is NOT a text field, should
 * move focus to the search field so the character is typed there ("type to search").
 *
 * 🔴 THIS IS WHAT KEEPS A SCAN FROM BEING LOST OR MISDIRECTED. A scanner types into whatever has
 * focus. Left on a product card, a tab button or a "+" button, the digits vanish and the final
 * Enter CLICKS that control — selling the card's product, not the scanned one. Moving focus on the
 * FIRST printable character sends that character and every one after it, Enter included, to the
 * search field, where the scan is resolved like any other. It is not scanner detection: a person
 * typing a letter on a card gets the same, ordinary "type to search".
 *
 * Space is excluded (it is the deliberate keyboard activation of the focused control), as are
 * Enter, arrows and every other named key (`key.length > 1`), modifier chords, text fields, and a
 * key some handler already claimed (`defaultPrevented` — the card's own "p" preview shortcut).
 */
export function isTypeToSearch(
  e: {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly defaultPrevented: boolean;
  },
  target: { readonly tagName?: string; readonly isContentEditable?: boolean } | null,
): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key.length !== 1 || e.key === " ") return false;
  if (target === null) return true;
  if (target.isContentEditable) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
}

/**
 * Enter never activates a control that CONFIRMS something on the Sell screen — a payment method,
 * or "yes, clear the cart". Call it from that control's keydown.
 *
 * 🔴 WHY: the payment pane gives Cash the initial focus, and a native button activates on Enter. A
 * scan arriving while the pane is open — its digits ignored by a button, its Enter not — therefore
 * recorded a CASH SALE without the scanned item. Preventing Enter's default on these controls
 * removes that path; a click, a tap, or Space on the deliberately focused control still confirms.
 * Nothing about what a confirmation records changes.
 */
export function refuseEnterActivation(e: { readonly key: string; preventDefault(): void }): void {
  if (e.key === "Enter") e.preventDefault();
}

/** The most integer digits a sale quantity can have (9999 → 4). */
const QUANTITY_DIGITS = String(MAX_QUANTITY_UNITS).length;

/**
 * What Enter in a cart line's QUANTITY box does with the text in it.
 *
 * 🔴 THE BOX CANNOT KNOW WHO TYPED, SO IT ASKS WHAT THE TEXT IS. A scanner typing into a focused
 * quantity box used to have its code committed as a quantity. The contract, in order:
 *   1. Text SHAPED like a quantity (`parseQuantity`'s own pattern: digits, optionally `.` and
 *      decimals) with at most 4 integer digits is the quantity — always, even if some product's
 *      barcode happens to be "12". A deliberate quantity is never turned into a product.
 *   2. A digits-only string longer than 4 digits cannot be a quantity (the maximum is 9999), so it
 *      is resolved as a scan: the scanned product is added, or the barcode message is shown.
 *   3. Any other text (an alphanumeric code, digits with spaces) that is EXACTLY a product's
 *      canonical barcode — active or inactive — is resolved as a scan.
 *   4. Everything else goes to the existing quantity parser and its existing refusal.
 * In every scan case the line's quantity is left as it was. What stays ambiguous is rule 1: an
 * UNKNOWN code of 4 digits or fewer typed into a focused quantity box is read as a quantity. That
 * is not hidden; it is why focus leaves the box after Enter (SellScreen), so only a box the
 * operator deliberately clicked into can receive one.
 */
export function quantityEnterAction(
  text: string,
  catalog: Pick<Catalog, "products" | "inactiveBarcodes">,
): { readonly kind: "quantity" } | { readonly kind: "scan"; readonly outcome: Exclude<ScanOutcome, { kind: "none" }> } {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "quantity" };
  const digitsOnly = /^\d+$/.test(trimmed);
  if (/^\d+(?:\.\d+)?$/.test(trimmed) && !(digitsOnly && trimmed.length > QUANTITY_DIGITS)) {
    return { kind: "quantity" };
  }
  const outcome = resolveScan(text, catalog);
  if (outcome.kind === "none") return { kind: "quantity" };
  if (digitsOnly) return { kind: "scan", outcome };
  if (outcome.kind === "add" || outcome.kind === "inactive") return { kind: "scan", outcome };
  return { kind: "quantity" };
}
