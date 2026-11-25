/**
 * J1-RECEIPT-NAMES — the on-screen receipt shows the product name in the screen's language, DISPLAY
 * ONLY, and only when that is verifiably the product that was recorded. Owner finding (J1, 2026-11-19):
 * the Arabic till listed «إسبريسو» in the cart and "Espresso" on the completed-sale screen.
 */
import { describe, expect, it } from "vitest";
import { receiptLineName } from "../../src/renderer/receiptNames";

const espresso = { name: "Espresso", nameAr: "إسبريسو", nameEn: "Espresso" };
const line = (productName: string, productId: string | null = "p1") => ({ productId, productName });

describe("receiptLineName", () => {
  it("Arabic UI: a line recorded as the English name shows the Arabic name, and keeps the recorded one beside it", () => {
    expect(receiptLineName(line("Espresso"), espresso, "ar")).toEqual({ display: "إسبريسو", recorded: "Espresso" });
  });

  it("English UI: the same line shows the English name, with nothing extra (same text as recorded)", () => {
    expect(receiptLineName(line("Espresso"), espresso, "en")).toEqual({ display: "Espresso", recorded: null });
  });

  it("a line recorded in Arabic shows English in the English UI, recorded name kept", () => {
    expect(receiptLineName(line("إسبريسو"), espresso, "en")).toEqual({ display: "Espresso", recorded: "إسبريسو" });
  });

  it("🔴 a product RENAMED since the sale shows the recorded name — never today's name for yesterday's sale", () => {
    const renamed = { name: "Double Espresso", nameAr: "إسبريسو مزدوج", nameEn: "Double Espresso" };
    expect(receiptLineName(line("Espresso"), renamed, "ar")).toEqual({ display: "Espresso", recorded: null });
  });

  it("a product no longer in the catalogue (deactivated / unknown) shows the recorded name", () => {
    expect(receiptLineName(line("Espresso"), undefined, "ar")).toEqual({ display: "Espresso", recorded: null });
  });

  it("an invoice-origin line with no product shows the recorded name", () => {
    expect(receiptLineName(line("Espresso", null), espresso, "ar")).toEqual({ display: "Espresso", recorded: null });
  });

  it("a product with only an Arabic name: English UI falls back to Arabic, never invents a translation", () => {
    const arOnly = { name: "منقوشة زعتر", nameAr: "منقوشة زعتر", nameEn: null };
    expect(receiptLineName(line("منقوشة زعتر"), arOnly, "en")).toEqual({ display: "منقوشة زعتر", recorded: null });
  });

  it("a single-name product (no nameAr/nameEn) is unchanged in both languages", () => {
    const single = { name: "Water 500ml" };
    expect(receiptLineName(line("Water 500ml"), single, "ar")).toEqual({ display: "Water 500ml", recorded: null });
    expect(receiptLineName(line("Water 500ml"), single, "en")).toEqual({ display: "Water 500ml", recorded: null });
  });

  it("whitespace differences do not count as a rename", () => {
    expect(receiptLineName(line(" Espresso "), espresso, "ar")).toEqual({ display: "إسبريسو", recorded: " Espresso " });
  });

  it("the function never returns an empty display", () => {
    const blankAr = { name: "Espresso", nameAr: "  ", nameEn: "Espresso" };
    expect(receiptLineName(line("Espresso"), blankAr, "ar").display.trim()).not.toBe("");
  });
});
