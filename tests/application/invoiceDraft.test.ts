/**
 * The manual invoice's service layer: drafting, the finalize transaction, and the number sequence.
 *
 * Every product, price, name and customer here is SYNTHETIC. No merchant data is in this
 * repository, and the one real-looking total (474.40) is the arithmetic regression sentence, not a
 * merchant's invoice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { amountInWordsAr } from "../../src/domain/amountInWords";
import { money } from "../../src/domain/money";
import { InvoiceService } from "../../src/application/invoiceService";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";
import type { Harness } from "../helpers/harness";

let t: TempDir;
let h: Harness;

const PROFILE = {
  nameAr: "متجر اختباري",
  nameEn: "Test Store",
  address: "شارع الاختبار",
  phone1: "0000000",
  taxpayerNumber: "TP-1",
  commercialRegister: "CR-2",
  vatNumber: "VAT-3",
};

const saveProfile = (extra: Record<string, unknown> = {}) =>
  h.invoices.saveCompanyProfile({ ...PROFILE, ...extra });

/** A draft carrying one line: `quantity` × `unitPrice`. */
function draftWithLine(quantity: string, unitPrice: string, description = "صنف اختباري") {
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLine(invoice.id, { description, unitLabel: "حبة", quantity, unitPrice });
  return invoice.id;
}

const nextNumber = () => Number(h.companyStore.find()!.next_invoice_number);

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("the company profile", () => {
  it("keeps the three official identifiers as three separate fields", () => {
    const saved = saveProfile();
    expect(saved.taxpayer_number).toBe("TP-1");
    expect(saved.commercial_register).toBe("CR-2");
    expect(saved.vat_number).toBe("VAT-3");
    // Three columns, three values — never one identifier printed under another's label.
    expect(new Set([saved.taxpayer_number, saved.commercial_register, saved.vat_number]).size).toBe(3);
  });

  it("stores exactly one row however many times it is saved", () => {
    saveProfile();
    saveProfile({ nameAr: "اسم آخر" });
    const n = h.db.prepare("SELECT count(*) AS c FROM company_profile").get() as { c: bigint };
    expect(Number(n.c)).toBe(1);
    expect(h.companyStore.find()!.name_ar).toBe("اسم آخر");
  });

  it("has tax OFF by default and hard-codes no rate", () => {
    const saved = saveProfile();
    expect(saved.tax_enabled).toBe(0n);
    expect(saved.tax_rate_bp).toBe(0n);
    expect(saved.tax_label).toBeNull();
  });

  it("turns a typed percentage into exact basis points", () => {
    expect(Number(saveProfile({ taxEnabled: true, taxRatePercent: "11" }).tax_rate_bp)).toBe(1100);
    expect(Number(saveProfile({ taxEnabled: true, taxRatePercent: "11.5" }).tax_rate_bp)).toBe(1150);
    expect(Number(saveProfile({ taxEnabled: true, taxRatePercent: "0" }).tax_rate_bp)).toBe(0);
  });

  it("refuses a tax rate that is not a plain percentage", () => {
    for (const bad of ["abc", "-1", "11%", "1e2", ""]) {
      expect(() => saveProfile({ taxEnabled: true, taxRatePercent: bad })).toThrow(DomainError);
    }
  });

  it("saving a new phone number does not rewind the invoice sequence", () => {
    saveProfile({ startNumber: 61 });
    expect(nextNumber()).toBe(61);
    saveProfile({ phone1: "1111111" });
    expect(nextNumber()).toBe(61);
  });
});

