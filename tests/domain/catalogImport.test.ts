/**
 * The strict catalog import format. Synthetic data only — no merchant names or prices are ever
 * committed to this public repository.
 */
import { describe, expect, it } from "vitest";
import { displayName } from "../../src/domain/catalog";
import { DomainError } from "../../src/domain/errors";
import { IMPORT_HEADER, decodeUtf8Strict, parseCsv, validateImport } from "../../src/domain/catalogImport";

const HEADER = IMPORT_HEADER.join(",");
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  throw new Error("expected a DomainError");
}

describe("CSV parsing", () => {
  it("handles quotes, doubled quotes (inch marks), embedded commas, CRLF and a BOM", () => {
    const text = '\uFEFFa,b\r\n1,"علبة بسكويت 2"""\r\n2,"x, y"\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["1", 'علبة بسكويت 2"'],
      ["2", "x, y"],
    ]);
  });

  it("refuses a file that ends inside a quoted field", () => {
    expect(code(() => parseCsv('a,b\n1,"open'))).toBe("IMPORT_REJECTED");
  });
});

describe("UTF-8 decoding", () => {
  it("keeps Arabic exactly (round trip through bytes)", () => {
    const original = "بيبسي 330 مل";
    expect(decodeUtf8Strict(new TextEncoder().encode(original))).toBe(original);
  });

  it("refuses a legacy code-page file (Windows-1256 Arabic bytes) instead of importing mojibake", () => {
    // "مياه" in Windows-1256: E3 ED C7 E5 — not valid UTF-8.
    expect(code(() => decodeUtf8Strict(new Uint8Array([0xe3, 0xed, 0xc7, 0xe5])))).toBe("IMPORT_REJECTED");
  });
});

describe("validateImport", () => {
  it("converts prices to exact minor units and keeps Arabic names as written", () => {
    const { rows, rejected } = validateImport(
      csv("1,بيبسي 330 مل,,1.00,USD,piece,0", "2,مياه,Water,3.5,USD,piece,0", "3,  شيبس   كبير ,,12,USD,box,0", "4,مياه,,0.01,USD,piece,1"),
      "USD",
    );
    expect(rejected).toEqual([]);
    expect(rows.map((r) => [r.sourceId, r.nameAr, r.nameEn, r.priceMinor, r.baseUnit, r.priceNeedsReview])).toEqual([
      ["1", "بيبسي 330 مل", null, 100n, "piece", false],
      ["2", "مياه", "Water", 350n, "piece", false],
      ["3", "شيبس كبير", null, 1200n, "box", false],
      ["4", "مياه", null, 1n, "piece", true],
    ]);
  });

  it("display name: English when present, otherwise the Arabic name (never a translation)", () => {
    expect(displayName("مياه", "Water")).toBe("Water");
    expect(displayName("بيبسي 330 مل", null)).toBe("بيبسي 330 مل");
  });

  it("rejects malformed money instead of rounding or guessing", () => {
    const bad = ["1.001", "$5.00", "\\$5.00", "5,00", "-1", "0", "0.00", "", "1e3", " 5", "٥", "NaN"];
    const { rows, rejected } = validateImport(csv(...bad.map((p, i) => `${i + 1},شيبس,,"${p}",USD,piece,0`)), "USD");
    expect(rows).toEqual([]);
    expect(rejected.map((r) => r.line)).toEqual(bad.map((_, i) => i + 2));
  });

  it("rejects every other invalid row with its line number and a reason", () => {
    const { rejected } = validateImport(
      csv(
        "1,مياه,,1.00,USD,piece,0",
        "1,شيبس,,1.00,USD,piece,0", // duplicate source_id
        "3,,,1.00,USD,piece,0", // empty name_ar
        "4,مياه,,1.00,LBP,piece,0", // wrong currency
        "5,مياه,,1.00,USD,litre,0", // unsupported unit (was "kg" until kg became sellable — see BASE_UNITS)
        "6,مياه,,1.00,USD,piece,yes", // bad flag
        "7,مياه,,1.00,USD,piece", // missing field
        "bad id,مياه,,1.00,USD,piece,0",
      ),
      "USD",
    );
    expect(rejected.map((r) => r.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(rejected[0]!.reason).toMatch(/already used on line 2/);
  });

  it("accepts every unit this terminal sells in, and still refuses one it does not", () => {
    // BASE_UNITS grew from ["piece","box"] to six units for the first offline release. An import
    // file written by the merchant may therefore use any of them; anything else is still refused.
    const { rows, rejected } = validateImport(
      csv(
        "1,حبة,,1.00,USD,piece,0",
        "2,علبة,,1.00,USD,box,0",
        "3,كيس,,1.00,USD,pack,0",
        "4,كيلو,,1.00,USD,kg,0",
        "5,متر,,1.00,USD,meter,0",
        "6,أخرى,,1.00,USD,other,0",
        "7,لتر,,1.00,USD,litre,0",
      ),
      "USD",
    );
    expect(rows.map((r) => r.baseUnit)).toEqual(["piece", "box", "pack", "kg", "meter", "other"]);
    expect(rejected.map((r) => r.line)).toEqual([8]);
    expect(rejected[0]!.reason).toMatch(/unit/i);
  });

  it("refuses a file with the wrong header or no products", () => {
    expect(code(() => validateImport("ID,Name,Price\n1,x,1\n", "USD"))).toBe("IMPORT_REJECTED");
    expect(code(() => validateImport(HEADER + "\n", "USD"))).toBe("IMPORT_REJECTED");
  });
});
