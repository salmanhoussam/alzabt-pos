import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { LedgerRepository } from "../../src/persistence/ledgerRepository";
import type { NewObligation } from "../../src/persistence/ledgerRepository";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * SELL-PARTIAL-DEBT (owner, 2026-11-08) — part of a sale received NOW, the rest a debt on the customer.
 *
 * The rules this file holds the SERVICE to (the bridge and the till are covered elsewhere):
 *  - OWNER ONLY (live role), an ACTIVE customer, ONE accepted method for the part received: cash, or
 *    Whish Money with its reference and an explicit confirmation; a reused reference is refused.
 *  - 0 < received < total. The received part is ONE tender (a payment, never a debt); the rest is ONE
 *    receivable for exactly that amount (a debt, never a payment) — sale, lines, tender and receivable
 *    in ONE transaction, or nothing at all.
 *  - The same key replays the same sale; the same key with other money received is a conflict.
 *  - Without a down payment, nothing changes (creditSale.test.ts keeps proving that, unchanged).
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
const reset = (opts: Parameters<typeof makeHarness>[1] = {}) => {
  if (h.db.open) h.db.close();
  t.cleanup();
  t = tempDir();
  h = makeHarness(t.dbPath, opts);
};

const ESPRESSO_X2 = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("expected a DomainError");
}
const n = (table: string) => Number((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
const footprint = () => ({
  sales: n("sales"),
  lines: n("sale_lines"),
  tenders: n("sale_tenders"),
  obligations: n("obligations"),
  settlements: n("settlements"),
  references: n("external_references"),
});
const NOTHING = { sales: 0, lines: 0, tenders: 0, obligations: 0, settlements: 0, references: 0 };

function customer(name = "زبون الدفع الجزئي", active = true): string {
  const id = `party-${newKey()}`;
  h.partyStore.insert({ id, kind: "customer", displayName: name, phone: null, address: null, note: null, createdBy: "cashier-01", now: h.clock.now().toISOString() });
  if (!active) h.partyStore.update(id, { isActive: false }, h.clock.now().toISOString());
  return id;
}
type Down = NonNullable<Parameters<typeof h.service.createCustomerCreditSale>[0]["downPayment"]>;
const cash = (minor: bigint): Down => ({ amountMinor: minor, method: "cash" });
const whish = (minor: bigint, reference = `WH-${newKey().slice(0, 8)}`, fundsConfirmed: unknown = true): Down => ({
  amountMinor: minor,
  method: "external",
  whish: { reference, fundsConfirmed },
});
const partialSale = (customerId: string, downPayment: Down | null, key = newKey(), terms = ESPRESSO_X2) =>
  h.service.createCustomerCreditSale({ idempotencyKey: key, customerId, ...terms, downPayment });

describe("the owner takes part now, the rest is a debt", () => {
  it("cash: one PARTIAL sale, one cash tender for what was received, one receivable for exactly the rest", () => {
    const c = customer();
    const r = partialSale(c, cash(200n));
    expect(r.duplicate).toBe(false);
    expect(r.sale.paymentStatus).toBe("partial");
    expect(r.sale.paymentMethod).toBe("cash");
    expect(r.sale.total.minor).toBe(500n);
    expect(r.sale.paid.minor).toBe(200n);
    expect(r.sale.balanceDue.minor).toBe(300n);
    expect(r.sale.customerId).toBe(c);
    expect(footprint()).toEqual({ sales: 1, lines: 1, tenders: 1, obligations: 1, settlements: 0, references: 0 });
    const tender = h.db.prepare("SELECT method, amount_minor AS a, reference FROM sale_tenders").get() as Record<string, unknown>;
    expect({ ...tender, a: Number(tender.a) }).toEqual({ method: "cash", a: 200, reference: null });
    // 🔴 The debt is the unpaid part — never the total, never the part received.
    expect(r.obligation.amountMinor).toBe(300n);
    expect(r.obligation.partyId).toBe(c);
    expect(r.obligation.direction).toBe("receivable");
    expect(r.obligation.sourceRef).toBe(r.sale.id);
  });

  it("Whish Money: the tender carries the reference, and the reference is registered for good", () => {
    const c = customer();
    const r = partialSale(c, whish(150n, "WH-PARTIAL-1"));
    expect(r.sale.paymentStatus).toBe("partial");
    expect(r.sale.paymentMethod).toBe("external");
    expect(r.sale.externalPayment).toEqual(expect.objectContaining({ provider: "whish", reference: "WH-PARTIAL-1" }));
    expect(r.obligation.amountMinor).toBe(350n);
    const tender = h.db.prepare("SELECT method, provider, reference, funds_confirmed AS f, amount_minor AS a FROM sale_tenders").get() as Record<string, unknown>;
    expect({ ...tender, f: Number(tender.f), a: Number(tender.a) }).toEqual({ method: "external", provider: "whish", reference: "WH-PARTIAL-1", f: 1, a: 150 });
    expect(footprint().references).toBe(1);
  });

  it("the received part plus the debt is the total — the ledger's arithmetic holds", () => {
    const c = customer();
    partialSale(c, cash(1n));
    partialSale(c, cash(499n));
    const bad = h.db
      .prepare(
        `SELECT count(*) AS n FROM sales s JOIN obligations o ON o.source_ref = s.id
          WHERE s.paid_minor + o.amount_minor <> s.total_minor OR s.balance_due_minor <> o.amount_minor
             OR s.paid_minor <> (SELECT sum(amount_minor) FROM sale_tenders t WHERE t.sale_id = s.id)`,
      )
      .get() as { n: bigint };
    expect(Number(bad.n)).toBe(0);
    expect(footprint()).toMatchObject({ sales: 2, tenders: 2, obligations: 2 });
  });
});

describe("🔴 refused — and a refusal writes nothing", () => {
  it("amounts: zero, negative, equal to the total, more than the total", () => {
    const c = customer();
    expect(codeOf(() => partialSale(c, cash(0n)))).toBe("DOWN_PAYMENT_INVALID");
    expect(codeOf(() => partialSale(c, cash(-100n)))).toBe("DOWN_PAYMENT_INVALID");
    expect(codeOf(() => partialSale(c, cash(500n)))).toBe("DOWN_PAYMENT_NOT_PARTIAL");
    expect(codeOf(() => partialSale(c, cash(501n)))).toBe("DOWN_PAYMENT_NOT_PARTIAL");
    expect(codeOf(() => partialSale(c, { amountMinor: 200 as unknown as bigint, method: "cash" }))).toBe("DOWN_PAYMENT_INVALID");
    expect(footprint()).toEqual(NOTHING);
  });

  it("methods: card, other and bank are not money this shop takes now (P3)", () => {
    const c = customer();
    for (const method of ["card", "other", "bank"]) {
      expect(codeOf(() => partialSale(c, { amountMinor: 200n, method } as unknown as Down))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    }
    expect(footprint()).toEqual(NOTHING);
  });

  it("Whish without a reference, without the confirmation, or a cash down payment carrying a reference", () => {
    const c = customer();
    expect(codeOf(() => partialSale(c, { amountMinor: 200n, method: "external" }))).toBe("INVALID_INPUT");
    expect(codeOf(() => partialSale(c, whish(200n, "   ")))).toBe("INVALID_INPUT");
    expect(codeOf(() => partialSale(c, whish(200n, "WH-NC-1", false)))).toBe("FUNDS_NOT_CONFIRMED");
    expect(codeOf(() => partialSale(c, whish(200n, "WH-NC-2", "yes")))).toBe("FUNDS_NOT_CONFIRMED");
    expect(codeOf(() => partialSale(c, { amountMinor: 200n, method: "cash", whish: { reference: "WH-X", fundsConfirmed: true } }))).toBe("INVALID_INPUT");
    expect(footprint()).toEqual(NOTHING);
  });

  it("🔴 a Whish reference already used — by a paid sale or by another partial sale — rolls back EVERYTHING", () => {
    const c = customer();
    const paid = h.service.createSale({
      idempotencyKey: newKey(),
      ...ESPRESSO_X2,
      paymentMethod: "external",
      whish: { reference: "WH-TAKEN-1", fundsConfirmed: true },
    });
    expect(paid.duplicate).toBe(false);
    partialSale(c, whish(100n, "WH-TAKEN-2"));
    const before = footprint();
    expect(codeOf(() => partialSale(c, whish(200n, "WH-TAKEN-1")))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(codeOf(() => partialSale(c, whish(200n, "WH-TAKEN-2")))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(footprint()).toEqual(before);
  });

  it("a cashier: refused by the service; an owner demoted in the durable row: refused at once", () => {
    const c = customer();
    h.service.login("cashier-02", "2222");
    expect(codeOf(() => partialSale(c, cash(200n)))).toBe("NOT_AUTHORIZED");
    reset();
    const c2 = customer();
    h.db.prepare("UPDATE operators SET role = 'cashier' WHERE id = 'cashier-01'").run();
    expect(codeOf(() => partialSale(c2, cash(200n)))).toBe("NOT_AUTHORIZED");
    expect(footprint()).toEqual(NOTHING);
  });

  it("an archived customer, an unknown id → PARTY_NOT_FOUND", () => {
    const archived = customer("زبون مؤرشف", false);
    expect(codeOf(() => partialSale(archived, cash(200n)))).toBe("PARTY_NOT_FOUND");
    expect(codeOf(() => partialSale("no-such-customer", cash(200n)))).toBe("PARTY_NOT_FOUND");
    expect(footprint()).toEqual(NOTHING);
  });

  it("a displayed total that no longer matches today's prices → TOTAL_MISMATCH", () => {
    const c = customer();
    expect(codeOf(() => partialSale(c, cash(200n), newKey(), { ...ESPRESSO_X2, expectedTotalMinor: 499n }))).toBe("TOTAL_MISMATCH");
    expect(footprint()).toEqual(NOTHING);
  });

  it("a partial sale carries a debt, so it cannot be voided (inherits SELL-CREDIT's refusal)", () => {
    const c = customer();
    const r = partialSale(c, cash(200n));
    expect(codeOf(() => h.service.voidSale(r.sale.id, "الزبون غيّر رأيه"))).toBe("NOT_AVAILABLE");
    expect(h.repository.getVoid(r.sale.id)).toBeUndefined();
  });
});

describe("🔴 idempotency — a double click or a lost reply never doubles anything", () => {
  it("the same key with the same money received replays the SAME sale, tender and debt", () => {
    const c = customer();
    const key = newKey();
    const first = partialSale(c, whish(200n, "WH-REPLAY-1"), key);
    const again = partialSale(c, whish(200n, "WH-REPLAY-1"), key);
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    expect(again.obligation.id).toBe(first.obligation.id);
    expect(footprint()).toEqual({ sales: 1, lines: 1, tenders: 1, obligations: 1, settlements: 0, references: 1 });
  });

  it("the same key with OTHER money received is a conflict, never a second sale", () => {
    const c = customer();
    const key = newKey();
    partialSale(c, cash(200n), key);
    const before = footprint();
    expect(codeOf(() => partialSale(c, cash(250n), key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => partialSale(c, whish(200n, "WH-OTHER"), key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => partialSale(c, null, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toEqual(before);
  });

  it("a Whish key replayed with another reference is a conflict; a fully-unpaid key replayed WITH a down payment too", () => {
    const c = customer();
    const k1 = newKey();
    partialSale(c, whish(200n, "WH-K1"), k1);
    expect(codeOf(() => partialSale(c, whish(200n, "WH-K1-OTHER"), k1))).toBe("IDEMPOTENCY_CONFLICT");
    const k2 = newKey();
    partialSale(c, null, k2);
    expect(codeOf(() => partialSale(c, cash(100n), k2))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toMatchObject({ sales: 2, tenders: 1, obligations: 2 });
  });
});

class FailingObligationRepository extends LedgerRepository {
  override insertObligation(obligation: NewObligation): void {
    super.insertObligation(obligation);
    throw new Error("injected after obligation insertion");
  }
}

describe("🔴 atomic — sale, lines, tender, reference and debt together or not at all", () => {
  it("a failure after the receivable was written rolls back the sale, its tender and the Whish reference", () => {
    reset({ ledgerRepository: (db) => new FailingObligationRepository(db) });
    const c = customer();
    expect(() => partialSale(c, whish(200n, "WH-ROLLBACK-1"))).toThrow();
    expect(footprint()).toEqual(NOTHING);
    // The reference was never kept: it is still free to be used once the sale is really recorded.
    reset();
    const c2 = customer();
    expect(partialSale(c2, whish(200n, "WH-ROLLBACK-1")).duplicate).toBe(false);
  });

  it("a failure just before COMMIT leaves nothing — then the same key records it once", () => {
    let calls = 0;
    reset({
      serviceTransact: (db, fn) =>
        db.transaction(() => {
          const result = fn();
          calls += 1;
          if (calls === 2) throw new Error("injected immediately before WRITE transaction COMMIT");
          return result;
        }).immediate(),
    });
    const c = customer();
    const key = newKey();
    expect(() => partialSale(c, cash(200n), key)).toThrow();
    expect(footprint()).toEqual(NOTHING);
  });

  it("a reply lost after COMMIT is recovered as the SAME sale and debt (no second write)", () => {
    let lose = false;
    let calls = 0;
    reset({
      serviceTransact: (db, fn) => {
        const result = db.transaction(fn).immediate();
        calls += 1;
        if (lose && calls === 2) {
          lose = false;
          throw new Error("injected lost response after COMMIT");
        }
        return result;
      },
    });
    const c = customer();
    const key = newKey();
    lose = true;
    const r = partialSale(c, cash(200n), key);
    expect(r.duplicate).toBe(true);
    expect(r.sale.paid.minor).toBe(200n);
    expect(r.obligation.amountMinor).toBe(300n);
    expect(footprint()).toEqual({ sales: 1, lines: 1, tenders: 1, obligations: 1, settlements: 0, references: 0 });
  });
});