describe("the draft", () => {
  it("opens empty, with every money column at zero", () => {
    saveProfile();
    const { invoice, lines } = h.invoices.createDraft();
    expect(invoice.status).toBe("draft");
    expect(invoice.invoice_number).toBeNull();
    expect(lines).toEqual([]);
    expect([invoice.subtotal_minor, invoice.tax_minor, invoice.total_minor, invoice.balance_due_minor]).toEqual([
      0n,
      0n,
      0n,
      0n,
    ]);
  });

  it("consumes NO invoice number — a hundred abandoned drafts leave the sequence where it was", () => {
    saveProfile({ startNumber: 61 });
    for (let i = 0; i < 100; i += 1) {
      const id = h.invoices.createDraft().invoice.id;
      h.invoices.updateDraftHeader(id, { customerName: `زبون ${i}` });
      h.invoices.addLine(id, { description: "صنف", unitLabel: "حبة", quantity: "1", unitPrice: "1.00" });
    }
    expect(nextNumber()).toBe(61);
    expect(h.invoiceStore.countFinalized()).toBe(0);
  });

  it("may stay incomplete — no customer, no date, no description is still a saveable draft", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    const view = h.invoices.addLine(invoice.id, { quantity: "2", unitPrice: "3.00" });
    expect(view.lines[0]!.description).toBeNull();
    expect(view.lines[0]!.unit_label).toBeNull();
    expect(view.invoice.customer_name).toBeNull();
    expect(view.invoice.total_minor).toBe(600n);
  });

  it("adds, edits and deletes lines, renumbering nothing and reusing no line number", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    for (const q of ["1", "2", "3"]) {
      h.invoices.addLine(invoice.id, { description: `صنف ${q}`, unitLabel: "حبة", quantity: q, unitPrice: "1.00" });
    }
    let view = h.invoices.getInvoice(invoice.id);
    expect(view.lines.map((l) => Number(l.line_no))).toEqual([1, 2, 3]);

    view = h.invoices.updateLine(invoice.id, view.lines[1]!.id, {
      description: "صنف معدّل",
      unitLabel: "كيلو",
      quantity: "2.5",
      unitPrice: "4.00",
    });
    expect(view.lines[1]!.description).toBe("صنف معدّل");
    expect(view.lines[1]!.quantity_milli).toBe(2500n);
    expect(view.lines[1]!.line_total_minor).toBe(1000n);
    expect(view.lines[1]!.canonical_unit).toBe("kg");

    view = h.invoices.removeLine(invoice.id, view.lines[0]!.id);
    expect(view.lines.map((l) => Number(l.line_no))).toEqual([2, 3]);

    // max + 1, so a deleted line's number is never handed out again
    view = h.invoices.addLine(invoice.id, { description: "صنف جديد", unitLabel: "حبة", quantity: "1", unitPrice: "1.00" });
    expect(view.lines.map((l) => Number(l.line_no))).toEqual([2, 3, 4]);
  });

  it("recomputes the stored totals after every line change", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    let view = h.invoices.addLine(invoice.id, { description: "أ", unitLabel: "حبة", quantity: "3", unitPrice: "2.50" });
    expect(view.invoice.subtotal_minor).toBe(750n);
    view = h.invoices.addLine(invoice.id, { description: "ب", unitLabel: "حبة", quantity: "1", unitPrice: "0.25" });
    expect(view.invoice.subtotal_minor).toBe(775n);
    expect(view.invoice.total_minor).toBe(775n);
    view = h.invoices.removeLine(invoice.id, view.lines[0]!.id);
    expect(view.invoice.subtotal_minor).toBe(25n);
  });

  it("keeps the printed unit label verbatim and leaves an unknown one unmapped", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    const view = h.invoices.addLine(invoice.id, {
      description: "صنف معبّأ",
      unitLabel: "كيس (50PCS)",
      quantity: "2",
      unitPrice: "1.00",
    });
    expect(view.lines[0]!.unit_label).toBe("كيس (50PCS)");
    // 🔴 null is a RESULT, not a failure: the label is kept, the catalog unit is not invented.
    expect(view.lines[0]!.canonical_unit).toBeNull();
  });

  it("accepts a fractional quantity regardless of any catalog unit policy", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    const view = h.invoices.addLine(invoice.id, {
      description: "حديد",
      unitLabel: "متر",
      quantity: "2.333",
      unitPrice: "3.00",
    });
    expect(view.lines[0]!.quantity_milli).toBe(2333n);
    expect(view.lines[0]!.line_total_minor).toBe(700n); // (2333 * 300 + 500) / 1000 = 699.9 -> 700
  });

  it("allows a zero-priced line, which a sale would refuse", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    const view = h.invoices.addLine(invoice.id, { description: "هدية", unitLabel: "حبة", quantity: "1", unitPrice: "0" });
    expect(view.lines[0]!.line_total_minor).toBe(0n);
  });

  it("names both numbers and the way out when a paid amount exceeds a reduced total", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, { description: "أ", unitLabel: "حبة", quantity: "1", unitPrice: "100.00" });
    const view = h.invoices.updateDraftHeader(invoice.id, { paid: "100.00" });
    expect(view.invoice.balance_due_minor).toBe(0n);

    let message = "";
    try {
      h.invoices.removeLine(invoice.id, view.lines[0]!.id);
    } catch (error) {
      message = (error as DomainError).message;
    }
    // Never a bare constraint failure: both amounts, and the one action that unblocks it.
    expect(message).toContain("100.00");
    expect(message).toContain("Reduce the paid amount");
    // And the draft is untouched, so the operator can actually take that action.
    expect(h.invoices.getInvoice(invoice.id).lines).toHaveLength(1);
  });

  it("refuses a malformed date rather than storing one the printer cannot read", () => {
    saveProfile();
    const { invoice } = h.invoices.createDraft();
    expect(() => h.invoices.updateDraftHeader(invoice.id, { invoiceDate: "04/10/2026" })).toThrow(DomainError);
    expect(h.invoices.updateDraftHeader(invoice.id, { invoiceDate: "2026-10-08" }).invoice.invoice_date).toBe(
      "2026-10-08",
    );
  });

  it("discards a draft and its lines together", () => {
    saveProfile();
    const id = draftWithLine("1", "1.00");
    h.invoices.discardDraft(id);
    expect(h.invoices.listDrafts()).toHaveLength(0);
    const n = h.db.prepare("SELECT count(*) AS c FROM invoice_lines").get() as { c: bigint };
    expect(Number(n.c)).toBe(0);
  });
});

