/**
 * Joint C2 — the demo's PREVIEW-ONLY document mark, on the REAL documents (O-5).
 *
 * The documents are produced by the product's own renderers from synthetic data:
 *   - the till receipt (renderSaleReceiptDocument) in BOTH layouts, thermal80 and a5, from real sales
 *     made through the real service on a newly created synthetic ledger;
 *   - the A4 invoice (renderInvoiceDocument) from the repository's own synthetic invoice samples,
 *     including "D-multipage" (45 lines, more than one A4 page).
 * Then `withDemoWatermark` is applied, and what is asserted is what can be asserted without a browser:
 * the bar and the mark are present exactly once, the mark is `position: fixed` (Chromium keeps it in
 * view at every scroll position and repeats it on every printed page), every document line survives,
 * the logo survives, nothing executable is added, and the mark is idempotent. Pixel layout and real
 * scrolling are checked by the kept Electron script e2e/demo-preview-render.mjs.
 *
 * Set DEMO_PREVIEW_OUT=<folder> to also write the watermarked HTML for that script.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SaleReceiptService } from "../../src/application/saleReceiptService";
import { MAX_HISTORY } from "../../src/application/posService";
import { DEMO_BAR_TEXT, DEMO_MARK_ATTR, DEMO_MARK_TEXT, previewSizeFor, withDemoWatermark } from "../../src/main/demoPrint";
import { renderInvoiceDocument } from "../../src/main/invoiceDocument";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { renderSaleReceiptDocument } from "../../src/main/saleReceiptDocument";
import { SaleReceiptRepository } from "../../src/persistence/saleReceiptRepository";
import type { IpcResult, SaleReceiptDto } from "../../src/shared/ipcContract";
import { SAMPLES } from "../../scripts/invoiceSampleFixtures";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

const ROOT = join(__dirname, "..", "..");
const LOGO_DATA_URL = `data:image/png;base64,${readFileSync(join(ROOT, "resources", "demo", "demo-logo.png")).toString("base64")}`;
const OUT = process.env.DEMO_PREVIEW_OUT;

const count = (html: string, needle: string) => html.split(needle).length - 1;
const lineRows = (html: string) => {
  const table = /<table class="lines" dir="ltr">([\s\S]*?)<\/table>/.exec(html);
  if (!table) throw new Error("no line-item table");
  return (/<tbody>([\s\S]*?)<\/tbody>/.exec(table[1]!)?.[1]?.match(/<tr>/g) ?? []).length;
};
const markStyle = (html: string) => new RegExp(`${DEMO_MARK_ATTR}="mark"[^>]*style="([^"]*)"`).exec(html)?.[1] ?? "";

function assertMarked(original: string, marked: string) {
  expect(count(marked, `${DEMO_MARK_ATTR}="mark"`)).toBe(1);
  expect(count(marked, `${DEMO_MARK_ATTR}="bar"`)).toBe(1);
  expect(marked).toContain(DEMO_BAR_TEXT);
  expect(marked).toContain(DEMO_MARK_TEXT);
  expect(markStyle(marked)).toMatch(/position:fixed/);
  expect(markStyle(marked)).toMatch(/pointer-events:none/);
  // The mark sits inside <body>, before </body>; the bar right after <body…>.
  expect(marked.indexOf(`${DEMO_MARK_ATTR}="mark"`)).toBeLessThan(marked.toLowerCase().lastIndexOf("</body>"));
  // Nothing executable or external is added; the document's own CSP meta is untouched.
  expect(count(marked, "<script")).toBe(count(original, "<script"));
  expect(marked).not.toMatch(/\son[a-z]+=/i);
  const csp = /<meta[^>]+Content-Security-Policy[^>]*>/i.exec(original)?.[0];
  if (csp) expect(marked).toContain(csp);
  // Every byte of the original body survives (only additions).
  const stripped = marked
    .replace(new RegExp(`<div ${DEMO_MARK_ATTR}="bar"[^>]*>[\\s\\S]*?</div>`), "")
    .replace(new RegExp(`<div ${DEMO_MARK_ATTR}="mark"[^>]*>[\\s\\S]*?</div>`), "");
  expect(stripped).toBe(original);
  // Idempotent: a re-staged preview never stacks two marks.
  expect(withDemoWatermark(marked)).toBe(marked);
}

function writeOut(name: string, html: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), html, "utf8");
}

describe("previewSizeFor — the on-screen preview matches the paper", () => {
  it("80 mm roll is narrow, A5 is medium, A4 (and anything unknown) is the widest", () => {
    expect(previewSizeFor("thermal80")).toEqual({ width: 420, height: 860 });
    expect(previewSizeFor("a5")).toEqual({ width: 640, height: 860 });
    expect(previewSizeFor("a4")).toEqual({ width: 860, height: 1000 });
    expect(previewSizeFor("something-else")).toEqual({ width: 860, height: 1000 });
  });
});

describe("A4 invoice — every synthetic sample, including the multi-page one", () => {
  it.each(SAMPLES.map((s) => [s.name, s] as const))("%s keeps every line and its logo, and carries the mark once", (name, sample) => {
    const original = renderInvoiceDocument(sample.v, { logoUrl: LOGO_DATA_URL });
    const marked = withDemoWatermark(original);
    assertMarked(original, marked);
    expect(lineRows(marked)).toBe(lineRows(original));
    expect(lineRows(original)).toBe(sample.v.lines.length);
    expect(marked).toContain('class="logo"');
    writeOut(`invoice-a4-${name}.html`, marked);
  });

  it("the multi-page sample really is long enough to span pages (45 lines)", () => {
    const d = SAMPLES.find((s) => s.name === "D-multipage")!;
    expect(d.v.lines.length).toBeGreaterThanOrEqual(40);
  });
});

describe("till receipt — thermal80 and a5, from real sales on a synthetic ledger", () => {
  let t: TempDir;
  let h: Harness;
  let ipc: ReturnType<typeof syncHandlers>;
  beforeEach(() => {
    t = tempDir();
    h = makeHarness(t.dbPath);
    const adv = makeAdvances(h);
    const receipts = new SaleReceiptService({
      reads: new SaleReceiptRepository(h.db),
      getSale: (id) => h.service.getSale(id),
      role: () => h.service.currentRole(),
      historyWindow: MAX_HISTORY,
      formatAdvanceNo: (n: number) => `ADV-${n}`,
    });
    ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger, advances: adv, saleReceipts: receipts }));
  });
  afterEach(() => {
    if (h.db.open) h.db.close();
    t.cleanup();
  });
  const ok = <T>(r: IpcResult<unknown>): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.data as T;
  };

  it.each(["thermal80", "a5"] as const)("%s receipt keeps every line and carries the mark once", (layout) => {
    const lines = ["prod-0001", "prod-0002", "prod-0003", "prod-0004", "prod-0005", "prod-0006", "prod-0007", "prod-0008"].map((productId) => ({
      productId,
      quantityMilli: 1000,
    }));
    const catalog = ok<{ products: Array<{ id: string; price: { minor: string } }> }>(ipc.getCatalog(undefined));
    const total = lines.reduce((sum, l) => sum + BigInt(catalog.products.find((p) => p.id === l.productId)!.price.minor), 0n);
    const sale = h.service.createSale({ idempotencyKey: newKey(), lines, expectedTotalMinor: total, paymentMethod: "cash" }).sale;
    const receipt = ok<SaleReceiptDto>(ipc.getSaleReceipt({ saleId: sale.id }));
    const original = renderSaleReceiptDocument({ receipt, layout, copy: false, shopName: "متجر عالضبط التجريبي", timeZone: "Asia/Beirut" });
    const marked = withDemoWatermark(original);
    assertMarked(original, marked);
    expect(receipt.sale.lines.length).toBe(8);
    // Every sale line is in the marked document's line table.
    const table = /<table class="lines">([\s\S]*?)<\/table>/.exec(marked)?.[1] ?? "";
    expect((table.match(/<tr/g) ?? []).length).toBeGreaterThanOrEqual(8);
    writeOut(`receipt-${layout}.html`, marked);
  });
});

describe("withDemoWatermark on its own", () => {
  it("a document without <body> still gets both, appended", () => {
    const marked = withDemoWatermark("<p>x</p>");
    expect(count(marked, `${DEMO_MARK_ATTR}="mark"`)).toBe(1);
    expect(count(marked, `${DEMO_MARK_ATTR}="bar"`)).toBe(1);
  });
  it("the demo texts carry no digits, paths or markup injection", () => {
    for (const s of [DEMO_BAR_TEXT, DEMO_MARK_TEXT]) {
      expect(s).not.toMatch(/[0-9<>"]/);
    }
  });
});
