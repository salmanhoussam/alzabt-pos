import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { loadCatalog, type Catalog } from "../../src/domain/catalog";
import { DomainError } from "../../src/domain/errors";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import type { NewSaleHeader, NewSaleLine } from "../../src/persistence/saleRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { LedgerRepository } from "../../src/persistence/ledgerRepository";
import type { NewObligation } from "../../src/persistence/ledgerRepository";
import { type Harness, type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

const oneItem = {
  lines: [{ productId: "prod-0001", quantityMilli: 2000 }],
  expectedTotalMinor: 500n,
};
const twoItems = {
  lines: [
    { productId: "prod-0001", quantityMilli: 2000 },
    { productId: "prod-0002", quantityMilli: 1000 },
  ],
  expectedTotalMinor: 875n,
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("expected a DomainError");
}

function addParty(kind: "customer" | "supplier" = "customer", id = `party-${kind}-${newKey()}`): string {
  h.partyStore.insert({
    id,
    kind,
    displayName: kind === "customer" ? "عميل اختباري" : "مورد اختباري",
    phone: null,
    address: null,
    note: null,
    createdBy: "cashier-01",
    now: h.clock.now().toISOString(),
  });
  return id;
}

function obligationCount(): number {
  return Number((h.db.prepare("SELECT count(*) AS c FROM obligations").get() as { c: bigint }).c);
}

type CreditTerms = Pick<Parameters<typeof h.service.createCustomerCreditSale>[0], "lines" | "expectedTotalMinor">;

function createCredit(customerId: string, input: CreditTerms = oneItem) {
  return h.service.createCustomerCreditSale({
    idempotencyKey: newKey(),
    customerId,
    ...input,
  });
}

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});

afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

function resetHarness(
  opts: Parameters<typeof makeHarness>[1] = {},
): void {
  if (h.db.open) h.db.close();
  t.cleanup();
  t = tempDir();
  h = makeHarness(t.dbPath, opts);
}

