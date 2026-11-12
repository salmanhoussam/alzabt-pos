/**
 * OCR-REVIEW-UX (2026-11-12) — the owner's eight Photo Invoice findings, pinned at the source.
 *
 * `vitest.config.mts` runs in node (no DOM), so layout is proven by the E2E screenshots and measured rects; these
 * tests pin the PROPERTIES that produced each defect, so none can come back silently between gates:
 *   1 narrow window · 2 double scrolling · 3 photo + inputs side by side · 4 mixed Arabic/English/digits ·
 *   5 suggestions hidden in a dropdown · 6 engine text on the confirmation · 7 one mixed-language refusal ·
 *   8 practical entry (handwritten: photo-only mode, Enter = next row).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/renderer/api";
import { readFailureText } from "../../src/renderer/screens/PhotoInvoiceFlow";

const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const FLOW = code(readFileSync("src/renderer/screens/PhotoInvoiceFlow.tsx", "utf8"));
const REVIEW = code(readFileSync("src/renderer/screens/PhotoInvoiceReview.tsx", "utf8"));
const CSS = readFileSync("src/renderer/styles.css", "utf8");
const rule = (sel: string): string => {
  const i = CSS.indexOf(`${sel} {`);
  expect(i, `CSS rule ${sel}`).toBeGreaterThan(-1);
  return CSS.slice(i, CSS.indexOf("}", i));
};

describe("Photo Invoice UX — layout (findings 1–3)", () => {
  it("the window is desktop-wide and full height, and does not scroll itself", () => {
    const r = rule(".overlay > .panel.photo-flow");
    // within the overlay's own 16px padding — 98vw + padding made the OVERLAY scroll (seen on the screenshot)
    expect(r).toMatch(/width: min\(1680px, calc\(100vw - 32px\)\)/);
    expect(r).toMatch(/height: calc\(100vh - 32px\)/);
    expect(r).toMatch(/overflow: hidden/);
  });
  it("ONE scroller in the review: the row list; the review is no longer a nested .panel", () => {
    expect(rule(".pir-rows")).toMatch(/overflow-y: auto/);
    expect(REVIEW).not.toMatch(/className="panel/);
    expect(REVIEW).not.toMatch(/overflow: "auto"/);
    expect(FLOW).not.toMatch(/overflow: "auto"/);
    expect(rule(".pir-photo-view.fit")).toMatch(/overflow: hidden/); // the photo scrolls only when zoomed in
  });
  it("photo beside the rows (two columns), stacked only on a narrow window", () => {
    expect(rule(".photo-review")).toMatch(/grid-template-columns: minmax\(320px, 40%\) 1fr/);
    expect(CSS).toMatch(/@media \(max-width: 900px\)[\s\S]*\.photo-review \{ grid-template-columns: 1fr;/);
  });
  it("warnings and issues have a visible style (the old `warn` class had none)", () => {
    expect(rule(".pir-note.warn")).toMatch(/background: var\(--status-warning\)/);
    expect(rule(".pir-note.bad")).toMatch(/background: var\(--status-danger\)/);
  });
});

describe("Photo Invoice UX — text (findings 4, 6, 7)", () => {
  it("names and engine text are isolated runs; numbers are left-to-right; no block container takes dir=auto", () => {
    expect(REVIEW).toMatch(/<input dir="auto" value=\{r\.name\}/);
    expect(REVIEW).toMatch(/<bdi dir="auto" data-testid="photo-review-raw">/);
    for (const t of ["photo-review-qty", "photo-review-cost", "photo-review-total", "photo-review-sale-price"]) {
      const at = REVIEW.indexOf(`data-testid="${t}"`);
      const tag = REVIEW.slice(REVIEW.lastIndexOf("<input", at), at); // that field's OWN tag, not a neighbour's
      expect(tag, t).toMatch(/dir="ltr"/);
    }
    expect(REVIEW + FLOW).not.toMatch(/<(div|p|section|article|td|li)\b[^>]*dir="auto"/);
    // a number CELL keeps the table's direction (so it sits under its header); only its digits run LTR
    expect(FLOW).not.toMatch(/<td[^>]*dir="ltr"/);
  });
  it("the confirmation shows a clean table — no engine text, no raw row", () => {
    const confirm = FLOW.slice(FLOW.indexOf('data-testid="photo-flow-confirm"'), FLOW.indexOf('data-testid="photo-flow-done"'));
    expect(confirm).toMatch(/<table className="pf-table" data-testid="photo-flow-confirm-new">/);
    expect(confirm).not.toMatch(/rawText|crop|warnings/);
  });
  it("every refusal is Arabic AND English, as two separate lines — never one mixed sentence", () => {
    for (const c of ["OCR_FAILED", "INVALID_INPUT", "NOT_AVAILABLE"]) {
      const t = readFailureText(new ApiError(c, "x"));
      expect(t.ar).toMatch(/[؀-ۿ]/);
      // no English sentence inside the Arabic line — the file-format names JPG / PNG are the only Latin allowed
      expect(t.ar.replace(/\b(JPG|PNG)\b/g, "")).not.toMatch(/[A-Za-z]{3,}/);
      expect(t.en).toMatch(/^[\x20-\x7E]+$/);
    }
    expect(readFailureText(new ApiError("INVALID_INPUT", "x")).ar).toContain("ليس صورة");
    // DEC-35zzzz: the GENERIC fallback used to put errorText() under the Arabic line and leave English EMPTY.
    const secret = "Error: boom at C:\\Users\\x\\main.js:12 — شركة النور مورّد 4471";
    for (const e of [new ApiError("INTERNAL", secret), new ApiError("SOMETHING_NEW", secret), new Error(secret), "not an error", new ApiError("bad code!", secret)]) {
      const g = readFailureText(e);
      expect(g.ar).toMatch(/[\u0600-\u06FF]/);
      expect(g.en.length).toBeGreaterThan(20);
      expect(g.en).toMatch(/^[\x20-\x7E]+$/);
      expect(g.ar + g.en).not.toContain("boom");
      expect(g.ar + g.en).not.toContain("main.js");
      expect(g.ar + g.en).not.toContain("النور");
      expect(g.ar).toMatch(/رمز الخطأ: [A-Z_]+\)/);
      expect(g.en).toMatch(/error code: [A-Z_]+\)/);
    }
    expect(readFailureText(new ApiError("INTERNAL", "x")).en).toContain("error code: INTERNAL");
    expect(readFailureText(new Error("x")).en).toContain("error code: UNEXPECTED");
    expect(readFailureText(new ApiError("bad code!", "x")).en).toContain("error code: UNEXPECTED"); // a code is shown only if it looks like one
    // a permission refusal is not a "could not be processed"
    expect(readFailureText(new ApiError("NOT_AUTHORIZED", "x"))).toEqual({ ar: "هذا الحساب لا يملك صلاحية إضافة الأصناف من صورة فاتورة.", en: "This account may not add products from an invoice photo." });

    expect(FLOW).toMatch(/<p dir="rtl" lang="ar">/);
    expect(FLOW).toMatch(/<p dir="ltr" lang="en">/);
  });
});

describe("Photo Invoice UX — decisions and practical entry (findings 5, 8)", () => {
  it("suggestions are visible buttons with their match share, and only a CLICK links", () => {
    expect(REVIEW).toMatch(/data-testid="photo-review-suggest"/);
    expect(REVIEW).toMatch(/Math\.round\(s \* 100\)/);
    expect(REVIEW).not.toMatch(/optgroup label="مقترح/);
  });
  it("skip / new are one-click buttons; the select keeps every option the E2E drives", () => {
    expect(REVIEW).toMatch(/data-testid="photo-review-skip"/);
    expect(REVIEW).toMatch(/data-testid="photo-review-new"/);
    for (const v of ["pending", "skip", "new"]) expect(REVIEW).toContain(`<option value="${v}">`);
  });
  it("a new product's sale price is never prefilled from the supplier price", () => {
    expect(REVIEW).toMatch(/value=\{saleText\[id\] \?\? ""\}/);
    expect(REVIEW).not.toMatch(/saleText[^;\n]*supplierPrice/);
  });
  it("handwritten: a photo-only start, one empty row with the cursor in it, Enter opens the next row", () => {
    expect(FLOW).toMatch(/data-testid="photo-flow-handwritten"/);
    expect(FLOW).toMatch(/readInvoicePhoto\(mode === "read" \? undefined : \{ mode \}\)/);
    expect(REVIEW).toMatch(/mode === "photo-only" && extracted\.length === 0 \? \[manualRow\(\)\]/);
    expect(REVIEW).toMatch(/if \(at === rows\.length - 1\) addManual\(null, ""\)/);
  });
});
