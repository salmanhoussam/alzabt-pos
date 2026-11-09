import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * INV-PAY-METHOD (owner, 2026-11-09) — an invoice marked paid records HOW the money arrived.
 *
 * What this file holds the INVOICE SERVICE to:
 *  - money marked paid needs a method AT ISSUE: cash, or Whish Money with its reference and an explicit
 *    confirmation; without one the issue is refused BEFORE the number is taken; nothing paid takes none;
 *  - the paid amount becomes ONE tender of that method on the invoice's sale, in the issue transaction;
 *  - a Whish reference already used anywhere refuses the WHOLE issue — no number, no sale, no tender;
 *  - a fully paid invoice creates NO debt; Card / Other / bank are refused (P3);
 *  - the invoice view carries `payment` only when a method was recorded — old and unpaid ones unchanged;
 *  - issuing again never writes a second sale or tender; the issue permission is unchanged.
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

/** A draft for 100.00 with `paid` marked on it. */
function draft(paid: string | null): string {
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", productId: null, quantity: "1", unitPrice: "100.00" });
  h.invoices.updateDraftHeader(invoice.id, { customerName: "زبون", paid });
  return invoice.id;
}
const status = (id: string) => (h.db.prepare("SELECT status, invoice_number AS num FROM invoices WHERE id = ?").get(id) as { status: string; num: bigint | null });
const saleRow = (id: string) =>
  h.db.prepare("SELECT id, payment_method AS m, payment_status AS st, paid_minor AS p, balance_due_minor AS b, tender_count AS tc FROM sales WHERE invoice_id = ?").get(id) as {
    id: string; m: string | null; st: string; p: bigint; b: bigint; tc: bigint;
  };
const tenderRows = (saleId: string) =>
  h.db.prepare("SELECT method, provider, reference, amount_minor AS a FROM sale_tenders WHERE sale_id = ? ORDER BY seq").all(saleId) as Array<Record<string, unknown>>;
const WHISH = (reference: string, fundsConfirmed: unknown = true) => ({ method: "external" as const, whish: { reference, fundsConfirmed } });

describe("a paid invoice records how it was paid", () => {
  it("cash, paid in full: the sale says cash, ONE cash tender for the paid amount, NO debt", () => {
    const id = draft("100.00");
    const view = h.invoices.finalizeInvoice(id, { payment: { method: "cash" } });
    const s = saleRow(id);
    expect({ m: s.m, st: s.st, p: s.p, b: s.b, tc: Number(s.tc) }).toEqual({ m: "cash", st: "paid", p: 10_000n, b: 0n, tc: 1 });
    expect(tenderRows(s.id)).toEqual([{ method: "cash", provider: null, reference: null, a: 10_000n }]);
    expect(footprint().obligations).toBe(0);
    expect(view.payment).toEqual({ method: "cash", provider: null, reference: null });
  });

  it("Whish Money: the tender carries the reference, which is registered for good", () => {
    const id = draft("100.00");
    const view = h.invoices.finalizeInvoice(id, { payment: WHISH("WH-INV-1") });
    const s = saleRow(id);
    expect(s.m).toBe("external");
    expect(tenderRows(s.id)).toEqual([{ method: "external", provider: "whish", reference: "WH-INV-1", a: 10_000n }]);
    const ref = h.db.prepare("SELECT owner_kind AS k, owner_id AS o FROM external_references").get() as { k: string; o: string };
    expect(ref).toEqual({ k: "sale_tender", o: `${s.id}#1` });
    expect(view.payment).toEqual({ method: "external", provider: "whish", reference: "WH-INV-1" });
    // …and reading it back later says the same — what print and PDF use.
    expect(h.invoices.getInvoice(id).payment).toEqual({ method: "external", provider: "whish", reference: "WH-INV-1" });
  });

  it("a partly paid invoice issued WITHOUT an account is now refused (INV-PARTIAL-DEBT, Option B)", () => {
    // TRANSITION · INV-PARTIAL-DEBT: this used to ISSUE (cash tender of 40, sale partial, NO debt —
    // the remainder untracked). Option B makes that impossible for a new invoice; the account path
    // and its receivable are covered in invoicePartialDebt.test.ts.
    const id = draft("40.00");
    const before = footprint();
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: { method: "cash" } }))).toBe("CREDIT_PARTIAL_NEEDS_ACCOUNT");
    expect(footprint()).toEqual(before);
    expect(status(id)).toEqual({ status: "draft", num: null });
  });

  it("a cashier issues a paid invoice exactly as before — the permission is unchanged", () => {
    h.service.login("cashier-02", "2222");
    const id = draft("100.00");
    h.invoices.finalizeInvoice(id, { payment: { method: "cash" } });
    expect(status(id).status).toBe("final");
  });
});

