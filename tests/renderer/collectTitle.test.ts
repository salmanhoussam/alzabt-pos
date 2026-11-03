/**
 * QW-COLLECT-TITLE — the collection form names the method actually chosen, and a missing "money
 * received" confirmation is shown WHERE it is missing. Wording (exact, both languages) and SOURCE-LEVEL
 * guarantees of the two forms (there is no DOM here; the installed E2E proves the rendered behaviour).
 *
 * 🔴 WHAT MUST HOLD: a Whish, bank transfer, card or other payment is never titled "cash"; the methods
 * offered are exactly the ledger's collection channels; the box is never ticked by the screen; a
 * missing confirmation sends nothing and keeps every typed value; nothing says the money did not arrive.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLLECTION_CHANNELS } from "../../src/domain/ledger";
import { allKeys, translate } from "../../src/shared/i18n";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const STATEMENT = strip(readFileSync("src/renderer/screens/CustomerStatement.tsx", "utf8"));
const FORM = strip(readFileSync("src/renderer/screens/AllocatedReceiptForm.tsx", "utf8"));

describe("the title names the method actually chosen", () => {
  it("every collection channel of the ledger has its own title, in both languages", () => {
    expect([...COLLECTION_CHANNELS]).toEqual(["cash", "card", "whish", "bank_transfer", "other"]);
    for (const m of COLLECTION_CHANNELS) {
      expect(allKeys()).toContain(`collect.title.${m}`);
      expect(translate("ar", `collect.title.${m}`)).not.toBe(`collect.title.${m}`);
      expect(translate("en", `collect.title.${m}`)).not.toBe(`collect.title.${m}`);
    }
  });

  it("🔴 only the cash title says cash — Whish, bank transfer, card and other never do", () => {
    // TRANSITION: `collect.title` («تسجيل دفعة نقديّة» / "Record a cash payment") was shown for EVERY method.
    expect(translate("ar", "collect.title.cash")).toBe("تسجيل دفعة نقديّة");
    expect(translate("en", "collect.title.cash")).toBe("Record a cash payment");
    for (const m of ["card", "whish", "bank_transfer", "other"]) {
      expect(translate("ar", `collect.title.${m}`)).not.toMatch(/نقد/);
      expect(translate("en", `collect.title.${m}`).toLowerCase()).not.toContain("cash");
    }
    expect(translate("ar", "collect.title.whish")).toContain("ويش");
    expect(translate("en", "collect.title.whish")).toContain("Whish");
    expect(translate("ar", "collect.title.bank_transfer")).toContain("تحويل مصرفي");
    expect(translate("en", "collect.title.bank_transfer")).toContain("bank transfer");
    expect(translate("ar", "collect.title.card")).toContain("بالبطاقة");
    expect(translate("en", "collect.title.card")).toContain("card");
  });

  it("the old single title is gone, and the form renders the chosen method's title", () => {
    expect(allKeys()).not.toContain("collect.title");
    expect(STATEMENT).not.toContain('t("collect.title")');
    expect(STATEMENT).toContain('<h4 data-testid="collect-title" data-method={method}>');
    expect(STATEMENT).toContain("{t(`collect.title.${method}`)}");
  });

  it("the methods offered are exactly the ledger's channels — none added, none renamed", () => {
    expect(STATEMENT).toContain('["cash", "card", "whish", "bank_transfer", "other"]');
    expect(FORM).toContain('value="whish"');
    expect(FORM).toContain('value="bank_transfer"');
    expect(FORM).not.toMatch(/value="(cash|card|other)"/);
  });
});

describe("🔴 a missing 'money received' confirmation is shown where it is missing", () => {
  const branch = (src: string, guard: string) => src.slice(src.indexOf(guard), src.indexOf("return;", src.indexOf(guard)) + 7);

  it("single debt: explained, focused, highlighted — and nothing is sent", () => {
    const b = branch(STATEMENT, "if (needsConfirmation && !confirmed) {");
    expect(b).toContain('setPayError(t("collect.confirmRequired"));');
    expect(b).toContain("setConfirmMissing(true);");
    expect(b).toContain("confirmBoxRef.current?.focus();");
    expect(b).not.toMatch(/setConfirmed|post\(|setAmountText|setMethod|setReference|setAttemptKey/);
    // the guard runs before the one send in submit
    const submit = STATEMENT.slice(STATEMENT.indexOf("const submit = async (o: StatementObligationDto)"), STATEMENT.indexOf("const post = async"));
    expect(submit.indexOf("if (needsConfirmation && !confirmed) {")).toBeLessThan(submit.indexOf("await post({"));
  });

  it("shared receipt: the same, before the one receipt send", () => {
    const b = branch(FORM, "if (!confirmed) {");
    expect(b).toContain('setError(t("collect.confirmRequired"));');
    expect(b).toContain("setConfirmMissing(true);");
    expect(b).toContain("confirmBoxRef.current?.focus();");
    expect(b).not.toMatch(/setConfirmed|recordAllocatedReceipt|setShares|setTotalText|setReference|setAttemptKey/);
    const submit = FORM.slice(FORM.indexOf("const submit"), FORM.indexOf("if (currencies.length === 0)"));
    expect(submit.indexOf("if (!confirmed) {")).toBeLessThan(submit.indexOf("recordAllocatedReceipt("));
  });

  it("🔴 the box is never ticked by the screen, in either form", () => {
    for (const src of [STATEMENT, FORM]) {
      expect(src).not.toMatch(/setConfirmed\(true\)/);
      expect(src).not.toMatch(/checked=\{true\}|defaultChecked/);
      expect(src).toContain("checked={confirmed}");
    }
  });

  it("the box carries the error semantics, and the explanation is an alert tied to it", () => {
    expect(STATEMENT).toContain("ref={confirmBoxRef}");
    expect(STATEMENT).toContain("aria-invalid={confirmMissing}");
    expect(STATEMENT).toContain("aria-describedby={confirmMissing ? `collect-confirm-missing-${o.id}` : undefined}");
    expect(STATEMENT).toMatch(/id=\{`collect-confirm-missing-\$\{o\.id\}`\} role="alert" data-testid="collect-confirm-missing"/);
    expect(FORM).toContain("ref={confirmBoxRef}");
    expect(FORM).toContain("aria-invalid={confirmMissing}");
    expect(FORM).toContain('aria-describedby={confirmMissing ? "receipt-confirm-missing" : undefined}');
    expect(FORM).toMatch(/id="receipt-confirm-missing" role="alert" data-testid="receipt-confirm-missing"/);
  });

  it("the highlight goes away as soon as the box (or the method) changes, never on ordinary typing", () => {
    // cleared by: the box itself, a method change, opening / closing the form (resetPaymentDetails)
    expect((STATEMENT.match(/setConfirmMissing\(false\)/g) ?? []).length).toBe(3);
    expect(STATEMENT).toMatch(/const resetPaymentDetails = \(\) => \{[\s\S]*?setConfirmMissing\(false\);/);
    expect((FORM.match(/setConfirmMissing\(false\)/g) ?? []).length).toBe(2);
    // set ONLY by the confirm attempt
    expect((STATEMENT.match(/setConfirmMissing\(true\)/g) ?? []).length).toBe(1);
    expect((FORM.match(/setConfirmMissing\(true\)/g) ?? []).length).toBe(1);
    // the amount field does not move focus or touch the highlight
    const amount = STATEMENT.slice(STATEMENT.indexOf('data-testid="collect-amount"'), STATEMENT.indexOf('data-testid="collect-method"'));
    expect(amount).not.toMatch(/focus\(|setConfirmMissing/);
  });

  it("the posting payload is unchanged: the confirmation is sent only as the owner ticked it", () => {
    expect(STATEMENT).toContain("fundsConfirmed: needsConfirmation ? confirmed : false,");
    expect(FORM).toContain("fundsConfirmed: confirmed,");
  });
});

describe("the explanation's wording", () => {
  it("🔴 says nothing was recorded, never that the money did not arrive — in both languages", () => {
    const ar = translate("ar", "collect.confirmMissing");
    const en = translate("en", "collect.confirmMissing");
    expect(ar).toContain("لم يُسجَّل شيء بعد");
    expect(en).toContain("Nothing has been recorded yet");
    expect(ar).not.toMatch(/لم يصل|لم يُستلم|لم تصل/);
    expect(en.toLowerCase()).not.toMatch(/not received|did not arrive|didn't arrive/);
  });

  it("names the box and the button exactly as the screen shows them (no drift)", () => {
    for (const lang of ["ar", "en"] as const) {
      const text = translate(lang, "collect.confirmMissing");
      expect(text).toContain(translate(lang, "collect.fundsConfirmed").replace(/\.$/, ""));
      expect(text).toContain(translate(lang, "collect.confirm"));
    }
  });
});
