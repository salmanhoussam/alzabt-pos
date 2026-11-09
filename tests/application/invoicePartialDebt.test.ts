import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * INV-PARTIAL-DEBT — OPTION B (owner, DEC-35h, 2026-11-09). Every NEW part-paid invoice puts its
 * remainder on a named customer's account.
 *
 *  - owner only (the existing "issue on account" gate), an ACTIVE linked customer mandatory;
 *  - the paid part is ONE tender — cash, or Whish with a unique reference and confirmed funds;
 *  - the remainder is ONE receivable = the balance (a debt, never a payment record);
 *  - invoice + sale + tender + receivable in ONE transaction, or none of them; a refusal never
 *    consumes an invoice number;
 *  - a part-paid invoice WITHOUT the account path is refused for every role (an untracked
 *    remainder is no longer possible); on account with nothing left owed is refused;
 *  - a repeat after a lost response verifies and writes nothing; a repeat naming a DIFFERENT
 *    payment is refused;
 *  - unpaid-on-account and fully-paid invoices keep their earlier rules; history is untouched.
 *
 * Real SQLite runtime. Every name, amount and reference is synthetic.
 */

let t: TempDir;
let h: Harness;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("expected a DomainError");
}
const n = (sql: string, ...p: unknown[]) => Number((h.db.prepare(sql).get(...p) as { n: bigint }).n);
const footprint = () => ({
  sales: n("SELECT count(*) AS n FROM sales"),
  tenders: n("SELECT count(*) AS n FROM sale_tenders"),
  obligations: n("SELECT count(*) AS n FROM obligations"),
  references: n("SELECT count(*) AS n FROM external_references"),
  final: n("SELECT count(*) AS n FROM invoices WHERE status = 'final'"),
});
const customer = (name = "زبون") => h.parties.create({ kind: "customer", displayName: name }).party;
/** A draft for 100.00 with `paid` marked on it, linked to `customerId` when given. */
function draft(paid: string | null, customerId: string | null = null): string {
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", productId: null, quantity: "1", unitPrice: "100.00" });
  h.invoices.updateDraftHeader(invoice.id, { customerName: "زبون", paid, customerPartyId: customerId });
  return invoice.id;
}
const status = (id: string) =>
  h.db.prepare("SELECT status, invoice_number AS num FROM invoices WHERE id = ?").get(id) as { status: string; num: bigint | null };
const saleRow = (id: string) =>
  h.db.prepare("SELECT id, payment_method AS m, payment_status AS st, paid_minor AS p, balance_due_minor AS b, tender_count AS tc FROM sales WHERE invoice_id = ?").get(id) as {
    id: string; m: string | null; st: string; p: bigint; b: bigint; tc: bigint;
  };
const tenders = (saleId: string) =>
  h.db.prepare("SELECT method, provider, reference, amount_minor AS a FROM sale_tenders WHERE sale_id = ? ORDER BY seq").all(saleId) as Array<Record<string, unknown>>;
const receivables = (saleId: string) =>
  h.db.prepare("SELECT party_id AS party, direction, amount_minor AS a FROM obligations WHERE sale_id = ?").all(saleId) as Array<Record<string, unknown>>;
const CASH = { method: "cash" as const };
const WHISH = (reference: string, fundsConfirmed: unknown = true) => ({ method: "external" as const, whish: { reference, fundsConfirmed } });
const issue = (id: string, payment: unknown) => h.invoices.finalizeInvoice(id, { issueOnAccount: true, payment: payment as never });
const becomeCashier = () => h.service.login("cashier-02", "2222");

