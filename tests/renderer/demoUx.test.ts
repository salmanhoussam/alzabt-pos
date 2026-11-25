/**
 * Joint C2 — the demo's product surface in the renderer, without a DOM (react-dom/server):
 *   K-3   DEMO_RESTRICTED shown in Arabic with the SIGNED wording, through the real
 *         call() → ApiError → errorText chain; English shows main's own (agreed) sentence unchanged.
 *   BR-C-06 (proposed) — the lifecycle adapter: absent channel ⇒ no action; any malformed answer,
 *         error or timeout ⇒ a neutral `failed`; only the three known statuses pass.
 *   The demo shell: a demo process with no session gets the "unavailable" screen, never a login form.
 *   The banner: states the mode, draws actions only when the channel exists; texts claim no
 *         isolation guarantee (rule E) and carry no digits.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate } from "../../src/shared/i18n";
import { I18nProvider } from "../../src/renderer/i18n";
import { ApiError, call, errorText } from "../../src/renderer/api";
import { MAPPED_CODES, arabicRefusal } from "../../src/renderer/refusalText";
import { DEMO_RESTRICTED_TEXT, demoRefusal } from "../../src/renderer/demoRefusal";
import { DEMO_LIFECYCLE_TIMEOUT_MS, demoLifecycleAvailable, demoShellFor, requestDemoLifecycle } from "../../src/renderer/demoControl";
import { DemoBanner, DemoUnavailable } from "../../src/renderer/components/DemoBanner";
import { WelcomeScreen } from "../../src/renderer/screens/WelcomeScreen";

const ROOT = join(__dirname, "..", "..");
const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, null, node));
/** The exact refusal X1's demo policy returns (demoPolicy.ts DEMO_REFUSAL). */
const POLICY_REFUSAL = { ok: false, error: { code: "DEMO_RESTRICTED", message: "This operation is unavailable in demo mode." } } as const;

