import { describe, expect, it } from "vitest";
import {
  MAX_QUANTITY,
  addProduct,
  decrement,
  priceCart,
  removeProduct,
  setQuantity,
} from "../../src/domain/cart";
import { loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";

const catalog = loadCatalog(FIXTURE_CATALOG);

describe("cart editing", () => {
  it("adds, increments, decrements and removes without mutating the input", () => {
    const empty: never[] = [];
    const one = addProduct(empty, "prod-0001");
    expect(empty).toEqual([]);
    expect(one).toEqual([{ productId: "prod-0001", quantity: 1 }]);
    const two = addProduct(one, "prod-0001");
    expect(two).toEqual([{ productId: "prod-0001", quantity: 2 }]);
    expect(one).toEqual([{ productId: "prod-0001", quantity: 1 }]);
    const mixed = addProduct(two, "prod-0003");
    expect(decrement(mixed, "prod-0001")).toEqual([
      { productId: "prod-0001", quantity: 1 },
      { productId: "prod-0003", quantity: 1 },
    ]);
    expect(decrement(decrement(mixed, "prod-0001"), "prod-0001")).toEqual([{ productId: "prod-0003", quantity: 1 }]);
    expect(removeProduct(mixed, "prod-0003")).toEqual([{ productId: "prod-0001", quantity: 2 }]);
  });

  it("rejects invalid quantities", () => {
    const cart = addProduct([], "prod-0001");
    for (const q of [0, -1, 1.5, MAX_QUANTITY + 1, Number.NaN]) {
      expect(() => setQuantity(cart, "prod-0001", q), String(q)).toThrow(/Quantity/);
    }
  });
});

describe("cart pricing", () => {
  it("computes exact line totals and totals from the catalog", () => {
    // 3 x 3.33 + 2 x 1.99 + 1 x 0.75 = 9.99 + 3.98 + 0.75 = 14.72
    const priced = priceCart(catalog, [
      { productId: "prod-0008", quantity: 3 },
      { productId: "prod-0003", quantity: 2 },
      { productId: "prod-0004", quantity: 1 },
    ]);
    expect(priced.lines.map((l) => l.lineTotal.minor)).toEqual([999n, 398n, 75n]);
    expect(priced.subtotal.minor).toBe(1472n);
    expect(priced.total.minor).toBe(1472n);
    expect(priced.currency).toBe("USD");
    expect(priced.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(priced.lines[0]).toMatchObject({ sku: "CKE-CHO", productName: "Chocolate Cake Slice", quantity: 3 });
  });

  it("handles large quantities exactly", () => {
    const priced = priceCart(catalog, [{ productId: "prod-0003", quantity: MAX_QUANTITY }]);
    expect(priced.total.minor).toBe(199n * BigInt(MAX_QUANTITY)); // 19,898.01
  });

  it("refuses an empty cart, unknown products and duplicated lines", () => {
    expect(() => priceCart(catalog, [])).toThrow(/empty/);
    expect(() => priceCart(catalog, [{ productId: "nope", quantity: 1 }])).toThrow(/Unknown product/);
    expect(() =>
      priceCart(catalog, [
        { productId: "prod-0001", quantity: 1 },
        { productId: "prod-0001", quantity: 1 },
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
