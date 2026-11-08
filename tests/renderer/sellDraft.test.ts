/**
 * SELL-CART-LOST-ON-TAB (owner go, 2026-11-08): the Sell screen's cart survives a tab switch.
 *
 * This repository has no DOM harness (see App.tsx's own note), so the component wiring is proven by
 * the E2E `e2e/sell-cart-tab.mjs` against the installed app; here are the pure rules and the source
 * facts the E2E cannot see from outside (sign-out / import drop the draft; a sale finishing after the
 * operator left still empties it).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CartLine, priceCart } from "../../src/domain/cart";
import { loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { type SellDraft, draftFor, keepSellableLines } from "../../src/renderer/sellDraft";

const catalog = loadCatalog(FIXTURE_CATALOG);
const cart: CartLine[] = [
  { productId: "prod-0001", quantityMilli: 2000 },
  { productId: "prod-0003", quantityMilli: 1000 },
];
const draft: SellDraft = { operatorId: "cashier-01", cart, customer: null, attemptKey: "k-1" };

describe("a kept cart belongs to ONE operator", () => {
  it("handed back to the operator who left it — the same object, nothing rebuilt", () => {
    expect(draftFor(draft, "cashier-01")).toBe(draft);
  });
  it("🔴 never to another operator, and never with nobody signed in", () => {
    expect(draftFor(draft, "cashier-02")).toBeNull();
    expect(draftFor(draft, null)).toBeNull();
    expect(draftFor(draft, undefined)).toBeNull();
    expect(draftFor(null, "cashier-01")).toBeNull();
  });
});

describe("a kept cart against the catalogue as it is now", () => {
  it("unchanged catalogue → the same lines, same quantities, same order, same total — nothing duplicated", () => {
    const { kept, dropped } = keepSellableLines(cart, catalog);
    expect(dropped).toBe(0);
    expect(kept).toEqual(cart);
    expect(priceCart(catalog, kept).total).toEqual(priceCart(catalog, cart).total);
  });
  it("a product no longer for sale is dropped (and counted); the rest is kept exactly", () => {
    const narrowed = { ...catalog, products: catalog.products.filter((p) => p.id !== "prod-0003") };
    const { kept, dropped } = keepSellableLines(cart, narrowed);
    expect(dropped).toBe(1);
    expect(kept).toEqual([cart[0]]);
    expect(() => priceCart(narrowed, kept)).not.toThrow();
  });
  it("prices are NEVER kept: the draft holds product + quantity only", () => {
    expect(Object.keys(draft).sort()).toEqual(["attemptKey", "cart", "customer", "operatorId"]);
    for (const l of draft.cart) expect(Object.keys(l).sort()).toEqual(["productId", "quantityMilli"]);
  });
});

describe("source facts the E2E cannot see", () => {
  const app = readFileSync("src/renderer/App.tsx", "utf8");
  const sell = readFileSync("src/renderer/screens/SellScreen.tsx", "utf8");
  const body = (src: string, start: string) => src.slice(src.indexOf(start), src.indexOf("};", src.indexOf(start)));

  it("sign-out drops the draft before the session's operator is cleared", () => {
    const logout = body(app, "const logout = async");
    expect(logout.indexOf("setSellDraft(null)")).toBeGreaterThan(-1);
    expect(logout.indexOf("setSellDraft(null)")).toBeLessThan(logout.indexOf("setCashier(null)"));
  });
  it("a catalogue import starts a fresh till (draft dropped), as before", () => {
    const imp = body(app, "const importCatalog = async");
    expect(imp).toContain("setSellDraft(null)");
  });
  it("Sell receives only the signed-in operator's draft", () => {
    expect(app).toContain("draft={draftFor(sellDraft, cashier.id)}");
  });
  it("a completed sale empties the draft directly, even if the screen is already gone", () => {
    const success = sell.slice(sell.indexOf("setCompleted(result.sale);"), sell.indexOf("} catch (e) {", sell.indexOf("setCompleted(result.sale);")));
    expect(success).toMatch(/draftSink\.current\?\.\(\{ cart: \[\], customer: null, attemptKey: newIdempotencyKey\(\) \}\)/);
  });
  it("switching tabs writes nothing: the draft path calls no main-process channel", () => {
    const mod = readFileSync("src/renderer/sellDraft.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(mod).not.toMatch(/pos\(\)|ipcRenderer|window\.|localStorage|sessionStorage|indexedDB/);
  });
});
