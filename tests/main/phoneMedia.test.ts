/**
 * Phone media: staging a photo, saving it atomically with the product, and the refusals.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO CLAIMS THESE TESTS EXIST FOR.
 *
 * 1 · UPLOADING IS NOT SAVING. A photo that reached the till must leave no durable trace until the
 *     merchant presses Save — no row, no file, nothing to orphan when they walk away. So the image
 *     table is counted before and after every upload, not only at the end.
 *
 * 2 · THE PRODUCT AND ITS PHOTO COMMIT TOGETHER. A product created WITHOUT the photo the merchant
 *     asked for, reported as a success, is the failure this slice had to design against — and the
 *     test injects a real failure in the photo half to prove the product half rolls back with it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces as realInterfaces } from "node:os";
import { PhoneSessionBridge } from "../../src/main/phoneSessionBridge";
import { assertStorable, normalizeProductPhoto } from "../../src/main/photoNormalize";
import { decodeBarcodePhoto } from "../../src/main/phoneBarcode";
import { fakeCodec } from "../helpers/fakeCodec";
import type { NetworkInterfaceMap } from "../../src/main/lanAddress";
import { makeHarness, tempDir, type Harness } from "../helpers/harness";
import { DomainError } from "../../src/domain/errors";

const OWNER = { cashierId: "cashier-01", pin: "1111" };
const TOKEN = "b".repeat(64);
const PHOTOS = join(__dirname, "..", "fixtures", "photos");
const BARCODES = join(__dirname, "..", "fixtures", "barcodes");

const LAN = (() => {
  for (const addrs of Object.values(realInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !/^127\./.test(a.address)) return a.address;
    }
  }
  return null;
})();
const IFACES: NetworkInterfaceMap = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: LAN ?? "127.0.0.1", family: "IPv4", internal: false }],
};

interface Reply {
  readonly status: number;
  json: () => Record<string, unknown>;
}

function request(
  host: string,
  port: number,
  method: string,
  path: string,
  body?: Buffer | string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const base: Record<string, string> = {
      Host: `${host}:${port}`,
      "User-Agent": "iPhone",
      "Content-Length": String(payload.length),
      Connection: "close",
      ...headers,
    };
    const head =
      `${method} ${path} HTTP/1.1\r\n` +
      Object.entries(base)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n";
    const socket: Socket = connect({ host, port }, () => {
      socket.write(head);
      if (payload.length) socket.write(payload);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0);
      const split = data.indexOf("\r\n\r\n");
      const text = split >= 0 ? data.slice(split + 4) : "";
      resolve({
        status,
        json: () => {
          try {
            return JSON.parse(text);
          } catch {
            return {};
          }
        },
      });
    });
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error("timed out talking to the phone listener"));
    });
  });
}

/** The served page's HTML — `request` keeps only the status, so this reads the body. */
async function rawPage(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host, port }, () =>
      socket.write(
        `GET /m/${TOKEN} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: iPhone\r\nConnection: close\r\n\r\n`,
      ),
    );
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const split = data.indexOf("\r\n\r\n");
      resolve(split >= 0 ? data.slice(split + 4) : "");
    });
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error("timed out reading the phone page"));
    });
  });
}

const submission = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    product: { nameAr: "مفتاح", nameEn: "", sku: "", price: "12.50", baseUnit: "piece", ...(over.product ?? {}) },
    master: {
      categoryId: "",
      barcode: "",
      brand: "",
      descriptionAr: "",
      descriptionEn: "",
      isOnlineVisible: false,
      ...(over.master ?? {}),
    },
  });

const countImages = (h: Harness) =>
  Number((h.db.prepare("SELECT count(*) AS n FROM catalog_product_images").get() as { n: number | bigint }).n);
const countProducts = (h: Harness) =>
  Number((h.db.prepare("SELECT count(*) AS n FROM catalog_products").get() as { n: number | bigint }).n);

interface Fixture {
  readonly h: Harness;
  readonly bridge: PhoneSessionBridge;
  readonly cleanup: () => Promise<void>;
}

/**
 * 🔴 THE REAL F PIPELINE, WITH THE SHARED FAKE CODEC. `normalizeProductPhoto` + `assertStorable`
 * are the production functions, unmodified — only the Electron `nativeImage` codec is substituted,
 * because `nativeImage` is undefined without a display. So every rule under test (sniffing,
 * decode-result validation, orientation, resize, the ladder, the caps) is F's own.
 */
