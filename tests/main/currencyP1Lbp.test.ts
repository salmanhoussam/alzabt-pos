/**
 * CURRENCY-P1 — Workstream B: one stored amount has ONE meaning on every covered path.
 *
 * The contract preserved (owner, 2026-11-21): LBP keeps exponent 2 in `money.ts` — 100 stored minor units per pound.
 * No stored integer is changed, rescaled or relabelled. What changed is how three paths READ those integers:
 *   · the invoice document printed LBP with exponent 0 (100× too large) and every other currency with a fixed 2;
 *   · the sale receipt's unit price used a fixed 2;
 *   · photo reading built minor units for LBP with exponent 0 (100× too small).
 * Each now takes the exponent from the currency. Every expectation below is derived from `formatDecimal` /
 * `parseDecimal` (the domain), so the paths are compared with the domain rather than with a restated number.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { MAX_MINOR, formatDecimal, money, parseDecimal } from "../../src/domain/money";
import { amountInWordsAr } from "../../src/domain/amountInWords";
import { emptyCatalog } from "../../src/domain/catalog";
import { printDecimalOf, printMoney, renderInvoiceDocument } from "../../src/main/invoiceDocument";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import { toInvoiceViewDto } from "../../src/shared/dto";
import type { IpcResult, ReadInvoicePhotoResponse } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

const MINORS = [0n, 1n, 99n, 100n, 150000n, 123456789n, MAX_MINOR];

describe("printing agrees with the domain for every currency in the table", () => {
  for (const currency of ["USD", "LBP", "JOD", "KWD"]) {
    it(`${currency}: printDecimalOf === formatDecimal, printMoney wraps it, and it parses back to the same minor`, () => {
      for (const minor of MINORS) {
        const domain = formatDecimal(money(minor, currency));
        expect(printDecimalOf({ minor: minor.toString(), currency })).toBe(domain);
        expect(printMoney({ minor: minor.toString(), currency })).toBe(`<bdi dir="ltr">${domain}&nbsp;${currency}</bdi>`);
        expect(parseDecimal(domain, currency).minor).toBe(minor);
      }
    });
  }

  it("LBP named values: 0, 1 minor, 100 minor (1 pound), 1,500 pounds, a large amount", () => {
    expect(printDecimalOf({ minor: "0", currency: "LBP" })).toBe("0.00");
    expect(printDecimalOf({ minor: "1", currency: "LBP" })).toBe("0.01");
    expect(printDecimalOf({ minor: "100", currency: "LBP" })).toBe("1.00");
    expect(printDecimalOf({ minor: "150000", currency: "LBP" })).toBe("1500.00");
    expect(printDecimalOf({ minor: "8950000000", currency: "LBP" })).toBe("89500000.00");
    // a negative receipt line keeps its sign
    expect(printDecimalOf({ minor: "-150000", currency: "LBP" })).toBe("-1500.00");
  });

  it("a legacy 3-decimal amount prints its own three decimals — not converted, not rounded", () => {
    expect(printMoney({ minor: "100", currency: "JOD" })).toBe('<bdi dir="ltr">0.100&nbsp;JOD</bdi>');
    expect(printDecimalOf({ minor: "1", currency: "KWD" })).toBe("0.001");
  });

  it("an unknown currency is refused explicitly (UNKNOWN_CURRENCY), never printed as a guessed amount", () => {
    let code = "NO-THROW";
    try {
      printMoney({ minor: "100", currency: "XYZ" });
    } catch (e) {
      code = e instanceof DomainError ? e.code : String(e);
    }
    expect(code).toBe("UNKNOWN_CURRENCY");
  });

  it("amount in words spells the SAME value the document prints (LBP)", () => {
    for (const minor of [100n, 150000n, 300000n]) {
      const printed = printDecimalOf({ minor: minor.toString(), currency: "LBP" });
      expect(amountInWordsAr(parseDecimal(printed, "LBP"))).toBe(amountInWordsAr(money(minor, "LBP")));
    }
    expect(amountInWordsAr(money(150000n, "LBP"))).toContain("ليرة");
  });
});

describe("an LBP invoice end to end (synthetic LBP terminal + catalog)", () => {
  let t: TempDir;
  let h: Harness;
  beforeEach(() => {
    t = tempDir();
    h = makeHarness(t.dbPath, { catalog: emptyCatalog("LBP"), terminal: { currency: "LBP", timeZone: "Asia/Beirut" } });
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
  });
  afterEach(() => {
    h.db.close();
    t.cleanup();
  });

  it("stored 150000 minor is 1,500 LBP in the service, the printed document and the words — never 150000", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", productId: null, quantity: "2", unitPrice: "1500" });
    const final = h.invoices.finalizeInvoice(invoice.id);
    expect(final.lines[0]!.unit_price_minor).toBe(150000n);
    expect(final.invoice.total_minor).toBe(300000n);
    const html = renderInvoiceDocument(toInvoiceViewDto(final));
    expect(html).toContain("1500.00&nbsp;LBP");
    expect(html).toContain("3000.00&nbsp;LBP");
    expect(html).not.toContain("150000&nbsp;LBP");
    expect(html).not.toContain("300000&nbsp;LBP");
    expect(final.invoice.amount_in_words).toBe(amountInWordsAr(money(300000n, "LBP")));
  });

  // The line is in decimal form («1500.00») on purpose. SIDE FINDING, pre-existing and exponent-independent (measured at
  // exponent 0 and 2 alike): a whole-number line («2 1500 3000») or one with thousands separators («1,500») yields NO
  // row and NO unexplained line from `rowsFromLines`/`rowsFromPositioned`. Not changed here — reported in the hand-off.
  // Negative control (baseline `LBP ? 0 : 2`): this same line produced supplierPriceMinor "1500" — 15.00 LBP.
  it("photo reading builds LBP minor units with the domain exponent: a read 1,500 is 150000 minor, not 1500", async () => {
    const handlers = createIpcHandlers(h.service, {
      readInvoicePhoto: async () => ({
        lines: [{ text: "1 مسامير تجريبية PCS 2 1500.00 3000.00", y: 100, h: 30, x0: 0, x1: 1000, source: "original" as const, kind: "engine" as const }],
        ms: 5,
        preview: null,
        crop: () => null,
      }),
    });
    const r = (await handlers.readInvoicePhoto(undefined)) as IpcResult<ReadInvoicePhotoResponse>;
    if (!r.ok) throw new Error(r.error.code);
    if (r.data.status !== "read") throw new Error(r.data.status);
    expect(r.data.currency).toBe("LBP");
    expect(r.data.rows).toHaveLength(1);
    expect(r.data.rows[0]).toMatchObject({ quantityMilli: 2000, supplierPriceMinor: "150000", lineTotalMinor: "300000" });
    // and the review screen's own formatter shows exactly what was read
    expect(formatDecimal(money(BigInt(r.data.rows[0]!.supplierPriceMinor!), "LBP"))).toBe("1500.00");
  });
});
