/**
 * The authorization policy itself: exhaustive, fail-closed, and justified where it is permissive.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE POLICY GETS ITS OWN TESTS. The refusals are tested elsewhere by actually calling
 * channels. These tests are about the TABLE: that no channel is unclassified, that nothing drifted
 * into `public` without a stated reason, and that the owner-only set still contains the things a
 * cashier must never reach. A permission that quietly widens is not a visible bug — it is a
 * silently larger blast radius — so it is asserted by name here.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../src/shared/ipcContract";
import { CHANNEL_POLICY, PUBLIC_REASON, accessFor } from "../../src/main/channelPolicy";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { makeHarness, tempDir } from "../helpers/harness";

const names = Object.keys(CHANNELS) as Array<keyof typeof CHANNELS>;

describe("every channel is classified", () => {
  it("🔴 covers EVERY channel in CHANNELS — a missing one would be unauthorized by accident", () => {
    const unclassified = names.filter((n) => !(n in CHANNEL_POLICY));
    expect(unclassified).toEqual([]);
    // And nothing classified that is not a channel, which would be a rename nobody finished.
    const orphans = Object.keys(CHANNEL_POLICY).filter((n) => !(names as string[]).includes(n));
    expect(orphans).toEqual([]);
  });

  it("🔴 FAILS CLOSED for a channel it does not know", () => {
    // The compile-time Record<ChannelName, Access> is the real guard; this is the backstop for the
    // case where types were bypassed. It must THROW, never return a permissive default.
    expect(() => accessFor("pos:somethingNobodyClassified")).toThrow(/no authorization classification/);
    expect(() => accessFor("")).toThrow(/no authorization classification/);
  });

  it("uses only the three known access levels", () => {
    const levels = new Set(Object.values(CHANNEL_POLICY));
    expect([...levels].sort()).toEqual(["owner", "public", "session"]);
  });
});

describe("the public set", () => {
  const publicChannels = names.filter((n) => CHANNEL_POLICY[n] === "public").sort();

  it("🔴 is EXACTLY these seven, each with a stated reason", () => {
    // Salman asked for three — listCashiers, login, completeBootstrapSetup. Three is not
    // achievable: the renderer also calls getSettings (the app reads its language before it can
    // render anything, the login screen included), setTerminalLanguage (the PRE-AUTH language
    // toggle shipped in UI unification v1), currentCashier (App.tsx asking at startup whether
    // anyone is signed in) and logout. Each is named individually, so this stays a list of
    // justified exceptions rather than a category future channels can drift into.
    expect(publicChannels).toEqual([
      "completeBootstrapSetup",
      "currentCashier",
      "getSettings",
      "listCashiers",
      "login",
      "logout",
      "setTerminalLanguage",
    ]);
  });

  it("every public channel carries a reason, and no reason exists for a non-public one", () => {
    for (const channel of publicChannels) {
      expect(PUBLIC_REASON[channel], `${channel} is public with no stated reason`).toBeTruthy();
    }
    const stale = Object.keys(PUBLIC_REASON).filter((c) => CHANNEL_POLICY[c as keyof typeof CHANNELS] !== "public");
    expect(stale).toEqual([]);
  });

  it("🔴 no channel that writes or reveals business data is public", () => {
    // The public set must stay things that cannot change money, master data or the shop's identity.
    const forbidden = [
      "createSale",
      "voidSale",
      "createProduct",
      "updateProduct",
      "setProductActive",
      "importCatalog",
      "exportCatalog",
      "exportBackup",
      "getCompanyProfile",
      "saveCompanyProfile",
      "getSaleHistory",
      "getTodaySales",
      "listOperators",
      "createOperator",
      "resetOperatorPin",
      "finalizeInvoice",
    ] as const;
    expect(forbidden.filter((c) => CHANNEL_POLICY[c] === "public")).toEqual([]);
  });
});

describe("the owner-only set", () => {
  it("🔴 contains every action Salman restricted, by name", () => {
    const ownerOnly = [
      // Reversing money.
      "voidSale",
      // Master data.
      "createProduct",
      "updateProduct",
      "setProductActive",
      "importCatalog",
      "exportCatalog",
      // Every sale the shop ever made.
      "exportBackup",
      // The shop's legal identity and its numbering.
      "getCompanyProfile",
      "saveCompanyProfile",
      "setNextInvoiceNumber",
      "pickInvoiceLogo",
      // Reconciliation, including the read — closed as owner-only in v1.
      "listReconciliation",
      "listReconciliationQueue",
      "resolveKeepCatalog",
      "resolveKeepInvoiceOnly",
      "resolveLinkProduct",
      "resolveCreateProduct",
      "resolveUpdateCatalog",
      // Operator management.
      "listOperators",
      "createOperator",
      "renameOperator",
      "resetOperatorPin",
      "setOperatorActive",
      "setOperatorRole",
    ] as const;
    const wrong = ownerOnly.filter((c) => CHANNEL_POLICY[c] !== "owner");
    expect(wrong).toEqual([]);
  });

  it("the cashier's daily work is NOT owner-only", () => {
    // A permission model that stops the shop selling is not a security win.
    const cashierWork = [
      "getCatalog",
      "createSale",
      "getTodaySales",
      "getSaleHistory",
      "listProducts",
      // Daily invoicing, which a finalized invoice makes a real sale (migration 7).
      "createInvoiceDraft",
      "addInvoiceLines",
      "finalizeInvoice",
      "printInvoice",
      "saveInvoicePdf",
    ] as const;
    expect(cashierWork.filter((c) => CHANNEL_POLICY[c] === "owner")).toEqual([]);
    expect(cashierWork.filter((c) => CHANNEL_POLICY[c] === "public")).toEqual([]);
  });
});

/**
 * 🔴 THE REFUSALS, THROUGH THE REAL HANDLERS. The table above is a claim; this is the behaviour.
 * A cashier session calls each owner-only channel directly — the way `page.evaluate` on
 * `window.pos` does in the installed app — and every one must be refused by the main process with
 * nothing written.
 */
