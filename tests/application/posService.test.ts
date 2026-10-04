import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogSource } from "../../src/domain/catalog";
import { DomainError } from "../../src/domain/errors";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { type TempDir, TestClock, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const espressoX2 = { lines: [{ productId: "prod-0001", quantity: 2 }], expectedTotalMinor: 500n };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  throw new Error("expected a DomainError");
}

describe("cashier session", () => {
  it("a sale and a void both require a logged-in cashier", () => {
    const { db, service } = makeHarness(t.dbPath, { login: false });
    expect(codeOf(() => service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espressoX2 }))).toBe(
      "NOT_LOGGED_IN",
    );
    expect(codeOf(() => service.voidSale("whatever", "reason here"))).toBe("NOT_LOGGED_IN");
    db.close();
  });

  it("a wrong PIN or unknown cashier is refused with the same error", () => {
    const { db, service } = makeHarness(t.dbPath, { login: false });
    expect(codeOf(() => service.login("cashier-01", "9999"))).toBe("INVALID_CREDENTIALS");
    expect(codeOf(() => service.login("cashier-99", "1111"))).toBe("INVALID_CREDENTIALS");
    expect(codeOf(() => service.login("cashier-01", "11'; DROP TABLE sales; --"))).toBe("INVALID_CREDENTIALS");
    expect(service.login("cashier-02", "2222")).toEqual({ id: "cashier-02", name: "Cashier Two" });
    db.close();
  });
});

describe("completing a sale", () => {
  it("records cashier, payment method, currency, snapshots and exact totals", () => {
    const { db, service } = makeHarness(t.dbPath);
    const { sale, duplicate } = service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "external",
      lines: [
        { productId: "prod-0002", quantity: 2 },
        { productId: "prod-0008", quantity: 1 },
      ],
      expectedTotalMinor: 1083n, // 2 x 3.75 + 3.33
    });
    expect(duplicate).toBe(false);
    expect(sale).toMatchObject({
      receiptNumber: 1,
      cashierId: "cashier-01",
      cashierName: "Cashier One",
      currency: "USD",
      paymentMethod: "external",
      businessDate: "2026-10-04",
    });
    expect(sale.total.minor).toBe(1083n);
    expect(sale.subtotal.minor).toBe(1083n);
    expect(sale.lines.map((l) => [l.sku, l.productName, l.quantity, l.unitPrice.minor, l.lineTotal.minor])).toEqual([
      ["COF-LAT", "Caffè Latte", 2, 375n, 750n],
      ["CKE-CHO", "Chocolate Cake Slice", 1, 333n, 333n],
    ]);
    db.close();
  });

  it("assigns consecutive receipt numbers", () => {
    const { db, service } = makeHarness(t.dbPath);
    const a = service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espressoX2 });
    const b = service.createSale({ idempotencyKey: newKey(), paymentMethod: "card", ...espressoX2 });
    expect([a.sale.receiptNumber, b.sale.receiptNumber]).toEqual([1, 2]);
    db.close();
  });

  it("rejects an unsupported payment method and a stale displayed total", () => {
    const { db, service } = makeHarness(t.dbPath);
    expect(
      codeOf(() =>
        service.createSale({ idempotencyKey: newKey(), paymentMethod: "bitcoin" as never, ...espressoX2 }),
      ),
    ).toBe("INVALID_PAYMENT_METHOD");
    expect(
      codeOf(() =>
        service.createSale({
          idempotencyKey: newKey(),
          paymentMethod: "cash",
          lines: espressoX2.lines,
          expectedTotalMinor: 499n,
        }),
      ),
    ).toBe("TOTAL_MISMATCH");
    expect(countRows(db).sales).toBe(0);
    db.close();
  });

  it("refuses a catalog whose currency differs from the terminal's", () => {
    expect(() =>
      makeHarness(t.dbPath, { catalogSource: { ...FIXTURE_CATALOG, currency: "EUR" } }),
    ).toThrow(/differs from terminal currency/);
  });
});

describe("C: duplicate completion", () => {
  it("the same idempotency key returns the original sale and writes nothing new", () => {
    const { db, service } = makeHarness(t.dbPath);
    const key = newKey();
    const first = service.createSale({ idempotencyKey: key, paymentMethod: "cash", ...espressoX2 });
    const second = service.createSale({ idempotencyKey: key, paymentMethod: "cash", ...espressoX2 });
    expect(second.duplicate).toBe(true);
    expect(second.sale.id).toBe(first.sale.id);
    expect(countRows(db)).toEqual({ sales: 1, lines: 1, voids: 0 });
    expect(service.getTodaySales().grossSales.minor).toBe(500n);
    db.close();
  });

  it("the same key with a different cart is a conflict, not a second sale", () => {
    const { db, service } = makeHarness(t.dbPath);
    const key = newKey();
    service.createSale({ idempotencyKey: key, paymentMethod: "cash", ...espressoX2 });
    expect(
      codeOf(() =>
        service.createSale({
          idempotencyKey: key,
          paymentMethod: "cash",
          lines: [{ productId: "prod-0001", quantity: 3 }],
          expectedTotalMinor: 750n,
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(countRows(db).sales).toBe(1);
    db.close();
  });

  it("the UNIQUE constraint is a second, independent guard", () => {
    const { db, service } = makeHarness(t.dbPath);
    const key = newKey();
    service.createSale({ idempotencyKey: key, paymentMethod: "cash", ...espressoX2 });
    expect(() => db.prepare("INSERT INTO sales (idempotency_key) VALUES (?)").run(key)).toThrow(/constraint/i);
    db.close();
  });
});

describe("D: catalog changes never alter a recorded sale", () => {
  it("a later price and name change leaves the old sale and today's totals untouched", () => {
    const clock = new TestClock();
    const before = makeHarness(t.dbPath, { clock });
    const { sale } = before.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espressoX2 });
    before.db.close();

    const changed: CatalogSource = {
      ...FIXTURE_CATALOG,
      products: FIXTURE_CATALOG.products.map((p) =>
        p.id === "prod-0001" ? { ...p, name: "Double Espresso", price: "9.99", sku: "COF-ESP-2" } : p,
      ),
    };
    const after = makeHarness(t.dbPath, { clock, catalogSource: changed });
    const stored = after.service.getSale(sale.id).sale;
    expect(stored).toEqual(sale);
    expect(stored.lines[0]).toMatchObject({ productName: "Espresso", sku: "COF-ESP", quantity: 2 });
    expect(stored.lines[0]!.unitPrice.minor).toBe(250n);
    expect(after.service.getTodaySales().grossSales.minor).toBe(500n);

    // A new sale uses the new price — the two coexist correctly.
    after.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [{ productId: "prod-0001", quantity: 1 }],
      expectedTotalMinor: 999n,
    });
    expect(after.service.getTodaySales().grossSales.minor).toBe(1499n);
    after.db.close();
  });
});

