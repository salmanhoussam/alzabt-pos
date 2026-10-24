/**
 * The invoice sheet's customer-account UI (migration 16) — SOURCE-LEVEL assertions plus the
 * bilingual dictionary. There is no DOM test environment, so this pins wiring, not rendering.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translate } from "../../src/shared/i18n";

const SHEET = readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const KEYS = [
  "inv.account.title",
  "inv.account.choose",
  "inv.account.change",
  "inv.account.unlink",
  "inv.account.hint",
  "inv.account.issue",
  "inv.account.issueHint",
  "inv.account.confirmRow",
  "inv.account.issued",
  "inv.account.unknown",
  "inv.account.err.CREDIT_OWNER_ONLY",
  "inv.account.err.CREDIT_NEEDS_CUSTOMER",
  "inv.account.err.CREDIT_NEEDS_UNPAID",
  "inv.account.err.CREDIT_NOT_ISSUED",
];

describe("labels exist in both languages", () => {
  it("every account key has a real Arabic and English sentence", () => {
    for (const k of KEYS) {
      for (const lang of ["ar", "en"] as const) {
        const text = translate(lang, k);
        expect(text, `${lang} ${k}`).not.toBe(k);
        expect(text.length).toBeGreaterThan(3);
      }
    }
  });
  it("the two promises operators rely on are stated plainly", () => {
    expect(translate("en", "inv.account.hint")).toMatch(/does not create a debt/i);
    expect(translate("ar", "inv.account.hint")).toContain("لا يُنشئ ديناً");
    expect(translate("en", "inv.account.issue")).toBe("Issue on Customer Account");
    expect(translate("ar", "inv.account.issue")).toBe("إصدار على حساب العميل");
  });
});

describe("the sheet's wiring (source-level)", () => {
  it("🔴 the account is chosen by id through the existing customer finder — never by name", () => {
    expect(SHEET).toContain("<CustomerFinder");
    expect(SHEET).toContain("chooseAccount(c.id, c.displayName)");
    expect(SHEET).toContain("customerPartyId: customerId");
    // the printed-name input never feeds the link
    expect(SHEET).not.toMatch(/customerPartyId:[^,}]*customerName/);
  });
  it("🔴 issue-on-account is owner-only, starts off, and is sent only when explicitly ticked", () => {
    expect(SHEET).toContain('useState(false)'); // isOwner / issueOnAccount default to false
    expect(SHEET).toMatch(/linkedId && isOwner[\s\S]{0,400}data-testid="account-issue"/);
    expect(SHEET).toContain("const account = issueOnAccount;");
    expect(SHEET).not.toMatch(/issueOnAccount && viewRef\.current\?\.invoice\.customerPartyId \? issueOnAccount : false/);
    expect(SHEET).toContain("finalizeInvoice({ invoiceId, issueOnAccount: account })");
    expect(SHEET).not.toMatch(/setIssueOnAccount\(true\)/);
  });
  it("🔴 changing the linked customer clears the previous credit authorization", () => {
    expect(SHEET).toContain("next.invoice.customerPartyId !== previousCustomerId");
    expect(SHEET).toContain("setIssueOnAccount(false)");
  });
  it("🔴 the whole total must be unpaid — refused on the STORED values before the confirmation", () => {
    const body = SHEET.slice(SHEET.indexOf("const prepareFinalize"));
    expect(body.indexOf("await flushHeader()")).toBeLessThan(body.indexOf('inv.account.err.CREDIT_NEEDS_UNPAID'));
    expect(body.indexOf('inv.account.err.CREDIT_NEEDS_UNPAID')).toBeLessThan(body.indexOf("setConfirming(true)"));
  });
  it("🔴 an unclear outcome is resolved by asking the ledger (a verified replay), never by guessing", () => {
    expect(SHEET).toContain('e.code === "INVOICE_FINALIZED"');
    expect(SHEET).toContain("finalizeInvoice({ invoiceId, issueOnAccount: true })");
    expect(SHEET).toContain('t("inv.account.unknown")');
  });
  it("the confirmation and the issued notice name the account", () => {
    expect(SHEET).toContain('data-testid="confirm-account"');
    expect(SHEET).toContain('data-testid="finalized-on-account"');
  });
});
