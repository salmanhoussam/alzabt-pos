/**
 * Slice F — the normalization policy, against the REAL fixture files.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE INPUTS HERE ARE REAL IMAGE FILES, NOT SYNTHETIC METADATA.
 *
 * `tests/fixtures/photos/` holds real bytes written by a real encoder: a 2400x1800 photograph, a
 * portrait phone photo carrying EXIF Orientation=6, a PNG with real transparency, a PNG without,
 * a 9000x6000 oversized camera frame, a real WEBP, a JPEG wearing a `.png` name, and a file that
 * is not an image at all. Every refusal and every format decision below is driven by those bytes.
 *
 * 🔴 WHAT THESE TESTS CANNOT PROVE, stated so nobody reads them as proof of it: the codec is a
 * model (tests/helpers/fakeCodec.ts), because `nativeImage` does not exist under
 * ELECTRON_RUN_AS_NODE. The model PARSES the real fixtures rather than consulting a table, and
 * every behaviour it models was measured in a real Electron process — but a photograph looking
 * right is proven by `e2e/photo-codec.mjs` and the installed Windows gate, not here.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { MAX_PRODUCT_IMAGE_BYTES } from "../../src/domain/productImage";
import {
  FALLBACK_LONG_EDGE,
  MAX_NORMALIZED_BYTES,
  MAX_SOURCE_BYTES,
  TARGET_LONG_EDGE,
  assertStorable,
  exifOrientation,
  hasTransparency,
  normalizeProductPhoto,
  orientBitmap,
  sniffImageFormat,
} from "../../src/main/photoNormalize";
import { fakeCodec } from "../helpers/fakeCodec";

const FIXTURES = join(__dirname, "..", "fixtures", "photos");
const fx = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  throw new Error("expected a DomainError, nothing was thrown");
};
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.message;
    throw e;
  }
  throw new Error("expected a DomainError, nothing was thrown");
};

describe("what format are these bytes, really", () => {
  it("names the real format of every real fixture", () => {
    expect(sniffImageFormat(fx("shelf.jpg"))).toBe("image/jpeg");
    expect(sniffImageFormat(fx("portrait-exif.jpg"))).toBe("image/jpeg");
    expect(sniffImageFormat(fx("oversized.jpg"))).toBe("image/jpeg");
    expect(sniffImageFormat(fx("logo-alpha.png"))).toBe("image/png");
    expect(sniffImageFormat(fx("table-noalpha.png"))).toBe("image/png");
  });

  it("🔴 reads the BYTES, not the name — a JPEG called .png is a JPEG", () => {
    // The fixture is genuinely a JPEG saved as `liar.png`. Were the extension trusted, this photo
    // would be stored declaring a MIME its bytes contradict, and the renderer's data: URL would
    // then tell the browser to decode a JPEG as a PNG.
    expect(sniffImageFormat(fx("liar.png"))).toBe("image/jpeg");
  });

  it("refuses what is not a JPEG or a PNG", () => {
    expect(sniffImageFormat(fx("sample.webp"))).toBeNull();
    expect(sniffImageFormat(Buffer.from("product,price\n"))).toBeNull();
    expect(sniffImageFormat(Buffer.alloc(0))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe("EXIF orientation", () => {
  it("reads Orientation=6 out of the real portrait fixture", () => {
    expect(exifOrientation(fx("portrait-exif.jpg"))).toBe(6);
  });

  it("answers 1 for a photo with no orientation tag, and for a PNG", () => {
    expect(exifOrientation(fx("shelf.jpg"))).toBe(1);
    expect(exifOrientation(fx("logo-alpha.png"))).toBe(1);
  });

  it("answers 1 rather than guessing, for every malformed shape", () => {
    expect(exifOrientation(Buffer.alloc(0))).toBe(1);
    expect(exifOrientation(Buffer.from([0xff, 0xd8]))).toBe(1);
    expect(exifOrientation(fx("corrupt.jpg"))).toBe(1);
    // An APP1 that claims to be Exif but whose TIFF header is nonsense.
    const bad = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]),
      Buffer.from("Exif\0\0", "latin1"),
      Buffer.from([0x5a, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ]);
    expect(exifOrientation(bad)).toBe(1);
    // A length field that runs past the end of the buffer.
    expect(exifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]))).toBe(1);
  });

  it("refuses an out-of-range orientation value instead of trusting it", () => {
    const tiff = Buffer.alloc(26);
    Buffer.from("MM", "latin1").copy(tiff, 0);
    tiff.writeUInt16BE(0x002a, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8); // one entry
    tiff.writeUInt16BE(0x0112, 10); // Orientation
    tiff.writeUInt16BE(3, 12); // SHORT
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(99, 18); // nonsense
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      (() => {
        const l = Buffer.alloc(2);
        l.writeUInt16BE(tiff.length + 8);
        return l;
      })(),
      Buffer.from("Exif\0\0", "latin1"),
      tiff,
    ]);
    expect(exifOrientation(jpeg)).toBe(1);
  });
});

describe("the orientation transform", () => {
  /** A 2x1 BGRA bitmap: left pixel blue, right pixel red. */
  const twoByOne = (): Buffer => Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);

  it("passes orientation 1 through untouched, allocating nothing", () => {
    const b = twoByOne();
    const out = orientBitmap(b, 2, 1, 1);
    expect(out.bytes).toBe(b);
    expect([out.width, out.height]).toEqual([2, 1]);
  });

  it("swaps the edges for every rotation case and only those", () => {
    for (const o of [2, 3, 4]) {
      const out = orientBitmap(twoByOne(), 2, 1, o);
      expect([out.width, out.height], `orientation ${o} must not swap edges`).toEqual([2, 1]);
    }
    for (const o of [5, 6, 7, 8]) {
      const out = orientBitmap(twoByOne(), 2, 1, o);
      expect([out.width, out.height], `orientation ${o} must swap edges`).toEqual([1, 2]);
    }
  });

  it("rotates 90° clockwise for orientation 6 — the phone-portrait case", () => {
    // 2x1 [blue, red] rotated 90° CW becomes 1x2 [blue; red]: the left pixel moves to the top.
    const out = orientBitmap(twoByOne(), 2, 1, 6);
    expect([...out.bytes]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("mirrors rather than rotates for orientation 2", () => {
    const out = orientBitmap(twoByOne(), 2, 1, 2);
    expect([...out.bytes]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });

  it("is its own inverse where it should be: 3 applied twice is the identity", () => {
    const once = orientBitmap(twoByOne(), 2, 1, 3);
    const twice = orientBitmap(once.bytes, once.width, once.height, 3);
    expect([...twice.bytes]).toEqual([...twoByOne()]);
  });
});

describe("transparency detection", () => {
  it("finds a non-opaque pixel wherever it is, including the last one", () => {
    expect(hasTransparency(Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]))).toBe(false);
    expect(hasTransparency(Buffer.from([0, 0, 0, 255, 0, 0, 0, 254]))).toBe(true);
    expect(hasTransparency(Buffer.from([0, 0, 0, 0, 0, 0, 0, 255]))).toBe(true);
    expect(hasTransparency(Buffer.alloc(0))).toBe(false);
  });
});

