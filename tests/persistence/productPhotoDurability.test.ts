/**
 * Slice F — does a product photo actually SURVIVE a backup and a restore?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 A ROW COUNT IS NOT A PHOTO.
 *
 * `catalog_product_images` has been in `COUNTED_TABLES` since migration 9, so a snapshot missing
 * the table is already refused. But the backup contract verifies ROW COUNTS, and a row whose BLOB
 * came across empty, truncated, or re-encoded would satisfy every count there is. The shop's
 * product photo would be gone and every check would still be green — which is the exact shape of
 * the frozen-logo gap that list was written to prevent, now at the scale of a whole catalog.
 *
 * So these tests restore the snapshot the way the support procedure in README.md actually does —
 * there is no in-app restore; the file is copied over the ledger path — and then read the photo
 * back THROUGH THE REAL SERVICE, which recomputes the SHA-256 of the bytes it finds and refuses
 * them if it disagrees. Bytes, checksum, dimensions and MIME are compared to what went in.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { copyFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COUNTED_TABLES, snapshotDatabase } from "../../src/persistence/backup";
import { DomainError } from "../../src/domain/errors";
import { normalizeProductPhoto } from "../../src/main/photoNormalize";
import { fakeCodec } from "../helpers/fakeCodec";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const FIXTURES = join(__dirname, "..", "fixtures", "photos");

const DRAFT = {
  nameAr: "مفتاح أحمر",
  nameEn: "Red Wrench",
  sku: "SKU-PHOTO-1",
  price: "4.00",
  baseUnit: "piece" as const,
};

/** A real fixture file, through the real normalizer — the same bytes the producer would hand over. */
function normalized(name: string): ReturnType<typeof normalizeProductPhoto> {
  return normalizeProductPhoto(readFileSync(join(FIXTURES, name)), fakeCodec());
}

describe("a photo survives backup and restore, byte for byte", () => {
  it("🔴 the restored bytes, checksum, size and MIME are identical", () => {
    const h = makeHarness(t.dbPath);
    const product = h.service.createProduct(DRAFT);
    const photo = normalized("shelf.jpg");
    const stored = h.service.setProductPrimaryImage({
      productId: product.id,
      bytes: photo.bytes,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      origin: "desktop",
    });
    const expectedSha = createHash("sha256").update(photo.bytes).digest("hex");
    expect(stored.sha256_hex).toBe(expectedSha);

    const snapshot = join(t.dir, "backup.sqlite");
    const snap = snapshotDatabase(h.db, snapshot);
    expect(Number(snap.counts.catalog_product_images)).toBe(1);
    h.db.close();

    // The support procedure: the snapshot file BECOMES the ledger.
    const restoredPath = join(t.dir, "restored.sqlite");
    copyFileSync(snapshot, restoredPath);
    const r = makeHarness(restoredPath);
    try {
      const meta = r.service.primaryPhotoIndex().get(product.id);
      expect(meta, "the restored catalog still knows this product has a photo").toBeTruthy();

      // 🔴 THROUGH THE SERVICE, which re-verifies the SHA of the bytes it read and throws
      // LEDGER_INTEGRITY if they do not hash to the stored value. A truncated BLOB fails here.
      const read = r.service.productImageBytes(stored.id);
      expect(read.bytes.length).toBe(photo.bytes.length);
      expect(read.bytes.equals(photo.bytes), "the restored BLOB must be the same bytes").toBe(true);
      expect(createHash("sha256").update(read.bytes).digest("hex")).toBe(expectedSha);
      expect(read.meta.sha256_hex).toBe(expectedSha);
      expect(read.meta.mime).toBe(photo.mime);
      expect(read.meta.width_px).toBe(photo.widthPx);
      expect(read.meta.height_px).toBe(photo.heightPx);
      expect(read.meta.byte_size).toBe(photo.bytes.length);
    } finally {
      r.db.close();
    }
  });

  it("survives for a transparent PNG too — the other stored format", () => {
    const h = makeHarness(t.dbPath);
    const product = h.service.createProduct(DRAFT);
    const photo = normalized("logo-alpha.png");
    expect(photo.mime).toBe("image/png");
    const stored = h.service.setProductPrimaryImage({
      productId: product.id,
      bytes: photo.bytes,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      origin: "desktop",
    });
    const snapshot = join(t.dir, "backup-png.sqlite");
    snapshotDatabase(h.db, snapshot);
    h.db.close();
    const restoredPath = join(t.dir, "restored-png.sqlite");
    copyFileSync(snapshot, restoredPath);
    const r = makeHarness(restoredPath);
    try {
      const read = r.service.productImageBytes(stored.id);
      expect(read.bytes.equals(photo.bytes)).toBe(true);
      expect(read.meta.mime).toBe("image/png");
    } finally {
      r.db.close();
    }
  });

  it("survives a REPLACEMENT: the restored photo is the new one, not the old", () => {
    const h = makeHarness(t.dbPath);
    const product = h.service.createProduct(DRAFT);
    const first = normalized("shelf.jpg");
    const second = normalized("portrait-exif.jpg");
    expect(second.bytes.equals(first.bytes)).toBe(false);
    for (const p of [first, second]) {
      h.service.setProductPrimaryImage({
        productId: product.id,
        bytes: p.bytes,
        mime: p.mime,
        widthPx: p.widthPx,
        heightPx: p.heightPx,
        origin: "desktop",
      });
    }
    const snapshot = join(t.dir, "backup-replaced.sqlite");
    snapshotDatabase(h.db, snapshot);
    h.db.close();
    const restoredPath = join(t.dir, "restored-replaced.sqlite");
    copyFileSync(snapshot, restoredPath);
    const r = makeHarness(restoredPath);
    try {
      const index = r.service.primaryPhotoIndex().get(product.id);
      const read = r.service.productImageBytes(index!.id);
      expect(read.bytes.equals(second.bytes), "the replacement must be what survives").toBe(true);
      // The portrait fixture is the one that gets rotated upright, so this also proves the
      // ORIENTED image is what reached the ledger and came back.
      expect(read.meta.height_px).toBeGreaterThan(read.meta.width_px);
    } finally {
      r.db.close();
    }
  });

  it("a REMOVED photo stays removed across a restore", () => {
    const h = makeHarness(t.dbPath);
    const product = h.service.createProduct(DRAFT);
    const photo = normalized("shelf.jpg");
    h.service.setProductPrimaryImage({
      productId: product.id,
      bytes: photo.bytes,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      origin: "desktop",
    });
    expect(h.service.removeProductPrimaryImage(product.id).removed).toBe(true);
    const snapshot = join(t.dir, "backup-removed.sqlite");
    snapshotDatabase(h.db, snapshot);
    h.db.close();
    const restoredPath = join(t.dir, "restored-removed.sqlite");
    copyFileSync(snapshot, restoredPath);
    const r = makeHarness(restoredPath);
    try {
      expect(r.service.primaryPhotoIndex().get(product.id)).toBeUndefined();
    } finally {
      r.db.close();
    }
  });
});

