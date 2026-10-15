/**
 * Writing the Online Catalog package to disk — atomically, or not at all.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 A HALF-WRITTEN EXPORT MUST NEVER LOOK LIKE A FINISHED ONE.
 *
 * The merchant's next action after this runs is to upload the folder. A directory that exists,
 * carries a `catalog.json`, and is missing four images because the disk filled up is indisputably
 * worse than no directory at all: the first is uploaded and publishes a broken shop, the second is
 * an error message.
 *
 * So everything is written into a hidden temporary directory INSIDE the chosen parent, verified
 * there, and only then renamed into place. The rename is the commit. Nothing before it produces a
 * success, and nothing after it can fail.
 *
 * 🔴 AND THE TEMP DIRECTORY IS UNDER THE CHOSEN PARENT, NOT THE OS TEMP DIRECTORY. `rename` is
 * atomic only within one filesystem; across volumes it degrades to copy-then-delete, which is
 * exactly the partial state this design exists to prevent. A merchant exporting to a USB stick
 * while the OS temp lives on C: would get the degraded path every time.
 *
 * 🔴 THIS MODULE DOES NO IMAGE PROCESSING. The normalized bytes in SQLite are the source of truth;
 * they are read, verified, and written out byte for byte. Re-encoding here would silently produce
 * a second authoritative image and break the SHA the catalogue publishes.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors";
import { serializeOnlineCatalog, type OnlineCatalogDocument } from "../domain/onlineCatalog";

/** The filesystem operations this writer needs. Injected so every failure point is testable. */
export interface PackageFs {
  mkdir(path: string): void;
  writeFile(path: string, data: Buffer | string): void;
  readFile(path: string): Buffer;
  rename(from: string, to: string): void;
  /** Recursive, best-effort. Must not throw for a path that is already gone. */
  rm(path: string): void;
  exists(path: string): boolean;
  /** Entries of a directory, names only, not recursive. */
  readdir(path: string): string[];
  join(...parts: string[]): string;
}

/** One image the package must carry, as the snapshot described it. */
export interface PackageImageRef {
  readonly file: string;
  readonly imageId: string;
  readonly sha256: string;
}

export interface WriteOnlineCatalogPackageInput {
  /** The folder the owner chose. The package and its temp directory are both created inside it. */
  readonly parentDir: string;
  readonly document: OnlineCatalogDocument;
  readonly images: ReadonlyArray<PackageImageRef>;
  /**
   * Reads one stored photo. The service's `productImageBytes` is the intended implementation: it
   * re-hashes what it read and refuses a mismatch, so a corrupt row fails here rather than being
   * published.
   */
  readonly readImage: (imageId: string) => { readonly bytes: Buffer; readonly mime: string };
  readonly fs: PackageFs;
  /** Distinguishes one export from another. Not required to be deterministic. */
  readonly suffix: () => string;
  readonly log?: { info(event: string, fields?: Record<string, unknown>): void };
}

export interface OnlineCatalogPackageResult {
  readonly folderName: string;
  readonly path: string;
  readonly products: number;
  readonly images: number;
}

export const PACKAGE_PREFIX = "Alzabt-Shop-Export";
export const CATALOG_FILE = "catalog.json";
export const IMAGES_DIR = "images";

/**
 * Everything a finished V1 package may contain, at the top level.
 *
 * 🔴 AN ALLOW-LIST, LIKE THE JSON ITSELF. The verification step refuses an unexpected entry rather
 * than ignoring it, because the only ways one can appear are a bug in this writer or something
 * else writing into our temp directory — and both deserve a refusal, not a shipped surprise.
 */
const ALLOWED_TOP_LEVEL = new Set([CATALOG_FILE, IMAGES_DIR]);

/**
 * Writes the package and returns where it landed.
 *
 * The order is deliberate: images first, then `catalog.json`, then verification, then the rename.
 * Writing the catalogue last means a crash leaves a temp directory with no manifest, which no
 * tool will mistake for a package even if cleanup never runs.
 */
