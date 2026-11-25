/**
 * J1-CART-THUMBS — the Current Sale lines show the product's photo.
 *
 * The defect (owner, J1 screenshots): the grid showed photos, the cart lines next to it showed none.
 * The Sell screen fed the shared thumbnail hook ONLY the grid's products, so the cart had no photo
 * state of its own and a line whose product left the grid (search, category chip, scan) could never
 * get one. `sellPhotoRows` is the decision; SellScreen only wires it (no DOM harness here, as in
 * thumbnails.test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AdminProductDto } from "../../src/shared/ipcContract";
import { sellCartPhotoIds, sellCartPhotoKey, sellPhotoRows, thumbnailsToFetch } from "../../src/renderer/thumbnails";

function product(id: string, photo: { imageId: string; version: string } | null): AdminProductDto {
  return {
    id,
    source: "manual",
    sourceKey: id,
    sku: null,
    nameAr: "منتج",
    nameEn: null,
    price: { minor: "100", currency: "USD" },
    priceDecimal: "1.00",
    baseUnit: "piece",
    priceNeedsReview: false,
    isActive: true,
    updatedAt: "2026-11-19T09:00:00.000Z",
    categoryId: null,
    barcode: null,
    brand: null,
    descriptionAr: null,
    descriptionEn: null,
    isOnlineVisible: false,
    hasImage: photo !== null,
    primaryImageId: photo?.imageId ?? null,
    imageMime: photo ? "image/jpeg" : null,
    imageVersion: photo?.version ?? null,
  } as AdminProductDto;
}

const a = product("a", { imageId: "img-a", version: "v1" });
const b = product("b", { imageId: "img-b", version: "v1" });
const c = product("c", null);
const meta = [a, b, c];
const ids = (...xs: string[]) => new Set(xs);

describe("sellPhotoRows", () => {
  it("includes a cart product that the grid no longer shows (search / chip / scan)", () => {
    const rows = sellPhotoRows(meta, ids("a"), ids("b"));
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("includes a product once when it is both on the grid and in the cart", () => {
    expect(sellPhotoRows(meta, ids("a", "b"), ids("a")).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("an empty grid (search with no match) still keeps every cart line's row", () => {
    expect(sellPhotoRows(meta, ids(), ids("a", "b")).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("a cart-only photographed product is actually fetched; a cart product with no photo is not", () => {
    const rows = sellPhotoRows(meta, ids(), ids("b", "c"));
    const wanted = thumbnailsToFetch(rows, new Set(rows.map((r) => r.id)), new Map());
    expect(wanted).toEqual([{ productId: "b", imageId: "img-b", version: "v1" }]);
  });

  it("a cart photo already cached is not read again when the grid or quantity changes", () => {
    const rows = sellPhotoRows(meta, ids(), ids("a"));
    const cache = new Map([["a", { kind: "ready" as const, version: "v1", url: "data:image/jpeg;base64,AA==" }]]);
    expect(thumbnailsToFetch(rows, new Set(rows.map((r) => r.id)), cache)).toEqual([]);
  });

  it("nothing in the cart and nothing on the grid costs zero rows", () => {
    expect(sellPhotoRows(meta, ids(), ids())).toEqual([]);
  });
});

it("keeps product identities containing a pipe distinct from multiple cart items", () => {
  const pipe = product("import:one|two", { imageId: "pipe-photo", version: "v1" });
  const key = sellCartPhotoKey([pipe.id]);
  expect(key).not.toBe(sellCartPhotoKey(["import:one", "two"]));
  expect([...sellCartPhotoIds(key)]).toEqual([pipe.id]);
  expect(sellPhotoRows([pipe], new Set(), sellCartPhotoIds(key))).toEqual([pipe]);
});

it("preserves the full image inside the cart thumbnail", () => {
  const css = readFileSync("src/renderer/styles.css", "utf8");
  expect(css).toMatch(/\.line-thumb\s*>\s*img\s*\{[^}]*object-fit:\s*contain\s*;/);
});
