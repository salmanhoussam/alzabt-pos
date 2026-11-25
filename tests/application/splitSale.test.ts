import { TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import type { NewSaleLine, SingleTender } from "../../src/persistence/saleRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { toSaleDto } from "../../src/shared/dto";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * SELL-SPLIT-CASH-WHISH (owner, 2026-11-09) — ONE sale paid IN FULL by cash AND Whish Money.
 *
 * What this file holds the SERVICE to:
 *  - cash + Whish = the trusted total EXACTLY, each part > 0, integer minor units: no debt is possible;
 *  - two tenders (seq 1 cash, seq 2 Whish with its reference) + the sale + its lines, in ONE
 *    transaction; `payment_method` NULL (migration 19); the Whish reference registered for good;
 *  - a reused reference, a missing reference, an unconfirmed transfer, Card / Other: refused, nothing written;
 *  - the same key replays; the same key with other amounts / reference / customer is a conflict;
 *  - the same permission as any paid sale (a cashier may), and NO change to any other sale's shape.
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
  references: n("external_references"),
});
const NOTHING = { sales: 0, lines: 0, tenders: 0, obligations: 0, references: 0 };

type Split = Parameters<typeof h.service.createSplitSale>[0];
const split = (over: Partial<Split> = {}, key = newKey()) =>
  h.service.createSplitSale({
    idempotencyKey: key,
    ...ESPRESSO_X2,
    cashMinor: 200n,
    whishMinor: 300n,
    whish: { reference: `WH-${newKey().slice(0, 8)}`, fundsConfirmed: true },
    ...over,
  });
function customer(name = "زبون الدفع المقسوم"): string {
  const id = `party-${newKey()}`;
  h.partyStore.insert({ id, kind: "customer", displayName: name, phone: null, address: null, note: null, createdBy: "cashier-01", now: h.clock.now().toISOString() });
  return id;
}

describe("one sale, paid in full by cash AND Whish Money", () => {
  it("2.00 cash + 3.00 Whish of 5.00: PAID, no single method, two tenders in order, NO debt", () => {
    const r = split({ whish: { reference: "WH-SPLIT-1", fundsConfirmed: true } });
    expect(r.duplicate).toBe(false);
    expect(r.sale.paymentStatus).toBe("paid");
    expect(r.sale.paymentMethod).toBeNull();
    expect(r.sale.paid.minor).toBe(500n);
    expect(r.sale.balanceDue.minor).toBe(0n);
    expect(r.sale.externalPayment ?? null).toBeNull();
    expect(r.sale.tenders?.map((x) => [x.seq, x.method, x.amount.minor, x.provider, x.reference])).toEqual([
      [1, "cash", 200n, null, null],
      [2, "external", 300n, "whish", "WH-SPLIT-1"],
    ]);
    expect(footprint()).toEqual({ sales: 1, lines: 1, tenders: 2, obligations: 0, references: 1 });
    const row = h.db.prepare("SELECT tender_count AS tc, payment_method AS m FROM sales").get() as { tc: bigint; m: string | null };
    expect({ tc: Number(row.tc), m: row.m }).toEqual({ tc: 2, m: null });
    const ref = h.db.prepare("SELECT owner_kind AS k, owner_id AS o, ref_display AS d FROM external_references").get() as Record<string, string>;
    expect(ref).toEqual({ k: "sale_tender", o: `${r.sale.id}#2`, d: "WH-SPLIT-1" });
  });

  it("the DTO carries both parts; a customer may be linked — still paid, still no debt", () => {
    const c = customer();
    const r = split({ customerId: c });
    expect(r.sale.customerId).toBe(c);
    const dto = toSaleDto(r.sale);
    expect(dto.tenders?.map((x) => [x.method, x.amount.minor])).toEqual([["cash", "200"], ["external", "300"]]);
    expect(footprint().obligations).toBe(0);
  });

  it("the smallest real split: 0.01 cash + 4.99 Whish — whole minor units, nothing lost to rounding", () => {
    const r = split({ cashMinor: 1n, whishMinor: 499n });
    expect(r.sale.tenders?.map((x) => x.amount.minor)).toEqual([1n, 499n]);
    const sum = h.db.prepare("SELECT sum(amount_minor) AS s FROM sale_tenders").get() as { s: bigint };
    expect(sum.s).toBe(500n);
  });

  it("a cashier may split (the same permission as any paid sale — nothing here creates a debt)", () => {
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect(split().sale.cashierId).toBe("cashier-02");
  });

  it("🔴 every OTHER sale keeps its exact shape: no `tenders` on cash, Whish, credit or partial sales", () => {
    const cash = h.service.createSale({ idempotencyKey: newKey(), ...ESPRESSO_X2, paymentMethod: "cash" });
    const whish = h.service.createSale({ idempotencyKey: newKey(), ...ESPRESSO_X2, paymentMethod: "external", whish: { reference: "WH-ONE", fundsConfirmed: true } });
    const c = customer();
    const credit = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c, ...ESPRESSO_X2 });
    const partial = h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c, ...ESPRESSO_X2, downPayment: { amountMinor: 100n, method: "cash" } });
    for (const s of [cash.sale, whish.sale, credit.sale, partial.sale]) {
      expect("tenders" in s).toBe(false);
      expect("tenders" in toSaleDto(s)).toBe(false);
    }
    expect(cash.sale.paymentMethod).toBe("cash");
    expect(whish.sale.externalPayment?.reference).toBe("WH-ONE");
  });

  it("Today counts the split sale once, at its total; a void (owner) keeps both tenders and the reference", () => {
    const r = split({ whish: { reference: "WH-VOID-1", fundsConfirmed: true } });
    expect(h.service.getTodaySales().grossSales.minor).toBe(500n);
    h.service.voidSale(r.sale.id, "الزبون غيّر رأيه");
    expect(footprint()).toMatchObject({ tenders: 2, references: 1 });
    expect(codeOf(() => split({ whish: { reference: "WH-VOID-1", fundsConfirmed: true } }))).toBe("DUPLICATE_PAYMENT_REFERENCE");
  });
});

