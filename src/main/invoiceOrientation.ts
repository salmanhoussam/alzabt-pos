/**
 * PHONE-INVOICE-ORIENTATION-01 (owner UAT 2026-11-13): an upright READING copy of an invoice photo.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE MEASURED CAUSE. The owner's three real phone invoices were 6.6–6.9 MB JPEGs carrying
 * EXIF Orientation = 6: the camera stores the pixels sideways and a tag that tells a viewer to turn
 * them 90° clockwise. The staging stored the bytes as received, and BOTH readers ignore the tag —
 * Tesseract reads raw pixels, and Electron's `nativeImage` does not apply EXIF (measured for the
 * product photo pipeline, `photoNormalize.ts` §3). So the review showed the invoice sideways and
 * the OCR read sideways text: zero confident lines.
 *
 * 🔴 THE FIX REUSES THE PRODUCT PIPELINE'S PURE PIECES, not a second implementation:
 * `exifOrientation` (reads the tag; anything malformed answers 1) and `orientBitmap` (applies all
 * eight orientations, mirrors included). On top, the operator's own quarter-turns («تدوير يمين/يسار»)
 * for a photo whose PIXELS are sideways with no tag (a scan, a screenshot, a forwarded image).
 *
 * 🔴 EXACTLY ONE ROTATION PATH, SO NO DOUBLE ROTATION. The tag is applied here once, to pixels, and
 * the copy is re-encoded with `toJPEG`, which writes NO EXIF — so nothing downstream can apply it a
 * second time. The original file is never modified.
 *
 * 🔴 READING DETAIL, BOUNDED MEMORY. Product photos are cut to 1600 px for storage; a reading needs
 * the detail, so the copy keeps a long edge of up to 3000 px. The resize happens BEFORE the turn (a
 * quarter-turn cannot change which edge is longer), so the bitmap that is turned is at most
 * 3000×3000×4 = 36 MB, not the 48 MB of a 12-megapixel source.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { exifOrientation, orientBitmap, sniffImageFormat, type ImageCodec } from "./photoNormalize";
import { DomainError } from "../domain/errors";

export const READING_LONG_EDGE = 3000;

/** A quarter-turn count, normalised to 0..3 (clockwise). */
export function normalizeTurns(turns: number): 0 | 1 | 2 | 3 {
  const t = (((Math.trunc(turns) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return t;
}

/** The EXIF orientation code that performs N clockwise quarter-turns. */
export function turnsToOrientation(turns: 0 | 1 | 2 | 3): 1 | 6 | 3 | 8 {
  return turns === 1 ? 6 : turns === 2 ? 3 : turns === 3 ? 8 : 1;
}

export interface UprightCopy {
  /** Null when the source needs neither the tag applied nor a turn: read the original as it is. */
  readonly jpeg: Buffer | null;
  readonly exifOrientation: number;
  readonly turns: 0 | 1 | 2 | 3;
  readonly width: number;
  readonly height: number;
  readonly ms: number;
}

/**
 * The bytes an invoice reader should see: EXIF applied, then the operator's turns, long edge ≤ 3000.
 * Pure over the codec seam (unit-tested with a fake codec; main passes Electron's).
 */
export function uprightForReading(source: Buffer, operatorTurns: number, codec: ImageCodec): UprightCopy {
  const t0 = Date.now();
  const mime = sniffImageFormat(source);
  if (!mime) throw new DomainError("INVALID_INPUT", "That file is not a readable image (JPEG or PNG)");
  const exif = mime === "image/jpeg" ? exifOrientation(source) : 1;
  const turns = normalizeTurns(operatorTurns);
  const decoded = codec.decode(source);
  if (decoded.isEmpty()) throw new DomainError("INVALID_INPUT", "That file is not a readable image");
  const size = decoded.getSize();
  // An upright photo with no operator turn is read EXACTLY as before this fix (no resize, no re-encode).
  if (exif === 1 && turns === 0) {
    return { jpeg: null, exifOrientation: 1, turns: 0, width: size.width, height: size.height, ms: Date.now() - t0 };
  }
  const scale = Math.min(1, READING_LONG_EDGE / Math.max(size.width, size.height));
  const working =
    scale < 1
      ? decoded.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: "best" })
      : decoded;
  let w = working.getSize().width;
  let h = working.getSize().height;
  let bitmap = working.toBitmap();
  for (const code of [exif, turnsToOrientation(turns)]) {
    if (code === 1) continue;
    const o = orientBitmap(bitmap, w, h, code);
    bitmap = o.bytes;
    w = o.width;
    h = o.height;
  }
  const out = codec.fromBitmap(bitmap, { width: w, height: h });
  if (out.isEmpty()) throw new DomainError("INVALID_INPUT", "That photo could not be prepared for reading");
  return { jpeg: out.toJPEG(92), exifOrientation: exif, turns, width: w, height: h, ms: Date.now() - t0 };
}

/**
 * A small upright thumbnail (JPEG) for the till's queue: shrunk FIRST, then turned, so a 12-megapixel
 * photo costs a thumbnail-sized rotation, not a full one. Same EXIF + turn rules as the reading copy.
 */
export function uprightThumbnail(source: Buffer, operatorTurns: number, codec: ImageCodec, width = 96): Buffer | null {
  const mime = sniffImageFormat(source);
  if (!mime) return null;
  const decoded = codec.decode(source);
  if (decoded.isEmpty()) return null;
  const s = decoded.getSize();
  const scale = Math.min(1, width / Math.max(s.width, s.height));
  const small = decoded.resize({ width: Math.max(1, Math.round(s.width * scale)), height: Math.max(1, Math.round(s.height * scale)), quality: "best" });
  let w = small.getSize().width;
  let h = small.getSize().height;
  let bitmap = small.toBitmap();
  for (const code of [mime === "image/jpeg" ? exifOrientation(source) : 1, turnsToOrientation(normalizeTurns(operatorTurns))]) {
    if (code === 1) continue;
    const o = orientBitmap(bitmap, w, h, code);
    bitmap = o.bytes;
    w = o.width;
    h = o.height;
  }
  const out = codec.fromBitmap(bitmap, { width: w, height: h });
  return out.isEmpty() ? null : out.toJPEG(70);
}
