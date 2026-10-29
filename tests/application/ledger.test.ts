/**
 * Obligations and settlements: posting, collecting, and every way the money could go wrong.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS GUARDING. An accounts system fails quietly, not loudly. The dangerous bugs
 * are the ones that produce a plausible number: a debt posted twice because a retry was not
 * recognised, a payment recorded twice for the same reason, two same-named customers sharing a
 * balance, a supplier's payable appearing among what customers owe, or a USD payment quietly
 * reducing an LBP debt. Each of those is asserted here, and so is the thing that must NOT happen:
 * any change at all to a finalized sale.
 *
 * Disposable database per test. Synthetic names and amounts only — no merchant data anywhere.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerService, type LedgerActor } from "../../src/application/ledgerService";
import { DomainError } from "../../src/domain/errors";
import { PartyService } from "../../src/application/partyService";
import { LedgerRepository } from "../../src/persistence/ledgerRepository";
import { PartyRepository } from "../../src/persistence/partyRepository";
import { type SettlementMethod, balancesByCurrency, ledgerAmount, outstanding } from "../../src/domain/ledger";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let actor: LedgerActor | null;
let ledger: LedgerService;
let parties: PartyService;
let repo: LedgerRepository;
let partyRepo: PartyRepository;
let clockMs: number;

const OWNER: LedgerActor = { id: "cashier-01", name: "Owner One", role: "owner" };
const CASHIER: LedgerActor = { id: "cashier-02", name: "Cashier Two", role: "cashier" };

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  partyRepo = new PartyRepository(h.db);
  repo = new LedgerRepository(h.db);
  actor = OWNER;
  clockMs = Date.parse("2026-10-22T08:00:00.000Z");
  let n = 0;
  let p = 0;
  parties = new PartyService({
    parties: partyRepo,
    actor: () => actor,
    transact: (fn) => h.db.transaction(fn).immediate(),
    now: () => new Date((clockMs += 1000)),
    newId: () => `party-${++p}`,
  });
  ledger = new LedgerService({
    ledger: repo,
    parties: partyRepo,
    actor: () => actor,
    transact: (fn) => h.db.transaction(fn).immediate(),
    terminal: { timeZone: "Asia/Beirut" },
    // 🔴 THE REAL TABLE, not a map. Production resolves this against `sales`, and a fixture that
    // answered from a side map could agree with the service while disagreeing with the foreign
    // key — which is exactly the failure an earlier draft of this file hit.
    saleCurrency: (id) => {
      const row = h.db.prepare(`SELECT currency FROM sales WHERE id = ?`).get(id) as { currency: string } | undefined;
      return row?.currency ?? null;
    },
    now: () => new Date((clockMs += 1000)),
    newId: () => `led-${++n}`,
  });
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_THROW";
};

/**
 * A customer, created through the real service so authorization is exercised too.
 *
 * Signature read from `PartyService.create`, not guessed: it takes ONE draft carrying `kind`,
 * not `(kind, draft)`. The first draft of this file guessed the latter and all 38 tests failed at
 * setup with "An account needs a name" — the name landed in the kind position.
 */
const customer = (name: string, phone?: string) =>
  parties.create({ kind: "customer", displayName: name, phone }).party;

const supplier = (name: string) => parties.create({ kind: "supplier", displayName: name }).party;

/**
 * A REAL completed sale, through the real PosService on the real connection.
 *
 * `prod-0001` at 2.50 is the bundled fixture catalog's first product, so the total is 250 minor.
 */
const realSale = (key: string): string =>
  h.service.createSale({
    idempotencyKey: key,
    lines: [{ productId: "prod-0001", quantityMilli: 1000 }],
    paymentMethod: "cash",
    expectedTotalMinor: 250n,
  }).sale.id;