describe("🔴 refused — and a refusal writes nothing", () => {
  it("amounts: a zero or negative part, a non-integer, parts that do not add up to the total", () => {
    expect(codeOf(() => split({ cashMinor: 0n, whishMinor: 500n }))).toBe("SPLIT_AMOUNT_INVALID");
    expect(codeOf(() => split({ cashMinor: 500n, whishMinor: 0n }))).toBe("SPLIT_AMOUNT_INVALID");
    expect(codeOf(() => split({ cashMinor: -100n, whishMinor: 600n }))).toBe("SPLIT_AMOUNT_INVALID");
    expect(codeOf(() => split({ cashMinor: 2 as unknown as bigint }))).toBe("SPLIT_AMOUNT_INVALID");
    expect(codeOf(() => split({ cashMinor: 200n, whishMinor: 299n }))).toBe("SPLIT_TOTAL_MISMATCH");
    expect(codeOf(() => split({ cashMinor: 200n, whishMinor: 301n }))).toBe("SPLIT_TOTAL_MISMATCH");
    expect(codeOf(() => split({ cashMinor: 400n, whishMinor: 400n }))).toBe("SPLIT_TOTAL_MISMATCH");
    expect(footprint()).toEqual(NOTHING);
  });

  it("a displayed total the catalogue no longer agrees with → TOTAL_MISMATCH (main re-prices)", () => {
    expect(codeOf(() => split({ expectedTotalMinor: 499n, cashMinor: 200n, whishMinor: 299n }))).toBe("TOTAL_MISMATCH");
    expect(footprint()).toEqual(NOTHING);
  });

  it("Whish: no evidence, a blank reference, an unconfirmed transfer", () => {
    expect(codeOf(() => split({ whish: null }))).toBe("INVALID_INPUT");
    expect(codeOf(() => split({ whish: { reference: "   ", fundsConfirmed: true } }))).toBe("INVALID_INPUT");
    expect(codeOf(() => split({ whish: { reference: "WH-NC", fundsConfirmed: false } }))).toBe("FUNDS_NOT_CONFIRMED");
    expect(codeOf(() => split({ whish: { reference: "WH-NC", fundsConfirmed: "yes" } }))).toBe("FUNDS_NOT_CONFIRMED");
    expect(footprint()).toEqual(NOTHING);
  });

  it("🔴 a Whish reference already used (by a Whish sale, a partial sale or another split) rolls back EVERYTHING", () => {
    h.service.createSale({ idempotencyKey: newKey(), ...ESPRESSO_X2, paymentMethod: "external", whish: { reference: "WH-USED-1", fundsConfirmed: true } });
    const c = customer();
    h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId: c, ...ESPRESSO_X2, downPayment: { amountMinor: 100n, method: "external", whish: { reference: "WH-USED-2", fundsConfirmed: true } } });
    split({ whish: { reference: "WH-USED-3", fundsConfirmed: true } });
    const before = footprint();
    for (const ref of ["WH-USED-1", "WH-USED-2", "WH-USED-3", " wh-used-3 "]) {
      expect(codeOf(() => split({ whish: { reference: ref, fundsConfirmed: true } }))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    }
    expect(footprint()).toEqual(before);
  });

  it("an archived customer → PARTY_NOT_FOUND, nothing written", () => {
    const c = customer();
    h.partyStore.update(c, { isActive: false }, h.clock.now().toISOString());
    expect(codeOf(() => split({ customerId: c }))).toBe("PARTY_NOT_FOUND");
    expect(footprint()).toEqual(NOTHING);
  });
});

