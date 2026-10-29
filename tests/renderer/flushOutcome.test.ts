/** Which failed row-writes drop their batch key, and how the sheet uses the durable key. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/renderer/api";
import { translate } from "../../src/shared/i18n";
import { classifyFlushFailure } from "../../src/renderer/screens/invoices/flushOutcome";

const SHEET = readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("classifying a failed flush", () => {
  it("an ordinary service refusal rolled back — the batch key may be dropped", () => {
    expect(classifyFlushFailure(new ApiError("INVALID_INPUT", "x"))).toBe("refused");
    expect(classifyFlushFailure(new ApiError("INVOICE_NOT_DRAFT", "x"))).toBe("refused");
  });
  it("INTERNAL, a damaged record, a key conflict and a lost IPC keep the batch", () => {
    for (const code of ["INTERNAL", "LEDGER_INTEGRITY", "IDEMPOTENCY_CONFLICT"]) {
      expect(classifyFlushFailure(new ApiError(code, "x"))).toBe("uncertain");
    }
    expect(classifyFlushFailure(new Error("ipc"))).toBe("uncertain");
  });
});

describe("the sheet's wiring (SOURCE-LEVEL assertions — there is no component test)", () => {
  it("🔴 sends every batch through the store under its key and never consults line counts", () => {
    expect(SHEET).toContain("rowStore.flush(");
    expect(SHEET).toContain("idempotencyKey: key");
    expect(SHEET).toContain("newKey: newIdempotencyKey");
    expect(SHEET).not.toContain("reconcileFlush");
  });
  it("🔴 rows are written only through the store, and every draft-row control honours the freeze", () => {
    expect(SHEET.match(/setDraftRows\(/g) ?? []).toHaveLength(1); // the mirror inside onChange
    const body = SHEET.slice(SHEET.indexOf("draftRows.map"), SHEET.indexOf("</tbody>", SHEET.indexOf("draftRows.map")));
    expect((body.match(/disabled=\{frozenRows\.has\(r\.key\)\}/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(body).toContain("rowStore.edit(r.key");
    expect(SHEET).toContain('t("inv.sheet.rowSaving")'); // the picker refuses a frozen row aloud
  });
  it("🔴 post-await checks read the store, not an old render's draftRows", () => {
    const afterAwait = SHEET.slice(SHEET.indexOf("const saveDraft"), SHEET.indexOf("const addRow"));
    expect(afterAwait).not.toMatch(/draftRows\.some/);
  });
  it("🔴 Finalize stores rows, then tax, then header, THEN opens the confirmation", () => {
    const body = SHEET.slice(SHEET.indexOf("const prepareFinalize"));
    const order = ["await flushRows()", "await flushTax()", "await flushHeader()", "setConfirming(true)"].map((s) =>
      body.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("🔴 an unblurred tax rate counts as unsaved and is stored by Save and by Save-and-leave", () => {
    expect(SHEET).toMatch(/const isDirty[\s\S]{0,200}if \(taxDirty\(\)\) return true;/);
    const save = SHEET.slice(SHEET.indexOf("const saveDraft"), SHEET.indexOf("const addRow"));
    expect((save.match(/await flushTax\(\)/g) ?? []).length).toBeGreaterThanOrEqual(1);
    const leave = SHEET.slice(SHEET.indexOf("const saveAndLeave"), SHEET.indexOf("const prepareFinalize"));
    expect(leave).toContain("await flushTax()");
  });
});

describe("a later step failing after rows were stored", () => {
  it("🔴 says the rows were saved — and only when a flush actually wrote them", () => {
    expect(SHEET).toContain('t("inv.sheet.partialSaved")');
    expect(SHEET).toContain("if (!rowStore.rowsWritten) throw e;");
  });
});

describe("operator wording", () => {
  it("🔴 flushUnknown never promises 'never twice' and tells the operator to inspect saved rows after a restart", () => {
    for (const lang of ["ar", "en"] as const) {
      const text = translate(lang, "inv.sheet.flushUnknown");
      expect(text).not.toMatch(/never|لن يُحفظ/i);
    }
    expect(translate("en", "inv.sheet.flushUnknown")).toMatch(/reopen the draft[\s\S]*review the saved lines/i);
    expect(translate("ar", "inv.sheet.flushUnknown")).toContain("افتح المسوّدة");
  });
});