/** A manual obligation — the shape that needs no sale fixture. */
const owe = (partyId: string, ref: string, minor: bigint, currency = "USD") =>
  ledger.postObligation({
    partyId,
    direction: "receivable",
    sourceKind: "manual",
    sourceRef: ref,
    currency,
    amountMinor: minor,
  });

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Stable party and source identity
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("source identity", () => {
  it("🔴 a posted obligation carries the party id, not the name", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    expect(record.partyId).toBe(c.id);
    expect(record.amountMinor).toBe(1000n);
    expect(record.direction).toBe("receivable");
    expect(record.partyKind).toBe("customer");
  });

  it("🔴 two same-named customers never share a balance", () => {
    const a = customer("محمد علي", "0111111");
    const b = customer("محمد علي", "0222222");
    expect(a.id).not.toBe(b.id);
    owe(a.id, "bill-a", 5000n);
    owe(b.id, "bill-b", 700n);
    expect(ledger.balancesOf(a.id).get("USD")).toBe(5000n);
    expect(ledger.balancesOf(b.id).get("USD")).toBe(700n);
  });

  it("🔴 a settlement names the party, and the WRONG party is refused", () => {
    const a = customer("محمد علي", "0111111");
    const b = customer("محمد علي", "0222222");
    const { record } = owe(a.id, "bill-a", 5000n);
    expect(
      code(() =>
        ledger.settle({ obligationId: record.id, partyId: b.id, idempotencyKey: "pay-00001", amountMinor: 100n, method: "cash" }),
      ),
    ).toBe("INVALID_INPUT");
    // And a's debt is untouched by the refusal.
    expect(ledger.balancesOf(a.id).get("USD")).toBe(5000n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Duplicate obligation attempts
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("no double posting", () => {
  it("🔴 the same source twice is ONE obligation, answered as a duplicate", () => {
    const c = customer("سمير");
    const first = owe(c.id, "bill-1", 1000n);
    const second = owe(c.id, "bill-1", 1000n);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(ledger.obligationsOf(c.id)).toHaveLength(1);
    expect(ledger.balancesOf(c.id).get("USD")).toBe(1000n);
  });

  it("🔴 the same source for a DIFFERENT amount is refused, not silently kept", () => {
    const c = customer("سمير");
    owe(c.id, "bill-1", 1000n);
    expect(code(() => owe(c.id, "bill-1", 9999n))).toBe("IDEMPOTENCY_CONFLICT");
    expect(ledger.balancesOf(c.id).get("USD")).toBe(1000n);
  });

  it("🔴 the database refuses a duplicate source even past the service", () => {
    const c = customer("سمير");
    owe(c.id, "bill-1", 1000n);
    expect(() =>
      repo.insertObligation({
        id: "sneaky", partyId: c.id, partyKind: "customer", direction: "receivable",
        sourceKind: "manual", sourceRef: "bill-1", saleId: null, currency: "USD",
        amountMinor: 1n, postedBy: "cashier-01",
        postedAt: "2026-10-22T08:00:00.000Z", businessDate: "2026-10-22",
      }),
    ).toThrow(/UNIQUE/i);
  });

  it("🔴 one sale cannot carry two obligations — the source IS the sale id", () => {
    const c = customer("سمير");
    // 🔴 A REAL SALE, MADE THROUGH THE REAL SERVICE. An earlier draft only faked the currency
    // lookup and the insert failed on `sale_id REFERENCES sales(id)` — the product refusing to
    // point a debt at a sale that does not exist, which is exactly right. A fixture that fakes the
    // lookup but not the row tests the fake.
    const saleId = realSale("till-key-00000001");
    const post = () =>
      ledger.postObligation({
        partyId: c.id, direction: "receivable", sourceKind: "sale",
        sourceRef: saleId, currency: "USD", amountMinor: 250n,
      });
    expect(post().duplicate).toBe(false);
    expect(post().duplicate).toBe(true);
    expect(ledger.obligationsOf(c.id)).toHaveLength(1);
    expect(ledger.obligationsOf(c.id)[0]!.saleId).toBe(saleId);
  });

  it("🔴 an invoice and its linked sale produce ONE debt, not two", () => {
    // The whole double-posting question in one assertion. `sales.invoice_id` is UNIQUE, so an
    // invoice has at most one sale; the obligation is keyed to the SALE; therefore the chain
    // invoice -> sale -> obligation is 1:1:1 and there is no second thing to post against.
    const c = customer("سمير");
    const saleId = realSale("till-key-00000002");
    ledger.postObligation({
      partyId: c.id, direction: "receivable", sourceKind: "sale",
      sourceRef: saleId, currency: "USD", amountMinor: 250n,
    });
    // Posting again against the SAME sale — however the caller reached it — is a duplicate.
    const again = ledger.postObligation({
      partyId: c.id, direction: "receivable", sourceKind: "sale",
      sourceRef: saleId, currency: "USD", amountMinor: 250n,
    });
    expect(again.duplicate).toBe(true);
    expect(Number((h.db.prepare(`SELECT count(*) AS n FROM obligations`).get() as { n: bigint }).n)).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 5, 6, 7, 8 · Settlement: partial, multiple, retried, and over
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("settlement", () => {
  // `method` is typed as the real union: `= "cash" as const` would narrow the PARAMETER to the
  // literal "cash" and refuse every other tender at the call site.
  const pay = (
    obligationId: string,
    partyId: string,
    key: string,
    minor: bigint,
    method: SettlementMethod = "cash",
  ) =>
    ledger.settle({ obligationId, partyId, idempotencyKey: key, amountMinor: minor, method });

  it("🔴 a partial payment leaves the rest owed", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    pay(record.id, c.id, "pay-00001", 400n);
    expect(ledger.outstandingOf(record.id)).toEqual({ minor: 600n, currency: "USD" });
    expect(ledger.balancesOf(c.id).get("USD")).toBe(600n);
  });

  it("🔴 several legitimate payments add up and can clear the debt exactly", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    pay(record.id, c.id, "pay-00001", 400n);
    pay(record.id, c.id, "pay-00002", 350n, "card");
    pay(record.id, c.id, "pay-00003", 250n, "external");
    expect(ledger.outstandingOf(record.id).minor).toBe(0n);
    expect(ledger.balancesOf(c.id).get("USD")).toBe(0n);
    expect(ledger.settlementsOf(record.id)).toHaveLength(3);
  });

  it("🔴 the same key twice is ONE payment — the retry answer a merchant needs", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    const a = pay(record.id, c.id, "pay-00001", 400n);
    const b = pay(record.id, c.id, "pay-00001", 400n);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.record.id).toBe(a.record.id);
    expect(ledger.settlementsOf(record.id)).toHaveLength(1);
    expect(ledger.outstandingOf(record.id).minor).toBe(600n);
  });

  it("🔴 the same key for DIFFERENT money is refused, never accepted as a retry", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    pay(record.id, c.id, "pay-00001", 400n);
    expect(code(() => pay(record.id, c.id, "pay-00001", 900n))).toBe("IDEMPOTENCY_CONFLICT");
    // ...and a different METHOD for the same amount is equally a different payment.
    expect(code(() => pay(record.id, c.id, "pay-00001", 400n, "card"))).toBe("IDEMPOTENCY_CONFLICT");
    expect(ledger.outstandingOf(record.id).minor).toBe(600n);
  });

  it("🔴 overpayment is refused by the SERVICE, with the real remaining figure", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    pay(record.id, c.id, "pay-00001", 400n);
    let refusal: unknown;
    try {
      pay(record.id, c.id, "pay-00002", 601n);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({
      code: "INVALID_AMOUNT",
      reason: "CUSTOMER_PAYMENT_EXCEEDS_OUTSTANDING",
      message: "That is more than is owed; 6.00 USD remains",
      context: { outstandingMinor: 600n, currency: "USD" },
    });
    expect(ledger.outstandingOf(record.id).minor).toBe(600n);
  });

  it("🔴 and by the DATABASE, which is the authority under concurrency", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    expect(() =>
      repo.insertSettlement({
        id: "sneaky", obligationId: record.id, currency: "USD", idempotencyKey: "sneak-001",
        requestFingerprint: "x", amountMinor: 1001n, method: "cash", settledBy: "cashier-01",
        settledAt: "2026-10-22T08:00:00.000Z", businessDate: "2026-10-22",
      }),
    ).toThrow(/cannot exceed what is owed/);
    expect(ledger.outstandingOf(record.id).minor).toBe(1000n);
  });

  it("🔴 zero and negative payments are refused", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    expect(code(() => pay(record.id, c.id, "pay-00001", 0n))).toBe("INVALID_AMOUNT");
    expect(code(() => pay(record.id, c.id, "pay-00002", -5n))).toBe("INVALID_AMOUNT");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 10 · Customer receivables versus supplier payables
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the two sides never mix", () => {
  it("🔴 a supplier payable never appears among what customers owe", () => {
    const c = customer("سمير");
    const s = supplier("مورّد");
    owe(c.id, "bill-c", 1000n);
    ledger.postObligation({
      partyId: s.id, direction: "payable", sourceKind: "manual",
      sourceRef: "supplier-bill-9", currency: "USD", amountMinor: 7000n,
    });
    const customerRows = ledger.obligationsOf(c.id);
    expect(customerRows).toHaveLength(1);
    expect(customerRows.every((o) => o.direction === "receivable")).toBe(true);
    const supplierRows = ledger.obligationsOf(s.id);
    expect(supplierRows).toHaveLength(1);
    expect(supplierRows.every((o) => o.direction === "payable")).toBe(true);
  });

  it("🔴 a receivable cannot be posted against a supplier, nor a payable against a customer", () => {
    const c = customer("سمير");
    const s = supplier("مورّد");
    expect(
      code(() =>
        ledger.postObligation({
          partyId: s.id, direction: "receivable", sourceKind: "manual",
          sourceRef: "x1", currency: "USD", amountMinor: 10n,
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      code(() =>
        ledger.postObligation({
          partyId: c.id, direction: "payable", sourceKind: "manual",
          sourceRef: "x2", currency: "USD", amountMinor: 10n,
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("🔴 the database refuses a mismatched pair even past the service", () => {
    const c = customer("سمير");
    expect(() =>
      repo.insertObligation({
        id: "bad", partyId: c.id, partyKind: "supplier", direction: "payable",
        sourceKind: "manual", sourceRef: "x3", saleId: null, currency: "USD",
        amountMinor: 10n, postedBy: "cashier-01",
        postedAt: "2026-10-22T08:00:00.000Z", businessDate: "2026-10-22",
      }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("🔴 and the two are never summed into one figure", () => {
    const c = customer("سمير");
    const s = supplier("مورّد");
    const a = owe(c.id, "bill-c", 1000n).record;
    const b = ledger.postObligation({
      partyId: s.id, direction: "payable", sourceKind: "manual",
      sourceRef: "sb-1", currency: "USD", amountMinor: 7000n,
    }).record;
    expect(code(() => balancesByCurrency([a, b], () => []))).toBe("LEDGER_INTEGRITY");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 16 · Currency separation
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("currency", () => {
  it("🔴 a party's balances are PER CURRENCY, never blended", () => {
    const c = customer("سمير");
    owe(c.id, "usd-1", 5000n, "USD");
    owe(c.id, "lbp-1", 2000000n, "LBP");
    const balances = ledger.balancesOf(c.id);
    expect(balances.get("USD")).toBe(5000n);
    expect(balances.get("LBP")).toBe(2000000n);
    expect(balances.size).toBe(2);
  });

  it("🔴 a settlement cannot change the currency of the debt it pays", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "lbp-1", 2000000n, "LBP");
    expect(() =>
      repo.insertSettlement({
        id: "x", obligationId: record.id, currency: "USD", idempotencyKey: "cross-001",
        requestFingerprint: "f", amountMinor: 100n, method: "cash", settledBy: "cashier-01",
        settledAt: "2026-10-22T08:00:00.000Z", businessDate: "2026-10-22",
      }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("🔴 a sale-sourced debt must match the sale's own currency", () => {
    const c = customer("سمير");
    // A real USD sale; posting it as an LBP debt is refused rather than converted.
    const saleId = realSale("till-key-00000003");
    expect(
      code(() =>
        ledger.postObligation({
          partyId: c.id, direction: "receivable", sourceKind: "sale",
          sourceRef: saleId, currency: "LBP", amountMinor: 100n,
        }),
      ),
    ).toBe("MIXED_CURRENCY");
    expect(Number((h.db.prepare(`SELECT count(*) AS n FROM obligations`).get() as { n: bigint }).n)).toBe(0);
  });

  it("🔴 an unknown currency is refused", () => {
    const c = customer("سمير");
    expect(code(() => owe(c.id, "x", 100n, "XYZ"))).toBe("UNKNOWN_CURRENCY");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 13 · Authorization
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("authorization", () => {
  it("🔴 a cashier may not post a debt, collect, or even read the ledger", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    actor = CASHIER;
    expect(code(() => owe(c.id, "bill-2", 50n))).toBe("NOT_AUTHORIZED");
    expect(
      code(() =>
        ledger.settle({ obligationId: record.id, partyId: c.id, idempotencyKey: "pay-00001", amountMinor: 10n, method: "cash" }),
      ),
    ).toBe("NOT_AUTHORIZED");
    expect(code(() => ledger.obligationsOf(c.id))).toBe("NOT_AUTHORIZED");
    expect(code(() => ledger.balancesOf(c.id))).toBe("NOT_AUTHORIZED");
    expect(code(() => ledger.outstandingOf(record.id))).toBe("NOT_AUTHORIZED");
    expect(code(() => ledger.settlementsOf(record.id))).toBe("NOT_AUTHORIZED");
  });

  it("🔴 nobody signed in may do anything", () => {
    const c = customer("سمير");
    actor = null;
    expect(code(() => owe(c.id, "bill-2", 50n))).toBe("NOT_LOGGED_IN");
    expect(code(() => ledger.balancesOf(c.id))).toBe("NOT_LOGGED_IN");
  });

  it("🔴 a refused write leaves no row behind", () => {
    const c = customer("سمير");
    actor = CASHIER;
    expect(code(() => owe(c.id, "bill-2", 50n))).toBe("NOT_AUTHORIZED");
    actor = OWNER;
    expect(ledger.obligationsOf(c.id)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 11 · Rollback on an injected persistence failure
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("a failure leaves nothing half-posted", () => {
  it("🔴 an exception inside the transaction rolls the whole posting back", () => {
    const c = customer("سمير");
    let boom = false;
    const breaking = new LedgerService({
      ledger: {
        ...repo,
        findObligationBySource: repo.findObligationBySource.bind(repo),
        findObligationById: repo.findObligationById.bind(repo),
        listObligations: repo.listObligations.bind(repo),
        listSettlements: repo.listSettlements.bind(repo),
        settledTotal: repo.settledTotal.bind(repo),
        findSettlementByIdempotencyKey: repo.findSettlementByIdempotencyKey.bind(repo),
        insertSettlement: repo.insertSettlement.bind(repo),
        insertObligation: (o) => {
          repo.insertObligation(o);
          if (boom) throw new Error("disk went away after the insert");
        },
      } as LedgerRepository,
      parties: partyRepo,
      actor: () => actor,
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
      now: () => new Date((clockMs += 1000)),
      newId: () => "led-boom",
    });
    boom = true;
    expect(() =>
      breaking.postObligation({
        partyId: c.id, direction: "receivable", sourceKind: "manual",
        sourceRef: "bill-boom", currency: "USD", amountMinor: 1000n,
      }),
    ).toThrow(/disk went away/);
    // 🔴 THE ROW WAS INSERTED AND THEN THE TRANSACTION FAILED. It must not survive.
    expect(ledger.obligationsOf(c.id)).toHaveLength(0);
    expect(repo.findObligationBySource("manual", "bill-boom")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 12 · An archived party keeps its financial history
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("archiving", () => {
  it("🔴 archiving a customer hides them from the directory but keeps every debt traceable", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    ledger.settle({ obligationId: record.id, partyId: c.id, idempotencyKey: "pay-00001", amountMinor: 400n, method: "cash" });

    parties.setActive("customer", c.id, false);
    expect(parties.list("customer").find((p) => p.id === c.id)).toBeUndefined();
    expect(parties.list("customer", true).find((p) => p.id === c.id)?.is_active).toBe(0);

    // The money is still there, still attributable, still correct.
    expect(ledger.obligationsOf(c.id)).toHaveLength(1);
    expect(ledger.outstandingOf(record.id).minor).toBe(600n);
    expect(ledger.balancesOf(c.id).get("USD")).toBe(600n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 15 · Overflow and invalid values
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("invalid amounts", () => {
  it("🔴 rejects zero, negative, non-exact and out-of-range", () => {
    const c = customer("سمير");
    expect(code(() => owe(c.id, "a", 0n))).toBe("INVALID_AMOUNT");
    expect(code(() => owe(c.id, "b", -1n))).toBe("INVALID_AMOUNT");
    expect(code(() => owe(c.id, "c", 10n ** 15n + 1n))).toBe("MONEY_OUT_OF_RANGE");
    expect(code(() => owe(c.id, "d", 100 as unknown as bigint))).toBe("NOT_EXACT");
    expect(code(() => owe(c.id, "e", "100" as unknown as bigint))).toBe("NOT_EXACT");
  });

  it("🔴 the exact maximum is accepted — the bound is not off by one", () => {
    const c = customer("سمير");
    expect(owe(c.id, "max", 10n ** 15n).record.amountMinor).toBe(10n ** 15n);
  });

  it("🔴 an empty or missing source reference is refused", () => {
    const c = customer("سمير");
    expect(code(() => owe(c.id, "   ", 10n))).toBe("INVALID_INPUT");
    expect(code(() => owe(c.id, "x".repeat(121), 10n))).toBe("INVALID_INPUT");
  });

  it("🔴 an unknown party is refused", () => {
    expect(code(() => owe("no-such-party", "a", 10n))).toBe("PARTY_NOT_FOUND");
  });

  it("🔴 a sale that does not exist is refused", () => {
    const c = customer("سمير");
    expect(
      code(() =>
        ledger.postObligation({
          partyId: c.id, direction: "receivable", sourceKind: "sale",
          sourceRef: "ghost-sale", currency: "USD", amountMinor: 10n,
        }),
      ),
    ).toBe("SALE_NOT_FOUND");
  });

  it("🔴 a bad idempotency key is refused before anything is written", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    expect(
      code(() => ledger.settle({ obligationId: record.id, partyId: c.id, idempotencyKey: "short", amountMinor: 1n, method: "cash" })),
    ).toBe("INVALID_INPUT");
    expect(
      code(() => ledger.settle({ obligationId: record.id, partyId: c.id, idempotencyKey: "pay-00001", amountMinor: 1n, method: "whish" })),
    ).toBe("INVALID_PAYMENT_METHOD");
    expect(ledger.settlementsOf(record.id)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 14 · The calculated balance, and that it is calculated
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the balance is derived", () => {
  it("🔴 there is no balance column anywhere to disagree with the rows", () => {
    const cols = (table: string) =>
      (h.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of ["obligations", "settlements", "parties"]) {
      const names = cols(t).join(" ");
      expect(names).not.toMatch(/balance/);
      expect(names).not.toMatch(/paid_minor/);
      expect(names).not.toMatch(/outstanding/);
    }
  });

  it("🔴 worked example: 1000 owed, 400 then 350 paid, 250 left", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    ledger.settle({ obligationId: record.id, partyId: c.id, idempotencyKey: "pay-00001", amountMinor: 400n, method: "cash" });
    ledger.settle({ obligationId: record.id, partyId: c.id, idempotencyKey: "pay-00002", amountMinor: 350n, method: "cash" });
    expect(ledger.outstandingOf(record.id).minor).toBe(250n);

    // The same answer computed straight from the rows, with no service in the way.
    const o = repo.findObligationById(record.id)!;
    expect(outstanding(o, repo.listSettlements(o.id)).minor).toBe(250n);
  });

  it("🔴 several obligations roll up into one per-currency figure", () => {
    const c = customer("سمير");
    const a = owe(c.id, "b1", 1000n).record;
    const b = owe(c.id, "b2", 2500n).record;
    ledger.settle({ obligationId: a.id, partyId: c.id, idempotencyKey: "pay-00001", amountMinor: 1000n, method: "cash" });
    ledger.settle({ obligationId: b.id, partyId: c.id, idempotencyKey: "pay-00002", amountMinor: 500n, method: "cash" });
    expect(ledger.balancesOf(c.id).get("USD")).toBe(2000n);
  });

  it("🔴 a party who owes nothing has an empty map, not a zero that looks authoritative", () => {
    const c = customer("سمير");
    expect(ledger.balancesOf(c.id).size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 4 (part) · Posted history is immutable
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("posted history cannot be rewritten", () => {
  it("🔴 neither table admits an UPDATE or a DELETE", () => {
    const c = customer("سمير");
    const { record } = owe(c.id, "bill-1", 1000n);
    ledger.settle({ obligationId: record.id, partyId: c.id, idempotencyKey: "pay-00001", amountMinor: 400n, method: "cash" });

    expect(() => h.db.prepare(`UPDATE obligations SET amount_minor = 1 WHERE id = ?`).run(record.id)).toThrow(/immutable/);
    expect(() => h.db.prepare(`DELETE FROM obligations WHERE id = ?`).run(record.id)).toThrow(/cannot be deleted/);
    expect(() => h.db.prepare(`UPDATE settlements SET amount_minor = 1`).run()).toThrow(/immutable/);
    expect(() => h.db.prepare(`DELETE FROM settlements`).run()).toThrow(/cannot be deleted/);

    expect(ledger.outstandingOf(record.id).minor).toBe(600n);
  });

  it("🔴 and the ledger repository exposes no mutating method to call by accident", () => {
    // 🔴 AN EXACT INVENTORY, NOT A PATTERN. The first draft filtered on /update|delete|remove|set/i
    // and flagged `insertSettlement` and `settledTotal` — "settlement" contains "set". A fuzzy
    // matcher over method names is the wrong instrument: it fails on innocent names and would
    // equally miss a mutator called `correct()`. Pinning the whole surface fails loudly the moment
    // ANY method is added, which is the behaviour actually wanted here.
    const names = Object.getOwnPropertyNames(LedgerRepository.prototype)
      .filter((n) => n !== "constructor")
      .sort();
    expect(names).toEqual([
      // Migration 17 (M17A) added READS (per-channel daily totals, the one-reference-one-collection
      // lookup) and the collection-attempt bookkeeping (insert / find / list-open / resolve-once —
      // a trigger lets an attempt be closed exactly once and nothing else about it change). Still
      // no mutator of an obligation or a settlement beyond the two inserts.
      "collectionTotals",
      "findAttempt",
      "findObligationById",
      "findObligationBySource",
      "findSettlementByIdempotencyKey",
      "findSettlementByProviderReference",
      "insertAttempt",
      "insertObligation",
      "insertSettlement",
      "listObligations",
      "listOpenAttempts",
      "listSettlements",
      "resolveAttempt",
      "settledTotal",
    ]);
    // And the two that write only ever INSERT.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const src = readFileSync("src/persistence/ledgerRepository.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bUPDATE\s+(obligations|settlements)\b/i);
    expect(src).not.toMatch(/\bDELETE\s+FROM\s+(obligations|settlements)\b/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 4 (part) · The sale is never rewritten
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("a payment never touches the sale", () => {
  it("🔴 no file in the ledger slice writes to sales, sale_lines or invoices", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    for (const f of [
      "src/application/ledgerService.ts",
      "src/persistence/ledgerRepository.ts",
      "src/domain/ledger.ts",
    ]) {
      const src = strip(readFileSync(f, "utf8"));
      expect(src, `${f} writes to a ledger table`).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(sales|sale_lines|invoices|invoice_lines|voids)\b/i);
    }
  });

  it("🔴 selecting a customer creates no obligation — only an explicit posting does", () => {
    const c = customer("سمير");
    // S1B's quick-create is exactly this call and nothing more.
    expect(ledger.obligationsOf(c.id)).toHaveLength(0);
    expect(Number((h.db.prepare(`SELECT count(*) AS n FROM obligations`).get() as { n: bigint }).n)).toBe(0);
    expect(Number((h.db.prepare(`SELECT count(*) AS n FROM settlements`).get() as { n: bigint }).n)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Domain-level guards, independent of any database
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("domain guards", () => {
  it("🔴 outstanding() refuses a settlement belonging to another obligation", () => {
    const o = {
      id: "o1", partyId: "p1", partyKind: "customer" as const, direction: "receivable" as const,
      sourceKind: "manual" as const, sourceRef: "r", saleId: null, currency: "USD",
      amountMinor: 100n, postedBy: "x", postedAt: "t", businessDate: "d",
    };
    const foreign = {
      id: "s1", obligationId: "SOMEONE-ELSE", currency: "USD", idempotencyKey: "k",
      amountMinor: 10n, method: "cash" as const, provider: null, reference: null, fundsConfirmed: null, settledBy: "x", settledAt: "t", businessDate: "d",
    };
    expect(code(() => outstanding(o, [foreign]))).toBe("LEDGER_INTEGRITY");
    expect(code(() => outstanding(o, [{ ...foreign, obligationId: "o1", currency: "LBP" }]))).toBe("MIXED_CURRENCY");
  });

  it("🔴 ledgerAmount enforces the positive-exact-in-range rule on its own", () => {
    expect(ledgerAmount(1n, "USD").minor).toBe(1n);
    expect(code(() => ledgerAmount(0n, "USD"))).toBe("INVALID_AMOUNT");
  });
});
