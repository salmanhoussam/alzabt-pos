/**
 * J1-COMPLETED-FIT (owner Windows run, 2026-11-20) — wiring only. The geometry itself (card held to
 * the screen, lines scrolling, total / print / «new sale» visible) is measured in the real app by
 * e2e/completed-sale-layout.mjs; a static render cannot see layout.
 *
 * Here: the completed-sale screen (Receipt WITH «new sale») is in fit mode and wraps its lines in the
 * scrolling region; the History reprint (no «new sale») is NOT in fit mode; and the total, the lines
 * and «new sale» are all still rendered — nothing moved out of the card.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("../../src/renderer/i18n", () => ({ useT: () => ({ t: (k: string) => k, unit: (u: string) => u, lang: "ar" }) }));
import { Receipt } from "../../src/renderer/screens/Receipt";
import type { SaleDto } from "../../src/shared/ipcContract";

const money = (minor: string) => ({ minor, currency: "USD" });
const line = (n: number) => ({
  lineNo: n, invoiceLineId: null, productId: `p${n}`, sku: null, productName: `Item ${n}`, unitLabel: null,
  saleUnit: "piece", quantityMilli: 1000, unitPrice: money("100"), lineTotal: money("100"),
});
const sale = {
  id: "s1", receiptNumber: 1, completedAt: "2026-11-20T00:00:00.000Z", cashierName: "Cashier One",
  sourceType: "pos", paymentStatus: "paid", paymentMethod: "cash", total: money("800"),
  lines: Array.from({ length: 8 }, (_, i) => line(i + 1)),
} as unknown as SaleDto;

it("completed sale (has «new sale»): fit mode, the 8 lines inside the scrolling region, total and «new sale» kept", () => {
  const html = renderToStaticMarkup(createElement(Receipt, { sale, onNewSale: () => undefined }));
  expect(html).toContain('class="center receipt-fit"');
  expect(html).toContain('data-fit="1"');
  const region = html.slice(html.indexOf('data-testid="receipt-lines"'), html.indexOf("</table>"));
  expect(region.match(/<tr>/g)?.length).toBe(8 + 1); // 8 lines + the total row
  expect(region).toContain("receipt-total");
  expect(html).toContain('data-testid="new-sale"');
});

it("History reprint (no «new sale»): ordinary flow, not fit mode", () => {
  const html = renderToStaticMarkup(createElement(Receipt, { sale }));
  expect(html).toContain('class="center"');
  expect(html).not.toContain("receipt-fit");
  expect(html).toContain('data-fit="0"');
  expect(html).not.toContain('data-testid="new-sale"');
});

// J1-PHASE5 U-3: the History reprint opts in explicitly; an explicit value always wins over the «new sale» default.
it("explicit fit (History reprint, no «new sale»): fit mode, lines in the scrolling region, no «new sale»", () => {
  const html = renderToStaticMarkup(createElement(Receipt, { sale, fit: true }));
  expect(html).toContain('class="center receipt-fit"');
  expect(html).toContain('data-fit="1"');
  expect(html).toContain('data-testid="receipt-lines"');
  expect(html).not.toContain('data-testid="new-sale"');
});

it("explicit fit=false wins even with «new sale»", () => {
  const html = renderToStaticMarkup(createElement(Receipt, { sale, onNewSale: () => undefined, fit: false }));
  expect(html).toContain('data-fit="0"');
  expect(html).toContain('data-testid="new-sale"');
});
