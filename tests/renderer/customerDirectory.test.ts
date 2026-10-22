/**
 * The Customer directory's own decisions, and the structural facts that keep a cart alive.
 *
 * 🔴 THE CART-SURVIVAL TESTS ARE STRUCTURAL BECAUSE THEY HAVE TO BE. This repository has no DOM
 * harness, so "the cart is still there after creating a customer" cannot be asserted by mounting
 * React. What CAN be asserted, and is, is the property that makes it true: the cart lives in
 * `useState` inside SellScreen and the finder renders BESIDE it rather than replacing it. A change
 * that turned the panel into a route — the one edit that would silently destroy a cart mid-sale —
 * fails here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contactPatch,
  disambiguator,
  mayCreateCustomers,
  mayMutateCustomers,
  nameIsValid,
  sameNamed,
} from "../../src/renderer/customerDirectory";
import { translate } from "../../src/shared/i18n";
import type { CustomerDto } from "../../src/shared/ipcContract";

/**
 * Source with its comments removed.
 *
 * 🔴 WITHOUT THIS, EVERY "the screen must not mention X" TEST FAILS ON ITS OWN DOCUMENTATION. The
 * first draft searched raw source for "balance" and "credit" and matched the comments that exist
 * precisely to say those things are ABSENT — the same over-broad search that failed once already in
 * R2. A check about what a merchant sees must look at the code, not at the prose around it.
 */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const customer = (over: Partial<CustomerDto> = {}): CustomerDto => ({
  id: "c1",
  displayName: "محمد علي",
  phone: null,
  address: null,
  note: null,
  isActive: true,
  createdAt: "2026-10-22T08:00:00.000Z",
  ...over,
});

describe("who may do what", () => {
  it("🔴 any signed-in operator may CREATE a customer; only an owner may change one", () => {
    for (const role of ["owner", "admin", "cashier"]) {
      expect(mayCreateCustomers(role), role).toBe(true);
    }
    expect(mayMutateCustomers("owner")).toBe(true);
    expect(mayMutateCustomers("cashier")).toBe(false);
    expect(mayMutateCustomers("admin")).toBe(false);
  });

  it("an absent or unknown role is NOT an owner — the fail-closed reading", () => {
    for (const bad of [null, undefined, "", "OWNER", "superuser"]) {
      expect(mayMutateCustomers(bad as string | null), String(bad)).toBe(false);
    }
    expect(mayCreateCustomers(null)).toBe(false);
    expect(mayCreateCustomers(undefined)).toBe(false);
  });
});

describe("telling two people apart", () => {
  it("🔴 same-named accounts are FOUND, not merged — and the subject is excluded", () => {
    const a = customer({ id: "a", phone: "0100" });
    const b = customer({ id: "b", phone: "0200" });
    const other = customer({ id: "c", displayName: "سمير" });
    expect(sameNamed([a, b, other], "محمد علي").map((c) => c.id)).toEqual(["a", "b"]);
    expect(sameNamed([a, b, other], "محمد علي", "a").map((c) => c.id)).toEqual(["b"]);
  });

  it("matching ignores case, spacing and Arabic-Indic digits, as the service does", () => {
    const list = [customer({ id: "a", displayName: "Ahmad  Saleh" }), customer({ id: "b", displayName: "شركة ٧" })];
    expect(sameNamed(list, "ahmad saleh").map((c) => c.id)).toEqual(["a"]);
    expect(sameNamed(list, "شركة 7").map((c) => c.id)).toEqual(["b"]);
  });

  it("🔴 the disambiguator is a REAL detail, never an index", () => {
    expect(disambiguator(customer({ phone: "0100" }))).toBe("0100");
    expect(disambiguator(customer({ address: "شارع" }))).toBe("شارع");
    expect(disambiguator(customer({ note: "جار المحل" }))).toBe("جار المحل");
    // Genuinely indistinguishable: say nothing rather than invent "1" and "2".
    expect(disambiguator(customer())).toBe("");
    // Phone wins when several exist — it is the thing a merchant actually recognises.
    expect(disambiguator(customer({ phone: "0100", address: "شارع", note: "ملاحظة" }))).toBe("0100");
  });
});

describe("validation and patching", () => {
  it("a name is required, and whitespace is not a name", () => {
    expect(nameIsValid("أحمد")).toBe(true);
    for (const bad of ["", " ", "\t\n"]) expect(nameIsValid(bad), JSON.stringify(bad)).toBe(false);
  });

  it("🔴 an untouched field is ABSENT from the patch, so it writes no history and reverts nothing", () => {
    const before = customer({ displayName: "قديم", phone: "0100", address: "شارع", note: null });
    expect(contactPatch(before, { displayName: "قديم", phone: "0100", address: "شارع", note: "" })).toEqual({});
    expect(contactPatch(before, { displayName: "جديد", phone: "0100", address: "شارع", note: "" })).toEqual({
      displayName: "جديد",
    });
  });

  it("clearing a field sends null, and an empty box means absent rather than blank", () => {
    const before = customer({ phone: "0100", address: "شارع" });
    expect(contactPatch(before, { displayName: before.displayName, phone: "", address: "شارع", note: "" })).toEqual({
      phone: null,
    });
    expect(contactPatch(before, { displayName: before.displayName, phone: "0100", address: "  ", note: "" })).toEqual({
      address: null,
    });
  });
});

