/**
 * The Product Master form's enrichment state, and the PATCH it produces.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS WHERE "ABSENT IS NOT NULL" EITHER SURVIVES THE UI OR DIES IN IT.
 *
 * The contract runs from the repository's `keep()` through the handler's `objectWithOptional` and
 * the preload's `in`-test builder, and all three are pointless if the form sends all six fields on
 * every save. Two ways that would go wrong, and the second is worse:
 *
 *   1. a field the owner never touched would be RESENT, so a value changed elsewhere between
 *      opening the form and pressing Save would be silently reverted to what the form loaded;
 *   2. a field the form does not know about would be sent as null and CLEARED.
 *
 * So the patch is a DIFF of what the owner actually changed, not a snapshot of the form. A field
 * left alone is absent from the patch; a field the owner emptied is `null`, which really does clear
 * it — because "remove this product's category" is a thing an owner does, and it must be
 * expressible. Those are different, deliberately.
 *
 * 🔴 IT IS A PURE MODULE, NOT STATE INSIDE THE COMPONENT, for the reason appScreen.test.ts already
 * paid for: this repository has no DOM harness, and the last rendering decision that lived inside a
 * component shipped a defect 717 tests passed through. The component holds strings; this decides
 * what they mean.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { AdminProductDto, ProductMasterPatch } from "../shared/ipcContract";

/**
 * The enrichment fields as the form holds them: strings, because that is what an input gives back,
 * and a boolean for the one checkbox.
 *
 * `categoryId` is "" for "no category" rather than null, so the `<select>` has a real value for its
 * placeholder option and React does not treat the control as uncontrolled.
 */
export interface MasterForm {
  readonly categoryId: string;
  readonly barcode: string;
  readonly brand: string;
  readonly descriptionAr: string;
  readonly descriptionEn: string;
  readonly isOnlineVisible: boolean;
}

export const EMPTY_MASTER_FORM: MasterForm = {
  categoryId: "",
  barcode: "",
  brand: "",
  descriptionAr: "",
  descriptionEn: "",
  isOnlineVisible: false,
};

/** What the form shows when an existing product is opened: exactly what is stored. */
export function masterFormOf(product: AdminProductDto): MasterForm {
  return {
    categoryId: product.categoryId ?? "",
    barcode: product.barcode ?? "",
    brand: product.brand ?? "",
    descriptionAr: product.descriptionAr ?? "",
    descriptionEn: product.descriptionEn ?? "",
    isOnlineVisible: product.isOnlineVisible,
  };
}

/** The text keys, so the diff below cannot silently miss one the interface gains. */
const TEXT_KEYS = ["categoryId", "barcode", "brand", "descriptionAr", "descriptionEn"] as const;

/**
 * The patch: only what changed, and `null` only where the owner really emptied a field.
 *
 * 🔴 TRIMMED BEFORE COMPARING, so re-saving a form whose value differs from storage only by
 * trailing whitespace sends nothing. Without that, `validateProductMaster` would trim it to the
 * same stored value and the audit diff would be empty — an event that describes no change, which
 * the trail refuses, which would surface as an internal error on an innocent save.
 *
 * Returns `undefined` when nothing changed at all, which is what the draft's optional `master` key
 * then carries: a save that touched no enrichment field sends no enrichment group whatsoever, and
 * is indistinguishable from an import or a reconciliation.
 */
export function masterPatchFrom(original: MasterForm, current: MasterForm): ProductMasterPatch | undefined {
  const out: Record<string, string | boolean | null> = {};
  for (const key of TEXT_KEYS) {
    const before = original[key].trim();
    const after = current[key].trim();
    if (before === after) continue;
    // Emptied by the owner: a real instruction to clear, not an accident.
    out[key] = after === "" ? null : after;
  }
  if (original.isOnlineVisible !== current.isOnlineVisible) out.isOnlineVisible = current.isOnlineVisible;
  return Object.keys(out).length === 0 ? undefined : (out as ProductMasterPatch);
}

/**
 * The categories the chooser offers for THIS product.
 *
 * 🔴 ACTIVE ONES, PLUS THE PRODUCT'S OWN EVEN IF RETIRED. The approved contract says deactivating a
 * category preserves it on the products that already carry it, and the service refuses only a NEW
 * assignment — so a form that offered active categories alone would show a product's own category
 * as blank, and the first save would silently move it to "no category".
 *
 * The retired one is marked, so the owner can see why it is there and that it is not on offer for
 * anything else.
 */
export function categoryChoices<T extends { readonly id: string; readonly isActive: boolean }>(
  categories: readonly T[],
  assignedId: string,
): Array<{ readonly category: T; readonly retired: boolean }> {
  return categories
    .filter((c) => c.isActive || c.id === assignedId)
    .map((c) => ({ category: c, retired: !c.isActive }));
}
