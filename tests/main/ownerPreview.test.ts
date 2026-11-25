/**
 * OWNER-ONLY R5 PREVIEW (owner decision 2026-11-25): the build flavor and the preview entry's allowlist.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../src/shared/ipcContract";
import { PREVIEW_ENTRY_ALLOWED, PREVIEW_REFUSAL, invokeWithPreviewPolicy } from "../../src/main/previewPolicy";
import { DEMO_CHANNEL_POLICY } from "../../src/main/demoPolicy";

const electron = vi.hoisted(() => ({ isPackaged: false, appPath: "" }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
    getAppPath: () => electron.appPath,
  },
}));

async function flavorModule(packaged: boolean, pkg: Record<string, unknown> | null) {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "alzabt-flavor-"));
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  electron.isPackaged = packaged;
  electron.appPath = dir;
  const mod = await import("../../src/main/syntheticBuild");
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("syntheticBuild — where the Demo path may run", () => {
  afterEach(() => {
    electron.isPackaged = false;
  });

  it("unpackaged development build: allowed (unchanged behaviour), and it is not the preview", async () => {
    const { mod, cleanup } = await flavorModule(false, null);
    expect(mod.syntheticBuildAllowed()).toBe(true);
    expect(mod.isOwnerPreviewBuild()).toBe(false);
    cleanup();
  });

  it("🔴 packaged STANDARD build (no flavor): never", async () => {
    const { mod, cleanup } = await flavorModule(true, { name: "alzabt-pos" });
    expect(mod.syntheticBuildAllowed()).toBe(false);
    expect(mod.isOwnerPreviewBuild()).toBe(false);
    cleanup();
  });

  it("🔴 packaged build with any OTHER flavor value, or no readable package.json: never", async () => {
    for (const pkg of [{ alzabtFlavor: "preview" }, { alzabtFlavor: true }, { alzabtFlavor: "OWNER-PREVIEW" }, null]) {
      const { mod, cleanup } = await flavorModule(true, pkg);
      expect(mod.syntheticBuildAllowed()).toBe(false);
      cleanup();
    }
  });

  it("packaged build marked owner-preview: allowed (identity is still gated separately)", async () => {
    const { mod, cleanup } = await flavorModule(true, { alzabtFlavor: "owner-preview" });
    expect(mod.isOwnerPreviewBuild()).toBe(true);
    expect(mod.syntheticBuildAllowed()).toBe(true);
    cleanup();
  });
});

describe("previewPolicy — the preview's non-demo entry is a launcher only", () => {
  const names = Object.keys(CHANNELS);

  it("🔴 the allowlist is EXACTLY these eight, and each one is a real channel", () => {
    expect([...PREVIEW_ENTRY_ALLOWED].sort()).toEqual(
      ["currentCashier", "getAppInfo", "getEntryState", "getSettings", "listCashiers", "login", "logout", "setTerminalLanguage"],
    );
    for (const n of PREVIEW_ENTRY_ALLOWED) expect(names).toContain(n);
  });

  it("🔴 in the preview, every other channel is refused in main — enrollment, setup, restore, import, sales, phone, OCR", () => {
    const refused = names.filter((n) => !PREVIEW_ENTRY_ALLOWED.has(n));
    expect(refused.length).toBeGreaterThan(90);
    for (const n of refused) {
      let called = false;
      expect(invokeWithPreviewPolicy(true, "real", n, () => (called = true))).toBe(PREVIEW_REFUSAL);
      expect(called, n).toBe(false);
    }
    for (const n of ["enrollOwner", "completeBootstrapSetup", "inspectRestoreBackup", "applyRestore", "importCatalog", "createSale", "startPhoneSession", "readInvoicePhoto"]) {
      expect(refused).toContain(n);
    }
  });

  it("allowed channels run; Demo processes and every non-preview build pass straight through", () => {
    expect(invokeWithPreviewPolicy(true, "real", "getSettings", () => "ran")).toBe("ran");
    expect(invokeWithPreviewPolicy(true, "demo", "createSale", () => "ran")).toBe("ran");
    expect(invokeWithPreviewPolicy(false, "real", "applyRestore", () => "ran")).toBe("ran");
  });

  it("the refusal is the NOT_AVAILABLE answer the screens already translate", () => {
    expect(PREVIEW_REFUSAL).toEqual({ ok: false, error: { code: "NOT_AVAILABLE", message: "Not available in the owner preview" } });
  });

  it("Demo may set its own rate (TRANSITION for F8) — and still denies enrollment, restore and phone channels", () => {
    expect(DEMO_CHANNEL_POLICY.setLbpRate).toBe("allow");
    for (const n of ["enrollOwner", "applyRestore", "inspectRestoreBackup", "importCatalog", "startPhoneSession", "readInvoicePhoto"] as const) {
      expect((DEMO_CHANNEL_POLICY as Record<string, string>)[n]).toBe("deny");
    }
  });
});
