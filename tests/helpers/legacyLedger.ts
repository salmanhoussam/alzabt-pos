/**
 * Writes rows in the shape an OLDER BUILD wrote them — raw SQL against the pre-migration-4
 * `sale_lines` (`quantity`, whole units, and no `sale_unit`).
 *
 * 🔴 Why this exists rather than calling PosService: a test that wants "a ledger an old build left
 * behind" cannot write it through today's repository, because today's repository inserts
 * `quantity_milli` and `sale_unit` — columns that do not exist before migration 4. Before migration
 * 4 the two column sets happened to coincide, so the old tests got away with it; from here on that
 * is impossible, and the coincidence was hiding the fact that they were never really testing an old
 * ledger at all.
 *
 * Synthetic data only.
 */
import type { Db } from "../../src/persistence/db";

export interface LegacyLine {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  /** WHOLE sale units, as the old schema stored them. */
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export interface LegacySale {
  readonly id: string;
  readonly receiptNumber: number;
  readonly paymentMethod?: "cash" | "card" | "external" | "other";
  readonly businessDate?: string;
  readonly lines: ReadonlyArray<LegacyLine>;
}

/** One sale, header and lines, exactly as a pre-migration-4 build would have committed it. */
export function insertLegacySale(db: Db, sale: LegacySale): void {
  const lines = sale.lines.map((l) => ({ ...l, lineTotalMinor: l.quantity * l.unitPriceMinor }));
  const total = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  const at = `${sale.businessDate ?? "2026-09-01"}T10:00:00.000Z`;
  db.prepare(
    `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, cashier_id,
                        cashier_name, currency, subtotal_minor, total_minor, payment_method,
                        line_count, business_date, completed_at, created_at)
     VALUES (@id, @receiptNumber, @key, 'legacy-fingerprint', 'cashier-01', 'Cashier One', 'USD',
             @total, @total, @method, @lineCount, @businessDate, @at, @at)`,
  ).run({
    id: sale.id,
    receiptNumber: sale.receiptNumber,
    key: `legacy-${sale.id}-00000001`.slice(0, 100),
    total,
    method: sale.paymentMethod ?? "cash",
    lineCount: lines.length,
    businessDate: sale.businessDate ?? "2026-09-01",
    at,
  });
  const insertLine = db.prepare(
    `INSERT INTO sale_lines (id, sale_id, line_no, product_id, sku, product_name, quantity,
                             unit_price_minor, line_total_minor)
     VALUES (@id, @saleId, @lineNo, @productId, @sku, @productName, @quantity,
             @unitPriceMinor, @lineTotalMinor)`,
  );
  lines.forEach((l, i) => {
    insertLine.run({
      id: `${sale.id}-l${i + 1}`,
      saleId: sale.id,
      lineNo: i + 1,
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
    });
  });
}

/** A void event against an existing legacy sale. */
export function insertLegacyVoid(db: Db, saleId: string, reason = "wrong item rung up"): void {
  db.prepare(
    `INSERT INTO voids (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at)
     VALUES (@id, @saleId, 'cashier-01', 'Cashier One', @reason, '2026-09-01', '2026-09-01T11:00:00.000Z')`,
  ).run({ id: `void-${saleId}`, saleId, reason });
}

/** Two sales and one void — a small but realistic pre-migration-4 ledger. */
export function seedLegacyLedger(db: Db): void {
  insertLegacySale(db, {
    id: "legacy-sale-1",
    receiptNumber: 1,
    lines: [
      { productId: "p-widget", sku: "SYN-1", productName: "Widget", quantity: 3, unitPriceMinor: 400 },
      { productId: "p-gadget", sku: "SYN-2", productName: "Gadget", quantity: 1, unitPriceMinor: 500 },
    ],
  });
  insertLegacySale(db, {
    id: "legacy-sale-2",
    receiptNumber: 2,
    paymentMethod: "card",
    lines: [{ productId: "p-widget", sku: "SYN-1", productName: "Widget", quantity: 7, unitPriceMinor: 400 }],
  });
  insertLegacyVoid(db, "legacy-sale-2");
}