describe("the Sell screen keeps its cart", () => {
  const sell = readFileSync("src/renderer/screens/SellScreen.tsx", "utf8");

  it("🔴 the cart, the product search and the idempotency key are SellScreen's own state", () => {
    for (const held of [
      "const [cart, setCart] = useState",
      "const [query, setQuery] = useState",
      "const [qtyDraft, setQtyDraft] = useState",
      "const [attemptKey, setAttemptKey] = useState",
    ]) {
      expect(sell, held).toContain(held);
    }
  });

  it("🔴 the customer finder renders BESIDE that state, not instead of it", () => {
    // A conditional render of an overlay leaves every sibling mounted. An early `return` before the
    // cart, or a route change, would not — and that is the edit this test refuses.
    expect(sell).toContain("{findingCustomer && (");
    expect(sell).toContain("<CustomerFinder");
    // The cart markup is still rendered unconditionally in the same tree.
    expect(sell).toContain('<aside className="cart" data-testid="cart">');
    // 🔴 BOTH LIVE IN THE SAME RETURNED TREE, which is what keeps the cart mounted. Their order in
    // the source does not matter — being SIBLINGS does — so this asserts there is exactly one
    // top-level `return (` and that both the panel and the cart come after it. An early return that
    // rendered the panel INSTEAD of the screen would put one of them before it, and fail here.
    const body = code(sell);
    // The component's own top-level `return (`, found line-anchored — an earlier draft searched for
    // the substring "  return (" and matched the deeply indented returns inside .map() callbacks.
    const mainReturn = /^  return \(/m.exec(body);
    expect(mainReturn, "SellScreen has no top-level return").not.toBeNull();
    const returnAt = mainReturn!.index;
    expect(body.indexOf("{findingCustomer && (")).toBeGreaterThan(returnAt);
    expect(body.indexOf('<aside className="cart"')).toBeGreaterThan(returnAt);
    // 🔴 EXACTLY TWO early returns stand above it, both pre-existing and both states in which there
    // is no cart to lose: the finished-sale receipt, and the catalog-loading guard. They are pinned
    // BY NAME, so a third one — a path that renders without the cart — fails here. An earlier draft
    // of this assertion said "one", which was simply wrong about the file.
    const earlyReturns = body.slice(0, returnAt).match(/^  if \(.*?\) return /gm) ?? [];
    expect(earlyReturns.map((r) => r.trim())).toEqual(["if (completed) return", "if (!catalog) return"]);
  });

  it("🔴 picking a customer sets state and closes the panel — it never clears the cart", () => {
    const pick = sell.slice(sell.indexOf("onPick={(c) => {"), sell.indexOf("onPick={(c) => {") + 160);
    expect(pick).toContain("setCustomer(c)");
    expect(pick).toContain("setFindingCustomer(false)");
    expect(pick).not.toContain("setCart");
    expect(pick).not.toContain("setQuery");
  });

  it("🔴 the screen SAYS the customer is not attached to the sale, in both languages", () => {
    expect(sell).toContain('data-testid="sell-customer-not-attached"');
    expect(sell).toContain('t("customers.notOnSaleYet")');
    // The sentence itself must not claim a debt was recorded.
    const ar = translate("ar", "customers.notOnSaleYet");
    const en = translate("en", "customers.notOnSaleYet");
    expect(ar).toContain("لا يُسجّل ديناً");
    expect(en).toMatch(/records no debt/);
    expect(ar).not.toBe("customers.notOnSaleYet");
    expect(en).not.toBe("customers.notOnSaleYet");
  });

  it("🔴 Sell offers no Credit or Whish control — the posting slice has not landed", () => {
    const body = code(sell);
    for (const forbidden of ["credit", "whish", "Credit", "Whish", "على الحساب"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
    // Positive control: the customer row really IS there, so the test above is not passing by
    // searching a file that has no customer feature in it at all.
    expect(body).toContain('data-testid="sell-choose-customer"');
  });
});

describe("no fabricated accounting", () => {
  const screen = readFileSync("src/renderer/screens/CustomersScreen.tsx", "utf8");
  const finder = readFileSync("src/renderer/screens/CustomerFinder.tsx", "utf8");

  it("🔴 neither customer surface renders a balance, a total or a currency", () => {
    for (const [name, src] of [["CustomersScreen", screen], ["CustomerFinder", finder]] as const) {
      const body = code(src);
      for (const forbidden of ["balance", "Balance", "totalMinor", "balanceMinor", "fmt(", "currency"]) {
        expect(body, `${name} renders ${forbidden}`).not.toContain(forbidden);
      }
    }
    // Positive control: both files really do render customer fields.
    expect(code(screen)).toContain("displayName");
    expect(code(finder)).toContain("displayName");
  });

  it("🔴 no customer label in either dictionary promises money", () => {
    for (const lang of ["ar", "en"] as const) {
      for (const key of ["customers.title", "customers.new", "customers.name", "customers.note"]) {
        const text = translate(lang, key);
        expect(text, `${lang}:${key}`).not.toMatch(/[0-9]/);
      }
    }
    expect(translate("ar", "customers.sameNameHint")).toContain("لم يُدمجا");
  });
});
