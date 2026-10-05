/**
 * Catalog export → edit → re-import round trip. Synthetic Arabic data and fake prices only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPORT_HEADER, parseCsv, toImportCsv } from "../../src/domain/catalogImport";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const enc = (s: string) => new TextEncoder().encode(s);
const SOURCE =
  [
    IMPORT_HEADER.join(","),
    "1,بيبسي 330 مل,,1.00,USD,piece,0",
    "2,مياه,Water,0.5,USD,piece,0",
    '3,"علبة بسكويت 2"", كبيرة",,12,USD,box,0',
    "10,شيبس,,0.01,USD,piece,1",
  ].join("\r\n") + "\r\n";

function imported(h: ReturnType<typeof makeHarness>, csv: string) {
  const r = h.service.importCatalogCsv("c.csv", enc(csv));
  if (r.status !== "imported") throw new Error(JSON.stringify(r));
  return r;
}

describe("catalog export", () => {
  it("writes the import format with a UTF-8 BOM, CRLF, exact prices and Arabic preserved", () => {
    const h = makeHarness(t.dbPath);
    imported(h, SOURCE);
    const { csv, productCount } = h.service.exportCatalogCsv();
    expect(productCount).toBe(4);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\r\n")[0]).toBe("﻿" + IMPORT_HEADER.join(","));
    const rows = parseCsv(csv).slice(1);
    expect(rows).toEqual([
      ["1", "بيبسي 330 مل", "", "1.00", "USD", "piece", "0"],
      ["2", "مياه", "Water", "0.50", "USD", "piece", "0"],
      ["3", 'علبة بسكويت 2", كبيرة', "", "12.00", "USD", "box", "0"],
      ["10", "شيبس", "", "0.01", "USD", "piece", "1"],
    ]);
    h.db.close();
  });

  it("re-importing the exported file changes nothing (stable identity = source_id)", () => {
    const h = makeHarness(t.dbPath);
    imported(h, SOURCE);
    const before = h.service.getCatalog().products.map((p) => [p.id, p.name, p.price.minor, p.priceNeedsReview]);
    const again = imported(h, h.service.exportCatalogCsv().csv);
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 4, deactivated: 0 });
    expect(h.service.getCatalog().products.map((p) => [p.id, p.name, p.price.minor, p.priceNeedsReview])).toEqual(before);
    h.db.close();
  });

  it("an edited price (as Excel would save it: '2.5', BOM kept) updates exactly that product", () => {
    const h = makeHarness(t.dbPath);
    imported(h, SOURCE);
    const edited = h.service
      .exportCatalogCsv()
      .csv.replace("10,شيبس,,0.01,USD,piece,1", "10,شيبس,,2.5,USD,piece,0");
    expect(imported(h, edited)).toMatchObject({ inserted: 0, updated: 1, unchanged: 3, placeholderPrices: 0 });
    const chips = h.service.getCatalog().byId.get("merchant-csv:10")!;
    expect(chips.price.minor).toBe(250n);
    expect(chips.priceNeedsReview).toBe(false);
    h.db.close();
  });

  it("refuses to export when there is no imported catalog (never exports the demo fixture)", () => {
    const h = makeHarness(t.dbPath);
    expect(() => h.service.exportCatalogCsv()).toThrow(/no imported catalog/);
    h.db.close();
  });

  it("toImportCsv quotes only when needed and never rounds", () => {
    expect(
      toImportCsv([
        { sourceId: "a", nameAr: "x,y", nameEn: null, price: "0.01", currency: "USD", baseUnit: "piece", priceNeedsReview: true },
      ]),
    ).toBe("﻿" + IMPORT_HEADER.join(",") + '\r\na,"x,y",,0.01,USD,piece,1\r\n');
  });
});