describe("normalizing a real photograph", () => {
  const codec = fakeCodec();

  it("reduces a 2400x1800 photograph to the target long edge, as a JPEG", () => {
    const out = normalizeProductPhoto(fx("shelf.jpg"), codec);
    expect(out.mime).toBe("image/jpeg");
    expect(Math.max(out.widthPx, out.heightPx)).toBe(TARGET_LONG_EDGE);
    expect(out.widthPx).toBe(1600);
    expect(out.heightPx).toBe(1200);
    expect(out.sourceWidthPx).toBe(2400);
    expect(out.sourceHeightPx).toBe(1800);
    expect(out.bytes.length).toBeLessThanOrEqual(MAX_NORMALIZED_BYTES);
  });

  it("reduces a 9000x6000 camera frame rather than refusing it", () => {
    // 54 megapixels is a legitimate camera file. The stored-image edge cap must not be mistaken
    // for an input cap — a shop that photographs its shelf with a good camera is not an attack.
    const out = normalizeProductPhoto(fx("oversized.jpg"), codec);
    expect(out.sourceWidthPx).toBe(9000);
    expect(Math.max(out.widthPx, out.heightPx)).toBe(TARGET_LONG_EDGE);
    expect(out.widthPx).toBe(1600);
    expect(out.heightPx).toBe(1067);
  });

  it("leaves an image already smaller than the target at its own size", () => {
    const out = normalizeProductPhoto(fx("liar.png"), codec);
    expect([out.widthPx, out.heightPx]).toEqual([800, 600]);
  });

  it("🔴 turns a portrait phone photo UPRIGHT — the edges swap", () => {
    // The fixture's bytes are 2400x1800 (landscape) with Orientation=6. Stored as decoded it would
    // appear on its side in the Products list and in the online catalogue. Measured: nativeImage
    // does not do this for us.
    const out = normalizeProductPhoto(fx("portrait-exif.jpg"), codec);
    expect(out.exifOrientation).toBe(6);
    expect(out.sourceWidthPx).toBeGreaterThan(out.sourceHeightPx);
    expect(out.heightPx, "a portrait photo must be stored taller than it is wide").toBeGreaterThan(out.widthPx);
    expect([out.widthPx, out.heightPx]).toEqual([1200, 1600]);
  });
});

