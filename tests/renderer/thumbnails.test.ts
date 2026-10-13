/**
 * The products screen's thumbnail-loading policy — the six rules, each one able to fail.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE TESTS EXIST AT ALL. "Opening the products list must not eagerly fetch every photo"
 * is a claim about a renderer effect, and this repository has no DOM harness to mount one in
 * (`vitest.config.mts`: `environment: "node"`). The precedent is `appScreen.test.ts`: when a
 * rendering decision mattered, it was extracted into a pure function so a regression fails here in
 * milliseconds instead of on a Windows gate — after 717 passing tests missed it.
 *
 * So these are not a proxy for the real behaviour. The function under test IS the decision; the
 * component does nothing but call it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import type { AdminProductDto } from "../../src/shared/ipcContract";
import { allUrls, type ThumbnailCache, type ThumbnailState, thumbnailsToFetch, urlsToRevoke } from "../../src/renderer/thumbnails";

function product(over: Partial<AdminProductDto> & { id: string }): AdminProductDto {
  return {
    source: "manual",
    sourceKey: over.id,
    sku: null,
    nameAr: "منتج",
    nameEn: null,
    price: { minor: "100", currency: "USD" },
    priceDecimal: "1.00",
    baseUnit: "piece",
    priceNeedsReview: false,
    isActive: true,
    updatedAt: "2026-10-13T09:00:00.000Z",
    categoryId: null,
    barcode: null,
    brand: null,
    descriptionAr: null,
    descriptionEn: null,
    isOnlineVisible: false,
    hasImage: false,
    primaryImageId: null,
    imageMime: null,
    imageVersion: null,
    ...over,
  };
}

const photographed = (id: string, imageId: string, version: string) =>
  product({ id, hasImage: true, primaryImageId: imageId, imageMime: "image/jpeg", imageVersion: version });

const all = (...products: AdminProductDto[]) => new Set(products.map((p) => p.id));

describe("thumbnailsToFetch", () => {
  it("🔴 RULE 1 — a catalog with no photos costs ZERO reads, however long it is", () => {
    const products = Array.from({ length: 500 }, (_, i) => product({ id: `p${i}` }));
    expect(thumbnailsToFetch(products, all(...products), new Map())).toEqual([]);
  });

  it("🔴 fetches ONLY the photographed products, and asks for the image id, not the product id", () => {
    const withPhoto = photographed("p1", "img-1", "v1");
    const without = product({ id: "p2" });
    expect(thumbnailsToFetch([withPhoto, without], all(withPhoto, without), new Map())).toEqual([
      { productId: "p1", imageId: "img-1", version: "v1" },
    ]);
  });

  it("🔴 RULE 2 — a photo that is not on screen is not fetched", () => {
    const a = photographed("p1", "img-1", "v1");
    const b = photographed("p2", "img-2", "v2");
    // A filtered or virtualised list: only p1 is rendered.
    expect(thumbnailsToFetch([a, b], new Set(["p1"]), new Map()).map((r) => r.productId)).toEqual(["p1"]);
    // CONTROL: with both on screen, both are fetched — so the line above is about visibility.
    expect(thumbnailsToFetch([a, b], all(a, b), new Map()).map((r) => r.productId)).toEqual(["p1", "p2"]);
  });

  it("🔴 RULE 3 — a photo already held at its current version is never re-fetched", () => {
    const p = photographed("p1", "img-1", "v1");
    const cache: ThumbnailCache = new Map([["p1", { kind: "ready", version: "v1", url: "blob:x" }]]);
    expect(thumbnailsToFetch([p], all(p), cache)).toEqual([]);
  });

  it("🔴 RULE 4 — a REPLACED photo is fetched again, because the content hash changed", () => {
    const stale: ThumbnailCache = new Map([["p1", { kind: "ready", version: "v1", url: "blob:old" }]]);
    const replaced = photographed("p1", "img-2", "v2"); // the owner replaced it: new id, new hash
    expect(thumbnailsToFetch([replaced], all(replaced), stale)).toEqual([
      { productId: "p1", imageId: "img-2", version: "v2" },
    ]);
  });

  it("🔴 RULE 4 again — the SAME image id with different bytes still invalidates", () => {
    // A content hash, not an id, is what decides. This is the case an id-keyed cache gets wrong.
    const cache: ThumbnailCache = new Map([["p1", { kind: "ready", version: "v1", url: "blob:old" }]]);
    const sameIdNewBytes = photographed("p1", "img-1", "v2");
    expect(thumbnailsToFetch([sameIdNewBytes], all(sameIdNewBytes), cache)).toHaveLength(1);
  });

  it("🔴 RULE 5 — a fetch in flight is not started twice", () => {
    const p = photographed("p1", "img-1", "v1");
    const inFlight: ThumbnailCache = new Map([["p1", { kind: "loading", version: "v1" }]]);
    expect(thumbnailsToFetch([p], all(p), inFlight)).toEqual([]);
  });

  it("🔴 RULE 6 — a FAILED photo is not retried in a loop", () => {
    const p = photographed("p1", "img-1", "v1");
    const failed: ThumbnailCache = new Map([["p1", { kind: "failed", version: "v1" }]]);
    // Without this, a corrupt photo — the one `productImageBytes` refuses on a checksum mismatch —
    // would be requested on every render for as long as the screen is open.
    expect(thumbnailsToFetch([p], all(p), failed)).toEqual([]);
    // ...but replacing the broken photo IS tried, so a failure is not permanent.
    const fixed = photographed("p1", "img-2", "v2");
    expect(thumbnailsToFetch([fixed], all(fixed), failed)).toHaveLength(1);
  });

  it("🔴 a photographed INACTIVE product still gets its thumbnail", () => {
    // Deactivating a product hides it from Sell; it is still on this screen, and still identifiable
    // by its photo. Nothing about `isActive` belongs in a loading decision.
    const p = { ...photographed("p1", "img-1", "v1"), isActive: false };
    expect(thumbnailsToFetch([p], all(p), new Map())).toHaveLength(1);
  });

  it("🔴 a flag with no id is unaskable, and is skipped rather than requested as undefined", () => {
    // `toAdminProductDto` derives all four photo fields from one row so this cannot arise from the
    // real mapper — which is exactly why it is worth pinning: a future hand-built DTO, a fixture or
    // a decoded payload could carry hasImage with no id, and asking for `undefined` bytes would be
    // an internal error on every render.
    const broken = product({ id: "p1", hasImage: true, primaryImageId: null, imageVersion: null });
    expect(thumbnailsToFetch([broken], all(broken), new Map())).toEqual([]);
  });
});

describe("urlsToRevoke — an object URL pins its blob until it is revoked", () => {
  const ready = (version: string, url: string): ThumbnailState => ({ kind: "ready", version, url });

  it("revokes nothing while a thumbnail is unchanged", () => {
    const cache: ThumbnailCache = new Map([["p1", ready("v1", "blob:a")]]);
    expect(urlsToRevoke(cache, cache)).toEqual([]);
  });

  it("🔴 revokes the OLD url when a photo is replaced", () => {
    const before: ThumbnailCache = new Map([["p1", ready("v1", "blob:old")]]);
    const after: ThumbnailCache = new Map([["p1", ready("v2", "blob:new")]]);
    expect(urlsToRevoke(before, after)).toEqual(["blob:old"]);
  });

  it("🔴 revokes it when the photo is REMOVED and the entry becomes a placeholder", () => {
    const before: ThumbnailCache = new Map([["p1", ready("v1", "blob:old")]]);
    expect(urlsToRevoke(before, new Map())).toEqual(["blob:old"]);
    // ...and also when the entry survives but is no longer `ready`.
    const failedNow: ThumbnailCache = new Map([["p1", { kind: "failed", version: "v2" }]]);
    expect(urlsToRevoke(before, failedNow)).toEqual(["blob:old"]);
  });

  it("🔴 revokes nothing that is still reachable — a wrongly revoked url is a broken image", () => {
    const before: ThumbnailCache = new Map([
      ["p1", ready("v1", "blob:a")],
      ["p2", ready("v1", "blob:b")],
    ]);
    const after: ThumbnailCache = new Map([
      ["p1", ready("v1", "blob:a")], // untouched
      ["p2", ready("v2", "blob:c")], // replaced
    ]);
    expect(urlsToRevoke(before, after)).toEqual(["blob:b"]);
  });

  it("allUrls is what an unmount releases, and it lists only the loaded ones", () => {
    const cache: ThumbnailCache = new Map([
      ["p1", ready("v1", "blob:a")],
      ["p2", { kind: "loading", version: "v1" }],
      ["p3", { kind: "failed", version: "v1" }],
      ["p4", ready("v1", "blob:d")],
    ]);
    expect(allUrls(cache).sort()).toEqual(["blob:a", "blob:d"]);
  });
});
