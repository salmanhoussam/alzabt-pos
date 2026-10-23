/**
 * Migration 14 — preserve the v13 financial ledger while adding a fully unpaid POS sale shape.
 *
 * Every fixture below is synthetic. This exercises the real migration runner on populated v13
 * databases; it does not create customer obligations through POS checkout.
 */
import { copyFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { snapshotDatabase } from "../../src/persistence/backup";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";

const V13 = 13;
const V14 = 14;
const MIGRATIONS_V13 = MIGRATIONS.slice(0, V13);
const NEW_TRIGGERS = [
  "sales_pos_unpaid_requires_no_tender",
  "sales_credit_requires_active_customer",
  "obligations_sale_customer_match",
].sort();
const PRESERVED_TABLES = [
  "sales",
  "sale_lines",
  "voids",
  "invoices",
  "invoice_lines",
  "parties",
  "obligations",
  "settlements",
] as const;
const FINANCIAL_TABLES = ["sales", "sale_lines", "voids", "obligations", "settlements", "parties"];

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type Row = Record<string, unknown>;

const rowsByTable = (db: Db): Record<(typeof PRESERVED_TABLES)[number], Row[]> =>
  Object.fromEntries(
    PRESERVED_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[],
    ]),
  ) as Record<(typeof PRESERVED_TABLES)[number], Row[]>;

const namedObjects = (db: Db) =>
  db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE type IN ('index', 'trigger') AND sql IS NOT NULL
         AND tbl_name IN (${FINANCIAL_TABLES.map(() => "?").join(", ")})
       ORDER BY type, name`,
    )
    .all(...FINANCIAL_TABLES) as Row[];

const tableDefinitions = (db: Db) =>
  db.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE type = 'table' AND name IN (${PRESERVED_TABLES.map(() => "?").join(", ")})
     ORDER BY name`,
  ).all(...PRESERVED_TABLES) as Row[];

const indexStates = (db: Db) =>
  Object.fromEntries(FINANCIAL_TABLES.map((table) => [table, indexDefinitions(db, table)]));

const foreignKeyStates = (db: Db) =>
  Object.fromEntries(FINANCIAL_TABLES.map((table) => [table, foreignKeys(db, table)]));

function expectHistoricalRowsPreserved(db: Db, before: Record<string, Row[]>): void {
  const after = rowsByTable(db);
  for (const table of PRESERVED_TABLES) {
    const historicalRows = before[table] ?? [];
    const oldColumns = Object.keys(historicalRows[0] ?? {});
    const projected = after[table].map((row) =>
      Object.fromEntries(oldColumns.map((column) => [column, row[column]])),
    );
    expect(projected, `historical ${table} rows`).toEqual(historicalRows);
  }
}

const foreignKeys = (db: Db, table: string) =>
  (db.pragma(`foreign_key_list('${table}')`) as Array<Record<string, unknown>>)
    .map(({ id, seq, table: parent, from, to, on_update, on_delete, match }) =>
      ({ id, seq, parent, from, to, on_update, on_delete, match }))
    .sort((a, b) => Number(a.id) - Number(b.id) || Number(a.seq) - Number(b.seq));

const indexDefinitions = (db: Db, table: string) =>
  (db.pragma(`index_list('${table}')`) as Array<Record<string, unknown>>)
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      columns: db.pragma(`index_info('${String(index.name)}')`) as Array<Record<string, unknown>>,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

