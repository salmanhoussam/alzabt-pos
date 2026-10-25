/**
 * M17B-S1 — the shared-receipt form: its arithmetic aid (exact figures), its bilingual wording, and the
 * source-level guarantees of the screens (there is no DOM environment, so these are SOURCE-LEVEL for
 * the markup and BEHAVIOURAL for the pure module). The installed E2E is what proves the rendered form.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocationState, minorOf, sharableCurrencies } from "../../src/renderer/screens/receiptAllocation";
import { allKeys, translate } from "../../src/shared/i18n";

const FORM = readFileSync("src/renderer/screens/AllocatedReceiptForm.tsx", "utf8");
const STATEMENT = readFileSync("src/renderer/screens/CustomerStatement.tsx", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FORM_CODE = strip(FORM);
const STATEMENT_CODE = strip(STATEMENT);

const ob = (id: string, cur: string, paid = false) => ({ id, fullyPaid: paid, outstanding: { minor: "100", currency: cur } }) as never;

describe("which currencies can be shared", () => {
  it("needs TWO open debts in one currency; a paid debt does not count; LBP and USD are never mixed", () => {
    expect(sharableCurrencies({ obligations: [ob("a", "USD"), ob("b", "USD")] })).toEqual(["USD"]);
    expect(sharableCurrencies({ obligations: [ob("a", "USD"), ob("b", "LBP")] })).toEqual([]);
    expect(sharableCurrencies({ obligations: [ob("a", "USD"), ob("b", "USD", true)] })).toEqual([]);
    expect(sharableCurrencies({ obligations: [ob("a", "USD"), ob("b", "USD"), ob("c", "LBP"), ob("d", "LBP")] })).toEqual(["LBP", "USD"]);
  });
});

describe("the exact arithmetic aid (bigint minor units)", () => {
  it("60.00 + 40.00 against 100.00 is complete with nothing left", () => {
    const s = allocationState("USD", "100.00", [{ id: "a", text: "60.00" }, { id: "b", text: "40.00" }]);
    expect([s.total, s.sum, s.left, s.complete]).toEqual([10000n, 10000n, 0n, true]);
  });
  it("99.00 or 101.00 is not complete and shows what is left (or over)", () => {
    expect(allocationState("USD", "100.00", [{ id: "a", text: "60.00" }, { id: "b", text: "39.00" }])).toMatchObject({ left: 100n, complete: false });
    expect(allocationState("USD", "100.00", [{ id: "a", text: "60.00" }, { id: "b", text: "41.00" }])).toMatchObject({ left: -100n, complete: false });
  });
  it("one typed share is never complete; three shares can be; an empty field is not a share", () => {
    expect(allocationState("USD", "60.00", [{ id: "a", text: "60.00" }, { id: "b", text: "" }]).complete).toBe(false);
    expect(allocationState("USD", "100.00", [{ id: "a", text: "50.00" }, { id: "b", text: "30.00" }, { id: "c", text: "20.00" }]).complete).toBe(true);
  });
  it("LBP: 5,000,000.00 = 3,000,000.00 + 2,000,000.00 exactly, with no float anywhere", () => {
    const s = allocationState("LBP", "5000000.00", [{ id: "a", text: "3000000.00" }, { id: "b", text: "2000000.00" }]);
    expect([s.total, s.complete]).toEqual([500000000n, true]);
    // 0.1 + 0.2 is the float trap; minor units cannot hit it
    expect(allocationState("USD", "0.30", [{ id: "a", text: "0.10" }, { id: "b", text: "0.20" }]).complete).toBe(true);
  });
  it("garbage, zero and negative shares are invalid, and an invalid total gives no 'left'", () => {
    expect(allocationState("USD", "100.00", [{ id: "a", text: "abc" }, { id: "b", text: "100.00" }]).complete).toBe(false);
    expect(allocationState("USD", "100.00", [{ id: "a", text: "0.00" }, { id: "b", text: "100.00" }]).complete).toBe(false);
    expect(allocationState("USD", "100.00", [{ id: "a", text: "-5.00" }, { id: "b", text: "105.00" }]).complete).toBe(false);
    expect(allocationState("USD", "", [{ id: "a", text: "1.00" }]).left).toBeNull();
    expect(minorOf("1.005", "USD")).toBeNull(); // not exact in this currency
  });
});

describe("🔴 the wording: never 'nothing was taken', never 'pay again'", () => {
  const keys = (allKeys() as string[]).filter((k) => k.startsWith("allocReceipt."));
  it("every key exists in BOTH languages and is non-empty", () => {
    expect(keys.length).toBeGreaterThanOrEqual(18);
    for (const k of keys) for (const lang of ["ar", "en"] as const) expect(translate(lang, k).trim().length, `${lang} ${k}`).toBeGreaterThan(0);
  });
  it("the not-recorded text says only that ALZABT POS holds no payment, and to check the real one", () => {
    const en = translate("en", "allocReceipt.pending.not_recorded");
    const ar = translate("ar", "allocReceipt.pending.not_recorded");
    expect(en).toBe("No payment was recorded in ALZABT POS for this attempt. This does not confirm whether the money was received. Check the actual payment before retrying the recording.");
    expect(en).not.toMatch(/nothing was taken|not in the ledger|no money/i);
    expect(ar).toContain("هيدا ما بيعني بالضرورة");
    expect(ar).toContain("تأكّد من استلام المبلغ فعلياً");
    expect(ar).not.toContain("لم يُؤخَذ");
  });
  it("the retry button names retrying the POS RECORDING", () => {
    expect(translate("en", "allocReceipt.pending.retry")).toBe("Retry recording this payment");
    expect(translate("ar", "allocReceipt.pending.retry")).toBe("إعادة محاولة تسجيل الدفعة");
    for (const lang of ["ar", "en"] as const) expect(translate(lang, "allocReceipt.pending.retry")).not.toMatch(/pay again|collect again|charge/i);
  });
  it("unknown and conflict use the EXACT approved wording (TRANSITION: replaces the earlier drafts) and tell the owner not to start a new collection", () => {
    // 🔴 TRANSITION with the independent review. The drafts these replace were: unknown "This payment could not be
    // confirmed. Do not record it again…" and conflict "The ledger holds a DIFFERENT payment under the same key…".
    expect(translate("en", "allocReceipt.pending.unknown")).toBe(
      "ALZABT POS could not determine whether this receipt was recorded. Do not start another collection. Reopen the customer statement to check the ledger again.",
    );
    expect(translate("en", "allocReceipt.pending.conflict")).toBe(
      "ALZABT POS found a conflicting or inconsistent receipt record for this attempt. Do not record a new collection. Request a ledger review.",
    );
    expect(translate("ar", "allocReceipt.pending.unknown")).toBe(
      "ما قدر برنامج «عالضبط» يحدّد إذا كان هالقبض تسجّل. ما تبدأ عملية قبض جديدة. أعد فتح كشف الزبون ليتحقّق البرنامج من السجلّ من جديد.",
    );
    expect(translate("ar", "allocReceipt.pending.conflict")).toBe(
      "برنامج «عالضبط» لقى سجلّ قبض متعارض أو غير متطابق لهالمحاولة. ما تسجّل قبض جديد، واطلب مراجعة السجلّ.",
    );
    // neither claims anything about the external money, and neither invites a new collection
    for (const k of ["allocReceipt.pending.unknown", "allocReceipt.pending.conflict"]) {
      expect(translate("en", k)).not.toMatch(/nothing was taken|money was not received|collect it again|pay again/i);
      expect(translate("en", k)).toMatch(/ALZABT POS/);
      expect(translate("ar", k)).toContain("«عالضبط»");
    }
    expect(translate("en", "allocReceipt.pending.unknown")).toMatch(/do not start another collection/i);
    expect(translate("ar", "allocReceipt.pending.unknown")).toContain("ما تبدأ عملية قبض جديدة");
    expect(translate("en", "allocReceipt.pending.conflict")).toMatch(/do not record a new collection/i);
    expect(translate("ar", "allocReceipt.pending.conflict")).toContain("ما تسجّل قبض جديد");
  });
  it("the own refusal sentences exist in both languages and the hint says the reference is never split", () => {
    for (const c of ["RECEIPT_ALLOCATION_MISMATCH", "RECEIPT_NEEDS_TWO_DEBTS", "RECEIPT_CHANNEL_NOT_ALLOWED"]) {
      for (const lang of ["ar", "en"] as const) expect(translate(lang, `allocReceipt.err.${c}`)).not.toBe(`allocReceipt.err.${c}`);
    }
    expect(translate("en", "allocReceipt.hint")).toMatch(/its reference is never split/);
    expect(translate("ar", "allocReceipt.action")).toBe("تسجيل دفعة واحدة على عدّة ديون");
    expect(translate("en", "allocReceipt.left")).toBe("Left to allocate");
    // the original POS-receipt keys are untouched
    expect(translate("en", "receipt.total")).toBe("Total");
  });
});

describe("the form — source-level guarantees", () => {
  it("🔴 there is ONE reference field and nothing derives a per-debt reference", () => {
    expect((FORM_CODE.match(/data-testid="receipt-reference"/g) ?? []).length).toBe(1);
    expect(FORM_CODE).not.toMatch(/reference\s*\+|`\$\{reference\}|reference\.concat|-\$\{/);
    expect(FORM_CODE).toContain("reference: reference.trim()");
  });
  it("only Whish and bank transfer can be chosen; no cash, card or other", () => {
    expect(FORM_CODE).toContain('value="whish"');
    expect(FORM_CODE).toContain('value="bank_transfer"');
    expect(FORM_CODE).not.toMatch(/value="(cash|card|other)"/);
  });
  it("🔴 Confirm needs exact completion; every field and Cancel are locked while blocked or busy; Confirm vanishes when blocked", () => {
    expect(FORM_CODE).toContain("disabled={busy || !complete}");
    expect((FORM_CODE.match(/disabled=\{blocked \|\| busy\}/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(FORM_CODE).toContain("{!blocked && (");
    expect(FORM_CODE).toMatch(/onClick=\{onClose\} disabled=\{blocked \|\| busy\}/);
  });
  it("the key is replaced when anything that defines the payment changes, and NOT after a failure", () => {
    expect((FORM_CODE.match(/edited\(\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
    const submit = FORM_CODE.slice(FORM_CODE.indexOf("const submit"), FORM_CODE.indexOf("if (currencies.length === 0)"));
    expect(submit).not.toContain("setAttemptKey(");
    expect(submit).toContain("idempotencyKey: attemptKey");
  });
  it("🔴 an unknown outcome locks the form and only the LEDGER's answer releases it (TRANSITION with finding R1)", () => {
    // TRANSITION with R1: the answer is now {status, statement}; "recorded" LEAVES the form through the
    // existing duplicate outcome, "not_recorded" re-offers the exact retry, and nothing else unlocks.
    const submit = FORM_CODE.slice(FORM_CODE.indexOf("const submit"), FORM_CODE.indexOf("if (currencies.length === 0)"));
    expect(submit).toContain("UNSAFE_TO_RETRY.has(err.code)");
    expect(submit).toContain("setBlocked(true)");
    expect(submit).toContain("await onAskLedger(attemptKey, request)");
    expect(submit).toContain('answer.status === "recorded" && answer.statement !== null');
    expect(submit).toContain("onRecorded(answer.statement, true)");
    expect(submit).toContain('answer.status === "not_recorded"');
    expect((submit.match(/setBlocked\(false\)/g) ?? []).length).toBe(1); // only inside the not_recorded branch
    // reconciling NEVER sends a receipt: the only send in the form is the one guarded by busy/blocked
    expect((FORM_CODE.match(/recordAllocatedReceipt\(/g) ?? []).length).toBe(1);
    expect(submit).toContain("if (busy || blocked) return;");
    // nothing but "recorded" or "not_recorded" ever releases it: unknown, conflict and absent are not mentioned as releases
    expect(submit).not.toMatch(/status === "(unknown|conflict|absent)"/);
  });
  it("early refusals are in the owner's language and need the reference and the funds confirmation", () => {
    expect(FORM_CODE).toContain('t("collect.referenceRequired")');
    expect(FORM_CODE).toContain('t("collect.confirmRequired")');
    expect(FORM_CODE).toContain('type="checkbox"');
    expect(FORM_CODE).toContain("checked={confirmed}"); // starts unchecked: useState(false)
    expect(FORM_CODE).toContain("useState(false)");
  });
});

describe("the statement screen — recovery and locking", () => {
  it("🔴 pending receipts come from the statement (the ledger), and unknown/conflict lock EVERY new payment", () => {
    expect(STATEMENT_CODE).toContain("statement.pendingReceipts");
    expect(STATEMENT_CODE).toMatch(/statement\.pendingReceipts\.some\(\(p\) => p\.status === "unknown" \|\| p\.status === "conflict"\)/);
    expect(STATEMENT_CODE).toMatch(/disabled=\{blocked \|\| busy \|\| lockedByPending \|\| payingId !== null\}/); // the receipt action
    expect(STATEMENT_CODE).toMatch(/disabled=\{blocked \|\| busy \|\| lockedByPending \|\| receiptOpen\}/); // the per-debt collect
  });
  it("🔴 the retry repeats the ORIGINAL key and the ledger's own record, never the form's state", () => {
    const fn = STATEMENT_CODE.slice(STATEMENT_CODE.indexOf("const repeatPendingReceipt"), STATEMENT_CODE.indexOf("useEffect(() => {"));
    expect(fn).toContain("idempotencyKey: p.idempotencyKey");
    expect(fn).toContain("channel: p.provider");
    expect(fn).toContain("reference: p.reference");
    expect(fn).toContain("totalMinor: p.total.minor");
    expect(fn).toContain("p.allocations.map");
    expect(fn).not.toMatch(/newIdempotencyKey|attemptKey|amountText/);
    // only a not_recorded attempt offers the button
    expect(STATEMENT_CODE).toMatch(/p\.status === "not_recorded" && \(\s*<button[^>]*receipt-pending-retry|receipt-pending-retry/);
  });
  it("a failed ledger lookup is 'unknown', never 'not recorded' (TRANSITION with finding R1)", () => {
    const fn = STATEMENT_CODE.slice(STATEMENT_CODE.indexOf("const askLedgerAboutReceipt"), STATEMENT_CODE.indexOf("const repeatPendingReceipt"));
    expect(fn).toContain("reconcileReceiptOutcome(next, key, request)");
    expect(fn).toMatch(/catch \{\s*return \{ status: "unknown", statement: null \}/);
    expect(fn).not.toContain("recordAllocatedReceipt"); // read-only: it never sends a receipt
    expect(fn).not.toContain("not_recorded");
  });
  it("the statement screen itself does no money arithmetic for receipts; each history share names its receipt", () => {
    expect(STATEMENT_CODE).not.toMatch(/BigInt\(|parseDecimal\(.*\)\.minor\s*[-+]/);
    expect(STATEMENT_CODE).toContain('data-testid="statement-settlement-share"');
    expect(STATEMENT_CODE).toContain('t("allocReceipt.shareOf")');
  });
  it("the preload and contract carry receipt data in the statement without a new write path", () => {
    expect(STATEMENT_CODE).toContain("pos().recordAllocatedReceipt");
    expect((STATEMENT_CODE.match(/recordAllocatedReceipt/g) ?? []).length).toBe(1);
  });
});
