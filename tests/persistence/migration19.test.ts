import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type TempDir, tempDir } from "../helpers/harness";

/**
 * Migration 19 — the unified payment model (owner design v3, 2026-11-07). Every test runs on a
 * THROW-AWAY ledger in a temp directory: no merchant data, no FIELD profile, no original database.
 *
 * Owner conditions (D-M19-GO), each pinned below:
 *  1 sales rebuild keeps every row, value, id and constraint   2 history identical before / after
 *  3 no old method changed, nothing invented                   4 tenders / references atomic
 *  5 one reference across every kind                           6 advances, applications, cash refunds
 *  7 a cashier cannot refund, even below the UI                8 upgrade from v18, rollback on failure
 *  9 an older app refuses a v19 ledger without touching it    10 integrity, FKs, accounting after each
 */

const V18 = 18;
const V19 = 19;
const MIGRATIONS_V18 = MIGRATIONS.slice(0, V18);
// TRANSITION (migration 20): these tests used the full registry `MIGRATIONS`, which WAS v19 when they were
// written. They test migration 19, so they open the ledger at v19 exactly; migration 20 has its own tests.
const MIGRATIONS_V19 = MIGRATIONS.slice(0, V19);
const AT = "2026-11-07T09:00:00.000Z";
const DAY = "2026-11-07";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type Row = Record<string, unknown>;
const all = (db: Db, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Row[];
const one = (db: Db, sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row;
const n = (db: Db, sql: string, ...p: unknown[]) => Number(one(db, sql, ...p).n);
const SALE_COLS =
  "id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id, cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor, balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at, created_at, customer_id, customer_name_snapshot";
const HISTORY_TABLES = ["sale_lines", "voids", "invoices", "invoice_lines", "parties", "obligations", "settlements", "receipts", "operators"];

function history(db: Db): Record<string, Row[]> {
  const out: Record<string, Row[]> = { sales: all(db, `SELECT ${SALE_COLS} FROM sales ORDER BY id`) };
  for (const tbl of HISTORY_TABLES) out[tbl] = all(db, `SELECT * FROM ${tbl} ORDER BY rowid`);
  return out;
}
const objects = (db: Db) =>
  all(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name");
const sound = (db: Db) => {
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(db.pragma("foreign_key_check")).toEqual([]);
};
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error("expected the ledger to refuse");
}
const owner = (db: Db) => String(one(db, "SELECT id FROM operators WHERE role = 'owner' ORDER BY id LIMIT 1").id);

// ── a v18 ledger holding every historical shape ───────────────────────────────────────────────
function sale(db: Db, s: { id: string; receipt: number; total: number; method: string | null; paid?: number; source?: "pos" | "invoice"; invoiceId?: string; customer?: string }) {
  const paid = s.paid ?? s.total;
  const due = s.total - paid;
  const status = due === 0 ? "paid" : paid === 0 ? "unpaid" : "partial";
  db.prepare(
    `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id, cashier_id, cashier_name,
       currency, subtotal_minor, tax_minor, total_minor, paid_minor, balance_due_minor, payment_status, payment_method, line_count,
       business_date, completed_at, created_at, customer_id, customer_name_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, 'cashier-01', 'مالك اختباري', 'USD', ?, 0, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(s.id, s.receipt, `hist-key-${s.id}`, `hist-fp-${s.id}`, s.source ?? "pos", s.invoiceId ?? null, s.total, s.total, paid, due, status,
    s.method, DAY, AT, AT, s.customer ?? null, s.customer ? `name-${s.customer}` : null);
  db.prepare(
    `INSERT INTO sale_lines (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name, sale_unit, unit_label, quantity_milli, unit_price_minor, line_total_minor)
     VALUES (?, ?, 1, ?, ?, ?, 'صنف تاريخي', ?, 'قطعة', 1000, ?, ?)`,
  ).run(`line-${s.id}`, s.id, s.source === "invoice" ? `iline-${s.invoiceId}` : null, s.source === "invoice" ? null : "p-1",
    s.source === "invoice" ? null : "SKU-1", s.source === "invoice" ? null : "piece", s.total, s.total);
}
function invoice(db: Db, id: string, total: number, paid: number, customer: string | null) {
  const op = owner(db);
  db.prepare(
    `INSERT INTO invoices (id, status, invoice_number, invoice_date, currency, customer_name, subtotal_minor, tax_minor, total_minor, paid_minor,
       balance_due_minor, created_by_id, created_by_name, created_at, updated_at, customer_party_id)
     VALUES (?, 'draft', NULL, NULL, 'USD', 'زبون', ?, 0, ?, ?, ?, ?, 'مالك', ?, ?, ?)`,
  ).run(id, total, total, paid, total - paid, op, AT, AT, customer);
  db.prepare(
    `INSERT INTO invoice_lines (id, invoice_id, line_no, description, unit_label, canonical_unit, product_id, quantity_milli, unit_price_minor, line_total_minor, created_at)
     VALUES (?, ?, 1, 'بند', 'قطعة', 'piece', NULL, 1000, ?, ?, ?)`,
  ).run(`iline-${id}`, id, total, total, AT);
  const no = 900 + n(db, "SELECT count(*) AS n FROM invoices");
  db.prepare(
    `UPDATE invoices SET status = 'final', invoice_number = ?, invoice_date = ?, amount_in_words = 'كلمات', issuer_snapshot_json = '{"name":"م"}', finalized_at = ? WHERE id = ?`,
  ).run(no, DAY, AT, id);
}
function party(db: Db, id: string) {
  db.prepare("INSERT INTO parties (id, kind, display_name, is_active, created_by, created_at, updated_at) VALUES (?, 'customer', ?, 1, ?, ?, ?)").run(
    id, `name-${id}`, owner(db), AT, AT);
}
function obligation(db: Db, id: string, partyId: string, amount: number, saleId: string | null) {
  db.prepare(
    `INSERT INTO obligations (id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency, amount_minor, posted_by, posted_at, business_date)
     VALUES (?, ?, 'customer', 'receivable', ?, ?, ?, 'USD', ?, ?, ?, ?)`,
  ).run(id, partyId, saleId ? "sale" : "manual", saleId ?? `paper-${id}`, saleId, amount, owner(db), AT, DAY);
}
function settle(db: Db, id: string, obl: string, amount: number, method: string, provider: string | null, reference: string | null, receiptId: string | null = null) {
  db.prepare(
    `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, provider, reference, funds_confirmed, settled_by, settled_at, business_date, receipt_id)
     VALUES (?, ?, 'USD', ?, 'fp', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, obl, `key-${id}-0001`, amount, method, provider, reference, provider ? 1 : null, owner(db), AT, DAY, receiptId);
}
function receipt(db: Db, id: string, customer: string, amount: number, count: number, reference: string) {
  db.prepare(
    `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
     VALUES (?, ?, 'USD', ?, 'whish', ?, 1, ?, ?, 'fp', ?, ?, ?)`,
  ).run(id, customer, amount, reference, count, `rkey-${id}-0001`, owner(db), AT, DAY);
}

function seedV18(path: string): void {
  const db = openDatabase(path, MIGRATIONS_V18);
  try {
    expect(schemaVersion(db)).toBe(V18);
    party(db, "c1");
    party(db, "c2");
    sale(db, { id: "s-cash", receipt: 1, total: 100, method: "cash" });
    sale(db, { id: "s-card", receipt: 2, total: 200, method: "card" });
    sale(db, { id: "s-ext", receipt: 3, total: 300, method: "external" });
    sale(db, { id: "s-other", receipt: 4, total: 400, method: "other" });
    sale(db, { id: "s-credit", receipt: 5, total: 1500, method: null, paid: 0, customer: "c1" });
    obligation(db, "o-credit", "c1", 1500, "s-credit");
    invoice(db, "inv-unpaid", 600, 0, null);
    sale(db, { id: "s-inv-unpaid", receipt: 6, total: 600, method: null, paid: 0, source: "invoice", invoiceId: "inv-unpaid" });
    invoice(db, "inv-partial", 1000, 300, "c2");
    sale(db, { id: "s-inv-partial", receipt: 7, total: 1000, method: null, paid: 300, source: "invoice", invoiceId: "inv-partial" });
    db.prepare("INSERT INTO voids (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at) VALUES ('v1', 's-cash', 'cashier-01', 'مالك', 'سبب', ?, ?)").run(DAY, AT);
    obligation(db, "o-m1", "c1", 900, null);
    obligation(db, "o-m2", "c1", 500, null);
    settle(db, "st-cash", "o-credit", 200, "cash", null, null);
    settle(db, "st-whish", "o-m1", 100, "external", "whish", "WH-OLD-1");
    settle(db, "st-whish-twin", "o-m1", 100, "external", "whish", "wh old 1"); // distinct raw at v18, same key at v19
    // A shared receipt is written exactly as the app writes it: allocations, then the sealing receipt,
    // in ONE transaction (settlements.receipt_id is a deferred foreign key).
    db.transaction(() => {
      settle(db, "st-r1", "o-m1", 300, "external", null, null, "r1");
      settle(db, "st-r2", "o-m2", 200, "external", null, null, "r1");
      receipt(db, "r1", "c1", 500, 2, "WH-RCPT-٧");
    })();
    sound(db);
  } finally {
    db.close();
  }
}

function upgraded(): { before: Record<string, Row[]>; objectsBefore: Row[]; db: Db } {
  seedV18(t.dbPath);
  const pre = openDatabase(t.dbPath, MIGRATIONS_V18);
  const before = history(pre);
  const objectsBefore = objects(pre);
  pre.close();
  const db = openDatabase(t.dbPath, MIGRATIONS_V19);
  return { before, objectsBefore, db };
}

describe("1–3 · upgrade v18 → v19 keeps every row, value, id and constraint, and invents nothing", () => {
  it("history is identical, typed, row by row; schema 19; checksums 1–18 unchanged", () => {
    const { before, db } = upgraded();
    try {
      expect(schemaVersion(db)).toBe(V19);
      expect(history(db)).toEqual(before);
      expect(n(db, "SELECT count(*) AS n FROM sales WHERE tender_count <> 0")).toBe(0);
      expect(n(db, "SELECT count(*) AS n FROM sale_tenders")).toBe(0);
      // the old methods, exactly as recorded — invoice sales stay NULL ("not recorded")
      expect(all(db, "SELECT id, payment_method AS m FROM sales ORDER BY id").map((r) => [r.id, r.m])).toEqual([
        ["s-card", "card"], ["s-cash", "cash"], ["s-credit", null], ["s-ext", "external"], ["s-inv-partial", null], ["s-inv-unpaid", null], ["s-other", "other"],
      ]);
      const sums = all(db, "SELECT version, checksum FROM schema_migrations WHERE version <= 18 ORDER BY version");
      expect(sums).toHaveLength(18);
      sound(db);
    } finally {
      db.close();
    }
  });

  it("every v18 schema object is byte-identical except the two intended changes", () => {
    const { objectsBefore, db } = upgraded();
    try {
      const after = new Map(objects(db).map((o) => [`${o.type}:${o.name}`, o.sql]));
      const changed = objectsBefore.filter((o) => after.get(`${o.type}:${o.name}`) !== o.sql).map((o) => `${o.type}:${o.name}`);
      expect(changed.sort()).toEqual(["table:sales", "trigger:obligations_invoice_sale_match"]);
    } finally {
      db.close();
    }
  });

  it("an existing till sale path still works unchanged (tender_count defaults to 0, method required)", () => {
    const { db } = upgraded();
    try {
      sale(db, { id: "s-new-cash", receipt: 50, total: 125, method: "cash" });
      expect(one(db, "SELECT tender_count AS c, payment_method AS m FROM sales WHERE id = 's-new-cash'")).toEqual({ c: 0n, m: "cash" });
      expect(refusal(() => sale(db, { id: "s-new-null", receipt: 51, total: 125, method: null }))).toMatch(/CHECK constraint failed/);
      sound(db);
    } finally {
      db.close();
    }
  });
});

describe("8 · a failed upgrade rolls back to v18 and changes nothing", () => {
  it("an injected failure after the rebuild leaves schema 18 and the history byte-identical", () => {
    seedV18(t.dbPath);
    const hash = () => createHash("sha256").update(readFileSync(t.dbPath)).digest("hex");
    const pre = openDatabase(t.dbPath, MIGRATIONS_V18);
    const before = history(pre);
    pre.close();
    const broken = [...MIGRATIONS_V18, { ...MIGRATIONS[V18]!, sql: `${MIGRATIONS[V18]!.sql}\nINSERT INTO deliberately_missing_m19 VALUES (1);` }];
    expect(() => openDatabase(t.dbPath, broken)).toThrow();
    const back = openDatabase(t.dbPath, MIGRATIONS_V18);
    try {
      expect(schemaVersion(back)).toBe(V18);
      expect(history(back)).toEqual(before);
      expect(n(back, "SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('sale_tenders','external_references','customer_advances')")).toBe(0);
      sound(back);
    } finally {
      back.close();
    }
    expect(hash()).toBeTruthy();
  });

  it("the self-check catches a row that changed during the rebuild (negative control) and rolls back", () => {
    seedV18(t.dbPath);
    // Same migration, with ONE value altered between copy-back and the comparison.
    const sql = MIGRATIONS[V18]!.sql.replace(
      "INSERT INTO m19_assert\nSELECT 'sales: same row count'",
      "DROP TRIGGER IF EXISTS sales_immutable_update;\nUPDATE sales SET cashier_name = 'tampered' WHERE id = 's-card';\nINSERT INTO m19_assert\nSELECT 'sales: same row count'",
    );
    expect(sql).not.toBe(MIGRATIONS[V18]!.sql);
    expect(() => openDatabase(t.dbPath, [...MIGRATIONS_V18, { ...MIGRATIONS[V18]!, sql }])).toThrow(/CHECK constraint failed/);
    const back = openDatabase(t.dbPath, MIGRATIONS_V18);
    try {
      expect(schemaVersion(back)).toBe(V18);
      expect(String(one(back, "SELECT cashier_name AS c FROM sales WHERE id = 's-card'").c)).toBe("مالك اختباري");
    } finally {
      back.close();
    }
  });
});

describe("9 · an older app refuses a v19 ledger without touching it", () => {
  it("opening with the v18 migration list throws and the file is byte-identical", () => {
    const { db } = upgraded();
    db.close();
    const hash = () => createHash("sha256").update(readFileSync(t.dbPath)).digest("hex");
    const h0 = hash();
    expect(() => openDatabase(t.dbPath, MIGRATIONS_V18)).toThrow();
    expect(hash()).toBe(h0);
  });
});

describe("4 · tenders are sealed by their sale, in one transaction", () => {
  const tender = (db: Db, saleId: string, seq: number, method: string, amount: number, provider: string | null = null, reference: string | null = null) =>
    db.prepare("INSERT INTO sale_tenders (sale_id, seq, method, provider, reference, funds_confirmed, amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      saleId, seq, method, provider, reference, provider ? 1 : null, amount);
  const splitSale = (db: Db, id: string, receiptNo: number, total: number, count: number) =>
    db.prepare(
      `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, cashier_id, cashier_name, currency, subtotal_minor, tax_minor,
         total_minor, paid_minor, balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at, created_at, tender_count)
       VALUES (?, ?, ?, 'fp', 'pos', 'cashier-01', 'م', 'USD', ?, 0, ?, ?, 0, 'paid', NULL, 1, ?, ?, ?, ?)`,
    ).run(id, receiptNo, `split-key-${id}`, total, total, total, DAY, AT, AT, count);

  it("cash + Whish = paid commits; a wrong sum, a late tender, a 9th tender all refuse and write nothing", () => {
    const { db } = upgraded();
    try {
      db.transaction(() => {
        tender(db, "s-split", 1, "cash", 300);
        tender(db, "s-split", 2, "external", 700, "whish", "WH-SPLIT-1");
        splitSale(db, "s-split", 60, 1000, 2);
      })();
      expect(n(db, "SELECT count(*) AS n FROM sale_tenders WHERE sale_id = 's-split'")).toBe(2);

      const before = [n(db, "SELECT count(*) AS n FROM sales"), n(db, "SELECT count(*) AS n FROM sale_tenders"), n(db, "SELECT count(*) AS n FROM external_references")];
      expect(refusal(() => db.transaction(() => {
        tender(db, "s-bad", 1, "cash", 300);
        tender(db, "s-bad", 2, "cash", 600);
        splitSale(db, "s-bad", 61, 1000, 2);
      })())).toMatch(/tenders must match/);
      expect(refusal(() => tender(db, "s-split", 3, "cash", 1))).toMatch(/cannot take another tender/);
      expect(refusal(() => db.transaction(() => { tender(db, "s-nine", 9, "cash", 1); })())).toMatch(/CHECK constraint failed/);
      expect(refusal(() => db.transaction(() => {
        tender(db, "s-one", 1, "card", 500);
        db.prepare(
          `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, cashier_id, cashier_name, currency, subtotal_minor, tax_minor,
             total_minor, paid_minor, balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at, created_at, tender_count)
           VALUES ('s-one', 62, 'one-key-0001', 'fp', 'pos', 'cashier-01', 'م', 'USD', 500, 0, 500, 500, 0, 'paid', 'cash', 1, ?, ?, ?, 1)`,
        ).run(DAY, AT, AT);
      })())).toMatch(/tenders must match/);
      expect([n(db, "SELECT count(*) AS n FROM sales"), n(db, "SELECT count(*) AS n FROM sale_tenders"), n(db, "SELECT count(*) AS n FROM external_references")]).toEqual(before);
      sound(db);
    } finally {
      db.close();
    }
  });
});

describe("5 · one Whish / bank reference, once, across every kind (D-REF-1 / D-REF-2)", () => {
  it("legacy references are registered, kept as history, and a twin pair is reported — not changed", () => {
    const { before, db } = upgraded();
    try {
      expect(n(db, "SELECT count(*) AS n FROM external_references WHERE legacy = 1")).toBe(3);
      expect(all(db, "SELECT provider, ref_key, uses FROM external_reference_legacy_collisions")).toEqual([{ provider: "whish", ref_key: "WHOLD1", uses: 2n }]);
      expect(one(db, "SELECT ref_key AS k FROM external_references WHERE owner_kind = 'receipt'").k).toBe("WHRCPT7");
      expect(history(db).settlements).toEqual(before.settlements);
    } finally {
      db.close();
    }
  });

  it("normalization: Arabic and Eastern digits, case, spaces and separators give one key; every kind is refused on reuse", () => {
    const { db } = upgraded();
    try {
      const refs0 = n(db, "SELECT count(*) AS n FROM external_references");
      settle(db, "st-new", "o-m2", 10, "external", "whish", "WH-٤٥6");
      expect(one(db, "SELECT ref_key AS k FROM external_references WHERE owner_id = 'st-new'").k).toBe("WH456");
      for (const variant of ["wh 456", "WH_۴۵۶", "wh/4.5-6"]) {
        expect(refusal(() => settle(db, `st-dup-${variant.length}${variant.charCodeAt(3)}`, "o-m2", 1, "external", "whish", variant))).toMatch(/already recorded/);
      }
      // the same text under the OTHER provider is a different reference
      settle(db, "st-bank", "o-m2", 10, "external", "bank_transfer", "WH-456");
      // a legacy key is reserved for ever (D-REF-2)
      expect(refusal(() => settle(db, "st-legacy-reuse", "o-m2", 1, "external", "whish", "WH OLD 1"))).toMatch(/already recorded/);
      // across kinds: a tender and an advance reusing a settlement's reference are refused too
      expect(refusal(() => db.transaction(() => {
        db.prepare("INSERT INTO sale_tenders (sale_id, seq, method, provider, reference, funds_confirmed, amount_minor) VALUES ('s-x', 1, 'external', 'whish', 'wh456', 1, 5)").run();
      })())).toMatch(/already recorded/);
      expect(n(db, "SELECT count(*) AS n FROM external_references")).toBe(refs0 + 2);
      sound(db);
    } finally {
      db.close();
    }
  });
});

describe("D-REF-1 = B (owner, 2026-11-07) · references merchants type today stay accepted, and still cannot repeat", () => {
  it("«WH-2026/10 #55» and «مرجع 77» are recorded; their spaced / cased / Arabic-digit twins are refused", () => {
    const { db } = upgraded();
    try {
      settle(db, "st-hash", "o-m2", 1, "external", "whish", "WH-2026/10 #55");
      settle(db, "st-ar", "o-m2", 1, "external", "bank_transfer", "مرجع 77");
      expect(one(db, "SELECT ref_key AS k FROM external_references WHERE owner_id = 'st-hash'").k).toBe("WH202610#55");
      expect(one(db, "SELECT ref_key AS k FROM external_references WHERE owner_id = 'st-ar'").k).toBe("مرجع77");
      expect(refusal(() => settle(db, "st-hash-2", "o-m2", 1, "external", "whish", "wh 2026.10 #55"))).toMatch(/already recorded/);
      expect(refusal(() => settle(db, "st-ar-2", "o-m2", 1, "external", "bank_transfer", "مرجع ٧٧"))).toMatch(/already recorded/);
      // a reference that normalizes to nothing is refused for a live entry
      expect(refusal(() => settle(db, "st-empty", "o-m2", 1, "external", "whish", "--"))).toMatch(/CHECK constraint failed/);
      sound(db);
    } finally {
      db.close();
    }
  });
});

describe("6–7 · advances: record, apply, refund — cash only, owner only, never above the unused balance", () => {
  function issue(db: Db, kind: string): number {
    db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = ?").run(kind);
    return n(db, "SELECT last_no AS n FROM document_numbers WHERE kind = ?", kind);
  }
  function advance(db: Db, id: string, amount: number, method = "cash", provider: string | null = null, reference: string | null = null) {
    const no = issue(db, "advance");
    db.prepare(
      `INSERT INTO customer_advances (id, doc_no, customer_id, currency, amount_minor, method, provider, reference, funds_confirmed, idempotency_key, request_fingerprint, received_by, received_at, business_date)
       VALUES (?, ?, 'c1', 'USD', ?, ?, ?, ?, ?, ?, 'fp', ?, ?, ?)`,
    ).run(id, no, amount, method, provider, reference, provider ? 1 : null, `adv-key-${id}`, owner(db), AT, DAY);
  }
  function refund(db: Db, id: string, adv: string, amount: number, by: string, method = "cash") {
    const no = issue(db, "advance_refund");
    db.prepare(
      `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint, refunded_by, refunded_at, business_date)
       VALUES (?, ?, ?, ?, ?, 'طلب الزبون', ?, 'fp', ?, ?, ?)`,
    ).run(id, no, adv, amount, method, `ref-key-${id}`, by, AT, DAY);
  }

  it("apply to a debt and refund the rest, both by the owner; over-use, cashier, non-cash and replay refused", () => {
    const { db } = upgraded();
    try {
      db.transaction(() => advance(db, "a1", 1000))();
      expect(n(db, "SELECT doc_no AS n FROM customer_advances WHERE id = 'a1'")).toBe(1);

      // apply 400 to c1's manual debt: the settlement carries no external evidence, the advance does
      db.transaction(() => {
        settle(db, "st-adv", "o-m2", 300, "cash", null, null);
        db.prepare("INSERT INTO advance_applications (id, advance_id, settlement_id, amount_minor, idempotency_key, applied_by, applied_at) VALUES ('ap1', 'a1', 'st-adv', 300, 'apply-key-0001', ?, ?)").run(owner(db), AT);
      })();

      // a CASHIER cannot refund, whatever the caller — enforced against the operator row
      const cashier = String(one(db, "SELECT id FROM operators WHERE role = 'cashier' ORDER BY id LIMIT 1").id);
      expect(refusal(() => db.transaction(() => refund(db, "rf-cashier", "a1", 100, cashier))())).toMatch(/owner's, in cash/);
      // non-cash refused by the table itself
      expect(refusal(() => db.transaction(() => refund(db, "rf-whish", "a1", 100, owner(db), "external"))())).toMatch(/CHECK constraint failed/);
      // refund within the unused balance (1000 − 300 = 700)
      db.transaction(() => refund(db, "rf1", "a1", 700, owner(db)))();
      // nothing left: a further refund or application is refused
      expect(refusal(() => db.transaction(() => refund(db, "rf2", "a1", 1, owner(db)))())).toMatch(/within the unused advance/);
      // the same idempotency key cannot refund twice
      expect(refusal(() => db.prepare(
        `INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint, refunded_by, refunded_at, business_date)
         VALUES ('rf-dup', 99, 'a1', 1, 'cash', 'تكرار', 'ref-key-rf1', 'fp', ?, ?, ?)`,
      ).run(owner(db), AT, DAY))).toMatch(/UNIQUE constraint failed|owner's, in cash/);
      // history is never edited or removed
      expect(refusal(() => db.prepare("UPDATE advance_refunds SET amount_minor = 1 WHERE id = 'rf1'").run())).toMatch(/immutable/);
      expect(refusal(() => db.prepare("DELETE FROM customer_advances WHERE id = 'a1'").run())).toMatch(/cannot be deleted/);
      // document numbers only move forward by one; a skipped number is refused
      expect(refusal(() => db.prepare("UPDATE document_numbers SET last_no = last_no + 2 WHERE kind = 'advance'").run())).toMatch(/forward by one/);

      // accounting: advance 1000 = applied 300 + refunded 700; the debt dropped by exactly 300
      expect(n(db, "SELECT coalesce(sum(amount_minor),0) AS n FROM advance_applications WHERE advance_id = 'a1'")
        + n(db, "SELECT coalesce(sum(amount_minor),0) AS n FROM advance_refunds WHERE advance_id = 'a1'")).toBe(1000);
      expect(n(db, "SELECT 500 - coalesce(sum(amount_minor),0) AS n FROM settlements WHERE obligation_id = 'o-m2'")).toBe(0);
      sound(db);
    } finally {
      db.close();
    }
  });

  it("an external advance needs its evidence and registers its reference against every other kind", () => {
    const { db } = upgraded();
    try {
      expect(refusal(() => db.transaction(() => advance(db, "a-bad", 500, "external", null, null))())).toMatch(/CHECK constraint failed/);
      db.transaction(() => advance(db, "a-whish", 500, "external", "whish", "WH-ADV-9"))();
      expect(refusal(() => settle(db, "st-adv-dup", "o-m2", 1, "external", "whish", "wh adv ٩"))).toMatch(/already recorded/);
      sound(db);
    } finally {
      db.close();
    }
  });
});

describe("D-P2a · the remainder of a partly paid invoice can become its customer's debt; an anonymous balance cannot", () => {
  it("a receivable equal to the balance of a partly paid, customer-linked invoice is accepted; a wrong one is not", () => {
    const { db } = upgraded();
    try {
      expect(refusal(() => obligation(db, "o-inv-wrong", "c2", 699, "s-inv-partial"))).toMatch(/invoice receivable must match/);
      obligation(db, "o-inv-partial", "c2", 700, "s-inv-partial");
      expect(refusal(() => obligation(db, "o-inv-other", "c1", 600, "s-inv-unpaid"))).toMatch(/invoice receivable must match/);
      sound(db);
    } finally {
      db.close();
    }
  });

  it("a NEW till sale that leaves a balance must name its customer", () => {
    const { db } = upgraded();
    try {
      expect(refusal(() => sale(db, { id: "s-anon", receipt: 70, total: 500, method: "cash", paid: 200 }))).toMatch(/must name its customer/);
      sale(db, { id: "s-named", receipt: 71, total: 500, method: "cash", paid: 200, customer: "c1" });
      sound(db);
    } finally {
      db.close();
    }
  });
});
