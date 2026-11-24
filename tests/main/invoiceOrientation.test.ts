/**
 * PHONE-INVOICE-ORIENTATION-01: the upright reading copy — EXIF applied once, operator turns on top,
 * no double rotation, upright photos untouched. A real JPEG/EXIF header (the parser is real) over a
 * fake bitmap codec, so every pixel's destination is checkable.
 */
import { describe, expect, it } from "vitest";
import { normalizeTurns, turnsToOrientation, uprightForReading, uprightThumbnail } from "../../src/main/invoiceOrientation";
import type { DecodedImage, ImageCodec } from "../../src/main/photoNormalize";

/** A minimal JPEG prefix: SOI + APP1 Exif with Orientation = o (or no APP1 when o is null). */
function jpeg(o: number | null): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  if (o === null) return Buffer.concat([soi, Buffer.from([0xff, 0xd9])]);
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([soi, Buffer.from([0xff, 0xe1]), len, payload, Buffer.from([0xff, 0xd9])]);
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

/** A width×height image whose pixel (x,y) carries the value 10*y + x in its blue byte. */
function image(width: number, height: number, bgra?: Buffer): DecodedImage {
  const data = bgra ?? Buffer.alloc(width * height * 4);
  if (!bgra) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4] = 10 * y + x;
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => data,
    resize: () => image(width, height, data),
    toJPEG: () => Buffer.concat([Buffer.from(`${width}x${height}:`), Buffer.from([...Array(width * height)].map((_, i) => data[i * 4]!))]),
    toPNG: () => Buffer.alloc(0),
    isEmpty: () => false,
  };
}
const codec = (w: number, h: number): ImageCodec => ({ decode: () => image(w, h), fromBitmap: (b, s) => image(s.width, s.height, b) });
/** Decode the fake toJPEG output: "WxH:" then one value per pixel, row-major. */
const grid = (buf: Buffer | null) => {
  const s = buf!.toString("binary");
  const [w, h] = s.slice(0, s.indexOf(":")).split("x").map(Number);
  const v = [...buf!.subarray(s.indexOf(":") + 1)];
  return { w, h, rows: Array.from({ length: h! }, (_, y) => v.slice(y * w!, y * w! + w!)) };
};

describe("uprightForReading", () => {
  it("an upright photo (no EXIF tag, no turn) is read EXACTLY as before — no copy", () => {
    expect(uprightForReading(jpeg(null), 0, codec(3, 2)).jpeg).toBeNull();
    expect(uprightForReading(jpeg(1), 0, codec(3, 2)).jpeg).toBeNull();
  });
  it("🔴 EXIF 6 (a portrait phone photo stored sideways) is turned 90° clockwise, ONCE", () => {
    const r = uprightForReading(jpeg(6), 0, codec(3, 2));
    expect(r.exifOrientation).toBe(6);
    const g = grid(r.jpeg);
    // source rows [0,1,2] / [10,11,12] → turned clockwise: [10,0] / [11,1] / [12,2]
    expect([g.w, g.h]).toEqual([2, 3]);
    expect(g.rows).toEqual([[10, 0], [11, 1], [12, 2]]);
  });
  it("🔴 no double rotation: EXIF 6 then one LEFT turn gives back the stored pixels", () => {
    const g = grid(uprightForReading(jpeg(6), -1, codec(3, 2)).jpeg);
    expect(g.rows).toEqual([[0, 1, 2], [10, 11, 12]]);
  });
  it("physically rotated pixels (no tag): the operator's right turn rotates the real image", () => {
    const r = uprightForReading(jpeg(null), 1, codec(3, 2));
    expect(r.turns).toBe(1);
    expect(grid(r.jpeg).rows).toEqual([[10, 0], [11, 1], [12, 2]]);
    expect(grid(uprightForReading(jpeg(null), 2, codec(3, 2)).jpeg).rows).toEqual([[12, 11, 10], [2, 1, 0]]);
  });
  it("a PNG has no EXIF: only the operator's turns apply", () => {
    expect(uprightForReading(PNG, 0, codec(3, 2)).jpeg).toBeNull();
    expect(grid(uprightForReading(PNG, 3, codec(3, 2)).jpeg).rows).toEqual([[2, 12], [1, 11], [0, 10]]);
  });
  it("refuses what is not a JPEG or PNG (an iPhone HEIC file is refused, never guessed)", () => {
    expect(() => uprightForReading(Buffer.from("....ftypheic"), 0, codec(3, 2))).toThrow();
  });
  it("turn arithmetic", () => {
    expect([normalizeTurns(-1), normalizeTurns(4), normalizeTurns(5)]).toEqual([3, 0, 1]);
    expect([0, 1, 2, 3].map((t) => turnsToOrientation(t as 0 | 1 | 2 | 3))).toEqual([1, 6, 3, 8]);
  });
});

describe("uprightThumbnail", () => {
  it("applies the same EXIF + turn rules to the small queue image", () => {
    expect(grid(uprightThumbnail(jpeg(6), 0, codec(3, 2))).rows).toEqual([[10, 0], [11, 1], [12, 2]]);
    expect(grid(uprightThumbnail(jpeg(6), -1, codec(3, 2))).rows).toEqual([[0, 1, 2], [10, 11, 12]]);
  });
});
