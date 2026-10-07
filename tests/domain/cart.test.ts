import { describe, expect, it } from "vitest";
import { addProduct, decrement, priceCart, removeProduct, setQuantityMilli } from "../../src/domain/cart";
import { loadCatalog } from "../../src/domain/catalog";
import { MAX_QUANTITY_MILLI } from "../../src/domain/quantity";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";

const catalog = loadCatalog(FIXTURE_CATALOG);

describe("cart editing", () => {
  it("adds, increments, decrements and removes without mutating the input", () => {
    const empty: never[] = [];
    const one = addProduct(empty, "prod-0001");
    expect(empty).toEqual([]);
    expect(one).toEqual([{ productId: "prod-0001", quantityMilli: 1000 }]);
    const two = addProduct(one, "prod-0001");
    expect(two).toEqual([{ productId: "prod-0001", quantityMilli: 2000 }]);
    expect(one).toEqual([{ productId: "prod-0001", quantityMilli: 1000 }]);
    const mixed = addProduct(two, "prod-0003");
    expect(decrement(mixed, "prod-0001")).toEqual([
      { productId: "prod-0001", quantityMilli: 1000 },
      { productId: "prod-0003", quantityMilli: 1000 },
    ]);
    expect(decrement(decrement(mixed, "prod-0001"), "prod-0001")).toEqual([{ productId: "prod-0003", quantityMilli: 1000 }]);
    expect(removeProduct(mixed, "prod-0003")).toEqual([{ productId: "prod-0001", quantityMilli: 2000 }]);
  });

  it("rejects invalid quantities", () => {
    const cart = addProduct([], "prod-0001");
    // Was `MAX_QUANTITY + 1` on whole units; the bound is now MAX_QUANTITY_MILLI thousandths.
    for (const q of [0, -1, 1.5, MAX_QUANTITY_MILLI + 1, Number.NaN]) {
      expect(() => setQuantityMilli(cart, "prod-0001", q, "piece"), String(q)).toThrow(/quantity/i);
    }
  });

  it("refuses a fraction on a whole-only unit, and accepts one on kg", () => {
    const cart = addProduct([], "prod-0001");
    expect(() => setQuantityMilli(cart, "prod-0001", 2500, "piece")).toThrow(/whole units/);
    expect(setQuantityMilli(cart, "prod-0001", 2500, "kg")).toEqual([
      { productId: "prod-0001", quantityMilli: 2500 },
    ]);
  });
});

describe("cart pricing", () => {
  it("computes exact line totals and totals from the catalog", () => {
    // 3 x 3.33 + 2 x 1.99 + 1 x 0.75 = 9.99 + 3.98 + 0.75 = 14.72
    const priced = priceCart(catalog, [
      { productId: "prod-0008", quantityMilli: 3000 },
      { productId: "prod-0003", quantityMilli: 2000 },
      { productId: "prod-0004", quantityMilli: 1000 },
    ]);
    expect(priced.lines.map((l) => l.lineTotal.minor)).toEqual([999n, 398n, 75n]);
    expect(priced.subtotal.minor).toBe(1472n);
    expect(priced.total.minor).toBe(1472n);
    expect(priced.currency).toBe("USD");
    expect(priced.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(priced.lines[0]).toMatchObject({ sku: "CKE-CHO", productName: "Chocolate Cake Slice", quantityMilli: 3000 });
  });

  it("handles large quantities exactly", () => {
    const priced = priceCart(catalog, [{ productId: "prod-0003", quantityMilli: MAX_QUANTITY_MILLI }]);
    expect(priced.total.minor).toBe(199n * BigInt(MAX_QUANTITY_MILLI / 1000)); // 19,898.01
  });

  it("refuses an empty cart, unknown products and duplicated lines", () => {
    expect(() => priceCart(catalog, [])).toThrow(/empty/);
    expect(() => priceCart(catalog, [{ productId: "nope", quantityMilli: 1000 }])).toThrow(/Unknown product/);
    expect(() =>
      priceCart(catalog, [
        { productId: "prod-0001", quantityMilli: 1000 },
        { productId: "prod-0001", quantityMilli: 1000 },
      ]),
    ).toThrow(/twice/);
  });

  it("validates the catalog itself", () => {
    expect(() =>
      loadCatalog({ currency: "USD", products: [{ id: "a", sku: "S", name: "x", price: "1.001" }] }),
    ).toThrow(/decimal places/);
    expect(() =>
      loadCatalog({
        currency: "USD",
        products: [
          { id: "a", sku: "S", name: "x", price: "1" },
          { id: "b", sku: "S", name: "y", price: "1" },
        ],
      }),
    ).toThrow(/Duplicate SKU/);
  });
});