describe("the negative control: a snapshot that loses the bytes must NOT look healthy", () => {
  it("🔴 blanking the BLOB keeps every row count intact — and the service still catches it", () => {
    // This is the whole reason this file exists. Row counts cannot see inside a BLOB, so the proof
    // that the restore is real has to be the SHA the service recomputes.
    const h = makeHarness(t.dbPath);
    const product = h.service.createProduct(DRAFT);
    const photo = normalized("shelf.jpg");
    const stored = h.service.setProductPrimaryImage({
      productId: product.id,
      bytes: photo.bytes,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      origin: "desktop",
    });
    const snapshot = join(t.dir, "backup-tampered.sqlite");
    snapshotDatabase(h.db, snapshot);
    h.db.close();

    const restoredPath = join(t.dir, "restored-tampered.sqlite");
    copyFileSync(snapshot, restoredPath);
    // Truncate the photo inside the restored file, leaving the row — and the count — in place.
    const raw = new Database(restoredPath);
    try {
      const before = raw.prepare("SELECT COUNT(*) AS n FROM catalog_product_images").get() as { n: number };
      raw.prepare("UPDATE catalog_product_images SET bytes = ? WHERE id = ?").run(Buffer.alloc(16), stored.id);
      const after = raw.prepare("SELECT COUNT(*) AS n FROM catalog_product_images").get() as { n: number };
      expect(after.n, "the row count is unchanged, which is exactly the problem").toBe(before.n);
    } finally {
      raw.close();
    }

    const r = makeHarness(restoredPath);
    try {
      // The CODE is the contract; the sentence is for the operator and may be reworded.
      let code: string | null = null;
      try {
        r.service.productImageBytes(stored.id);
      } catch (e) {
        code = e instanceof DomainError ? e.code : "not-a-DomainError";
      }
      expect(code, "a truncated BLOB must be refused, not returned").toBe("LEDGER_INTEGRITY");
    } finally {
      r.db.close();
    }
  });

  it("the images table is still named in the verified set", () => {
    // A derived guard: if a future migration rebuilt this table under a new name and the list were
    // not updated, snapshots would silently stop verifying it.
    expect(COUNTED_TABLES).toContain("catalog_product_images");
  });
});
