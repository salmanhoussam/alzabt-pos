
import React, { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { call } from "../../src/renderer/api";
import { DemoBanner, DemoUnavailable } from "../../src/renderer/components/DemoBanner";
import { demoShellFor, requestDemoLifecycle, type DemoAction } from "../../src/renderer/demoControl";
import { readEntryState } from "../../src/renderer/entryState";
import { I18nProvider } from "../../src/renderer/i18n";
function exitClick(node: ReactNode): (() => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void; "data-testid"?: string }>(node)) return undefined;
  if (node.props["data-testid"] === "demo-exit") return node.props.onClick;
  for (const child of Children.toArray(node.props.children)) {
    const found = exitClick(child);
    if (found) return found;
  }
  return undefined;
}
describe("renderer-only failed synthetic demo recovery", () => {

  it("keeps recovery available and suppresses details when Main refuses Exit", async () => {
    const outcome = await requestDemoLifecycle({
      requestDemoLifecycle: async () => ({ ok: false, error: { code: "INTERNAL", message: "private-detail" } }),
    }, "exit");
    expect(outcome).toEqual({ status: "failed" });
    const banner = createElement(DemoBanner, { canControl: true, pending: null, outcome, onAction: () => undefined });
    const view = createElement(React.Fragment, null, banner, createElement(DemoUnavailable, { canExit: true }));
    const html = renderToStaticMarkup(createElement(I18nProvider, null, view));
    expect(html).toContain('data-testid="demo-unavailable"');
    expect(html).toContain('data-testid="demo-exit"');
    expect(html).toContain('data-testid="demo-action-failed"');
    expect(html).not.toContain("private-detail");
  });
  it("renders unavailable without login and lets Exit request the trusted lifecycle", async () => {
    const requests: unknown[] = [];
    const api = {
      getEntryState: async () => ({ ok: true, data: { profile: "demo", terminalClaimed: false, firstRunEligible: false, demoAvailable: false } }),
      currentCashier: async () => ({ ok: true as const, data: null }),
      requestDemoLifecycle: async (request: unknown) => {
        requests.push(request);
        return { ok: true, data: { status: "restarting" } };
      },
    };
    const entry = await readEntryState(api);
    const cashier = await call(api.currentCashier());
    expect(demoShellFor(entry.profile, cashier !== null)).toBe("demo-no-session");
    let click: (() => void) | undefined;
    let pending: Promise<unknown> | undefined;
    const onAction = (action: DemoAction) => { pending = requestDemoLifecycle(api, action); };
    function Harness() {
      const banner = DemoBanner({ canControl: true, pending: null, outcome: null, onAction });
      click = exitClick(banner);
      return createElement(React.Fragment, null, banner, createElement(DemoUnavailable, { canExit: true }));
    }
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(Harness)));
    expect(html).toContain('data-testid="demo-unavailable"');
    expect(html).toContain('data-testid="demo-exit"');
    expect(html).not.toMatch(/<input|login-cashier/);
    expect(click).toBeTypeOf("function");
    click!();
    await expect(pending).resolves.toEqual({ status: "restarting" });
    expect(requests).toEqual([{ action: "exit" }]);
  });
});