function fixture(over: { normalizePhoto?: (b: Buffer) => never | ReturnType<typeof assertStorable> } = {}): Fixture {
  const t = tempDir();
  const h = makeHarness(t.dbPath, { login: false });
  const codec = fakeCodec();
  const bridge = new PhoneSessionBridge({
    service: h.service,
    interfaces: () => IFACES,
    randomToken: () => TOKEN,
    renderQr: async () => "<svg/>",
    normalizePhoto: over.normalizePhoto ?? ((bytes) => assertStorable(normalizeProductPhoto(bytes, codec))),
    decodeBarcode: (bytes) => decodeBarcodePhoto(bytes),
  });
  return {
    h,
    bridge,
    cleanup: async () => {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    },
  };
}

async function openSession(f: Fixture, action: "NEW_PRODUCT" | "EDIT_PRODUCT" = "NEW_PRODUCT", productId: string | null = null) {
  f.h.service.login(OWNER.cashierId, OWNER.pin);
  const dto = await f.bridge.start(f.h.service.authorizePhoneSession(action, productId));
  await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
  return dto;
}

describe("uploading a photo stages it — and changes nothing durable", () => {
  it("a valid JPEG is accepted and reported back without bytes or a path", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const before = countImages(f.h);

      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}/photo`,
        readFileSync(join(PHOTOS, "shelf.jpg")),
        { "Content-Type": "image/jpeg" },
      );
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.staged).toBe(true);
      expect(body.mime).toBe("image/jpeg");
      expect(Number(body.widthPx)).toBeGreaterThan(0);

      // 🔴 NOTHING DURABLE. The image table is untouched and no product exists yet.
      expect(countImages(f.h)).toBe(before);
      expect(f.bridge.hasStagedPhoto()).toBe(true);

      // 🔴 AND THE ANSWER LEAKS NOTHING: no bytes, no path, no filename, no token.
      const json = JSON.stringify(body);
      expect(json).not.toContain("shelf");
      expect(json).not.toContain(".jpg");
      expect(json).not.toContain(TOKEN);
      // 🔴 Not "no slash at all" — `image/jpeg` legitimately contains one. What must be absent is
      // anything that looks like a FILESYSTEM path or a temp location.
      expect(json).not.toMatch(/[A-Za-z]:\\\\|\/home\/|\/tmp\/|\/var\/|\\\\Users\\\\/);
      expect(json).not.toMatch(/base64/i);
      expect(Object.keys(body).sort()).toEqual(
        ["byteSize", "heightPx", "mime", "ok", "staged", "widthPx"].sort(),
      );
    } finally {
      await f.cleanup();
    }
  });

  it("a transparent PNG is accepted", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}/photo`,
        readFileSync(join(PHOTOS, "logo-alpha.png")),
        { "Content-Type": "image/png" },
      );
      expect(res.status).toBe(200);
      expect(res.json().ok).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a SECOND upload replaces the staged photo rather than accumulating", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const a = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      const b = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}/photo`,
        readFileSync(join(PHOTOS, "logo-alpha.png")),
      );
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(countImages(f.h)).toBe(0);
      expect(f.bridge.hasStagedPhoto()).toBe(true);

      // Saving stores ONE photo — the second one.
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(countImages(f.h)).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 THE CONTENT IS JUDGED, NOT THE HEADER. `Content-Type: image/jpeg` on rubbish bytes, and a
   * file whose name and header say PNG while its bytes say otherwise, must both fail — F sniffs
   * the magic bytes and validates the DECODE RESULT rather than trusting a declaration or an
   * absence of exceptions.
   */
  it("🔴 rubbish bytes with a JPEG Content-Type are refused", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, Buffer.from("not an image"), {
        "Content-Type": "image/jpeg",
      });
      expect(res.status).toBe(422);
      expect(res.json().ok).toBe(false);
      expect(countImages(f.h)).toBe(0);
      expect(f.bridge.hasStagedPhoto()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("a corrupt JPEG and an unsupported format are refused", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      for (const name of ["corrupt.jpg", "sample.webp"]) {
        const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, name)));
        expect(res.status, name).toBe(422);
        expect(countImages(f.h)).toBe(0);
      }
      // 🔴 HEIC IS NOT SOLVED HERE. F refuses anything that is not JPEG or PNG, and this slice
      // keeps that: an iPhone handing over HEIC gets a readable refusal, not a silent conversion.
      expect(f.bridge.hasStagedPhoto()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a refused photo leaves the SESSION and the draft alive", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, Buffer.from("rubbish"));
      // The merchant tries a good one, then saves — all on the same session.
      const ok = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(ok.status).toBe(200);
      const saved = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(saved.status).toBe(200);
      expect(countProducts(f.h)).toBe(1);
      expect(countImages(f.h)).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it("an empty body is refused", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, Buffer.alloc(0));
      expect(res.status).toBe(422);
    } finally {
      await f.cleanup();
    }
  });
});

