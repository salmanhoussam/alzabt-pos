import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/persistence/db";
import { type NewSaleHeader, SaleRepository, singleTenderFor } from "../../src/persistence/saleRepository";
import { type Harness, type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * P2 · SELL-WHISH-REFERENCE-AND-CONFIRMATION (owner, 2026-11-07).
 *
 * A till sale paid by Whish Money is recorded ONLY with the reference the operator typed and their
 * explicit "the money arrived". It is written with ONE `external` tender (provider whish, the reference,
 * funds_confirmed = 1) in the same transaction as the sale; migration 19's registry refuses the same
 * reference anywhere in the ledger, and a refusal leaves NOTHING behind. Cash and customer debt are
 * unchanged. Bank transfer is out of scope. Offline: nothing here contacts Whish.
 */

let t: TempDir;
let h: Harness;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

const espresso = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };
const whishSale = (reference: unknown, extra: Record<string, unknown> = {}, key = newKey()) =>
  h.service.createSale({ idempotencyKey: key, paymentMethod: "external", whish: { reference, fundsConfirmed: true }, ...espresso, ...extra } as never);
const tenders = (db: Db, saleId: string) =>
  db.prepare("SELECT seq, method, provider, reference, funds_confirmed AS fc, amount_minor AS amt FROM sale_tenders WHERE sale_id = ? ORDER BY seq").all(saleId) as Record<string, unknown>[];
const n = (db: Db, sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: bigint }).n);
const allTenders = (db: Db) => n(db, "SELECT count(*) AS n FROM sale_tenders");
const liveRefs = (db: Db) => n(db, "SELECT count(*) AS n FROM external_references WHERE legacy = 0");
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "NO ERROR";
};
/** Everything a refused sale could have left behind. */
const footprint = (db: Db) => ({ ...countRows(db), tenders: allTenders(db), refs: liveRefs(db) });

describe("a Whish Money sale is recorded with its evidence", () => {
  it("ONE external tender: provider whish, the typed reference, funds confirmed, amount = paid; registered once", () => {
    const { sale, duplicate } = whishSale("  WH-2026/11 #55 ");
    expect(duplicate).toBe(false);
    expect(sale.paymentMethod).toBe("external");
    expect(sale.paymentStatus).toBe("paid");
    expect(sale.externalPayment).toEqual({ provider: "whish", reference: "WH-2026/11 #55" });
    expect(tenders(h.db, sale.id)).toEqual([{ seq: 1n, method: "external", provider: "whish", reference: "WH-2026/11 #55", fc: 1n, amt: 500n }]);
    expect(n(h.db, "SELECT tender_count AS n FROM sales WHERE id = ?", sale.id)).toBe(1);
    const reg = h.db.prepare("SELECT provider, ref_key, ref_display, owner_kind, owner_id, legacy FROM external_references").all();
    expect(reg).toEqual([{ provider: "whish", ref_key: "WH202611#55", ref_display: "WH-2026/11 #55", owner_kind: "sale_tender", owner_id: `${sale.id}#1`, legacy: 0n }]);
    // read back the same way every screen reads it
    expect(h.service.getSaleHistory(5)[0]?.sale.externalPayment).toEqual({ provider: "whish", reference: "WH-2026/11 #55" });
  });

  it("an Arabic reference is kept as typed (D-REF-1 = B)", () => {
    const { sale } = whishSale("مرجع ٧٧");
    expect(sale.externalPayment?.reference).toBe("مرجع ٧٧");
  });

  it("singleTenderFor: external WITH confirmed Whish evidence → one external tender; without → none", () => {
    const base = { sourceType: "pos" as const, paymentMethod: "external" as const, paidMinor: 9n };
    expect(singleTenderFor({ ...base, externalPayment: { provider: "whish", reference: "R1", fundsConfirmed: true } })).toEqual({
      method: "external",
      amountMinor: 9n,
      provider: "whish",
      reference: "R1",
    });
    expect(singleTenderFor(base)).toBeNull();
    expect(singleTenderFor({ ...base, externalPayment: null })).toBeNull();
    // TRANSITION (INV-PAY-METHOD): an invoice paid by Whish WITH its evidence now gets its external tender.
    // Old value: toBeNull(). Without the evidence it still gets none (asserted just below for any source).
    expect(singleTenderFor({ ...base, sourceType: "invoice", externalPayment: { provider: "whish", reference: "R1", fundsConfirmed: true } })).toEqual(
      expect.objectContaining({ method: "external", provider: "whish", reference: "R1" }),
    );
    expect(singleTenderFor({ ...base, sourceType: "invoice", externalPayment: null })).toBeNull();
  });
});

