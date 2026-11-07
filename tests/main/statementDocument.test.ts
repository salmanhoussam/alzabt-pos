import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { statementDocumentText } from "../../src/renderer/statementDocument";
import { translate } from "../../src/shared/i18n";
import type { CustomerStatementDto, StatementDocumentDto } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * UX-REF-NUMBERS (owner finding DEC-33 #2, FIELD UAT 2026-11-06): the statement and the collection forms
 * showed «بيعة 5a7cde3c-…». Each debt now carries the readable document behind it, resolved in main from
 * real rows; the ids stay for the accounting links. Nothing is invented, and the invoice number and the
 * sale receipt number are never confused.
 */

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger, invoices: h.invoices }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("each debt shows the document it came from — from real rows only", () => {
  it("an on-account invoice shows ITS number; a till credit sale its RECEIPT number; a manual debt its own reference", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون المراجع" }).party;

    // 1 · an invoice issued on account
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [{ description: "صنف", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "12.00" }], "batch-refs-0001-key");
    h.invoices.updateDraftHeader(invoice.id, { customerPartyId: c.id });
    const issued = h.invoices.finalizeInvoice(invoice.id, { issueOnAccount: true });
    const invoiceNumber = Number(issued.invoice.invoice_number);

    // 2 · a till credit sale
    const credit = h.service.createCustomerCreditSale({
      idempotencyKey: newKey(),
      customerId: c.id,
      lines: [{ productId: "prod-0001", quantityMilli: 2000 }],
      expectedTotalMinor: 500n,
    });
    const receiptNumber = credit.sale.receiptNumber;

    // 3 · a manual debt
    h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "ورقة-17", currency: "USD", amountMinor: 300n });

    const st = ok<CustomerStatementDto>(ipc.getCustomerStatement({ customerId: c.id }));
    const docs = st.obligations.map((o) => o.document).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(docs).toEqual([
      { kind: "invoice", number: invoiceNumber },
      { kind: "manual", reference: "ورقة-17" },
      { kind: "sale", receiptNumber },
    ]);
    // the two series are different numbers, each under its own label — never one passed for the other
    expect(invoiceNumber).not.toBeNaN();
    // the ids are still there for the links, and no document carries one
    for (const o of st.obligations) {
      expect(o.sourceRef.length).toBeGreaterThan(0);
      expect(JSON.stringify(o.document)).not.toMatch(UUID);
    }
  });
});

describe("the words a merchant reads, in both languages", () => {
  const ar = (k: string) => translate("ar", k);
  const en = (k: string) => translate("en", k);
  const cases: [StatementDocumentDto, string, string][] = [
    [{ kind: "invoice", number: 12 }, "فاتورة #12", "Invoice #12"],
    [{ kind: "sale", receiptNumber: 34 }, "إيصال بيع #34", "Sale receipt #34"],
    [{ kind: "manual", reference: "ورقة-17" }, "مستند خارجي ورقة-17", "External document ورقة-17"],
    [{ kind: "unresolved" }, "—", "—"],
  ];
  it.each(cases)("%j", (doc, arabic, english) => {
    expect(statementDocumentText(doc, ar)).toBe(arabic);
    expect(statementDocumentText(doc, en)).toBe(english);
    expect(statementDocumentText(doc, ar)).not.toMatch(UUID);
  });

  it("🔴 no screen prints a debt's raw id any more", () => {
    for (const file of ["src/renderer/screens/CustomerStatement.tsx", "src/renderer/screens/AllocatedReceiptForm.tsx"]) {
      const code = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
      expect(code, file).not.toMatch(/>\s*\{\s*[od]\.sourceRef\s*\}/);
      expect(code, file).not.toMatch(/<bdi[^>]*>\s*\{\s*[od]\.sourceRef\s*\}\s*<\/bdi>/);
    }
  });
});
