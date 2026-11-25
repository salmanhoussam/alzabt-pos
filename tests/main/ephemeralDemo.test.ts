/**
 * EPHEMERAL DEMO (owner decision 2026-11-25): every Demo start is a brand-new shop that lives ONLY in memory.
 *
 * Proves, with the REAL shipped Demo assets (resources/demo + the 22 fixture photos) and the validated seed:
 *   - the ledger is `:memory:` (no file, journal_mode "memory", no -wal / -journal);
 *   - it starts with the original 22 products / 8 categories;
 *   - a sale made in one Demo session does NOT exist in the next one (closing IS the reset);
 *   - nothing but copies of the synthetic logo are written to the session folder — no ledger, no business data.
 * The image codec is tests/helpers/fakeCodec (parses the real bytes; never kinder than Chromium).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEphemeralSyntheticDemo } from "../../src/main/demoSyntheticStartup";
import { fakeCodec } from "../helpers/fakeCodec";
import type { ImageCodec } from "../../src/main/photoNormalize";

/**
 * fakeCodec's `toJPEG` output is deliberately NOT a parseable JPEG (see its header: it models sizes, not encoding),
 * so the seed's final «the stored photo decodes» check could never pass with it. The real Chromium encoder produces
 * a real JPEG that decodes. This wrapper models exactly that and nothing more: bytes THIS codec just encoded decode
 * back to the image they came from; every other input goes to fakeCodec unchanged (no extra file becomes decodable).
 */
function roundTripCodec(): ImageCodec {
  const base = fakeCodec();
  const encoded = new Map<string, ReturnType<ImageCodec["decode"]>>();
  const remember = (img: ReturnType<ImageCodec["decode"]>): ReturnType<ImageCodec["decode"]> => ({
    ...img,
    resize: (size) => remember(img.resize(size)),
    toJPEG: (q) => {
      const out = img.toJPEG(q);
      encoded.set(out.toString("base64"), img);
      return out;
    },
  });
  return {
    ...base,
    decode: (bytes) => encoded.get(Buffer.from(bytes).toString("base64")) ?? remember(base.decode(bytes)),
    fromBitmap: (...args: Parameters<ImageCodec["fromBitmap"]>) => remember(base.fromBitmap(...args)),
  };
}

const repo = join(__dirname, "..", "..");
const assets = () => ({
  csv: readFileSync(join(repo, "resources", "demo", "demo-22-import.csv")),
  mapping: readFileSync(join(repo, "resources", "demo", "product-image-mapping.json")),
  manifest: readFileSync(join(repo, "resources", "demo", "demo-media-manifest.json")),
  logo: readFileSync(join(repo, "resources", "demo", "demo-logo.png")),
  profile: readFileSync(join(repo, "resources", "demo", "demo-profile.json")),
  sourceImage: (sku: string) => readFileSync(join(repo, "tests", "fixtures", "demo-catalog", "images", `${sku}.jpg`)),
  codec: roundTripCodec(),
});

function allFiles(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(root, join(dir, e.name)) : [relative(root, join(dir, e.name)).replace(/\\/g, "/")],
  );
}

const dirs: string[] = [];
const session = () => {
  const d = mkdtempSync(join(tmpdir(), "alzabt-ephemeral-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const count = (db: { prepare: (s: string) => { get: () => unknown } }, sql: string) =>
  Number((db.prepare(sql).get() as { n: bigint }).n);

describe("ephemeral Demo: in memory, fresh on every start", () => {
  it("is a real :memory: ledger with the original 22 products and 8 categories", () => {
    const { db } = startEphemeralSyntheticDemo(session(), assets());
    try {
      expect(db.memory).toBe(true);
      expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("memory");
      expect(count(db, "SELECT COUNT(*) AS n FROM catalog_products")).toBe(22);
      expect(count(db, "SELECT COUNT(*) AS n FROM catalog_product_images")).toBe(22);
      expect(count(db, "SELECT COUNT(*) AS n FROM catalog_categories")).toBe(8);
      expect(count(db, "SELECT COUNT(*) AS n FROM sales")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("🔴 a sale in one Demo session is GONE in the next: closing is the reset", () => {
    const first = startEphemeralSyntheticDemo(session(), assets());
    const product = first.db.prepare("SELECT id, selling_price_minor AS price FROM catalog_products WHERE is_active = 1 ORDER BY id LIMIT 1").get() as {
      id: string;
      price: bigint;
    };
    const svc = first.services.service;
    expect(svc.currentCashier(), "the seed signs the synthetic owner in").not.toBeNull();
    svc.createSale({
      idempotencyKey: "ephemeral-test-sale-0001",
      paymentMethod: "cash",
      lines: [{ productId: product.id, quantityMilli: 1000 }],
      expectedTotalMinor: product.price,
    });
    expect(count(first.db, "SELECT COUNT(*) AS n FROM sales")).toBe(1);
    first.db.close(); // the app closes

    const second = startEphemeralSyntheticDemo(session(), assets()); // the app reopens
    try {
      expect(count(second.db, "SELECT COUNT(*) AS n FROM sales")).toBe(0);
      expect(count(second.db, "SELECT COUNT(*) AS n FROM catalog_products")).toBe(22);
    } finally {
      second.db.close();
    }
  });

  it("🔴 writes NO ledger, journal or business file: the session folder holds only the synthetic logo copy", () => {
    const dir = session();
    const { db } = startEphemeralSyntheticDemo(dir, assets());
    db.close();
    const files = allFiles(dir);
    // Exactly ONE file, and it IS the shipped synthetic logo, byte for byte — no ledger, journal or business data.
    expect(files).toEqual(["branding/synthetic-demo-logo.png"]);
    expect(readFileSync(join(dir, files[0]!)).equals(readFileSync(join(repo, "resources", "demo", "demo-logo.png")))).toBe(true);
  });
});

describe("ephemeral Demo settings: the LBP rate lives and dies with the session", () => {
  it("validates, confirms and refuses exactly as on disk — and a new session starts unconfirmed at USD", async () => {
    const { SettingsStore, memorySettingsFs } = await import("../../src/main/settingsStore");
    const first = new SettingsStore("C:\\demo-session-a", memorySettingsFs());
    expect(() => first.setDisplayCurrency("LBP")).toThrow(expect.objectContaining({ code: "LBP_RATE_UNCONFIRMED" }));
    first.setLbpRate(9_000_000n);
    expect(first.setDisplayCurrency("LBP")).toMatchObject({ displayCurrency: "LBP", lbpRate: "90000", lbpRateConfirmed: true });

    const next = new SettingsStore("C:\\demo-session-a", memorySettingsFs()); // the app reopened
    expect(next.get()).toMatchObject({ displayCurrency: "USD", lbpRate: "89000", lbpRateConfirmed: false });
  });
});
