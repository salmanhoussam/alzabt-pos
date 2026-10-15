/**
 * Slice G2 — the package on disk: atomic, verified, and carrying nothing it should not.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THESE TESTS USE A REAL FILESYSTEM, in a real temporary directory, through the real `node:fs`.
 *
 * The writer takes its filesystem as an injected interface, and the temptation is to test it
 * against an in-memory fake. That would prove the writer calls the methods it calls — and nothing
 * about `rename` being atomic, a directory listing being what we think, or a partially written
 * file reading back short. The injection exists so FAILURES can be placed exactly, not so the
 * filesystem can be imaginary: every test below writes real bytes, and the failure tests wrap the
 * real implementation and throw at one chosen call.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { onlineCatalogDocument, onlineCatalogImageFile, onlineCatalogProduct } from "../../src/domain/onlineCatalog";
import {
  CATALOG_FILE,
  IMAGES_DIR,
  PACKAGE_PREFIX,
  writeOnlineCatalogPackage,
  type PackageFs,
} from "../../src/main/onlineCatalogPackage";

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "pos-g2-"));
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

/** The real filesystem, which is what every test here runs against. */
const realFs = (): PackageFs => ({
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  writeFile: (p, d) => writeFileSync(p, d),
  readFile: (p) => readFileSync(p),
  rename: (from, to) => renameSync(from, to),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  exists: (p) => existsSync(p),
  readdir: (p) => readdirSync(p),
  join: (...parts) => join(...parts),
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x31)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 0x32)]);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const ROW = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sku: null,
  barcode: null,
  name_ar: "صنف",
  name_en: null,
  brand: null,
  selling_price_minor: 400n,
  currency: "USD",
  base_unit: "piece",
  description_ar: null,
  description_en: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** A snapshot of N products, the first `withImages` of them photographed. */
function snapshot(ids: string[], photos: Record<string, Buffer> = {}) {
  const images: Array<{ file: string; imageId: string; sha256: string }> = [];
  const products = ids.map((id) => {
    const bytes = photos[id];
    let image = null;
    if (bytes !== undefined) {
      const mime = bytes[0] === 0xff ? ("image/jpeg" as const) : ("image/png" as const);
      const file = onlineCatalogImageFile(id, mime);
      image = { file, mime, sha256: sha(bytes), width: 10, height: 10 };
      images.push({ file, imageId: `img-${id}`, sha256: sha(bytes) });
    }
    return onlineCatalogProduct({ row: ROW(id), category: null, image });
  });
  return { document: onlineCatalogDocument("2026-01-01T00:00:00.000Z", products), images };
}

const readImageFrom =
  (photos: Record<string, Buffer>) =>
  (imageId: string): { bytes: Buffer; mime: string } => {
    const id = imageId.replace(/^img-/, "");
    const bytes = photos[id];
    if (bytes === undefined) throw new DomainError("IMAGE_NOT_FOUND", "That photo is no longer stored");
    return { bytes, mime: bytes[0] === 0xff ? "image/jpeg" : "image/png" };
  };

function writePackage(
  ids: string[],
  photos: Record<string, Buffer> = {},
  over: Partial<Parameters<typeof writeOnlineCatalogPackage>[0]> = {},
) {
  const snap = snapshot(ids, photos);
  return writeOnlineCatalogPackage({
    parentDir: parent,
    document: snap.document,
    images: snap.images,
    readImage: readImageFrom(photos),
    fs: realFs(),
    suffix: () => "20260101-000000-aaaaaa",
    ...over,
  });
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    return `threw ${(e as Error).message}`;
  }
  throw new Error("expected a throw, nothing was thrown");
};

