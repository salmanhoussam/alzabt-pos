/**
 * The `catalog_product_images` child table.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE RULE THIS FILE EXISTS TO ENFORCE: METADATA AND BYTES ARE SEPARATE READS.
 *
 * Image bytes live in SQLite so the existing `VACUUM INTO` backup already covers them — a photo
 * stored beside the database would be the frozen-logo gap again, at the scale of a whole catalog.
 * The cost of that choice is that a careless query drags a megabyte per product into memory, and
 * the products list renders every product.
 *
 * So there are two kinds of read here, and the type system keeps them apart: `ProductImageMeta`
 * has no `bytes` field AT ALL, and the only way to obtain bytes is `readBytes`, which names one
 * image. A list screen cannot accidentally be given them, because the shape it receives does not
 * have them.
 *
 * ONE PRIMARY IMAGE PER PRODUCT IN V1, and the schema's partial unique index — not this file —
 * is what makes that true. The table admits non-primary rows so a gallery needs no migration
 * later; nothing here creates one.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { Db } from "./db";

export type ImageMime = "image/jpeg" | "image/png";
export type ImageOrigin = "desktop" | "phone";

/**
 * Everything about an image EXCEPT its bytes.
 *
 * 🔴 There is deliberately no `bytes` field. Adding one here would let any caller that holds a
 * metadata row reach the blob, which is precisely the coupling the child table was chosen to
 * prevent.
 */
export interface ProductImageMeta {
  readonly id: string;
  readonly product_id: string;
  readonly mime: ImageMime;
  readonly sha256_hex: string;
  readonly byte_size: number;
  readonly width_px: number;
  readonly height_px: number;
  readonly is_primary: number;
  readonly origin: ImageOrigin;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Validated, already-normalized bytes on their way in. The service proves these, not this file. */
export interface NewProductImage {
  readonly id: string;
  readonly productId: string;
  readonly bytes: Buffer;
  readonly mime: ImageMime;
  readonly sha256Hex: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly origin: ImageOrigin;
  readonly now: string;
}

const META = `id, product_id, mime, sha256_hex, byte_size, width_px, height_px, is_primary,
              origin, created_at, updated_at`;

function normalise(row: Record<string, unknown> | undefined): ProductImageMeta | null {
  if (!row) return null;
  return {
    id: row.id as string,
    product_id: row.product_id as string,
    mime: row.mime as ImageMime,
    sha256_hex: row.sha256_hex as string,
    byte_size: Number(row.byte_size),
    width_px: Number(row.width_px),
    height_px: Number(row.height_px),
    is_primary: Number(row.is_primary),
    origin: row.origin as ImageOrigin,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export class ProductImageRepository {
  constructor(private readonly db: Db) {}

  /** The product's current image, as metadata only. No bytes are read. */
  findPrimaryMeta(productId: string): ProductImageMeta | null {
    return normalise(
      this.db
        .prepare(
          `SELECT ${META} FROM catalog_product_images WHERE product_id = ? AND is_primary = 1`,
        )
        .get(productId) as Record<string, unknown> | undefined,
    );
  }

  /**
   * WHICH products have an image, for a list screen that wants to show a badge or a placeholder.
   *
   * 🔴 THIS IS WHY THE LIST NEVER NEEDS BYTES. One query returns the ids that have a primary
   * image, so a products list showing "has photo" costs one small read for the whole table
   * instead of one blob per row.
   */
  productIdsWithPrimary(): ReadonlySet<string> {
    const rows = this.db
      .prepare(`SELECT product_id FROM catalog_product_images WHERE is_primary = 1`)
      .all() as Array<{ product_id: string }>;
    return new Set(rows.map((r) => r.product_id));
  }

  /**
   * One image's metadata by its OWN id, with no bytes.
   *
   * The companion to `readBytes`, which names the same image: a caller that wants the bytes also
   * wants the MIME and the stored checksum to verify them against, and asking for both separately
   * is what keeps the bytes out of every read that does not need them.
   */
  findMetaById(imageId: string): ProductImageMeta | null {
    return normalise(
      this.db.prepare(`SELECT ${META} FROM catalog_product_images WHERE id = ?`).get(imageId) as
        | Record<string, unknown>
        | undefined,
    );
  }

  /** Metadata for every image of one product, newest first. V1 only ever stores one. */
  listMetaForProduct(productId: string): ProductImageMeta[] {
    return (
      this.db
        .prepare(
          `SELECT ${META} FROM catalog_product_images
            WHERE product_id = ? ORDER BY is_primary DESC, created_at DESC, id`,
        )
        .all(productId) as Array<Record<string, unknown>>
    ).map((r) => normalise(r)!);
  }

  /**
   * The bytes of ONE named image — the only route to them.
   *
   * Used by the product's own detail view and by the online catalog export, which writes each
   * image to a real file and verifies what it wrote against `sha256_hex`.
   */
  readBytes(imageId: string): Buffer | null {
    const row = this.db
      .prepare(`SELECT bytes FROM catalog_product_images WHERE id = ?`)
      .get(imageId) as { bytes: Buffer } | undefined;
    return row ? row.bytes : null;
  }

  /**
   * Stores a new PRIMARY image, replacing whatever the product had.
   *
   * 🔴 DELETE-THEN-INSERT, IN THE CALLER'S TRANSACTION, AND THE ORDER IS NOT A STYLE CHOICE. The
   * partial unique index permits exactly one `is_primary = 1` row per product, so inserting before
   * removing would be refused by the database. The service wraps this so a failed insert cannot
   * leave a product with no image after it had one.
   */
  putPrimary(input: NewProductImage): ProductImageMeta {
    this.db.prepare(`DELETE FROM catalog_product_images WHERE product_id = ? AND is_primary = 1`).run(
      input.productId,
    );
    this.db
      .prepare(
        `INSERT INTO catalog_product_images (id, product_id, bytes, mime, sha256_hex, byte_size,
                                             width_px, height_px, is_primary, origin,
                                             created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.productId,
        input.bytes,
        input.mime,
        input.sha256Hex,
        input.bytes.length,
        input.widthPx,
        input.heightPx,
        input.origin,
        input.now,
        input.now,
      );
    return this.findPrimaryMeta(input.productId)!;
  }

  /** Removes the product's primary image. Returns whether there was one to remove. */
  removePrimary(productId: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM catalog_product_images WHERE product_id = ? AND is_primary = 1`)
      .run(productId);
    return Number(info.changes) > 0;
  }
}
