/**
 * SELL-CUSTOMER-LINK (ACC-2): a PAID till sale may name its customer, by id; the owner's statement
 * lists those sales as activity. Through the REAL service, IPC handlers and SQLite. Synthetic data.
 *
 * 🔴 WHAT MUST HOLD, AND WHY EACH ASSERTION IS HERE:
 *   - a sale with no customer is byte-for-byte the sale it always was, fingerprint included;
 *   - a linked sale is still PAID in full: balance due 0, no obligation, no change to any balance;
 *   - the customer is an ACTIVE customer by id, checked inside the sale transaction;
 *   - a key reused for a different customer (or for none) is a different request;
 *   - the statement lists a paid sale once, apart from the debts, and adds it to no total.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { priceCart } from "../../src/domain/cart";
import { DomainError } from "../../src/domain/errors";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { CustomerStatementDto } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const LINES = [{ productId: "prod-0001", quantityMilli: 2000 }] as const;
const total = () => priceCart(h.service.getCatalog(), LINES).total.minor;
let n = 0;
const key = () => `acc2-key-${String(++n).padStart(6, "0")}`;
const sell = (customerId?: string | null, k = key()) =>
  h.service.createSale({ idempotencyKey: k, lines: LINES, paymentMethod: "cash", expectedTotalMinor: total(), customerId });
const count = (sql: string, ...args: unknown[]) => Number((h.db.prepare(sql).get(...args) as { n: bigint | number }).n);
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : `not-a-domain-error: ${String(e)}`;
  }
};
const customer = (displayName = "زبون مرتبط") => h.parties.create({ kind: "customer", displayName }).party;
const statement = (id: string) => {
  const r = ipc.getCustomerStatement({ customerId: id }) as { ok: true; data: CustomerStatementDto } | { ok: false; error: { code: string } };
  if (!r.ok) throw new Error(`statement refused: ${r.error.code}`);
  return r.data;
};

describe("a sale WITHOUT a customer is exactly the sale it always was", () => {
  it("🔴 customerId null and the LEGACY fingerprint, byte-identical to the pre-ACC-2 formula", () => {
    const k = key();
    const { sale } = sell(undefined, k);
    expect(sale.customerId).toBeNull();
    expect(sale.customerNameSnapshot).toBeNull();
    const legacy = createHash("sha256")
      .update(
        JSON.stringify({
          cashierId: "cashier-01",
          paymentMethod: "cash",
          lines: LINES.map((l) => [l.productId, l.quantityMilli]),
          expectedTotalMinor: total().toString(),
        }),
      )
      .digest("hex");
    expect(h.repository.findByIdempotencyKey(k)!.fingerprint).toBe(legacy);
    // null behaves as absent.
    const again = sell(null, k);
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(sale.id);
  });
});

describe("a PAID sale linked to an active customer", () => {
  it("🔴 stores the id and the account's name snapshot — and is still paid in full, with NO obligation", () => {
    const c = customer();
    const { sale, duplicate } = sell(c.id);
    expect(duplicate).toBe(false);
    expect(sale.customerId).toBe(c.id);
    expect(sale.customerNameSnapshot).toBe("زبون مرتبط");
    expect(sale.paymentStatus).toBe("paid");
    expect(sale.balanceDue.minor).toBe(0n);
    expect(sale.paid.minor).toBe(sale.total.minor);
    // And the stored row agrees, read straight from SQLite.
    expect(
      h.db.prepare("SELECT payment_status AS s, balance_due_minor AS b, customer_id AS c FROM sales WHERE id = ?").get(sale.id),
    ).toEqual({ s: "paid", b: 0n, c: c.id });
    expect(count("SELECT count(*) AS n FROM obligations")).toBe(0);
    expect(count("SELECT count(*) AS n FROM settlements")).toBe(0);
  });

  it("🔴 the snapshot is history: renaming the account later does not rewrite the sale", () => {
    const c = customer("الاسم القديم");
    const { sale } = sell(c.id);
    h.parties.updateContact("customer", c.id, { displayName: "الاسم الجديد" });
    expect(h.repository.getSale(sale.id)!.customerNameSnapshot).toBe("الاسم القديم");
  });

  it("a granted-nothing CASHIER may link a customer to a paid sale (the existing sale permission)", () => {
    const c = customer();
    h.service.logout();
    h.service.login("cashier-02", "2222");
    const { sale } = sell(c.id);
    expect(sale.customerId).toBe(c.id);
    expect(sale.cashierId).toBe("cashier-02");
  });
});

describe("🔴 the customer is checked by id, as an ACTIVE customer, inside the sale transaction", () => {
  it("an archived customer is refused and NOTHING is written — no sale, no receipt number used", () => {
    const c = customer();
    h.parties.setActive("customer", c.id, false);
    const before = count("SELECT count(*) AS n FROM sales");
    expect(code(() => sell(c.id))).toBe("PARTY_NOT_FOUND");
    expect(count("SELECT count(*) AS n FROM sales")).toBe(before);
    // The next ordinary sale still gets receipt number 1: the refused one consumed nothing.
    expect(sell().sale.receiptNumber).toBe(1);
  });

  it("a NAME is not an account: the display name, an unknown id and a supplier id are all refused", () => {
    const c = customer("سمير");
    const supplier = h.parties.create({ kind: "supplier", displayName: "مورّد" }).party;
    for (const wrong of ["سمير", "no-such-account", supplier.id]) {
      expect(code(() => sell(wrong)), wrong).toBe("PARTY_NOT_FOUND");
    }
    expect(c.id).not.toBe("سمير");
    expect(count("SELECT count(*) AS n FROM sales")).toBe(0);
  });

  it("an empty or oversized id is refused as input, before anything is read", () => {
    expect(code(() => sell(""))).toBe("INVALID_INPUT");
    expect(code(() => sell("x".repeat(101)))).toBe("INVALID_INPUT");
  });

  it("🔴 a failure AFTER the check rolls the whole sale back — no partial posting", () => {
    const c = customer();
    const original = h.repository.commitSaleWithinTransaction.bind(h.repository);
    h.repository.commitSaleWithinTransaction = (header, lines) => {
      original(header, lines);
      throw new DomainError("LEDGER_INTEGRITY", "injected after the write");
    };
    expect(code(() => sell(c.id))).toBe("LEDGER_INTEGRITY");
    h.repository.commitSaleWithinTransaction = original;
    expect(count("SELECT count(*) AS n FROM sales")).toBe(0);
    expect(count("SELECT count(*) AS n FROM sale_lines")).toBe(0);
  });
});

describe("🔴 idempotency with a customer", () => {
  it("the same request and key returns the SAME sale once", () => {
    const c = customer();
    const k = key();
    const first = sell(c.id, k);
    const again = sell(c.id, k);
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    expect(count("SELECT count(*) AS n FROM sales")).toBe(1);
  });

  it("the same key for ANOTHER customer, or for no customer, is a conflict — never a second sale", () => {
    const a = customer("أ");
    const b = customer("ب");
    const k = key();
    sell(a.id, k);
    expect(code(() => sell(b.id, k))).toBe("IDEMPOTENCY_CONFLICT");
    expect(code(() => sell(undefined, k))).toBe("IDEMPOTENCY_CONFLICT");
    const legacyKey = key();
    sell(undefined, legacyKey);
    expect(code(() => sell(a.id, legacyKey))).toBe("IDEMPOTENCY_CONFLICT");
    expect(count("SELECT count(*) AS n FROM sales")).toBe(2);
  });

  it("an exact replay still answers after the customer was archived (the sale already exists)", () => {
    const c = customer();
    const k = key();
    const first = sell(c.id, k);
    h.parties.setActive("customer", c.id, false);
    const again = sell(c.id, k);
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
  });
});

describe("🔴 the owner's statement: paid sales are activity, never debt", () => {
  it("lists the linked paid sale ONCE, apart from the debts, and leaves every balance unchanged", () => {
    const c = customer();
    // A real debt first: an atomic credit sale (owner) posts one receivable.
    const credit = h.service.createCustomerCreditSale({ idempotencyKey: key(), customerId: c.id, lines: LINES, expectedTotalMinor: total() });
    const before = statement(c.id);
    expect(before.obligations).toHaveLength(1);
    expect(before.paidSales).toEqual([]);

    const { sale } = sell(c.id);
    const after = statement(c.id);
    expect(after.paidSales).toEqual([
      {
        saleId: sale.id,
        receiptNumber: sale.receiptNumber,
        total: { minor: sale.total.minor.toString(), currency: sale.total.currency },
        paymentMethod: "cash",
        completedAt: sale.completedAt,
        voided: false,
      },
    ]);
    // 🔴 The credit sale is NOT repeated as activity — it appears once, as its obligation.
    expect(after.paidSales.map((p) => p.saleId)).not.toContain(credit.sale.id);
    // 🔴 No new obligation and the outstanding balance is exactly what it was.
    expect(after.obligations).toEqual(before.obligations);
    expect(after.balances).toEqual(before.balances);
  });

  it("a sale linked to ANOTHER customer, or to none, never appears in this customer's history", () => {
    const a = customer("أ");
    const b = customer("ب");
    sell(b.id);
    sell();
    expect(statement(a.id).paidSales).toEqual([]);
    expect(statement(b.id).paidSales).toHaveLength(1);
  });

  it("a voided linked sale stays in the history, marked voided, and still adds to no balance", () => {
    const c = customer();
    const { sale } = sell(c.id);
    h.service.voidSale(sale.id, "wrong item rung up");
    const s = statement(c.id);
    expect(s.paidSales).toHaveLength(1);
    expect(s.paidSales[0]).toMatchObject({ saleId: sale.id, voided: true });
    expect(s.balances).toEqual([]);
    expect(s.obligations).toEqual([]);
  });

  it("an archived customer's history is kept: their earlier linked sale is still listed", () => {
    const c = customer();
    const { sale } = sell(c.id);
    h.parties.setActive("customer", c.id, false);
    expect(statement(c.id).paidSales.map((p) => p.saleId)).toEqual([sale.id]);
  });

  it("🔴 the history stays OWNER-ONLY: a cashier is refused the statement and the paid-sale read", () => {
    const c = customer();
    sell(c.id);
    h.service.logout();
    h.service.login("cashier-02", "2222");
    const r = ipc.getCustomerStatement({ customerId: c.id }) as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("NOT_AUTHORIZED");
    expect(code(() => h.service.customerPaidSales(c.id))).toBe("NOT_AUTHORIZED");
  });
});

describe("the createSale channel", () => {
  const request = (extra: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    lines: LINES.map((l) => ({ ...l })),
    paymentMethod: "cash",
    expectedTotalMinor: total().toString(),
    ...extra,
  });

  it("accepts the one optional key `customerId` and links the sale", () => {
    const c = customer();
    const r = ipc.createSale(request({ customerId: c.id })) as { ok: true; data: { sale: { id: string } } };
    expect(r.ok).toBe(true);
    expect(h.repository.getSale(r.data.sale.id)!.customerId).toBe(c.id);
  });

  it("🔴 the renderer still cannot choose a name, a snapshot or a status — and customerId must be text", () => {
    const c = customer();
    for (const extra of [
      { customerName: "اسم مختلق" },
      { customerNameSnapshot: "اسم مختلق" },
      { paymentStatus: "unpaid" },
      { customerId: 42 },
      { customerId: null },
    ]) {
      const r = ipc.createSale(request({ ...extra, ...(extra.customerId === undefined ? { customerId: c.id } : {}) })) as {
        ok: boolean;
        error?: { code: string };
      };
      expect(r.ok, JSON.stringify(extra)).toBe(false);
      expect(r.error?.code, JSON.stringify(extra)).toBe("INVALID_INPUT");
    }
    expect(count("SELECT count(*) AS n FROM sales")).toBe(0);
  });

  it("without the key the channel behaves exactly as before", () => {
    const r = ipc.createSale(request()) as { ok: true; data: { sale: { id: string } } };
    expect(r.ok).toBe(true);
    expect(h.repository.getSale(r.data.sale.id)!.customerId).toBeNull();
  });
});
