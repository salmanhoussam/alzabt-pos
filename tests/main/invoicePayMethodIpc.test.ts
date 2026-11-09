import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { paymentMethodRow, renderInvoiceDocument } from "../../src/main/invoiceDocument";
import { toInvoiceViewDto } from "../../src/shared/dto";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

/**
 * INV-PAY-METHOD (owner, 2026-11-09) through the REAL bridge, and on paper.
 *
 *  - `payment` is the second optional key of `finalizeInvoice`: exactly { method: "cash" } or
 *    { method: "external", whish: { reference, fundsConfirmed } } — nothing else crosses;
 *  - the invoice DTO carries `payment` only when a method was recorded, so History, the sheet, the
 *    print and the PDF read it from ONE place;
 *  - the printed document gains a "Payment method" row ONLY for such an invoice — every other invoice
 *    prints exactly as it did.
 */

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
  ipc = syncHandlers(createIpcHandlers(h.service, { invoices: h.invoices }));
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

type R = { ok: boolean; data?: any; error?: { code: string } };
const code = (r: unknown) => ((r as R).ok ? "OK" : (r as R).error!.code);
function draft(paid: string | null): string {
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", productId: null, quantity: "1", unitPrice: "100.00" });
  h.invoices.updateDraftHeader(invoice.id, { customerName: "زبون", paid });
  return invoice.id;
}
const finalize = (req: unknown) => ipc.finalizeInvoice(req as never) as R;
const printed = (id: string) => renderInvoiceDocument(toInvoiceViewDto(h.invoices.getInvoice(id)));

describe("the bridge carries how the invoice was paid", () => {
  it("cash: the issued DTO says cash; History shows the invoice sale paid by cash", () => {
    const id = draft("100.00");
    const r = finalize({ invoiceId: id, payment: { method: "cash" } });
    expect(r.ok).toBe(true);
    expect(r.data.invoice.payment).toEqual({ method: "cash", provider: null, reference: null });
    const history = (ipc.getSaleHistory({ limit: 10 }) as R).data as Array<{ sale: { invoiceId: string | null; paymentMethod: string | null } }>;
    expect(history.find((x) => x.sale.invoiceId === id)?.sale.paymentMethod).toBe("cash");
  });

  it("Whish: the DTO carries the reference; History names Whish and the reference", () => {
    const id = draft("100.00");
    const r = finalize({ invoiceId: id, payment: { method: "external", whish: { reference: "WH-IPC-INV", fundsConfirmed: true } } });
    expect(r.data.invoice.payment).toEqual({ method: "external", provider: "whish", reference: "WH-IPC-INV" });
    const history = (ipc.getSaleHistory({ limit: 10 }) as R).data as Array<{ sale: { invoiceId: string | null; externalPayment?: { reference: string } } }>;
    expect(history.find((x) => x.sale.invoiceId === id)?.sale.externalPayment?.reference).toBe("WH-IPC-INV");
  });

  it("no method with money marked paid → INVOICE_PAYMENT_METHOD_REQUIRED (still a draft)", () => {
    const id = draft("100.00");
    expect(code(finalize({ invoiceId: id }))).toBe("INVOICE_PAYMENT_METHOD_REQUIRED");
    expect(h.invoices.getInvoice(id).invoice.status).toBe("draft");
  });
});

describe("🔴 the preload forwards the method (found by the first real E2E run)", () => {
  // The first build passed every unit test above and still dropped the method: the preload built the
  // finalizeInvoice payload from two named fields, and these tests call the handlers directly. Pinned here
  // at source level; the E2E (invoice-pay-method.mjs) proves the whole path.
  it("finalizeInvoice's preload passes `payment` through when given, and nothing else new", () => {
    const src = readFileSync(join("src", "preload", "preload.ts"), "utf8");
    const at = src.indexOf("finalizeInvoice: (req) =>");
    const body = src.slice(at, src.indexOf("\n\n", at));
    expect(body).toContain("invoiceId: req.invoiceId");
    expect(body).toContain("issueOnAccount: req.issueOnAccount === true");
    expect(body).toContain("req.payment === undefined ? {} : { payment: req.payment }");
  });
});

describe("🔴 what the renderer cannot send", () => {
  it("exact shapes: no other method word, no extra key, no truthy confirmation", () => {
    const id = draft("100.00");
    for (const payment of [
      { method: "card" },
      { method: "whish", whish: { reference: "W", fundsConfirmed: true } },
      { method: "cash", whish: { reference: "W", fundsConfirmed: true } },
      { method: "cash", amountMinor: "100" },
      { method: "external" },
      { method: "external", whish: { reference: "W", fundsConfirmed: "true" } },
      { method: "external", whish: { reference: "W", fundsConfirmed: true, extra: 1 } },
      "cash",
    ]) {
      expect(code(finalize({ invoiceId: id, payment }))).toBe("INVALID_INPUT");
    }
    expect(h.invoices.getInvoice(id).invoice.status).toBe("draft");
  });
});

describe("on paper — print and PDF render the same document", () => {
  it("cash and Whish print a «طريقة الدفع / Payment method» row; Whish with its reference", () => {
    const cash = draft("100.00");
    h.invoices.finalizeInvoice(cash, { payment: { method: "cash" } });
    const c = printed(cash);
    expect(c).toContain("طريقة الدفع / Payment method");
    expect(c).toContain("نقداً / Cash");

    const whish = draft("100.00");
    h.invoices.finalizeInvoice(whish, { payment: { method: "external", whish: { reference: "WH-PRINT-1", fundsConfirmed: true } } });
    const w = printed(whish);
    expect(w).toContain("ويش موني / Whish Money");
    expect(w).toContain("WH-PRINT-1");
  });

  it("🔴 an invoice with nothing paid prints NO method row — never an invented one", () => {
    const unpaid = draft(null);
    h.invoices.finalizeInvoice(unpaid);
    const html = printed(unpaid);
    expect(html).not.toContain("Payment method");
    expect(html).toContain("Balance Due");
  });

  // Found by the first run: the existing reference rule (cleanPaymentReference) REFUSES markup, so it can
  // never reach the paper. The row still escapes, proven on the function itself — two layers, not one.
  it("a reference with markup is refused at issue; and the printed row escapes anyway", () => {
    const id = draft("100.00");
    expect(() => h.invoices.finalizeInvoice(id, { payment: { method: "external", whish: { reference: "WH<b>1", fundsConfirmed: true } } })).toThrow(/reference is not valid/);
    expect(h.invoices.getInvoice(id).invoice.status).toBe("draft");
    const row = paymentMethodRow({ method: "external", provider: "whish", reference: "WH<b>1" }).join("");
    expect(row).not.toContain("WH<b>1");
    expect(row).toContain("WH&lt;b&gt;1");
  });
});
