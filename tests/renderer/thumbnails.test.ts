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
// 🔴 `btoa` is a browser global. It exists in Node 16+, but naming the dependency here means a
// future Node that drops it fails by name rather than as an undefined call inside the renderer.
if (typeof globalThis.btoa !== "function") throw new Error("this test needs btoa");
import type { AdminProductDto } from "../../src/shared/ipcContract";
import { type ThumbnailCache, dataUrlFrom, thumbnailsToFetch } from "../../src/renderer/thumbnails";

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

/**
 * 🔴 THE REVOKE SUITE THAT USED TO BE HERE IS GONE, AND THIS IS WHY — it is not a weakened
 * assertion, it is a function that no longer exists.
 *
 * `urlsToRevoke` and `allUrls` managed the lifetime of `blob:` URLs. The renderer's CSP starts from
 * `default-src 'none'` and admits `img-src 'self' data:`, so a blob URL is BLOCKED and the image
 * silently never decodes — the first installed Windows run of this screen failed on exactly that,
 * against a PNG an independent decoder reads fine. Widening the CSP to admit `blob:` was rejected:
 * it is a real change to what the untrusted side of the bridge may load, and it would have been
 * made to save a base64 encode on a 40-pixel thumbnail.
 *
 * Thumbnails are `data:` URLs now, which are strings released with the state that holds them. There
 * is no lifetime to manage, so there is nothing left for those two functions to be right about.
 * What replaces them is the encoder below, which has its own trap.
 */
describe("dataUrlFrom", () => {
  it("produces a data URL the CSP admits, with the right media type", () => {
    const url = dataUrlFrom(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // Round-trips: the bytes are recoverable, so the encoding is not merely well-formed.
    const b64 = url.slice("data:image/png;base64,".length);
    expect([...Buffer.from(b64, "base64")]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("🔴 survives a REAL photo's size — the spread form would throw on one", () => {
    // `String.fromCharCode(...bytes)` passes every byte as an argument and blows the call-stack
    // argument limit somewhere past a hundred thousand of them. A 300 KB photo is well past it, so
    // the naive encoder works on a small fixture and throws on a real shop photo — the worst shape
    // a bug can have. 300_000 bytes here is a realistic normalized JPEG.
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
    const url = dataUrlFrom(big, "image/jpeg");
    const decoded = Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64");
    expect(decoded.length).toBe(big.length);
    expect(decoded.equals(Buffer.from(big))).toBe(true);
  });

  it("an empty array is still a valid data URL", () => {
    expect(dataUrlFrom(new Uint8Array(), "image/png")).toBe("data:image/png;base64,");
  });
});
