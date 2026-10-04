import { describe, expect, it } from "vitest";
import {
  AUTO_START_ENTRY_NAME,
  type LoginItemApi,
  type MarkerStore,
  applyAutoStart,
  planAutoStart,
} from "../../src/main/autoStart";

const packagedWindows = { platform: "win32", isPackaged: true, disabledByEnv: false, alreadyConfigured: false };

describe("auto-start decision", () => {
  it("registers only for a packaged Windows build that has not been configured yet", () => {
    expect(planAutoStart(packagedWindows)).toEqual({ action: "register" });
    expect(planAutoStart({ ...packagedWindows, platform: "linux" })).toEqual({ action: "skip", reason: "not-windows" });
    expect(planAutoStart({ ...packagedWindows, platform: "darwin" })).toEqual({ action: "skip", reason: "not-windows" });
    expect(planAutoStart({ ...packagedWindows, isPackaged: false })).toEqual({
      action: "skip",
      reason: "development-build",
    });
    expect(planAutoStart({ ...packagedWindows, disabledByEnv: true })).toEqual({
      action: "skip",
      reason: "disabled-by-env",
    });
    expect(planAutoStart({ ...packagedWindows, alreadyConfigured: true })).toEqual({
      action: "skip",
      reason: "already-configured",
    });
  });
});

function fakes(opts: { failRegistration?: boolean; failWrite?: boolean } = {}) {
  const calls: Array<Parameters<LoginItemApi["setLoginItemSettings"]>[0]> = [];
  const files = new Map<string, string>();
  const app: LoginItemApi = {
    setLoginItemSettings: (s) => {
      if (opts.failRegistration) throw new Error("registry unavailable");
      calls.push(s);
    },
  };
  const store: MarkerStore = {
    exists: (p) => files.has(p),
    write: (p, c) => {
      if (opts.failWrite) throw new Error("disk full");
      files.set(p, c);
    },
  };
  return { app, store, calls, files };
}

const base = {
  markerPath: "C:\\Users\\m\\AppData\\Roaming\\Alzabt POS\\autostart.json",
  executablePath: "C:\\Users\\m\\AppData\\Local\\Programs\\alzabt-pos\\Alzabt POS.exe",
  platform: "win32",
  isPackaged: true,
  env: {},
  now: () => new Date("2026-10-04T09:00:00.000Z"),
};

describe("auto-start application", () => {
  it("first packaged launch registers one named entry for the installed executable and records it", () => {
    const f = fakes();
    expect(applyAutoStart({ ...base, app: f.app, store: f.store })).toEqual({ status: "registered" });
    expect(f.calls).toEqual([{ openAtLogin: true, name: AUTO_START_ENTRY_NAME, path: base.executablePath }]);
    expect(JSON.parse(f.files.get(base.markerPath)!)).toEqual({
      entry: "AlzabtPOS",
      configuredAt: "2026-10-04T09:00:00.000Z",
    });
  });

  it("later launches do not re-register (a merchant who switched it off stays off; no duplicates)", () => {
    const f = fakes();
    applyAutoStart({ ...base, app: f.app, store: f.store });
    for (let i = 0; i < 3; i++) {
      expect(applyAutoStart({ ...base, app: f.app, store: f.store })).toEqual({
        status: "skipped",
        reason: "already-configured",
      });
    }
    expect(f.calls).toHaveLength(1);
  });

  it("a development run never touches the startup list", () => {
    const f = fakes();
    expect(applyAutoStart({ ...base, isPackaged: false, app: f.app, store: f.store })).toEqual({
      status: "skipped",
      reason: "development-build",
    });
    expect(f.calls).toHaveLength(0);
    expect(f.files.size).toBe(0);
  });

  it("ALZABT_POS_DISABLE_AUTOSTART=1 opts out", () => {
    const f = fakes();
    expect(
      applyAutoStart({ ...base, env: { ALZABT_POS_DISABLE_AUTOSTART: "1" }, app: f.app, store: f.store }),
    ).toEqual({ status: "skipped", reason: "disabled-by-env" });
    expect(f.calls).toHaveLength(0);
  });

  it("a registration failure is reported, never thrown, and is retried on the next launch", () => {
    const failing = fakes({ failRegistration: true });
    expect(applyAutoStart({ ...base, app: failing.app, store: failing.store })).toEqual({
      status: "failed",
      error: "registry unavailable",
    });
    expect(failing.files.size).toBe(0); // no marker, so the next launch tries again
  });

  it("a marker-write failure is reported, never thrown", () => {
    const f = fakes({ failWrite: true });
    expect(applyAutoStart({ ...base, app: f.app, store: f.store })).toEqual({ status: "failed", error: "disk full" });
  });
});