describe("the format decision", () => {
  const codec = fakeCodec();

  it("🔴 preserves PNG only for transparency", () => {
    const alpha = normalizeProductPhoto(fx("logo-alpha.png"), codec);
    expect(alpha.mime, "an image with transparency must stay a PNG — JPEG cannot carry alpha").toBe("image/png");
  });

  it("🔴 does NOT preserve PNG for a graphic without transparency", () => {
    // Measured: at a 1200 edge this exact kind of image is 67.3 KB as PNG and 46.7 KB as JPEG. The
    // tempting rule ("it's a graphic, keep it lossless") costs bytes and buys nothing.
    const flat = normalizeProductPhoto(fx("table-noalpha.png"), codec);
    expect(flat.mime).toBe("image/jpeg");
  });

  it("never stores a photograph as a PNG", () => {
    expect(normalizeProductPhoto(fx("shelf.jpg"), codec).mime).toBe("image/jpeg");
    expect(normalizeProductPhoto(fx("oversized.jpg"), codec).mime).toBe("image/jpeg");
  });

  it("keeps transparency through the rotation path too", () => {
    // A rotated image goes out through `fromBitmap`, a different construction path from the
    // resize-only one — so alpha has to survive the bitmap round-trip, not just the resize.
    const rotated = orientBitmap(Buffer.from([0, 0, 0, 0, 1, 1, 1, 255]), 2, 1, 6);
    expect(hasTransparency(rotated.bytes)).toBe(true);
  });
});