describe("staged media never outlives its session", () => {
  for (const [label, end] of [
    ["cancel", (b: PhoneSessionBridge) => b.cancel()],
    ["navigating away", (b: PhoneSessionBridge) => b.navigatedAway()],
    ["the app quitting", (b: PhoneSessionBridge) => b.appClosing()],
  ] as const) {
    it(`🔴 ${label} drops the staged photo and writes nothing`, async () => {
      const f = fixture();
      try {
        const dto = await openSession(f);
        await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
        expect(f.bridge.hasStagedPhoto()).toBe(true);

        await end(f.bridge);
        expect(f.bridge.hasStagedPhoto()).toBe(false);
        expect(countImages(f.h)).toBe(0);
        expect(countProducts(f.h)).toBe(0);
      } finally {
        await f.cleanup();
      }
    });
  }

  /**
   * 🔴 THE LISTENER'S REAL TIMER HAS TO FIRE, so the clock is rigged rather than merely advanced.
   *
   * A first version advanced an injected clock by eleven minutes and asserted the staged photo was
   * gone. It was not — and the test was wrong, not the code: `setTimeout` runs on real time, so
   * moving a fake clock forward makes `checkAccess` refuse the session while the teardown timer
   * still has ten real minutes to wait.
   *
   * This clock returns the real time for the FIRST read — the one that mints the session and sets
   * `expiresAtMs` — and then jumps almost a full TTL forward, so the server computes a ~120ms
   * `msLeft` and the genuine expiry path runs end to end.
   */
  it("🔴 expiry drops it too, with no request and no desktop action", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    const codec = fakeCodec();
    const base = Date.now();
    let reads = 0;
    const bridge = new PhoneSessionBridge({
      service: h.service,
      interfaces: () => IFACES,
      randomToken: () => TOKEN,
      renderQr: async () => "<svg/>",
      normalizePhoto: (bytes) => assertStorable(normalizeProductPhoto(bytes, codec)),
      now: () => {
        reads += 1;
        return reads === 1 ? base : base + 10 * 60 * 1000 - 120;
      },
    });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await bridge.start(h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(bridge.hasStagedPhoto()).toBe(true);

      await new Promise((r) => setTimeout(r, 400));
      expect(bridge.hasStagedPhoto()).toBe(false);
      expect(countImages(h)).toBe(0);
      expect(countProducts(h)).toBe(0);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  it("🔴 a successful Save consumes it — the next session starts with nothing staged", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(countImages(f.h)).toBe(1);
      expect(f.bridge.hasStagedPhoto()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

describe("the save is atomic", () => {
  it("a NEW product saves with its photo, stored as origin 'phone'", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(res.status).toBe(200);

      const row = f.h.db
        .prepare("SELECT origin, is_primary, mime, byte_size, width_px, height_px, sha256_hex FROM catalog_product_images")
        .get() as Record<string, unknown>;
      // 🔴 TRUTHFULLY 'phone'. The column has admitted this since migration 9.
      expect(row.origin).toBe("phone");
      expect(Number(row.is_primary)).toBe(1);
      expect(["image/jpeg", "image/png"]).toContain(row.mime);
      expect(Number(row.byte_size)).toBeGreaterThan(0);
      expect(String(row.sha256_hex)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 THE CONTRACT THIS SLICE HAD TO DESIGN AGAINST. `createProduct` and `setProductPrimaryImage`
   * each open their own transaction; run one after the other, a failure in the second leaves a
   * product the merchant asked to photograph WITHOUT its photo, reported as success.
   *
   * The staged photo here carries a width the image table's CHECK constraint refuses, so the photo
   * write fails for a real reason at the database. The product must not survive it.
   */
  it("🔴 a failing photo write ROLLS BACK the product — no half-saved state", async () => {
    const f = fixture({
      normalizePhoto: () =>
        // A shape `assertStorable` would never emit; it reaches the service and the row's CHECK.
        ({
          bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
          mime: "image/jpeg",
          widthPx: -5,
          heightPx: -5,
          sourceMime: "image/jpeg",
          sourceWidthPx: 1,
          sourceHeightPx: 1,
          exifOrientation: 1,
        }) as never,
    });
    try {
      const dto = await openSession(f);
      const staged = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(staged.status).toBe(200);

      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(res.status).toBeGreaterThanOrEqual(400);

      // 🔴 NEITHER HALF SURVIVED. Without the outer transaction the product would be here alone.
      expect(countProducts(f.h)).toBe(0);
      expect(countImages(f.h)).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 EDIT with no staged photo PRESERVES the existing photo — absent is not null", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const p = f.h.service.createProduct({ nameAr: "مفتاح", nameEn: null, sku: null, price: "10.00", baseUnit: "piece" });
      // A photo already on the product, put there the desktop way.
      f.h.service.setProductPrimaryImage({
        productId: p.id,
        bytes: readFileSync(join(PHOTOS, "shelf.jpg")),
        mime: "image/jpeg",
        widthPx: 800,
        heightPx: 600,
        origin: "desktop",
      });
      const before = f.h.db.prepare("SELECT id, sha256_hex, origin FROM catalog_product_images").get() as Record<string, unknown>;

      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", p.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      // Saves with NO photo upload at all.
      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({ product: { nameAr: "مفتاح", price: "21.00" } }),
      );
      expect(res.status).toBe(200);

      const after = f.h.db.prepare("SELECT id, sha256_hex, origin FROM catalog_product_images").get() as Record<string, unknown>;
      expect(countImages(f.h)).toBe(1);
      // 🔴 THE SAME ROW, byte for byte. A media path that cleared a photo because none was
      // uploaded would be exactly the "absent means null" defect this project keeps guarding.
      expect(after.id).toBe(before.id);
      expect(after.sha256_hex).toBe(before.sha256_hex);
      expect(after.origin).toBe("desktop");
    } finally {
      await f.cleanup();
    }
  });

  it("EDIT with a staged photo replaces it, and leaves exactly one", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const p = f.h.service.createProduct({ nameAr: "مفتاح", nameEn: null, sku: null, price: "10.00", baseUnit: "piece" });
      f.h.service.setProductPrimaryImage({
        productId: p.id,
        bytes: readFileSync(join(PHOTOS, "logo-alpha.png")),
        mime: "image/png",
        widthPx: 400,
        heightPx: 400,
        origin: "desktop",
      });
      const before = f.h.db.prepare("SELECT sha256_hex FROM catalog_product_images").get() as { sha256_hex: string };

      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", p.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ product: { nameAr: "مفتاح" } }));

      expect(countImages(f.h)).toBe(1);
      const after = f.h.db.prepare("SELECT sha256_hex, origin FROM catalog_product_images").get() as Record<string, unknown>;
      expect(after.sha256_hex).not.toBe(before.sha256_hex);
      expect(after.origin).toBe("phone");
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 the audit records the photo, and records NO bytes, path, filename or token", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());

      const rows = f.h.db
        .prepare(
          "SELECT event_type, changed_json, metadata_json FROM audit_events WHERE entity_type = 'product_image'",
        )
        .all() as Array<{ event_type: string; changed_json: string; metadata_json: string | null }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const all = rows.map((r) => `${r.changed_json}${r.metadata_json ?? ""}`).join("");
      expect(all).toMatch(/sha256_hex/);
      // Nothing that identifies the source or the session.
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain("shelf");
      expect(all).not.toContain(".jpg");
      expect(all).not.toMatch(/base64/i);
      expect(all).not.toMatch(/[A-Za-z]:\\\\|\/home\/|\/tmp\//);
    } finally {
      await f.cleanup();
    }
  });
});

describe("the barcode endpoint", () => {
  it("reads a photographed EAN-13 and stores nothing", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}/barcode`,
        readFileSync(join(BARCODES, "ean13.png")),
      );
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.found).toBe(true);
      expect(body.value).toBe("5901234123457");
      expect(body.format).toBe("EAN13");
      // 🔴 NOTHING WAS PERSISTED. The value is draft text; storage happens at Save.
      expect(countProducts(f.h)).toBe(0);
      expect(countImages(f.h)).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a photo with no barcode answers found:false and keeps the session alive", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(res.status).toBe(200);
      expect(res.json().found).toBe(false);

      // The draft is untouched and the merchant can still save.
      const saved = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(saved.status).toBe(200);
      expect(countProducts(f.h)).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it("a decoded barcode reaches storage canonicalized, exactly as a typed one would", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const scan = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}/barcode`,
        readFileSync(join(BARCODES, "upca.png")),
      );
      const value = String(scan.json().value);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ master: { barcode: value } }));
      const row = f.h.db.prepare("SELECT barcode FROM catalog_products").get() as { barcode: string };
      expect(row.barcode).toBe("0036000291452");
    } finally {
      await f.cleanup();
    }
  });
});

