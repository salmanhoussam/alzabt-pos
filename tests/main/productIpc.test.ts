/**
 * The product-administration channels at the IPC boundary: exact-shape validation, and the fact
 * that a business failure arrives as a code the UI can act on rather than a generic internal error.
 */
import { describe, expect, it, vi } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { DomainError } from "../../src/domain/errors";
import type { PosService } from "../../src/application/posService";
import type { AdminProductRow } from "../../src/persistence/catalogRepository";

const ROW: AdminProductRow = {
  id: "manual:000001",
  source: "manual",
  source_key: "000001",
  sku: "SKU-001",
  name_ar: "مفتاح أحمر",
  name_en: "Red Wrench",
  selling_price_minor: 400n,
  currency: "USD",
  base_unit: "piece",
  price_needs_review: 0n,
  is_active: 1n,
  created_at: "2026-10-07T09:00:00.000Z",
  updated_at: "2026-10-07T09:00:00.000Z",
};

const DRAFT = { nameAr: "مفتاح أحمر", nameEn: "Red Wrench", sku: "SKU-001", price: "4.00", baseUnit: "piece" };

function handlers(overrides: Partial<Record<string, unknown>> = {}) {
  const service = {
    listProducts: vi.fn(() => [ROW]),
    createProduct: vi.fn(() => ROW),
    updateProduct: vi.fn(() => ROW),
    setProductActive: vi.fn(() => ({ ...ROW, is_active: 0n })),
    currentCashier: vi.fn(() => ({ id: "cashier-01", name: "Cashier One" })),
    ...overrides,
  } as unknown as PosService;
  return { h: syncHandlers(createIpcHandlers(service)), service };
}

describe("listProducts", () => {
  it("maps bigint columns to strings and 0/1 to booleans", () => {
    const { h } = handlers();
    const r = h.listProducts(undefined) as { ok: true; data: Array<Record<string, unknown>> };
    expect(r.ok).toBe(true);
    expect(r.data[0]).toMatchObject({
      id: "manual:000001",
      nameAr: "مفتاح أحمر",
      priceDecimal: "4.00",
      price: { minor: "400", currency: "USD" },
      baseUnit: "piece",
      isActive: true,
      priceNeedsReview: false,
    });
    // No bigint ever crosses the boundary — it would not survive structured cloning to the renderer.
    expect(JSON.stringify(r.data)).toContain('"minor":"400"');
  });

  it("takes no payload", () => {
    const { h } = handlers();
    expect(h.listProducts({ limit: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

describe("createProduct", () => {
  it("passes the exact draft through", () => {
    const { h, service } = handlers();
    expect(h.createProduct({ draft: DRAFT })).toMatchObject({ ok: true });
    expect(service.createProduct).toHaveBeenCalledWith(DRAFT);
  });

  it("refuses an unexpected or missing field instead of guessing", () => {
    const { h } = handlers();
    for (const bad of [
      {},
      { draft: DRAFT, extra: 1 },
      { draft: { ...DRAFT, colour: "red" } },
      { draft: { nameAr: "x", price: "1", baseUnit: "piece" } },
    ]) {
      expect(h.createProduct(bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("accepts null for the optional fields and rejects a non-string", () => {
    const { h, service } = handlers();
    expect(h.createProduct({ draft: { ...DRAFT, nameEn: null, sku: null } })).toMatchObject({ ok: true });
    expect(service.createProduct).toHaveBeenCalledWith({ ...DRAFT, nameEn: null, sku: null });
    expect(h.createProduct({ draft: { ...DRAFT, nameEn: 5 } })).toMatchObject({ ok: false });
  });

  it("forwards a business error's own code, so the screen can tell the operator what happened", () => {
    const { h } = handlers({
      createProduct: vi.fn(() => {
        throw new DomainError("DUPLICATE_SKU", "Another product already uses the SKU 'SKU-001'");
      }),
    });
    expect(h.createProduct({ draft: DRAFT })).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_SKU", message: /SKU-001/ as unknown as string },
    });
  });

  it("never leaks an internal error's text", () => {
    const { h } = handlers({
      createProduct: vi.fn(() => {
        throw new Error("SQLITE_CORRUPT: /home/merchant/ledger.sqlite");
      }),
    });
    const r = h.createProduct({ draft: DRAFT }) as { ok: false; error: { code: string; message: string } };
    expect(r.error.code).toBe("INTERNAL");
    expect(r.error.message).not.toContain("SQLITE");
    expect(r.error.message).not.toContain("/home/merchant");
  });
});

describe("updateProduct and setProductActive", () => {
  it("require id plus the exact remaining fields", () => {
    const { h, service } = handlers();
    expect(h.updateProduct({ id: "manual:000001", draft: DRAFT, isActive: true })).toMatchObject({ ok: true });
    expect(service.updateProduct).toHaveBeenCalledWith("manual:000001", DRAFT, true);
    expect(h.updateProduct({ id: "manual:000001", draft: DRAFT })).toMatchObject({ ok: false });
    expect(h.updateProduct({ id: "manual:000001", draft: DRAFT, isActive: "yes" })).toMatchObject({ ok: false });
  });

  it("setProductActive requires a real boolean", () => {
    const { h, service } = handlers();
    expect(h.setProductActive({ id: "manual:000001", isActive: false })).toMatchObject({ ok: true });
    expect(service.setProductActive).toHaveBeenCalledWith("manual:000001", false);
    expect(h.setProductActive({ id: "manual:000001", isActive: 0 })).toMatchObject({ ok: false });
  });
});

describe("settings channels", () => {
  it("reports the defaults when no settings store is wired", () => {
    const { h } = handlers();
    expect(h.getSettings(undefined)).toMatchObject({
      ok: true,
      data: { terminalLanguage: "ar", receiptLanguage: "ar" },
    });
  });

  it("accepts only 'ar' or 'en'", () => {
    const store = {
      get: () => ({ terminalLanguage: "ar" as const, receiptLanguage: "ar" as const }),
      setTerminalLanguage: vi.fn((lang: "ar" | "en") => ({ terminalLanguage: lang, receiptLanguage: "ar" as const })),
    };
    const service = { currentCashier: () => null } as unknown as PosService;
    const h = syncHandlers(createIpcHandlers(service, { settings: store }));
    expect(h.setTerminalLanguage({ language: "en" })).toMatchObject({
      ok: true,
      data: { terminalLanguage: "en" },
    });
    for (const bad of [{ language: "fr" }, { language: "" }, { language: 1 }, {}]) {
      expect(h.setTerminalLanguage(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it("says so plainly when settings are not available instead of pretending to save", () => {
    const service = { currentCashier: () => null } as unknown as PosService;
    const h = syncHandlers(createIpcHandlers(service));
    expect(h.setTerminalLanguage({ language: "en" })).toMatchObject({
      ok: false,
      error: { code: "NOT_AVAILABLE" },
    });
  });
});
