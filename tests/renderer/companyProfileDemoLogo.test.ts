/**
 * J1-DEMO-LOGO — the Demo company form never shows the internal logo file name; the real shop still
 * shows which logo is set. Same static-render harness as companyProfileDemo.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const mode = vi.hoisted(() => ({ demo: false }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useState: (initial: unknown) => [initial === true ? false : initial, () => {}] };
});
vi.mock("../../src/renderer/demoMode", () => ({ useDemoMode: () => mode.demo }));
vi.mock("../../src/renderer/i18n", () => ({ useT: () => ({ t: (key: string) => key }) }));
import { CompanyProfileForm } from "../../src/renderer/screens/invoices/CompanyProfileForm";

it("Demo: the fixed-logo sentence, and no logo file name", () => {
  mode.demo = true;
  const html = renderToStaticMarkup(createElement(CompanyProfileForm, {}));
  expect(html).toContain('data-testid="company-logo-fixed"');
  expect(html).not.toContain('data-testid="company-logo-name"');
});

it("real shop: the logo name line is still shown", () => {
  mode.demo = false;
  const html = renderToStaticMarkup(createElement(CompanyProfileForm, {}));
  expect(html).toContain('data-testid="company-logo-name"');
  expect(html).not.toContain('data-testid="company-logo-fixed"');
});
