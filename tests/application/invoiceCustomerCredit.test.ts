/**
 * Migration 16 — an invoice names its customer ACCOUNT, and the owner may issue it ON that account.
 *
 * 🔴 THE INVARIANTS UNDER TEST
 *   · linking is by account id: two customers with the same name stay two accounts;
 *   · linking alone, or an ordinary finalization of a linked invoice, creates NO debt;
 *   · "issue on account" is explicit, owner-only, needs a customer and a wholly unpaid total;
 *   · it finalizes ONE invoice, ONE invoice-origin sale (customer_id stays NULL, M14) and ONE
 *     receivable in a single transaction, verified by reading them back — or none of them;
 *   · a repeat after a lost response verifies and never writes again; unverifiable → LEDGER_INTEGRITY.
 *
 * Real SQLite runtime. Every name, amount and id is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let seq = 0;

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
  seq = 0;
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const line = (price = "10.00") => ({
  description: "صنف",
  unitLabel: "حبة",
  canonicalUnit: null,
  productId: null,
  quantity: "1",
  unitPrice: price,
});
const draft = (price = "10.00") => {
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLines(invoice.id, [line(price)], `batch-credit-${(seq += 1)}-key`);
  return invoice.id;
};
const customer = (name = "زبون") => h.parties.create({ kind: "customer", displayName: name }).party;
const supplier = (name = "مورّد") => h.parties.create({ kind: "supplier", displayName: name }).party;
const n = (sql: string, ...args: unknown[]) => Number((h.db.prepare(sql).get(...args) as { n: bigint }).n);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};
const link = (invoiceId: string, customerPartyId: string | null) =>
  h.invoices.updateDraftHeader(invoiceId, { customerPartyId });
const onAccount = (id: string) => h.invoices.finalizeInvoice(id, { issueOnAccount: true });
const obligations = () => n("SELECT count(*) AS n FROM obligations");
const sales = () => n("SELECT count(*) AS n FROM sales");
const becomeCashier = () => h.service.login("cashier-02", "2222");

describe("linking an invoice to a customer account", () => {
  it("🔴 two customers with the SAME name stay distinct — the link is the id, never the name", () => {
    const a = customer("أحمد");
    const b = customer("أحمد");
    expect(a.id).not.toBe(b.id);
    const id = draft();
    expect(link(id, a.id).invoice.customer_party_id).toBe(a.id);
    expect(link(id, b.id).invoice.customer_party_id).toBe(b.id);
    // The printed name is independent: linking does not write it and typing it does not link.
    const typed = h.invoices.updateDraftHeader(id, { customerName: "أحمد" });
    expect(typed.invoice.customer_party_id).toBe(b.id);
    expect(link(id, null).invoice.customer_name).toBe("أحمد");
    expect(h.invoices.getInvoice(id).invoice.customer_party_id).toBeNull();
  });

  it("🔴 linking alone creates no debt, no sale and no receivable", () => {
    const c = customer();
    const id = draft("25.00");
    link(id, c.id);
    expect(obligations()).toBe(0);
    expect(sales()).toBe(0);
  });

  it("🔴 an ordinary finalization of a LINKED invoice still creates no debt", () => {
    const c = customer();
    const id = draft("25.00");
    link(id, c.id);
    const final = h.invoices.finalizeInvoice(id).invoice;
    expect(final.status).toBe("final");
    expect(final.customer_party_id).toBe(c.id);
    expect(sales()).toBe(1);
    expect(obligations()).toBe(0);
  });

  it("refuses a missing, inactive or supplier account and keeps the previous link", () => {
    const keep = customer("باقٍ");
    const gone = customer("مؤرشف");
    const sup = supplier();
    const id = draft();
    link(id, keep.id);
    h.parties.setActive("customer", gone.id, false);
    for (const bad of ["no-such-account", gone.id, sup.id]) {
      expect(code(() => link(id, bad))).toBe("PARTY_NOT_FOUND");
    }
    expect(h.invoices.getInvoice(id).invoice.customer_party_id).toBe(keep.id);
  });

  it("the database itself refuses a link to a supplier", () => {
    const sup = supplier();
    const id = draft();
    expect(() => h.db.prepare("UPDATE invoices SET customer_party_id = ? WHERE id = ?").run(sup.id, id)).toThrow(
      /active customer/,
    );
  });
});

describe("issuing on a customer account", () => {
  it("🔴 finalizes ONE invoice, ONE invoice sale and ONE matching receivable, atomically", () => {
    const c = customer();
    const id = draft("25.00");
    link(id, c.id);
    const view = onAccount(id);
    const final = view.invoice;
    expect(final.status).toBe("final");
    expect(final.total_minor).toBe(2500n);
    expect(final.paid_minor).toBe(0n);
    expect(final.balance_due_minor).toBe(2500n);

    expect(n("SELECT count(*) AS n FROM invoices WHERE status = 'final'")).toBe(1);
    expect(sales()).toBe(1);
    const sale = h.db.prepare("SELECT * FROM sales WHERE invoice_id = ?").get(id) as Record<string, unknown>;
    expect(sale.source_type).toBe("invoice");
    expect(sale.customer_id).toBeNull(); // M14: invoice sales carry no customer_id
    expect(sale.payment_status).toBe("unpaid");
    expect(obligations()).toBe(1);
    const ob = h.db.prepare("SELECT * FROM obligations").get() as Record<string, unknown>;
    expect(ob.party_id).toBe(c.id);
    expect(ob.direction).toBe("receivable");
    expect(ob.source_kind).toBe("sale");
    expect(ob.sale_id).toBe(sale.id);
    expect(ob.amount_minor).toBe(2500n);
    expect(ob.currency).toBe(final.currency);
    // Reconciliation is preserved exactly as for any finalization.
    expect(n("SELECT count(*) AS n FROM invoice_reconciliation WHERE invoice_id = ?", id)).toBe(1);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("includes tax in the receivable — the debt is the document's total", () => {
    const c = customer();
    const id = draft("100.00");
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "11" });
    link(id, c.id);
    onAccount(id);
    expect(h.db.prepare("SELECT amount_minor AS a FROM obligations").get()).toEqual({ a: 11100n });
  });

  it("🔴 the customer statement shows it, and a payment settles it without touching the invoice", () => {
    const c = customer();
    const id = draft("30.00");
    link(id, c.id);
    const final = onAccount(id).invoice;
    const st = h.ledger.statementFor(c.id);
    expect(st.obligations).toHaveLength(1);
    expect(st.obligations[0]!.outstandingMinor).toBe(3000n);
    const obId = st.obligations[0]!.obligation.id;
    h.ledger.settle({ obligationId: obId, partyId: c.id, idempotencyKey: "pay-key-000001", amountMinor: 1000n, method: "cash" });
    expect(h.ledger.statementFor(c.id).obligations[0]!.outstandingMinor).toBe(2000n);
    const after = h.invoices.getInvoice(id).invoice;
    expect(after.paid_minor).toBe(0n); // the invoice is history; the ledger carries the payment
    expect(after.total_minor).toBe(final.total_minor);
  });

  it("🔴 refuses without a linked customer, with something paid, or for a cashier — and changes nothing", () => {
    const c = customer();
    const noCustomer = draft();
    expect(code(() => onAccount(noCustomer))).toBe("CREDIT_NEEDS_CUSTOMER");

    const part = draft("50.00");
    link(part, c.id);
    h.invoices.updateDraftHeader(part, { paid: "10.00" });
    expect(code(() => onAccount(part))).toBe("CREDIT_NEEDS_UNPAID");

    const plain = draft();
    link(plain, c.id);
    becomeCashier();
    expect(code(() => onAccount(plain))).toBe("CREDIT_OWNER_ONLY");
    // …and a cashier can still do the ordinary thing.
    expect(h.invoices.finalizeInvoice(plain).invoice.status).toBe("final");

    expect(obligations()).toBe(0);
    expect(n("SELECT count(*) AS n FROM invoices WHERE status = 'draft'")).toBe(2);
    expect(sales()).toBe(1); // only the cashier's ordinary one
  });

  it("re-reads the account at finalization: an account archived after linking is refused", () => {
    const c = customer();
    const id = draft();
    link(id, c.id);
    h.parties.setActive("customer", c.id, false);
    expect(code(() => onAccount(id))).toBe("PARTY_NOT_FOUND");
    expect(h.invoices.getInvoice(id).invoice.status).toBe("draft");
    expect(obligations() + sales()).toBe(0);
  });

  it("🔴 a failure while posting rolls EVERYTHING back — draft, number, sale, receivable, reconciliation", () => {
    const c = customer();
    const id = draft("25.00");
    link(id, c.id);
    h.db.exec("CREATE TRIGGER test_ob_fails BEFORE INSERT ON obligations BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    expect(() => onAccount(id)).toThrow();
    h.db.exec("DROP TRIGGER test_ob_fails");
    expect(h.invoices.getInvoice(id).invoice.status).toBe("draft");
    expect(h.invoices.getInvoice(id).invoice.invoice_number).toBeNull();
    expect(sales()).toBe(0);
    expect(obligations()).toBe(0);
    expect(n("SELECT count(*) AS n FROM invoice_reconciliation")).toBe(0);
    // The number was not consumed: the retry gets the first number.
    expect(Number(onAccount(id).invoice.invoice_number)).toBe(1);
    expect(obligations()).toBe(1);
  });
});

describe("lost response and verification", () => {
  it("🔴 a repeat after a committed request verifies and never writes a second sale or receivable", () => {
    const c = customer();
    const id = draft("25.00");
    link(id, c.id);
    const first = onAccount(id).invoice;
    const again = onAccount(id).invoice; // the response was "lost"; the caller asks again
    expect(again.invoice_number).toBe(first.invoice_number);
    expect(n("SELECT count(*) AS n FROM invoices WHERE status = 'final'")).toBe(1);
    expect(sales()).toBe(1);
    expect(obligations()).toBe(1);
  });

  it("an on-account request for an invoice issued the ordinary way is refused, not reported as done", () => {
    const c = customer();
    const id = draft();
    link(id, c.id);
    h.invoices.finalizeInvoice(id);
    expect(code(() => onAccount(id))).toBe("CREDIT_NOT_ISSUED");
    expect(obligations()).toBe(0);
  });

  it("🔴 replay rejects a sale whose financial total was damaged after issue", () => {
    const c = customer();
    const id = draft("25.00");
    link(id, c.id);
    onAccount(id);
    // Simulate corruption while retaining internally consistent header arithmetic. Production
    // protects the row with an immutable UPDATE trigger; this test bypasses it deliberately.
    h.db.exec("DROP TRIGGER sales_immutable_update");
    h.db.prepare(`UPDATE sales SET subtotal_minor = subtotal_minor + 100,
        total_minor = total_minor + 100, balance_due_minor = balance_due_minor + 100
        WHERE invoice_id = ?`).run(id);
    expect(code(() => onAccount(id))).toBe("LEDGER_INTEGRITY");
    expect(sales()).toBe(1);
    expect(obligations()).toBe(1);
  });

  it("fails closed with LEDGER_INTEGRITY when the recorded receivable cannot be verified", () => {
    const c = customer();
    const id = draft("25.00");
    link(id, c.id);
    onAccount(id);
    h.db.exec("DROP TRIGGER obligations_immutable_update");
    h.db.exec("UPDATE obligations SET amount_minor = 1");
    expect(code(() => onAccount(id))).toBe("LEDGER_INTEGRITY");
    expect(obligations()).toBe(1);
  });
});

describe("immutability and database-level protection", () => {
  it("the issued invoice, its link and its receivable can no longer be changed", () => {
    const a = customer("أ");
    const b = customer("ب");
    const id = draft();
    link(id, a.id);
    onAccount(id);
    expect(code(() => link(id, b.id))).toBe("INVOICE_NOT_DRAFT");
    expect(() => h.db.prepare("UPDATE invoices SET customer_party_id = ? WHERE id = ?").run(b.id, id)).toThrow();
    expect(() => h.db.prepare("UPDATE obligations SET party_id = ?").run(b.id)).toThrow(/immutable/);
    expect(() => h.db.prepare("DELETE FROM obligations").run()).toThrow(/cannot be deleted/);
  });

  it("🔴 a receivable cannot be forged against an invoice sale — wrong customer, amount or direction", () => {
    const a = customer("أ");
    const b = customer("ب");
    const id = draft("25.00");
    link(id, a.id);
    h.invoices.finalizeInvoice(id); // ordinary: no debt
    const saleId = (h.db.prepare("SELECT id FROM sales WHERE invoice_id = ?").get(id) as { id: string }).id;
    const post = (partyId: string, amountMinor: bigint) =>
      h.ledger.postObligation({ partyId, direction: "receivable", sourceKind: "sale", sourceRef: saleId, currency: "USD", amountMinor });
    expect(() => post(b.id, 2500n)).toThrow(/invoice customer/); // another customer
    expect(() => post(a.id, 100n)).toThrow(/invoice customer/); // not the unpaid balance
    expect(obligations()).toBe(0);
  });

  it("an unlinked invoice's sale can never carry a receivable", () => {
    const a = customer();
    const id = draft();
    h.invoices.finalizeInvoice(id);
    const saleId = (h.db.prepare("SELECT id FROM sales WHERE invoice_id = ?").get(id) as { id: string }).id;
    expect(() =>
      h.ledger.postObligation({ partyId: a.id, direction: "receivable", sourceKind: "sale", sourceRef: saleId, currency: "USD", amountMinor: 1000n }),
    ).toThrow(/invoice customer/);
  });
});

describe("ordinary invoices are unchanged", () => {
  it("paid, partial and unpaid unlinked invoices finalize exactly as before", () => {
    const paid = draft("20.00");
    h.invoices.updateDraftHeader(paid, { paid: "20.00" });
    const partial = draft("20.00");
    h.invoices.updateDraftHeader(partial, { paid: "5.00" });
    const unpaid = draft("20.00");
    const statuses = [paid, partial, unpaid].map((i) => {
      h.invoices.finalizeInvoice(i);
      return (h.db.prepare("SELECT payment_status AS s FROM sales WHERE invoice_id = ?").get(i) as { s: string }).s;
    });
    expect(statuses).toEqual(["paid", "partial", "unpaid"]);
    expect(obligations()).toBe(0);
    expect(n("SELECT count(*) AS n FROM invoices WHERE customer_party_id IS NOT NULL")).toBe(0);
  });
});
