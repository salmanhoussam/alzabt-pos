import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ app: {
  isPackaged: false, getPath: vi.fn(), setPath: vi.fn(), getName: vi.fn(),
  setName: vi.fn(), setAppUserModelId: vi.fn(), exit: vi.fn(),
}, requireLocalTrial: vi.fn() }));
vi.mock("electron", () => fake);
vi.mock("../../src/main/trialLocalGate", () => ({ requireLocalTrial: fake.requireLocalTrial }));

describe("synthetic runner bootstrap with a mocked Electron app", () => {
  let root: string;
  const keys = ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "ALZABT_SYNTHETIC_RUNNER_ONLY", "RUNNER_TEMP",
    "ALZABT_POS_USER_DATA", "ALZABT_POS_DIAG_LOG", "ELECTRON_LOG_FILE", "ELECTRON_ENABLE_LOGGING", "CHROME_LOG_FILE"] as const;
  let oldEnv: Record<string, string | undefined>;
  let oldExe: string;
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    oldExe = process.execPath;
    fake.app.isPackaged = false;
    for (const key of keys) delete process.env[key];
    root = mkdtempSync(join(tmpdir(), "alzabt-bootstrap-"));
    const appData = join(root, "alzabt-trial-appdata");
    mkdirSync(appData);
    Object.assign(process.env, { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
      ALZABT_SYNTHETIC_RUNNER_ONLY: "1", RUNNER_TEMP: root });
    const paths: Record<string, string> = { appData };
    fake.app.getPath.mockImplementation((name: string) => paths[name]);
    fake.app.setPath.mockImplementation((name: string, value: string) => { paths[name] = value; });
    fake.app.getName.mockReturnValue("trial");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.execPath = oldExe;
    for (const key of keys) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
    rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks();
  });
  it("selects the separated synthetic profile on the designated runner", async () => {
    await import("../../src/main/trialBootstrap");
    expect(fake.app.setPath).toHaveBeenCalledWith("userData", join(root, "alzabt-trial-appdata", "Alzabt POS TRIAL Test Data"));
    expect(fake.app.exit).not.toHaveBeenCalled();
  });
  it.each(["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "ALZABT_SYNTHETIC_RUNNER_ONLY", "RUNNER_TEMP"])("refuses a missing %s", async (key) => {
    delete process.env[key];
    await expect(import("../../src/main/trialBootstrap")).rejects.toThrow(/disposable synthetic runner/);
    expect(fake.app.exit).toHaveBeenCalledWith(1);
    expect(fake.app.setPath).not.toHaveBeenCalled();
  });
  it("refuses a different app-data root", async () => {
    fake.app.getPath.mockReturnValue(root);
    await expect(import("../../src/main/trialBootstrap")).rejects.toThrow(/disposable synthetic runner/);
    expect(fake.app.setPath).not.toHaveBeenCalled();
  });
  it("refuses a diagnostic override", async () => {
    process.env.ELECTRON_LOG_FILE = join(root, "sentinel.log");
    await expect(import("../../src/main/trialBootstrap")).rejects.toThrow(/overrides/);
    expect(fake.app.setPath).not.toHaveBeenCalled();
  });
  it("routes a local launch through the account gate before selecting the profile", async () => {
    for (const key of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "ALZABT_SYNTHETIC_RUNNER_ONLY", "RUNNER_TEMP"]) delete process.env[key];
    fake.app.isPackaged = true;
    fake.app.getName.mockReturnValue("Alzabt POS TRIAL TEST ONLY");
    process.execPath = join(root, "Alzabt POS TRIAL TEST ONLY.exe");
    await import("../../src/main/trialBootstrap");
    expect(fake.requireLocalTrial).toHaveBeenCalledWith(expect.objectContaining({ packaged: true,
      appName: "Alzabt POS TRIAL TEST ONLY", executablePath: process.execPath, appData: join(root, "alzabt-trial-appdata") }));
    expect(fake.app.setPath).toHaveBeenCalledWith("userData", join(root, "alzabt-trial-appdata", "Alzabt POS TRIAL Test Data"));
  });
  it("refuses startup without selecting a profile when the local gate fails", async () => {
    for (const key of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "ALZABT_SYNTHETIC_RUNNER_ONLY", "RUNNER_TEMP"]) delete process.env[key];
    fake.requireLocalTrial.mockImplementationOnce(() => { throw new Error("bad account"); });
    await expect(import("../../src/main/trialBootstrap")).rejects.toThrow("bad account");
    expect(fake.app.exit).toHaveBeenCalledWith(1);
    expect(fake.app.setPath).not.toHaveBeenCalled();
  });
});