describe("the media routes inherit every H1/H2 protection", () => {
  it("🔴 a wrong token, an ended session and a replay are all refused", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const other = "c".repeat(64);

      const wrong = await request(dto.host, dto.port, "POST", `/m/${other}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(wrong.status).toBe(404);
      expect(countImages(f.h)).toBe(0);

      // After a save the session is spent: the media routes close with it.
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      let afterSave = 0;
      try {
        afterSave = (await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, Buffer.from("x"))).status;
      } catch {
        afterSave = 0; // the listener closed — the strongest refusal
      }
      expect(afterSave === 0 || afterSave >= 400).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a SECOND phone cannot upload to a session another phone claimed", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f); // claimed by "iPhone"
      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}/photo`,
        readFileSync(join(PHOTOS, "shelf.jpg")),
        { "User-Agent": "Android" },
      );
      expect(res.status).toBe(404);
      expect(f.bridge.hasStagedPhoto()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 an expired session refuses an upload", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    const codec = fakeCodec();
    let clock = Date.now();
    const bridge = new PhoneSessionBridge({
      service: h.service,
      interfaces: () => IFACES,
      randomToken: () => TOKEN,
      renderQr: async () => "<svg/>",
      normalizePhoto: (bytes) => assertStorable(normalizeProductPhoto(bytes, codec)),
      now: () => clock,
    });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await bridge.start(h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      clock += 11 * 60 * 1000;
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(res.status).toBe(404);
      expect(countImages(h)).toBe(0);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  /**
   * 🔴 THE DECLARED LENGTH IS DISTRUSTED IN BOTH DIRECTIONS. A huge `Content-Length` is refused
   * before a byte is read; a body that LIES about being small and then streams past the cap is
   * caught by counting what actually arrives. Trusting the header alone is how an unlimited upload
   * passes a limit that looks enforced.
   */
  it("🔴 an oversized DECLARED Content-Length is refused before the body is read", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, Buffer.from("x"), {
        "Content-Length": String(50 * 1024 * 1024),
      });
      expect(res.status).toBe(413);
      expect(res.json().code).toBe("TOO_LARGE");
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a body that STREAMS past the cap is destroyed even though it declared less", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const host = dto.host;
      const port = dto.port;
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect({ host, port }, () => {
          socket.write(
            `POST /m/${TOKEN}/photo HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: iPhone\r\n` +
              `Content-Length: 1024\r\nConnection: close\r\n\r\n`,
          );
          // Then send far more than declared, in chunks.
          const chunk = Buffer.alloc(1024 * 1024, 0x41);
          let sent = 0;
          const pump = () => {
            if (sent > 16 * 1024 * 1024) return;
            sent += chunk.length;
            if (socket.writable) socket.write(chunk, () => setImmediate(pump));
          };
          pump();
        });
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (c) => (data += c));
        socket.on("error", () => resolve(data === "" ? "destroyed" : data));
        socket.on("close", () => resolve(data === "" ? "destroyed" : data));
        socket.setTimeout(8000, () => {
          socket.destroy();
          resolve("timeout");
        });
      });
      // Either a 413 answer or a destroyed socket — both mean the cap held.
      expect(outcome === "destroyed" || /413/.test(outcome)).toBe(true);
      expect(countImages(f.h)).toBe(0);
      expect(f.bridge.hasStagedPhoto()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 the media routes are POST-only and expose nothing on GET", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      for (const p of [`/m/${TOKEN}/photo`, `/m/${TOKEN}/barcode`]) {
        const res = await request(dto.host, dto.port, "GET", p);
        expect(res.status, p).toBe(404);
      }
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 no new generic surface appeared — only the two named media routes exist", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      for (const p of [
        `/m/${TOKEN}/upload`,
        `/m/${TOKEN}/files`,
        `/m/${TOKEN}/photo/../../etc/passwd`,
        `/m/${TOKEN}/barcode/x`,
        "/upload",
        "/files",
        "/api/photo",
        `/m/${TOKEN}/image`,
      ]) {
        const res = await request(dto.host, dto.port, "POST", p, Buffer.from("x"));
        expect(res.status, p).toBe(404);
      }
      // CONTROL: the real route still works, so the loop is not passing because the server died.
      const ok = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(ok.status).toBe(200);
    } finally {
      await f.cleanup();
    }
  });

  it("without the pipeline wired, the photo route says NOT_AVAILABLE and stages nothing", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    const bridge = new PhoneSessionBridge({
      service: h.service,
      interfaces: () => IFACES,
      randomToken: () => TOKEN,
      renderQr: async () => "<svg/>",
      // no normalizePhoto, no decodeBarcode — the H2-era shape
    });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await bridge.start(h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      const photo = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, Buffer.from("x"));
      const barcode = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, Buffer.from("x"));
      expect(photo.status).toBe(503);
      expect(barcode.status).toBe(503);
      expect(bridge.hasStagedPhoto()).toBe(false);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  it("a CASHIER at the till cannot complete a session that staged a photo", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));

      f.h.service.logout();
      f.h.service.login("cashier-02", "2222");

      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(res.status).toBe(422);
      expect(res.json().code).toBe("NOT_AUTHORIZED");
      expect(countProducts(f.h)).toBe(0);
      expect(countImages(f.h)).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
});

