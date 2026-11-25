/**
 * Joint C1 — the first-run Welcome screen and the entry-state hint (contract J0-CODEX-1 §A, BR-C-01).
 *
 * P5 (as corrected in J0-CODEX-1): the entry state is a UX ROUTING HINT that fails closed to the
 *    plain login — on no channel, an error, a malformed / contradictory / over-rich answer.
 * P6: the Welcome screen renders the three choices in Arabic and English, draws the demo choice only
 *    when supplied, and its texts claim no isolation guarantee and reveal no code.
 * Rendered with react-dom/server (no DOM), like tests/renderer/lineMath.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate } from "../../src/shared/i18n";
import { I18nProvider } from "../../src/renderer/i18n";
import { WelcomeScreen } from "../../src/renderer/screens/WelcomeScreen";
import { NewShopScreen } from "../../src/renderer/screens/NewShopScreen";
import {
  ENTRY_STATE_TIMEOUT_MS,
  EntryStateLoader,
  INITIAL_ENTRY_UI,
  LEGACY_ENTRY,
  type EntryState,
  type EntryUiEvent,
  entryUiReducer,
  offersDemo,
  parseEntryState,
  preLoginScreen,
  readEntryState,
  showsNewShop,
} from "../../src/renderer/entryState";

const FRESH: EntryState = { profile: "real", terminalClaimed: false, firstRunEligible: true, demoAvailable: false };
const noop = () => undefined;

describe("P5 — preLoginScreen: the Welcome screen only where main says first-run eligible", () => {
  it.each<[string, EntryState, "welcome" | "login" | null, "welcome" | "login"]>([
    ["legacy default (no channel / failure)", LEGACY_ENTRY, null, "login"],
    ["real, unclaimed, eligible, no choice yet", FRESH, null, "welcome"],
    ["real, unclaimed, eligible, chose sign-in", FRESH, "login", "login"],
    ["real, unclaimed, NOT eligible (e.g. upgraded with data)", { ...FRESH, firstRunEligible: false }, null, "login"],
    ["real, claimed", { ...FRESH, terminalClaimed: true, firstRunEligible: false }, null, "login"],
    ["demo process never shows Welcome", { ...FRESH, profile: "demo" }, null, "login"],
  ])("%s → %s", (_name, entry, chosen, expected) => {
    expect(preLoginScreen(entry, chosen)).toBe(expected);
  });

  it("offers the demo only for a real process whose entry says available", () => {
    expect(offersDemo(LEGACY_ENTRY)).toBe(false);
    expect(offersDemo({ ...FRESH, demoAvailable: true })).toBe(true);
    expect(offersDemo({ ...FRESH, profile: "demo", demoAvailable: true })).toBe(false);
  });
});

describe("P5 — parseEntryState fails closed", () => {
  it("accepts the signed shape exactly", () => {
    expect(parseEntryState(FRESH)).toEqual(FRESH);
    expect(parseEntryState({ ...FRESH, demoAvailable: true, demoRetention: { retained: 2, max: 5, reached: false } })).toEqual({
      ...FRESH,
      demoAvailable: true,
      demoRetention: { retained: 2, max: 5, reached: false },
    });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an array", []],
    ["an extra key (e.g. a PIN)", { ...FRESH, pin: "123456" }],
    ["an extra key (e.g. a path)", { ...FRESH, profilePath: "C:\\x" }],
    ["a missing key", { profile: "real", terminalClaimed: false, firstRunEligible: true }],
    ["an unknown profile", { ...FRESH, profile: "admin" }],
    ["a string boolean", { ...FRESH, firstRunEligible: "true" }],
    ["claimed AND eligible (contradiction)", { ...FRESH, terminalClaimed: true, firstRunEligible: true }],
    ["retention max other than 5", { ...FRESH, demoRetention: { retained: 1, max: 6, reached: false } }],
    ["retention 'reached' inconsistent with counts", { ...FRESH, demoRetention: { retained: 5, max: 5, reached: false } }],
    ["negative retention", { ...FRESH, demoRetention: { retained: -1, max: 5, reached: false } }],
  ])("%s → LEGACY_ENTRY", (_name, raw) => {
    expect(parseEntryState(raw)).toBe(LEGACY_ENTRY);
  });

  it("never offers the demo at the retention limit, whatever the flag says", () => {
    const at = parseEntryState({ ...FRESH, demoAvailable: true, demoRetention: { retained: 5, max: 5, reached: true } });
    expect(at.demoAvailable).toBe(false);
  });
});

describe("P5 — readEntryState: no channel, a refusal or a throw all mean the plain login", () => {
  it("answers LEGACY_ENTRY when the channel is not bound (this C1 build: X1 binds it)", async () => {
    expect(await readEntryState({})).toBe(LEGACY_ENTRY);
    expect(await readEntryState(undefined)).toBe(LEGACY_ENTRY);
  });
  it("answers LEGACY_ENTRY on ok:false, on a throw and on a malformed payload", async () => {
    expect(await readEntryState({ getEntryState: async () => ({ ok: false, error: { code: "X", message: "x" } }) })).toBe(LEGACY_ENTRY);
    expect(await readEntryState({ getEntryState: async () => Promise.reject(new Error("boom")) })).toBe(LEGACY_ENTRY);
    expect(await readEntryState({ getEntryState: () => { throw new Error("sync boom"); } })).toBe(LEGACY_ENTRY);
    expect(await readEntryState({ getEntryState: async () => ({ ok: true, data: { ...FRESH, pin: "1" } }) })).toBe(LEGACY_ENTRY);
  });
  it("passes a valid answer through", async () => {
    expect(await readEntryState({ getEntryState: async () => ({ ok: true, data: FRESH }) })).toEqual(FRESH);
  });
});

const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, null, node));

describe("P6 — the Welcome screen", () => {
  it("draws «إنشاء حساب» and «تسجيل الدخول» in Arabic (the default), and no demo choice when none is supplied", () => {
    const html = render(createElement(WelcomeScreen, { onCreateAccount: noop, onLogin: noop }));
    expect(html).toContain('data-testid="welcome-create"');
    expect(html).toContain('data-testid="welcome-login"');
    expect(html).not.toContain('data-testid="welcome-demo"');
    expect(html).toContain(translate("ar", "welcome.create"));
    expect(html).toContain(translate("ar", "welcome.login"));
  });

  it("draws «جرّب النظام» only when the app supplies a demo action", () => {
    const html = render(createElement(WelcomeScreen, { onCreateAccount: noop, onLogin: noop, onDemo: noop }));
    expect(html).toContain('data-testid="welcome-demo"');
    expect(html).toContain(translate("ar", "welcome.demo"));
  });

  // TRANSITION (O-1 Phase 1, owner R9, 2026-11-25): was «the Create-Account note explains the existing setup path
  // without revealing any code» — that note pointed to the published setup code, which P1 no longer accepts. The
  // destination is now the «محل جديد» form; the «reveals no code» property is kept, asserted on the new screen.
  it("«محل جديد» renders its own Arabic form (name, PIN, confirm) and reveals no code", () => {
    const html = render(createElement(NewShopScreen, { onReady: noop, onBack: noop }));
    expect(html).toContain('data-testid="new-shop-screen"');
    for (const key of ["newShop.title", "newShop.why", "newShop.name", "newShop.pin", "newShop.confirm", "newShop.submit"])
      expect(html).toContain(translate("ar", key));
    expect(html).not.toMatch(/1111|2222/);
    for (const lang of ["ar", "en"] as const)
      for (const key of ["newShop.title", "newShop.why", "newShop.notNew", "newShop.unavailable"]) {
        expect(translate(lang, key), `${lang}:${key}`).not.toBe(key);
        expect(translate(lang, key)).not.toMatch(/[0-9٠-٩]/);
      }
  });

  it("no welcome text claims an isolation guarantee (rule E) or contains digits a code could hide in", () => {
    const keys = ["welcome.title", "welcome.subtitle", "welcome.create", "welcome.createHint", "welcome.login",
      "welcome.loginHint", "welcome.demo", "welcome.demoHint", "welcome.local", "welcome.back"];
    for (const lang of ["ar", "en"] as const) {
      for (const key of keys) {
        const text = translate(lang, key);
        expect(text, `${lang}:${key} translated`).not.toBe(key);
        expect(text).not.toMatch(/[0-9٠-٩]/);
        expect(text).not.toMatch(/nothing (is|here|leaves)|لا شيء|لا يُحفظ|isolated|معزول/i);
      }
    }
  });
});

describe("C1-R1 — a hung or late entry-state answer never holds the app on Loading", () => {
  it("has a bounded default well under a user's patience", () => {
    expect(ENTRY_STATE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ENTRY_STATE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  it("a never-settling channel resolves to LEGACY_ENTRY within the bound", async () => {
    const started = Date.now();
    const state = await readEntryState({ getEntryState: () => new Promise(() => undefined) }, 50);
    expect(state).toBe(LEGACY_ENTRY);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("an answer arriving AFTER the bound is ignored: the result stays LEGACY_ENTRY", async () => {
    let deliver: (v: unknown) => void = () => undefined;
    const late = new Promise((r) => (deliver = r));
    const result = readEntryState({ getEntryState: () => late }, 30);
    expect(await result).toBe(LEGACY_ENTRY);
    deliver({ ok: true, data: FRESH }); // too late — the promise above has already settled
    expect(await result).toBe(LEGACY_ENTRY);
  });

  it("an answer inside the bound is used", async () => {
    const quick = { getEntryState: () => new Promise((r) => setTimeout(() => r({ ok: true, data: FRESH }), 5)) };
    expect(await readEntryState(quick, 500)).toEqual(FRESH);
  });

  it("the loader drops a read superseded by a newer load or by invalidate()", async () => {
    const resolvers: Array<(s: EntryState) => void> = [];
    const loader = new EntryStateLoader(() => new Promise<EntryState>((r) => resolvers.push(r)));
    const first = loader.load();
    const second = loader.load();
    resolvers[0]!(FRESH);
    resolvers[1]!(LEGACY_ENTRY);
    expect(await first).toBeNull(); // superseded
    expect(await second).toBe(LEGACY_ENTRY);

    const third = loader.load();
    loader.invalidate();
    resolvers[2]!(FRESH);
    expect(await third).toBeNull(); // invalidated (e.g. setup completed while the start-up read was in flight)
  });
});

describe("C1-R2 — no stale Welcome / Create Account after setup, logout or a change of route", () => {
  const run = (events: EntryUiEvent[]) => events.reduce(entryUiReducer, INITIAL_ENTRY_UI);

  it("starts unanswered (Loading), then routes an eligible terminal to Welcome", () => {
    expect(INITIAL_ENTRY_UI.entry).toBeUndefined();
    const ui = run([{ type: "loaded", entry: FRESH }]);
    expect(preLoginScreen(ui.entry!, ui.preLogin)).toBe("welcome");
  });

  it("«إنشاء حساب» → plain login with the note; «رجوع» → Welcome again", () => {
    const created = run([{ type: "loaded", entry: FRESH }, { type: "choose-create" }]);
    expect(preLoginScreen(created.entry!, created.preLogin)).toBe("login");
    expect(showsNewShop(created)).toBe(true);
    const back = entryUiReducer(created, { type: "back" });
    expect(preLoginScreen(back.entry!, back.preLogin)).toBe("welcome");
    expect(showsNewShop(back)).toBe(false);
  });

  it("after the owner's setup completes, neither Welcome nor the note can come back from the start-up hint", () => {
    const ui = run([{ type: "loaded", entry: FRESH }, { type: "choose-create" }, { type: "setup-complete" }]);
    expect(ui.entry).toBe(LEGACY_ENTRY);
    expect(ui.fromCreate).toBe(false);
    expect(preLoginScreen(ui.entry!, ui.preLogin)).toBe("login");
    expect(showsNewShop(ui)).toBe(false);
  });

  it("setup → logout → the hint is re-read (Loading), and a claimed answer gives the plain login, no note", () => {
    const afterLogout = run([{ type: "loaded", entry: FRESH }, { type: "choose-create" }, { type: "setup-complete" }, { type: "logout" }]);
    expect(afterLogout.entry).toBeUndefined(); // the start-up hint is NOT reused
    expect(afterLogout.fromCreate).toBe(false);
    const reread = entryUiReducer(afterLogout, { type: "loaded", entry: { ...FRESH, terminalClaimed: true, firstRunEligible: false } });
    expect(preLoginScreen(reread.entry!, reread.preLogin)).toBe("login");
    expect(showsNewShop(reread)).toBe(false);
  });

  it("logout clears an earlier route choice, so the next operator is routed only by the fresh hint", () => {
    const ui = run([{ type: "loaded", entry: FRESH }, { type: "choose-login" }, { type: "logout" }, { type: "loaded", entry: LEGACY_ENTRY }]);
    expect(ui.preLogin).toBeNull();
    expect(preLoginScreen(ui.entry!, ui.preLogin)).toBe("login");
  });
});
