/**
 * BR-C-05 V3 verification primitive for a future main-only demo seed binding.
 * No process, profile, session or file authority is created here. The caller must
 * already have a trusted new synthetic ledger and independently validated fixture.
 */
import type { CatalogImportResult } from "../application/posService";
import { decodeUtf8Strict, validateImport } from "../domain/catalogImport";
import { CSV_SOURCE, productIdFor, type AdminProductRow } from "../persistence/catalogRepository";

export interface ExpectedDemoIdentity {
  readonly sourceId: string;
  readonly sku: string;
}
export interface VerifiedDemoIdentity extends ExpectedDemoIdentity {
  readonly productId: string;
}
const DEMO_COUNT = 22;
export class DemoIdentityError extends Error {
  constructor() { super("Demo product verification failed."); this.name = "DemoIdentityError"; }
}
function fail(): never { throw new DemoIdentityError(); }

/** Parse the exact CSV bytes; never zip independent fixture/repository orders. */
export function verifyDemoImportedIdentities(
  csv: Uint8Array,
  currency: string,
  result: CatalogImportResult,
  expected: ReadonlyArray<ExpectedDemoIdentity>,
  persisted: ReadonlyArray<AdminProductRow>,
): ReadonlyArray<VerifiedDemoIdentity> {
  try {
    const parsed = validateImport(decodeUtf8Strict(csv), currency);
    if (parsed.rejected.length || parsed.rows.length !== DEMO_COUNT ||
      result.status !== "imported" || result.rowCount !== DEMO_COUNT ||
      result.inserted !== DEMO_COUNT || result.updated !== 0 ||
      result.unchanged !== 0 || result.deactivated !== 0 ||
      expected.length !== DEMO_COUNT || persisted.length !== DEMO_COUNT) fail();

    const bySource = new Map<string, ExpectedDemoIdentity>();
    const seenSkus = new Set<string>();
    for (const item of expected) {
      if (!item.sourceId || !item.sku || bySource.has(item.sourceId) || seenSkus.has(item.sku)) fail();
      bySource.set(item.sourceId, item);
      seenSkus.add(item.sku);
    }
    const byId = new Map<string, AdminProductRow>();
    for (const row of persisted) {
      if (row.source !== CSV_SOURCE || byId.has(row.id)) fail();
      byId.set(row.id, row);
    }
    const seenIds = new Set<string>();
    const out: VerifiedDemoIdentity[] = [];
    for (const row of parsed.rows) {
      const item = bySource.get(row.sourceId);
      const id = productIdFor(CSV_SOURCE, row.sourceId);
      const actual = byId.get(id);
      if (!item || !actual || seenIds.has(id) ||
        actual.id !== id || actual.source !== CSV_SOURCE || actual.source_key !== row.sourceId ||
        actual.is_active !== 1n || actual.sku !== null ||
        actual.name_ar !== row.nameAr || actual.name_en !== row.nameEn ||
        actual.selling_price_minor !== row.priceMinor || actual.currency !== row.currency ||
        actual.base_unit !== row.baseUnit || actual.price_needs_review !== (row.priceNeedsReview ? 1n : 0n)) fail();
      seenIds.add(id);
      out.push({ sourceId: row.sourceId, sku: item.sku, productId: id });
    }
    if (seenIds.size !== DEMO_COUNT || bySource.size !== DEMO_COUNT || byId.size !== DEMO_COUNT) fail();
    return out;
  } catch {
    // Never rethrow detailed CSV parser or store-origin errors.
    throw new DemoIdentityError();
  }
}