describe("the F pipeline is reused, not reimplemented", () => {
  /**
   * 🔴 ASSERTED ON THE CODE, NOT ON INTENT. `phoneSessionBridge.ts` must contain no image decoding
   * of its own — no magic-byte table, no resize policy, no JPEG ladder. If someone later inlines a
   * "quick" normalization there, this fails.
   */
  it("🔴 the bridge contains no second image pipeline", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "main", "phoneSessionBridge.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/toJPEG|toPNG|toBitmap|createFromBuffer|resize\(/);
    expect(code).not.toMatch(/0xff,\s*0xd8|0x89,\s*0x50/);
    expect(code).not.toMatch(/JPEG_QUALITY_LADDER|TARGET_LONG_EDGE/);
    // CONTROL: it really does call F's entry point via its injected dependency.
    expect(code).toMatch(/normalizePhoto/);
  });

  it("🔴 the stored photo is NORMALIZED, not the bytes the phone sent", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const source = readFileSync(join(PHOTOS, "shelf.jpg"));
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, source);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());

      const row = f.h.db.prepare("SELECT byte_size, bytes FROM catalog_product_images").get() as {
        byte_size: number | bigint;
        bytes: Buffer;
      };
      // F re-encodes; the stored bytes are not the uploaded ones.
      expect(Buffer.compare(row.bytes, source)).not.toBe(0);
      expect(Number(row.byte_size)).toBe(row.bytes.length);
    } finally {
      await f.cleanup();
    }
  });
});

