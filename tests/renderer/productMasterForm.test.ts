/**
 * The Product Master form's patch — where "absent is not null" either survives the UI or dies in it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE CONTRACT RUNS THROUGH FOUR LAYERS AND THIS IS THE FIRST. `keep()` in the repository,
 * `objectWithOptional` in the handler and the preload's `in`-test builder are all pointless if the
 * form sends a SNAPSHOT of its six fields on every save. Two different failures follow from that,
 * and the second is the dangerous one:
 *
 *   1. a field the owner never touched is RESENT, so a value changed elsewhere between opening the
 *      form and pressing Save is silently reverted to what the form loaded;
 *   2. a field the form happens not to know about is sent as null and CLEARED.
 *
 * So the patch is a DIFF. These tests are what stop it quietly becoming a snapshot again.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import type { AdminProductDto } from "../../src/shared/ipcContract";
import {
  EMPTY_MASTER_FORM,
  categoryChoices,
  masterFormOf,
  masterPatchFrom,
} from "../../src/renderer/productMasterForm";

const PRODUCT: AdminProductDto = {
  id: "manual:000001",
  source: "manual",
  sourceKey: "000001",
  sku: "SKU-1",
  nameAr: "مفك",
  nameEn: null,
  price: { minor: "500", currency: "USD" },
  priceDecimal: "5.00",
  baseUnit: "piece",
  priceNeedsReview: false,
  isActive: true,
  updatedAt: "2026-10-14T09:00:00.000Z",
  categoryId: "cat-1",
  barcode: "0036000291452",
  brand: "Bosch",
  descriptionAr: "وصف",
  descriptionEn: "A description",
  isOnlineVisible: true,
  hasImage: false,
  primaryImageId: null,
  imageMime: null,
  imageVersion: null,
};

describe("masterPatchFrom", () => {
  it("🔴 an untouched form produces NO PATCH AT ALL — not an empty object, undefined", () => {
    const form = masterFormOf(PRODUCT);
    // undefined is what makes the draft's optional `master` key absent, which is what tells the
    // repository to leave every enrichment field exactly as it is. An empty object would also be
    // harmless today, but it would mean the form had an opinion; this means it had none.
    expect(masterPatchFrom(form, form)).toBeUndefined();
  });

  it("🔴 only the CHANGED key travels — the other five are not resent", () => {
    const form = masterFormOf(PRODUCT);
    expect(masterPatchFrom(form, { ...form, brand: "Makita" })).toEqual({ brand: "Makita" });
    // Named explicitly: this is the assertion that fails the moment someone sends a snapshot.
    expect(Object.keys(masterPatchFrom(form, { ...form, brand: "Makita" })!)).toEqual(["brand"]);
  });

  it("🔴 an EMPTIED field becomes null, which really does clear it", () => {
    const form = masterFormOf(PRODUCT);
    expect(masterPatchFrom(form, { ...form, categoryId: "" })).toEqual({ categoryId: null });
    expect(masterPatchFrom(form, { ...form, brand: "" })).toEqual({ brand: null });
    expect(masterPatchFrom(form, { ...form, barcode: "" })).toEqual({ barcode: null });
  });

  it("🔴 CONTROL — emptying and leaving-alone are DIFFERENT, which is the whole contract", () => {
    const form = masterFormOf(PRODUCT);
    expect(masterPatchFrom(form, form)?.brand).toBeUndefined(); // left alone
    expect(masterPatchFrom(form, { ...form, brand: "" })).toEqual({ brand: null }); // cleared
  });

  it("whitespace-only is the same as empty, and a value differing only by spaces sends nothing", () => {
    const form = masterFormOf(PRODUCT);
    expect(masterPatchFrom(form, { ...form, brand: "   " })).toEqual({ brand: null });
    // 🔴 Without the trim, this would send "Bosch " — the service would store "Bosch", the audit
    // diff would be empty, the trail would refuse an event that describes no change, and an
    // innocent save would surface as an internal error.
    expect(masterPatchFrom(form, { ...form, brand: "  Bosch  " })).toBeUndefined();
  });

  it("the checkbox travels only when it flips", () => {
    const form = masterFormOf(PRODUCT);
    expect(masterPatchFrom(form, { ...form, isOnlineVisible: false })).toEqual({ isOnlineVisible: false });
    expect(masterPatchFrom(form, { ...form, isOnlineVisible: true })).toBeUndefined();
    // false -> true is a change too, from the other direction.
    const off = { ...form, isOnlineVisible: false };
    expect(masterPatchFrom(off, { ...off, isOnlineVisible: true })).toEqual({ isOnlineVisible: true });
  });

  it("🔴 a NEW product sends only what was filled in — never five nulls", () => {
    // The import path and invoice reconciliation send no enrichment at all; a brand-new product
    // whose owner filled in one field must behave the same way for the other five.
    expect(masterPatchFrom(EMPTY_MASTER_FORM, { ...EMPTY_MASTER_FORM, brand: "Bosch" })).toEqual({ brand: "Bosch" });
    expect(masterPatchFrom(EMPTY_MASTER_FORM, EMPTY_MASTER_FORM)).toBeUndefined();
  });

  it("several changes travel together, each once", () => {
    const form = masterFormOf(PRODUCT);
    const patch = masterPatchFrom(form, {
      ...form,
      brand: "Makita",
      descriptionEn: "",
      isOnlineVisible: false,
    });
    expect(patch).toEqual({ brand: "Makita", descriptionEn: null, isOnlineVisible: false });
  });

  it("a product with nothing stored round-trips through the form unchanged", () => {
    const bare = { ...PRODUCT, categoryId: null, barcode: null, brand: null, descriptionAr: null, descriptionEn: null, isOnlineVisible: false };
    const form = masterFormOf(bare);
    expect(form).toEqual(EMPTY_MASTER_FORM);
    expect(masterPatchFrom(form, form)).toBeUndefined();
  });
});

describe("categoryChoices", () => {
  const cats = [
    { id: "a", isActive: true },
    { id: "b", isActive: false },
    { id: "c", isActive: true },
  ];

  it("offers the active ones", () => {
    expect(categoryChoices(cats, "").map((c) => c.category.id)).toEqual(["a", "c"]);
  });

  it("🔴 KEEPS the product's own category even when it is retired, and marks it", () => {
    // The approved contract: deactivating a category preserves it on the products already using
    // it, and the service refuses only a NEW assignment. A chooser offering active categories
    // alone would render this product's category as blank — and the first save would move it to
    // "no category" without anyone intending to.
    const choices = categoryChoices(cats, "b");
    expect(choices.map((c) => c.category.id)).toEqual(["a", "b", "c"]);
    expect(choices.find((c) => c.category.id === "b")!.retired).toBe(true);
    expect(choices.find((c) => c.category.id === "a")!.retired).toBe(false);
  });

  it("🔴 CONTROL — a retired category NOT assigned to this product is still not offered", () => {
    // Otherwise the test above would pass with a function that simply returned everything.
    expect(categoryChoices(cats, "c").map((c) => c.category.id)).toEqual(["a", "c"]);
  });
});