describe("E: voids", () => {
  it("a void is a new record; the original sale row is byte-for-byte unchanged; totals move", () => {
    const { db, service } = makeHarness(t.dbPath);
    const keep = service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [{ productId: "prod-0007", quantity: 2 }],
      expectedTotalMinor: 820n,
    });
    const cancel = service.createSale({ idempotencyKey: newKey(), paymentMethod: "card", ...espressoX2 });
    const rawBefore = db.prepare("SELECT * FROM sales WHERE id = ?").get(cancel.sale.id);
    const linesBefore = db.prepare("SELECT * FROM sale_lines WHERE sale_id = ?").all(cancel.sale.id);

    const reportBefore = service.getTodaySales();
    expect(reportBefore.grossSales.minor).toBe(1320n);
    expect(reportBefore.netSales.minor).toBe(1320n);

    const v = service.voidSale(cancel.sale.id, "  wrong item rung up  ");
    expect(v).toMatchObject({ saleId: cancel.sale.id, cashierId: "cashier-01", reason: "wrong item rung up" });

    expect(db.prepare("SELECT * FROM sales WHERE id = ?").get(cancel.sale.id)).toEqual(rawBefore);
    expect(db.prepare("SELECT * FROM sale_lines WHERE sale_id = ?").all(cancel.sale.id)).toEqual(linesBefore);
    expect(countRows(db)).toEqual({ sales: 2, lines: 2, voids: 1 });

    const report = service.getTodaySales();
    expect(report).toMatchObject({ completedSalesCount: 2, voidedSalesCount: 1, currency: "USD" });
    expect(report.grossSales.minor).toBe(1320n);
    expect(report.voidTotal.minor).toBe(500n);
    expect(report.netSales.minor).toBe(820n);
    expect(service.getSale(keep.sale.id).void).toBeNull();
    expect(service.getSale(cancel.sale.id).void?.id).toBe(v.id);
    db.close();
  });

  it("a sale cannot be voided twice, nor without a reason, nor if it does not exist", () => {
    const { db, service } = makeHarness(t.dbPath);
    const { sale } = service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espressoX2 });
    expect(codeOf(() => service.voidSale(sale.id, "  "))).toBe("INVALID_REASON");
    expect(codeOf(() => service.voidSale("missing", "a reason"))).toBe("SALE_NOT_FOUND");
    service.voidSale(sale.id, "first void");
    expect(codeOf(() => service.voidSale(sale.id, "second void"))).toBe("ALREADY_VOIDED");
    expect(countRows(db).voids).toBe(1);
    expect(service.getTodaySales().netSales.minor).toBe(0n);
    db.close();
  });

  it("a sale from a previous business day cannot be voided (refunds are out of scope)", () => {
    const clock = new TestClock(new Date("2026-10-03T20:30:00.000Z")); // 23:30 Beirut, Oct 3
    const { db, service } = makeHarness(t.dbPath, { clock });
    const { sale } = service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espressoX2 });
    expect(sale.businessDate).toBe("2026-10-03");
    clock.set("2026-10-03T21:00:00.000Z"); // 00:00 Beirut, Oct 4
    expect(codeOf(() => service.voidSale(sale.id, "too late"))).toBe("VOID_NOT_ALLOWED");
    // And the new day starts empty.
    expect(service.getTodaySales()).toMatchObject({ date: "2026-10-04", completedSalesCount: 0 });
    db.close();
  });
});

describe("persistence across restart", () => {
  it("completed sales and voids are still there after closing and reopening the database", () => {
    const first = makeHarness(t.dbPath);
    const a = first.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espressoX2 });
    const b = first.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "other",
      lines: [{ productId: "prod-0006", quantity: 4 }],
      expectedTotalMinor: 600n,
    });
    first.service.voidSale(a.sale.id, "test void");
    const reportBefore = first.service.getTodaySales();
    first.db.close();

    const second = makeHarness(t.dbPath);
    expect(second.service.getTodaySales()).toEqual(reportBefore);
    const history = second.service.getSaleHistory();
    expect(history.map((h) => [h.sale.receiptNumber, h.void !== null])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(second.service.getSale(b.sale.id).sale).toEqual(b.sale);
    second.db.close();
  });
});