describe("finalize", () => {
  it("needs the shop's own details before it will issue a document", () => {
    const id = draftWithLine("1", "1.00");
    expect(() => h.invoices.finalizeInvoice(id)).toThrow(/shop's own details/);
    // And refusing cost nothing: still a draft, still no number anywhere.
    expect(h.invoices.getInvoice(id).invoice.status).toBe("draft");
  });

  it("refuses an empty invoice and a line with no description or unit", () => {
    saveProfile();
    const empty = h.invoices.createDraft().invoice.id;
    expect(() => h.invoices.finalizeInvoice(empty)).toThrow(/at least one line/);

    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, { quantity: "1", unitPrice: "1.00" });
    expect(() => h.invoices.finalizeInvoice(invoice.id)).toThrow(/description/);
    h.invoices.updateLine(invoice.id, h.invoices.getInvoice(invoice.id).lines[0]!.id, {
      description: "صنف",
      quantity: "1",
      unitPrice: "1.00",
    });
    expect(() => h.invoices.finalizeInvoice(invoice.id)).toThrow(/no unit/);
  });

  it("a refused finalization consumes no invoice number", () => {
    saveProfile({ startNumber: 61 });
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLine(invoice.id, { quantity: "1", unitPrice: "1.00" }); // no description
    expect(() => h.invoices.finalizeInvoice(invoice.id)).toThrow(DomainError);
    expect(nextNumber()).toBe(61);
  });

  it("freezes the number, date, totals, words and issuer onto the document", () => {
    saveProfile({ startNumber: 61 });
    const id = draftWithLine("1", "474.40");
    const { invoice } = h.invoices.finalizeInvoice(id);

    expect(invoice.status).toBe("final");
    expect(Number(invoice.invoice_number)).toBe(61);
    expect(invoice.invoice_date).toBe("2026-10-04"); // the business date of the frozen test clock
    expect(invoice.total_minor).toBe(47440n);
    expect(invoice.finalized_at).toBe("2026-10-04T09:00:00.000Z");

    // The words are frozen, so a later build cannot reword an invoice already in someone's hands.
    expect(invoice.amount_in_words).toBe(amountInWordsAr(money(47440n, "USD")));
    expect(invoice.amount_in_words).toBe("فقط أربعمئة وأربعة وسبعون دولاراً وأربعون سنتاً لا غير");

    const issuer = JSON.parse(invoice.issuer_snapshot_json!) as Record<string, unknown>;
    expect(issuer.name_ar).toBe("متجر اختباري");
    expect(issuer.taxpayer_number).toBe("TP-1");
    expect(issuer.commercial_register).toBe("CR-2");
    expect(issuer.vat_number).toBe("VAT-3");
  });

  it("the issuer snapshot does not follow a later change to the shop's details", () => {
    saveProfile();
    const id = draftWithLine("1", "10.00");
    h.invoices.finalizeInvoice(id);
    saveProfile({ phone1: "9999999", nameAr: "اسم جديد" });

    const issuer = JSON.parse(h.invoices.getInvoice(id).invoice.issuer_snapshot_json!) as Record<string, unknown>;
    expect(issuer.phone1).toBe("0000000");
    expect(issuer.name_ar).toBe("متجر اختباري");
    // The live profile really did change — the snapshot simply is not a reference to it.
    expect(h.companyStore.find()!.phone1).toBe("9999999");
  });

  it("recomputes the totals and does not trust the ones stored on the draft header", () => {
    saveProfile();
    const id = draftWithLine("4", "25.00"); // 100.00
    // Corrupt the header to a self-consistent but WRONG set of totals, which the table's own
    // arithmetic CHECKs happily accept because they only check the columns against each other.
    h.db
      .prepare(
        `UPDATE invoices SET subtotal_minor = 1, tax_minor = 0, total_minor = 1, paid_minor = 0,
                             balance_due_minor = 1 WHERE id = ?`,
      )
      .run(id);
    expect(h.invoiceStore.requireById(id).total_minor).toBe(1n);

    const { invoice } = h.invoices.finalizeInvoice(id);
    expect(invoice.subtotal_minor).toBe(10000n);
    expect(invoice.total_minor).toBe(10000n);
  });

  it("applies the shop's own tax rate, exactly and half-up", () => {
    saveProfile({ taxEnabled: true, taxRatePercent: "11", taxLabel: "VAT 11%" });
    const id = draftWithLine("1", "99.99"); // 9999 * 1100 / 10000 = 1099.89 -> 1100
    const { invoice } = h.invoices.finalizeInvoice(id);
    expect(invoice.subtotal_minor).toBe(9999n);
    expect(invoice.tax_minor).toBe(1100n);
    expect(invoice.total_minor).toBe(11099n);
    expect(JSON.parse(invoice.tax_snapshot_json!)).toEqual({
      enabled: true,
      rate_basis_points: 1100,
      label: "VAT 11%",
    });
  });

  it("a finalized invoice cannot be edited through the service", () => {
    saveProfile();
    const id = draftWithLine("1", "10.00");
    const lineId = h.invoices.getInvoice(id).lines[0]!.id;
    h.invoices.finalizeInvoice(id);

    expect(() => h.invoices.updateDraftHeader(id, { customerName: "آخر" })).toThrow(/has been issued/);
    expect(() => h.invoices.addLine(id, { description: "س", unitLabel: "حبة", quantity: "1", unitPrice: "1" })).toThrow(
      /has been issued/,
    );
    expect(() => h.invoices.updateLine(id, lineId, { quantity: "9", unitPrice: "9" })).toThrow(/has been issued/);
    expect(() => h.invoices.removeLine(id, lineId)).toThrow(/has been issued/);
    expect(() => h.invoices.discardDraft(id)).toThrow(/has been issued/);
    expect(() => h.invoices.finalizeInvoice(id)).toThrow(/has been issued/);
  });

  it("and the DATABASE refuses it too, which is the guard that does not depend on this code", () => {
    saveProfile();
    const id = draftWithLine("1", "10.00");
    const lineId = h.invoices.getInvoice(id).lines[0]!.id;
    h.invoices.finalizeInvoice(id);

    expect(() => h.db.prepare("UPDATE invoices SET notes = 'x' WHERE id = ?").run(id)).toThrow(/immutable/);
    expect(() => h.db.prepare("DELETE FROM invoices WHERE id = ?").run(id)).toThrow(/cannot be deleted/);
    expect(() => h.db.prepare("UPDATE invoice_lines SET description = 'x' WHERE id = ?").run(lineId)).toThrow(
      /line is immutable/,
    );
    expect(() => h.db.prepare("DELETE FROM invoice_lines WHERE id = ?").run(lineId)).toThrow(/cannot be deleted/);
  });

  it("the database refuses a line total that does not follow the half-up rule", () => {
    // This is why `finalizeInvoice`'s own recomputation guard cannot be reached from a real ledger:
    // the column CHECK makes a wrong line total unstorable in the first place. The guard stays as
    // defence against a future path that bypassed the CHECK — asserted here rather than implied.
    saveProfile();
    const id = draftWithLine("3", "2.50"); // 750
    const lineId = h.invoices.getInvoice(id).lines[0]!.id;
    expect(() => h.db.prepare("UPDATE invoice_lines SET line_total_minor = 749 WHERE id = ?").run(lineId)).toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe("the invoice number", () => {
  it("is sequential and independent of the sales receipt sequence", () => {
    saveProfile({ startNumber: 61 });
    const numbers = ["1.00", "2.00", "3.00"].map((p) => {
      const id = draftWithLine("1", p);
      return Number(h.invoices.finalizeInvoice(id).invoice.invoice_number);
    });
    expect(numbers).toEqual([61, 62, 63]);
    expect(nextNumber()).toBe(64);

    // 🔴 THIS ASSERTION WAS FLIPPED ON 2026-10-09, AND THE OLD VALUE WAS ZERO. Until then
    // finalizing an invoice wrote NO sale, by the V1 decision stated in migration 6, and this line
    // read `expect(Number(receipts.c)).toBe(0)`. Field use reversed that decision: a finalized
    // invoice IS a sale. What this test is really about — that the two NUMBER SEQUENCES never meet
    // — is unchanged and is now asserted directly below, which is stronger than inferring it from
    // an empty table.
    const receipts = h.db.prepare("SELECT count(*) AS c FROM sales").get() as { c: bigint };
    expect(Number(receipts.c)).toBe(3);

    // Receipt numbers start at 1 and know nothing about the invoice sequence starting at 61.
    const pairs = (
      h.db
        .prepare("SELECT receipt_number, invoice_id FROM sales ORDER BY receipt_number")
        .all() as Array<{ receipt_number: bigint; invoice_id: string }>
    ).map((r) => Number(r.receipt_number));
    expect(pairs).toEqual([1, 2, 3]);
    // And every one of the three is linked to its invoice, exactly once.
    const linked = h.db.prepare("SELECT count(DISTINCT invoice_id) AS c FROM sales").get() as { c: bigint };
    expect(Number(linked.c)).toBe(3);
  });

  it("cannot be handed to two invoices, which the UNIQUE index enforces independently", () => {
    saveProfile();
    const first = draftWithLine("1", "1.00");
    const number = Number(h.invoices.finalizeInvoice(first).invoice.invoice_number);
    const second = draftWithLine("1", "2.00");
    expect(() =>
      h.db.prepare("UPDATE invoices SET invoice_number = ? WHERE id = ?").run(number, second),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("may be moved before the first invoice is issued, and never after", () => {
    saveProfile();
    expect(Number(h.invoices.setNextInvoiceNumber(61).next_invoice_number)).toBe(61);
    const id = draftWithLine("1", "1.00");
    h.invoices.finalizeInvoice(id);
    expect(() => h.invoices.setNextInvoiceNumber(200)).toThrow(/cannot be changed once an invoice has been issued/);
    expect(nextNumber()).toBe(62);
  });

  it("refuses a start number that is not a whole number of 1 or more", () => {
    for (const bad of [0, -5, 1.5, "abc"]) {
      expect(() => saveProfile({ startNumber: bad })).toThrow(DomainError);
    }
  });
});

describe("finalize rolls back as one act", () => {
  /**
   * Failure injection at the LAST step — writing the review queue, after the number has been
   * allocated and the invoice row has already been updated to 'final' inside the transaction. If
   * anything survived a throw here, it would be the worst case: a numbered, finalized document with
   * no reconciliation behind it.
   */
  function serviceThatFailsWritingTheQueue(): InvoiceService {
    class ExplodingReconciliation extends ReconciliationRepository {
      override insert(): never {
        throw new Error("injected failure: the review queue could not be written");
      }
    }
    return new InvoiceService({
      invoices: new InvoiceRepository(h.db),
      reconciliation: new ExplodingReconciliation(h.db),
      company: h.companyStore,
      catalogStore: new CatalogRepository(h.db),
      products: h.service,
      sales: new SaleRepository(h.db),
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: h.clock.now,
      newId: () => `fail-${Math.random()}`,
    });
  }

  it("leaves a valid editable draft, an unconsumed number and zero reconciliation rows", () => {
    saveProfile({ startNumber: 61 });
    const id = draftWithLine("4", "25.00");
    const before = h.invoiceStore.requireById(id);

    expect(() => serviceThatFailsWritingTheQueue().finalizeInvoice(id)).toThrow(/injected failure/);

    const after = h.invoiceStore.requireById(id);
    expect(after.status).toBe("draft");
    expect(after.invoice_number).toBeNull();
    expect(after.finalized_at).toBeNull();
    expect(after.amount_in_words).toBeNull();
    expect(after.issuer_snapshot_json).toBeNull();
    // Byte-for-byte the row it was, not merely "still a draft".
    expect(after).toEqual(before);

    // The number was allocated inside that transaction and went back with it.
    expect(nextNumber()).toBe(61);
    expect(h.reconciliationStore.countUnresolved()).toBe(0);
    expect(h.db.prepare("SELECT count(*) AS c FROM invoice_reconciliation").get()).toEqual({ c: 0n });

    // And the draft is still fully editable afterwards — the real proof it is a valid draft.
    const view = h.invoices.addLine(id, { description: "صنف آخر", unitLabel: "حبة", quantity: "1", unitPrice: "5.00" });
    expect(view.lines).toHaveLength(2);
    expect(view.invoice.subtotal_minor).toBe(10500n);

    // Then a real finalization still gets the number that the failed one did not keep.
    expect(Number(h.invoices.finalizeInvoice(id).invoice.invoice_number)).toBe(61);
  });
});

describe("history", () => {
  it("lists finalized invoices newest number first, and drafts separately", () => {
    saveProfile();
    const ids = ["1.00", "2.00", "3.00"].map((p) => draftWithLine("1", p));
    for (const id of ids) h.invoices.finalizeInvoice(id);
    draftWithLine("1", "9.00");

    expect(h.invoices.listFinalized().map((i) => Number(i.invoice_number))).toEqual([3, 2, 1]);
    expect(h.invoices.listDrafts()).toHaveLength(1);
  });

  it("searches finalized invoices by customer name and by number, wildcards escaped", () => {
    saveProfile();
    const id = draftWithLine("1", "5.00");
    h.invoices.updateDraftHeader(id, { customerName: "زبون 50% نقدي" });
    h.invoices.finalizeInvoice(id);
    const other = draftWithLine("1", "6.00");
    h.invoices.updateDraftHeader(other, { customerName: "زبون آخر" });
    h.invoices.finalizeInvoice(other);

    expect(h.invoices.searchFinalized("50%").map((i) => i.id)).toEqual([id]);
    expect(h.invoices.searchFinalized("زبون")).toHaveLength(2);
    expect(h.invoices.searchFinalized("1").map((i) => Number(i.invoice_number))).toEqual([1]);
    // A bare wildcard is a literal, not "match everything".
    expect(h.invoices.searchFinalized("%")).toHaveLength(1);
  });
});