describe("DomainError is still what a refusal looks like", () => {
  it("the service refuses a staged photo for a product that vanished", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const p = f.h.service.createProduct({ nameAr: "مفتاح", nameEn: null, sku: null, price: "10.00", baseUnit: "piece" });
      const spec = f.h.service.authorizePhoneSession("EDIT_PRODUCT", p.id);
      f.h.db.prepare("DELETE FROM catalog_products WHERE id = ?").run(p.id);
      expect(() =>
        f.h.service.savePhoneProduct(
          spec,
          { draft: { nameAr: "مفتاح", nameEn: null, sku: null, price: "10.00", baseUnit: "piece" }, master: {
            categoryId: "", barcode: "", brand: "", descriptionAr: "", descriptionEn: "", isOnlineVisible: false } },
          null,
          null,
        ),
      ).toThrow(DomainError);
    } finally {
      await f.cleanup();
    }
  });
});

describe("I2 — the mobile media controls the page actually renders", () => {
  it("offers photo capture AND library choice, and a barcode capture", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const html = await rawPage(dto.host, dto.port);
      for (const id of [
        "phone-photo-take",
        "phone-photo-choose",
        "phone-photo-input",
        "phone-photo-pick",
        "phone-photo-status",
        "phone-barcode-scan",
        "phone-barcode-input",
        "phone-barcode-status",
      ]) {
        expect(html, id).toContain(`data-testid="${id}"`);
      }
      // The barcode text field is still there and still editable — no `readonly`, no `disabled`.
      expect(html).toContain('data-testid="phone-barcode"');
      expect(/data-testid="phone-barcode"[^>]*\b(readonly|disabled)\b/.test(html)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 THE CAPTURE ATTRIBUTES ARE THE WHOLE COMPATIBILITY STORY. `accept="image/*"` with `capture`
   * is a FILE INPUT: it opens the camera on iOS and Android and needs no secure context. The live
   * camera and in-browser scanner APIs are secure-context only and are undefined on a plain-HTTP
   * LAN origin on BOTH platforms, which is why this page must never reach for them.
   */
  it("🔴 uses file inputs with accept+capture, and names no live-camera API anywhere", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const html = await rawPage(dto.host, dto.port);
      expect((html.match(/accept="image\/\*"/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect((html.match(/capture="environment"/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(html).not.toMatch(/getUserMedia|BarcodeDetector|mediaDevices/);
      // And still entirely local — no CDN, no remote font, no external anything.
      expect(html).not.toMatch(/https?:\/\//);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 an EDIT with an existing photo SAYS it will be kept; a NEW product does not", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const p = f.h.service.createProduct({ nameAr: "مفتاح", nameEn: null, sku: null, price: "10.00", baseUnit: "piece" });
      f.h.service.setProductPrimaryImage({
        productId: p.id,
        bytes: readFileSync(join(PHOTOS, "shelf.jpg")),
        mime: "image/jpeg",
        widthPx: 800,
        heightPx: 600,
        origin: "desktop",
      });
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", p.id));
      const html = await rawPage(dto.host, dto.port);
      // 🔴 The merchant is told the existing photo survives an untouched Save — the UI half of
      // "absent is not null" for media.
      expect(html).toContain('data-testid="phone-photo-current"');
      expect(html).toContain("للصنف صورة حالية");
    } finally {
      await f.cleanup();
    }
  });

  it("a NEW product's form does not claim an existing photo", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const html = await rawPage(dto.host, dto.port);
      expect(html).not.toContain('data-testid="phone-photo-current"');
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 THE FULL I2 JOURNEY, THROUGH THE REAL ENDPOINTS: capture a barcode, get a decode, CORRECT
   * it by hand, attach a photo, and save once. The correction is the point — the decoder reads
   * roughly two labels in three, so a flow that only worked when it guessed right would fail a
   * merchant a third of the time.
   */
  it("🔴 decode → MANUAL CORRECTION → save stores the corrected value, not the decoded one", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);

      const scan = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, readFileSync(join(BARCODES, "ean13.png")));
      expect(scan.status).toBe(200);
      expect(scan.json().value).toBe("5901234123457");

      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));

      // The merchant edits the field before saving — a different, valid EAN-13.
      const corrected = "4006381333931";
      const saved = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({ master: { barcode: corrected } }),
      );
      expect(saved.status).toBe(200);

      const row = f.h.db.prepare("SELECT barcode FROM catalog_products").get() as { barcode: string };
      expect(row.barcode).toBe(corrected);
      expect(row.barcode).not.toBe("5901234123457");
      expect(countImages(f.h)).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it("a second barcode capture replaces the first decode result", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const a = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, readFileSync(join(BARCODES, "ean13.png")));
      const b = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, readFileSync(join(BARCODES, "ean8.png")));
      expect(a.json().value).toBe("5901234123457");
      expect(b.json().value).toBe("96385074");
      // Whatever the form last held is what Save stores.
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ master: { barcode: "96385074" } }));
      const row = f.h.db.prepare("SELECT barcode FROM catalog_products").get() as { barcode: string };
      expect(row.barcode).toBe("96385074");
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 Code 128's case survives the whole journey to storage", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const scan = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, readFileSync(join(BARCODES, "code128.png")));
      expect(scan.json().value).toBe("Alz-7781-A");
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ master: { barcode: String(scan.json().value) } }));
      const row = f.h.db.prepare("SELECT barcode FROM catalog_products").get() as { barcode: string };
      expect(row.barcode).toBe("Alz-7781-A");
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a failed decode blocks nothing — the merchant types it and saves", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const miss = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(miss.status).toBe(200);
      expect(miss.json().found).toBe(false);

      const saved = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ master: { barcode: "96385074" } }));
      expect(saved.status).toBe(200);
      const row = f.h.db.prepare("SELECT barcode FROM catalog_products").get() as { barcode: string };
      expect(row.barcode).toBe("96385074");
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a failed photo upload, then a retry, then Save — the draft survives throughout", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      const bad = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, Buffer.from("rubbish"));
      expect(bad.status).toBe(422);
      expect(f.bridge.hasStagedPhoto()).toBe(false);

      const good = await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      expect(good.status).toBe(200);

      const saved = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ product: { nameAr: "مفتاح أحمر" } }));
      expect(saved.status).toBe(200);
      const row = f.h.db.prepare("SELECT name_ar FROM catalog_products").get() as { name_ar: string };
      expect(row.name_ar).toBe("مفتاح أحمر");
      expect(countImages(f.h)).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 media actions alone create NOTHING durable", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/barcode`, readFileSync(join(BARCODES, "ean13.png")));
      expect(countProducts(f.h)).toBe(0);
      expect(countImages(f.h)).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
});