export function writeOnlineCatalogPackage(
  input: WriteOnlineCatalogPackageInput,
): OnlineCatalogPackageResult {
  const { fs } = input;
  if (!fs.exists(input.parentDir)) {
    throw new DomainError("INVALID_INPUT", "That destination folder no longer exists");
  }

  const suffix = input.suffix();
  const folderName = `${PACKAGE_PREFIX}-${suffix}`;
  const finalPath = fs.join(input.parentDir, folderName);
  // 🔴 NEVER OVERWRITE. A previous export is the merchant's own file and may already be published;
  // replacing it silently would destroy the only copy of what the website currently shows.
  if (fs.exists(finalPath)) {
    throw new DomainError("INVALID_INPUT", "An export with that name already exists here");
  }

  const tempPath = fs.join(input.parentDir, `.${PACKAGE_PREFIX.toLowerCase()}-${suffix}.tmp`);
  if (fs.exists(tempPath)) fs.rm(tempPath);

  try {
    fs.mkdir(tempPath);
    fs.mkdir(fs.join(tempPath, IMAGES_DIR));

    // ── images ────────────────────────────────────────────────────────────────────────────────
    const written = new Set<string>();
    for (const ref of input.images) {
      const { bytes, mime } = input.readImage(ref.imageId);
      // 🔴 THE SHA IS CHECKED AGAINST WHAT THE CATALOGUE WILL CLAIM, not only against the row.
      // `readImage` already verified the bytes against their stored checksum; this verifies that
      // the checksum the snapshot put in `catalog.json` is the same one. The two could disagree
      // only if the photo changed between the snapshot and the write, and publishing a hash that
      // does not describe the shipped file is exactly the breakage this export must not produce.
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== ref.sha256) {
        throw new DomainError(
          "LEDGER_INTEGRITY",
          "A product photo changed while the catalogue was being prepared",
        );
      }
      void mime;
      const target = fs.join(tempPath, ...ref.file.split("/"));
      fs.writeFile(target, bytes);
      written.add(ref.file);
    }

    // ── catalog.json ──────────────────────────────────────────────────────────────────────────
    const json = serializeOnlineCatalog(input.document);
    fs.writeFile(fs.join(tempPath, CATALOG_FILE), json);

    // ── verification, before anything becomes visible ─────────────────────────────────────────
    verifyPackage({ fs, tempPath, document: input.document, images: input.images, json });

    // ── the commit ────────────────────────────────────────────────────────────────────────────
    fs.rename(tempPath, finalPath);
    input.log?.info("online-catalog-exported", {
      folder: folderName,
      products: input.document.products.length,
      images: input.images.length,
    });
    return {
      folderName,
      path: finalPath,
      products: input.document.products.length,
      images: input.images.length,
    };
  } catch (error) {
    // 🔴 CLEANUP MUST NOT REPLACE THE REAL ERROR. If removing the temp directory also fails, the
    // operator needs to know why the EXPORT failed — a message about a failed cleanup would hide
    // the actual cause behind a secondary symptom. The cleanup failure is logged, without the
    // path, and the original error is rethrown untouched.
    try {
      fs.rm(tempPath);
    } catch {
      input.log?.info("online-catalog-temp-cleanup-failed", { folder: folderName });
    }
    throw error;
  }
}

/**
 * Everything that must be true before a temp directory is allowed to become a package.
 *
 * Verification reads the files BACK rather than trusting the writes that just happened: a write
 * that silently truncated, a filesystem that reordered, or a name that collided are all invisible
 * to the code that issued the write and obvious to the code that reads it.
 */
function verifyPackage(input: {
  fs: PackageFs;
  tempPath: string;
  document: OnlineCatalogDocument;
  images: ReadonlyArray<PackageImageRef>;
  json: string;
}): void {
  const { fs, tempPath } = input;

  // 1 · the catalogue parses, and is what we meant to write
  const onDisk = fs.readFile(fs.join(tempPath, CATALOG_FILE)).toString("utf8");
  if (onDisk !== input.json) {
    throw new DomainError("INVALID_INPUT", "The catalogue file was not written correctly");
  }
  let parsed: OnlineCatalogDocument;
  try {
    parsed = JSON.parse(onDisk) as OnlineCatalogDocument;
  } catch {
    throw new DomainError("INVALID_INPUT", "The catalogue file is not valid JSON");
  }
  if (parsed.products.length !== input.document.products.length) {
    throw new DomainError("INVALID_INPUT", "The catalogue file is incomplete");
  }

  // 2 · every referenced image exists and hashes to what the catalogue claims
  const expected = new Map(input.images.map((i) => [i.file, i.sha256]));
  for (const product of parsed.products) {
    if (product.image === null) continue;
    const claimed = expected.get(product.image.file);
    if (claimed === undefined || claimed !== product.image.sha256) {
      throw new DomainError("INVALID_INPUT", "A product photo is missing from the package");
    }
    const bytes = fs.readFile(fs.join(tempPath, ...product.image.file.split("/")));
    if (createHash("sha256").update(bytes).digest("hex") !== product.image.sha256) {
      throw new DomainError("LEDGER_INTEGRITY", "A product photo was not written correctly");
    }
  }

  // 3 · no stale or unexpected image file — the package carries exactly what it references
  const imageDir = fs.join(tempPath, IMAGES_DIR);
  const onDiskImages = fs.readdir(imageDir).sort();
  const referenced = [...expected.keys()].map((f) => f.split("/")[1]!).sort();
  if (onDiskImages.length !== referenced.length || onDiskImages.some((n, i) => n !== referenced[i])) {
    throw new DomainError("INVALID_INPUT", "The package contains an unexpected image file");
  }

  // 4 · nothing else at the top level
  for (const entry of fs.readdir(tempPath)) {
    if (!ALLOWED_TOP_LEVEL.has(entry)) {
      throw new DomainError("INVALID_INPUT", "The package contains an unexpected file");
    }
  }
}
