/**
 * R5 (Abu Abbas, R4 review F3 + R5 contract invariant 4): the issue is bound, INSIDE the finalize transaction, to the
 * complete draft its confirmation showed (`confirmationDigest`, `src/shared/invoiceConfirmation.ts`).
 *
 * Each refusal asserts the code (INVOICE_CONFIRMATION_STALE), that NOTHING irreversible was written (still a draft, no
 * number, no sale, no receivable), and a positive control: the same draft issues exactly once with a FRESH digest.
 * The cases are the ones a totals-only fingerprint missed: a same-total substitution, a same-count edit, a removed and
 * re-added line, a printed header field, and the on-account choice.
 *
 * Real SQLite runtime on a temporary, synthetic database (migrations run on that file only). Every value is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { toInvoiceViewDto } from "../../src/shared/dto";
import { confirmationDigest } from "../../src/shared/invoiceConfirmation";
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

const line = (price: string, description = "صنف") => ({
  description,
  unitLabel: "حبة",
  canonicalUnit: null,
  productId: null,
  quantity: "1",
  unitPrice: price,
});
const draft = (...prices: string[]) => {
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLines(invoice.id, prices.map((p, i) => line(p, `صنف ${i + 1}`)), `batch-r5-${(seq += 1)}-key`);
  return invoice.id;
};
/** What the renderer computes from the view it shows — the same DTO conversion the IPC layer applies. */
const digestOf = (id: string, onAccount = false) => confirmationDigest(toInvoiceViewDto(h.invoices.getInvoice(id)), onAccount);
const n = (sql: string) => Number((h.db.prepare(sql).get() as { n: bigint }).n);
const sales = () => n("SELECT count(*) AS n FROM sales");
const obligations = () => n("SELECT count(*) AS n FROM obligations");
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};
const untouched = (id: string, salesBefore: number) => {
  const after = h.invoices.getInvoice(id).invoice;
  expect(after.status).toBe("draft");
  expect(after.invoice_number).toBeNull();
  expect(sales()).toBe(salesBefore);
};

describe("finalize compares the confirmed draft inside its transaction", () => {
  it("issues when the persisted draft is exactly the confirmed one", () => {
    const id = draft("5.00", "3.00");
    const view = h.invoices.finalizeInvoice(id, { confirmedDraft: digestOf(id) });
    expect(view.invoice.status).toBe("final");
    expect(sales()).toBe(1);
  });

  it("🔴 same-total substitution (a line's description changed) → refused, nothing written; a fresh digest issues once", () => {
    const id = draft("5.00", "3.00");
    const confirmed = digestOf(id);
    const l1 = h.invoices.getInvoice(id).lines[0]!;
    h.invoices.updateLine(id, l1.id, { ...line("5.00", "صنف آخر"), quantity: "1" });
    const before = sales();
    expect(code(() => h.invoices.finalizeInvoice(id, { confirmedDraft: confirmed }))).toBe("INVOICE_CONFIRMATION_STALE");
    untouched(id, before);
    expect(h.invoices.finalizeInvoice(id, { confirmedDraft: digestOf(id) }).invoice.status).toBe("final");
    expect(sales()).toBe(before + 1);
  });

  it("🔴 a line removed and an equal one re-added (same count, same total, new identity) → refused", () => {
    const id = draft("5.00", "3.00");
    const confirmed = digestOf(id);
    const l2 = h.invoices.getInvoice(id).lines[1]!;
    h.invoices.removeLine(id, l2.id);
    h.invoices.addLines(id, [line("3.00", "صنف 2")], "batch-r5-readd-key");
    expect(h.invoices.getInvoice(id).lines).toHaveLength(2);
    const before = sales();
    expect(code(() => h.invoices.finalizeInvoice(id, { confirmedDraft: confirmed }))).toBe("INVOICE_CONFIRMATION_STALE");
    untouched(id, before);
  });

  it("🔴 a removed line (count changes) → refused", () => {
    const id = draft("5.00", "3.00");
    const confirmed = digestOf(id);
    h.invoices.removeLine(id, h.invoices.getInvoice(id).lines[1]!.id);
    const before = sales();
    expect(code(() => h.invoices.finalizeInvoice(id, { confirmedDraft: confirmed }))).toBe("INVOICE_CONFIRMATION_STALE");
    untouched(id, before);
  });

  it("🔴 a printed header field (customer name) changed after the confirmation → refused", () => {
    const id = draft("5.00");
    const confirmed = digestOf(id);
    h.invoices.updateDraftHeader(id, { customerName: "زبون جديد" });
    const before = sales();
    expect(code(() => h.invoices.finalizeInvoice(id, { confirmedDraft: confirmed }))).toBe("INVOICE_CONFIRMATION_STALE");
    untouched(id, before);
  });

  it("the paid amount changed after the confirmation → refused (the R3 figures stay covered)", () => {
    const id = draft("5.00");
    const confirmed = digestOf(id);
    h.invoices.updateDraftHeader(id, { paid: "5.00" });
    const before = sales();
    expect(code(() => h.invoices.finalizeInvoice(id, { confirmedDraft: confirmed, payment: { method: "cash" } }))).toBe(
      "INVOICE_CONFIRMATION_STALE",
    );
    untouched(id, before);
  });

  it("without `confirmedDraft` the issue behaves exactly as before (every earlier caller)", () => {
    const id = draft("5.00");
    expect(h.invoices.finalizeInvoice(id).invoice.status).toBe("final");
  });
});

describe("on account: the choice is part of the confirmation, and a verified replay is never a false failure", () => {
  const customer = () => h.parties.create({ kind: "customer", displayName: "زبون" }).party;

  it("🔴 a confirmation shown for an ORDINARY issue does not authorize an on-account issue", () => {
    const id = draft("10.00");
    h.invoices.updateDraftHeader(id, { customerPartyId: customer().id });
    const shownOrdinary = digestOf(id, false);
    const before = { s: sales(), o: obligations() };
    expect(code(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: shownOrdinary }))).toBe(
      "INVOICE_CONFIRMATION_STALE",
    );
    untouched(id, before.s);
    expect(obligations()).toBe(before.o);
    expect(h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: digestOf(id, true) }).invoice.status).toBe("final");
    expect(obligations()).toBe(before.o + 1);
  });

  it("🔴 a repeat of a COMMITTED on-account issue (lost response) verifies with the same digest — no second sale, no refusal", () => {
    const id = draft("10.00");
    h.invoices.updateDraftHeader(id, { customerPartyId: customer().id });
    const confirmed = digestOf(id, true);
    h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: confirmed });
    const after = { s: sales(), o: obligations() };
    const replay = h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: confirmed });
    expect(replay.invoice.status).toBe("final");
    expect(sales()).toBe(after.s);
    expect(obligations()).toBe(after.o);
  });

  it("a stale on-account request for a draft that did NOT commit is refused and writes nothing", () => {
    const id = draft("10.00");
    h.invoices.updateDraftHeader(id, { customerPartyId: customer().id });
    const confirmed = digestOf(id, true);
    h.invoices.addLines(id, [line("1.00", "صنف إضافي")], "batch-r5-late-key");
    const before = { s: sales(), o: obligations() };
    expect(code(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: confirmed }))).toBe(
      "INVOICE_CONFIRMATION_STALE",
    );
    untouched(id, before.s);
    expect(obligations()).toBe(before.o);
  });
});
