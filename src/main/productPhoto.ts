/**
 * The desktop product-photo producer: the one place a file on this PC becomes a product photo.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE SOURCE PATH NEVER LEAVES THIS FUNCTION.
 *
 * The owner chooses a file; this reads it, normalizes it (photoNormalize.ts) and returns BYTES.
 * The path is not returned, not logged, not stored and not audited — not because a path is secret,
 * but because the authoritative photo is the copy in SQLite, and the original may well be deleted
 * the day after it is imported. A stored path would be a reference to a file that is allowed to
 * vanish, and anything later resolving it would be a filesystem read primitive driven by old data.
 *
 * That is the same reasoning `pickInvoiceLogo` has followed since migration 6, and the same
 * reasoning behind the channel itself accepting no path from the renderer.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything is injected so the whole producer is testable without Electron and without a dialog.
 * `electronCodec` is the only part that touches `nativeImage`, and it is four one-line methods.
 */
import type { PickedPhoto } from "./ipcHandlers";
import type { Logger } from "./logger";
import { DomainError } from "../domain/errors";
import {
  MAX_SOURCE_BYTES,
  assertStorable,
  normalizeProductPhoto,
  type DecodedImage,
  type ImageCodec,
} from "./photoNormalize";

/** The extensions offered in the dialog. The filter is a convenience; the sniff is the check. */
export const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png"] as const;

export interface PhotoPickerDeps {
  /** Shows the native picker. Returns an absolute path, or null when the owner cancelled. */
  readonly chooseFile: () => string | null;
  /** Size in bytes, read without reading the file. */
  readonly fileSize: (path: string) => number;
  readonly readFile: (path: string) => Buffer;
  readonly codec: ImageCodec;
  readonly log?: Logger;
}

/**
 * Builds the `pickProductPhoto` the IPC layer expects.
 *
 * Cancellation answers `null`, which the handler already treats as "nothing happened": no service
 * call, no database write, no audit event. A refusal throws a `DomainError`, which the handler's
 * `wrap` turns into a coded failure the renderer can show — never a raw Electron message.
 */
export function createProductPhotoPicker(deps: PhotoPickerDeps): (productId: string) => PickedPhoto | null {
  return (productId: string): PickedPhoto | null => {
    const path = deps.chooseFile();
    if (path === null || path === "") return null;

    // Checked BEFORE the read, so a 4 GB file someone renamed to .jpg is refused without being
    // pulled into memory first. `normalizeProductPhoto` checks the same cap on the buffer it is
    // given — this is the cheap guard, that is the honest one.
    let declaredSize: number;
    try {
      declaredSize = deps.fileSize(path);
    } catch {
      throw new DomainError("INVALID_INPUT", "That file could not be read");
    }
    if (declaredSize > MAX_SOURCE_BYTES) {
      throw new DomainError(
        "INVALID_INPUT",
        `Choose an image smaller than ${Math.floor(MAX_SOURCE_BYTES / (1024 * 1024))} MB`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = deps.readFile(path);
    } catch {
      // 🔴 THE MESSAGE CARRIES NO PATH AND NO UNDERLYING ERROR. An ENOENT from Node names the
      // file, which would put a username and folder layout in front of whoever is standing at the
      // till — and into the log, if it were logged.
      throw new DomainError("INVALID_INPUT", "That file could not be read");
    }

    const photo = assertStorable(normalizeProductPhoto(bytes, deps.codec));
    deps.log?.info("product-photo-normalized", {
      productId,
      sourceMime: photo.sourceMime,
      sourceWidthPx: photo.sourceWidthPx,
      sourceHeightPx: photo.sourceHeightPx,
      exifOrientation: photo.exifOrientation,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      bytes: photo.bytes.length,
      sourceBytes: bytes.length,
    });
    return {
      bytes: photo.bytes,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      // Chosen from this PC by the owner. The phone path is slice H and will say "phone".
      origin: "desktop",
    };
  };
}

/**
 * Electron's `nativeImage`, as the four operations `photoNormalize` needs.
 *
 * 🔴 `createFromBuffer` IS WRAPPED, NOT TRUSTED TO THROW. Measured: it answers an EMPTY image for
 * every kind of rubbish, including a 676-megapixel decompression bomb. The try/catch here is for
 * the case it ever does throw; `isEmpty()` upstream is what actually catches the measured
 * behaviour. Both, because relying on either alone was the wrong instinct in one direction or the
 * other.
 */
export function electronCodec(nativeImage: {
  createFromBuffer: (b: Buffer) => DecodedImage;
  createFromBitmap: (b: Buffer, o: { width: number; height: number }) => DecodedImage;
}): ImageCodec {
  return {
    decode: (bytes) => {
      try {
        return nativeImage.createFromBuffer(bytes);
      } catch {
        return EMPTY_IMAGE;
      }
    },
    fromBitmap: (bgra, size) => {
      try {
        return nativeImage.createFromBitmap(bgra, size);
      } catch {
        return EMPTY_IMAGE;
      }
    },
  };
}

/** The one shape "this did not decode" takes, so callers test `isEmpty()` and nothing else. */
const EMPTY_IMAGE: DecodedImage = {
  isEmpty: () => true,
  getSize: () => ({ width: 0, height: 0 }),
  toBitmap: () => Buffer.alloc(0),
  resize: () => EMPTY_IMAGE,
  toJPEG: () => Buffer.alloc(0),
  toPNG: () => Buffer.alloc(0),
};
