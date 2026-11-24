/** Newly authored synthetic inputs; these do not reproduce photo OCR readings. */
import { describe, expect, it } from "vitest";
import { bareName, respaced, rowsFromPositioned } from "../../src/domain/invoiceOcrRows";
import type { OcrSource, PositionedLine } from "../../src/domain/ocrLayout";

type L = [text: string, y: number, h: number, source: OcrSource, kind: "engine" | "geometry"];
const lines = (rows: readonly L[]): PositionedLine[] => rows.map(([text, y, h, source, kind]) => ({ text, y, h, x0: 0, x1: 1000, source, kind }));

describe("synthetic OCR row regressions", () => {
  it("supplements a broken total with a balancing digits reading", () => {
    const original: L[] = [["0 7.25 2 صنف تجريبي", 400, 20, "original", "engine"]];
    expect(rowsFromPositioned(lines(original)).rows).toHaveLength(0);
    const result = rowsFromPositioned(lines([...original, ["2 7.25 14.50", 400, 20, "digits", "engine"]]));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ name: "صنف تجريبي", quantityMilli: 2000, supplierPriceMinor: 725n, lineTotalMinor: 1450n });
    expect(result.rows[0]!.warnings).toContain("SINGLE_READING");
  });
  it("does not infer a row from an unbalanced digits reading", () => {
    const result = rowsFromPositioned(lines([["صنف تجريبي 3 1.75", 500, 20, "original", "engine"], ["3 1.75 9.99", 500, 20, "digits", "engine"]]));
    expect(result.rows).toHaveLength(0);
  });
  it("flags conflicting balanced readings", () => {
    const result = rowsFromPositioned(lines([["صنف تجريبي 3 1.75 5.25", 500, 20, "original", "engine"], ["3 2.75 8.25", 500, 20, "digits", "engine"]]));
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.warnings.includes("CONFLICT"))).toBe(true);
  });
  it("does not duplicate an overlapping tall digits box", () => {
    const result = rowsFromPositioned(lines([["صنف تجريبي 2 17.00 34.00", 640, 20, "original", "engine"], ["2 17.00 34.00", 633, 20, "digits", "geometry"], ["xx 2 17.00 34.00", 657, 73, "digits", "engine"]]));
    expect(result.rows).toHaveLength(1);
  });
});

describe("synthetic OCR name handling", () => {
  it("borrows safe spacing without changing characters or digits", () => {
    expect(respaced("صنفتجريبي", "صنف تجريبي")).toBe("صنف تجريبي");
    expect(respaced("صنفتجريبي", "صنف تخريبي")).toBe("صنفتجريبي");
    expect(respaced("SKU AB1234", "SKU AB12 34")).toBe("SKU AB1234");
  });
  it.each([["0 7.25 2 صنف تجريبي", "صنف تجريبي"], ["12 7", ""], ["Synthetic item 8mm", "Synthetic item 8mm"]])("strips numeric columns from %s", (input, expected) => {
    expect(bareName(input)).toBe(expected);
  });
});
