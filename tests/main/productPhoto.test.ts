/**
 * Slice F — the producer itself: the dialog, the read, and what does NOT come back from it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE CENTRAL ASSERTION HERE IS AN ABSENCE, and absences are the easy thing to leave untested.
 *
 * The owner picks `C:\Users\hussein\Pictures\IMG_2041.JPG`. What comes back must contain the bytes
 * and nothing that could ever lead anyone back to that path — not in the returned object, not in
 * the log fields, not in a refusal message an operator reads at the till. The file is allowed to be
 * deleted tomorrow; Alzabt keeps the photo regardless, and nothing may hold a reference to a file
 * that is allowed to vanish.
 *
 * So these tests search EVERY string the producer emits for the path it was given, rather than
 * checking that one named field is absent. A field nobody thought of is exactly how a path leaks.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { MAX_SOURCE_BYTES } from "../../src/main/photoNormalize";
import { PHOTO_EXTENSIONS, createProductPhotoPicker, electronCodec } from "../../src/main/productPhoto";
import { fakeCodec } from "../helpers/fakeCodec";

const FIXTURES = join(__dirname, "..", "fixtures", "photos");
const fx = (name: string): Buffer => readFileSync(join(FIXTURES, name));

/** A Windows path of the shape a real shop produces, username and all. */
const WINDOWS_PATH = "C:\\Users\\hussein\\Pictures\\Camera Roll\\IMG_2041.JPG";

interface Captured {
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

function picker(
  opts: {
    path?: string | null;
    file?: Buffer;
    size?: number;
    readThrows?: boolean;
    sizeThrows?: boolean;
    codec?: ReturnType<typeof fakeCodec>;
  } = {},
): { pick: (productId: string) => unknown; logged: Captured[]; pathsAskedFor: string[] } {
  const logged: Captured[] = [];
  const pathsAskedFor: string[] = [];
  const path = opts.path === undefined ? WINDOWS_PATH : opts.path;
  const file = opts.file ?? fx("shelf.jpg");
  const pick = createProductPhotoPicker({
    chooseFile: () => path,
    fileSize: (p) => {
      pathsAskedFor.push(p);
      if (opts.sizeThrows) throw new Error(`EACCES: permission denied, stat '${p}'`);
      return opts.size ?? file.length;
    },
    readFile: (p) => {
      pathsAskedFor.push(p);
      if (opts.readThrows) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return file;
    },
    codec: opts.codec ?? fakeCodec(),
    log: {
      info: (event, fields) => logged.push({ event, fields: fields ?? {} }),
      warn: (event, fields) => logged.push({ event, fields: fields ?? {} }),
      error: (event, fields) => logged.push({ event, fields: fields ?? {} }),
      file: null,
    },
  });
  return { pick, logged, pathsAskedFor };
}

const thrown = (fn: () => unknown): DomainError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError, nothing was thrown");
};

describe("a successful pick", () => {
  it("returns normalized bytes, a real MIME, real dimensions and a desktop origin", () => {
    const { pick } = picker();
    const photo = pick("p1") as {
      bytes: Buffer;
      mime: string;
      widthPx: number;
      heightPx: number;
      origin: string;
    };
    expect(Buffer.isBuffer(photo.bytes)).toBe(true);
    expect(photo.bytes.length).toBeGreaterThan(0);
    expect(photo.mime).toBe("image/jpeg");
    expect(photo.widthPx).toBe(1600);
    expect(photo.heightPx).toBe(1200);
    expect(photo.origin).toBe("desktop");
  });

  it("normalizes: the bytes it returns are NOT the bytes it read", () => {
    const source = fx("shelf.jpg");
    const { pick } = picker({ file: source });
    const photo = pick("p1") as { bytes: Buffer };
    expect(photo.bytes.equals(source), "handing the source file straight through is not normalizing").toBe(false);
  });

  it("offers only the extensions nativeImage can actually decode", () => {
    // Measured: WEBP does not decode from a buffer. Offering it in the dialog filter would invite
    // a failure the owner could not have predicted.
    expect([...PHOTO_EXTENSIONS].sort()).toEqual(["jpeg", "jpg", "png"]);
    expect(PHOTO_EXTENSIONS).not.toContain("webp");
  });
});

