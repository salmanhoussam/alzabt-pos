/**
 * PHOTO-INVOICE-TO-ITEMS — review rules. The release blocker's safety, proven:
 *   no automatic catalog write · supplier price is never the sale price · nothing "fixed" silently ·
 *   the plan is impossible while any row blocks. Synthetic rows only.
 */
import { describe, expect, it } from "vitest";
import {
  type ExtractedRow,
  type ReviewRow,
  canFinish,
  decideNew,
  lineTotalOf,
  planOf,
  reviewIssues,
  rowIssues,
  startReview,
} from "../../src/domain/photoInvoiceReview";

const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  id: "r1",
  rawText: "1 سكر أبيض 1 كغ 10 1.25 12.50",
  name: "سكر أبيض 1 كغ",
  quantityMilli: 10000,
  supplierPriceMinor: 125n,
  lineTotalMinor: 1250n,
  arithmeticOk: true,
  ...over,
});
const codes = (r: ReviewRow) => rowIssues(r).map((i) => `${i.code}${i.blocking ? "!" : ""}`);

describe("photo invoice review", () => {
  it("🔴 every row starts PENDING and the review cannot finish — nothing reaches the catalog by itself", () => {
    const rows = startReview([row(), row({ id: "r2" })]);
    expect(rows.every((r) => r.decision.kind === "pending")).toBe(true);
    expect(canFinish(rows)).toBe(false);
    expect(() => planOf(rows)).toThrow(/not finished/);
    expect(canFinish([])).toBe(false);
  });

  it("🔴 a NEW product starts with NO sale price; the supplier price is never copied into it", () => {
    const [r] = startReview([row()]);
    const n = decideNew(r!);
    expect(n.decision).toEqual({ kind: "new", salePriceMinor: null });
    expect(codes(n)).toContain("SALE_PRICE_REQUIRED!");
    expect(canFinish([n])).toBe(false);
  });

  it("a sale price equal to the cost is allowed but flagged; below the cost is flagged too; above is clean", () => {
    const [r] = startReview([row()]);
    const at = (p: bigint) => ({ ...r!, decision: { kind: "new" as const, salePriceMinor: p } });
    expect(codes(at(125n))).toEqual(["SALE_PRICE_EQUALS_COST"]);
    expect(codes(at(100n))).toEqual(["SALE_PRICE_BELOW_COST"]);
    expect(codes(at(175n))).toEqual([]);
    expect(canFinish([at(125n)])).toBe(true);
  });

  it("🔴 a row whose arithmetic does not hold is SHOWN as a mismatch — never silently corrected", () => {
    const [r] = startReview([row({ lineTotalMinor: 1300n, arithmeticOk: false })]);
    const kept = { ...r!, decision: { kind: "link" as const, productId: "prod-0001" } };
    expect(codes(kept)).toEqual(["TOTAL_MISMATCH"]);
    expect(kept.lineTotalMinor).toBe(1300n); // the value read, untouched
    expect(r!.extracted.rawText).toContain("12.50"); // the original text stays for the operator
  });

  it("an unreadable quantity or price blocks a kept row, but not a skipped one", () => {
    const [r] = startReview([row({ quantityMilli: null, supplierPriceMinor: null })]);
    expect(codes({ ...r!, decision: { kind: "link", productId: "p" } })).toEqual(["QUANTITY_INVALID!", "SUPPLIER_PRICE_INVALID!"]);
    expect(codes({ ...r!, decision: { kind: "skip" } })).toEqual([]);
  });

  it("the plan names exactly what would be created or linked, with cost and sale price SEPARATE", () => {
    const rows = startReview([row(), row({ id: "r2", name: "Tomato Paste 400g", quantityMilli: 24000, supplierPriceMinor: 60n, lineTotalMinor: 1440n }), row({ id: "r3" })]);
    const decided: ReviewRow[] = [
      { ...rows[0]!, decision: { kind: "new", salePriceMinor: 175n } },
      { ...rows[1]!, decision: { kind: "link", productId: "prod-0042" } },
      { ...rows[2]!, decision: { kind: "skip" } },
    ];
    expect(canFinish(decided)).toBe(true);
    expect(planOf(decided)).toEqual({
      create: [{ rowId: "r1", name: "سكر أبيض 1 كغ", salePriceMinor: 175n, supplierPriceMinor: 125n }],
      link: [{ rowId: "r2", productId: "prod-0042", supplierPriceMinor: 60n }],
      skipped: ["r3"],
      keptTotalMinor: 2690n,
    });
  });

  it("🔴 re-processing the same invoice cannot create a duplicate: an existing name must be LINKED", () => {
    const [r] = startReview([row()]);
    const asNew = { ...r!, decision: { kind: "new" as const, salePriceMinor: 175n } };
    // the catalog already holds this product (written with a different alef/hamza and spacing)
    expect(canFinish([asNew], ["سكر  ابيض 1 كغ"])).toBe(false);
    expect(reviewIssues([asNew], ["سكر  ابيض 1 كغ"]).get("r1")!.map((i) => i.code)).toContain("DUPLICATE_PRODUCT_NAME");
    expect(() => planOf([asNew], ["سكر ابيض 1 كغ"])).toThrow();
    expect(canFinish([{ ...r!, decision: { kind: "link", productId: "prod-sugar" } }], ["سكر ابيض 1 كغ"])).toBe(true);
    // two NEW rows of one review with the same name block each other
    const [a, b] = startReview([row(), row({ id: "r2" })]);
    const twins = [a!, b!].map((x) => ({ ...x, decision: { kind: "new" as const, salePriceMinor: 175n } }));
    expect(reviewIssues(twins, []).get("r2")!.map((i) => i.code)).toContain("DUPLICATE_IN_REVIEW");
  });

  it("line totals are exact in minor units (milli quantities)", () => {
    expect(lineTotalOf(10000, 125n)).toBe(1250n);
    expect(lineTotalOf(1500, 199n)).toBe(299n); // 1.5 × 1.99 = 2.985 → 2.99 (half-up)
  });
});
