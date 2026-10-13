/**
 * What a product photo is allowed to be. Pure: no I/O, no decoding, no Electron.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE IS A BACKSTOP, NOT A VALIDATOR, AND THE DIFFERENCE MATTERS.
 *
 * It can prove that a MIME string is one of two values and that a buffer is neither empty nor
 * absurdly large. It CANNOT prove that these bytes are a JPEG, that they decode, or that they
 * really are 800×600 — that needs a decoder, which is slice F's `nativeImage` pipeline in the main
 * process. Anything here passing is therefore necessary and not sufficient.
 *
 * Stated plainly because the opposite reading is the dangerous one: a reviewer who takes these
 * checks for "the image is validated" would conclude the producer needs none.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { DomainError } from "./errors";

/** The two formats the schema's own CHECK admits. Kept in step with migration 9 by name. */
export const IMAGE_MIMES = ["image/jpeg", "image/png"] as const;
export type ImageMimeValue = (typeof IMAGE_MIMES)[number];

/** Where the photo came from. Carried so a shop can tell a desktop import from a phone capture. */
export const IMAGE_ORIGINS = ["desktop", "phone"] as const;
export type ImageOriginValue = (typeof IMAGE_ORIGINS)[number];

/**
 * 2 MB, which is generous for a normalized catalog photo and refuses an un-normalized one.
 *
 * The number is a guard against an unprocessed 12-megapixel phone capture reaching SQLite — where
 * it would also land in every backup, forever. A normalized 1200px JPEG is tens of kilobytes; a
 * photo near this cap means the producer did not normalize, which is a defect in the producer.
 */
export const MAX_PRODUCT_IMAGE_BYTES = 2 * 1024 * 1024;

/** No edge beyond this. Same reasoning: a sane normalized photo is far below it. */
export const MAX_PRODUCT_IMAGE_EDGE = 8192;

export function imageMime(value: unknown): ImageMimeValue {
  if (typeof value !== "string" || !(IMAGE_MIMES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_INPUT", "A product photo must be a JPEG or a PNG");
  }
  return value as ImageMimeValue;
}

export function imageOrigin(value: unknown): ImageOriginValue {
  if (typeof value !== "string" || !(IMAGE_ORIGINS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_INPUT", "A photo's origin must be 'desktop' or 'phone'");
  }
  return value as ImageOriginValue;
}

/** Refuses an empty buffer and one over the cap. Says nothing about whether it decodes. */
export function imageBytes(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new DomainError("INVALID_INPUT", "That photo is empty");
  }
  if (value.length > MAX_PRODUCT_IMAGE_BYTES) {
    throw new DomainError(
      "INVALID_INPUT",
      `A product photo must be at most ${Math.floor(MAX_PRODUCT_IMAGE_BYTES / 1024)} KB`,
    );
  }
  return value;
}

/** A declared pixel dimension. Refuses a float, a zero, a negative and an absurd value. */
export function imageEdge(value: unknown, field: "width" | "height"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_PRODUCT_IMAGE_EDGE) {
    throw new DomainError("INVALID_INPUT", `A photo's ${field} must be between 1 and ${MAX_PRODUCT_IMAGE_EDGE}`);
  }
  return value;
}
