/**
 * Parsing what the phone POSTs into the shapes the Product Master contract already understands.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE VALIDATES SHAPE. IT DOES NOT VALIDATE PRODUCTS.
 *
 * The authoritative rules — a required Arabic name, an exact price, a unit that exists, a barcode
 * canonicalized once, a category that exists and is usable — live in `productDraft.ts` and
 * `posService.ts` and are NOT restated here. This module's only job is to turn an untrusted JSON
 * body into a `ProductDraft` + `MasterForm` without trusting a single thing about it, so that the
 * existing validation receives the same kind of object the desktop hands it.
 *
 * The distinction matters because a second copy of the product rules is how the two surfaces drift
 * apart. A phone that accepted a unit the desktop refuses would be a second contract.
 *
 * 🔴 AND IT REFUSES AN UNKNOWN FIELD RATHER THAN IGNORING IT. `exactKeys` below is the same
 * discipline `exactObject` applies at the IPC boundary: a payload carrying `productId`, `isActive`
 * or `id` is REFUSED, not quietly dropped — because a client that sends one believes it will be
 * honoured, and the only safe answer to that belief is an error.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { DomainError } from "./errors";
import type { ProductDraft } from "./productDraft";
import type { MasterForm } from "../shared/productMasterForm";

/**
 * A hard cap on the whole decoded body, independent of the transport cap.
 *
 * The listener already counts bytes as they arrive and destroys the socket past its limit. This is
 * the second, smaller limit: H2 submits text fields only, so a body measured in megabytes is
 * already wrong, and refusing it here means `JSON.parse` is never handed something enormous.
 */
export const PHONE_SUBMISSION_MAX_BYTES = 64 * 1024;

/** The exact field set the phone form may send. Anything else is a refusal. */
const SELLING_KEYS = ["nameAr", "nameEn", "sku", "price", "baseUnit"] as const;
const MASTER_KEYS = ["categoryId", "barcode", "brand", "descriptionAr", "descriptionEn", "isOnlineVisible"] as const;

export interface PhoneSubmission {
  /**
   * The selling fields, as a full draft.
   *
   * 🔴 FULL, NOT A PATCH, AND THAT IS THE EXISTING CONTRACT RATHER THAN A CHOICE: `ProductDraft`
   * requires `nameAr`, `price` and `baseUnit`, so `updateProduct` has always received all five —
   * the desktop's `draftOf()` does exactly the same. The enrichment group is where absence means
   * something, and that is handled separately below.
   */
  readonly draft: ProductDraft;
  /**
   * The enrichment fields as the FORM held them — strings and one boolean, not a patch.
   *
   * 🔴 THE PHONE DOES NOT COMPUTE THE DIFF, and it must not: a diff needs the original the form was
   * shown, and a client-supplied "original" is a client-supplied instruction to revert. The POS
   * remembers what it served and diffs against that with `masterPatchFrom` — the one
   * implementation the desktop also uses.
   */
  readonly master: MasterForm;
}

/** A string field, or a refusal. Length is capped per field so one huge value cannot get through. */
function text(value: unknown, field: string, max: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", `'${field}' must be text`);
  if (value.length > max) {
    throw new DomainError("INVALID_INPUT", `'${field}' must be at most ${max} characters`);
  }
  return value;
}

/**
 * Per-field caps, deliberately GENEROUS relative to the real limits.
 *
 * 🔴 THESE ARE NOT THE PRODUCT RULES. `productDraft.ts` enforces the real maxima (200 for a name,
 * 64 for a SKU, 2000 for a description) and must remain the thing that refuses an over-long name,
 * with its own message. These exist only so a hostile body cannot carry a megabyte in one field
 * and have it travel all the way to a domain error. Setting them equal to the real limits would
 * duplicate the contract and the two would drift; setting them an order of magnitude higher
 * guards memory without owning the rule.
 */
const FIELD_CAP = 20_000;

function exactKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new DomainError("INVALID_INPUT", `${what} carries unexpected fields [${extra.join(", ")}]`);
  }
}

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("INVALID_INPUT", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Decode and shape-check a phone submission.
 *
 * `raw` is the request body as received. Everything about it is untrusted: its size, its encoding,
 * its JSON validity, its field set and every value's type.
 */
export function parsePhoneSubmission(raw: Buffer | string): PhoneSubmission {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes === 0) throw new DomainError("INVALID_INPUT", "The form sent nothing");
  if (bytes > PHONE_SUBMISSION_MAX_BYTES) {
    throw new DomainError("INVALID_INPUT", "The form sent more data than a product can contain");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    // The parser's own message can quote the body back; it is not shown to the merchant.
    throw new DomainError("INVALID_INPUT", "The form sent something this till could not read");
  }

  const body = plainObject(parsed, "The form");
  exactKeys(body, ["product", "master"], "The form");

  const sellingRaw = plainObject(body.product, "The product fields");
  exactKeys(sellingRaw, SELLING_KEYS, "The product fields");

  // 🔴 `nameAr`, `price` and `baseUnit` are passed through AS GIVEN (after the shape check) so
  // `validateProductDraft` produces its own message for a missing name or a bad price. Deciding
  // "a name is required" here would be the second contract this file exists to avoid.
  const draft: ProductDraft = {
    nameAr: text(sellingRaw.nameAr, "nameAr", FIELD_CAP),
    nameEn: emptyToNull(text(sellingRaw.nameEn, "nameEn", FIELD_CAP)),
    sku: emptyToNull(text(sellingRaw.sku, "sku", FIELD_CAP)),
    price: text(sellingRaw.price, "price", 64),
    baseUnit: text(sellingRaw.baseUnit, "baseUnit", 64),
  };

  const masterRaw = plainObject(body.master, "The catalogue fields");
  exactKeys(masterRaw, MASTER_KEYS, "The catalogue fields");

  if (masterRaw.isOnlineVisible !== undefined && typeof masterRaw.isOnlineVisible !== "boolean") {
    throw new DomainError("INVALID_INPUT", "'isOnlineVisible' must be true or false");
  }

  const master: MasterForm = {
    categoryId: text(masterRaw.categoryId, "categoryId", FIELD_CAP),
    barcode: text(masterRaw.barcode, "barcode", FIELD_CAP),
    brand: text(masterRaw.brand, "brand", FIELD_CAP),
    descriptionAr: text(masterRaw.descriptionAr, "descriptionAr", FIELD_CAP),
    descriptionEn: text(masterRaw.descriptionEn, "descriptionEn", FIELD_CAP),
    isOnlineVisible: masterRaw.isOnlineVisible === true,
  };

  return { draft, master };
}

/**
 * "" means "not given" for an optional field, matching `productDraft.ts`'s `optional()`.
 *
 * It is applied to `nameEn` and `sku` only. It is NOT applied to the master fields, because there
 * "" is meaningful: it is how the form expresses "the owner emptied this box", which
 * `masterPatchFrom` turns into a real `null` that clears the stored value.
 */
function emptyToNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}
