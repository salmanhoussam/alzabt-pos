/**
 * OCR lines → candidate rows. INVENTED supplier lines only (no real invoice text in the repository).
 * The cases are the SHAPES measured on the shop's real invoices (DEC-35t): plain, discount, boxes,
 * pack conversion, a lost decimal point, a row number multiplying an amount, Arabic-Indic digits.
 */
import { describe, expect, it } from "vitest";
import { rowsFromLines } from "../../src/domain/invoiceOcrRows";

describe("invoice OCR rows", () => {
  it("R1 plain: qty × price = total, the name keeps its words and drops the numbers", () => {
    const r = rowsFromLines(["1 مسامير خشب 4 سم PCS 12 0.75 9.00"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ relation: "R1", quantityMilli: 12000, supplierPriceMinor: 75n, lineTotalMinor: 900n, arithmeticOk: true });
    expect(r.rows[0]!.name).toContain("مسامير خشب");
  });

  it("R2 discount column: 6 × 9.50 − 30 % = 39.90, labelled, never 'arithmeticOk'", () => {
    const r = rowsFromLines(["كماشة تجريبية PCS 6.00 9.500 30.00 39.90"]);
    expect(r.rows[0]).toMatchObject({ relation: "R2", discountPercent: 30, lineTotalMinor: 3990n, arithmeticOk: false });
  });

  it("R3 boxes: 3 boxes × 23.40, 12 pieces × 1.95 = 23.40 → 36 pieces at 1.95", () => {
    const r = rowsFromLines(["MSX-9 لاصق تجريبي 3 36 1.95 23.40 70.20"]);
    expect(r.rows[0]).toMatchObject({ relation: "R3", quantityMilli: 36000, supplierPriceMinor: 195n, lineTotalMinor: 7020n });
  });

  it("🔴 a LOST decimal point never becomes a row (235 read for 2.35)", () => {
    const r = rowsFromLines(["1 نايلون تجريبي KG 31 235 235 7285"]);
    expect(r.rows).toHaveLength(0);
  });

  it("🔴 a row number of 1 does not turn an amount into a row; two decimal amounts are reported UNEXPLAINED", () => {
    const r = rowsFromLines(["1 بند تجريبي 21.00 63.00"]);
    expect(r.rows).toHaveLength(0);
    expect(r.unexplained).toEqual(["1 بند تجريبي 21.00 63.00"]);
  });

  it("Arabic-Indic digits are normalised for the arithmetic; the original text is kept", () => {
    const r = rowsFromLines(["علبة تجريبية ٣ ٢٫٥٠ ٧٫٥٠"]);
    expect(r.rows[0]).toMatchObject({ quantityMilli: 3000, supplierPriceMinor: 250n, lineTotalMinor: 750n });
    expect(r.rows[0]!.rawText).toContain("٢٫٥٠");
  });

  it("🔴 two DIFFERENT items with the same numbers stay TWO rows (paint invoice: 1 × 12.50 each)", () => {
    const r = rowsFromLines(["BLUE GLOSS 11 1 DZ 12.50 12.50", "RED MATT 22 1 DZ 12.50 12.50", "BLUE GLOSS 11 1 DZ 12.50 12.50"]);
    expect(r.rows).toHaveLength(2);
  });

  it("the same numbers read twice (text line + geometric line) make ONE row", () => {
    expect(rowsFromLines(["صنف أ 2 1.50 3.00", "صنف أ 2 1.50 3.00"]).rows).toHaveLength(1);
  });
});