describe("a CASHIER session is refused every owner-only channel", () => {
  const owners = (Object.keys(CHANNEL_POLICY) as Array<keyof typeof CHANNELS>).filter(
    (c) => CHANNEL_POLICY[c] === "owner",
  );

  it("refuses all of them with NOT_AUTHORIZED, and none with a different code", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const ipc = syncHandlers(createIpcHandlers(h.service));
      // Cashier Two is a real cashier in this database.
      const login = ipc.login({ cashierId: "cashier-02", pin: "2222" }) as { ok: boolean };
      expect(login.ok).toBe(true);

      const outcomes = owners.map((channel) => {
        // The payload does not matter: authorization runs BEFORE any payload is examined, which is
        // itself the point — a restricted channel must not even tell you whether your payload was
        // well formed.
        const r = ipc[channel](undefined) as { ok: boolean; error?: { code: string } };
        return { channel, ok: r.ok, code: r.error?.code };
      });

      const notRefused = outcomes.filter((o) => o.ok);
      expect(notRefused, "an owner-only channel answered a cashier").toEqual([]);
      const wrongCode = outcomes.filter((o) => o.code !== "NOT_AUTHORIZED");
      expect(wrongCode, "refused for the wrong reason").toEqual([]);
      // Sanity: the list is not accidentally empty, which would make this test vacuous.
      expect(outcomes.length).toBeGreaterThanOrEqual(20);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("🔴 writes NOTHING — the ledger and the catalog are untouched by the attempts", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const ipc = syncHandlers(createIpcHandlers(h.service));
      ipc.login({ cashierId: "cashier-02", pin: "2222" });
      const before = {
        products: h.db.prepare("SELECT count(*) AS n FROM catalog_products").get(),
        operators: h.db.prepare("SELECT count(*) AS n FROM operators").get(),
        audit: h.db.prepare("SELECT count(*) AS n FROM audit_events").get(),
      };
      ipc.createProduct({ nameAr: "x", nameEn: null, sku: null, price: "1.00", baseUnit: "piece" });
      ipc.createOperator({ name: "intruder", role: "owner", pin: "1234" });
      ipc.setOperatorActive({ operatorId: "cashier-01", isActive: false });
      expect({
        products: h.db.prepare("SELECT count(*) AS n FROM catalog_products").get(),
        operators: h.db.prepare("SELECT count(*) AS n FROM operators").get(),
        audit: h.db.prepare("SELECT count(*) AS n FROM audit_events").get(),
      }).toEqual(before);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("a cashier CAN do the cashier's job — this is not a locked terminal", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const ipc = syncHandlers(createIpcHandlers(h.service));
      ipc.login({ cashierId: "cashier-02", pin: "2222" });
      for (const channel of ["getCatalog", "getTodaySales", "listProducts", "getAppInfo"] as const) {
        expect((ipc[channel](undefined) as { ok: boolean }).ok, channel).toBe(true);
      }
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("🔴 with NO session, a session-level channel is refused too", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const ipc = syncHandlers(createIpcHandlers(h.service));
      const r = ipc.createSale(undefined) as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("NOT_LOGGED_IN");
    } finally {
      h.db.close();
      t.cleanup();
    }
  });
});