describe("K-3 — DEMO_RESTRICTED in the operator's language", () => {
  it("uses exactly the signed wording (J0-CODEX-1 §C)", () => {
    expect(DEMO_RESTRICTED_TEXT.ar).toBe("هذه العملية غير متاحة في وضع التجربة.");
    expect(DEMO_RESTRICTED_TEXT.en).toBe("This operation is unavailable in demo mode.");
    expect(POLICY_REFUSAL.error.message).toBe(DEMO_RESTRICTED_TEXT.en);
  });

  it("arrives in Arabic through the real call() → ApiError → errorText chain", async () => {
    let caught: unknown;
    try {
      await call(Promise.resolve(POLICY_REFUSAL));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(errorText(caught, "ar")).toBe("هذه العملية غير متاحة في وضع التجربة.");
  });

  it("English shows main's own sentence, byte for byte", () => {
    expect(errorText(new ApiError("DEMO_RESTRICTED", POLICY_REFUSAL.error.message), "en")).toBe(POLICY_REFUSAL.error.message);
    expect(demoRefusal("en", "DEMO_RESTRICTED")).toBeNull();
  });

  it("answers for DEMO_RESTRICTED only, and leaves refusalText's audited map untouched", () => {
    expect(demoRefusal("ar", "NOT_AVAILABLE")).toBeNull();
    expect(demoRefusal("ar", "toString")).toBeNull();
    expect(MAPPED_CODES).not.toContain("DEMO_RESTRICTED");
    expect(arabicRefusal("ar", "DEMO_RESTRICTED")).toBeNull();
    // Other codes still flow to their own mapping, unchanged.
    expect(errorText(new ApiError("EMPTY_CART", "The cart is empty"), "ar")).toBe("السلّة فارغة.");
  });

  it("claims nothing beyond the refusal (rule E): no isolation promise, no digits, no path", () => {
    for (const s of Object.values(DEMO_RESTRICTED_TEXT)) {
      expect(s).not.toMatch(/[0-9٠-٩\\/]|nothing|لا شيء|isolat|معزول/i);
    }
  });
});

describe("BR-C-06 (proposed) — the demo lifecycle adapter fails closed and quiet", () => {
  it("no channel ⇒ unavailable, and the shell draws no action", async () => {
    expect(demoLifecycleAvailable({})).toBe(false);
    expect(demoLifecycleAvailable(undefined)).toBe(false);
    expect(await requestDemoLifecycle({}, "enter")).toEqual({ status: "unavailable" });
  });

  it("passes only the two V7 success statuses through; a limit-reached STATUS is not a success", async () => {
    const odd = { requestDemoLifecycle: async () => ({ ok: true, data: { status: "limit-reached" } }) };
    expect(await requestDemoLifecycle(odd, "enter")).toEqual({ status: "failed" });
    for (const status of ["restarting", "cancelled"] as const) {
      const api = { requestDemoLifecycle: async () => ({ ok: true, data: { status } }) };
      expect(await requestDemoLifecycle(api, "exit")).toEqual({ status });
    }
  });

  it("sends exactly { action } and nothing else", async () => {
    const seen: unknown[] = [];
    const api = { requestDemoLifecycle: async (r: unknown) => (seen.push(r), { ok: true, data: { status: "cancelled" } }) };
    await requestDemoLifecycle(api, "reset");
    expect(seen).toEqual([{ action: "reset" }]);
  });

  it.each<[string, unknown]>([
    ["an unknown status", { ok: true, data: { status: "deleted" } }],
    ["an extra field (e.g. a path)", { ok: true, data: { status: "restarting", profile: "C:\\x" } }],
    ["a non-object", "restarting"],
    ["a refusal with a raw message", { ok: false, error: { code: "INTERNAL", message: "C:\\secret pin=1" } }],
  ])("%s ⇒ a neutral failed", async (_n, answer) => {
    const api = { requestDemoLifecycle: async () => answer };
    expect(await requestDemoLifecycle(api, "enter")).toEqual({ status: "failed" });
  });

  it("a retention-limit refusal is reported as limit-reached", async () => {
    const api = { requestDemoLifecycle: async () => ({ ok: false, error: { code: "DEMO_RETENTION_LIMIT", message: "x" } }) };
    expect(await requestDemoLifecycle(api, "enter")).toEqual({ status: "limit-reached" });
  });

  it("a throw or a rejection ⇒ failed; a hang ⇒ an informational no-answer, never a decision", async () => {
    expect(await requestDemoLifecycle({ requestDemoLifecycle: () => { throw new Error("C:\\secret"); } }, "exit")).toEqual({ status: "failed" });
    expect(await requestDemoLifecycle({ requestDemoLifecycle: () => Promise.reject(new Error("x")) }, "exit")).toEqual({ status: "failed" });
    const started = Date.now();
    expect(await requestDemoLifecycle({ requestDemoLifecycle: () => new Promise(() => undefined) }, "exit", 40)).toEqual({ status: "no-answer" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("V7 §5: the renderer waits longer than Main's 60 s bound, and signals 'slow' without deciding", async () => {
    expect(DEMO_LIFECYCLE_TIMEOUT_MS).toBeGreaterThan(60_000);
    let slow = 0;
    const out = await requestDemoLifecycle({ requestDemoLifecycle: () => new Promise(() => undefined) }, "exit", 60, () => slow++, 10);
    expect(slow).toBe(1);
    expect(out).toEqual({ status: "no-answer" });
    let late = 0;
    await requestDemoLifecycle({ requestDemoLifecycle: async () => ({ ok: true, data: { status: "cancelled" } }) }, "exit", 60, () => late++, 30);
    await new Promise((r) => setTimeout(r, 50));
    expect(late).toBe(0); // the slow timer is cleared once Main answers
  });
});

describe("the demo shell", () => {
  it("a real process is never a demo shell; a demo without a session is NOT given a login form", () => {
    expect(demoShellFor("real", false)).toBe("not-demo");
    expect(demoShellFor("real", true)).toBe("not-demo");
    expect(demoShellFor("demo", true)).toBe("demo-session");
    expect(demoShellFor("demo", false)).toBe("demo-no-session");
  });

  it("the unavailable screen offers no PIN field and no account list", () => {
    const html = render(createElement(DemoUnavailable));
    expect(html).toContain('data-testid="demo-unavailable"');
    expect(html).not.toMatch(/<input|login-cashier|data-testid="pin/);
    expect(html).toContain(translate("ar", "demo.unavailableTitle"));
  });
});

describe("the demo banner", () => {
  const base = { pending: null, outcome: null, onAction: () => undefined } as const;

  it("states the mode and the preview-only rule; draws NO action without the channel", () => {
    const html = render(createElement(DemoBanner, { ...base, canControl: false }));
    expect(html).toContain('data-testid="demo-mode-banner"');
    expect(html).toContain(translate("ar", "demo.banner"));
    expect(html).toContain(translate("ar", "demo.previewOnly"));
    expect(html).not.toContain('data-testid="demo-reset"');
    expect(html).not.toContain('data-testid="demo-exit"');
  });

  it("draws «ابدأ من جديد» and «الخروج» only when main exposes the lifecycle channel", () => {
    const html = render(createElement(DemoBanner, { ...base, canControl: true }));
    expect(html).toContain('data-testid="demo-reset"');
    expect(html).toContain('data-testid="demo-exit"');
  });

  it("shows a neutral sentence for a failed request and the limit sentence at the limit", () => {
    expect(render(createElement(DemoBanner, { ...base, canControl: true, outcome: { status: "failed" } }))).toContain(translate("ar", "demo.actionFailed"));
    expect(render(createElement(DemoBanner, { ...base, canControl: true, outcome: { status: "limit-reached" } }))).toContain(translate("ar", "demo.limitReached"));
  });

  it("the Welcome demo choice shows pending, failure and limit states", () => {
    const props = { onCreateAccount: () => undefined, onLogin: () => undefined, onDemo: () => undefined };
    expect(render(createElement(WelcomeScreen, { ...props, demoPending: true }))).toContain('data-testid="welcome-demo-pending"');
    expect(render(createElement(WelcomeScreen, { ...props, demoOutcome: { status: "failed" } }))).toContain('data-testid="welcome-demo-failed"');
    expect(render(createElement(WelcomeScreen, { ...props, demoOutcome: { status: "limit-reached" } }))).toContain('data-testid="welcome-demo-limit"');
  });

  it("no demo text claims an isolation guarantee or carries digits, in either language", () => {
    const keys = ["demo.banner", "demo.previewOnly", "demo.reset", "demo.exit", "demo.pending", "demo.actionFailed", "demo.limitReached", "demo.unavailableTitle", "demo.unavailableBody"];
    for (const lang of ["ar", "en"] as const) {
      for (const key of keys) {
        const text = translate(lang, key);
        expect(text, `${lang}:${key}`).not.toBe(key);
        expect(text).not.toMatch(/[0-9٠-٩]/);
        expect(text).not.toMatch(/nothing (is|here|leaves)|لا شيء|لا يُحفظ|isolated|معزول|safe|آمن/i);
      }
    }
  });
});

describe("O-5 / F-2 — the demo offers no PDF save, split or void (structure, parsed from the source)", () => {
  // There is no DOM harness in this repository to mount LedgerReceipt / InvoiceSheet (they load through
  // IPC in effects), so this pins the STRUCTURE: each PDF button is rendered only under `!demo`, where
  // `demo` comes from useDemoMode(). The rendered behaviour is part of the prepared demo journey
  // (e2e/demo-onboarding.mjs), which needs J1 to run.
  const guarded = (file: string, testId: string): boolean => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let ok = false;
    const visit = (n: ts.Node) => {
      if (ts.isJsxAttribute(n) && n.name.getText(sf) === "data-testid" && n.initializer && n.initializer.getText(sf) === `"${testId}"`) {
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && /(^|&&\s*)!demo$/.test(p.left.getText(sf).trim())) ok = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const usesHook = /const demo = useDemoMode\(\);/.test(sf.getFullText());
    return ok && usesHook;
  };
  it("the till receipt's «PDF» button is drawn only outside the demo", () => {
    expect(guarded(join(ROOT, "src", "renderer", "screens", "LedgerReceipt.tsx"), "receipt-pdf")).toBe(true);
  });
  it("the invoice sheet's «حفظ PDF» button is drawn only outside the demo", () => {
    expect(guarded(join(ROOT, "src", "renderer", "screens", "invoices", "InvoiceSheet.tsx"), "save-pdf")).toBe(true);
  });
  it("split payment and voiding are not offered in the demo (both refused by policy)", () => {
    expect(guarded(join(ROOT, "src", "renderer", "screens", "SellScreen.tsx"), "pay-split")).toBe(true);
    expect(guarded(join(ROOT, "src", "renderer", "screens", "HistoryScreen.tsx"), "history-void")).toBe(true);
  });
  it("the print buttons stay (in the demo main turns them into a watermarked preview)", () => {
    expect(guarded(join(ROOT, "src", "renderer", "screens", "LedgerReceipt.tsx"), "receipt-print-80")).toBe(false);
    expect(guarded(join(ROOT, "src", "renderer", "screens", "invoices", "InvoiceSheet.tsx"), "print")).toBe(false);
  });
});
