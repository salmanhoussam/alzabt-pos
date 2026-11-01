/**
 * SELL-BARCODE: what Enter in the Sell search does with a scanned code.
 *
 * Synthetic products and codes only. Every numeric code below was checked against the GS1
 * check-digit rule before use: the valid ones are valid and the "invalid" ones fail ONLY their
 * check digit, so a refusal here is the check digit and nothing else.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addProduct, type CartLine } from "../../src/domain/cart";
import { type CatalogSource, loadCatalog } from "../../src/domain/catalog";
import { DomainError } from "../../src/domain/errors";
import { QUANTITY_SCALE } from "../../src/domain/quantity";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import {
  SCAN_MESSAGE_KEY,
  enterAction,
  isSearchShortcut,
  isTypeToSearch,
  quantityEnterAction,
  refuseEnterActivation,
  resolveScan,
} from "../../src/renderer/sellScan";
import { fromCatalogDto, toCatalogDto } from "../../src/shared/dto";
import { translate } from "../../src/shared/i18n";

const SOURCE: CatalogSource = {
  currency: "USD",
  products: [
    // Mineral Water as the field test stored it: the UPC-A 123456789012 in its EAN-13 form.
    { id: "water", sku: "W-1", name: "Mineral Water", price: "0.50", barcode: "0123456789012" },
    { id: "ean8", sku: null, name: "Small pack", price: "1.00", barcode: "96385074" },
    { id: "code128", sku: null, name: "Shelf label item", price: "2.00", barcode: "Alz-1" },
    // A product whose SKU IS a valid EAN-13 and whose name CONTAINS digits — the look-alikes that
    // the old Enter rule would have added and the scan rule must not.
    { id: "lookalike", sku: "5901234123457", name: "Paint 590123", price: "3.00" },
  ],
  inactiveBarcodes: ["4006381333931"],
};
const catalog = loadCatalog(SOURCE);

describe("resolveScan — an active product's canonical barcode adds it", () => {
  it("🔴 a 12-digit UPC-A finds the product stored as its 13-digit EAN-13 form", () => {
    expect(resolveScan("123456789012", catalog)).toEqual({ kind: "add", productId: "water" });
  });

  it("the EAN-13 itself finds the same product", () => {
    expect(resolveScan("0123456789012", catalog)).toEqual({ kind: "add", productId: "water" });
  });

  it("spaces anywhere in the scanned text are removed, as normalizeBarcode defines", () => {
    expect(resolveScan(" 0123 4567 89012 ", catalog)).toEqual({ kind: "add", productId: "water" });
  });

  it("an EAN-8 matches exactly", () => {
    expect(resolveScan("96385074", catalog)).toEqual({ kind: "add", productId: "ean8" });
  });

  it("🔴 an alphanumeric code keeps its case: 'Alz-1' adds, 'alz-1' is another code", () => {
    expect(resolveScan("Alz-1", catalog)).toEqual({ kind: "add", productId: "code128" });
    expect(resolveScan("alz-1", catalog)).toEqual({ kind: "unknown" });
  });
});

describe("resolveScan — a miss never sells a look-alike", () => {
  it("🔴 a valid EAN-13 no product carries is unknown, even when a product's SKU equals it", () => {
    expect(resolveScan("5901234123457", catalog)).toEqual({ kind: "unknown" });
  });

  it("🔴 digits contained in a product's name are unknown, not that product", () => {
    expect(resolveScan("590123", catalog)).toEqual({ kind: "unknown" });
  });

  it("🔴 a product's full name or SKU typed exactly does not add it on Enter", () => {
    expect(resolveScan("Paint 590123", catalog)).toEqual({ kind: "unknown" });
    expect(resolveScan("W-1", catalog)).toEqual({ kind: "unknown" });
    expect(resolveScan("Mineral Water", catalog)).toEqual({ kind: "unknown" });
  });

  it("a partial barcode is not a match", () => {
    expect(resolveScan("012345678901", catalog)).not.toEqual({ kind: "add", productId: "water" });
    expect(resolveScan("9638507", catalog)).toEqual({ kind: "unknown" });
  });
});

describe("resolveScan — inactive, invalid, empty", () => {
  it("🔴 an inactive product's code says inactive, and nothing about it is sellable", () => {
    expect(resolveScan("4006381333931", catalog)).toEqual({ kind: "inactive" });
    expect(catalog.products.some((p) => p.barcode === "4006381333931")).toBe(false);
  });

  it("a wrong check digit on EAN-13, UPC-A and EAN-8 is invalid", () => {
    expect(resolveScan("0123456789013", catalog)).toEqual({ kind: "invalid" });
    expect(resolveScan("123456789013", catalog)).toEqual({ kind: "invalid" });
    expect(resolveScan("96385075", catalog)).toEqual({ kind: "invalid" });
    expect(resolveScan("4006381333932", catalog)).toEqual({ kind: "invalid" });
  });

  it("🔴 an alphanumeric code is never 'invalid' for lacking an EAN check digit", () => {
    expect(resolveScan("ABC-123", catalog)).toEqual({ kind: "unknown" });
  });

  it("text longer than any barcode is unknown when it is not all digits", () => {
    expect(resolveScan("x".repeat(60), catalog)).toEqual({ kind: "unknown" });
  });

  it("an empty or blank field resolves to nothing", () => {
    expect(resolveScan("", catalog)).toEqual({ kind: "none" });
    expect(resolveScan("   ", catalog)).toEqual({ kind: "none" });
  });

  it("a catalog with no barcodes at all (the demo fixture) still answers, with unknown", () => {
    expect(resolveScan("0123456789012", loadCatalog(FIXTURE_CATALOG))).toEqual({ kind: "unknown" });
  });
});

describe("Enter: one press, one resolution", () => {
  it("a deliberate Enter submits", () => {
    expect(enterAction({ key: "Enter", repeat: false, isComposing: false })).toBe("submit");
  });

  it("🔴 an auto-repeated Enter (the key held down) is swallowed, so it adds nothing more", () => {
    expect(enterAction({ key: "Enter", repeat: true, isComposing: false })).toBe("swallow");
  });

  it("Enter that confirms an input-method composition is left to the IME", () => {
    expect(enterAction({ key: "Enter", repeat: false, isComposing: true })).toBe("ignore");
  });

  it("every other key is ignored", () => {
    expect(enterAction({ key: "a", repeat: false, isComposing: false })).toBe("ignore");
    expect(enterAction({ key: "Tab", repeat: false, isComposing: false })).toBe("ignore");
  });

  it("🔴 two intentional scans of the same item make quantity 2 — one line, not two", () => {
    let cart: CartLine[] = [];
    for (const scan of ["123456789012", "0123456789012"]) {
      const outcome = resolveScan(scan, catalog);
      if (outcome.kind !== "add") throw new Error(`expected add, got ${outcome.kind}`);
      cart = addProduct(cart, outcome.productId);
    }
    expect(cart).toEqual([{ productId: "water", quantityMilli: 2 * QUANTITY_SCALE }]);
  });
});

describe("the / shortcut", () => {
  const key = (over: Partial<Parameters<typeof isSearchShortcut>[0]> = {}) => ({
    key: "/",
    code: "Slash",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("/ from the page focuses the search", () => {
    expect(isSearchShortcut(key(), { tagName: "BUTTON" })).toBe(true);
    expect(isSearchShortcut(key(), { tagName: "BODY" })).toBe(true);
    expect(isSearchShortcut(key(), null)).toBe(true);
  });

  it("🔴 the same physical key on the Arabic layout (it types «ظ») counts", () => {
    expect(isSearchShortcut(key({ key: "ظ" }), { tagName: "BODY" })).toBe(true);
  });

  it("never while typing in a field", () => {
    expect(isSearchShortcut(key(), { tagName: "INPUT" })).toBe(false);
    expect(isSearchShortcut(key(), { tagName: "TEXTAREA" })).toBe(false);
    expect(isSearchShortcut(key(), { tagName: "SELECT" })).toBe(false);
    expect(isSearchShortcut(key(), { tagName: "DIV", isContentEditable: true })).toBe(false);
  });

  it("never with a modifier, and not for shift+/ (which is '?')", () => {
    expect(isSearchShortcut(key({ ctrlKey: true }), null)).toBe(false);
    expect(isSearchShortcut(key({ altKey: true }), null)).toBe(false);
    expect(isSearchShortcut(key({ metaKey: true }), null)).toBe(false);
    expect(isSearchShortcut(key({ key: "?", shiftKey: true }), null)).toBe(false);
  });

  it("other keys do nothing", () => {
    expect(isSearchShortcut(key({ key: "a", code: "KeyA" }), null)).toBe(false);
  });
});

describe("the catalog carries barcodes, and inactive ones as strings only", () => {
  it("loadCatalog keeps each product's barcode; a source without barcodes means none", () => {
    expect(catalog.byId.get("water")!.barcode).toBe("0123456789012");
    expect(catalog.byId.get("lookalike")!.barcode).toBeNull();
    const fixture = loadCatalog(FIXTURE_CATALOG);
    expect(fixture.products.every((p) => p.barcode === null)).toBe(true);
    expect(fixture.inactiveBarcodes.size).toBe(0);
  });

  it("🔴 one code, one product: a duplicate active barcode refuses the catalog", () => {
    const dup: CatalogSource = {
      currency: "USD",
      products: [
        { id: "a", sku: null, name: "A", price: "1.00", barcode: "96385074" },
        { id: "b", sku: null, name: "B", price: "1.00", barcode: "96385074" },
      ],
    };
    expect(() => loadCatalog(dup)).toThrow(DomainError);
  });

  it("🔴 a code cannot be both active and inactive", () => {
    const both: CatalogSource = {
      currency: "USD",
      products: [{ id: "a", sku: null, name: "A", price: "1.00", barcode: "96385074" }],
      inactiveBarcodes: ["96385074"],
    };
    expect(() => loadCatalog(both)).toThrow(DomainError);
  });

  it("🔴 the DTO carries inactive codes as bare strings — no id, name or price", () => {
    const dto = toCatalogDto(catalog);
    expect(dto.inactiveBarcodes).toEqual(["4006381333931"]);
    expect(dto.inactiveBarcodes.every((c) => typeof c === "string")).toBe(true);
    expect(dto.products.map((p) => p.id)).not.toContain("inactive");
    expect(Object.keys(dto).sort()).toEqual(["currency", "inactiveBarcodes", "products"]);
  });

  it("the DTO round trip keeps barcodes and the inactive set, and the decision still holds", () => {
    const back = fromCatalogDto(JSON.parse(JSON.stringify(toCatalogDto(catalog))));
    expect(back.byId.get("water")!.barcode).toBe("0123456789012");
    expect([...back.inactiveBarcodes]).toEqual(["4006381333931"]);
    expect(resolveScan("123456789012", back)).toEqual({ kind: "add", productId: "water" });
    expect(resolveScan("4006381333931", back)).toEqual({ kind: "inactive" });
  });
});

describe("the three refusals read as approved, in both languages", () => {
  it("each outcome has its own key", () => {
    expect(new Set(Object.values(SCAN_MESSAGE_KEY)).size).toBe(3);
  });

  it("🔴 the owner-approved wording, verbatim", () => {
    expect(translate("ar", SCAN_MESSAGE_KEY.unknown)).toBe("لم يتم العثور على منتج بهذا الباركود.");
    expect(translate("en", SCAN_MESSAGE_KEY.unknown)).toBe("No product found for this barcode.");
    expect(translate("ar", SCAN_MESSAGE_KEY.inactive)).toBe("هذا المنتج غير نشط ولا يمكن بيعه.");
    expect(translate("en", SCAN_MESSAGE_KEY.inactive)).toBe("This product is inactive and cannot be sold.");
    expect(translate("ar", SCAN_MESSAGE_KEY.invalid)).toBe("الباركود غير صالح. تأكد من الرمز وحاول مجدداً.");
    expect(translate("en", SCAN_MESSAGE_KEY.invalid)).toBe("Invalid barcode. Check the code and try again.");
  });
});

describe("the Sell screen routes Enter through the scan decision", () => {
  // Comments stripped, so an explanation of the OLD rule cannot satisfy or fail these checks.
  const sell = readFileSync("src/renderer/screens/SellScreen.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const handler = sell.slice(sell.indexOf('data-testid="product-search"'), sell.indexOf('className="search-kbd"'));

  it("🔴 the search field's Enter resolves a scan and adds only its product", () => {
    expect(handler).toContain("enterAction(");
    expect(handler).toContain("resolveScan(query, catalog)");
    // TRANSITION (hardening round): the add moved from this handler into `applyScan`, which the
    // quantity box shares, so both paths add a scanned product in exactly one way.
    expect(handler).toContain("applyScan(query, outcome)");
    const apply = sell.slice(sell.indexOf("const applyScan ="), sell.indexOf("const applyScan =") + 700);
    expect(apply).toContain("addProduct(cart, outcome.productId)");
  });

  it("🔴 the old look-alike rule is gone from Enter: no single-visible-result, no SKU/name equality", () => {
    expect(handler).not.toContain("visible.length === 1");
    expect(handler).not.toContain("visible.find(");
    expect(handler).not.toMatch(/addProduct\(cart, (chosen|exact|unique)/);
  });

  it("the field takes focus when the screen opens", () => {
    expect(handler).toContain("autoFocus");
  });
});

// ── Hardening round: payment, quantity box, focus ────────────────────────────────────────────────

describe("🔴 a scan never confirms a payment or clears the cart", () => {
  const press = (key: string) => {
    let prevented = false;
    refuseEnterActivation({ key, preventDefault: () => (prevented = true) });
    return prevented;
  };

  it("Enter's default (a native button's activation) is refused on a confirming control", () => {
    expect(press("Enter")).toBe(true);
  });

  it("Space — the deliberate keyboard activation — and every other key are left alone", () => {
    expect(press(" ")).toBe(false);
    expect(press("Tab")).toBe(false);
    expect(press("1")).toBe(false);
    expect(press("Escape")).toBe(false);
  });

  // Comments stripped, so the explanation of the rule cannot satisfy these checks by itself.
  const sell = readFileSync("src/renderer/screens/SellScreen.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("every payment method button refuses Enter", () => {
    const payButton = sell.slice(sell.indexOf("PAYMENT_METHODS.map("), sell.indexOf("onClick={() => pay(m)}") + 30);
    expect(payButton).toContain("onKeyDown={refuseEnterActivation}");
    expect(payButton).toContain("data-testid={`pay-${m}`}");
  });

  it("the clear-cart confirmation refuses Enter", () => {
    const confirm = sell.slice(sell.indexOf('data-testid="clear-confirm"'), sell.indexOf('data-testid="clear-confirm"') + 120);
    expect(confirm).toContain("onKeyDown={refuseEnterActivation}");
  });

  it("the payment and its accounting are untouched: pay() still sends the same request", () => {
    const pay = sell.slice(sell.indexOf("const pay = async"), sell.indexOf("if (completed) return"));
    expect(pay).toContain("idempotencyKey: attemptKey");
    expect(pay).toContain("paymentMethod: method");
    expect(pay).toContain("expectedTotalMinor: priced.total.minor.toString()");
  });
});

describe("🔴 the quantity box: a scan does not become a quantity", () => {
  const small: CatalogSource = {
    currency: "USD",
    products: [
      ...SOURCE.products,
      // A product whose code is ALSO a plausible quantity — the case a careless rule would hijack.
      { id: "short", sku: null, name: "Short code", price: "1.00", barcode: "12" },
    ],
    inactiveBarcodes: SOURCE.inactiveBarcodes,
  };
  const cat = loadCatalog(small);
  const q = (text: string) => quantityEnterAction(text, cat);

  it("normal quantity editing is unchanged: whole, fractional, small numbers", () => {
    expect(q("3")).toEqual({ kind: "quantity" });
    expect(q("1.5")).toEqual({ kind: "quantity" });
    expect(q("0.25")).toEqual({ kind: "quantity" });
    expect(q(" 7 ")).toEqual({ kind: "quantity" });
  });

  it("🔴 a quantity-shaped text stays a quantity even when some product's barcode equals it", () => {
    expect(q("12")).toEqual({ kind: "quantity" });
  });

  it("🔴 a four-digit code typed into the box is still a quantity — the ambiguity is real and pinned", () => {
    expect(q("1234")).toEqual({ kind: "quantity" });
    expect(q("9999")).toEqual({ kind: "quantity" });
  });

  it("🔴 an active product's barcode in the box is that product's scan, not a quantity", () => {
    expect(q("96385074")).toEqual({ kind: "scan", outcome: { kind: "add", productId: "ean8" } });
    expect(q("123456789012")).toEqual({ kind: "scan", outcome: { kind: "add", productId: "water" } });
    expect(q(" 0123 4567 89012 ")).toEqual({ kind: "scan", outcome: { kind: "add", productId: "water" } });
    expect(q("Alz-1")).toEqual({ kind: "scan", outcome: { kind: "add", productId: "code128" } });
  });

  it("an inactive product's barcode in the box says inactive", () => {
    expect(q("4006381333931")).toEqual({ kind: "scan", outcome: { kind: "inactive" } });
  });

  it("🔴 more digits than any quantity has is a scan: unknown or invalid, never a quantity", () => {
    expect(q("12345")).toEqual({ kind: "scan", outcome: { kind: "unknown" } });
    expect(q("5901234123457")).toEqual({ kind: "scan", outcome: { kind: "unknown" } });
    expect(q("0123456789013")).toEqual({ kind: "scan", outcome: { kind: "invalid" } });
  });

  it("invalid input that is no product's code still reaches the quantity parser and its own refusal", () => {
    expect(q("abc")).toEqual({ kind: "quantity" });
    expect(q("1.5.5")).toEqual({ kind: "quantity" });
    expect(q("12345.5")).toEqual({ kind: "quantity" });
    expect(q("")).toEqual({ kind: "quantity" });
  });

  it("the Sell screen's quantity box routes Enter through this decision and returns focus", () => {
    const sell = readFileSync("src/renderer/screens/SellScreen.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const box = sell.slice(sell.indexOf("data-testid={`qty-${l.productId}`}"), sell.indexOf("onBlur={() => commitQuantity"));
    expect(box).toContain("quantityEnterAction(text, catalog)");
    expect(box).toContain("enterAction(");
    expect(box).toContain("commitQuantity(l.productId, l.saleUnit)");
    expect(box).toContain("focusSearchAfterRender(");
  });
});

describe("type to search: a key typed on a control goes to the search field", () => {
  const k = (key: string, over: Partial<Parameters<typeof isTypeToSearch>[0]> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    ...over,
  });

  it("🔴 a digit or letter on a card, a cart button or a tab moves focus to the field", () => {
    expect(isTypeToSearch(k("0"), { tagName: "BUTTON" })).toBe(true);
    expect(isTypeToSearch(k("A"), { tagName: "BUTTON" })).toBe(true);
    expect(isTypeToSearch(k("م"), { tagName: "BODY" })).toBe(true);
    expect(isTypeToSearch(k("7"), null)).toBe(true);
  });

  it("Space, Enter, arrows and Tab keep their meaning on the focused control", () => {
    expect(isTypeToSearch(k(" "), { tagName: "BUTTON" })).toBe(false);
    expect(isTypeToSearch(k("Enter"), { tagName: "BUTTON" })).toBe(false);
    expect(isTypeToSearch(k("ArrowDown"), { tagName: "BUTTON" })).toBe(false);
    expect(isTypeToSearch(k("Tab"), { tagName: "BUTTON" })).toBe(false);
  });

  it("never from a text field — a quantity box keeps what is typed into it", () => {
    expect(isTypeToSearch(k("4"), { tagName: "INPUT" })).toBe(false);
    expect(isTypeToSearch(k("4"), { tagName: "TEXTAREA" })).toBe(false);
    expect(isTypeToSearch(k("4"), { tagName: "DIV", isContentEditable: true })).toBe(false);
  });

  it("never a modifier chord, and never a key a control already claimed (the card's p preview)", () => {
    expect(isTypeToSearch(k("c", { ctrlKey: true }), { tagName: "BUTTON" })).toBe(false);
    expect(isTypeToSearch(k("p", { defaultPrevented: true }), { tagName: "BUTTON" })).toBe(false);
  });
});

describe("Sell tab clicked while Sell is open", () => {
  it("🔴 the tab bar asks the Sell screen to take focus back, only for that click", () => {
    const app = readFileSync("src/renderer/App.tsx", "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(app).toContain('if (name === "sell" && tab === "sell") setSellFocusRequest((n) => n + 1);');
    expect(app).toContain("<SellScreen key={catalogVersion} focusRequest={sellFocusRequest} />");
  });
});
