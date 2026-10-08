/**
 * The invoice's arithmetic and its unit labels.
 *
 * The regression anchor is the real document this feature replaces: fifteen lines summing to
 * 474.40 USD, no tax, PAID 0.00, BALANCE DUE 474.40. Only the AMOUNTS are taken from it — the
 * descriptions below are synthetic.
 */
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { formatDecimal, money } from "../../src/domain/money";
import { MAX_QUANTITY_MILLI, MAX_UNIT_PRICE_MINOR } from "../../src/domain/quantity";
import {
  TAX_DISABLED,
  computeInvoiceTotals,
  invoiceLineTotal,
  parseInvoiceQuantity,
} from "../../src/domain/invoice";
import { canonicalUnitFor, isCanonicalUnit, knownLabelsFor } from "../../src/domain/invoiceUnits";

const usd = (minor: bigint) => money(minor, "USD");
const total = (qtyMilli: number, priceMinor: bigint) => invoiceLineTotal(usd(priceMinor), qtyMilli);

describe("🔴 the real invoice, as a regression anchor", () => {
  // [quantity in milli, unit price in minor] — the amounts exactly as printed.
  const LINES: ReadonlyArray<readonly [number, bigint]> = [
    [1000, 4500n], [2000, 400n], [1000, 1200n], [2000, 5000n], [34000, 260n],
    [3000, 350n], [4000, 250n], [2000, 1200n], [1000, 650n], [2000, 150n],
    [1000, 900n], [12000, 800n], [2000, 1500n], [2000, 350n], [10000, 250n],
  ];

  it("every line total matches the printed figure", () => {
    const expected = [
      4500n, 800n, 1200n, 10000n, 8840n, 1050n, 1000n, 2400n,
      650n, 300n, 900n, 9600n, 3000n, 700n, 2500n,
    ];
    LINES.forEach(([q, p], i) => {
      expect(total(q, p).minor, `line ${i + 1}`).toBe(expected[i]!);
    });
  });

  it("the subtotal is exactly 474.40, with tax disabled and nothing paid", () => {
    const totals = computeInvoiceTotals(
      LINES.map(([q, p]) => total(q, p)),
      "USD",
      TAX_DISABLED,
      usd(0n),
    );
    expect(totals.subtotal.minor).toBe(47440n);
    expect(totals.tax.minor).toBe(0n);
    expect(totals.total.minor).toBe(47440n);
    expect(totals.paid.minor).toBe(0n);
    // 🔴 The credit sale: nothing paid, the whole amount outstanding.
    expect(totals.balanceDue.minor).toBe(47440n);
    expect(formatDecimal(totals.total)).toBe("474.40");
  });

  it("34 kilos at 2.60 is exactly 88.40 — the fractional-unit line", () => {
    expect(formatDecimal(total(34000, 260n))).toBe("88.40");
  });
});

describe("invoice line arithmetic", () => {
  it("is integer-only and rounds half up at the exact boundary", () => {
    // The rule is (q * p + 500) / 1000 with truncating integer division, so the half-up point is
    // exactly q * p === 500. Either side of it:
    expect(total(100, 5n).minor).toBe(1n); // 500 -> (500+500)/1000 = 1
    expect(total(99, 5n).minor).toBe(0n);  // 495 -> 995/1000 = 0
    expect(total(500, 1n).minor).toBe(1n); // 500 -> 1
    expect(total(499, 1n).minor).toBe(0n); // 499 -> 999/1000 = 0
    expect(total(1, 5n).minor).toBe(0n);   // 5   -> 505/1000 = 0
  });

  it("🔴 accepts a fraction of ANY unit — the invoice records what was written", () => {
    // 2.5 of something whose label this build has never seen.
    expect(total(2500, 400n).minor).toBe(1000n);
    expect(total(333, 300n).minor).toBe(100n);
  });

  it("a zero-priced line is allowed on an invoice, unlike on a sale", () => {
    expect(total(1000, 0n).minor).toBe(0n);
  });

  it("refuses a quantity outside the established safe bounds", () => {
    expect(() => total(0, 100n)).toThrow(DomainError);
    expect(() => total(-1, 100n)).toThrow(/between 0.001/);
    expect(() => total(MAX_QUANTITY_MILLI + 1, 100n)).toThrow(/between 0.001/);
    expect(() => total(1.5, 100n)).toThrow(/between 0.001/);
    expect(total(MAX_QUANTITY_MILLI, 1n).minor).toBe(9999n);
  });

  it("🔴 refuses a unit price past the overflow guard, reusing the ledger's own constant", () => {
    expect(() => total(1000, MAX_UNIT_PRICE_MINOR + 1n)).toThrow(/unit price must be between/);
    // at the bound itself the multiplication is still an exact integer
    expect(total(1000, MAX_UNIT_PRICE_MINOR).minor).toBe(MAX_UNIT_PRICE_MINOR);
    // A negative price cannot even be constructed: Money itself refuses it, so the guard's lower
    // half is unreachable through Money and is defence in depth rather than a live path.
    expect(() => money(-1n, "USD")).toThrow(/outside the accepted range/);
  });
});