describe("refusals a shop owner can act on", () => {
  const codec = fakeCodec();

  it("🔴 refuses a real WEBP, because nativeImage cannot decode one", () => {
    // Measured empty in real Electron. Offering WEBP in the dialog and then failing deeper would
    // be worse than naming it here.
    expect(codeOf(() => normalizeProductPhoto(fx("sample.webp"), codec))).toBe("INVALID_INPUT");
  });

  it("🔴 names JPEG and PNG, and names the iPhone case, instead of saying 'unsupported'", () => {
    const m = messageOf(() => normalizeProductPhoto(fx("sample.webp"), codec));
    expect(m).toMatch(/JPEG/);
    expect(m).toMatch(/PNG/);
    expect(m, "the commonest real failure is an iPhone HEIC and the owner needs to know what to do").toMatch(/HEIC/i);
  });

  it("🔴 refuses a file that is not an image although it wears a .jpg name and a JPEG magic", () => {
    // corrupt.jpg starts FF D8 FF E0, so the sniff ACCEPTS it. The decode is what refuses it — and
    // measured, the decoder does that by returning an EMPTY image, never by throwing.
    expect(sniffImageFormat(fx("corrupt.jpg"))).toBe("image/jpeg");
    expect(codeOf(() => normalizeProductPhoto(fx("corrupt.jpg"), codec))).toBe("INVALID_INPUT");
    expect(messageOf(() => normalizeProductPhoto(fx("corrupt.jpg"), codec))).toMatch(/not a readable image/);
  });

  it("refuses an empty file and one over the source cap", () => {
    expect(codeOf(() => normalizeProductPhoto(Buffer.alloc(0), codec))).toBe("INVALID_INPUT");
    const huge = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    Buffer.from([0xff, 0xd8, 0xff]).copy(huge, 0);
    expect(messageOf(() => normalizeProductPhoto(huge, codec))).toMatch(/smaller than 32 MB/);
  });

  it("🔴 refuses an empty decode rather than storing a 0x0 photo — TRY/CATCH IS NOT SUFFICIENT", () => {
    // 🔴 THE STANDING CONTRACT THIS TEST EXISTS TO HOLD. Measured in real Electron: invalid,
    // corrupt and extreme input makes `nativeImage.createFromBuffer` return an EMPTY image, NOT
    // throw — a truncated JPEG, random bytes, a bare magic number, a text file and a 676-megapixel
    // decompression bomb all take that path. So validation must test the DECODE RESULT —
    // `isEmpty()`, width > 0, height > 0, and the normalized output's own bounds — and a producer
    // written around try/catch alone would store every one of them as a 0x0 "photo".
    //
    // The codec here is the measured failure mode modelled directly: one that answers empty for
    // everything, handed a file that is genuinely a valid JPEG.
    const blind = { decode: () => emptyImage(), fromBitmap: () => emptyImage() };
    expect(sniffImageFormat(fx("shelf.jpg")), "the input really is a valid JPEG").toBe("image/jpeg");
    expect(codeOf(() => normalizeProductPhoto(fx("shelf.jpg"), blind))).toBe("INVALID_INPUT");
  });

  it("🔴 and a codec that THROWS is refused too — both directions, not one", () => {
    // The other half of the same contract. `electronCodec` converts a throw into an empty image so
    // there is one shape to test, but the normalizer must not depend on that conversion having
    // happened: a codec that throws must not escape as an unhandled error to the renderer.
    const throwing = {
      decode: () => {
        throw new Error("decoder exploded");
      },
      fromBitmap: () => emptyImage(),
    };
    expect(() => normalizeProductPhoto(fx("shelf.jpg"), throwing)).toThrow();
  });

  it("refuses a decoded image beyond the pixel ceiling", () => {
    const vast = {
      decode: () => ({
        ...emptyImage(),
        isEmpty: () => false,
        getSize: () => ({ width: 30000, height: 30000 }),
      }),
      fromBitmap: () => emptyImage(),
    };
    expect(messageOf(() => normalizeProductPhoto(fx("shelf.jpg"), vast))).toMatch(/too large/);
  });

  it("exposes no Electron or filesystem detail in any refusal message", () => {
    for (const name of ["sample.webp", "corrupt.jpg"]) {
      const m = messageOf(() => normalizeProductPhoto(fx(name), codec));
      expect(m, `${name}: no stack, no path, no errno`).not.toMatch(/ENOENT|Error:|\/|\\\\|nativeImage|undefined/);
    }
  });
});

