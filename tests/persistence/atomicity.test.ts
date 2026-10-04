/**
 * Transaction safety, proven by behaviour (not by reading the code):
 *   A  a successful commit writes the header and ALL lines;
 *   B  a fault injected mid-transaction leaves ZERO sales and ZERO orphan lines;
 *   B2 a sale whose lines do not add up is refused by the pre-COMMIT verification;
 *   NEGATIVE CONTROL: the same fault WITHOUT a transaction does leave a partial sale — proving
 *   these tests are able to detect the failure they claim is prevented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/persistence/db";
import { type NewSaleHeader, type NewSaleLine, SaleRepository } from "../../src/persistence/saleRepository";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

class FailOnLineRepository extends SaleRepository {
  constructor(
    db: Db,
    private readonly failAtLine: number,
  ) {
    super(db);
  }
  protected override insertSaleLine(saleId: string, line: NewSaleLine): void {
    super.insertSaleLine(saleId, line);
    if (line.lineNo === this.failAtLine) throw new Error(`injected fault after line ${line.lineNo}`);
  }
}

/** Silently drops the last line — the header claims more than was written. */
class DropLastLineRepository extends SaleRepository {
  override commitSale(header: NewSaleHeader, lines: ReadonlyArray<NewSaleLine>): number {
    const run = this.db.transaction(() => {
      const receipt = this.nextReceiptNumber();
      this.insertSaleHeader(header, receipt, lines.length);
      for (const line of lines.slice(0, -1)) this.insertSaleLine(header.id, line);
      this.verifySale(header.id);
      return receipt;
    });
    return run.immediate();
  }
}

/** NEGATIVE CONTROL: the same steps, but with no transaction around them. */
class NoTransactionRepository extends FailOnLineRepository {
  override commitSale(header: NewSaleHeader, lines: ReadonlyArray<NewSaleLine>): number {
    const receipt = this.nextReceiptNumber();
    this.insertSaleHeader(header, receipt, lines.length);
    for (const line of lines) this.insertSaleLine(header.id, line);
    this.verifySale(header.id);
    return receipt;
  }
}

const THREE_LINES = [
  { productId: "prod-0001", quantity: 2 },
  { productId: "prod-0005", quantity: 1 },
  { productId: "prod-0007", quantity: 3 },
];
const THREE_LINES_TOTAL = 500n + 225n + 1230n; // 19.55

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

describe("complete-sale atomicity", () => {
  it("A: a successful commit writes the sale and every line", () => {
    const { db, service } = makeHarness(t.dbPath);
    const { sale } = service.createSale({
      idempotencyKey: newKey(),
      lines: THREE_LINES,
      paymentMethod: "cash",
      expectedTotalMinor: THREE_LINES_TOTAL,
    });
    expect(countRows(db)).toEqual({ sales: 1, lines: 3, voids: 0 });
    expect(sale.lines.map((l) => l.lineTotal.minor)).toEqual([500n, 225n, 1230n]);
    expect(sale.total.minor).toBe(THREE_LINES_TOTAL);
    expect(sale.receiptNumber).toBe(1);
    db.close();
  });

  it("B: a fault after the header and two lines leaves zero sales and zero orphan lines", () => {
    const { db, service } = makeHarness(t.dbPath, { repository: (d) => new FailOnLineRepository(d, 2) });
    expect(() =>
      service.createSale({
        idempotencyKey: newKey(),
        lines: THREE_LINES,
        paymentMethod: "cash",
        expectedTotalMinor: THREE_LINES_TOTAL,
      }),
    ).toThrow(/injected fault after line 2/);
    expect(countRows(db)).toEqual({ sales: 0, lines: 0, voids: 0 });
    expect(service.getTodaySales().completedSalesCount).toBe(0);
    db.close();
  });

  it("B: after a rolled-back attempt the next sale commits normally with receipt #1", () => {
    const failing = makeHarness(t.dbPath, { repository: (d) => new FailOnLineRepository(d, 1) });
    expect(() =>
      failing.service.createSale({
        idempotencyKey: newKey(),
        lines: THREE_LINES,
        paymentMethod: "cash",
        expectedTotalMinor: THREE_LINES_TOTAL,
      }),
    ).toThrow();
    failing.db.close();

    const ok = makeHarness(t.dbPath);
    const { sale } = ok.service.createSale({
      idempotencyKey: newKey(),
      lines: THREE_LINES,
      paymentMethod: "card",
      expectedTotalMinor: THREE_LINES_TOTAL,
    });
    expect(sale.receiptNumber).toBe(1);
    expect(countRows(ok.db)).toEqual({ sales: 1, lines: 3, voids: 0 });
    ok.db.close();
  });

  it("B2: a sale whose written lines do not add up is refused before COMMIT", () => {
    const { db, service } = makeHarness(t.dbPath, { repository: (d) => new DropLastLineRepository(d) });
    expect(() =>
      service.createSale({
        idempotencyKey: newKey(),
        lines: THREE_LINES,
        paymentMethod: "cash",
        expectedTotalMinor: THREE_LINES_TOTAL,
      }),
    ).toThrow(/does not add up/);
    expect(countRows(db)).toEqual({ sales: 0, lines: 0, voids: 0 });
    db.close();
  });

  it("NEGATIVE CONTROL: without a transaction the same fault leaves a half-written sale", () => {
    const { db, service } = makeHarness(t.dbPath, { repository: (d) => new NoTransactionRepository(d, 2) });
    expect(() =>
      service.createSale({
        idempotencyKey: newKey(),
        lines: THREE_LINES,
        paymentMethod: "cash",
        expectedTotalMinor: THREE_LINES_TOTAL,
      }),
    ).toThrow(/injected fault/);
    // The detector sees the corruption the real code prevents.
    expect(countRows(db)).toEqual({ sales: 1, lines: 2, voids: 0 });
    db.close();
  });
});
