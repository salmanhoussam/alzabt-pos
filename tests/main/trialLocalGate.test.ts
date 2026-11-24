import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireLocalTrial, validateLocalTrial, type LocalTrialFacts } from "../../src/main/trialLocalGate";

const os = vi.hoisted(() => ({ execFileSync: vi.fn(), hostname: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: os.execFileSync }));
vi.mock("node:os", () => ({ hostname: os.hostname }));

const facts = (): LocalTrialFacts => ({
  platform: "win32", packaged: true, appName: "Alzabt POS TRIAL TEST ONLY",
  home: "C:\\Users\\alzabt-test", appData: "C:\\Users\\alzabt-test\\AppData\\Roaming",
  localAppData: "C:\\Users\\alzabt-test\\AppData\\Local",
  executablePath: "C:\\Users\\alzabt-test\\AppData\\Local\\Programs\\alzabt-pos-trial\\Alzabt POS TRIAL TEST ONLY.exe",
  computerName: "POS-PC", whoamiUser: '"POS-PC\\alzabt-test","S-1-5-21-111-222-333-1001"',
  whoamiGroups: '"Everyone","Well-known group","S-1-1-0","Enabled"\n"Local account","Well-known group","S-1-5-113","Enabled"\n"Users","Alias","S-1-5-32-545","Enabled"\n"Medium","Label","S-1-16-8192","Enabled"',
});

describe("Windows token adapter", () => {
  beforeEach(() => { vi.clearAllMocks(); os.hostname.mockReturnValue("POS-PC"); });
  it("queries the system whoami executable and validates the resulting token", () => {
    os.execFileSync.mockReturnValueOnce(facts().whoamiUser).mockReturnValueOnce(facts().whoamiGroups);
    requireLocalTrial({ ...facts(), windowsDir: "C:\\Windows" });
    expect(os.execFileSync).toHaveBeenNthCalledWith(1, "C:\\Windows\\System32\\whoami.exe",
      ["/user", "/fo", "csv", "/nh"], expect.objectContaining({ windowsHide: true, timeout: 5000 }));
    expect(os.execFileSync).toHaveBeenNthCalledWith(2, "C:\\Windows\\System32\\whoami.exe",
      ["/groups", "/fo", "csv", "/nh"], expect.any(Object));
  });
  it("fails closed when token inspection fails", () => {
    os.execFileSync.mockImplementation(() => { throw new Error("identity unavailable"); });
    expect(() => requireLocalTrial({ ...facts(), windowsDir: "C:\\Windows" })).toThrow("identity unavailable");
  });
  it("does not execute a command with an invalid system root", () => {
    expect(() => requireLocalTrial({ ...facts(), windowsDir: "" })).toThrow();
    expect(os.execFileSync).not.toHaveBeenCalled();
  });
});

describe("local installed trial gate", () => {
  it("accepts the fixed trial identity for the local standard-user token", () => {
    expect(() => validateLocalTrial(facts())).not.toThrow();
  });
  it.each([
    { platform: "linux" }, { packaged: false }, { appName: "Alzabt POS" },
    { whoamiUser: '"POS-PC\\salma","S-1-5-21-111-222-333-1001"' },
    { whoamiUser: '"DOMAIN\\alzabt-test","S-1-5-21-111-222-333-1001"' },
    { whoamiUser: '"POS-PC\\alzabt-test","S-1-5-18"' }, { whoamiUser: "" },
    { whoamiGroups: "" },
    { whoamiGroups: facts().whoamiGroups.replace("S-1-5-113", "S-1-5-114") },
    { whoamiGroups: `${facts().whoamiGroups}\n"Administrators","Alias","S-1-5-32-544","Deny only"` },
    { whoamiGroups: `${facts().whoamiGroups}\n"High","Label","S-1-16-12288","Enabled"` },
    { whoamiGroups: facts().whoamiGroups.replace("S-1-16-8192", "S-1-16-4096") },
    { executablePath: "C:\\Program Files\\Alzabt POS\\Alzabt POS.exe" },
    { executablePath: "C:\\Users\\alzabt-test\\AppData\\Local\\Programs\\alzabt-pos-trial\\other.exe" },
    { appData: "C:\\Users\\salma\\AppData\\Roaming" },
    { localAppData: "C:\\Users\\salma\\AppData\\Local" },
    { home: "C:\\" }, { home: "C:\\Users\\trial\\..\\salma" },
    { appData: "\\\\server\\share" }, { localAppData: "" },
  ])("refuses a mismatched identity, token, or path: %j", (change) => {
    expect(() => validateLocalTrial({ ...facts(), ...change })).toThrow();
  });
});
