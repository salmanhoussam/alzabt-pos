/**
 * Turning a file a shop owner picked into a product photo Alzabt will keep.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE VALIDATOR `src/domain/productImage.ts` SAYS IT IS NOT.
 *
 * That module proves a MIME string is one of two values and a buffer is neither empty nor absurd.
 * It says so plainly, because the opposite reading is the dangerous one. This module is the other
 * half: it DECODES the bytes, and a thing that does not decode is not a photo, whatever its name,
 * its extension or its declared type say.
 *
 * It does the decoding through an injected `ImageCodec`, so every rule below is unit-testable
 * without Electron, and the real codec is one thin adapter (`electronCodec` in productPhoto.ts).
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── EVERY NUMBER HERE WAS MEASURED, NOT CHOSEN ─────────────────────────────────────────────────
 *
 * Measured 2026-10-14 in a REAL Electron main process (`nativeImage`, Electron 44.5.1 /
 * Chromium 152), against real camera-sized fixtures. The earlier Linux study could not measure
 * this at all, because under `ELECTRON_RUN_AS_NODE=1` the binary is plain Node and `nativeImage`
 * does not exist. Running it for real is what produced every fact below.
 *
 *   1. `createFromBuffer` DECODES ONLY JPEG AND PNG. Measured empty (not an error — see 2) for
 *      WEBP, GIF, BMP, TIFF and HEVC/HEIC. So WEBP input is NOT supported and must not be
 *      promised, and an iPhone's default HEIC will be refused — a real shop limitation, carried
 *      as a merchant-readable message rather than a crash.
 *
 *   2. 🔴 `createFromBuffer` NEVER THROWS ON RUBBISH. It returns an EMPTY image: `isEmpty()` true,
 *      size 0x0. Measured for a truncated JPEG, random bytes, a bare JPEG magic number, a text
 *      file, a PNG header followed by junk, and a 26000x26000 decompression bomb. A producer built
 *      around try/catch would therefore accept every one of them as a 0x0 "photo". The refusal has
 *      to test `isEmpty()` and the dimensions, which is what `decodeOrRefuse` below does.
 *
 *   3. EXIF ORIENTATION IS NOT APPLIED. A portrait phone photo stored 4032x3024 with
 *      Orientation=6 comes back 4032x3024 — sideways. `toJPEG()` also STRIPS EXIF, so once we
 *      rotate the pixels ourselves the output carries no tag that could contradict them. There is
 *      no `rotate()` on NativeImage, so the transform runs on the bitmap (measured: 400x300 ->
 *      300x400, re-encodes clean).
 *
 *   4. THE BITMAP IS BGRA. Measured with a 1x1 pure-red PNG: bytes `0,0,255,255`.
 *
 *   5. RESIZE PRESERVES ALPHA, so transparency can be detected once, cheaply, on the SMALL
 *      bitmap instead of a 12-megapixel one.
 *
 *   6. PNG IS WORTH PRESERVING ONLY FOR TRANSPARENCY. At a 1200 long edge:
 *
 *           photograph              png  916.3 KB   jpeg80  32.3 KB     (28x)
 *           graphic, NO alpha       png   67.3 KB   jpeg80  46.7 KB
 *           graphic, WITH alpha     png    1.4 KB   jpeg80   1.7 KB
 *           logo, WITH alpha        png    3.2 KB   jpeg80   6.2 KB
 *
 *      So "is it a graphic?" is the wrong question — a graphic without alpha is SMALLER as JPEG.
 *      The one property JPEG cannot represent at all is transparency, and that is exactly where
 *      PNG wins on size too. Hence the rule: alpha -> PNG, everything else -> JPEG.
 *
 *   7. SIZE AT A 1600 LONG EDGE, 12-megapixel source: jpeg72 41.5 KB, jpeg80 65.9 KB, png 1.7 MB.
 *      At 1200: jpeg72 23.4 KB, jpeg80 32.3 KB.
 *
 *   8. THE WHOLE PIPELINE COSTS ~175 ms for a 12-megapixel JPEG (decode 88, resize 68, alpha scan
 *      4, encode 8), measured over five runs. Cheap enough to run synchronously in main.
 *
 *   9. RESIZE QUALITY: "good" 51 ms, "better" 39 ms, "best" 75 ms, all producing ~32 KB. `best`
 *      is chosen — 75 ms is invisible to an operator and a catalog photo is downscaled 3.4x, which
 *      is exactly where a better filter shows.
 */
import { DomainError } from "../domain/errors";
import { MAX_PRODUCT_IMAGE_BYTES, MAX_PRODUCT_IMAGE_EDGE, type ImageMimeValue } from "../domain/productImage";