function insertInvoice(db: Db, input: { id: string; lineId: string; total: number }): void {
  const operatorId = (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
  const invoiceNumber = 700 + Number((db.prepare("SELECT count(*) AS n FROM invoices").get() as { n: bigint }).n);
  const at = "2026-10-22T09:00:00.000Z";
  db.prepare(
    `INSERT INTO invoices (
       id, status, invoice_number, invoice_date, currency, customer_name, customer_address,
       customer_phone, notes, subtotal_minor, tax_minor, total_minor, paid_minor,
       balance_due_minor, amount_in_words, issuer_snapshot_json, tax_snapshot_json,
       created_by_id, created_by_name, created_at, updated_at, finalized_at
     ) VALUES (?, 'draft', NULL, NULL, 'USD', ?, NULL, NULL, NULL, ?, 0, ?, 0, ?,
               NULL, NULL, NULL, ?, 'مالك اختباري', ?, ?, NULL)`,
  ).run(input.id, "اسم حر من المستند", input.total, input.total, input.total, operatorId, at, at);
  db.prepare(
    `INSERT INTO invoice_lines
       (id, invoice_id, line_no, description, unit_label, canonical_unit, product_id,
        quantity_milli, unit_price_minor, line_total_minor, created_at)
     VALUES (?, ?, 1, 'بند فاتورة', 'قطعة', 'piece', NULL, 1000, ?, ?, ?)`,
  ).run(input.lineId, input.id, input.total, input.total, at);
  db.prepare(
    `UPDATE invoices
     SET status = 'final', invoice_number = ?, invoice_date = '2026-10-22',
         amount_in_words = 'مبلغ تجريبي', issuer_snapshot_json = '{"name":"متجر اختباري"}',
         finalized_at = ?
     WHERE id = ?`,
  ).run(invoiceNumber, at, input.id);
}

function insertSale(
  db: Db,
  input: {
    id: string;
    receipt: number;
    total: number;
    method: string | null;
    source?: "pos" | "invoice";
    invoiceId?: string | null;
    paid?: number;
    due?: number;
  },
): void {
  const source = input.source ?? "pos";
  const invoiceId = input.invoiceId ?? null;
  const paid = input.paid ?? input.total;
  const due = input.due ?? input.total - paid;
  const status = due === 0 ? "paid" : paid === 0 ? "unpaid" : "partial";
  db.prepare(
    `INSERT INTO sales (
       id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
       cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor,
       balance_due_minor, payment_status, payment_method, line_count, business_date,
       completed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'cashier-01', 'مالك اختباري', 'USD', ?, 0, ?, ?, ?, ?, ?, 1,
               '2026-10-22', '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:00.000Z')`,
  ).run(
    input.id,
    input.receipt,
    `history-key-${input.id}`,
    `history-fingerprint-${input.id}`,
    source,
    invoiceId,
    input.total,
    input.total,
    paid,
    due,
    status,
    input.method,
  );
  db.prepare(
    `INSERT INTO sale_lines (
       id, sale_id, line_no, invoice_line_id, product_id, sku, product_name, sale_unit,
       unit_label, quantity_milli, unit_price_minor, line_total_minor
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'قطعة', 1000, ?, ?)`,
  ).run(
    `line-${input.id}`,
    input.id,
    source === "invoice"
      ? input.id === "sale-invoice"
        ? "invoice-line-existing"
        : `invoice-sale-line-${input.id}`
      : null,
    source === "invoice" ? null : "synthetic-product",
    source === "invoice" ? null : "SYN",
    "صنف تاريخي",
    source === "invoice" ? null : "piece",
    input.total,
    input.total,
  );
}

function seedV13(path: string): {
  rows: ReturnType<typeof rowsByTable>;
  objects: Row[];
  tables: Row[];
  indexes: Record<string, Row[]>;
  foreignKeys: Record<string, Row[]>;
} {
  const db = openDatabase(path, MIGRATIONS_V13);
  expect(schemaVersion(db)).toBe(V13);
  const operatorId = (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
  const at = "2026-10-22T09:00:00.000Z";
  db.prepare(
    `INSERT INTO parties
       (id, kind, display_name, is_active, created_by, created_at, updated_at)
     VALUES
       ('customer-001', 'customer', 'محمد علي', 1, ?, ?, ?),
       ('customer-002', 'customer', 'محمد علي', 1, ?, ?, ?),
       ('customer-archived', 'customer', 'عميل مؤرشف', 0, ?, ?, ?),
       ('supplier-001', 'supplier', 'مورد عربي', 1, ?, ?, ?)`,
  ).run(operatorId, at, at, operatorId, at, at, operatorId, at, at, operatorId, at, at);
  insertInvoice(db, { id: "invoice-existing", lineId: "invoice-line-existing", total: 600 });

  insertSale(db, { id: "sale-cash", receipt: 101, total: 100, method: "cash" });
  insertSale(db, { id: "sale-card", receipt: 102, total: 200, method: "card" });
  insertSale(db, { id: "sale-external", receipt: 103, total: 300, method: "external" });
  insertSale(db, { id: "sale-other", receipt: 104, total: 400, method: "other" });
  // Legal under v13 and intentionally preserved even though its tender/status are contradictory.
  insertSale(db, { id: "sale-legacy-unpaid-cash", receipt: 105, total: 500, method: "cash", paid: 0, due: 500 });
  insertSale(db, {
    id: "sale-invoice",
    receipt: 106,
    total: 600,
    method: null,
    source: "invoice",
    invoiceId: "invoice-existing",
    paid: 0,
    due: 600,
  });
  db.prepare(
    `INSERT INTO voids (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at)
     VALUES ('void-existing', 'sale-cash', 'cashier-01', 'مالك اختباري', 'إلغاء اصطناعي',
             '2026-10-22', '2026-10-22T10:01:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO obligations (
       id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency,
       amount_minor, posted_by, posted_at, business_date
     ) VALUES
       ('obligation-sale', 'customer-001', 'customer', 'receivable', 'sale',
        'sale-legacy-unpaid-cash', 'sale-legacy-unpaid-cash', 'USD', 500, ?,
        '2026-10-22T10:02:00.000Z', '2026-10-22'),
       ('obligation-manual-customer', 'customer-002', 'customer', 'receivable', 'manual',
        'paper-customer-001', NULL, 'USD', 200, ?, '2026-10-22T10:03:00.000Z', '2026-10-22'),
       ('obligation-manual-supplier', 'supplier-001', 'supplier', 'payable', 'manual',
        'paper-supplier-001', NULL, 'USD', 75, ?, '2026-10-22T10:04:00.000Z', '2026-10-22')`,
  ).run(operatorId, operatorId, operatorId);
  db.prepare(
    `INSERT INTO settlements (
       id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor,
       method, settled_by, settled_at, business_date
     ) VALUES
       ('settlement-sale-partial', 'obligation-sale', 'USD', 'settle-sale-0001',
        'fingerprint-sale-partial', 125, 'cash', ?, '2026-10-22T10:05:00.000Z', '2026-10-22'),
       ('settlement-customer-partial', 'obligation-manual-customer', 'USD', 'settle-customer-01',
        'fingerprint-customer-partial', 50, 'card', ?, '2026-10-22T10:06:00.000Z', '2026-10-22'),
       ('settlement-customer-final', 'obligation-manual-customer', 'USD', 'settle-customer-02',
        'fingerprint-customer-final', 150, 'external', ?, '2026-10-22T10:07:00.000Z', '2026-10-22'),
       ('settlement-supplier-full', 'obligation-manual-supplier', 'USD', 'settle-supplier-01',
        'fingerprint-supplier-full', 75, 'other', ?, '2026-10-22T10:08:00.000Z', '2026-10-22')`,
  ).run(operatorId, operatorId, operatorId, operatorId);

  const rows = rowsByTable(db);
  const objects = namedObjects(db);
  const tables = tableDefinitions(db);
  const indexes = indexStates(db);
  const foreignKeys = foreignKeyStates(db);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  db.close();
  return { rows, objects, tables, indexes, foreignKeys };
}

interface CreditSaleInput {
  readonly id: string;
  readonly receipt: number;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly method?: string | null;
  readonly status?: "paid" | "partial" | "unpaid";
  readonly paid?: number;
  readonly due?: number;
  readonly currency?: string;
}

function insertCreditSale(db: Db, input: CreditSaleInput): void {
  const total = 1500;
  const paid = input.paid ?? 0;
  const due = input.due ?? total;
  db.prepare(
    `INSERT INTO sales (
       id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
       cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor,
       balance_due_minor, payment_status, payment_method, line_count, business_date,
       completed_at, created_at, customer_id, customer_name_snapshot
     ) VALUES (?, ?, ?, ?, 'pos', NULL, 'cashier-01', 'مالك اختباري', ?, ?, 0, ?, ?, ?, ?, ?,
               1, '2026-10-23', '2026-10-23T10:00:00.000Z', '2026-10-23T10:00:00.000Z', ?, ?)`,
  ).run(
    input.id,
    input.receipt,
    `credit-key-${input.id}`,
    `credit-fingerprint-${input.id}`,
    input.currency ?? "USD",
    total,
    total,
    paid,
    due,
    input.status ?? "unpaid",
    input.method === undefined ? null : input.method,
    input.customerId,
    input.customerName,
  );
}

function insertCreditObligation(
  db: Db,
  input: {
    readonly id: string;
    readonly saleId: string;
    readonly partyId: string;
    readonly partyKind: "customer" | "supplier";
    readonly direction: "receivable" | "payable";
    readonly currency?: string;
    readonly amount?: number;
  },
): void {
  db.prepare(
    `INSERT INTO obligations (
       id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency,
       amount_minor, posted_by, posted_at, business_date
     ) VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, 'cashier-01',
               '2026-10-23T10:00:00.000Z', '2026-10-23')`,
  ).run(
    input.id,
    input.partyId,
    input.partyKind,
    input.direction,
    input.saleId,
    input.saleId,
    input.currency ?? "USD",
    input.amount ?? 1500,
  );
}

describe("migration 14 — schema-only customer credit sale representation", () => {
  it("upgrades populated v13 history with exact values, relationships, schema objects and financial protections", () => {
    const before = seedV13(t.dbPath);
    expect(before.rows.sales).toHaveLength(6);
    expect(before.rows.sale_lines).toHaveLength(6);
    expect(before.rows.voids).toHaveLength(1);
    expect(before.rows.obligations).toHaveLength(3);
    expect(before.rows.settlements).toHaveLength(4);
    expect(before.rows.parties.filter((row) => row.display_name === "محمد علي")).toHaveLength(2);
    expect(before.rows.sales.map((row) => row.payment_method)).toContain(null);
    expect(before.rows.sales.map((row) => row.payment_method)).toEqual(
      expect.arrayContaining(["cash", "card", "external", "other", null]),
    );

    let backupCounts: Record<string, number> | undefined;
    const db = openDatabase(t.dbPath, MIGRATIONS, {
      beforeMigrations: (connection, pending) => {
        expect(pending).toEqual({ fromVersion: V13, toVersion: V14 });
        backupCounts = snapshotDatabase(connection, `${t.dir}/pre-m14.sqlite`).counts;
      },
    });
    try {
      expect(schemaVersion(db)).toBe(V14);
      expect(backupCounts).toMatchObject({
        sales: 6,
        sale_lines: 6,
        voids: 1,
        parties: 4,
        obligations: 3,
        settlements: 4,
      });
      expectHistoricalRowsPreserved(db, before.rows);
      expect(db.prepare("SELECT id, receipt_number, idempotency_key, request_fingerprint, invoice_id FROM sales WHERE id = 'sale-invoice'").get()).toEqual(
        expect.objectContaining({
          id: "sale-invoice",
          receipt_number: 106n,
          idempotency_key: "history-key-sale-invoice",
          request_fingerprint: "history-fingerprint-sale-invoice",
          invoice_id: "invoice-existing",
        }),
      );
      expect(db.prepare("SELECT id, customer_id, customer_name_snapshot FROM sales ORDER BY id").all()).toEqual(
        before.rows.sales.map((sale) => ({
          id: sale.id,
          customer_id: null,
          customer_name_snapshot: null,
        })),
      );
      expect(db.prepare("SELECT id, display_name FROM parties WHERE id IN ('customer-001', 'customer-002') ORDER BY id").all()).toEqual([
        { id: "customer-001", display_name: "محمد علي" },
        { id: "customer-002", display_name: "محمد علي" },
      ]);

      const oldObjectsAfter = namedObjects(db).filter((object) => !NEW_TRIGGERS.includes(String(object.name)));
      expect(oldObjectsAfter).toEqual(before.objects);
      expect(tableDefinitions(db).filter((table) => table.name !== "sales")).toEqual(
        before.tables.filter((table) => table.name !== "sales"),
      );
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'sales_m14'").get()).toBeUndefined();
      expect(indexStates(db)).toEqual(before.indexes);

      for (const table of ["sale_lines", "voids", "obligations", "settlements", "parties"]) {
        expect(foreignKeys(db, table)).toEqual(before.foreignKeys[table]);
      }
      const salesFks = foreignKeys(db, "sales");
      expect(salesFks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ parent: "invoices", from: "invoice_id", to: "id" }),
          expect.objectContaining({ parent: "parties", from: "customer_id", to: "id" }),
          expect.objectContaining({ parent: "parties", from: "customer_kind", to: "kind" }),
        ]),
      );
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

      const successfulRestorePath = `${t.dir}/restored-successful-v13.sqlite`;
      copyFileSync(`${t.dir}/pre-m14.sqlite`, successfulRestorePath);
      const successfulRestore = openDatabase(successfulRestorePath, MIGRATIONS_V13, { fileMustExist: true });
      try {
        expect(schemaVersion(successfulRestore)).toBe(V13);
        expect(rowsByTable(successfulRestore)).toEqual(before.rows);
        expect(successfulRestore.pragma("foreign_key_check")).toEqual([]);
        expect(successfulRestore.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        successfulRestore.close();
      }

      let receipt = 107;
      const nextCredit = (id: string, customerId = "customer-001", customerName = "محمد علي") =>
        insertCreditSale(db, { id, receipt: receipt++, customerId, customerName });
      nextCredit("credit-valid-a");
      nextCredit("credit-valid-b", "customer-002");
      expect(
        db.prepare("SELECT payment_method, paid_minor, payment_status, balance_due_minor, total_minor, customer_id, customer_name_snapshot, customer_kind FROM sales WHERE id='credit-valid-a'").get(),
      ).toEqual({
        payment_method: null,
        paid_minor: 0n,
        payment_status: "unpaid",
        balance_due_minor: 1500n,
        total_minor: 1500n,
        customer_id: "customer-001",
        customer_name_snapshot: "محمد علي",
        customer_kind: "customer",
      });
      expect(db.prepare("SELECT customer_id FROM sales WHERE id='credit-valid-b'").get()).toEqual({ customer_id: "customer-002" });

      insertCreditObligation(db, {
        id: "obligation-credit-valid",
        saleId: "credit-valid-a",
        partyId: "customer-001",
        partyKind: "customer",
        direction: "receivable",
      });
      expect(db.prepare("SELECT count(*) AS n FROM obligations WHERE source_kind='sale' AND source_ref='credit-valid-a'").get()).toEqual({ n: 1n });
      expect(() =>
        insertCreditObligation(db, {
          id: "obligation-credit-duplicate",
          saleId: "credit-valid-a",
          partyId: "customer-001",
          partyKind: "customer",
          direction: "receivable",
        }),
      ).toThrow();

      nextCredit("credit-wrong-party");
      expect(() =>
        insertCreditObligation(db, {
          id: "obligation-credit-wrong-party",
          saleId: "credit-wrong-party",
          partyId: "customer-002",
          partyKind: "customer",
          direction: "receivable",
        }),
      ).toThrow(/sale obligation does not match/);
      nextCredit("credit-wrong-currency");
      expect(() =>
        insertCreditObligation(db, {
          id: "obligation-credit-wrong-currency",
          saleId: "credit-wrong-currency",
          partyId: "customer-001",
          partyKind: "customer",
          direction: "receivable",
          currency: "EUR",
        }),
      ).toThrow(/sale obligation does not match/);
      nextCredit("credit-wrong-amount");
      expect(() =>
        insertCreditObligation(db, {
          id: "obligation-credit-wrong-amount",
          saleId: "credit-wrong-amount",
          partyId: "customer-001",
          partyKind: "customer",
          direction: "receivable",
          amount: 1499,
        }),
      ).toThrow(/sale obligation does not match/);
      nextCredit("credit-wrong-direction");
      expect(() =>
        insertCreditObligation(db, {
          id: "obligation-credit-wrong-direction",
          saleId: "credit-wrong-direction",
          partyId: "supplier-001",
          partyKind: "supplier",
          direction: "payable",
        }),
      ).toThrow(/sale obligation does not match/);

      const operatorId = (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
      expect(() =>
        db.prepare(
          `INSERT INTO settlements
             (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor,
              method, settled_by, settled_at, business_date)
           VALUES ('settlement-overpay-existing', 'obligation-sale', 'USD', 'overpay-existing-1',
                   'overpay-existing-fp', 376, 'cash', ?, '2026-10-23T11:00:00.000Z', '2026-10-23')`,
        ).run(operatorId),
      ).toThrow(/cannot exceed what is owed/);
      expect(() => db.prepare("UPDATE sales SET total_minor = 1 WHERE id = 'sale-cash'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM sales WHERE id = 'sale-cash'").run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare("UPDATE sale_lines SET product_name = 'تغيير' WHERE id = 'line-sale-cash'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM sale_lines WHERE id = 'line-sale-cash'").run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare("UPDATE voids SET reason = 'تغيير' WHERE id = 'void-existing'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM voids WHERE id = 'void-existing'").run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare("UPDATE obligations SET amount_minor = 1 WHERE id = 'obligation-sale'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM obligations WHERE id = 'obligation-sale'").run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare("UPDATE settlements SET amount_minor = 1 WHERE id = 'settlement-sale-partial'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM settlements WHERE id = 'settlement-sale-partial'").run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare("DELETE FROM parties WHERE id = 'customer-001'").run()).toThrow(/archived, never deleted/);
      expect(() => db.prepare("UPDATE parties SET kind = 'supplier' WHERE id = 'customer-001'").run()).toThrow(/kind cannot change/);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("preserves v13's historic unpaid/tender rows but rejects new contradictions and preserves invoice NULL methods", () => {
    const before = seedV13(t.dbPath);
    const db = openDatabase(t.dbPath, MIGRATIONS);
    try {
      expectHistoricalRowsPreserved(db, before.rows);
      expect(db.prepare("SELECT payment_method, payment_status FROM sales WHERE id='sale-legacy-unpaid-cash'").get()).toEqual({
        payment_method: "cash",
        payment_status: "unpaid",
      });

      const legacySaleColumns = `id, receipt_number, idempotency_key, request_fingerprint, source_type,
        invoice_id, cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor,
        paid_minor, balance_due_minor, payment_status, payment_method, line_count, business_date,
        completed_at, created_at, customer_id, customer_name_snapshot`;
      const legacySaleInsert = (conflict: "INSERT" | "INSERT OR REPLACE", id: string) =>
        db.prepare(
          `${conflict} INTO sales (${legacySaleColumns})
           SELECT ?, receipt_number, ?, ?, source_type, invoice_id, cashier_id, cashier_name, currency,
                  subtotal_minor, tax_minor, total_minor, paid_minor, balance_due_minor, payment_status,
                  payment_method, line_count, business_date, completed_at, created_at, customer_id,
                  customer_name_snapshot
           FROM sales WHERE id = 'sale-legacy-unpaid-cash'`,
        ).run(id, `legacy-copy-${id}`, `legacy-copy-fingerprint-${id}`);
      expect(() => legacySaleInsert("INSERT", "copied-legacy-unpaid-cash"))
        .toThrow(/unpaid POS sale cannot record a tender/);
      expect(() => legacySaleInsert("INSERT OR REPLACE", "sale-legacy-unpaid-cash"))
        .toThrow(/unpaid POS sale cannot record a tender/);
      expect(db.prepare("SELECT payment_method, payment_status FROM sales WHERE id='sale-legacy-unpaid-cash'").get()).toEqual({
        payment_method: "cash",
        payment_status: "unpaid",
      });

      const addCredit = (input: CreditSaleInput) => insertCreditSale(db, input);
      const invalidShapes: CreditSaleInput[] = [
        { id: "bad-credit-paid-null", receipt: 107, customerId: "customer-001", customerName: "محمد علي", status: "paid", paid: 1500, due: 0 },
        { id: "bad-credit-partial-null", receipt: 108, customerId: "customer-001", customerName: "محمد علي", status: "partial", paid: 500, due: 1000 },
        { id: "bad-credit-no-customer", receipt: 109, customerId: null, customerName: null },
        { id: "bad-credit-name-only", receipt: 110, customerId: null, customerName: "محمد علي" },
        { id: "bad-credit-id-only", receipt: 111, customerId: "customer-001", customerName: null },
        { id: "bad-credit-empty-name", receipt: 112, customerId: "customer-001", customerName: "  " },
        { id: "bad-credit-unknown-customer", receipt: 113, customerId: "customer-missing", customerName: "محمد علي" },
        { id: "bad-credit-supplier-as-customer", receipt: 114, customerId: "supplier-001", customerName: "مورد عربي" },
        { id: "bad-credit-inactive-customer", receipt: 115, customerId: "customer-archived", customerName: "عميل مؤرشف" },
        { id: "bad-credit-name-mismatch", receipt: 116, customerId: "customer-001", customerName: "اسم مختلف" },
        { id: "bad-credit-unpaid-cash", receipt: 117, customerId: "customer-001", customerName: "محمد علي", method: "cash" },
        { id: "bad-credit-method", receipt: 118, customerId: "customer-001", customerName: "محمد علي", method: "credit" },
        { id: "bad-credit-wrong-residual", receipt: 119, customerId: "customer-001", customerName: "محمد علي", due: 1499 },
      ];
      for (const shape of invalidShapes) expect(() => addCredit(shape), shape.id).toThrow();

      insertSale(db, {
        id: "post-m14-cash",
        receipt: 120,
        total: 200,
        method: "cash",
      });
      expect(db.prepare("SELECT payment_method, payment_status, paid_minor, balance_due_minor FROM sales WHERE id='post-m14-cash'").get()).toEqual({
        payment_method: "cash",
        payment_status: "paid",
        paid_minor: 200n,
        balance_due_minor: 0n,
      });

      insertInvoice(db, { id: "invoice-new", lineId: "invoice-line-new", total: 300 });
      insertSale(db, {
        id: "invoice-sale-new",
        receipt: 121,
        total: 300,
        method: null,
        source: "invoice",
        invoiceId: "invoice-new",
        paid: 0,
        due: 300,
      });
      expect(db.prepare("SELECT source_type, invoice_id, payment_method, payment_status FROM sales WHERE id='invoice-sale-new'").get()).toEqual({
        source_type: "invoice",
        invoice_id: "invoice-new",
        payment_method: null,
        payment_status: "unpaid",
      });
      expect(db.prepare("SELECT customer_id, customer_name_snapshot FROM sales WHERE id='invoice-sale-new'").get()).toEqual({
        customer_id: null,
        customer_name_snapshot: null,
      });

      expect(() =>
        db.prepare(
          `INSERT INTO sales (
             id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
             cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor,
             balance_due_minor, payment_status, payment_method, line_count, business_date,
             completed_at, created_at, customer_id, customer_name_snapshot
           ) VALUES ('new-legacy-shape', 122, 'new-legacy-key-001', 'new-legacy-fp', 'pos', NULL,
                     'cashier-01', 'مالك اختباري', 'USD', 100, 0, 100, 0, 100, 'unpaid', 'cash',
                     1, '2026-10-23', '2026-10-23T10:00:00.000Z', '2026-10-23T10:00:00.000Z',
                     'customer-001', 'محمد علي')`,
        ).run(),
      ).toThrow(/unpaid POS sale cannot record a tender/);

      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("rolls a failed v14 migration back completely, verifies its backup, and restores under v13", () => {
    const before = seedV13(t.dbPath);
    const failedBackupPath = `${t.dir}/failed-pre-m14.sqlite`;
    const failedM14 = {
      ...MIGRATIONS[V13]!,
      sql: `${MIGRATIONS[V13]!.sql}\nINSERT INTO deliberately_missing_m14_table VALUES (1);`,
    };
    expect(() =>
      openDatabase(t.dbPath, [...MIGRATIONS_V13, failedM14], {
        beforeMigrations: (connection, pending) => {
          expect(pending).toEqual({ fromVersion: V13, toVersion: V14 });
          snapshotDatabase(connection, failedBackupPath);
        },
      }),
    ).toThrow(/deliberately_missing_m14_table/);

    const reopened = openDatabase(t.dbPath, MIGRATIONS_V13);
    try {
      expect(schemaVersion(reopened)).toBe(V13);
      expect(rowsByTable(reopened)).toEqual(before.rows);
      expect(namedObjects(reopened)).toEqual(before.objects);
      expect(tableDefinitions(reopened)).toEqual(before.tables);
      expect(reopened.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE '%_m14'").get()).toBeUndefined();
      expect(reopened.pragma("foreign_key_check")).toEqual([]);
      expect(reopened.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      reopened.close();
    }

    const restoredCopyPath = `${t.dir}/restored-failed-v13.sqlite`;
    copyFileSync(failedBackupPath, restoredCopyPath);
    const restored = openDatabase(restoredCopyPath, MIGRATIONS_V13, { fileMustExist: true });
    try {
      expect(schemaVersion(restored)).toBe(V13);
      expect(rowsByTable(restored)).toEqual(before.rows);
      expect(restored.pragma("foreign_key_check")).toEqual([]);
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      restored.close();
    }
  });

  it("fresh installs reach v14 and an already-migrated database is not rebuilt on reopen", () => {
    const freshPath = `${t.dir}/fresh.sqlite`;
    const fresh = openDatabase(freshPath);
    try {
      expect(schemaVersion(fresh)).toBe(V14);
      expect(fresh.pragma("foreign_key_check")).toEqual([]);
      expect(fresh.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(fresh.prepare("SELECT name FROM sqlite_schema WHERE name = 'sales_m14'").get()).toBeUndefined();
    } finally {
      fresh.close();
    }

    seedV13(t.dbPath);
    const first = openDatabase(t.dbPath);
    const afterFirst = {
      rows: rowsByTable(first),
      objects: namedObjects(first),
      tables: tableDefinitions(first),
    };
    first.close();
    let backupCalls = 0;
    const second = openDatabase(t.dbPath, MIGRATIONS, {
      beforeMigrations: () => {
        backupCalls += 1;
      },
    });
    try {
      expect(backupCalls).toBe(0);
      expect(schemaVersion(second)).toBe(V14);
      expect(rowsByTable(second)).toEqual(afterFirst.rows);
      expect(namedObjects(second)).toEqual(afterFirst.objects);
      expect(tableDefinitions(second)).toEqual(afterFirst.tables);
    } finally {
      second.close();
    }
  });
});