describe("parseInvoiceQuantity", () => {
  it("accepts the shapes a till operator types", () => {
    expect(parseInvoiceQuantity("2")).toBe(2000);
    expect(parseInvoiceQuantity("2.5")).toBe(2500);
    expect(parseInvoiceQuantity("0.333")).toBe(333);
    expect(parseInvoiceQuantity(" 34 ")).toBe(34000);
  });

  it("refuses what is not a plain decimal", () => {
    for (const bad of ["", " ", "0", "-1", "2.", ".5", "1e3", "٢٫٥", "abc", "1,5"]) {
      expect(() => parseInvoiceQuantity(bad), JSON.stringify(bad)).toThrow(DomainError);
    }
    expect(() => parseInvoiceQuantity(2 as never)).toThrow(/required/);
  });

  it("refuses more than three decimals, and anything past the maximum", () => {
    expect(() => parseInvoiceQuantity("2.5555")).toThrow(/decimal places/);
    expect(() => parseInvoiceQuantity("10000")).toThrow(/may not exceed/);
    expect(parseInvoiceQuantity("9999")).toBe(MAX_QUANTITY_MILLI);
  });
});

describe("totals", () => {
  const lines = [usd(1000n), usd(2500n)];

  it("tax is disabled by default and contributes exactly zero", () => {
    const t = computeInvoiceTotals(lines, "USD", TAX_DISABLED, usd(0n));
    expect(t.tax.minor).toBe(0n);
    expect(t.total.minor).toBe(t.subtotal.minor);
  });

  it("an enabled tax is exact integer basis-point arithmetic, half up", () => {
    // 35.00 at 11% = 3.85 exactly
    const t = computeInvoiceTotals(lines, "USD", { enabled: true, rateBasisPoints: 1100, label: "VAT 11%" }, usd(0n));
    expect(t.subtotal.minor).toBe(3500n);
    expect(t.tax.minor).toBe(385n);
    expect(t.total.minor).toBe(3885n);
  });

  it("the half-up boundary of the tax itself", () => {
    // 0.05 at 50% = 0.025 -> rounds to 0.03
    expect(computeInvoiceTotals([usd(5n)], "USD", { enabled: true, rateBasisPoints: 5000, label: null }, usd(0n)).tax.minor).toBe(3n);
    // 0.04 at 50% = 0.02 exactly
    expect(computeInvoiceTotals([usd(4n)], "USD", { enabled: true, rateBasisPoints: 5000, label: null }, usd(0n)).tax.minor).toBe(2n);
  });

  it("no tax rate is hard-coded — a disabled config ignores its own rate entirely", () => {
    const t = computeInvoiceTotals(lines, "USD", { enabled: false, rateBasisPoints: 1100, label: "VAT" }, usd(0n));
    expect(t.tax.minor).toBe(0n);
  });

  it("paid and balance due", () => {
    const t = computeInvoiceTotals(lines, "USD", TAX_DISABLED, usd(1500n));
    expect(t.balanceDue.minor).toBe(2000n);
    const paidInFull = computeInvoiceTotals(lines, "USD", TAX_DISABLED, usd(3500n));
    expect(paidInFull.balanceDue.minor).toBe(0n);
  });

  it("refuses overpayment, a negative paid amount, an impossible rate and a mixed currency", () => {
    expect(() => computeInvoiceTotals(lines, "USD", TAX_DISABLED, usd(3501n))).toThrow(/greater than the invoice total/);
    // A negative paid amount cannot be constructed at all — Money rejects it first.
    expect(() => money(-1n, "USD")).toThrow(/outside the accepted range/);
    expect(() => computeInvoiceTotals(lines, "USD", { enabled: true, rateBasisPoints: 10001, label: null }, usd(0n))).toThrow(/between 0 and 100/);
    expect(() => computeInvoiceTotals([money(100n, "EUR")], "USD", TAX_DISABLED, usd(0n))).toThrow(/not in USD/);
    expect(() => computeInvoiceTotals(lines, "USD", TAX_DISABLED, money(0n, "EUR"))).toThrow(/not in USD/);
  });

  it("an empty invoice totals zero", () => {
    const t = computeInvoiceTotals([], "USD", TAX_DISABLED, usd(0n));
    expect(t.subtotal.minor).toBe(0n);
    expect(t.balanceDue.minor).toBe(0n);
  });
});

describe("unit labels", () => {
  it("maps the Arabic labels a Lebanese hardware invoice actually uses", () => {
    expect(canonicalUnitFor("حبة")).toBe("piece");
    expect(canonicalUnitFor("كيلو")).toBe("kg");
    expect(canonicalUnitFor("علبة")).toBe("box");
    expect(canonicalUnitFor("متر")).toBe("meter");
  });

  it("maps English labels too", () => {
    expect(canonicalUnitFor("kg")).toBe("kg");
    expect(canonicalUnitFor("PCS")).toBe("piece");
    expect(canonicalUnitFor("Box")).toBe("box");
  });

  it("normalisation means a hamza or a stray space cannot miss a mapping", () => {
    expect(canonicalUnitFor("  حبة  ")).toBe("piece");
    expect(canonicalUnitFor("حبه")).toBe("piece");
  });

  it("🔴 'كيس (50PCS)' is NOT guessed — it returns null and stays free text", () => {
    expect(canonicalUnitFor("كيس (50PCS)")).toBeNull();
    expect(canonicalUnitFor("كيس")).toBeNull();
    expect(canonicalUnitFor("طبة")).toBeNull();
    expect(canonicalUnitFor("")).toBeNull();
    expect(canonicalUnitFor(null as never)).toBeNull();
  });

  it("knows which strings are already catalog base units", () => {
    expect(isCanonicalUnit("piece")).toBe(true);
    expect(isCanonicalUnit("pack")).toBe(true);
    expect(isCanonicalUnit("كيلو")).toBe(false);
  });

  it("can show the operator what a base unit is already known by", () => {
    expect(knownLabelsFor("kg")).toContain("كيلو");
    expect(knownLabelsFor("piece")).toContain("حبة");
  });
});