describe("a part-paid invoice puts its remainder on the customer's account", () => {
  it("🔴 cash 40 of 100: ONE cash tender of 40, ONE receivable of 60, sale partial — and the statement owes 60", () => {
    const c = customer();
    const id = draft("40.00", c.id);
    const view = issue(id, CASH);
    expect(view.invoice.status).toBe("final");
    expect(view.payment).toEqual({ method: "cash", provider: null, reference: null });
    const s = saleRow(id);
    expect({ m: s.m, st: s.st, p: s.p, b: s.b, tc: s.tc }).toEqual({ m: "cash", st: "partial", p: 4_000n, b: 6_000n, tc: 1n });
    expect(tenders(s.id)).toEqual([{ method: "cash", provider: null, reference: null, a: 4_000n }]);
    expect(receivables(s.id)).toEqual([{ party: c.id, direction: "receivable", a: 6_000n }]);
    const st = h.ledger.statementFor(c.id);
    expect(st.obligations).toHaveLength(1);
    expect(st.obligations[0]!.outstandingMinor).toBe(6_000n);
  });

  it("Whish 25 of 100: the tender carries the reference, which is registered; the debt is 75", () => {
    const c = customer();
    const id = draft("25.00", c.id);
    issue(id, WHISH("WH-PART-1"));
    const s = saleRow(id);
    expect(tenders(s.id)).toEqual([{ method: "external", provider: "whish", reference: "WH-PART-1", a: 2_500n }]);
    expect(receivables(s.id)).toEqual([{ party: c.id, direction: "receivable", a: 7_500n }]);
    expect(n("SELECT count(*) AS n FROM external_references")).toBe(1);
  });

  it("the remainder is collected later through the ordinary ledger, and the invoice stays history", () => {
    const c = customer();
    const id = draft("40.00", c.id);
    issue(id, CASH);
    const obId = (h.db.prepare("SELECT id FROM obligations").get() as { id: string }).id;
    h.ledger.settle({ obligationId: obId, partyId: c.id, idempotencyKey: "inv-part-settle-01", amountMinor: 6_000n, method: "cash" });
    expect(h.ledger.statementFor(c.id).obligations[0]!.outstandingMinor).toBe(0n);
    expect(h.invoices.getInvoice(id).invoice.paid_minor).toBe(4_000n);
  });
});

