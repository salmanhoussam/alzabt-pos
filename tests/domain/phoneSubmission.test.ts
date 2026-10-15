/**
 * The submission parser, as unit tests. Shape only — the product rules live elsewhere.
 *
 * 🔴 THE DIVISION THIS FILE DEFENDS. `phoneSubmission.ts` must NOT decide that a name is required
 * or that a price is positive; `productDraft.ts` does, and a second copy would drift. So the tests
 * below assert that a missing name is PASSED THROUGH as an empty string rather than refused here,
 * and the integration tests assert the service then refuses it. A parser that started rejecting
 * products would pass its own tests while quietly becoming a second contract.
 */
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { PHONE_SUBMISSION_MAX_BYTES, parsePhoneSubmission } from "../../src/domain/phoneSubmission";

const good = {
  product: { nameAr: "مفتاح", nameEn: "Wrench", sku: "WR-1", price: "12.50", baseUnit: "piece" },
  master: {
    categoryId: "cat-1",
    barcode: "036000291452",
    brand: "Stanley",
    descriptionAr: "وصف",
    descriptionEn: "Desc",
    isOnlineVisible: true,
  },
};

const body = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8");

describe("a well-formed submission", () => {
  it("produces a draft and a form, with values carried through", () => {
    const s = parsePhoneSubmission(body(good));
    expect(s.draft.nameAr).toBe("مفتاح");
    expect(s.draft.nameEn).toBe("Wrench");
    expect(s.draft.sku).toBe("WR-1");
    expect(s.draft.price).toBe("12.50");
    expect(s.draft.baseUnit).toBe("piece");
    expect(s.master.categoryId).toBe("cat-1");
    expect(s.master.brand).toBe("Stanley");
    expect(s.master.isOnlineVisible).toBe(true);
  });

  /**
   * 🔴 THE BARCODE IS NOT NORMALIZED HERE. It is carried through raw so the ONE canonicalizer in
   * `barcode.ts` sees it — pre-processing it in two places is exactly how a typed UPC-A and a
   * decoded EAN-13 become two products.
   */
  it("🔴 leaves the barcode RAW for the one canonicalizer downstream", () => {
    const s = parsePhoneSubmission(body(good));
    expect(s.master.barcode).toBe("036000291452");
    expect(s.master.barcode).not.toBe("0036000291452");
  });

  /**
   * 🔴 "" MEANS DIFFERENT THINGS IN THE TWO GROUPS, DELIBERATELY. For `nameEn`/`sku` it means "not
   * given" (matching `productDraft.ts`'s own `optional()`); for a master field it means "the owner
   * emptied this box", which the patch builder turns into a real clearing `null`. Collapsing the
   * two would make a cleared brand indistinguishable from an untouched one.
   */
  it("🔴 empty selling fields become null; empty master fields stay empty strings", () => {
    const s = parsePhoneSubmission(
      body({
        product: { nameAr: "س", nameEn: "", sku: "   ", price: "1", baseUnit: "piece" },
        master: { categoryId: "", barcode: "", brand: "", descriptionAr: "", descriptionEn: "", isOnlineVisible: false },
      }),
    );
    expect(s.draft.nameEn).toBeNull();
    expect(s.draft.sku).toBeNull();
    expect(s.master.brand).toBe("");
    expect(s.master.categoryId).toBe("");
  });

  it("a missing master key defaults rather than throwing — the form may omit a checkbox", () => {
    const s = parsePhoneSubmission(body({ product: { nameAr: "س", price: "1", baseUnit: "piece" }, master: {} }));
    expect(s.master.isOnlineVisible).toBe(false);
    expect(s.master.brand).toBe("");
  });

  /**
   * 🔴 THE PASS-THROUGH TEST THAT KEEPS THE CONTRACTS SEPARATE. A missing name is NOT refused here.
   * If this ever starts throwing, this module has taken over a rule that belongs to
   * `validateProductDraft`, and the two will diverge.
   */
  it("🔴 does NOT refuse a missing name — that is the draft validator's job", () => {
    const s = parsePhoneSubmission(body({ product: { price: "1", baseUnit: "piece" }, master: {} }));
    expect(s.draft.nameAr).toBe("");
  });

  it("description whitespace and newlines survive — prose is not a name", () => {
    const s = parsePhoneSubmission(
      body({ ...good, master: { ...good.master, descriptionAr: "سطر\nسطر ثانٍ" } }),
    );
    expect(s.master.descriptionAr).toBe("سطر\nسطر ثانٍ");
  });
});

