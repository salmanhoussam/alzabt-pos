/**
 * DEC-35v regression: duplicates are removed by PLACE on the page, never by numbers alone. INVENTED lines
 * shaped like the shop's real invoices (no real invoice text in the repository): the paint invoice (11
 * different colours, every one 1 × 12.50), the same row read four times, and a conflicting reading.
 */
import { describe, expect, it } from "vitest";
import { rowsFromPositioned } from "../../src/domain/invoiceOcrRows";
import { type PositionedLine, positionedLines, toOriginal } from "../../src/domain/ocrLayout";

const at = (text: string, y: number, source: PositionedLine["source"] = "original", kind: PositionedLine["kind"] = "engine"): PositionedLine => ({
  text, y, h: 30, x0: 100, x1: 1400, source, kind,
});
const COLOURS = ["BLUE GLOSS 11", "RED MATT 22", "GREEN 33", "BLACK GLOSS 44", "WHITE MATT 55", "IVORY 66", "SILVER 77", "BEIGE 88", "BROWN 99", "ORANGE 10", "GREY 12"];

describe("rows by place (DEC-35v)", () => {
  it("🔴 PAINT INVOICE: 11 different colours, every one 1 × 12.50, read TWICE (original + straightened) → exactly 11 rows", () => {
    const lines: PositionedLine[] = [];
    COLOURS.forEach((c, i) => {
      const y = 800 + i * 48;
      lines.push(at(`E-${c} ${c} 1 DZ 12.50 12.50`, y, "original", "engine"));
      lines.push(at(`${c} E-${c} 1 DZ 12.50 12.50`, y + 3, "original", "geometry"));
      lines.push(at(`E-${c.toLowerCase()} ${c} 1 DZ 12.50 12.50`, y - 4, "deskewed", "engine"));
    });
    const r = rowsFromPositioned(lines);
    expect(r.rows).toHaveLength(11);
    expect(r.rows.every((x) => x.lineTotalMinor === 1250n && x.quantityMilli === 1000)).toBe(true);
    expect(r.rows.map((x) => x.readings)).toEqual(Array(11).fill(3));
    expect(r.rows.every((x) => !x.warnings.includes("CONFLICT"))).toBe(true);
    // in page order, each with its own name
    expect(r.rows[0]!.name).toContain("BLUE GLOSS");
    expect(r.rows[10]!.name).toContain("GREY");
  });

  it("the SAME row read four ways (engine/geometry × original/straightened) with different name noise → ONE row, alternatives kept", () => {
    const r = rowsFromPositioned([
      at("1 سلم تجريبي 7 درجات PC 3 21.00 21.00 63.00", 500, "original", "engine"),
      at("63.00 21.00 3 PC سلم تجريبى 7 درجات SHX-1", 506, "original", "geometry"),
      at("1 سلم تجربي 7 درجات PC 3 21.00 63.00", 495, "deskewed", "engine"),
      at("سلم 7 3 21.00 63.00", 503, "deskewed", "geometry"),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ quantityMilli: 3000, supplierPriceMinor: 2100n, lineTotalMinor: 6300n, readings: 4 });
    expect(r.rows[0]!.alternativeNames.length).toBeGreaterThan(0);
  });

  it("🔴 two readings of ONE place with DIFFERENT numbers are NOT merged: both shown, both flagged CONFLICT", () => {
    const r = rowsFromPositioned([at("نايلون تجريبي KG 31 2.35 72.85", 700), at("نايلون تجريبي KG 3 2.35 7.05", 704, "deskewed")]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((x) => x.warnings.includes("CONFLICT"))).toBe(true);
  });

  it("a row found by only one of two readings is flagged SINGLE_READING; a discount row NOT_PLAIN_ARITHMETIC", () => {
    const r = rowsFromPositioned([at("صنف أ 2 1.50 3.00", 300, "original"), at("صنف ب 6.00 9.500 30.00 39.90", 400, "deskewed"), at("صنف أ 2 1.50 3.00", 302, "deskewed")]);
    const a = r.rows.find((x) => x.lineTotalMinor === 300n)!;
    const b = r.rows.find((x) => x.lineTotalMinor === 3990n)!;
    expect(a.warnings).toEqual([]);
    expect(b.warnings).toEqual(expect.arrayContaining(["SINGLE_READING", "NOT_PLAIN_ARITHMETIC"]));
  });

  it("an unexplained line where a row was found is the same line read badly — not reported twice", () => {
    const r = rowsFromPositioned([at("صنف أ 2 1.50 3.00", 300), at("صنف أ 2 1,5O 3.00 ؟؟ 7.25", 302, "deskewed"), at("بند غامض 21.00 63.00", 600)]);
    expect(r.unexplained.map((u) => u.text)).toEqual(["بند غامض 21.00 63.00"]);
  });

  it("🔴 a row whose decimal point was LOST (12.50 read as 1250) is never repaired and never silently dropped: it is listed for manual entry", () => {
    const r = rowsFromPositioned([at("RED MATT 22 1 DZ 1250 12.50", 800), at("BLUE GLOSS 11 1 DZ 12.50 12.50", 848)]);
    expect(r.rows).toHaveLength(1);
    expect(r.unexplained.map((x) => x.text)).toEqual(["RED MATT 22 1 DZ 1250 12.50"]);
  });

  it("a straightened reading is mapped back onto the ORIGINAL photo (rotation inverse of the sampling)", () => {
    const p = toOriginal(1000, 500, 2, 2000, 1000);
    expect(Math.abs(p.y - (499.5 + (1000 - 999.5) * Math.sin((2 * Math.PI) / 180) + (500 - 499.5) * Math.cos((2 * Math.PI) / 180)))).toBeLessThan(1e-9);
    const lines = positionedLines(
      { blocks: [{ paragraphs: [{ lines: [{ text: "x 1 2.00 2.00", bbox: { x0: 0, y0: 490, x1: 2000, y1: 510 }, words: [] }] }] }] },
      "deskewed",
      { skewDegrees: 2, width: 2000, height: 1000 },
    );
    expect(lines[0]!.y).toBeCloseTo(toOriginal(1000, 500, 2, 2000, 1000).y, 6);
  });
});