describe("refusals — nothing written, no number consumed", () => {
  it("🔴 a part-paid invoice WITHOUT the account path is refused for the owner AND the cashier", () => {
    const owner = draft("40.00");
    const before = footprint();
    expect(codeOf(() => h.invoices.finalizeInvoice(owner, { payment: CASH }))).toBe("CREDIT_PARTIAL_NEEDS_ACCOUNT");
    becomeCashier();
    const cashier = draft("40.00", customer().id);
    expect(codeOf(() => h.invoices.finalizeInvoice(cashier, { payment: CASH }))).toBe("CREDIT_PARTIAL_NEEDS_ACCOUNT");
    // …and a cashier cannot take the account path either.
    expect(codeOf(() => issue(cashier, CASH))).toBe("CREDIT_OWNER_ONLY");
    expect(footprint()).toEqual(before);
    expect(status(owner)).toEqual({ status: "draft", num: null });
    expect(status(cashier)).toEqual({ status: "draft", num: null });
  });

  it("no customer, or an archived customer → refused", () => {
    const before = footprint();
    expect(codeOf(() => issue(draft("40.00"), CASH))).toBe("CREDIT_NEEDS_CUSTOMER");
    const gone = customer("مؤرشف");
    const id = draft("40.00", gone.id);
    h.parties.setActive("customer", gone.id, false);
    expect(codeOf(() => issue(id, CASH))).toBe("PARTY_NOT_FOUND");
    expect(footprint()).toEqual(before);
    expect(status(id).num).toBeNull();
  });

  it("on account with NOTHING left owed (paid = total) → CREDIT_NOTHING_OWED", () => {
    const id = draft("100.00", customer().id);
    const before = footprint();
    expect(codeOf(() => issue(id, CASH))).toBe("CREDIT_NOTHING_OWED");
    expect(footprint()).toEqual(before);
    expect(status(id)).toEqual({ status: "draft", num: null });
  });

  it("paid more than the total, or negative, is refused where it is typed", () => {
    const id = draft(null, customer().id);
    expect(codeOf(() => h.invoices.updateDraftHeader(id, { paid: "-1.00" }))).not.toBe("NO_ERROR");
    expect(codeOf(() => h.invoices.updateDraftHeader(id, { paid: "150.00" }))).not.toBe("NO_ERROR");
    expect(h.invoices.getInvoice(id).invoice.paid_minor).toBe(0n);
    expect(status(id).num).toBeNull();
  });

  it("a paid part with no method, Card / Other, Whish without reference or confirmation → refused", () => {
    const id = draft("40.00", customer().id);
    const before = footprint();
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true }))).toBe("INVOICE_PAYMENT_METHOD_REQUIRED");
    expect(codeOf(() => issue(id, { method: "card" }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(codeOf(() => issue(id, { method: "other" }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(codeOf(() => issue(id, WHISH("  ")))).toBe("INVALID_INPUT");
    expect(codeOf(() => issue(id, WHISH("WH-NO-CONF", false)))).toBe("FUNDS_NOT_CONFIRMED");
    expect(footprint()).toEqual(before);
    expect(status(id)).toEqual({ status: "draft", num: null });
  });

  it("🔴 a Whish reference already used refuses the WHOLE issue; the number stays free", () => {
    h.service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: "prod-0001", quantityMilli: 2000 }],
      expectedTotalMinor: 500n,
      paymentMethod: "external",
      whish: { reference: "WH-USED", fundsConfirmed: true },
    });
    const id = draft("40.00", customer().id);
    const before = footprint();
    expect(codeOf(() => issue(id, WHISH("WH-USED")))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(footprint()).toEqual(before);
    expect(status(id)).toEqual({ status: "draft", num: null });
    expect(Number(issue(id, CASH).invoice.invoice_number)).toBe(1);
  });

  it("🔴 ROLLBACK: a failure while posting the receivable undoes the number, sale, tender and reference", () => {
    const id = draft("40.00", customer().id);
    const before = footprint();
    const deps = (h.invoices as unknown as { deps: { credit: { postReceivable: (...a: unknown[]) => unknown } } }).deps;
    const real = deps.credit.postReceivable;
    deps.credit.postReceivable = () => {
      throw new Error("injected failure after the sale and its tender were written");
    };
    expect(() => issue(id, WHISH("WH-ROLLBACK"))).toThrow(/injected failure/);
    deps.credit.postReceivable = real;
    expect(footprint()).toEqual(before);
    expect(status(id)).toEqual({ status: "draft", num: null });
    // The reference was NOT kept by the failed attempt: the same honest issue now succeeds as #1.
    expect(Number(issue(id, WHISH("WH-ROLLBACK")).invoice.invoice_number)).toBe(1);
  });
});

describe("repeats — double click, lost response", () => {
  it("🔴 the SAME request again verifies and writes nothing", () => {
    const id = draft("40.00", customer().id);
    const first = issue(id, WHISH("WH-REPLAY"));
    const after = footprint();
    const again = issue(id, WHISH("WH-REPLAY"));
    expect(again.invoice.invoice_number).toBe(first.invoice.invoice_number);
    expect(again.payment).toEqual({ method: "external", provider: "whish", reference: "WH-REPLAY" });
    expect(footprint()).toEqual(after);
  });

  it("a repeat naming a DIFFERENT payment (or none) is refused and writes nothing", () => {
    const id = draft("40.00", customer().id);
    issue(id, WHISH("WH-ONE"));
    const after = footprint();
    expect(codeOf(() => issue(id, WHISH("WH-TWO")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => issue(id, CASH))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toEqual(after);
  });

  it("an ordinary (non-account) repeat of a final invoice is refused as already final", () => {
    const id = draft("40.00", customer().id);
    issue(id, CASH);
    const after = footprint();
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: CASH }))).not.toBe("NO_ERROR");
    expect(footprint()).toEqual(after);
  });
});

