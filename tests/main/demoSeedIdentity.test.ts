import { describe, expect, it } from "vitest";
import type { CatalogImportResult } from "../../src/application/posService";
import { validateImport } from "../../src/domain/catalogImport";
import { CSV_SOURCE, productIdFor, type AdminProductRow } from "../../src/persistence/catalogRepository";
import { DemoIdentityError, verifyDemoImportedIdentities } from "../../src/main/demoSeedIdentity";

const header = "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review";
const lines = Array.from({ length: 22 }, (_, i) => "id-" + (i + 1) + ",Item " + (i + 1) + ",Name " + (i + 1) + ",1.00,USD,piece,0");
const csv = new TextEncoder().encode([header, ...lines].join(String.fromCharCode(10)));
const result: CatalogImportResult = { status: "imported", rowCount: 22, placeholderPrices: 0, inserted: 22, updated: 0, unchanged: 0, deactivated: 0 };
const expected = lines.map((_, i) => ({ sourceId: "id-" + (i + 1), sku: "SKU-" + (i + 1) })).reverse();
const rows = validateImport(new TextDecoder().decode(csv), "USD").rows;
const persisted = rows.map((r) => ({
  id: productIdFor(CSV_SOURCE, r.sourceId), source: CSV_SOURCE, source_key: r.sourceId,
  sku: null, name_ar: r.nameAr, name_en: r.nameEn, selling_price_minor: r.priceMinor,
  currency: r.currency, base_unit: r.baseUnit, price_needs_review: 0n, is_active: 1n,
} as AdminProductRow)).reverse();

describe("BR-C-05 V3 main-only identity verification primitive", () => {
  it("resolves all IDs in exact CSV order, independently of fixture and repository order", () => {
    const out = verifyDemoImportedIdentities(csv, "USD", result, expected, persisted);
    expect(out.map((v) => v.sourceId)).toEqual(rows.map((r) => r.sourceId));
    for (const [i, value] of out.entries()) {
      expect(value.productId).toBe(productIdFor(CSV_SOURCE, rows[i]!.sourceId));
      expect(value.sku).toBe("SKU-" + (i + 1));
      expect(value.sku + ".jpg").toBe("SKU-" + (i + 1) + ".jpg");
      expect(rows[i]!.nameEn).toBe("Name " + (i + 1));
    }
  });
  it("rejects missing, duplicated, unexpected or misbound identities and changed attributes", () => {
    const cases: ReadonlyArray<ReadonlyArray<AdminProductRow>> = [
      persisted.slice(1),
      [...persisted.slice(0, 21), persisted[0]!],
      persisted.map((r, i) => i === 0 ? { ...r, source_key: "wrong" } : r),
      persisted.map((r, i) => i === 0 ? { ...r, source: "manual" } : r),
      persisted.map((r, i) => i === 0 ? { ...r, is_active: 0n } : r),
      persisted.map((r, i) => i === 0 ? { ...r, name_ar: "wrong" } : r),
      persisted.map((r, i) => i === 0 ? { ...r, sku: "unexpected" } : r),
    ];
    for (const bad of cases) expect(() => verifyDemoImportedIdentities(csv, "USD", result, expected, bad)).toThrow(DemoIdentityError);
    expect(() => verifyDemoImportedIdentities(csv, "USD", result, [...expected.slice(0,21), expected[0]!], persisted)).toThrow(DemoIdentityError);
    expect(() => verifyDemoImportedIdentities(csv, "USD", { ...result, inserted: 21 }, expected, persisted)).toThrow(DemoIdentityError);
  });
  it("refuses duplicate source IDs, bad CSV and rejected imports without leaking their contents", () => {
    const bad = new TextEncoder().encode([header, ...lines.slice(0,21), lines[0]].join(String.fromCharCode(10)));
    for (const input of [bad, new TextEncoder().encode("private-sentinel")]) {
      expect(() => verifyDemoImportedIdentities(input, "USD", result, expected, persisted)).toThrow("Demo product verification failed.");
      try { verifyDemoImportedIdentities(input, "USD", result, expected, persisted); }
      catch (e) { expect(String(e)).not.toContain("private-sentinel"); }
    }
    expect(() => verifyDemoImportedIdentities(csv, "USD", { status: "rejected", rejected: [] }, expected, persisted)).toThrow(DemoIdentityError);
  });
});
