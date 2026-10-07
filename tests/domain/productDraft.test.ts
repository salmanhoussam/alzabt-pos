import { describe, expect, it } from "vitest";
import { BASE_UNITS } from "../../src/domain/catalog";
import { validateProductDraft } from "../../src/domain/productDraft";

const base = { nameAr: "مفتاح أحمر", nameEn: null, sku: null, price: "4.00", baseUnit: "piece" };

describe("validateProductDraft", () => {
  it("accepts the minimum a sale and an invoice need: Arabic name, exact price, unit", () => {
    const v = validateProductDraft(base, "USD");
    expect(v.nameAr).toBe("مفتاح أحمر");
    expect(v.nameEn).toBeNull();
    expect(v.sku).toBeNull();
    expect(v.price.minor).toBe(400n);
    expect(v.price.currency).toBe("USD");
    expect(v.baseUnit).toBe("piece");
  });

  it("requires an Arabic name", () => {
    expect(() => validateProductDraft({ ...base, nameAr: "" }, "USD")).toThrow(/required/);
    expect(() => validateProductDraft({ ...base, nameAr: "   " }, "USD")).toThrow(/required/);
  });

  it("keeps the Arabic name as written apart from collapsing whitespace", () => {
    expect(validateProductDraft({ ...base, nameAr: "  عَلَم   أحمر  " }, "USD").nameAr).toBe("عَلَم أحمر");
  });

  it("treats an empty optional field as absent, never as an empty string", () => {
    const v = validateProductDraft({ ...base, nameEn: "   ", sku: "" }, "USD");
    expect(v.nameEn).toBeNull();
    expect(v.sku).toBeNull();
  });

  it("accepts an optional English name and SKU when given", () => {
    const v = validateProductDraft({ ...base, nameEn: " Red Wrench ", sku: " SKU-1 " }, "USD");
    expect(v.nameEn).toBe("Red Wrench");
    expect(v.sku).toBe("SKU-1");
  });

  it("accepts exact prices and refuses everything else — one parser, no float", () => {
    expect(validateProductDraft({ ...base, price: "12" }, "USD").price.minor).toBe(1200n);
    expect(validateProductDraft({ ...base, price: "3.5" }, "USD").price.minor).toBe(350n);
    expect(validateProductDraft({ ...base, price: " 2.60 " }, "USD").price.minor).toBe(260n);
    for (const bad of ["$5", "5,00", "1.005", "-1", "1e3", "", "abc", "1.2.3"]) {
      expect(() => validateProductDraft({ ...base, price: bad }, "USD"), bad).toThrow();
    }
  });

  it("refuses a zero price — migration 3 refuses it too, so it could never be stored", () => {
    expect(() => validateProductDraft({ ...base, price: "0" }, "USD")).toThrow(/greater than zero/);
    expect(() => validateProductDraft({ ...base, price: "0.00" }, "USD")).toThrow(/greater than zero/);
  });

  it("requires a unit, and only one this terminal sells in", () => {
    expect(() => validateProductDraft({ ...base, baseUnit: "" }, "USD")).toThrow(/unit is required/);
    expect(() => validateProductDraft({ ...base, baseUnit: "litre" }, "USD")).toThrow(/not a unit/);
  });

  it("accepts every approved unit", () => {
    expect(BASE_UNITS).toEqual(["piece", "box", "pack", "kg", "meter", "other"]);
    for (const u of BASE_UNITS) {
      expect(validateProductDraft({ ...base, baseUnit: u }, "USD").baseUnit).toBe(u);
    }
  });

  it("rejects a price with more precision than the currency has", () => {
    expect(() => validateProductDraft({ ...base, price: "1.001" }, "USD")).toThrow(/decimal places/);
    expect(validateProductDraft({ ...base, price: "1.001" }, "JOD").price.minor).toBe(1001n);
  });
});
