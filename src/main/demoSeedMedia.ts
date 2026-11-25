/**
 * BR-C-05 V3 media verification primitive. No file access or authority.
 * A future main-only adapter must obtain a separately trusted immutable manifest,
 * source bytes and codec from a securely confined resource reader. This module
 * does not establish that confinement or resolve Windows junction/TOCTOU.
 */
import { createHash } from "node:crypto";
import type { ProductImageMeta } from "../persistence/productImageRepository";
import { assertStorable, normalizeProductPhoto, sniffImageFormat, type ImageCodec, type NormalizedPhoto } from "./photoNormalize";

export interface ReviewedDemoMedia {
  readonly sku: string;
  readonly file: string;
  readonly sha256: string;
  readonly sourcePage: string;
  readonly licence: string;
}

export class DemoMediaError extends Error {
  constructor() { super("Demo media verification failed."); this.name = "DemoMediaError"; }
}

/**
 * The manifest's review and commercial rights are prerequisites, not inferred
 * from a populated field. Its expected hash must be pinned outside mutable input.
 * Returns normalized bytes only after identity, manifest and codec verification.
 */
export function verifyDemoProductMedia(
  sku: string,
  file: string,
  bytes: Buffer,
  reviewedManifest: ReadonlyArray<ReviewedDemoMedia>,
  codec: ImageCodec,
): NormalizedPhoto {
  try {
    if (!/^[A-Z0-9-]+$/.test(sku) || file !== sku + ".jpg") throw new DemoMediaError();
    const matching = reviewedManifest.filter((entry) => entry.sku === sku || entry.file === file);
    if (matching.length !== 1) throw new DemoMediaError();
    const entry = matching[0]!;
    if (entry.sku !== sku || entry.file !== file ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !entry.sourcePage.trim() || !entry.licence.trim() ||
      !Buffer.isBuffer(bytes) || sniffImageFormat(bytes) !== "image/jpeg" || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new DemoMediaError();
    }
    return assertStorable(normalizeProductPhoto(bytes, codec));
  } catch {
    throw new DemoMediaError();
  }
}

/**
 * Verify the post-write primary image and its actual stored bytes for the
 * expected product. Re-encoding changes hashes; compare against the normalized
 * bytes, never against the original fixture digest.
 */
export function verifyStoredDemoProductMedia(
  productId: string,
  normalized: NormalizedPhoto,
  stored: ProductImageMeta | null,
  storedBytes: Buffer | null,
): void {
  try {
    if (!stored || !storedBytes || stored.product_id !== productId || stored.is_primary !== 1 ||
      stored.mime !== normalized.mime || stored.width_px !== normalized.widthPx ||
      stored.height_px !== normalized.heightPx || stored.byte_size !== normalized.bytes.length ||
      storedBytes.length !== normalized.bytes.length) throw new DemoMediaError();
    const normalizedHash = createHash("sha256").update(normalized.bytes).digest("hex");
    const actualHash = createHash("sha256").update(storedBytes).digest("hex");
    if (stored.sha256_hex !== normalizedHash || actualHash !== normalizedHash) throw new DemoMediaError();
  } catch {
    throw new DemoMediaError();
  }
}