// ── The policy ─────────────────────────────────────────────────────────────────────────────────

/**
 * The long edge every stored photo is reduced to.
 *
 * 1600 rather than 1200 because this same image is slice G's online-catalog image, where a
 * customer may open it full-screen on a phone; and rather than 2048 because at 1600/q80 a
 * 12-megapixel photo is ~66 KB, so a 400-product catalog is ~26 MB — carried in every VACUUM INTO
 * backup, on one shop PC. A source already at or below 1600 is left at its own size.
 */
export const TARGET_LONG_EDGE = 1600;

/** The quality ladder. 80 is the normal case; the rest exist only for the output cap below. */
export const JPEG_QUALITY_LADDER = [80, 72, 64] as const;

/** The fallback long edge, tried once if even the lowest quality will not fit. */
export const FALLBACK_LONG_EDGE = 1200;

/**
 * The most a NORMALIZED photo may be.
 *
 * Deliberately below the schema's own 2 MB (`MAX_PRODUCT_IMAGE_BYTES`) so that cap stays a
 * backstop that should never be the thing to fire: if the producer is working, nothing reaches it.
 */
export const MAX_NORMALIZED_BYTES = 1_200_000;

/**
 * The most an INPUT file may be before it is even read into memory.
 *
 * A 12-megapixel phone JPEG is 2-4 MB and the measured 9000x6000 fixture 3.5 MB; 32 MB admits a
 * 48-megapixel phone and a lightly-compressed DSLR frame while refusing a video someone renamed.
 */
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

/**
 * The most pixels a decoded source may contain: 80 megapixels.
 *
 * The measured 9000x6000 (54 MP) camera file is legitimate and must be accepted and shrunk, so
 * this cannot be `MAX_PRODUCT_IMAGE_EDGE` — that governs the STORED image, which after
 * normalization is at most 1600. Chromium's own decoder already refused a 676-megapixel bomb (it
 * came back empty), but a limit that lives in another project's source is not our guarantee.
 */
export const MAX_SOURCE_PIXELS = 80_000_000;

// ── The codec seam ─────────────────────────────────────────────────────────────────────────────

/** One decoded image. Exactly the slice of Electron's NativeImage this module uses. */
export interface DecodedImage {
  getSize(): { width: number; height: number };
  /** BGRA, row-major, `width * height * 4` bytes. */
  toBitmap(): Buffer;
  resize(options: { width: number; height: number; quality: "best" }): DecodedImage;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
  isEmpty(): boolean;
}

export interface ImageCodec {
  /** Decodes, or returns an EMPTY image — it must not throw. See measurement 2. */
  decode(bytes: Buffer): DecodedImage;
  /** Builds an image from a BGRA bitmap. Used only for the orientation transform. */
  fromBitmap(bgra: Buffer, size: { width: number; height: number }): DecodedImage;
}

/** What the producer hands the service. Mirrors `PickedPhoto` minus the origin. */
export interface NormalizedPhoto {
  readonly bytes: Buffer;
  readonly mime: ImageMimeValue;
  readonly widthPx: number;
  readonly heightPx: number;
  /** For the log and the measured-rationale record; never persisted, never audited. */
  readonly sourceMime: ImageMimeValue;
  readonly sourceWidthPx: number;
  readonly sourceHeightPx: number;
  readonly exifOrientation: number;
}

// ── Pure: what format are these bytes, really ──────────────────────────────────────────────────

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The real format of these bytes, or null.
 *
 * 🔴 THE EXTENSION IS NOT EVIDENCE, and that is measured too: a fixture that is a JPEG named
 * `.png` decoded perfectly at 800x600. The name a file carries is chosen by whoever handed it
 * over; the first bytes are chosen by whatever wrote the image.
 */
export function sniffImageFormat(bytes: Buffer): ImageMimeValue | null {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  return null;
}

// ── Pure: EXIF orientation ─────────────────────────────────────────────────────────────────────

const ORIENTATION_TAG = 0x0112;

/**
 * The EXIF Orientation of a JPEG: 1..8, or 1 when there is none and for anything malformed.
 *
 * Walks the JPEG segment chain to APP1, then the TIFF header and IFD0. Every bound is checked and
 * every failure answers 1 — a photo with a corrupt EXIF block is still a photo, and guessing a
 * rotation from a broken tag would turn a readable image into a sideways one. PNG has no such
 * tag, so a PNG always answers 1.
 */
