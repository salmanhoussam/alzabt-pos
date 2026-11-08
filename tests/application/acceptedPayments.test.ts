import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCEPTED_COLLECTION_CHANNELS, ACCEPTED_SALE_METHODS } from "../../src/domain/acceptedPayments";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * P3 · ONLY THE APPROVED METHODS FOR NEW MONEY (owner decision DEC-35, 2026-11-07).
 *
 * New sales and new collections are Cash or Whish Money; On account is a debt, never a payment. Card,
 * Other and bank transfer are REFUSED for new money AT THE SERVICE — hiding a button is not the guard —
 * on every write path (createSale, recordCustomerPayment / collect, recordAllocatedReceipt, settle), and a
 * refusal writes NOTHING (no sale, settlement, receipt, nor collection / receipt attempt).
 *
 * History is untouched: rows an earlier build wrote keep their own method, read the same everywhere, and a
 * replay of a historic request under its own idempotency key — or the continuation of an attempt that was
 * already open — answers exactly as before. Historic rows are seeded through `build: "pre-dec35"`
 * (tests/helpers/preDec35.ts), the stand-in for the older build that wrote them.
 */

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
const open = (build?: "pre-dec35") => {
  h = makeHarness(t.dbPath, build ? { build } : {});
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
};
const reopen = (build?: "pre-dec35") => {
  h.db.close();
  open(build);
};
beforeEach(() => {
  t = tempDir();
  open();
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

const espresso = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };
const n = (table: string) => Number((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
const footprint = () => ({
  sales: n("sales"),
  tenders: n("sale_tenders"),
  settlements: n("settlements"),
  receipts: n("receipts"),
  collectionAttempts: n("collection_attempts"),
  receiptAttempts: n("receipt_attempts"),
  refs: n("external_references"),
});
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "OK" : r.error!.code);
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "OK";
};
const customer = () => h.parties.create({ kind: "customer", displayName: "زبون P3" }).party;
const owe = (partyId: string, ref: string, minor = 10000n) =>
  h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
const collect = (c: { id: string }, o: { id: string }, key: string, method: string, extra: Record<string, unknown> = {}) =>
  ipc.recordCustomerPayment({ customerId: c.id, obligationId: o.id, idempotencyKey: key, amountMinor: "100", method, ...extra } as never);
const shared = (c: { id: string }, a: { id: string }, b: { id: string }, key: string, channel: string, reference: string) =>
  ipc.recordAllocatedReceipt({
    customerId: c.id,
    idempotencyKey: key,
    channel,
    reference,
    fundsConfirmed: true,
    currency: "USD",
    totalMinor: "300",
    allocations: [
      { obligationId: a.id, amountMinor: "200" },
      { obligationId: b.id, amountMinor: "100" },
    ],
  } as never);

describe("the policy, as written", () => {
  it("new money: cash and Whish only — on account is a debt, never in these lists", () => {
    expect(ACCEPTED_SALE_METHODS).toEqual(["cash", "whish"]);
    expect(ACCEPTED_COLLECTION_CHANNELS).toEqual(["cash", "whish"]);
  });
});

describe("🔴 refused at the SERVICE for new money — and a refusal writes nothing", () => {
  it("a new card / other sale, through the service AND through the bridge", () => {
    const before = footprint();
    for (const paymentMethod of ["card", "other"] as const) {
      expect(codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod, ...espresso }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
      expect(code(ipc.createSale({ idempotencyKey: newKey(), lines: espresso.lines, paymentMethod, expectedTotalMinor: "500" } as never))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    }
    expect(footprint()).toEqual(before);
  });

  it("a new card / bank-transfer / other collection on one debt — no settlement and NO attempt is written", () => {
    const c = customer();
    const o = owe(c.id, "P3-A");
    const before = footprint();
    expect(code(collect(c, o, "p3-col-card-0001", "card"))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(code(collect(c, o, "p3-col-bank-0001", "bank_transfer", { reference: "BT-9", fundsConfirmed: true }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(code(collect(c, o, "p3-col-othr-0001", "other", { reference: "OT-9", fundsConfirmed: true }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(footprint()).toEqual(before);
    // and the same customer can still pay in cash or Whish straight after — nothing was left open
    expect(code(collect(c, o, "p3-col-cash-0001", "cash"))).toBe("OK");
    expect(code(collect(c, o, "p3-col-wish-0001", "whish", { reference: "WH-P3-1", fundsConfirmed: true }))).toBe("OK");
  });

  it("a new bank-transfer receipt shared across debts — no receipt and NO attempt; Whish still works", () => {
    const c = customer();
    const a = owe(c.id, "P3-B1");
    const b = owe(c.id, "P3-B2");
    const before = footprint();
    expect(code(shared(c, a, b, "p3-rcpt-bank-001", "bank_transfer", "BT-SHARED-1"))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(footprint()).toEqual(before);
    expect(code(shared(c, a, b, "p3-rcpt-wish-001", "whish", "WH-SHARED-1"))).toBe("OK");
  });

  it("the internal settle() path too — card, other and a provider-less external are refused", () => {
    const c = customer();
    const o = owe(c.id, "P3-C");
    const before = footprint();
    for (const method of ["card", "other", "external"] as const) {
      expect(codeOf(() => h.ledger.settle({ obligationId: o.id, partyId: c.id, idempotencyKey: `p3-settle-${method}-1`, amountMinor: 100n, method }))).toBe(
        "PAYMENT_METHOD_NOT_ACCEPTED",
      );
    }
    expect(codeOf(() => h.ledger.settle({ obligationId: o.id, partyId: c.id, idempotencyKey: "p3-settle-bank-01", amountMinor: 100n, method: "external", channel: "bank_transfer", reference: "BT-S", fundsConfirmed: true }))).toBe(
      "PAYMENT_METHOD_NOT_ACCEPTED",
    );
    expect(footprint()).toEqual(before);
    expect(codeOf(() => h.ledger.settle({ obligationId: o.id, partyId: c.id, idempotencyKey: "p3-settle-cash-01", amountMinor: 100n, method: "cash" }))).toBe("OK");
  });

  it("cash and Whish are accepted on every path (sale, single collection, shared receipt)", () => {
    expect(h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso }).duplicate).toBe(false);
    expect(h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "external", whish: { reference: "WH-P3-S", fundsConfirmed: true }, ...espresso }).duplicate).toBe(false);
    const c = customer();
    const o = owe(c.id, "P3-D");
    expect(code(collect(c, o, "p3-ok-cash-00001", "cash"))).toBe("OK");
    expect(code(collect(c, o, "p3-ok-wish-00001", "whish", { reference: "WH-P3-D", fundsConfirmed: true }))).toBe("OK");
  });
});

describe("🔴 history is untouched — rows from an earlier build read and replay exactly as before", () => {
  it("a historic CARD sale replays under its own key (same sale, nothing new) and reads as card", () => {
    reopen("pre-dec35");
    const key = newKey();
    const first = h.service.createSale({ idempotencyKey: key, paymentMethod: "card", ...espresso });
    reopen(); // today's build
    const before = footprint();
    const again = h.service.createSale({ idempotencyKey: key, paymentMethod: "card", ...espresso });
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    expect(footprint()).toEqual(before);
    expect(h.service.getSaleHistory(5).map((r) => r.sale.paymentMethod)).toEqual(["card"]);
    // …while a NEW card sale is refused
    expect(codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "card", ...espresso }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
  });

  it("historic card / bank / other COLLECTIONS replay under their keys and keep their channels on the statement", () => {
    reopen("pre-dec35");
    const c = customer();
    const o = owe(c.id, "P3-H");
    expect(code(collect(c, o, "p3-hist-card-001", "card"))).toBe("OK");
    expect(code(collect(c, o, "p3-hist-bank-001", "bank_transfer", { reference: "BT-HIST", fundsConfirmed: true }))).toBe("OK");
    expect(code(collect(c, o, "p3-hist-othr-001", "other", { reference: "OT-HIST", fundsConfirmed: true }))).toBe("OK");
    reopen();
    const before = footprint();
    expect(code(collect(c, o, "p3-hist-card-001", "card"))).toBe("OK");
    expect(code(collect(c, o, "p3-hist-bank-001", "bank_transfer", { reference: "BT-HIST", fundsConfirmed: true }))).toBe("OK");
    expect(code(collect(c, o, "p3-hist-othr-001", "other", { reference: "OT-HIST", fundsConfirmed: true }))).toBe("OK");
    expect(footprint()).toEqual(before);
    const stored = h.db.prepare("SELECT method, provider, reference FROM settlements ORDER BY idempotency_key").all();
    expect(stored).toEqual([
      { method: "external", provider: "bank_transfer", reference: "BT-HIST" },
      { method: "card", provider: null, reference: null },
      { method: "other", provider: null, reference: "OT-HIST" },
    ]);
    expect(h.ledger.statementFor(c.id).obligations[0]?.outstandingMinor).toBe(10000n - 300n);
  });

  it("a historic bank-transfer RECEIPT replays under its key; its reference stays taken", () => {
    reopen("pre-dec35");
    const c = customer();
    const a = owe(c.id, "P3-R1");
    const b = owe(c.id, "P3-R2");
    expect(code(shared(c, a, b, "p3-hist-rcpt-001", "bank_transfer", "BT-RCPT-1"))).toBe("OK");
    reopen();
    const before = footprint();
    expect(code(shared(c, a, b, "p3-hist-rcpt-001", "bank_transfer", "BT-RCPT-1"))).toBe("OK");
    expect(footprint()).toEqual(before);
    expect(h.db.prepare("SELECT provider, reference FROM receipts").all()).toEqual([{ provider: "bank_transfer", reference: "BT-RCPT-1" }]);
  });

  it("an attempt for a card collection that was OPEN before the upgrade still completes under its original key", () => {
    reopen("pre-dec35");
    const c = customer();
    const o = owe(c.id, "P3-O");
    h.db.exec("CREATE TRIGGER test_settle_fault BEFORE INSERT ON settlements BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
    expect(code(collect(c, o, "p3-open-card-001", "card"))).not.toBe("OK");
    h.db.exec("DROP TRIGGER test_settle_fault");
    expect(n("collection_attempts")).toBe(1);
    expect(n("settlements")).toBe(0);
    reopen(); // today's build: the SAME request under its ORIGINAL key is a continuation, not new money
    expect(code(collect(c, o, "p3-open-card-001", "card"))).toBe("OK");
    expect(h.db.prepare("SELECT method FROM settlements").all()).toEqual([{ method: "card" }]);
    // a NEW key for card is still refused
    expect(code(collect(c, o, "p3-open-card-002", "card"))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
  });

  it("an upgraded v18 ledger: historic card / other / external sales read as they were; nothing re-classified", () => {
    h.db.close();
    const t2 = tempDir();
    try {
      const v18 = openDatabase(t2.dbPath, MIGRATIONS.slice(0, 18));
      const sale = v18.prepare(
        `INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type, cashier_id, cashier_name, currency,
           subtotal_minor, tax_minor, total_minor, paid_minor, balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at, created_at)
         VALUES (?, ?, ?, 'fp', 'pos', 'cashier-01', 'م', 'USD', 250, 0, 250, 250, 0, 'paid', ?, 1, '2026-11-01', 't', 't')`,
      );
      const line = v18.prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name, sale_unit, unit_label, quantity_milli, unit_price_minor, line_total_minor)
         VALUES (?, ?, 1, NULL, 'prod-0001', 'COF-ESP', 'Espresso', 'piece', 'قطعة', 1000, 250, 250)`,
      );
      ["card", "other", "external"].forEach((m, i) => {
        sale.run(`old-${m}`, i + 1, `old-${m}-key-0001`, m);
        line.run(`old-line-${m}`, `old-${m}`);
      });
      v18.close();
      h = makeHarness(t2.dbPath);
      const history = h.service.getSaleHistory(10).map((r) => [r.sale.id, r.sale.paymentMethod, r.sale.externalPayment ?? null]);
      expect(history.sort()).toEqual([
        ["old-card", "card", null],
        ["old-external", "external", null],
        ["old-other", "other", null],
      ]);
      expect(Number((h.db.prepare("SELECT count(*) AS n FROM sale_tenders").get() as { n: bigint }).n)).toBe(0);
      expect(codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "card", ...espresso }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
      expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
      h.db.close();
    } finally {
      t2.cleanup();
    }
  });
});

describe("🔴 the stand-in for an older build exists ONLY in tests", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("nothing in src/ subclasses the services or overrides the DEC-35 checks", () => {
    const offenders = walk("src")
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /extends\s+(PosService|LedgerService)\b|override\s+assertAcceptedNew|PreDec35/.test(code(readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("main.ts builds the PLAIN services", () => {
    const main = code(readFileSync("src/main/main.ts", "utf8"));
    expect(main).toMatch(/new PosService\(/);
    expect(main).toMatch(/new LedgerService\(/);
    expect(main).not.toMatch(/pre-dec35|PreDec35/);
  });
});
