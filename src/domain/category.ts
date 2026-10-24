/**
 * Category names. Pure: no I/O, no database.
 *
 * A category is one flat label the owner types — "عدد", "دهان", "سباكة". There is deliberately no
 * `parent_id` and no tree: a hardware shop's list is one level deep in practice, and a tree is not
 * an approved feature. Nothing here decides whether a category may be deleted; that needs a count
 * of referencing products inside a transaction and lives in the service.
 *
 * 🔴 WHY THIS IS NOT `optional()` FROM productDraft.ts. That helper is right for a product name and
 * is reused here in spirit — collapse runs of whitespace, trim, refuse empty — but a category name
 * has its own, shorter limit, and copying the rule rather than importing a product's version keeps
 * the two free to diverge without one silently changing the other.
 */
import { DomainError } from "./errors";

/**
 * Shorter than a product name by intent: this is a label on a dropdown and in a website's
 * navigation, not a description. The column itself has no length CHECK, so this is the only limit.
 */
export const MAX_CATEGORY_NAME = 80;

/** The Arabic name — required, because it is what every surface shows and what UNIQUE compares. */
export function categoryNameAr(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", "A category name is required");
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") throw new DomainError("INVALID_INPUT", "A category name is required");
  if (trimmed.length > MAX_CATEGORY_NAME) {
    throw new DomainError("INVALID_INPUT", `A category name must be at most ${MAX_CATEGORY_NAME} characters`);
  }
  return trimmed;
}

/** The English name — optional. Empty, whitespace-only and null all mean "not given", never "". */
export function categoryNameEn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", "'name_en' must be text");
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_CATEGORY_NAME) {
    throw new DomainError("INVALID_INPUT", `A category name must be at most ${MAX_CATEGORY_NAME} characters`);
  }
  return trimmed;
}
