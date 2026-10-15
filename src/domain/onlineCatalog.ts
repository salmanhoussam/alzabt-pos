/**
 * The Online Catalog Export contract — what the shop's website is allowed to be told.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS AN ALLOW-LIST, BY CONSTRUCTION, AND THAT IS THE WHOLE SECURITY ARGUMENT.
 *
 * Nothing here serializes an internal row and then deletes dangerous keys. Every field in the
 * exported object is named, individually, in `onlineCatalogProduct` below. A column added to
 * `catalog_products` tomorrow — or a private table joined in by accident — cannot reach the
 * website by default, because the only way into the output is to be written down here on purpose.
 *
 * The opposite shape (serialize, then strip) fails open: it exports anything nobody remembered to
 * remove, and the failure is silent and permanent, because the merchant uploads the file.
 *
 * 🔴 AND IT IS A SEPARATE FEATURE FROM THE LEGACY CSV EXPORT. `exportCatalogCsv` keeps its 7-column
 * `IMPORT_HEADER` contract exactly as it is, so a shop's existing import/export round-trip still
 * works. That export reads `listForExport(CSV_SOURCE)` and therefore only ever sees imported
 * products — the measured gap where a hand-typed product vanishes. This file does not widen it or
 * reroute it; it replaces nothing. It reads the authoritative Product Master instead, where a
 * product's ORIGIN is not part of the question.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { formatDecimal, money } from "./money";
import type { ImageMimeValue } from "./productImage";

/**
 * The version of the external contract, carried in every file.
 *
 * It exists so a website reading an old package can refuse it rather than mis-read it. Bump it
 * when a field changes meaning or disappears — never for an additive, optional field.
 */
export const ONLINE_CATALOG_SCHEMA_VERSION = 1;

/** The category a product is filed under, as the website sees it. */
export interface OnlineCatalogCategory {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string | null;
}

/** A product's photo, as the website sees it. Never bytes — a path to a real file beside it. */
export interface OnlineCatalogImage {
  /** Relative to the package root, always forward-slashed: `images/product-….jpg`. */
  readonly file: string;
  readonly mime: ImageMimeValue;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One product in the external catalog.
 *
 * 🔴 `id` IS THE WEBSITE'S IDENTITY FOR THIS PRODUCT, and it is deliberately not the SKU. A SKU is
 * optional, editable and may be re-used by a shop that renumbers its shelves; the product id is
 * minted once and never changes, so a website keying on it keeps its own links, reviews and
 * ordering intact across every future export.
 */
export interface OnlineCatalogProduct {
  readonly id: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly name_ar: string;
  readonly name_en: string | null;
  readonly category: OnlineCatalogCategory | null;
  readonly brand: string | null;
  /** An exact decimal string ("12.50"), never a float — a float cannot hold every price exactly. */
  readonly price: string;
  readonly currency: string;
  readonly unit: string;
  readonly description_ar: string | null;
  readonly description_en: string | null;
  readonly online_visible: true;
  readonly image: OnlineCatalogImage | null;
  readonly updated_at: string;
}

export interface OnlineCatalogDocument {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly products: ReadonlyArray<OnlineCatalogProduct>;
}

// ── Eligibility ────────────────────────────────────────────────────────────────────────────────

/**
 * Exactly the products that belong in a freshly generated online catalog.
 *
 * 🔴 TWO CONDITIONS, AND ORIGIN IS NOT ONE OF THEM. A product created by hand, by a CSV import, or
 * by "create as new product" during invoice reconciliation is the same kind of thing once it is
 * in Product Master, and the website has no interest in which door it came through. Reading
 * `source` here is exactly the mistake the legacy CSV export makes.
 *
 * 🔴 INACTIVE IS EXCLUDED EVEN WHEN ONLINE-VISIBLE. Deactivating a product is how a shop takes it
 * off the shelf; leaving it published in a catalogue generated afterwards would quietly sell
 * something the shop has withdrawn. The flag stays on the row — reactivating republishes it.
 *
 * Incomplete enrichment is NOT a condition. A product with no category, no brand, no English name,
 * no description and no photo still exports, with those fields truthfully null.
 */
export function isEligibleForOnlineCatalog(row: {
  readonly is_active: number | bigint;
  readonly is_online_visible: number | bigint;
}): boolean {
  return Number(row.is_active) === 1 && Number(row.is_online_visible) === 1;
}

// ── Image file names ───────────────────────────────────────────────────────────────────────────

const EXTENSION: Record<ImageMimeValue, string> = { "image/jpeg": "jpg", "image/png": "png" };

/** Names Windows refuses outright, whatever extension follows them. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A stable, Windows-safe, traversal-proof file name for a product's photo.
 *
 * 🔴 THE PRODUCT ID CANNOT GO INTO A PATH VERBATIM, AND THIS WAS MEASURED, NOT ASSUMED. Ids are
 * `<source>:<source_key>` — a real one is `manual:000001`. A colon is illegal in a Windows file
 * name, and worse than illegal: NTFS reads `product-manual:000001.jpg` as an alternate data stream
 * named `000001.jpg` on a file called `product-manual`, so the write would APPEAR to succeed and
 * the image would be invisible to every normal tool, including the merchant's upload.
 *
 * 🔴 AND SANITIZING ALONE IS NOT ENOUGH, because `source_key` carries user text: a CSV whose
 * `source_id` is `a:b` and another whose `source_id` is `a_b` both sanitize to `merchant-csv_a_b`,
 * and the second image would overwrite the first. So the name ends with a short digest of the FULL
 * original id. Two different products cannot collide; the same product always gets the same name.
 */
export function onlineCatalogImageFile(productId: string, mime: ImageMimeValue): string {
  const digest = createHash("sha256").update(productId, "utf8").digest("hex").slice(0, 12);
  let safe = productId
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 48);
  if (safe.length === 0 || RESERVED.test(safe)) safe = "product";
  return `images/product-${safe}-${digest}.${EXTENSION[mime]}`;
}

