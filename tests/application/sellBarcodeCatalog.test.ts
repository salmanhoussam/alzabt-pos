/**
 * SELL-BARCODE below the UI: the selling catalog built from the real SQLite table carries each
 * active product's canonical barcode, and the inactive products' codes as bare strings — through
 * the real create / deactivate paths, not hand-written rows. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { resolveScan } from "../../src/renderer/sellScan";
import { fromCatalogDto } from "../../src/shared/dto";
import type { CatalogDto } from "../../src/shared/ipcContract";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const DRAFT = (over: Record<string, unknown> = {}) => ({
  nameAr: "صنف",
  nameEn: "Item",
  price: "4.00",
  baseUnit: "piece" as const,
  ...over,
});

describe("the selling catalog carries barcodes from the real table", () => {
  it("🔴 an active product's barcode is its canonical form; an inactive one's is a bare string", () => {
    const h = makeHarness(t.dbPath);
    const water = h.service.createProduct(DRAFT({ nameAr: "مياه", sku: "W-1", master: { barcode: "123456789012" } }) as never);
    const plain = h.service.createProduct(DRAFT({ nameAr: "بدون باركود", sku: "P-1" }) as never);
    const retired = h.service.createProduct(DRAFT({ nameAr: "موقوف", sku: "R-1", master: { barcode: "4006381333931" } }) as never);
    h.service.setProductActive(retired.id, false);

    const live = h.service.getCatalog();
    expect(live.byId.get(water.id)!.barcode).toBe("0123456789012");
    expect(live.byId.get(plain.id)!.barcode).toBeNull();
    // 🔴 The inactive product is not sellable at all — only its code is known.
    expect(live.byId.has(retired.id)).toBe(false);
    expect([...live.inactiveBarcodes]).toEqual(["4006381333931"]);

    expect(resolveScan("123456789012", live)).toEqual({ kind: "add", productId: water.id });
    expect(resolveScan("4006381333931", live)).toEqual({ kind: "inactive" });
    h.db.close();
  });

  it("reactivating a product moves its code back from the inactive list to the sellable product", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(DRAFT({ nameAr: "يبقى نشطاً", sku: "K-1" }) as never);
    const p = h.service.createProduct(DRAFT({ sku: "S-1", master: { barcode: "96385074" } }) as never);
    h.service.setProductActive(p.id, false);
    expect(h.service.getCatalog().inactiveBarcodes.has("96385074")).toBe(true);
    h.service.setProductActive(p.id, true);
    const live = h.service.getCatalog();
    expect(live.inactiveBarcodes.has("96385074")).toBe(false);
    expect(resolveScan("96385074", live)).toEqual({ kind: "add", productId: p.id });
    h.db.close();
  });

  it("🔴 over IPC, getCatalog sends inactive codes and nothing else about those products", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(DRAFT({ nameAr: "نشط", sku: "A-1", master: { barcode: "96385074" } }) as never);
    const retired = h.service.createProduct(DRAFT({ nameAr: "اسم سري", sku: "SECRET-SKU", master: { barcode: "4006381333931" } }) as never);
    h.service.setProductActive(retired.id, false);

    const handlers = syncHandlers(createIpcHandlers(h.service));
    const result = handlers.getCatalog(undefined) as { ok: true; data: CatalogDto };
    expect(result.ok).toBe(true);
    const dto = result.data;
    expect(dto.inactiveBarcodes).toEqual(["4006381333931"]);
    const wire = JSON.stringify(dto);
    expect(wire).not.toContain(retired.id);
    expect(wire).not.toContain("اسم سري");
    expect(wire).not.toContain("SECRET-SKU");
    expect(resolveScan("4006381333931", fromCatalogDto(dto))).toEqual({ kind: "inactive" });
    h.db.close();
  });

  /**
   * 🔴 KNOWN LIMIT, NOT A GOAL. With no ACTIVE local product at all, the till sells the bundled demo
   * catalog exactly as a fresh install does (`startupCatalog` / `refreshCatalogFromStore`), and that
   * fallback carries no inactive codes — so a retired product's code reads "unknown", not
   * "inactive". Nothing is sold wrongly either way. Changing the fallback is outside SELL-BARCODE;
   * if it changes, this assertion flips on purpose.
   */
  it("with no active local product, a retired code reads unknown (demo fallback)", () => {
    const h = makeHarness(t.dbPath);
    const only = h.service.createProduct(DRAFT({ sku: "O-1", master: { barcode: "96385074" } }) as never);
    h.service.setProductActive(only.id, false);
    const live = h.service.getCatalog();
    expect(live.inactiveBarcodes.size).toBe(0);
    expect(resolveScan("96385074", live)).toEqual({ kind: "unknown" });
    h.db.close();
  });
});