describe("the package that lands on disk", () => {
  it("writes catalog.json and exactly the referenced images, and nothing else", () => {
    const result = writePackage(["manual:1", "manual:2", "manual:3"], {
      "manual:1": JPEG,
      "manual:3": PNG,
    });
    expect(result.products).toBe(3);
    expect(result.images).toBe(2);
    expect(result.folderName).toBe(`${PACKAGE_PREFIX}-20260101-000000-aaaaaa`);

    expect(readdirSync(result.path).sort()).toEqual([CATALOG_FILE, IMAGES_DIR]);
    const files = readdirSync(join(result.path, IMAGES_DIR)).sort();
    expect(files).toHaveLength(2);
    for (const name of files) expect(name).toMatch(/^product-[0-9a-f]{64}\.(jpg|png)$/);

    const parsed = JSON.parse(readFileSync(join(result.path, CATALOG_FILE), "utf8")) as {
      schema_version: number;
      products: Array<{ id: string; image: { file: string; sha256: string } | null }>;
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.products.map((p) => p.id)).toEqual(["manual:1", "manual:2", "manual:3"]);
    expect(parsed.products[1]!.image).toBeNull();
  });

  it("🔴 writes the EXACT stored bytes — no re-encoding, and the hash proves it", () => {
    const result = writePackage(["manual:1"], { "manual:1": JPEG });
    const file = (JSON.parse(readFileSync(join(result.path, CATALOG_FILE), "utf8")) as {
      products: Array<{ image: { file: string; sha256: string } }>;
    }).products[0]!.image;
    const onDisk = readFileSync(join(result.path, ...file.file.split("/")));
    expect(onDisk.equals(JPEG)).toBe(true);
    expect(sha(onDisk)).toBe(file.sha256);
    expect(sha(onDisk)).toBe(sha(JPEG));
  });

  it("leaves no temp directory behind on success", () => {
    writePackage(["manual:1"], { "manual:1": JPEG });
    expect(readdirSync(parent).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(readdirSync(parent)).toHaveLength(1);
  });

  it("🔴 refuses to overwrite an existing export", () => {
    writePackage(["manual:1"]);
    expect(codeOf(() => writePackage(["manual:1"]))).toBe("INVALID_INPUT");
    // And the first one is untouched.
    expect(readdirSync(parent)).toHaveLength(1);
  });

  it("refuses a destination that has gone", () => {
    rmSync(parent, { recursive: true, force: true });
    expect(codeOf(() => writePackage(["manual:1"]))).toBe("INVALID_INPUT");
  });

  it("a package with no eligible products is still a valid package", () => {
    const result = writePackage([]);
    expect(result.products).toBe(0);
    expect(readdirSync(join(result.path, IMAGES_DIR))).toEqual([]);
    expect(JSON.parse(readFileSync(join(result.path, CATALOG_FILE), "utf8")).products).toEqual([]);
  });
});

describe("determinism at the package level", () => {
  it("🔴 the same state and the same clock produce identical bytes and identical names", () => {
    const photos = { "manual:2": JPEG, "manual:1": PNG };
    const a = writePackage(["manual:1", "manual:2"], photos);
    const movedA = join(parent, "first");
    renameSync(a.path, movedA);
    const b = writePackage(["manual:1", "manual:2"], photos);

    const read = (root: string) => ({
      json: readFileSync(join(root, CATALOG_FILE), "utf8"),
      names: readdirSync(join(root, IMAGES_DIR)).sort(),
      bytes: readdirSync(join(root, IMAGES_DIR))
        .sort()
        .map((n) => sha(readFileSync(join(root, IMAGES_DIR, n)))),
    });
    expect(read(b.path)).toEqual(read(movedA));
  });

  it("filesystem enumeration order does not decide JSON order", () => {
    // Written in one order, listed in another — the catalogue is still sorted by id.
    const result = writePackage(["manual:3", "manual:1", "manual:2"]);
    const parsed = JSON.parse(readFileSync(join(result.path, CATALOG_FILE), "utf8")) as {
      products: Array<{ id: string }>;
    };
    expect(parsed.products.map((p) => p.id)).toEqual(["manual:1", "manual:2", "manual:3"]);
  });
});

describe("🔴 corrupt or missing photos fail the WHOLE export", () => {
  it("fails when the stored bytes are gone — it does not quietly export image: null", () => {
    const snap = snapshot(["manual:1"], { "manual:1": JPEG });
    const code = codeOf(() =>
      writeOnlineCatalogPackage({
        parentDir: parent,
        document: snap.document,
        images: snap.images,
        readImage: () => {
          throw new DomainError("IMAGE_NOT_FOUND", "That photo is no longer stored");
        },
        fs: realFs(),
        suffix: () => "s",
      }),
    );
    expect(code).toBe("IMAGE_NOT_FOUND");
    expect(readdirSync(parent)).toEqual([]);
  });

  it("fails when the bytes do not match the sha the catalogue claims", () => {
    const snap = snapshot(["manual:1"], { "manual:1": JPEG });
    const code = codeOf(() =>
      writeOnlineCatalogPackage({
        parentDir: parent,
        document: snap.document,
        images: snap.images,
        // A different photo than the one the snapshot described — the shape of a photo replaced
        // between the snapshot and the write.
        readImage: () => ({ bytes: PNG, mime: "image/png" }),
        fs: realFs(),
        suffix: () => "s",
      }),
    );
    expect(code).toBe("LEDGER_INTEGRITY");
    expect(readdirSync(parent)).toEqual([]);
  });

  it("🔴 fails BEFORE writing a single image file when the photo changed", () => {
    // 🔴 THIS ISOLATES THE PRE-WRITE CHECK. Two layers verify the bytes — one before writing, one
    // by reading the file back — and a mutation showed they MASK each other: removing either one
    // left every test green, because the other caught the same case. Neither was individually
    // tested. This one defeats the second layer's relevance by asserting on a side effect it
    // cannot produce: if the pre-write check is gone, a file gets written before verification
    // runs, and `wrote` is no longer empty.
    const snap = snapshot(["manual:1"], { "manual:1": JPEG });
    const base = realFs();
    const wrote: string[] = [];
    const fs: PackageFs = {
      ...base,
      writeFile: (path, data) => {
        wrote.push(path);
        base.writeFile(path, data);
      },
    };
    const code = codeOf(() =>
      writeOnlineCatalogPackage({
        parentDir: parent,
        document: snap.document,
        images: snap.images,
        readImage: () => ({ bytes: PNG, mime: "image/png" }),
        fs,
        suffix: () => "s",
      }),
    );
    expect(code).toBe("LEDGER_INTEGRITY");
    expect(wrote, "nothing may be written once the photo is known to have changed").toEqual([]);
  });

  it("🔴 catches a write that SILENTLY TRUNCATES an image", () => {
    // 🔴 AND THIS ISOLATES THE READ-BACK CHECK. Here the bytes handed over are correct, so the
    // pre-write comparison passes; the filesystem is what corrupts them. Only reading the file
    // back and hashing it can see this — which is why the writer does not trust its own writes.
    const base = realFs();
    const fs: PackageFs = {
      ...base,
      writeFile: (path, data) =>
        base.writeFile(path, typeof data === "string" ? data : (data as Buffer).subarray(0, 8)),
    };
    expect(codeOf(() => writePackage(["manual:1"], { "manual:1": JPEG }, { fs }))).toBe("LEDGER_INTEGRITY");
    expect(readdirSync(parent)).toEqual([]);
  });

  it("CONTROL — a product that truthfully has NO photo exports fine", () => {
    const result = writePackage(["manual:1"]);
    expect(JSON.parse(readFileSync(join(result.path, CATALOG_FILE), "utf8")).products[0].image).toBeNull();
  });
});

describe("🔴 failure injection — nothing partial ever becomes visible", () => {
  /** The real filesystem, with one named call throwing the Nth time it is used. */
  const failingFs = (method: keyof PackageFs, nth = 1): PackageFs => {
    const base = realFs();
    let seen = 0;
    return {
      ...base,
      [method]: (...args: unknown[]) => {
        seen += 1;
        if (seen === nth) throw new Error(`injected ${method} failure`);
        return (base[method] as (...a: unknown[]) => unknown)(...args);
      },
    } as PackageFs;
  };

  const cases: Array<[string, PackageFs]> = [
    ["mkdir", failingFs("mkdir")],
    ["first image write", failingFs("writeFile", 1)],
    ["later image write", failingFs("writeFile", 2)],
    ["catalog.json write", failingFs("writeFile", 3)],
    ["verification read", failingFs("readFile", 1)],
    ["final rename", failingFs("rename")],
  ];

  for (const [name, fs] of cases) {
    it(`${name} leaves NO package and NO temp directory`, () => {
      const photos = { "manual:1": JPEG, "manual:2": PNG };
      let threw = false;
      try {
        writePackage(["manual:1", "manual:2"], photos, { fs });
      } catch {
        threw = true;
      }
      expect(threw, `${name} must fail the export`).toBe(true);
      // 🔴 THE DIRECTORY IS EMPTY — no final package, and no leftover temp either.
      expect(readdirSync(parent), `${name} left something behind`).toEqual([]);
    });
  }

  it("🔴 a failing CLEANUP does not replace the real error", () => {
    const base = realFs();
    const fs: PackageFs = {
      ...base,
      rename: () => {
        throw new Error("injected rename failure");
      },
      rm: () => {
        throw new Error("injected cleanup failure");
      },
    };
    let message = "";
    try {
      writePackage(["manual:1"], { "manual:1": JPEG }, { fs });
    } catch (e) {
      message = (e as Error).message;
    }
    // The operator must be told why the EXPORT failed, not why a tidy-up failed afterwards.
    expect(message).toBe("injected rename failure");
    expect(message).not.toContain("cleanup");
  });

  it("a previous successful export is untouched by a later failure", () => {
    const first = writePackage(["manual:1"], { "manual:1": JPEG });
    const before = readdirSync(first.path).sort();
    try {
      writePackage(["manual:2"], { "manual:2": PNG }, {
        fs: { ...realFs(), rename: () => { throw new Error("injected"); } },
        suffix: () => "second",
      });
    } catch {
      /* expected */
    }
    expect(readdirSync(first.path).sort()).toEqual(before);
    expect(existsSync(join(first.path, CATALOG_FILE))).toBe(true);
  });
});

describe("🔴 the package allow-list", () => {
  it("refuses an unexpected top-level entry", () => {
    const base = realFs();
    const fs: PackageFs = {
      ...base,
      // Something else writes into the temp directory just before verification.
      readdir: (p) => {
        const entries = base.readdir(p);
        return p.endsWith(".tmp") ? [...entries, "ledger.sqlite"] : entries;
      },
    };
    expect(codeOf(() => writePackage(["manual:1"], {}, { fs }))).toBe("INVALID_INPUT");
    expect(readdirSync(parent)).toEqual([]);
  });

  it("🔴 refuses a STALE image file the catalogue does not reference", () => {
    // The shape of a replaced or removed photo leaking out of an earlier run.
    const base = realFs();
    let seeded = false;
    const fs: PackageFs = {
      ...base,
      readFile: (p) => {
        if (!seeded && p.endsWith(CATALOG_FILE)) {
          seeded = true;
          const dir = p.replace(CATALOG_FILE, IMAGES_DIR);
          writeFileSync(join(dir, "product-stale.jpg"), JPEG);
        }
        return base.readFile(p);
      },
    };
    expect(codeOf(() => writePackage(["manual:1"], { "manual:1": JPEG }, { fs }))).toBe("INVALID_INPUT");
    expect(readdirSync(parent)).toEqual([]);
  });

  it("refuses a catalogue that reads back different from what was written", () => {
    const base = realFs();
    const fs: PackageFs = {
      ...base,
      readFile: (p) => (p.endsWith(CATALOG_FILE) ? Buffer.from("{}\n") : base.readFile(p)),
    };
    expect(codeOf(() => writePackage(["manual:1"], {}, { fs }))).toBe("INVALID_INPUT");
  });

  it("no .sqlite, .wal, .shm, .log or backup file can appear in a successful package", () => {
    const result = writePackage(["manual:1", "manual:2"], { "manual:1": JPEG, "manual:2": PNG });
    const everything = [
      ...readdirSync(result.path),
      ...readdirSync(join(result.path, IMAGES_DIR)),
    ];
    for (const name of everything) {
      expect(name).not.toMatch(/\.(sqlite|wal|shm|log|bak|tmp)$/i);
    }
    expect(everything.filter((n) => n === CATALOG_FILE || n === IMAGES_DIR || /^product-/.test(n))).toHaveLength(
      everything.length,
    );
  });
});

describe("the temp directory lives under the chosen parent", () => {
  it("🔴 so the final rename never crosses a filesystem", () => {
    // Observed directly: the path handed to `mkdir` must be inside the parent the owner chose.
    const seen: string[] = [];
    const base = realFs();
    const fs: PackageFs = {
      ...base,
      mkdir: (p) => {
        seen.push(p);
        base.mkdir(p);
      },
    };
    writePackage(["manual:1"], {}, { fs });
    // 🔴 THE CLAIM IS THAT THE TEMP DIRECTORY'S PARENT **IS** THE CHOSEN PARENT — a direct child,
    // not merely somewhere underneath it and not somewhere else entirely. An earlier version of
    // this test asserted the path did not contain the OS temp directory, which is meaningless
    // here: the chosen parent in this test IS under the OS temp directory, so the assertion was
    // either trivially false or trivially true depending on where the test ran.
    expect(dirname(seen[0]!)).toBe(parent);
    expect(seen[0]).toMatch(/\.alzabt-shop-export-.*\.tmp$/);
    // And the final package is a sibling of it, so the rename stays within one filesystem.
    expect(dirname(join(parent, `${PACKAGE_PREFIX}-x`))).toBe(dirname(seen[0]!));
  });

  it("a leftover temp directory from a crashed run is replaced, not merged", () => {
    const stale = join(parent, `.${PACKAGE_PREFIX.toLowerCase()}-20260101-000000-aaaaaa.tmp`);
    mkdirSync(join(stale, IMAGES_DIR), { recursive: true });
    writeFileSync(join(stale, IMAGES_DIR, "product-ghost.jpg"), JPEG);
    const result = writePackage(["manual:1"], { "manual:1": JPEG });
    expect(readdirSync(join(result.path, IMAGES_DIR))).toHaveLength(1);
    expect(readdirSync(join(result.path, IMAGES_DIR))[0]).not.toBe("product-ghost.jpg");
  });
});

describe("unique suffixes", () => {
  it("two exports in the same parent do not collide", () => {
    const a = writePackage(["manual:1"], {}, { suffix: () => randomUUID().slice(0, 8) });
    const b = writePackage(["manual:1"], {}, { suffix: () => randomUUID().slice(0, 8) });
    expect(a.folderName).not.toBe(b.folderName);
    expect(readdirSync(parent).sort()).toEqual([a.folderName, b.folderName].sort());
  });

  it("the folder name is Windows-safe", () => {
    const result = writePackage(["manual:1"], {}, { suffix: () => "20260101-123000-ab12cd" });
    expect(result.folderName).toMatch(/^[A-Za-z0-9.-]+$/);
    expect(result.folderName).not.toContain(":");
  });
});