export function exifOrientation(bytes: Buffer): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let p = 2;
  // Segment chain: FF <marker> <2-byte length including itself> <payload>.
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return 1;
    const marker = bytes[p + 1] ?? 0;
    // Start of scan / end of image: the metadata is behind us.
    if (marker === 0xda || marker === 0xd9) return 1;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const length = bytes.readUInt16BE(p + 2);
    if (length < 2) return 1;
    const payload = p + 4;
    const end = payload + length - 2;
    if (end > bytes.length) return 1;
    if (marker === 0xe1 && end - payload >= 14 && bytes.subarray(payload, payload + 4).toString("latin1") === "Exif") {
      return orientationFromTiff(bytes.subarray(payload + 6, end));
    }
    p = end;
  }
  return 1;
}

function orientationFromTiff(tiff: Buffer): number {
  if (tiff.length < 8) return 1;
  const byteOrder = tiff.subarray(0, 2).toString("latin1");
  const little = byteOrder === "II";
  if (!little && byteOrder !== "MM") return 1;
  const u16 = (at: number): number => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 0x002a) return 1;
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return 1;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (u16(entry) !== ORIENTATION_TAG) continue;
    // Type 3 = SHORT; the value sits in the first two bytes of the 4-byte value field.
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

// ── Pure: the orientation transform ────────────────────────────────────────────────────────────

/** True when any pixel is not fully opaque. BGRA, so alpha is every 4th byte. */
export function hasTransparency(bgra: Buffer): boolean {
  for (let i = 3; i < bgra.length; i += 4) if (bgra[i] !== 255) return true;
  return false;
}

/**
 * Applies an EXIF orientation to a BGRA bitmap, returning the bitmap as it should be SEEN.
 *
 * The four odd cases (2, 4, 5, 7) are mirrors, not just rotations, and they are implemented rather
 * than rounded to the nearest rotation: a mirrored product label is unreadable in a way a reader
 * cannot explain, where a sideways one at least looks like an obvious mistake.
 */
export function orientBitmap(
  bgra: Buffer,
  width: number,
  height: number,
  orientation: number,
): { bytes: Buffer; width: number; height: number } {
  if (orientation === 1) return { bytes: bgra, width, height };
  const swaps = orientation >= 5 && orientation <= 8;
  const outW = swaps ? height : width;
  const outH = swaps ? width : height;
  const out = Buffer.allocUnsafe(bgra.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2: nx = width - 1 - x; ny = y; break;
        case 3: nx = width - 1 - x; ny = height - 1 - y; break;
        case 4: nx = x; ny = height - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = height - 1 - y; ny = x; break;
        case 7: nx = height - 1 - y; ny = width - 1 - x; break;
        case 8: nx = y; ny = width - 1 - x; break;
        default: nx = x; ny = y; break;
      }
      bgra.copy(out, (ny * outW + nx) * 4, (y * width + x) * 4, (y * width + x) * 4 + 4);
    }
  }
  return { bytes: out, width: outW, height: outH };
}

// ── The pipeline ───────────────────────────────────────────────────────────────────────────────

/**
 * Decodes, or refuses with a message a shop owner can act on.
 *
 * 🔴 `isEmpty()` AND BOTH DIMENSIONS. See measurement 2: an undecodable file arrives here as a
 * 0x0 image, not as an exception, so a check that only catches throws catches nothing.
 */
function decodeOrRefuse(codec: ImageCodec, bytes: Buffer, what: string): DecodedImage {
  const image = codec.decode(bytes);
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
  if (image.isEmpty() || size.width <= 0 || size.height <= 0) {
    throw new DomainError("INVALID_INPUT", what);
  }
  return image;
}

/**
 * A picked file's bytes, turned into a photo worth storing — or a refusal.
 *
 * Order matters and is deliberate:
 *
 *   sniff -> size guard -> decode -> pixel guard -> resize -> orient -> alpha -> encode -> cap
 *
 * The sniff comes first because it is the cheapest possible refusal of a file that was never an
 * image. The resize comes BEFORE the orientation transform because the transform costs one pass
 * over the bitmap, and a 1600-edge bitmap is 10 MB where a 12-megapixel one is 48 MB; a 90-degree
 * rotation swaps the edges but cannot change which edge is longer, so the result is identical.
 */