// ── Building one product, field by field ───────────────────────────────────────────────────────

/** The internal row this reads from. Named explicitly so a wider row cannot be passed by accident. */
export interface OnlineCatalogSourceRow {
  readonly id: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly name_ar: string;
  readonly name_en: string | null;
  readonly brand: string | null;
  readonly selling_price_minor: bigint | number;
  readonly currency: string;
  readonly base_unit: string;
  readonly description_ar: string | null;
  readonly description_en: string | null;
  readonly updated_at: string;
}

/**
 * One external product, built field by field from approved inputs.
 *
 * 🔴 THE CATEGORY IS EXPORTED EVEN WHEN IT IS RETIRED, and that is deliberate. A retired category
 * cannot be NEWLY assigned (the service refuses it), but a product that already carries one still
 * carries it, and that is truthful Product Master data. Erasing it here because of a flag the
 * website never sees would silently lose the shop's own classification of its own product.
 *
 * The category's `is_active` is NOT exported: it governs what an operator may choose next in the
 * till, which is nothing the website can act on.
 */
export function onlineCatalogProduct(input: {
  readonly row: OnlineCatalogSourceRow;
  readonly category: { readonly id: string; readonly name_ar: string; readonly name_en: string | null } | null;
  readonly image: OnlineCatalogImage | null;
}): OnlineCatalogProduct {
  const { row } = input;
  // Key order is written once, here, and is the order every exported object carries — see
  // `serializeOnlineCatalog` for why that matters.
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name_ar: row.name_ar,
    name_en: row.name_en,
    category:
      input.category === null
        ? null
        : { id: input.category.id, name_ar: input.category.name_ar, name_en: input.category.name_en },
    brand: row.brand,
    // 🔴 THROUGH THE MONEY MODULE, NOT A DIVISION BY 100. `formatDecimal` is the one place that
    // knows a currency's exponent, and the exported string is exact minor units — never a float,
    // which cannot represent every price and would turn 12.50 into 12.499999999999998 somewhere.
    price: formatDecimal(money(BigInt(row.selling_price_minor), row.currency)),
    currency: row.currency,
    unit: row.base_unit,
    description_ar: row.description_ar,
    description_en: row.description_en,
    // Always true: an ineligible product never reaches this function. Stated in the file rather
    // than implied, so a website reading one product in isolation knows what it is looking at.
    online_visible: true,
    image: input.image,
    updated_at: row.updated_at,
  };
}

// ── Determinism ────────────────────────────────────────────────────────────────────────────────

/**
 * The same database state and the same instant must produce byte-identical output.
 *
 * Four things have to be pinned for that to hold, and all four are here rather than spread across
 * the writer:
 *
 *   1. PRODUCT ORDER — by `id`, compared as plain code units. Not by name: an Arabic name's order
 *      depends on the collation of whoever is running, and `localeCompare` is not stable across
 *      machines. Ids are ASCII and minted by us.
 *   2. KEY ORDER — fixed by the literal in `onlineCatalogProduct`; JavaScript preserves insertion
 *      order for string keys, so no sorting is needed and none is done.
 *   3. ENCODING — `JSON.stringify` leaves non-ASCII alone, so Arabic stays Arabic in UTF-8 rather
 *      than becoming صنف. A merchant opening this file should see their own words.
 *   4. WHITESPACE — two-space indent and exactly one trailing newline, so a diff between two
 *      exports shows what actually changed.
 */
export function sortOnlineCatalogProducts(
  products: ReadonlyArray<OnlineCatalogProduct>,
): OnlineCatalogProduct[] {
  return [...products].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function onlineCatalogDocument(
  generatedAt: string,
  products: ReadonlyArray<OnlineCatalogProduct>,
): OnlineCatalogDocument {
  return {
    schema_version: ONLINE_CATALOG_SCHEMA_VERSION,
    generated_at: generatedAt,
    products: sortOnlineCatalogProducts(products),
  };
}

/** The exact bytes of `catalog.json`. */
export function serializeOnlineCatalog(document: OnlineCatalogDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