describe("🔴 refused — and a refusal leaves nothing behind", () => {
  it("no reference, a blank one, or no evidence at all", () => {
    const before = footprint(h.db);
    expect(codeOf(() => whishSale(""))).toBe("INVALID_INPUT");
    expect(codeOf(() => whishSale("   "))).toBe("INVALID_INPUT");
    expect(codeOf(() => whishSale(null))).toBe("INVALID_INPUT");
    expect(codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "external", ...espresso }))).toBe("INVALID_INPUT");
    expect(footprint(h.db)).toEqual(before);
  });

  it("the money not confirmed (false, missing, or 'true' as text)", () => {
    const before = footprint(h.db);
    for (const fundsConfirmed of [false, undefined, "true", 1]) {
      expect(
        codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "external", whish: { reference: "WH-NC-1", fundsConfirmed }, ...espresso } as never)),
      ).toBe("FUNDS_NOT_CONFIRMED");
    }
    expect(footprint(h.db)).toEqual(before);
  });

  it("a reference that is not a reference: too long, a newline, or a card number", () => {
    const before = footprint(h.db);
    expect(codeOf(() => whishSale("W".repeat(65)))).toBe("INVALID_INPUT");
    expect(codeOf(() => whishSale("WH-1\nWH-2"))).toBe("INVALID_INPUT");
    expect(codeOf(() => whishSale("4111 1111 1111 1111"))).toBe("INVALID_INPUT");
    expect(footprint(h.db)).toEqual(before);
  });

  it("Whish evidence on a cash / card / other sale is refused, never silently dropped", () => {
    const before = footprint(h.db);
    for (const paymentMethod of ["cash", "card", "other"] as const) {
      expect(
        codeOf(() => h.service.createSale({ idempotencyKey: newKey(), paymentMethod, whish: { reference: "WH-X", fundsConfirmed: true }, ...espresso } as never)),
      ).toBe("INVALID_INPUT");
    }
    expect(footprint(h.db)).toEqual(before);
  });
});