describe("🔴 idempotency — a double click or a lost reply never doubles anything", () => {
  it("the same key with the same request replays the SAME sale", () => {
    const key = newKey();
    const whish = { reference: "WH-REPLAY", fundsConfirmed: true };
    const a = split({ whish }, key);
    const b = split({ whish }, key);
    expect(b.duplicate).toBe(true);
    expect(b.sale.id).toBe(a.sale.id);
    expect(footprint()).toEqual({ sales: 1, lines: 1, tenders: 2, obligations: 0, references: 1 });
  });

  it("the same key with other amounts, another reference or another customer is a conflict", () => {
    const key = newKey();
    const whish = { reference: "WH-K", fundsConfirmed: true };
    split({ whish }, key);
    const before = footprint();
    expect(codeOf(() => split({ whish, cashMinor: 100n, whishMinor: 400n }, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => split({ whish: { reference: "WH-K-OTHER", fundsConfirmed: true } }, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => split({ whish, customerId: customer() }, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toEqual(before);
  });

  it("a key already used by an ordinary cash sale is a conflict, never a second sale", () => {
    const key = newKey();
    h.service.createSale({ idempotencyKey: key, ...ESPRESSO_X2, paymentMethod: "cash" });
    expect(codeOf(() => split({}, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toMatchObject({ sales: 1, tenders: 1 });
  });
});

class FailingSplitRepository extends SaleRepository {
  constructor(
    db: ConstructorParameters<typeof SaleRepository>[0],
    private readonly fault: "second-tender" | "first-line",
  ) {
    super(db);
  }
  protected override insertTender(saleId: string, seq: number, tender: SingleTender): void {
    if (this.fault === "second-tender" && seq === 2) throw new Error("injected at the second tender");
    super.insertTender(saleId, seq, tender);
  }
  protected override insertSaleLine(saleId: string, line: NewSaleLine): void {
    if (this.fault === "first-line") throw new Error("injected at the first sale line");
    super.insertSaleLine(saleId, line);
  }
}

describe("🔴 atomic — the sale, both tenders, the reference and the lines together or not at all", () => {
  it.each(["second-tender", "first-line"] as const)("a failure at the %s leaves NOTHING — not the cash tender, not the reference", (fault) => {
    reset({ repository: (db) => new FailingSplitRepository(db, fault) });
    expect(() => split({ whish: { reference: "WH-ATOMIC", fundsConfirmed: true } })).toThrow();
    expect(footprint()).toEqual(NOTHING);
    // The reference was never kept: once the fault is gone, the same reference records once.
    reset();
    expect(split({ whish: { reference: "WH-ATOMIC", fundsConfirmed: true } }).duplicate).toBe(false);
  });

  it("the repository refuses a multi-tender header that names a single method (no silent mixed shape)", () => {
    const repo = new SaleRepository(h.db);
    const header = {
      id: "s-mixed", idempotencyKey: "mixed-key-0001", requestFingerprint: "f", sourceType: "pos" as const, invoiceId: null,
      customerId: null, customerNameSnapshot: null, cashierId: "cashier-01", cashierName: "Cashier One", currency: "USD",
      subtotalMinor: 500n, taxMinor: 0n, totalMinor: 500n, paidMinor: 500n, balanceDueMinor: 0n, paymentStatus: "paid" as const,
      paymentMethod: "cash" as const, businessDate: "2026-11-09", completedAt: "x", createdAt: "x",
      tenders: [{ method: "cash" as const, amountMinor: 200n }, { method: "cash" as const, amountMinor: 300n }],
    };
    expect(() => repo.commitSale(header, [])).toThrow(/single method/);
    expect(footprint()).toEqual(NOTHING);
  });
});
