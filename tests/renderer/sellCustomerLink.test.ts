/**
 * SELL-CUSTOMER-LINK (ACC-2) — the Sell screen's wiring, read from source (no DOM harness here).
 * The behaviour itself is proven end to end in e2e/customers.mjs (ACC-2 section) and in
 * tests/application/sellCustomerLink.test.ts; these guard the three renderer rules that keep a
 * linked sale from landing on the wrong customer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sell = readFileSync("src/renderer/screens/SellScreen.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const between = (from: string, to: string) => sell.slice(sell.indexOf(from), sell.indexOf(to, sell.indexOf(from)));

describe("the Sell screen sends the customer by id, and never a stale one", () => {
  it("🔴 the paid sale carries `customerId` only when a customer is chosen — never a name", () => {
    const pay = between("const pay = async", "if (completed)");
    expect(pay).toContain("...(customer === null ? {} : { customerId: customer.id })");
    expect(pay).not.toMatch(/customerName|displayName/);
  });

  it("🔴 a completed sale clears the customer, so the next sale never inherits it", () => {
    const pay = between("const pay = async", "if (completed)");
    expect(pay.indexOf("setCustomer(null)")).toBeGreaterThan(pay.indexOf("setCompleted(result.sale)"));
  });

  it("🔴 choosing or clearing a customer replaces the checkout key, like a cart edit", () => {
    const pick = between("onPick={(c) => {", "}}");
    expect(pick).toContain("setCustomer(c)");
    expect(pick).toContain("setAttemptKey(newIdempotencyKey())");
    const clear = between("setCustomer(null);\n                  setAttemptKey", "data-testid=\"sell-clear-customer\"");
    expect(clear).toContain("setAttemptKey(newIdempotencyKey())");
  });
});