describe("🔴 one Whish reference, once — anywhere in the ledger", () => {
  it("a second sale with the same reference — or the same one written differently — is refused, nothing written", () => {
    whishSale("WH-123");
    const before = footprint(h.db);
    // D-REF-1 = B: digits, case, spaces and separators are normalised; Arabic-Indic digits too
    for (const again of ["WH-123", "wh 123", "WH123", "wh_1/2.3", "WH-١٢٣"]) {
      expect(codeOf(() => whishSale(again)), again).toBe("DUPLICATE_PAYMENT_REFERENCE");
    }
    expect(footprint(h.db)).toEqual(before);
    // a genuinely different reference still sells
    expect(whishSale("WH-124").sale.externalPayment?.reference).toBe("WH-124");
  });

  it("a reference already used to COLLECT a customer's debt cannot pay a sale (and nothing is written)", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون ويش" }).party;
    const ob = h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "DEBT-1", currency: "USD", amountMinor: 1000n }).record;
    h.ledger.settle({ obligationId: ob.id, partyId: c.id, idempotencyKey: "p2-collect-0001", amountMinor: 400n, method: "external", channel: "whish", reference: "WH-COL-9", fundsConfirmed: true });
    const before = footprint(h.db);
    expect(codeOf(() => whishSale("wh col 9"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(footprint(h.db)).toEqual(before);
  });

  it("a reference already used to PAY A SALE cannot be collected again on a debt (same sentence, nothing written)", () => {
    whishSale("WH-SALE-5");
    const c = h.parties.create({ kind: "customer", displayName: "زبون دين" }).party;
    const ob = h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "DEBT-2", currency: "USD", amountMinor: 1000n }).record;
    const settledBefore = n(h.db, "SELECT count(*) AS n FROM settlements");
    expect(
      codeOf(() =>
        h.ledger.settle({ obligationId: ob.id, partyId: c.id, idempotencyKey: "p2-collect-0002", amountMinor: 400n, method: "external", channel: "whish", reference: "WH-SALE-5", fundsConfirmed: true }),
      ),
    ).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(n(h.db, "SELECT count(*) AS n FROM settlements")).toBe(settledBefore);
    expect(h.ledger.statementFor(c.id).obligations[0]?.outstandingMinor).toBe(1000n);
  });

  it("two COLLECTIONS with the same reference written differently: the owner reads the duplicate sentence, not the database's", () => {
    // Found while building P2: before it, the collection pre-check compared the reference byte for byte,
    // so «wh 7» after «WH-7» reached migration 19's trigger and surfaced as a raw SQLITE_CONSTRAINT_TRIGGER.
    const c = h.parties.create({ kind: "customer", displayName: "زبون تحصيل" }).party;
    const ob = h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "DEBT-3", currency: "USD", amountMinor: 1000n }).record;
    const pay = (key: string, reference: string) =>
      h.ledger.settle({ obligationId: ob.id, partyId: c.id, idempotencyKey: key, amountMinor: 100n, method: "external", channel: "whish", reference, fundsConfirmed: true });
    pay("p2-collect-0003", "WH-7");
    const settledBefore = n(h.db, "SELECT count(*) AS n FROM settlements");
    expect(codeOf(() => pay("p2-collect-0004", "wh 7"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(n(h.db, "SELECT count(*) AS n FROM settlements")).toBe(settledBefore);
  });

  it("a historic (legacy) reference from before migration 19 is reserved too", () => {
    h.db
      .prepare("INSERT INTO external_references (provider, ref_key, ref_display, owner_kind, owner_id, legacy, registered_at) VALUES ('whish', 'OLD77', 'OLD-77', 'receipt', 'r-old', 1, 't')")
      .run();
    const before = footprint(h.db);
    expect(codeOf(() => whishSale("old 77"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(footprint(h.db)).toEqual(before);
  });

  it("a customer-linked Whish sale with a taken reference is refused inside its own transaction too", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون مرتبط" }).party;
    whishSale("WH-LINK-1");
    const before = footprint(h.db);
    expect(codeOf(() => whishSale("WH-LINK-1", { customerId: c.id }))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(footprint(h.db)).toEqual(before);
  });
});

describe("no double recording, no partial write", () => {
  it("🔴 a replayed request (double click, retry) returns the first sale: one sale, one tender, one registration", () => {
    const key = newKey();
    const first = whishSale("WH-DBL-1", {}, key);
    const again = whishSale("WH-DBL-1", {}, key);
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    expect(countRows(h.db).sales).toBe(1);
    expect(allTenders(h.db)).toBe(1);
    expect(liveRefs(h.db)).toBe(1);
  });

  it("🔴 the same key with ANOTHER reference is a different payment: IDEMPOTENCY_CONFLICT, nothing written", () => {
    const key = newKey();
    whishSale("WH-K-1", {}, key);
    const before = footprint(h.db);
    expect(codeOf(() => whishSale("WH-K-2", {}, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint(h.db)).toEqual(before);
  });

  it("🔴 a fault after the tender rolls back the sale, the tender AND the reference registration — the reference stays free", () => {
    class FailAfterTender extends SaleRepository {
      protected override insertSaleHeader(_h: NewSaleHeader, _r: number, _l: number, _t = 0): void {
        throw new Error("injected after the tender, before the sale header");
      }
    }
    h.db.close();
    h = makeHarness(t.dbPath, { repository: (db) => new FailAfterTender(db) });
    const before = footprint(h.db);
    expect(() => whishSale("WH-RB-1")).toThrow(/injected/);
    expect(footprint(h.db)).toEqual(before);
    h.db.close();
    h = makeHarness(t.dbPath);
    expect(whishSale("WH-RB-1").sale.externalPayment?.reference).toBe("WH-RB-1");
  });

  it("the ledger itself refuses an external tender without its evidence, even written by hand", () => {
    const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
    expect(() =>
      h.db.prepare("INSERT INTO sale_tenders (sale_id, seq, method, provider, reference, funds_confirmed, amount_minor) VALUES (?, 2, 'external', 'whish', NULL, 1, 1)").run(sale.id),
    ).toThrow();
  });
});

describe("cash and customer debt are unchanged; a Whish sale creates no debt", () => {
  it("cash still records ONE cash tender with no reference and nothing registered", () => {
    const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
    expect(tenders(h.db, sale.id)).toEqual([{ seq: 1n, method: "cash", provider: null, reference: null, fc: null, amt: 500n }]);
    expect(sale.externalPayment).toBeNull();
    expect(liveRefs(h.db)).toBe(0);
  });

  it("a customer-linked Whish sale is PAID: no obligation, the customer's balance does not move", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون مدفوع" }).party;
    const before = h.ledger.statementFor(c.id).obligations.length;
    const { sale } = whishSale("WH-PAID-1", { customerId: c.id });
    expect(sale.customerId).toBe(c.id);
    expect(h.ledger.statementFor(c.id).obligations.length).toBe(before);
    expect(n(h.db, "SELECT count(*) AS n FROM obligations WHERE sale_id = ?", sale.id)).toBe(0);
  });

  it("a credit sale still posts its debt with NO tender, and that debt can be collected by cash then by Whish", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون آجل" }).party;
    const r = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c.id, ...espresso });
    expect(tenders(h.db, r.sale.id)).toEqual([]);
    const ob = h.ledger.statementFor(c.id).obligations.find((o) => o.obligation.saleId === r.sale.id);
    expect(ob?.outstandingMinor).toBe(500n);
    h.ledger.settle({ obligationId: ob!.obligation.id, partyId: c.id, idempotencyKey: "p2-credit-cash-01", amountMinor: 200n, method: "cash" });
    h.ledger.settle({ obligationId: ob!.obligation.id, partyId: c.id, idempotencyKey: "p2-credit-whish-1", amountMinor: 300n, method: "external", channel: "whish", reference: "WH-DEBT-1", fundsConfirmed: true });
    const after = h.ledger.statementFor(c.id).obligations.find((o) => o.obligation.id === ob!.obligation.id);
    expect(after?.outstandingMinor).toBe(0n);
    // and that Whish collection's reference now blocks a sale
    expect(codeOf(() => whishSale("WH-DEBT-1"))).toBe("DUPLICATE_PAYMENT_REFERENCE");
  });

  it("Σ tenders = paid on every sale; every external tender has evidence; integrity holds", () => {
    h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
    whishSale("WH-SUM-1");
    whishSale("WH-SUM-2");
    // TRANSITION (P3, DEC-35): new payments are cash or Whish only; old method here: "card".
    h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...espresso });
    expect(
      n(
        h.db,
        `SELECT count(*) AS n FROM sales s WHERE s.tender_count > 0 AND (s.tender_count <> (SELECT count(*) FROM sale_tenders t WHERE t.sale_id = s.id)
           OR s.paid_minor <> (SELECT coalesce(sum(amount_minor),0) FROM sale_tenders t WHERE t.sale_id = s.id))`,
      ),
    ).toBe(0);
    expect(n(h.db, "SELECT count(*) AS n FROM sale_tenders WHERE method = 'external' AND (provider IS NULL OR reference IS NULL OR funds_confirmed IS NOT 1)")).toBe(0);
    expect(n(h.db, "SELECT count(*) AS n FROM sales WHERE payment_method = 'external' AND tender_count = 0")).toBe(0);
    expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });
});