export function normalizeProductPhoto(sourceBytes: Buffer, codec: ImageCodec): NormalizedPhoto {
  if (sourceBytes.length === 0) {
    throw new DomainError("INVALID_INPUT", "That file is empty");
  }
  if (sourceBytes.length > MAX_SOURCE_BYTES) {
    throw new DomainError(
      "INVALID_INPUT",
      `Choose an image smaller than ${Math.floor(MAX_SOURCE_BYTES / (1024 * 1024))} MB`,
    );
  }
  const sourceMime = sniffImageFormat(sourceBytes);
  if (sourceMime === null) {
    // The message names what WILL work, because the commonest real case is an iPhone's HEIC and
    // "unsupported format" tells the owner nothing they can do about it.
    throw new DomainError("INVALID_INPUT", "Choose a JPEG or PNG image (an iPhone HEIC photo must be saved as JPEG first)");
  }

  const decoded = decodeOrRefuse(codec, sourceBytes, "That file is not a readable image");
  const source = decoded.getSize();
  if (source.width * source.height > MAX_SOURCE_PIXELS) {
    throw new DomainError(
      "INVALID_INPUT",
      `That image is too large (${Math.round((source.width * source.height) / 1_000_000)} megapixels)`,
    );
  }

  const orientation = sourceMime === "image/jpeg" ? exifOrientation(sourceBytes) : 1;
  let attemptEdge = TARGET_LONG_EDGE;

  for (;;) {
    const working = resizeToEdge(decoded, source, attemptEdge);
    const workingSize = working.getSize();

    // 🔴 THE ROTATION IS A BITMAP ROUND-TRIP, because NativeImage has no `rotate()`. A photo that
    // needs no rotation never makes the trip at all — the overwhelmingly common case stays one
    // decode and one resize.
    let finalImage = working;
    if (orientation !== 1) {
      const oriented = orientBitmap(working.toBitmap(), workingSize.width, workingSize.height, orientation);
      finalImage = codec.fromBitmap(oriented.bytes, { width: oriented.width, height: oriented.height });
    }
    if (finalImage.isEmpty()) {
      throw new DomainError("INVALID_INPUT", "That photo could not be prepared");
    }
    const finalSize = finalImage.getSize();
    const transparent = hasTransparency(finalImage.toBitmap());

    const encoded = transparent
      ? { bytes: finalImage.toPNG(), mime: "image/png" as const }
      : encodeJpegWithinCap(finalImage);

    if (encoded !== null && encoded.bytes.length <= MAX_NORMALIZED_BYTES) {
      return {
        bytes: encoded.bytes,
        mime: encoded.mime,
        widthPx: finalSize.width,
        heightPx: finalSize.height,
        sourceMime,
        sourceWidthPx: source.width,
        sourceHeightPx: source.height,
        exifOrientation: orientation,
      };
    }
    if (attemptEdge === TARGET_LONG_EDGE) {
      attemptEdge = FALLBACK_LONG_EDGE;
      continue;
    }
    throw new DomainError("INVALID_INPUT", "That image could not be reduced to a reasonable size");
  }
}

/** Resizes so the long edge is at most `edge`; returns the image itself when already smaller. */
function resizeToEdge(image: DecodedImage, size: { width: number; height: number }, edge: number): DecodedImage {
  const long = Math.max(size.width, size.height);
  if (long <= edge) return image;
  const scale = edge / long;
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best",
  });
}

/** Walks the quality ladder until the output fits, or returns null. */
function encodeJpegWithinCap(image: DecodedImage): { bytes: Buffer; mime: "image/jpeg" } | null {
  let last: Buffer | null = null;
  for (const quality of JPEG_QUALITY_LADDER) {
    last = image.toJPEG(quality);
    if (last.length <= MAX_NORMALIZED_BYTES) return { bytes: last, mime: "image/jpeg" };
  }
  return null;
}

/**
 * The stored-photo invariants this module promises, asserted in one place so a test can name them.
 *
 * Called at the end of the producer rather than trusted: every one of these is something the
 * service would refuse anyway, and a producer that hands the service something it refuses is a
 * producer defect, not an operator error.
 */
export function assertStorable(photo: NormalizedPhoto): NormalizedPhoto {
  if (photo.bytes.length === 0 || photo.bytes.length > MAX_PRODUCT_IMAGE_BYTES) {
    throw new DomainError("INVALID_INPUT", "That photo could not be prepared");
  }
  if (photo.widthPx <= 0 || photo.heightPx <= 0) {
    throw new DomainError("INVALID_INPUT", "That photo could not be prepared");
  }
  if (photo.widthPx > MAX_PRODUCT_IMAGE_EDGE || photo.heightPx > MAX_PRODUCT_IMAGE_EDGE) {
    throw new DomainError("INVALID_INPUT", "That photo could not be prepared");
  }
  if (sniffImageFormat(photo.bytes) !== photo.mime) {
    // The bytes and the declared type must agree, because the declared type is what the renderer
    // will put in a `data:` URL and what slice G will serve.
    throw new DomainError("INVALID_INPUT", "That photo could not be prepared");
  }
  return photo;
}