describe("the output cap and the quality ladder", () => {
  it("steps down the quality ladder before giving up", () => {
    // A codec whose JPEG only fits at the bottom of the ladder. The normalizer must find that
    // rung rather than refuse at the first one.
    const fat = (factor: number) => ({
      decode: () => sized(2400, 1800, false, factor),
      fromBitmap: () => sized(2400, 1800, false, factor),
    });
    const out = normalizeProductPhoto(fx("shelf.jpg"), fat(MAX_NORMALIZED_BYTES / 64));
    expect(out.bytes.length).toBeLessThanOrEqual(MAX_NORMALIZED_BYTES);
  });

  it("falls back to the smaller edge when no quality fits", () => {
    let edgeSeen = 0;
    const codec = {
      decode: () => trackingImage(2400, 1800, (w) => (edgeSeen = w)),
      fromBitmap: () => trackingImage(2400, 1800, (w) => (edgeSeen = w)),
    };
    try {
      normalizeProductPhoto(fx("shelf.jpg"), codec);
    } catch {
      /* expected: nothing fits */
    }
    expect(edgeSeen, "the fallback edge must actually be attempted").toBe(FALLBACK_LONG_EDGE);
  });

  it("refuses rather than storing something over the cap", () => {
    // `factor` is bytes-per-encode, so it has to exceed the cap even at the BOTTOM of the quality
    // ladder (q64 = factor * 0.8) — a factor merely large in absolute terms still fits.
    const over = MAX_NORMALIZED_BYTES * 2;
    const immovable = {
      decode: () => sized(2400, 1800, false, over),
      fromBitmap: () => sized(2400, 1800, false, over),
    };
    expect(messageOf(() => normalizeProductPhoto(fx("shelf.jpg"), immovable))).toMatch(/reasonable size/);
  });

  it("keeps the normalized cap below the schema's own backstop", () => {
    // If these ever crossed, the producer would be handing the service photos it refuses, and the
    // first sign would be an operator seeing INVALID_INPUT on a perfectly good photo.
    expect(MAX_NORMALIZED_BYTES).toBeLessThan(MAX_PRODUCT_IMAGE_BYTES);
  });
});

describe("assertStorable — the producer's own last check", () => {
  const codec = fakeCodec();

  it("passes a real normalized photo", () => {
    expect(() => assertStorable(normalizeProductPhoto(fx("shelf.jpg"), codec))).not.toThrow();
    expect(() => assertStorable(normalizeProductPhoto(fx("logo-alpha.png"), codec))).not.toThrow();
  });

  it("🔴 refuses bytes whose real format contradicts the declared MIME", () => {
    const real = normalizeProductPhoto(fx("shelf.jpg"), codec);
    expect(codeOf(() => assertStorable({ ...real, mime: "image/png" }))).toBe("INVALID_INPUT");
  });

  it("refuses a zero dimension, an empty buffer and an over-cap buffer", () => {
    const real = normalizeProductPhoto(fx("shelf.jpg"), codec);
    expect(codeOf(() => assertStorable({ ...real, widthPx: 0 }))).toBe("INVALID_INPUT");
    expect(codeOf(() => assertStorable({ ...real, bytes: Buffer.alloc(0) }))).toBe("INVALID_INPUT");
    expect(codeOf(() => assertStorable({ ...real, widthPx: 9000 }))).toBe("INVALID_INPUT");
  });
});

// ── small codec stubs used only by the refusal tests above ─────────────────────────────────────

function emptyImage() {
  const e = {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toBitmap: () => Buffer.alloc(0),
    resize: () => e,
    toJPEG: () => Buffer.alloc(0),
    toPNG: () => Buffer.alloc(0),
  };
  return e;
}

/** An image whose encoders produce `factor` bytes per pixel, to drive the cap. */
function sized(width: number, height: number, alpha: boolean, factor: number) {
  const self = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => {
      const b = Buffer.alloc(width * height * 4, 0xff);
      if (alpha) b[b.length - 1] = 0;
      return b;
    },
    resize: ({ width: w, height: h }: { width: number; height: number }) => sized(w, h, alpha, factor),
    toJPEG: (q: number) => {
      const out = Buffer.alloc(Math.max(4, Math.round(factor * (q / 80))), 0x5a);
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(out, 0);
      return out;
    },
    toPNG: () => Buffer.alloc(Math.max(8, Math.round(factor * 4)), 0x5a),
  };
  return self;
}

/** Reports which long edge it was asked for, so the fallback can be observed rather than assumed. */
function trackingImage(width: number, height: number, onResize: (w: number) => void) {
  const self: ReturnType<typeof sized> = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.alloc(width * height * 4, 0xff),
    resize: ({ width: w, height: h }: { width: number; height: number }) => {
      onResize(Math.max(w, h));
      return trackingImage(w, h, onResize);
    },
    toJPEG: () => {
      const out = Buffer.alloc(MAX_NORMALIZED_BYTES + 1, 0x5a);
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(out, 0);
      return out;
    },
    toPNG: () => Buffer.alloc(MAX_NORMALIZED_BYTES + 1, 0x5a),
  };
  return self;
}
