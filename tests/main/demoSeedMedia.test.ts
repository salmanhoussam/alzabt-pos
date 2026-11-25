import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DemoMediaError, verifyDemoProductMedia, verifyStoredDemoProductMedia, type ReviewedDemoMedia } from "../../src/main/demoSeedMedia";
import { fakeCodec } from "../helpers/fakeCodec";
import type { ProductImageMeta } from "../../src/persistence/productImageRepository";

// Synthetic JPEG segment chain for the fake codec; this is not a real-decoder proof.
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const approved: ReviewedDemoMedia = { sku: "SYNTH-1", file: "SYNTH-1.jpg", sha256, sourcePage: "synthetic-provenance", licence: "test-only" };

describe("BR-C-05 media primitive (trusted inputs, no file-authority claim)", () => {
  it("verifies an approved digest and invokes the existing decode and normalization pipeline", () => {
    const out = verifyDemoProductMedia("SYNTH-1", "SYNTH-1.jpg", bytes, [approved], fakeCodec());
    expect(out.widthPx).toBeGreaterThan(0);
    expect(out.heightPx).toBeGreaterThan(0);
    expect(out.bytes.length).toBeGreaterThan(0);
  });
  it("verifies stored normalized bytes against the correct product, not the source hash", () => {
    const normalized = verifyDemoProductMedia("SYNTH-1", "SYNTH-1.jpg", bytes, [approved], fakeCodec());
    const storedHash = createHash("sha256").update(normalized.bytes).digest("hex");
    expect(storedHash).not.toBe(sha256);
    const meta = {
      id: "image-1", product_id: "product-1", is_primary: 1, mime: normalized.mime,
      sha256_hex: storedHash, byte_size: normalized.bytes.length,
      width_px: normalized.widthPx, height_px: normalized.heightPx,
      origin: "desktop", created_at: "synthetic", updated_at: "synthetic",
    } satisfies ProductImageMeta;
    expect(() => verifyStoredDemoProductMedia("product-1", normalized, meta, Buffer.from(normalized.bytes))).not.toThrow();
    expect(() => verifyStoredDemoProductMedia("other-product", normalized, meta, normalized.bytes)).toThrow(DemoMediaError);
    expect(() => verifyStoredDemoProductMedia("product-1", normalized, { ...meta, sha256_hex: sha256 }, normalized.bytes)).toThrow(DemoMediaError);
    const corrupt = Buffer.from(normalized.bytes); corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
    expect(() => verifyStoredDemoProductMedia("product-1", normalized, meta, corrupt)).toThrow(DemoMediaError);
  });
  it("fails closed on missing, duplicated, uncredited, changed or misnamed media", () => {
    const lists = [[], [approved, approved], [{ ...approved, licence: "" }], [{ ...approved, sourcePage: "" }], [{ ...approved, sha256: "0".repeat(64) }]];
    for (const list of lists) expect(() => verifyDemoProductMedia("SYNTH-1", "SYNTH-1.jpg", bytes, list, fakeCodec())).toThrow(DemoMediaError);
    for (const name of ["../SYNTH-1.jpg", "OTHER.jpg", "SYNTH-1.png"]) expect(() => verifyDemoProductMedia("SYNTH-1", name, bytes, [approved], fakeCodec())).toThrow(DemoMediaError);
    expect(() => verifyDemoProductMedia("SYNTH-1", "SYNTH-1.jpg", Buffer.alloc(0), [approved], fakeCodec())).toThrow(DemoMediaError);
  });
  it("fails closed when bytes pass their pinned digest but cannot decode", () => {
    const invalid = Buffer.from("synthetic-not-an-image");
    const bad = { ...approved, sha256: createHash("sha256").update(invalid).digest("hex") };
    expect(() => verifyDemoProductMedia("SYNTH-1", "SYNTH-1.jpg", invalid, [bad], fakeCodec())).toThrow("Demo media verification failed.");
  });
});