describe("🔴 refused — the draft stays a draft, the number is not taken, nothing is written", () => {
  it("money marked paid with NO method → INVOICE_PAYMENT_METHOD_REQUIRED, before the number is allocated", () => {
    const id = draft("100.00");
    expect(codeOf(() => h.invoices.finalizeInvoice(id))).toBe("INVOICE_PAYMENT_METHOD_REQUIRED");
    expect(status(id)).toEqual({ status: "draft", num: null });
    expect(footprint()).toEqual({ sales: 0, tenders: 0, obligations: 0, references: 0, final: 0 });
    // The number was not consumed: the next issue gets #1.
    const ok = h.invoices.finalizeInvoice(id, { payment: { method: "cash" } });
    expect(Number(ok.invoice.invoice_number)).toBe(1);
  });

  it("a method with NOTHING marked paid is refused (no invented payment)", () => {
    const id = draft(null);
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: { method: "cash" } }))).toBe("INVALID_INPUT");
    expect(status(id).status).toBe("draft");
    h.invoices.finalizeInvoice(id);
    expect(saleRow(id).m).toBeNull();
    expect(h.invoices.getInvoice(id).payment).toBeUndefined();
  });

  it("Card, Other and bank are not money this shop takes (P3)", () => {
    const id = draft("100.00");
    for (const method of ["card", "other", "bank_transfer"]) {
      expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: { method } as never }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    }
    expect(footprint().sales).toBe(0);
  });

  it("Whish without a reference, a blank one, or without the confirmation", () => {
    const id = draft("100.00");
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: { method: "external" } as never }))).toBe("INVALID_INPUT");
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: WHISH("   ") }))).toBe("INVALID_INPUT");
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: WHISH("WH-NC", false) }))).toBe("FUNDS_NOT_CONFIRMED");
    expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: { method: "cash", whish: { reference: "X", fundsConfirmed: true } } as never }))).toBe("INVALID_INPUT");
    expect(status(id)).toEqual({ status: "draft", num: null });
  });

  it("🔴 a Whish reference already used (a till sale, another invoice) refuses the WHOLE issue — atomically", () => {
    h.service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: "prod-0001", quantityMilli: 2000 }],
      expectedTotalMinor: 500n,
      paymentMethod: "external",
      whish: { reference: "WH-TAKEN", fundsConfirmed: true },
    });
    const first = draft("100.00");
    h.invoices.finalizeInvoice(first, { payment: WHISH("WH-INV-TAKEN") });
    const before = footprint();
    const id = draft("100.00");
    for (const ref of ["WH-TAKEN", "WH-INV-TAKEN", " wh-inv-taken "]) {
      expect(codeOf(() => h.invoices.finalizeInvoice(id, { payment: WHISH(ref) }))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    }
    expect(footprint()).toEqual(before);
    expect(status(id)).toEqual({ status: "draft", num: null });
    // The number is still free: this invoice takes #2 once paid honestly.
    expect(Number(h.invoices.finalizeInvoice(id, { payment: { method: "cash" } }).invoice.invoice_number)).toBe(2);
  });

  it("issuing the same invoice again never writes a second sale or tender", () => {
    const id = draft("100.00");
    h.invoices.finalizeInvoice(id, { payment: { method: "cash" } });
    const before = footprint();
    expect(() => h.invoices.finalizeInvoice(id, { payment: { method: "cash" } })).toThrow();
    expect(footprint()).toEqual(before);
  });
});

describe("history and on-account are untouched", () => {
  it("an unpaid invoice issued on account (owner) still records NO method and carries NO payment", () => {
    const customer = h.parties.create({ kind: "customer", displayName: "زبون على الحساب" }).party;
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", productId: null, quantity: "1", unitPrice: "100.00" });
    h.invoices.updateDraftHeader(invoice.id, { customerName: "زبون", customerPartyId: customer.id });
    const view = h.invoices.finalizeInvoice(invoice.id, { issueOnAccount: true });
    expect(saleRow(invoice.id).m).toBeNull();
    expect(view.payment).toBeUndefined();
    expect(footprint().obligations).toBe(1);
    // …and an on-account issue cannot smuggle a method in: nothing is paid on it.
    const other = draft(null);
    expect(codeOf(() => h.invoices.finalizeInvoice(other, { issueOnAccount: true, payment: { method: "cash" } }))).not.toBe("OK");
  });
});