describe("🔴 the source path never comes back", () => {
  const leaks = (value: unknown): boolean => {
    const haystack = JSON.stringify(value, (_k, v) => (Buffer.isBuffer(v) ? `<${v.length} bytes>` : v)) ?? "";
    return (
      haystack.includes("IMG_2041") ||
      haystack.includes("hussein") ||
      haystack.includes("Pictures") ||
      haystack.includes("C:\\\\") ||
      haystack.includes("Camera Roll")
    );
  };

  it("not in the returned photo", () => {
    const { pick } = picker();
    expect(leaks(pick("p1"))).toBe(false);
  });

  it("not in any log field", () => {
    const { pick, logged } = picker();
    pick("p1");
    expect(logged.length, "the normalization should be logged at all").toBeGreaterThan(0);
    for (const line of logged) expect(leaks(line), `leaked via log event '${line.event}'`).toBe(false);
  });

  it("not in the refusal when the file cannot be read — although Node's own error names it", () => {
    // The injected error message contains the full path, the way a real ENOENT does. Passing a
    // cause through, or interpolating `e.message`, would put a username on the till screen.
    const { pick, logged } = picker({ readThrows: true });
    const err = thrown(() => pick("p1"));
    expect(err.code).toBe("INVALID_INPUT");
    expect(leaks(err.message), `refusal message leaked: ${err.message}`).toBe(false);
    for (const line of logged) expect(leaks(line)).toBe(false);
  });

  it("not in the refusal when the file cannot be stat'd", () => {
    const { pick } = picker({ sizeThrows: true });
    const err = thrown(() => pick("p1"));
    expect(err.code).toBe("INVALID_INPUT");
    expect(leaks(err.message)).toBe(false);
  });

  it("not in a refusal from the normalizer either", () => {
    const { pick } = picker({ file: fx("sample.webp") });
    expect(leaks(thrown(() => pick("p1")).message)).toBe(false);
  });

  it("the path IS used, locally — so the test above is not passing by accident", () => {
    // 🔴 THE CONTROL FOR EVERY ASSERTION ABOVE. If the producer never touched the path at all,
    // "the path does not leak" would be true and worthless. It must reach `fileSize`/`readFile`
    // and stop there.
    const { pick, pathsAskedFor } = picker();
    pick("p1");
    expect(pathsAskedFor).toContain(WINDOWS_PATH);
  });
});

describe("cancellation", () => {
  it("answers null, reads nothing, logs nothing", () => {
    const { pick, logged, pathsAskedFor } = picker({ path: null });
    expect(pick("p1")).toBeNull();
    expect(pathsAskedFor, "a cancelled dialog must not touch the filesystem").toEqual([]);
    expect(logged, "a cancelled dialog is not an event worth a line").toEqual([]);
  });

  it("treats an empty path as a cancellation too", () => {
    const { pick, pathsAskedFor } = picker({ path: "" });
    expect(pick("p1")).toBeNull();
    expect(pathsAskedFor).toEqual([]);
  });
});

describe("the size guard runs before the read", () => {
  it("refuses an over-cap file without reading it", () => {
    let read = false;
    const pick = createProductPhotoPicker({
      chooseFile: () => WINDOWS_PATH,
      fileSize: () => MAX_SOURCE_BYTES + 1,
      readFile: () => {
        read = true;
        return fx("shelf.jpg");
      },
      codec: fakeCodec(),
    });
    expect(thrown(() => pick("p1")).message).toMatch(/smaller than 32 MB/);
    expect(read, "a 33 MB file must be refused on its size, not pulled into memory first").toBe(false);
  });
});

describe("electronCodec", () => {
  it("answers an empty image instead of propagating a throw from createFromBuffer", () => {
    const codec = electronCodec({
      createFromBuffer: () => {
        throw new Error("boom");
      },
      createFromBitmap: () => {
        throw new Error("boom");
      },
    });
    expect(codec.decode(Buffer.from([1])).isEmpty()).toBe(true);
    expect(codec.fromBitmap(Buffer.from([1]), { width: 1, height: 1 }).isEmpty()).toBe(true);
  });

  it("passes a real image straight through", () => {
    const stub = {
      isEmpty: () => false,
      getSize: () => ({ width: 4, height: 3 }),
      toBitmap: () => Buffer.alloc(48, 0xff),
      resize: () => stub,
      toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      toPNG: () => Buffer.alloc(8),
    };
    const codec = electronCodec({ createFromBuffer: () => stub, createFromBitmap: () => stub });
    expect(codec.decode(Buffer.from([1])).getSize()).toEqual({ width: 4, height: 3 });
  });
});
