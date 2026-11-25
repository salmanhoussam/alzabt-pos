/**
 * J1-RECEIPT-NAMES — wiring: the on-screen Receipt shows the localized name AND keeps the recorded one,
 * and with no catalogue it shows exactly the recorded names (the behaviour before this change).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const ui = vi.hoisted(() => ({ lang: "ar" as "ar" | "en" }));
vi.mock("../../src/renderer/i18n", () => ({ useT: () => ({ t: (k: string) => k, unit: (u: string) => u, lang: ui.lang }) }));
import { Receipt } from "../../src/renderer/screens/Receipt";
import type { SaleDto } from "../../src/shared/ipcContract";

const money = (minor: string) => ({ minor, currency: "USD" });
const sale = {
  id: "s1", receiptNumber: 1, completedAt: "2026-11-19T20:51:00.000Z", cashierName: "Cashier One",
  sourceType: "pos", paymentStatus: "paid", paymentMethod: "cash", total: money("250"),
  lines: [
    { lineNo: 1, invoiceLineId: null, productId: "p1", sku: null, productName: "Espresso", unitLabel: null, saleUnit: "piece", quantityMilli: 1000, unitPrice: money("250"), lineTotal: money("250") },
  ],
} as unknown as SaleDto;
const names = new Map([["p1", { name: "Espresso", nameAr: "إسبريسو", nameEn: "Espresso" }]]);
const render = (withNames: boolean) =>
  renderToStaticMarkup(createElement(Receipt, withNames ? { sale, productNames: names } : { sale }));

it("Arabic UI: the line shows «إسبريسو» and still shows the recorded «Espresso»", () => {
  ui.lang = "ar";
  const html = render(true);
  expect(html).toMatch(/data-testid="receipt-line-name"[^>]*>إسبريسو</);
  expect(html).toMatch(/data-testid="receipt-line-recorded"[^>]*>Espresso</);
});

it("English UI: the English name, no duplicate recorded line", () => {
  ui.lang = "en";
  const html = render(true);
  expect(html).toMatch(/data-testid="receipt-line-name"[^>]*>Espresso</);
  expect(html).not.toContain('data-testid="receipt-line-recorded"');
});

it("no catalogue (read failed): exactly the recorded name, as before", () => {
  ui.lang = "ar";
  const html = render(false);
  expect(html).toMatch(/data-testid="receipt-line-name"[^>]*>Espresso</);
  expect(html).not.toContain('data-testid="receipt-line-recorded"');
});