describe("atomic, owner-only POS customer credit sale", () => {
  it("commits a fully unpaid sale and exactly one matching sale-sourced receivable", () => {
    const customerId = addParty();
    const result = createCredit(customerId);
    const persisted = h.repository.getSale(result.sale.id)!;

    expect(result.duplicate).toBe(false);
    expect(persisted).toMatchObject({
      sourceType: "pos",
      customerId,
      customerNameSnapshot: "عميل اختباري",
      paymentMethod: null,
      paymentStatus: "unpaid",
    });
    expect(persisted.total.minor).toBe(500n);
    expect(persisted.paid.minor).toBe(0n);
    expect(persisted.balanceDue.minor).toBe(500n);
    expect(result.obligation).toMatchObject({
      partyId: customerId,
      partyKind: "customer",
      direction: "receivable",
      sourceKind: "sale",
      sourceRef: persisted.id,
      saleId: persisted.id,
      currency: persisted.currency,
      amountMinor: persisted.balanceDue.minor,
    });
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("returns the exact same sale and obligation for a same-key retry without duplicates", () => {
    const customerId = addParty();
    const request = { idempotencyKey: newKey(), customerId, ...oneItem };
    const first = h.service.createCustomerCreditSale(request);
    const retry = h.service.createCustomerCreditSale(request);

    expect(retry.duplicate).toBe(true);
    expect(retry.sale).toEqual(first.sale);
    expect(retry.obligation).toEqual(first.obligation);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("commits and recovers a multi-line credit sale with unchanged line identity", () => {
    const customerId = addParty();
    const request = { idempotencyKey: newKey(), customerId, ...twoItems };
    const created = h.service.createCustomerCreditSale(request);
    const duplicate = h.service.createCustomerCreditSale(request);
    expect(created.sale.lines).toHaveLength(2);
    expect(created.sale.total.minor).toBe(875n);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.sale.id).toBe(created.sale.id);
    expect(duplicate.obligation.id).toBe(created.obligation.id);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 2 });
    expect(obligationCount()).toBe(1);
  });

  it("fingerprints trusted amount, currency, and literal fully-unpaid sale terms", () => {
    const customerId = addParty();
    const key = newKey();
    const result = h.service.createCustomerCreditSale({ idempotencyKey: key, customerId, ...oneItem });
    const expectedFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          cashierId: "cashier-01",
          sourceType: "pos",
          paymentIntent: "customer_credit",
          customerId,
          lines: [["prod-0001", 2000]],
          expectedTotalMinor: "500",
          totalMinor: "500",
          currency: "USD",
          paymentMethod: null,
          paidMinor: "0",
          paymentStatus: "unpaid",
          balanceDueMinor: "500",
          taxMinor: "0",
        }),
      )
      .digest("hex");

    expect(h.repository.findByIdempotencyKey(key)?.fingerprint).toBe(expectedFingerprint);
    expect(result.sale.currency).toBe("USD");
    h.db.close();
  });

  it.each([
    { change: "price increase", currency: "USD", price: "2.75" },
    { change: "price decrease", currency: "USD", price: "1.75" },
    { change: "currency", currency: "EUR", price: "2.50" },
  ] as const)("recovers the original pair after catalog $change", ({ change, currency, price }) => {
    const key = newKey();
    const initial = loadCatalog(FIXTURE_CATALOG);
    let activeCurrency = initial.currency;
    const mutableProducts = new Map(initial.byId);
    const mutableCatalog = {
      get currency() {
        return activeCurrency;
      },
      products: initial.products,
      byId: mutableProducts,
    } as Catalog;
    resetHarness({ catalog: mutableCatalog });
    const customerId = addParty();
    const request = { idempotencyKey: key, customerId, ...oneItem };
    const original = h.service.createCustomerCreditSale(request);
    const source = {
      ...FIXTURE_CATALOG,
      currency,
      products: FIXTURE_CATALOG.products.map((product) =>
        product.id === "prod-0001" ? { ...product, price } : product,
      ),
    };
    const repriced = loadCatalog(source);
    mutableProducts.set("prod-0001", repriced.byId.get("prod-0001")!);
    activeCurrency = repriced.currency;

    const retry = h.service.createCustomerCreditSale(request);

    expect(retry.duplicate).toBe(true);
    expect(retry.sale).toEqual(original.sale);
    expect(retry.obligation).toEqual(original.obligation);
    expect(original.sale.currency).toBe("USD");
    expect(h.repository.getSale(original.sale.id)?.total.minor).toBe(500n);
    expect(change === "currency" ? repriced.currency : original.sale.currency).toBe(currency);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("recovers the original pair when its product is no longer available", () => {
    const initial = loadCatalog(FIXTURE_CATALOG);
    const mutableProducts = new Map(initial.byId);
    const mutableCatalog = {
      currency: initial.currency,
      products: initial.products,
      byId: mutableProducts,
    } as Catalog;
    resetHarness({ catalog: mutableCatalog });
    const customerId = addParty();
    const request = { idempotencyKey: newKey(), customerId, ...oneItem };
    const first = h.service.createCustomerCreditSale(request);
    mutableProducts.delete("prod-0001");

    const retry = h.service.createCustomerCreditSale(request);
    expect(retry.duplicate).toBe(true);
    expect(retry.sale).toEqual(first.sale);
    expect(retry.obligation).toEqual(first.obligation);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("recovers a committed pair after simulated lost response, SQLite reopen, and repricing", () => {
    let loseResponse = false;
    let transactionCalls = 0;
    const initial = loadCatalog(FIXTURE_CATALOG);
    const mutableProducts = new Map(initial.byId);
    const mutableCatalog = {
      currency: initial.currency,
      products: initial.products,
      byId: mutableProducts,
    } as Catalog;
    resetHarness({
      catalog: mutableCatalog,
      serviceTransact: (db, fn) => {
        const result = db.transaction(fn).immediate();
        transactionCalls += 1;
        if (loseResponse && transactionCalls === 2) {
          loseResponse = false;
          db.close();
          throw new Error("injected lost response after COMMIT and process close");
        }
        return result;
      },
    });
    const customerId = addParty();
    const request = { idempotencyKey: newKey(), customerId, ...oneItem };
    loseResponse = true;
    expect(codeOf(() => h.service.createCustomerCreditSale(request))).toBe("LEDGER_INTEGRITY");
    const repriced = loadCatalog({
      ...FIXTURE_CATALOG,
      products: FIXTURE_CATALOG.products.map((product) =>
        product.id === "prod-0001" ? { ...product, price: "2.75" } : product,
      ),
    });
    mutableProducts.set("prod-0001", repriced.byId.get("prod-0001")!);
    h = makeHarness(t.dbPath, { catalog: mutableCatalog });

    const reopened = h.service.createCustomerCreditSale(request);
    expect(reopened.duplicate).toBe(true);
    expect(reopened.sale.total.minor).toBe(500n);
    expect(reopened.obligation.amountMinor).toBe(500n);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
  });

  it("conflicts when a reused key changes customer, items, or the displayed total", () => {
    const customerId = addParty("customer", "customer-original");
    const otherId = addParty("customer", "customer-other");
    const key = newKey();
    h.service.createCustomerCreditSale({ idempotencyKey: key, customerId, ...oneItem });

    expect(
      codeOf(() => h.service.createCustomerCreditSale({ idempotencyKey: key, customerId: otherId, ...oneItem })),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      codeOf(() => h.service.createCustomerCreditSale({ idempotencyKey: key, customerId, ...twoItems })),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      codeOf(() =>
        h.service.createCustomerCreditSale({
          idempotencyKey: key,
          customerId,
          ...oneItem,
          expectedTotalMinor: 501n,
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("refuses missing, supplier, and archived identities before writing", () => {
    const supplierId = addParty("supplier");
    const archivedId = addParty("customer");
    h.partyStore.update(archivedId, { isActive: false }, h.clock.now().toISOString());

    for (const customerId of ["missing-customer", supplierId, archivedId]) {
      expect(codeOf(() => createCredit(customerId))).toBe("PARTY_NOT_FOUND");
      expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
      expect(obligationCount()).toBe(0);
    }
    h.db.close();
  });

  it("uses the durable live role and refuses a cashier before any sale or obligation write", () => {
    const customerId = addParty();
    h.service.login("cashier-02", "2222");
    expect(codeOf(() => createCredit(customerId))).toBe("NOT_AUTHORIZED");
    expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
    expect(obligationCount()).toBe(0);
    h.db.close();
  });

  it("refuses same-key recovery after the persistent owner role changes to cashier", () => {
    const customerId = addParty();
    const request = { idempotencyKey: newKey(), customerId, ...oneItem };
    const original = h.service.createCustomerCreditSale(request);
    h.db.prepare("UPDATE operators SET role = 'cashier' WHERE id = 'cashier-01'").run();

    expect(codeOf(() => h.service.createCustomerCreditSale(request))).toBe("NOT_AUTHORIZED");
    expect(h.repository.getSale(original.sale.id)?.total.minor).toBe(500n);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("revalidates live role and active customer inside the immediate transaction", () => {
    resetHarness({
      serviceTransact: (db, fn) =>
        db.transaction(() => {
          db.prepare("UPDATE operators SET role = 'cashier' WHERE id = 'cashier-01'").run();
          return fn();
        }).immediate(),
    });
    const customerId = addParty();
    expect(codeOf(() => createCredit(customerId))).toBe("NOT_AUTHORIZED");
    expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
    expect(obligationCount()).toBe(0);
    expect((h.db.prepare("SELECT role FROM operators WHERE id = 'cashier-01'").get() as { role: string }).role).toBe(
      "owner",
    );
  });

  it("keeps the customer name snapshot immutable after a directory rename", () => {
    const customerId = addParty();
    const sale = createCredit(customerId).sale;
    h.partyStore.update(customerId, { displayName: "عميل باسم جديد" }, h.clock.now().toISOString());

    expect(h.repository.getSale(sale.id)?.customerNameSnapshot).toBe("عميل اختباري");
    h.db.close();
  });

  it("rejects renderer totals that differ from catalog pricing and validates positive known-currency debt", () => {
    const customerId = addParty();
    expect(
      codeOf(() =>
        h.service.createCustomerCreditSale({
          idempotencyKey: newKey(),
          customerId,
          ...oneItem,
          expectedTotalMinor: 499n,
        }),
      ),
    ).toBe("TOTAL_MISMATCH");
    expect(codeOf(() => h.ledger.validateObligationAmount(0n, "USD"))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => h.ledger.validateObligationAmount(500n, "ZZZ"))).toBe("UNKNOWN_CURRENCY");
    expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
    expect(obligationCount()).toBe(0);
    h.db.close();
  });

  it("preserves source uniqueness through both service and database defenses", () => {
    const customerId = addParty();
    const result = createCredit(customerId);
    const retry = h.ledger.postObligation({
      partyId: customerId,
      direction: "receivable",
      sourceKind: "sale",
      sourceRef: result.sale.id,
      currency: "USD",
      amountMinor: 500n,
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.record.id).toBe(result.obligation.id);
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO obligations
           (id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency,
            amount_minor, posted_by, posted_at, business_date)
           SELECT 'duplicate-obligation', party_id, party_kind, direction, source_kind,
                  source_ref, sale_id, currency, amount_minor, posted_by, posted_at, business_date
             FROM obligations WHERE id = ?`,
        )
        .run(result.obligation.id),
    ).toThrow(/UNIQUE/i);
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("refuses to void any sale with a receivable, including after partial collection", () => {
    const customerId = addParty();
    const result = createCredit(customerId);
    h.ledger.settle({
      obligationId: result.obligation.id,
      partyId: customerId,
      idempotencyKey: "partial-payment-1",
      amountMinor: 100n,
      method: "cash",
    });
    expect(codeOf(() => h.service.voidSale(result.sale.id, "customer changed mind"))).toBe("NOT_AVAILABLE");
    expect(h.repository.getVoid(result.sale.id)).toBeUndefined();
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("recovers the original obligation after settlement without changing settlement history", () => {
    const customerId = addParty();
    const request = { idempotencyKey: newKey(), customerId, ...oneItem };
    const original = h.service.createCustomerCreditSale(request);
    h.ledger.settle({
      obligationId: original.obligation.id,
      partyId: customerId,
      idempotencyKey: "credit-recovery-payment-1",
      amountMinor: 100n,
      method: "cash",
    });

    const retry = h.service.createCustomerCreditSale(request);
    expect(retry.duplicate).toBe(true);
    expect(retry.sale).toEqual(original.sale);
    expect(retry.obligation).toEqual(original.obligation);
    expect(
      (h.db.prepare("SELECT amount_minor FROM settlements WHERE obligation_id = ?").all(original.obligation.id) as
        Array<{ amount_minor: bigint }>).map((row) => row.amount_minor),
    ).toEqual([100n]);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    h.db.close();
  });

  it("rechecks current catalog pricing for a new key after repricing", () => {
    const initial = loadCatalog(FIXTURE_CATALOG);
    const mutableProducts = new Map(initial.byId);
    const mutableCatalog = {
      currency: initial.currency,
      products: initial.products,
      byId: mutableProducts,
    } as Catalog;
    resetHarness({ catalog: mutableCatalog });
    const customerId = addParty();
    const first = h.service.createCustomerCreditSale({
      idempotencyKey: newKey(),
      customerId,
      ...oneItem,
    });
    const repriced = loadCatalog({
      ...FIXTURE_CATALOG,
      products: FIXTURE_CATALOG.products.map((product) =>
        product.id === "prod-0001" ? { ...product, price: "2.75" } : product,
      ),
    });
    mutableProducts.set("prod-0001", repriced.byId.get("prod-0001")!);

    expect(
      codeOf(() =>
        h.service.createCustomerCreditSale({
          idempotencyKey: newKey(),
          customerId,
          ...oneItem,
        }),
      ),
    ).toBe("TOTAL_MISMATCH");
    const currentPrice = h.service.createCustomerCreditSale({
      idempotencyKey: newKey(),
      customerId,
      lines: oneItem.lines,
      expectedTotalMinor: 550n,
    });
    expect(currentPrice.sale.total.minor).toBe(550n);
    expect(countRows(h.db)).toMatchObject({ sales: 2, lines: 2 });
    expect(obligationCount()).toBe(2);
    expect(first.sale.total.minor).toBe(500n);
    h.db.close();
  });
});

class FailingSaleRepository extends SaleRepository {
  private lineCalls = 0;
  private verifyCalls = 0;

  constructor(
    db: ConstructorParameters<typeof SaleRepository>[0],
    private readonly fault:
      | "before-header"
      | "after-first-line"
      | "during-second-line"
      | "before-final-verification"
      | "final-verification",
  ) {
    super(db);
  }

  protected override insertSaleHeader(header: NewSaleHeader, receipt: number, lineCount: number): void {
    if (this.fault === "before-header") throw new Error("injected before sale header");
    super.insertSaleHeader(header, receipt, lineCount);
  }

  protected override insertSaleLine(saleId: string, line: NewSaleLine): void {
    this.lineCalls += 1;
    if (this.fault === "during-second-line" && this.lineCalls === 2) {
      throw new Error("injected during second sale line");
    }
    super.insertSaleLine(saleId, line);
    if (this.fault === "after-first-line" && this.lineCalls === 1) {
      throw new Error("injected after first sale line");
    }
  }

  protected override verifySale(saleId: string): void {
    this.verifyCalls += 1;
    if (this.fault === "before-final-verification" && this.verifyCalls === 2) {
      throw new Error("injected before final sale verification");
    }
    super.verifySale(saleId);
    if (this.fault === "final-verification" && this.verifyCalls === 2) {
      throw new Error("injected during final sale verification");
    }
  }
}

class FailingObligationRepository extends LedgerRepository {
  override insertObligation(obligation: NewObligation): void {
    super.insertObligation(obligation);
    throw new Error("injected after obligation insertion");
  }
}

class FailingBeforeObligationRepository extends LedgerRepository {
  override insertObligation(_obligation: NewObligation): void {
    throw new Error("injected before obligation insertion");
  }
}

class HidingObligationRepository extends LedgerRepository {
  override findObligationBySource(): null {
    return null;
  }
}

class ToggleObligationRepository extends LedgerRepository {
  mode: "normal" | "missing" | "throw" | "wrong-party" | "wrong-currency" | "wrong-source" | "wrong-amount" =
    "normal";

  override findObligationBySource(
    sourceKind: Parameters<LedgerRepository["findObligationBySource"]>[0],
    ref: string,
  ) {
    if (this.mode === "throw") throw new Error("injected obligation read failure");
    const record = super.findObligationBySource(sourceKind, ref);
    if (!record) return null;
    if (this.mode === "missing") return null;
    if (this.mode === "wrong-party") return { ...record, partyId: "different-customer" };
    if (this.mode === "wrong-currency") return { ...record, currency: "EUR" };
    if (this.mode === "wrong-source") return { ...record, sourceRef: "different-sale" };
    if (this.mode === "wrong-amount") return { ...record, amountMinor: record.amountMinor + 1n };
    return record;
  }
}

describe("durable-pair recovery failure modes", () => {
  it.each([
    "missing", "throw", "wrong-party", "wrong-currency", "wrong-source", "wrong-amount",
  ] as const)("fails closed on an existing key with %s receivable", (mode) => {
    resetHarness({ ledgerRepository: (db) => new ToggleObligationRepository(db) });
    const customerId = addParty();
    const request = { idempotencyKey: newKey(), customerId, ...oneItem };
    const original = h.service.createCustomerCreditSale(request);
    (h.ledgerStore as ToggleObligationRepository).mode = mode;

    expect(codeOf(() => h.service.createCustomerCreditSale(request))).toBe("LEDGER_INTEGRITY");
    expect(h.repository.getSale(original.sale.id)).toEqual(original.sale);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
    expect(Number((h.db.prepare("SELECT count(*) AS c FROM settlements").get() as { c: bigint }).c)).toBe(0);
  });
});

describe("atomic rollback and uncertain-response recovery", () => {
  it.each([
    "before-header",
    "after-first-line",
    "during-second-line",
    "before-final-verification",
    "final-verification",
  ] as const)(
    "rolls back all rows when sale phase fails: %s",
    (fault) => {
      resetHarness({ repository: (db) => new FailingSaleRepository(db, fault) });
      const customerId = addParty();
      expect(() =>
        h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId, ...twoItems }),
      ).toThrow();
      expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
      expect(obligationCount()).toBe(0);
    },
  );

  it("rolls back the sale and lines when obligation insertion fails after writing", () => {
    resetHarness({ ledgerRepository: (db) => new FailingObligationRepository(db) });
    const customerId = addParty();
    expect(() =>
      h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId, ...oneItem }),
    ).toThrow();
    expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
    expect(obligationCount()).toBe(0);
  });

  it("rolls back the sale and lines when obligation insertion fails before writing", () => {
    resetHarness({ ledgerRepository: (db) => new FailingBeforeObligationRepository(db) });
    const customerId = addParty();
    expect(() =>
      h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId, ...oneItem }),
    ).toThrow();
    expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
    expect(obligationCount()).toBe(0);
  });

  it("treats a one-sided pair lookup as integrity failure and rolls back both records", () => {
    resetHarness({ ledgerRepository: (db) => new HidingObligationRepository(db) });
    const customerId = addParty();
    expect(() =>
      h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId, ...oneItem }),
    ).toThrowError(expect.objectContaining({ code: "LEDGER_INTEGRITY" }));
    expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
    expect(obligationCount()).toBe(0);
  });

  it("rolls back sale, lines, and receivable when the WRITE transaction fails before commit", () => {
    let calls = 0;
    let sawPendingPair = false;
    resetHarness({
      serviceTransact: (db, fn) =>
        db.transaction(() => {
          const result = fn();
          calls += 1;
          // Call 1 is the initial read-only idempotency lookup. Call 2 is the write transaction.
          if (calls === 2) {
            expect(countRows(db)).toMatchObject({ sales: 1, lines: 1 });
            expect(obligationCount()).toBe(1);
            sawPendingPair = true;
            throw new Error("injected immediately before WRITE transaction COMMIT");
          }
          return result;
        }).immediate(),
    });
    const customerId = addParty();
    expect(() =>
      h.service.createCustomerCreditSale({ idempotencyKey: newKey(), customerId, ...oneItem }),
    ).toThrow();
    expect(sawPendingPair).toBe(true);
    expect(calls).toBe(2);
    expect(countRows(h.db)).toMatchObject({ sales: 0, lines: 0 });
    expect(obligationCount()).toBe(0);
  });

  it("recovers a committed pair when the response is lost after COMMIT", () => {
    let loseResponse = false;
    let transactionCalls = 0;
    resetHarness({
      serviceTransact: (db, fn) => {
        const result = db.transaction(fn).immediate();
        transactionCalls += 1;
        if (loseResponse && transactionCalls === 2) {
          loseResponse = false;
          throw new Error("injected lost response after COMMIT");
        }
        return result;
      },
    });
    const customerId = addParty();
    const key = newKey();
    loseResponse = true;
    const recovered = h.service.createCustomerCreditSale({ idempotencyKey: key, customerId, ...oneItem });
    expect(recovered.duplicate).toBe(true);
    expect(recovered.sale.id).toBeDefined();
    expect(recovered.obligation.saleId).toBe(recovered.sale.id);
    expect(countRows(h.db)).toMatchObject({ sales: 1, lines: 1 });
    expect(obligationCount()).toBe(1);
  });
});
