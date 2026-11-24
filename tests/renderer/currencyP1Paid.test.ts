/**
 * CURRENCY-P1 — Workstream A (Finding C): the paid amount is written only when the merchant typed into it AND its value
 * differs from the stored one; and every amount the invoice sheet renders uses the currency's own exponent.
 *
 * Two layers, both asserted: the pure decision (`paidWriteDecision`) and the sheet's wiring of it (source, comments
 * stripped — the same technique as `invoiceHeaderSave.test.ts`). The behaviour in a real DOM is measured separately by
 * the screen-only Chromium scenarios in the hand-off (`scenarios-currency.mjs`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDecimal } from "../../src/domain/money";
import { paidWriteDecision } from "../../src/renderer/screens/invoices/headerSaveQueue";

const parseIn = (currency: string) => (text: string) => parseDecimal(text.trim(), currency);

// TRANSITION (CURRENCY-P1 R2, Abu Abbas P1-1): the decision no longer takes a touch flag. It takes the VISIBLE value
// and the sheet's own exact rendering of the stored amount. The Phase 1 cases are kept in meaning: an untouched field
// is its own rendering (→ "omit"); a value-equal retype resolves; a different amount is sent. What changed on purpose:
// a value that differs from the store is SENT however it got there — Phase 1 omitted it when no `input` had fired.
describe("paidWriteDecision (R2: value-based, event-free)", () => {
  it("the visible text IS the stored rendering → omit (untouched; never written back), in every currency", () => {
    expect(paidWriteDecision("5.00", "5.00", "500", parseIn("USD"))).toBe("omit");
    expect(paidWriteDecision("1500.00", "1500.00", "150000", parseIn("LBP"))).toBe("omit");
    expect(paidWriteDecision("0.100", "0.100", "100", parseIn("JOD"))).toBe("omit"); // Abbas's Finding C shape, now exact
    expect(paidWriteDecision("", "", "0", parseIn("USD"))).toBe("omit"); // zero paid renders empty
  });

  it("different text, same amount (parsed in the invoice currency) → resolve, no write", () => {
    expect(paidWriteDecision("5", "5.00", "500", parseIn("USD"))).toBe("resolve");
    expect(paidWriteDecision(" 5.00 ", "5.00", "500", parseIn("USD"))).toBe("resolve");
    expect(paidWriteDecision("1500", "1500.00", "150000", parseIn("LBP"))).toBe("resolve");
    expect(paidWriteDecision("0.1", "0.100", "100", parseIn("JOD"))).toBe("resolve");
    expect(paidWriteDecision("   ", "", "0", parseIn("USD"))).toBe("resolve");
  });

  it("a different amount, a cleared field or unparseable text → send (the service stores it or refuses it)", () => {
    expect(paidWriteDecision("3.00", "10.00", "1000", parseIn("USD"))).toBe("send"); // P1-1's exact case
    expect(paidWriteDecision("1.00", "0.100", "100", parseIn("JOD"))).toBe("send"); // a visible 1.00 JOD is a change
    expect(paidWriteDecision("", "5.00", "500", parseIn("USD"))).toBe("send");
    expect(paidWriteDecision("abc", "5.00", "500", parseIn("USD"))).toBe("send");
    expect(paidWriteDecision("1.005", "1.00", "100", parseIn("USD"))).toBe("send");
    expect(paidWriteDecision("0.50", "", "0", parseIn("LBP"))).toBe("send"); // fractional LBP, from zero
  });
});

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SHEET = strip(readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8"));
const QUEUE = strip(readFileSync("src/renderer/screens/invoices/ReconciliationQueue.tsx", "utf8"));
const DOC = strip(readFileSync("src/main/invoiceDocument.ts", "utf8"));
const RECEIPT = strip(readFileSync("src/main/saleReceiptDocument.ts", "utf8"));
const IPC = strip(readFileSync("src/main/ipcHandlers.ts", "utf8"));

describe("sheet wiring (source, comments stripped)", () => {
  it("no fixed-two-decimal money formatter is left in the sheet; priceText is the domain's formatDecimal", () => {
    expect(SHEET).not.toMatch(/padStart\(3, "0"\)/);
    expect(SHEET).toMatch(/function priceText\(minor: string, currency: string\): string \{\s*return formatDecimal\(money\(BigInt\(minor\), currency\)\);\s*\}/);
    // every call names a currency
    const calls = [...SHEET.matchAll(/\b(?:priceText|paidText)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const args of calls) expect(args.split(",").length, args).toBe(2);
  });

  // TRANSITION (R2): no `onInput` touch flag exists any more; the decision reads the input's VALUE.
  it("the paid field: its blur, every full flush, the exit check and the late checks all go through paidDecision", () => {
    expect(SHEET).not.toMatch(/paidTouched/);
    const flush = SHEET.slice(SHEET.indexOf("const flushHeader ="), SHEET.indexOf("const storedDisplay ="));
    // TRANSITION (R2): an exact rendering ("omit") and a value-equal retype ("resolve") are both left out of the patch.
    expect(flush).toMatch(/if \(key === "paid"\) \{\s*const decision = paidDecision\(\);\s*if \(decision === "omit" \|\| decision === "resolve"\) \{\s*paidResolved = true;\s*continue;/);
    const dirty = SHEET.slice(SHEET.indexOf("const isDirty ="), SHEET.indexOf("const snapshot ="));
    expect(dirty).toMatch(/if \(paidDecision\(\) === "send"\) return true;/);
    expect(SHEET).toMatch(/return paidWriteDecision\(el\.value, rendering, inv\.paid\.minor,/);
    expect(SHEET).toMatch(/const rendering = inv\.paid\.minor === "0" \? "" : paidText\(inv\.paid\.minor, inv\.paid\.currency\);/);
    expect(SHEET).toMatch(/const verifyPaid = \(\): string \| null => \(paidDecision\(\) === "send" \? t\("inv\.sheet\.paidUnverified"\) : null\);/);
    // the late check sits after every flush that ends in a success claim: «محفوظة», «حفظ وخروج», the confirmation, the issue
    expect((SHEET.match(/= verifyPaid\(\);/g) ?? []).length).toBe(4);
  });

  it("reconciliation: the invoice-side price uses the frozen line's currency", () => {
    expect(QUEUE).toMatch(/valueOf\(d, "invoice", item\.line\?\.unitPrice\.currency \?\? null\)/);
  });
});

describe("document and photo paths take the exponent from the currency", () => {
  it("no caller-chosen or LBP-special exponent remains", () => {
    expect(DOC).not.toMatch(/=== "LBP" \? 0 : 2/);
    expect(DOC).toMatch(/const exponent = currencyExponent\(m\.currency\);/);
    expect(DOC).toMatch(/export function printMoney\(m: MoneyDto\): string \{/);
    expect(RECEIPT).toMatch(/function printDecimal\(m: MoneyDto\): string \{\s*return printDecimalOf\(m\);\s*\}/);
    expect(IPC).not.toMatch(/=== "LBP" \? 0 : 2/);
    expect(IPC).toMatch(/const exponent = currencyExponent\(currency\);/);
  });
});

// R3 (Abu Abbas, R2 review — the issue-confirmation race). Behaviour is measured by the screen scenarios
// (`scenarios-confirm-r3.mjs`, 14/14 on R3, 6/14 on R2); these pin the wiring so it cannot silently regress.
describe("R3 issue-confirmation wiring (source, comments stripped)", () => {
  // TRANSITION (R4, Abu Abbas R3-1): the same seven sections are now inert while ANY modal is open, not only the
  // confirmation — the picker left them live, which is how «إصدار» was reached behind it.
  it("every background section is inert while a modal is open — seven, and nothing inside the dialog", () => {
    expect(SHEET).not.toMatch(/inert=\{confirming\}/);
    expect((SHEET.match(/inert=\{modalOpen\}/g) ?? []).length).toBe(7);
    const dialog = SHEET.slice(SHEET.indexOf('data-testid="finalize-confirm"'), SHEET.indexOf('data-testid="exit-confirm"'));
    expect(dialog).not.toMatch(/inert=/);
  });

  it("the issue is bound to the figures the confirmation showed: captured on open, compared after every flush", () => {
    // TRANSITION (R4): the confirmation now opens through the one-modal gate, right after the figures are captured.
    // TRANSITION (R5): the figures are the COMPLETE draft (`confirmationDigest`, every line), and the confirmation opens
    // from inside its own action.
    expect(SHEET).toMatch(/confirmedFigures\.current = storedView \? confirmationDigest\(storedView, issueOnAccount\) : null;\s*if \(!openModal\("confirm", \(\) => setConfirming\(true\), issueButton, true\)\) return;/);
    const fin = SHEET.slice(SHEET.indexOf("const finalize = async"), SHEET.indexOf("const print = async"));
    const late = fin.indexOf("const latePaidRefusal = verifyPaid();");
    const bind = fin.indexOf('confirmationDigest(freshStored, issueOnAccount) !== confirmedFigures.current'); // TRANSITION (R5)
    const send = fin.indexOf("pos().finalizeInvoice(");
    expect(late).toBeGreaterThan(0);
    expect(bind).toBeGreaterThan(late);
    expect(send).toBeGreaterThan(bind);
    expect(fin).toMatch(/setIssueRefusal\(t\("inv\.sheet\.confirmStale"\)\);\s*return;/);
  });

  it("while the finalize request is in flight the paid amount is text, never an input", () => {
    const fin = SHEET.slice(SHEET.indexOf("const finalize = async"), SHEET.indexOf("const print = async"));
    expect(fin.indexOf("setIssuing(true);")).toBeLessThan(fin.indexOf("pos().finalizeInvoice("));
    // TRANSITION (R5): the finally also ends the issue's ownership of the screen, before the paid input returns.
    expect(fin).toMatch(/\} finally \{\s*operatingRef\.current = false;\s*setOperating\(false\);\s*setIssuing\(false\);\s*setBusy\(false\);\s*\}/);
    expect(SHEET).toMatch(/\{readOnly \|\| issuing \? \(\s*<bdi dir="ltr" data-testid=\{issuing \? "sheet-paid-issuing" : undefined\}>\{fmt\(inv\.paid\)\}<\/bdi>/);
  });
});

// R4 (Abu Abbas, R3 review finding R3-1 — the confirmation issued BEHIND the product picker). Behaviour is measured by
// the screen scenarios (`scenarios-modal-r4.mjs`, 22/22 on R4, 2/22 on R3); these pin the wiring.
describe("R4 one-modal wiring (source, comments stripped)", () => {
  it("every sheet dialog opens through openModal — no direct opener is left", () => {
    expect(SHEET).not.toMatch(/onClick=\{\(\) => setPickerFor\((?!null\))/); // closing (null) is not opening
    expect(SHEET).not.toMatch(/act\(\(\) => setFindingCustomer\(true\)\)/);
    expect(SHEET).not.toMatch(/onClick=\{\(\) => setDiscarding\(true\)\}/);
    expect(SHEET).not.toMatch(/^\s*setExiting\(true\);$/m);
    expect(SHEET).not.toMatch(/^\s*setConfirming\(true\);$/m);
    expect((SHEET.match(/openModal\("picker"/g) ?? []).length).toBe(2);
    expect((SHEET.match(/openModal\("customer"/g) ?? []).length).toBe(2);
    expect((SHEET.match(/openModal\("discard"/g) ?? []).length).toBe(1);
    expect((SHEET.match(/openModal\("exit"/g) ?? []).length).toBe(1);
    expect((SHEET.match(/openModal\("confirm"/g) ?? []).length).toBe(1);
  });

  it("the issue is refused at the action boundary unless the confirmation is the one modal, and again before dispatch", () => {
    const fin = SHEET.slice(SHEET.indexOf("const finalize = async"), SHEET.indexOf("const print = async"));
    const gate = fin.indexOf('if (modals.length !== 1 || modals[0] !== "confirm") {');
    const late = fin.indexOf("if (modalsRef.current.value.length > 0) {");
    const send = fin.indexOf("pos().finalizeInvoice(");
    expect(gate).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(fin.indexOf("confirmationDigest(freshStored, issueOnAccount) !== confirmedFigures.current")); // TRANSITION (R5)
    expect(send).toBeGreaterThan(late);
    // TRANSITION (R5): closed through `closeModal` (ref first), and the issue then OWNS the screen until it answers.
    expect(fin).toMatch(/closeModal\("confirm", \(\) => setConfirming\(false\)\);\s*operatingRef\.current = true;\s*setOperating\(true\);\s*claimAppModal\(appOwnerId\);/);
    const prep = SHEET.slice(SHEET.indexOf("const prepareFinalize = async"), SHEET.indexOf("const finalize = async"));
    expect(prep).toMatch(/if \(modalsRef\.current\.value\.length > 0\) \{\s*setError\(t\("inv\.sheet\.modalOpen"\)\);\s*return;/);
  });

  it("every sheet dialog is a modal dialog with a root the focus trap can find", () => {
    for (const kind of ["confirm", "exit", "discard", "finalized", "picker"]) {
      expect(SHEET).toContain(`data-sheet-modal="${kind}"`);
    }
    expect((SHEET.match(/role="dialog" aria-modal="true"/g) ?? []).length).toBe(5);
    expect(SHEET).toMatch(/useModalFocus\(openModals\[0\] \?\? null, sheetRef, modalOpener\);/);
    expect(SHEET).toMatch(/<div className="inv-sheet" ref=\{sheetRef\} inert=\{activeAppOwner !== null && activeAppOwner !== appOwnerId\}>/);
  });
});

// R5 (Abu Abbas, R4 review F1–F3). Behaviour is measured by `scenarios-app-r5.mjs` on the REAL App (26/26), with four
// disposable mutants as negative controls, and by `tests/application/invoiceConfirmationBoundary.test.ts` on SQLite.
// These pin the wiring.
describe("R5 ownership and confirmation wiring (source, comments stripped)", () => {
  const APP = strip(readFileSync("src/renderer/App.tsx", "utf8"));
  const MODAL = strip(readFileSync("src/renderer/screens/invoices/sheetModal.ts", "utf8"));
  const DIGEST = strip(readFileSync("src/shared/invoiceConfirmation.ts", "utf8"));
  const SERVICE = strip(readFileSync("src/application/invoiceService.ts", "utf8"));

  it("the shell is inert while the sheet owns interaction, and every shell action refuses at execution", () => {
    expect(APP).toMatch(/<header className="topbar" inert=\{modalOwner !== null\}>/);
    expect(APP).toMatch(/if \(!shellFree\(\)\) return;/);
    expect(APP).toMatch(/shellFree\(\) && setLanguage\(/);
    expect(APP).toMatch(/shellFree\(\) && logout\(\)/);
    expect(MODAL).toMatch(/document\.addEventListener\("focusin", onFocusIn, true\);/);
  });

  it("one gate for actions and writes: checked at the request and again when a queued action runs", () => {
    const act = SHEET.slice(SHEET.indexOf("const act = ("), SHEET.indexOf("const header = ("));
    expect((act.match(/dialogAllows\(by\)/g) ?? []).length).toBe(2);
    const bg = SHEET.slice(SHEET.indexOf("const background = ("), SHEET.indexOf("const act = ("));
    expect(bg).toMatch(/if \(externalOwner\(\) \|\| operatingRef\.current \|\| preparingIssue\.current \|\| !dialogAllows\(by\)\) \{[\s\S]*?return Promise\.resolve\(false\);/);
    expect(SHEET).toMatch(/act\(finalize, "confirm"\)/);
    expect(SHEET).toMatch(/act\(discard, "discard"\)/);
    expect(SHEET).toMatch(/act\(saveAndLeave, "exit"\)/);
  });

  it("the confirmation is the COMPLETE draft, withdrawn when the draft changes, and checked again by the service", () => {
    expect(DIGEST).toMatch(/rows: view\.lines\.length,/);
    expect(DIGEST).toMatch(/lines: view\.lines\.map\(\(l\) => \[\s*l\.id,\s*l\.lineNo,\s*l\.description/);
    expect(SHEET).toMatch(/if \(confirmationDigest\(view, issueOnAccount\) === confirmedFigures\.current\) return;\s*confirmedFigures\.current = null;\s*closeModal\("confirm"/);
    expect((SHEET.match(/confirmedDraft(,| \})/g) ?? []).length).toBe(2);
    expect(SERVICE).toMatch(/confirmationDigest\(toInvoiceViewDto\(\{ invoice, lines \}\), credit !== null\) !== confirmedDraft/);
    // compared before anything irreversible: before the number is allocated and the invoice frozen
    const within = SERVICE.slice(SERVICE.indexOf("private finalizeWithin("));
    expect(within.indexOf("INVOICE_CONFIRMATION_STALE")).toBeGreaterThan(0);
    expect(within.indexOf("INVOICE_CONFIRMATION_STALE")).toBeLessThan(within.indexOf("this.deps.invoices.finalize("));
  });
});
