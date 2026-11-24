/**
 * The demo catalog fixture (tests/fixtures/demo-catalog) is itself checked, with the app's OWN
 * parsers, so a hand edit that breaks it fails here rather than halfway through an E2E run.
 *
 *   - the import CSV passes the real importer (`validateImport`) with zero rejected rows, and says
 *     exactly what catalog.json says
 *   - SKUs, source ids and barcodes are unique; every barcode is a valid EAN-13 in the restricted
 *     in-store prefix 200 (never a real manufacturer's code)
 *   - prices are positive decimals with at most two places
 *   - every credited photo exists, is a JPEG under the app's size limit, and has a CC0 / public
 *     domain licence with no restriction; every photo file has a credit; a product without a photo
 *     says why
 *   - nothing in the folder is a ledger, a log or an installer
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBarcode } from "../../src/domain/barcode";
import { decodeUtf8Strict, validateImport } from "../../src/domain/catalogImport";
import { MAX_PRODUCT_IMAGE_BYTES } from "../../src/domain/productImage";

const DIR = join(__dirname, "..", "fixtures", "demo-catalog");
interface DemoProduct {
  source_id: string;
  sku: string;
  name_ar: string;
  name_en: string | null;
  price: string;
  unit: string;
  category: string;
  active: boolean;
  needs_review: boolean;
  barcode: string;
}
const DEF = JSON.parse(readFileSync(join(DIR, "catalog.json"), "utf8")) as {
  currency: string;
  categories: [string, string, string][];
  products: DemoProduct[];
};
const CREDITS = JSON.parse(readFileSync(join(DIR, "image-credits.json"), "utf8")) as Record<
  string,
  { file: string | null; licence?: string; source_page?: string; reason?: string }
>;
const LICENCE_CHECK = JSON.parse(readFileSync(join(DIR, "image-licence-check.json"), "utf8")) as Record<
  string,
  { licence: string; restrictions: string }
>;

describe("demo catalog fixture — data", () => {
  it("40 products in 8 categories, every product in a known category", () => {
    expect(DEF.products).toHaveLength(40);
    expect(DEF.categories).toHaveLength(8);
    const keys = new Set(DEF.categories.map(([k]) => k));
    for (const p of DEF.products) expect(keys.has(p.category), p.sku).toBe(true);
  });

  it("SKUs, source ids and barcodes are unique", () => {
    for (const field of ["sku", "source_id", "barcode"] as const) {
      const values = DEF.products.map((p) => p[field]);
      expect(new Set(values).size, field).toBe(values.length);
    }
  });

  it("every barcode is a valid EAN-13 in the restricted in-store prefix 200", () => {
    for (const p of DEF.products) {
      const b = normalizeBarcode(p.barcode);
      expect(b?.kind, p.sku).toBe("EAN13");
      expect(b?.value, p.sku).toBe(p.barcode);
      expect(p.barcode.startsWith("200"), p.sku).toBe(true);
    }
  });

  it("prices are positive decimals with at most two places", () => {
    for (const p of DEF.products) {
      expect(p.price, p.sku).toMatch(/^\d+(\.\d{1,2})?$/);
      expect(Number(p.price), p.sku).toBeGreaterThan(0);
    }
  });

  it("the import CSV passes the real importer with zero rejections and matches catalog.json", () => {
    const text = decodeUtf8Strict(new Uint8Array(readFileSync(join(DIR, "alzabt-demo-catalog-import.csv"))));
    const { rows, rejected } = validateImport(text, DEF.currency);
    expect(rejected).toEqual([]);
    expect(rows).toHaveLength(DEF.products.length);
    rows.forEach((r, i) => {
      const p = DEF.products[i]!;
      expect(r.sourceId).toBe(p.source_id);
      expect(r.nameAr).toBe(p.name_ar);
      expect(r.nameEn).toBe(p.name_en);
      expect(r.baseUnit).toBe(p.unit);
      expect(r.priceNeedsReview).toBe(p.needs_review);
      expect(r.priceMinor).toBe(BigInt(Math.round(Number(p.price) * 100)));
    });
  });
});

describe("demo catalog fixture — photos and licences", () => {
  const files = readdirSync(join(DIR, "images"));

  it("38 photos; every photo file has a credit and every credit's file exists", () => {
    expect(files).toHaveLength(38);
    const credited = new Set(Object.values(CREDITS).map((c) => c.file).filter((f): f is string => f !== null));
    expect(new Set(files)).toEqual(credited);
    for (const p of DEF.products) expect(CREDITS[p.sku], p.sku).toBeDefined();
  });

  it("every photo is a JPEG under the app's size limit", () => {
    for (const f of files) {
      const bytes = readFileSync(join(DIR, "images", f));
      expect([bytes[0], bytes[1], bytes[2]], f).toEqual([0xff, 0xd8, 0xff]);
      expect(bytes.length, f).toBeLessThanOrEqual(MAX_PRODUCT_IMAGE_BYTES);
    }
  });

  it("🔴 every photo is CC0 or public domain with NO restriction; a product without one says why", () => {
    for (const [sku, c] of Object.entries(CREDITS)) {
      if (c.file === null) {
        expect(c.reason, sku).toBeTruthy();
        continue;
      }
      expect(["CC0", "Public domain"], sku).toContain(c.licence);
      expect(c.source_page, sku).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
    }
    for (const [sku, l] of Object.entries(LICENCE_CHECK)) {
      expect(["CC0", "Public domain"], sku).toContain(l.licence);
      expect(l.restrictions, sku).toBe("");
    }
  });

  it("the folder holds no ledger, log, installer or temporary file", () => {
    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else all.push(e);
      }
    };
    walk(DIR);
    expect(all.filter((f) => /\.(sqlite|db|wal|shm|log|exe|msi|png|pyc|tmp)$/i.test(f))).toEqual([]);
  });
});
