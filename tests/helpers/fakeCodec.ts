/**
 * A stand-in for Electron's `nativeImage`, for the tests that cannot have the real one.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS A MODEL, AND THE DANGEROUS FAILURE IS A MODEL KINDER THAN REALITY.
 *
 * A fake that decodes more than Chromium does would make `normalizeProductPhoto` look correct
 * about files the shipped app refuses, and the test suite would be green about a feature that does
 * not work. So this does not consult a table of expected answers — it PARSES THE REAL BYTES it is
 * handed: a PNG's IHDR for its dimensions and colour type, a JPEG's segment chain for its SOF.
 * A file it cannot parse comes back EMPTY, which is exactly what `createFromBuffer` does.
 *
 * Every behaviour below is one that was MEASURED in a real Electron main process on 2026-10-14
 * (Electron 44.5.1 / Chromium 152) — see the header of src/main/photoNormalize.ts for the figures:
 *
 *   · decode NEVER THROWS; rubbish comes back `isEmpty()` with size 0x0
 *   · only JPEG and PNG decode — WEBP, GIF, BMP, TIFF and HEIC all come back empty
 *   · the bitmap is BGRA
 *   · resize preserves alpha
 *   · EXIF orientation is NOT applied by the decoder
 *   · `toJPEG` strips EXIF
 *
 * What it does NOT model is pixel fidelity: encoded sizes here come from a byte-per-pixel model,
 * not from a real encoder. So this file can prove the POLICY (which format, which edge, which
 * refusal, which rotation) and it cannot prove a photo looks right. That is what the installed
 * Windows gate and `e2e/photo-codec.mjs` are for, and why both exist.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { DecodedImage, ImageCodec } from "../../src/main/photoNormalize";

interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly alpha: boolean;
  /** Bytes an encoder would produce per pixel, so the output cap and the ladder are exercised. */
  readonly density: number;
}

/** Reads a PNG's IHDR. Returns null when this is not a parseable PNG. */
function parsePng(bytes: Buffer): Pixels | null {
  if (bytes.length < 33) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colourType = bytes[25] ?? 0;
  if (width === 0 || height === 0) return null;
  return { width, height, alpha: colourType === 4 || colourType === 6, density: 0.6 };
}

/** Walks a JPEG's segments to its SOF. Returns null when the chain does not hold together. */
function parseJpeg(bytes: Buffer): Pixels | null {
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1] ?? 0;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const length = bytes.readUInt16BE(p + 2);
    if (length < 2 || p + 2 + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 > bytes.length) return null;
      const height = bytes.readUInt16BE(p + 5);
      const width = bytes.readUInt16BE(p + 7);
      if (width === 0 || height === 0) return null;
      // A JPEG never carries alpha, which is why the format decision can hinge on transparency.
      return { width, height, alpha: false, density: 0.022 };
    }
    p += 2 + length;
  }
  return null;
}

const EMPTY: DecodedImage = {
  isEmpty: () => true,
  getSize: () => ({ width: 0, height: 0 }),
  toBitmap: () => Buffer.alloc(0),
  resize: () => EMPTY,
  toJPEG: () => Buffer.alloc(0),
  toPNG: () => Buffer.alloc(0),
};

function image(px: Pixels): DecodedImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: px.width, height: px.height }),
    toBitmap: () => {
      // BGRA. A transparent image gets ONE non-opaque pixel, which is all `hasTransparency` can
      // honestly be asked to find — and it must find it wherever it is, so it is the last one.
      const b = Buffer.alloc(px.width * px.height * 4, 0xff);
      if (px.alpha && b.length >= 4) b[b.length - 1] = 0x40;
      return b;
    },
    resize: ({ width, height }) => image({ ...px, width, height }),
    toJPEG: (quality) => {
      const n = Math.max(125, Math.round(px.width * px.height * px.density * (quality / 80)));
      const out = Buffer.alloc(n, 0x5a);
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(out, 0);
      // 🔴 THE CONTENT DEPENDS ON THE IMAGE, and it has to. Filling every output with one byte
      // made a 1600x1200 photo and a 1200x1600 one BYTE-IDENTICAL whenever their pixel counts
      // matched — which silently turned "the replacement is not the original" into a tautology.
      // A fake may be poorer than reality; it must not collapse two different things into one.
      out.writeUInt32BE(px.width, 4);
      out.writeUInt32BE(px.height, 8);
      out.writeUInt16BE(quality, 12);
      return out;
    },
    toPNG: () => {
      // A photograph re-encoded as PNG is ~28x its JPEG, measured. The model keeps that ratio so
      // the "never store a photograph as PNG" rule is tested against a realistic penalty.
      const n = Math.max(120, Math.round(px.width * px.height * (px.alpha ? 0.02 : 0.62)));
      const out = Buffer.alloc(n, 0x5a);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
      // Enough of an IHDR that a round-trip through `parsePng` agrees with what we just produced.
      out.writeUInt32BE(13, 8);
      Buffer.from("IHDR").copy(out, 12);
      out.writeUInt32BE(px.width, 16);
      out.writeUInt32BE(px.height, 20);
      out[24] = 8;
      out[25] = px.alpha ? 6 : 2;
      return out;
    },
  };
}

/** The codec itself. `decode` answers EMPTY rather than throwing, exactly as measured. */
export function fakeCodec(): ImageCodec {
  return {
    decode: (bytes) => {
      if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        const px = parsePng(bytes);
        return px === null ? EMPTY : image(px);
      }
      if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        const px = parseJpeg(bytes);
        return px === null ? EMPTY : image(px);
      }
      // WEBP, GIF, BMP, TIFF, HEIC, a text file, random bytes — all of these were measured empty.
      return EMPTY;
    },
    // A bitmap we just produced always builds, and it carries alpha when any pixel is non-opaque,
    // which is how a rotated transparent image stays a PNG.
    fromBitmap: (bgra, size) => {
      if (bgra.length !== size.width * size.height * 4 || size.width <= 0 || size.height <= 0) return EMPTY;
      let alpha = false;
      for (let i = 3; i < bgra.length; i += 4) {
        if (bgra[i] !== 255) {
          alpha = true;
          break;
        }
      }
      return image({ width: size.width, height: size.height, alpha, density: alpha ? 0.6 : 0.022 });
    },
  };
}