describe("unchanged rules for unpaid and fully paid invoices", () => {
  it("an UNPAID invoice on account still records no method and a receivable of the whole total", () => {
    const c = customer();
    const id = draft(null, c.id);
    const view = h.invoices.finalizeInvoice(id, { issueOnAccount: true });
    expect(view.payment).toBeUndefined();
    const s = saleRow(id);
    expect({ m: s.m, st: s.st, tc: s.tc }).toEqual({ m: null, st: "unpaid", tc: 0n });
    expect(receivables(s.id)).toEqual([{ party: c.id, direction: "receivable", a: 10_000n }]);
    // and its repeat (no payment) still verifies
    expect(h.invoices.finalizeInvoice(id, { issueOnAccount: true }).invoice.status).toBe("final");
  });

  it("a FULLY paid invoice: a cashier issues it as before, no debt", () => {
    becomeCashier();
    const id = draft("100.00");
    h.invoices.finalizeInvoice(id, { payment: CASH });
    expect(saleRow(id).st).toBe("paid");
    expect(footprint().obligations).toBe(0);
  });

  it("an unpaid invoice WITHOUT an account is still issued ordinarily (no invented debt)", () => {
    becomeCashier();
    const id = draft(null);
    h.invoices.finalizeInvoice(id);
    expect(saleRow(id).st).toBe("unpaid");
    expect(footprint().obligations).toBe(0);
  });
});

describe("historic audit — invoices with an amount left and NO debt (read-only, never repaired)", () => {
  it("lists the untracked balances, skips account and fully paid invoices, and writes nothing", async () => {
    const { listUntrackedInvoiceBalances } = await import("../../scripts/untrackedInvoiceBalances");
    const c = customer();
    const unpaidPlain = draft(null);
    h.invoices.finalizeInvoice(unpaidPlain); // ordinary unpaid: no debt by design → listed as "unpaid"
    issue(draft("40.00", c.id), CASH); // on account → NOT listed
    h.invoices.finalizeInvoice(draft("100.00"), { payment: CASH }); // fully paid → NOT listed
    // Real rows cover unpaid / on account / paid; a historic PARTIAL row is covered just below.
    const before = footprint();
    const list = listUntrackedInvoiceBalances(h.db);
    expect(list.map((r) => [r.invoiceNumber, r.kind, r.balanceDueMinor])).toEqual([[1, "unpaid", 10_000n]]);
    expect(footprint()).toEqual(before);
  });
});

describe("historic audit — a part-paid invoice from BEFORE Option B is labelled partial", () => {
  it("classifies on the stored figures (minimal read-only schema, since the service can no longer write one)", async () => {
    const { listUntrackedInvoiceBalances } = await import("../../scripts/untrackedInvoiceBalances");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE invoices (id TEXT, invoice_number INTEGER, invoice_date TEXT, customer_name TEXT, currency TEXT,
               total_minor INTEGER, paid_minor INTEGER, balance_due_minor INTEGER, status TEXT);
             CREATE TABLE sales (id TEXT, invoice_id TEXT);
             CREATE TABLE obligations (sale_id TEXT, direction TEXT);
             INSERT INTO invoices VALUES ('a', 7, '2026-10-01', 'زبون قديم', 'USD', 10000, 4000, 6000, 'final');
             INSERT INTO sales VALUES ('sa', 'a');
             INSERT INTO invoices VALUES ('b', 8, '2026-10-02', 'زبون', 'USD', 10000, 4000, 6000, 'final');
             INSERT INTO sales VALUES ('sb', 'b');
             INSERT INTO obligations VALUES ('sb', 'receivable');`);
    expect(listUntrackedInvoiceBalances(db)).toEqual([
      { invoiceNumber: 7, invoiceDate: "2026-10-01", customerName: "زبون قديم", currency: "USD", totalMinor: 10_000n, paidMinor: 4_000n, balanceDueMinor: 6_000n, kind: "partial" },
    ]);
    db.close();
  });
});
