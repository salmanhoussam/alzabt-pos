/**
 * The three S1B UI corrections: the Sell button's wording, and bidirectional isolation on every
 * customer surface that DISPLAYS a name.
 *
 * 🔴 WHY THESE ARE SOURCE ASSERTIONS. `vitest.config.mts` is `environment: "node"`, so there is no
 * DOM to measure and "the phone number sits next to its label" cannot be asserted by layout. What
 * CAN be asserted is the property that produced the defect: `dir="auto"` on a BLOCK container sets
 * that element's direction from its own first strong character, which moves the box. A phone
 * number is digits, so it resolved LTR and sat at the far edge of an RTL pane; an Arabic name on an
 * English terminal did the mirror of it. `<bdi>` isolates the run WITHOUT touching alignment, so
 * the box follows the UI language and the name still renders correctly inside it.
 *
 * The visual proof is the Windows gate's screenshots. These tests stop the regression from being
 * reintroduced silently between gates.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mayCreateCustomers, mayMutateCustomers } from "../../src/renderer/customerDirectory";
import { allKeys, translate } from "../../src/shared/i18n";

/** Source with its comments removed — a comment explaining an absence must not satisfy a search. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (path: string): string => code(readFileSync(path, "utf8"));

const SELL = read("src/renderer/screens/SellScreen.tsx");
const SCREEN = read("src/renderer/screens/CustomersScreen.tsx");
const FINDER = read("src/renderer/screens/CustomerFinder.tsx");
const CSS = readFileSync("src/renderer/styles.css", "utf8");

describe("1 · the Sell button says what it does", () => {
  it("🔴 has its own key, and that key is not the record-editing one", () => {
    expect(allKeys()).toContain("sell.changeCustomer");
    expect(translate("ar", "sell.changeCustomer")).toBe("تغيير الزبون");
    expect(translate("en", "sell.changeCustomer")).toBe("Change customer");
    // The edit label still exists for the thing that really edits.
    expect(translate("ar", "customers.edit")).toBe("تعديل");
    expect(translate("en", "customers.edit")).toBe("Edit");
    expect(translate("ar", "sell.changeCustomer")).not.toBe(translate("ar", "customers.edit"));
  });

  it("🔴 Sell renders the change label and never borrows customers.edit", () => {
    expect(SELL).toContain('t("sell.changeCustomer")');
    expect(SELL).not.toContain('t("customers.edit")');
    // The empty state is unchanged.
    expect(SELL).toContain('t("sell.chooseCustomer")');
  });

  it("🔴 a translated key is never the key itself — both languages are really present", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(translate(lang, "sell.changeCustomer")).not.toBe("sell.changeCustomer");
    }
  });

  it("🔴 the button still only reopens the picker — it mutates nothing", () => {
    const button = SELL.slice(SELL.indexOf('data-testid="sell-choose-customer"') - 400);
    expect(button).toContain("setFindingCustomer(true)");
    expect(SELL).not.toContain("updateCustomerContact");
    expect(SELL).not.toContain("setCustomerActive");
  });
});

describe("2 · permission is unchanged by the relabel", () => {
  it("🔴 a cashier may create and choose, and may not edit or archive", () => {
    expect(mayCreateCustomers("cashier")).toBe(true);
    expect(mayMutateCustomers("cashier")).toBe(false);
    expect(mayCreateCustomers("owner")).toBe(true);
    expect(mayMutateCustomers("owner")).toBe(true);
  });

  it("🔴 the edit and archive controls are still behind mayMutate", () => {
    expect(SCREEN).toContain("mayMutate");
    const guarded = SCREEN.indexOf("mayMutate ?");
    expect(guarded).toBeGreaterThan(-1);
    expect(SCREEN.indexOf('data-testid="customers-edit"')).toBeGreaterThan(guarded);
    expect(SCREEN.indexOf('data-testid="customers-archive"')).toBeGreaterThan(guarded);
  });
});

describe("3 · the cart is untouched by choosing a customer", () => {
  it("🔴 the customer is its own state and no handler clears the cart", () => {
    expect(SELL).toContain("setFindingCustomer");
    expect(SELL).toContain("setCustomer");
    // Clearing the customer clears the customer, not the sale.
    expect(SELL).toContain("setCustomer(null)");
    const clear = SELL.slice(SELL.indexOf('data-testid="sell-clear-customer"') - 200);
    expect(clear.slice(0, 200)).not.toContain("setLines");
  });

  it("🔴 nothing on the Sell customer row records money", () => {
    const row = SELL.slice(SELL.indexOf('className="cart-customer"'));
    const block = row.slice(0, row.indexOf("</div>"));
    for (const forbidden of ["balance", "credit", "owes", "due", "Minor"]) {
      expect(block.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("🔴 and the honest sentence is still rendered every time", () => {
    expect(SELL).toContain('t("customers.notOnSaleYet")');
    expect(translate("ar", "customers.notOnSaleYet")).toContain("لا يُسجّل ديناً");
    expect(translate("en", "customers.notOnSaleYet")).toContain("records no debt");
  });
});

describe("4 · displayed names are isolated, not re-directed", () => {
  /**
   * Every element that DISPLAYS a customer name or contact value. An `<input>` is deliberately not
   * here: there `dir="auto"` is right, because the field should follow what the operator types.
   */
  it("🔴 no dir=\"auto\" survives on a span, dd or h2 in the customer surfaces", () => {
    for (const [name, src] of [
      ["CustomersScreen", SCREEN],
      ["CustomerFinder", FINDER],
    ] as const) {
      const offenders = [...src.matchAll(/<(span|dd|h2)\b[^>]*dir="auto"/g)].map((m) => m[0]);
      expect(offenders, `${name} still re-directs a display element`).toEqual([]);
    }
    // The Sell chip specifically — the one customer element on the till screen.
    const chip = SELL.slice(SELL.indexOf('className="customer-chip"'), SELL.indexOf('className="customer-chip"') + 200);
    expect(chip).not.toContain('dir="auto"');
  });

  it("🔴 and each of them wraps its value in <bdi>", () => {
    expect(SCREEN).toMatch(/<h2>\s*<bdi>\{selected\.displayName\}<\/bdi>/);
    expect(SCREEN).toContain("<bdi>{selected.phone ?? \"—\"}</bdi>");
    expect(SCREEN).toContain("<bdi>{selected.address ?? \"—\"}</bdi>");
    expect(SCREEN).toContain("<bdi>{selected.note ?? \"—\"}</bdi>");
    expect(SCREEN).toContain("<bdi>{c.displayName}</bdi>");
    expect(SCREEN).toContain("<bdi>{disambiguator(c)}</bdi>");
    expect(FINDER).toContain("<bdi>{c.displayName}</bdi>");
    expect(FINDER).toContain("<bdi>{disambiguator(c)}</bdi>");
    expect(SELL).toContain("<bdi>{customer.displayName}</bdi>");
  });

  it("🔴 the inputs KEEP dir=\"auto\" — they follow what is typed", () => {
    expect(SCREEN).toMatch(/<input[^>]*dir="auto"/);
    expect(FINDER).toMatch(/<input[^>]*dir="auto"/);
  });

  it("🔴 the disambiguator still distinguishes two same-named people", () => {
    // Guards the fix above: wrapping it in <bdi> must not have dropped the call.
    expect(SCREEN).toContain("disambiguator(c)");
    expect(FINDER).toContain("disambiguator(c)");
    expect(SCREEN).toContain('data-testid="customers-disambiguator"');
    expect(FINDER).toContain('data-testid="customer-disambiguator"');
  });
});

describe("5 · the detail grid still wraps instead of overflowing", () => {
  it("🔴 the value column stays 1fr and long values wrap", () => {
    const block = CSS.slice(CSS.indexOf(".customer-detail dl"));
    expect(block).toContain("grid-template-columns: auto 1fr");
    expect(block.slice(0, 400)).toContain("overflow-wrap: anywhere");
    expect(block.slice(0, 400)).toContain("min-width: 0");
  });

  it("🔴 the narrow-window stacking rule is still there", () => {
    expect(CSS).toContain(".customers-screen { grid-template-columns: 1fr; }");
  });
});

describe("6 · nothing financial was added", () => {
  it("🔴 no customer surface mentions a balance, an obligation or a payment", () => {
    for (const [name, src] of [
      ["CustomersScreen", SCREEN],
      ["CustomerFinder", FINDER],
    ] as const) {
      for (const forbidden of ["balance", "obligation", "settlement", "whish", "receivable"]) {
        expect(src.toLowerCase(), `${name} mentions ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
