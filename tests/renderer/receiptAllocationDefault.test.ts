/**
 * M17B-ALLOC-DEFAULT (ACC-3) — the shared receipt proposes its shares OLDEST DEBT FIRST until the owner
 * edits one. Exact figures for the pure module (bigint minor units), and SOURCE-LEVEL guarantees for the
 * form (there is no DOM here; the installed E2E proves the rendered form).
 *
 * 🔴 WHAT MUST HOLD: oldest first by `posted_at` then id; no debt gets more than it owes; nothing gets
 * more than the total; what cannot be absorbed is reported, never spread; a total that lands on ONE
 * debt is never sent as a shared receipt; a manual share is never rewritten; nothing is posted before
 * the owner's explicit Confirm.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocationState,
  byAge,
  leftText,
  type OpenDebt,
  oldestFirstShares,
  openDebtsOf,
} from "../../src/renderer/screens/receiptAllocation";
import { allKeys, translate } from "../../src/shared/i18n";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FORM = strip(readFileSync("src/renderer/screens/AllocatedReceiptForm.tsx", "utf8"));
const STATEMENT = strip(readFileSync("src/renderer/screens/CustomerStatement.tsx", "utf8"));

const debt = (id: string, postedAt: string, owed: bigint): OpenDebt => ({ id, postedAt, outstandingMinor: owed });
const T1 = "2026-10-01T09:00:00.000Z";
const T2 = "2026-10-02T09:00:00.000Z";
const T3 = "2026-10-03T09:00:00.000Z";

describe("oldest debt first — the proposal (exact minor units)", () => {
  it("the field case: 0.60 (older) + 1.50, a 2.00 receipt → 0.60 then 1.40", () => {
    const r = oldestFirstShares(200n, [debt("new", T2, 150n), debt("old", T1, 60n)]);
    expect(r.shares).toEqual([
      { id: "old", minor: 60n },
      { id: "new", minor: 140n },
    ]);
    expect(r.unallocated).toBe(0n);
  });

  it("orders by posted_at, and EQUAL times by id — the ledger's own ORDER BY posted_at, id", () => {
    const debts = [debt("c", T1, 100n), debt("a", T1, 100n), debt("b", T2, 100n)];
    expect(oldestFirstShares(250n, debts).shares.map((s) => s.id)).toEqual(["a", "c", "b"]);
    // the input order never matters
    expect(oldestFirstShares(250n, [...debts].reverse()).shares).toEqual(oldestFirstShares(250n, debts).shares);
    expect([debt("b", T1, 1n), debt("a", T1, 1n)].sort(byAge).map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("exactly the oldest debt, or less, lands on ONE debt only", () => {
    const debts = [debt("old", T1, 500n), debt("new", T2, 300n)];
    expect(oldestFirstShares(500n, debts).shares).toEqual([{ id: "old", minor: 500n }]);
    expect(oldestFirstShares(120n, debts).shares).toEqual([{ id: "old", minor: 120n }]);
  });

  it("spans two or more debts, never giving any debt more than it owes", () => {
    const debts = [debt("a", T1, 100n), debt("b", T2, 200n), debt("c", T3, 300n)];
    const r = oldestFirstShares(450n, debts);
    expect(r.shares).toEqual([
      { id: "a", minor: 100n },
      { id: "b", minor: 200n },
      { id: "c", minor: 150n },
    ]);
    for (const s of r.shares) expect(s.minor).toBeLessThanOrEqual(debts.find((d) => d.id === s.id)!.outstandingMinor);
    expect(r.shares.reduce((a, s) => a + s.minor, 0n)).toBe(450n);
  });

  it("🔴 more than everything owed: every debt is filled and the REST is reported, never spread", () => {
    const r = oldestFirstShares(1000n, [debt("a", T1, 100n), debt("b", T2, 200n)]);
    expect(r.shares).toEqual([
      { id: "a", minor: 100n },
      { id: "b", minor: 200n },
    ]);
    expect(r.unallocated).toBe(700n);
  });

  it("zero or negative proposes nothing; a debt with nothing owed receives nothing", () => {
    expect(oldestFirstShares(0n, [debt("a", T1, 100n)])).toEqual({ shares: [], unallocated: 0n });
    expect(oldestFirstShares(-5n, [debt("a", T1, 100n)])).toEqual({ shares: [], unallocated: 0n });
    expect(oldestFirstShares(50n, [debt("z", T1, 0n), debt("a", T2, 100n)]).shares).toEqual([{ id: "a", minor: 50n }]);
  });

  it("🔴 currencies never mix: only the chosen currency's OPEN debts, oldest first", () => {
    const ob = (id: string, cur: string, minor: string, postedAt: string, fullyPaid = false) =>
      ({ id, fullyPaid, postedAt, outstanding: { minor, currency: cur } }) as never;
    const statement = { obligations: [ob("u2", "USD", "300", T2), ob("l1", "LBP", "9000000", T1), ob("u1", "USD", "100", T1), ob("u0", "USD", "0", T1, true)] };
    expect(openDebtsOf(statement, "USD")).toEqual([debt("u1", T1, 100n), debt("u2", T2, 300n)]);
    expect(openDebtsOf(statement, "LBP")).toEqual([debt("l1", T1, 9000000n)]);
  });
});

describe("the arithmetic aid now also knows what each debt owes", () => {
  const owed = new Map([
    ["a", 100n],
    ["b", 200n],
  ]);
  it("a share over what its debt owes is flagged and blocks completion", () => {
    const s = allocationState("USD", "3.00", [{ id: "a", text: "1.50" }, { id: "b", text: "1.50" }], owed);
    expect(s.overDebt).toEqual(["a"]);
    expect(s.complete).toBe(false);
  });
  it("🔴 a total that lands entirely on ONE debt is not complete — it names that debt instead", () => {
    const s = allocationState("USD", "0.80", [{ id: "a", text: "0.80" }, { id: "b", text: "" }], owed);
    expect(s.singleDebt).toBe("a");
    expect(s.complete).toBe(false);
    // not exact → no single-debt pointer either
    expect(allocationState("USD", "0.90", [{ id: "a", text: "0.80" }], owed).singleDebt).toBeNull();
  });
  it("two exact shares within what is owed are complete (the existing rule, unchanged)", () => {
    const s = allocationState("USD", "2.00", [{ id: "a", text: "0.60" }, { id: "b", text: "1.40" }], owed);
    expect(s).toMatchObject({ complete: true, overDebt: [], singleDebt: null, left: 0n });
  });
  it("without the debts' figures it behaves exactly as before (no over-debt check)", () => {
    expect(allocationState("USD", "3.00", [{ id: "a", text: "1.50" }, { id: "b", text: "1.50" }]).complete).toBe(true);
  });
});

describe("🔴 shares above the total never crash the screen (pre-existing defect, measured on ed6123f)", () => {
  it("'left' is shown signed, from the absolute amount — money() never sees a negative", () => {
    expect(leftText(-100n, "USD")).toBe("−1.00 USD");
    expect(leftText(100n, "USD")).toBe("1.00 USD");
    expect(leftText(0n, "LBP")).toBe("0.00 LBP");
    expect(leftText(null, "USD")).toBe("—");
  });
  it("the form renders 'left' only through leftText, and says the shares must add up when they are over", () => {
    expect(FORM).not.toMatch(/money\(left/);
    expect(FORM).toContain("{leftText(left, currency)}");
    const over = FORM.slice(FORM.indexOf("left !== null && left < 0n"), FORM.indexOf('data-testid="receipt-over-total"') + 40);
    expect(over).toContain('data-testid="receipt-over-total"');
    expect(FORM).toContain('t("allocReceipt.err.RECEIPT_ALLOCATION_MISMATCH")');
  });
});

describe("the form — source-level guarantees", () => {
  it("🔴 the proposal is used only while NOT manual; the first share edit switches to manual", () => {
    expect(FORM).toContain("const proposal = manual || typedTotal === null ? null : oldestFirstShares(typedTotal, open);");
    const shareInput = FORM.slice(FORM.indexOf('data-testid="receipt-share"'), FORM.indexOf('data-testid="receipt-share-over"'));
    expect(shareInput).toContain("setShares({ ...shown, [d.id]: e.target.value });");
    expect(shareInput).toContain("setManual(true);");
    expect(shareInput).toContain("edited();");
  });
  it("only the explicit re-distribute action (and a currency change) returns to automatic", () => {
    expect((FORM.match(/setManual\(false\)/g) ?? []).length).toBe(2);
    const reset = FORM.slice(FORM.indexOf("{manual && ("), FORM.indexOf('data-testid="receipt-auto-reset"'));
    expect(reset).toContain("setManual(false);");
    expect(reset).toContain("disabled={blocked || busy}");
    expect(FORM).toContain('t("allocReceipt.autoReset")');
  });
  it("🔴 the single-debt pointer SENDS nothing: one receipt send in the whole form, and Confirm still needs completion", () => {
    expect((FORM.match(/recordAllocatedReceipt\(/g) ?? []).length).toBe(1);
    expect(FORM).toContain("disabled={busy || !complete}");
    const single = FORM.slice(FORM.indexOf('data-testid="receipt-single-debt"'), FORM.indexOf('data-testid="receipt-use-single"'));
    expect(single).toContain("onUseSingleDebt({ obligationId: singleDebt, amountText: totalText.trim(), method: provider, reference })");
    expect(single).not.toMatch(/confirmed|recordAllocatedReceipt|recordCustomerPayment/);
  });
  it("🔴 the statement opens the single-debt form WITHOUT the funds confirmation and without sending", () => {
    const fn = STATEMENT.slice(STATEMENT.indexOf("const openFormWithPrefill"), STATEMENT.indexOf("const submit = async"));
    expect(fn).toContain("if (blocked || busy) return;");
    expect(fn).toContain("openForm(obligationId);");
    expect(fn).not.toMatch(/setConfirmed|post\(|recordCustomerPayment|recordAllocatedReceipt/);
    // openForm itself (unchanged) clears the confirmation through resetPaymentDetails
    expect(STATEMENT).toMatch(/const resetPaymentDetails = \(\) => \{[\s\S]*?setConfirmed\(false\);/);
    expect(STATEMENT).toContain("openFormWithPrefill(obligationId, prefill);");
  });
  it("the debts are shown in the order they are proposed, oldest first", () => {
    expect(FORM).toContain("const open = openDebtsOf(statement, currency);");
    expect(FORM).toContain("const debts: StatementObligationDto[] = open.map(");
  });
});

describe("the wording", () => {
  const KEYS = [
    "allocReceipt.autoNote",
    "allocReceipt.manualNote",
    "allocReceipt.autoReset",
    "allocReceipt.overOutstanding",
    "allocReceipt.shareOverDebt",
    "allocReceipt.singleDebt",
    "allocReceipt.useSingle",
  ];
  it("every new key exists in BOTH languages and is non-empty", () => {
    for (const k of KEYS) {
      expect(allKeys()).toContain(k);
      expect(translate("ar", k)).not.toBe(k);
      expect(translate("en", k)).not.toBe(k);
    }
  });
  it("🔴 the single-debt sentence is the owner's approved wording, word for word", () => {
    expect(translate("ar", "allocReceipt.singleDebt")).toBe("هذا المبلغ يغطّي ديناً واحداً فقط. استخدم تسديد الدين الواحد لإتمام التحصيل.");
    expect(translate("en", "allocReceipt.singleDebt")).toBe(
      "This amount applies to one debt only. Use single-debt payment to complete the collection.",
    );
  });
  it("the button names the existing per-debt action, and «more than owed» is its own sentence, not a single debt's", () => {
    expect(translate("ar", "allocReceipt.useSingle")).toContain(translate("ar", "collect.action"));
    expect(translate("ar", "allocReceipt.overOutstanding")).not.toBe(translate("ar", "collect.tooMuch"));
  });
});
