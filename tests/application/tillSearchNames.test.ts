/**
 * TILL-SEARCH-AR + TILL-NAMES (DEC-35h §2–§3), below the UI. Synthetic data only.
 *
 * Finding F1 (demo catalog E2E, 2026-11-09): the till filtered on the DISPLAYED name only, so a
 * product with an English name could not be found by its Arabic name («عدس» → 0). The fix routes
 * the till through domain/arabic.ts `matchesSearch` — the normalisation Products and Invoices
 * already use — over both stored names, the snapshot name, the SKU and the barcode.
 *
 * Finding F2: the till showed the English name in the Arabic UI. A screen now shows the name for
 * its language; the SALE LINE still snapshots `name` (displayName), so nothing recorded changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchesSearch } from "../../src/domain/arabic";
import { type Product, displayName, loadCatalog, nameForLanguage, searchFields, secondaryName } from "../../src/domain/catalog";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { fromCatalogDto, toCatalogDto } from "../../src/shared/dto";
import type { CatalogDto } from "../../src/shared/ipcContract";
import { type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const DRAFT = (over: Record<string, unknown> = {}) => ({ nameAr: "صنف", nameEn: null, price: "4.00", baseUnit: "piece" as const, ...over });
const find = (products: ReadonlyArray<Product>, q: string) => products.filter((p) => matchesSearch(searchFields(p), q)).map((p) => p.sku);

describe("TILL-SEARCH-AR — the till finds a product by either name, SKU or barcode", () => {
  it("🔴 the selling catalog from the real table carries BOTH stored names", () => {
    const h = makeHarness(t.dbPath);
    const lentils = h.service.createProduct(DRAFT({ nameAr: "عدس أحمر ١ كغ", nameEn: "Red lentils 1 kg", sku: "GRC-LENT-1KG" }) as never);
    const parsley = h.service.createProduct(DRAFT({ nameAr: "بقدونس", sku: "VEG-PRSL-BN" }) as never);
    const live = h.service.getCatalog();
    const l = live.byId.get(lentils.id)!;
    expect(l.name).toBe("Red lentils 1 kg"); // the snapshot rule is unchanged
    expect(l.nameAr).toBe("عدس أحمر ١ كغ");
    expect(l.nameEn).toBe("Red lentils 1 kg");
    const p = live.byId.get(parsley.id)!;
    expect(p.nameAr).toBe("بقدونس");
    expect(p.nameEn).toBeNull();
    h.db.close();
  });

  it("🔴 F1 regression: an English-named product IS found by its Arabic name (was 0 results)", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(DRAFT({ nameAr: "عدس أحمر ١ كغ", nameEn: "Red lentils 1 kg", sku: "GRC-LENT-1KG" }) as never);
    h.service.createProduct(DRAFT({ nameAr: "أرز بسمتي ٥ كغ", nameEn: "Basmati rice 5 kg", sku: "GRC-RICE-5KG" }) as never);
    const products = h.service.getCatalog().products;
    // TRANSITION: the old till filter (displayed name + SKU, plain substring) found NOTHING here.
    const oldFilter = (q: string) => products.filter((p) => p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q));
    expect(oldFilter("عدس")).toHaveLength(0);
    expect(find(products, "عدس")).toEqual(["GRC-LENT-1KG"]);
    h.db.close();
  });

  it("Arabic normalisation: hamza forms, tashkeel, tatweel, alef maqsura and Arabic-Indic digits", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(DRAFT({ nameAr: "أرز بسمتي ٥ كغ", nameEn: "Basmati rice 5 kg", sku: "GRC-RICE-5KG" }) as never);
    h.service.createProduct(DRAFT({ nameAr: "حلوى مُشكّلة", sku: "SWT-MIX" }) as never);
    h.service.createProduct(DRAFT({ nameAr: "مكتبة صغيرة", sku: "LIB-1" }) as never);
    const products = h.service.getCatalog().products;
    expect(find(products, "ارز")).toEqual(["GRC-RICE-5KG"]); // أ → ا
    expect(find(products, "ارز 5")).toEqual(["GRC-RICE-5KG"]); // ٥ → 5, terms ANDed
    expect(find(products, "حلوي مشكلة")).toEqual(["SWT-MIX"]); // ى → ي, tashkeel dropped
    expect(find(products, "حلـــوى")).toEqual(["SWT-MIX"]); // tatweel dropped
    // 🔴 ة is NOT folded into ه, by the approved rule (مكتبة ≠ مكتبه).
    expect(find(products, "مكتبه")).toEqual([]);
    h.db.close();
  });

  it("English name (any case), SKU and barcode all find the product; an Arabic-only product too", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(DRAFT({ nameAr: "عدس أحمر ١ كغ", nameEn: "Red lentils 1 kg", sku: "GRC-LENT-1KG", master: { barcode: "2000000000053" } }) as never);
    h.service.createProduct(DRAFT({ nameAr: "بقدونس", sku: "VEG-PRSL-BN" }) as never);
    const products = h.service.getCatalog().products;
    expect(find(products, "LENTILS")).toEqual(["GRC-LENT-1KG"]);
    expect(find(products, "grc-lent")).toEqual(["GRC-LENT-1KG"]);
    expect(find(products, "2000000000053")).toEqual(["GRC-LENT-1KG"]);
    expect(find(products, "بقدونس")).toEqual(["VEG-PRSL-BN"]);
    expect(find(products, "parsley")).toEqual([]); // no invented English name to match
    h.db.close();
  });

  it("the names cross IPC and survive the renderer's rebuild (additive DTO fields)", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(DRAFT({ nameAr: "عدس", nameEn: "Lentils", sku: "L-1" }) as never);
    const handlers = syncHandlers(createIpcHandlers(h.service));
    const result = handlers.getCatalog(undefined) as { ok: true; data: CatalogDto };
    const back = fromCatalogDto(result.data);
    expect(find(back.products, "عدس")).toEqual(["L-1"]);
    h.db.close();
  });

  it("a single-name catalog (the bundled fixture shape) still searches and displays by `name`", () => {
    const c = loadCatalog({ currency: "USD", products: [{ id: "x1", sku: "COF-ESP", name: "Espresso", price: "2.50" }] });
    const back = fromCatalogDto(toCatalogDto(c));
    expect(back.products[0]!.nameAr).toBeUndefined();
    expect(find(back.products, "espresso")).toEqual(["COF-ESP"]);
    expect(nameForLanguage(back.products[0]!, "ar")).toBe("Espresso");
    expect(secondaryName(back.products[0]!, "ar")).toBeNull();
  });

  it("performance: 5,000 products × a typed Arabic query stays well under a frame budget per keystroke", () => {
    const products: Product[] = [];
    for (let i = 0; i < 5000; i++) {
      products.push({
        id: `p${i}`, sku: `SKU-${i}`, name: `Product ${i}`, nameAr: `منتج رقم ${i} أحمر`, nameEn: `Product ${i}`,
        price: { minor: 100n, currency: "USD" } as never, baseUnit: "piece", priceNeedsReview: false, barcode: String(2000000000000 + i),
      });
    }
    const index = products.map((p) => ({ p, fields: searchFields(p) }));
    const queries = ["م", "من", "منت", "منتج", "منتج ر", "منتج رقم 4999", "احمر"];
    const start = performance.now();
    let hits = 0;
    for (const q of queries) hits += index.filter(({ fields }) => matchesSearch(fields, q)).length;
    const perKeystroke = (performance.now() - start) / queries.length;
    expect(hits).toBeGreaterThan(0);
    // Recorded, generous bound: a regression to something quadratic fails; machine noise does not.
    expect(perKeystroke).toBeLessThan(150);
  });
});

describe("TILL-NAMES — the name a screen shows follows the UI language; the sale line does not", () => {
  const both = { name: "Red lentils 1 kg", nameAr: "عدس أحمر ١ كغ", nameEn: "Red lentils 1 kg" };
  const arOnly = { name: "بقدونس", nameAr: "بقدونس", nameEn: null };

  it("Arabic UI → Arabic name; English UI → English name; a missing one falls back", () => {
    expect(nameForLanguage(both, "ar")).toBe("عدس أحمر ١ كغ");
    expect(nameForLanguage(both, "en")).toBe("Red lentils 1 kg");
    expect(nameForLanguage(arOnly, "ar")).toBe("بقدونس");
    expect(nameForLanguage(arOnly, "en")).toBe("بقدونس"); // never an invented translation
  });

  it("the second, smaller name is the OTHER stored name — or nothing", () => {
    expect(secondaryName(both, "ar")).toBe("Red lentils 1 kg");
    expect(secondaryName(both, "en")).toBe("عدس أحمر ١ كغ");
    expect(secondaryName(arOnly, "ar")).toBeNull();
    expect(secondaryName(arOnly, "en")).toBeNull();
    expect(secondaryName({ name: "Pita", nameAr: "Pita", nameEn: "Pita" }, "ar")).toBeNull();
  });

  it("🔴 INVARIANT: the snapshot rule is unchanged — a sale line still records displayName", () => {
    expect(displayName("عدس أحمر ١ كغ", "Red lentils 1 kg")).toBe("Red lentils 1 kg");
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ nameAr: "عدس أحمر", nameEn: "Red lentils", sku: "L-2", price: "2.00" }) as never);
    const sale = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: p.id, quantityMilli: 1000 }], expectedTotalMinor: 200n });
    const row = h.db.prepare("SELECT product_name FROM sale_lines WHERE sale_id = ?").get(sale.sale.id) as { product_name: string };
    expect(row.product_name).toBe("Red lentils");
    h.db.close();
  });
});