describe("refusals", () => {
  const refuse = (label: string, value: unknown) =>
    it(`refuses ${label}`, () => {
      expect(() => parsePhoneSubmission(body(value)), label).toThrow(DomainError);
    });

  refuse("an array", []);
  refuse("a bare string", "hello");
  refuse("a number", 7);
  refuse("null", null);
  refuse("a missing product group", { master: {} });
  refuse("a missing master group", { product: {} });
  refuse("a product group that is an array", { product: [], master: {} });
  refuse("a master group that is an array", { product: { nameAr: "x" }, master: [] });

  /**
   * 🔴 UNKNOWN FIELDS ARE REFUSED, NOT IGNORED — and these specific ones are the attack. A client
   * that sends `productId` believes it will choose the product; one that sends `isActive` believes
   * it can deactivate. Silently dropping them would let a caller think it had done something it
   * had not, and the only safe answer to that belief is an error.
   */
  refuse("a top-level extra field", { product: { nameAr: "x" }, master: {}, isActive: false });
  refuse("productId inside product", { product: { nameAr: "x", productId: "p1" }, master: {} });
  refuse("id inside product", { product: { nameAr: "x", id: "p1" }, master: {} });
  refuse("isActive inside product", { product: { nameAr: "x", isActive: false }, master: {} });
  refuse("source inside product", { product: { nameAr: "x", source: "manual" }, master: {} });
  refuse("hasImage inside master", { product: { nameAr: "x" }, master: { hasImage: true } });
  refuse("priceNeedsReview inside master", { product: { nameAr: "x" }, master: { priceNeedsReview: false } });

  refuse("a numeric name", { product: { nameAr: 42 }, master: {} });
  refuse("an object price", { product: { nameAr: "x", price: {} }, master: {} });
  refuse("an array sku", { product: { nameAr: "x", sku: [] }, master: {} });
  refuse("a non-boolean visibility", { product: { nameAr: "x" }, master: { isOnlineVisible: "yes" } });
  refuse("a numeric visibility", { product: { nameAr: "x" }, master: { isOnlineVisible: 1 } });

  it("refuses an empty body and invalid JSON", () => {
    expect(() => parsePhoneSubmission(Buffer.alloc(0))).toThrow(DomainError);
    expect(() => parsePhoneSubmission(Buffer.from("<<<", "utf8"))).toThrow(DomainError);
    expect(() => parsePhoneSubmission(Buffer.from("{", "utf8"))).toThrow(DomainError);
  });

  it("🔴 refuses a body past the submission cap, before parsing it", () => {
    const huge = Buffer.alloc(PHONE_SUBMISSION_MAX_BYTES + 1, 0x20);
    expect(() => parsePhoneSubmission(huge)).toThrow(/more data than a product can contain/);
  });

  it("🔴 refuses one enormous FIELD even inside a legal body", () => {
    // Under the whole-body cap is impossible for a 90k field, so this is checked just under it:
    // a single field carrying 20_001 characters is refused by the per-field guard.
    const value = { product: { nameAr: "x".repeat(20_001), price: "1", baseUnit: "piece" }, master: {} };
    expect(() => parsePhoneSubmission(body(value))).toThrow(DomainError);
  });

  it("the error message never quotes the body back", () => {
    let message = "";
    try {
      parsePhoneSubmission(Buffer.from('{"secret":"swordfish"', "utf8"));
    } catch (err) {
      message = (err as DomainError).message;
    }
    expect(message).not.toContain("swordfish");
    expect(message).not.toContain("secret");
  });
});