describe("I2 — the online catalogue still sees a phone-created product", () => {
  /**
   * 🔴 THE EXPORT IS THE REASON ANY OF THIS ENRICHMENT EXISTS. A product entered on a phone must
   * reach the website package exactly like one typed at the till: its barcode, its normalized
   * image, and a SHA the catalogue publishes and the file matches. Slice G proved the export;
   * this proves a phone-originated product is not a special case it misses.
   */
  it("🔴 a phone-created product exports with its barcode, image and matching SHA — no base64", async () => {
    const f = fixture();
    try {
      const dto = await openSession(f);
      await request(dto.host, dto.port, "POST", `/m/${TOKEN}/photo`, readFileSync(join(PHOTOS, "shelf.jpg")));
      const saved = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({
          product: { nameAr: "صنف من الهاتف", price: "7.25" },
          master: { barcode: "5901234123457", isOnlineVisible: true },
        }),
      );
      expect(saved.status).toBe(200);

      const snapshot = f.h.service.onlineCatalogSnapshot();
      const doc = JSON.parse(JSON.stringify(snapshot.document)) as {
        products: Array<Record<string, unknown>>;
      };
      const product = doc.products.find((p) => p.name_ar === "صنف من الهاتف");
      expect(product, "the phone-created product is in the export").toBeDefined();
      expect(product!.barcode).toBe("5901234123457");
      expect(product!.price).toBe("7.25");

      const image = product!.image as Record<string, unknown> | null;
      expect(image, "…and it carries its image").not.toBeNull();
      expect(String(image!.sha256)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(image!.file)).toMatch(/^images\/product-[0-9a-f]{64}\.(jpg|png)$/);
      expect(Number(image!.width)).toBeGreaterThan(0);

      // 🔴 THE SHA THE CATALOGUE PUBLISHES IS THE SHA OF THE STORED BYTES.
      const row = f.h.db.prepare("SELECT sha256_hex, origin FROM catalog_product_images").get() as Record<string, unknown>;
      expect(image!.sha256).toBe(row.sha256_hex);
      expect(row.origin).toBe("phone");

      // 🔴 NO BASE64 ANYWHERE — the export carries real files, never bytes inside JSON.
      const asText = JSON.stringify(doc);
      expect(asText).not.toMatch(/base64|data:image/i);
      expect(asText.length).toBeLessThan(100_000);
    } finally {
      await f.cleanup();
    }
  });
});
