import { describe, expect, it } from "vitest";
import { planDedicatedTrialAccount, type TrialAccountFacts } from "../../src/main/trialAccountPolicy";

const facts = (): TrialAccountFacts => ({
  platform: "win32", packaged: true, appName: "Alzabt POS TRIAL TEST ONLY",
  executablePath: "C:\\Users\\trial\\AppData\\Local\\Programs\\Alzabt-POS-NSIS-TEST-ONLY\\Alzabt POS TRIAL TEST ONLY.exe",
  tokenAccount: "alzabt-test", tokenDomain: "SYNTHETIC-PC", computerName: "SYNTHETIC-PC",
  tokenSid: "S-1-5-21-11-22-33-1001", resolvedLocalAccountSid: "S-1-5-21-11-22-33-1001",
  tokenElevated: false, administratorMember: false,
  shellRoamingAppData: "C:\\Users\\trial\\AppData\\Roaming",
  shellLocalAppData: "C:\\Users\\trial\\AppData\\Local",
});

describe("dedicated trial account policy, with synthetic facts only", () => {
  it("plans distinct fixed trial locations for the local standard-user identity", () => {
    expect(planDedicatedTrialAccount(facts())).toEqual({
      installDir: "C:\\Users\\trial\\AppData\\Local\\Programs\\Alzabt-POS-NSIS-TEST-ONLY",
      profileDir: "C:\\Users\\trial\\AppData\\Roaming\\Alzabt POS TRIAL Test Data",
    });
  });

  it.each([
    { tokenAccount: "salma" }, { tokenDomain: "OTHER-DOMAIN" },
    { tokenSid: "S-1-5-21-11-22-33-1002" }, { tokenSid: "S-1-5-18" },
    { tokenElevated: true }, { administratorMember: true },
    { packaged: false }, { platform: "linux" }, { appName: "Alzabt POS" },
    { executablePath: "C:\\Program Files\\Alzabt POS\\Alzabt POS.exe" },
    { shellRoamingAppData: "C:\\" }, { shellLocalAppData: "\\\\server\\share" },
    { shellLocalAppData: "C:\\Users\\trial\\..\\Local" },
    { shellLocalAppData: "C:\\Users\\trial\\Local:alternate" },
    { shellRoamingAppData: "C:\\Users\\trial\\Roam*" },
    { shellRoamingAppData: "C:\\Users\\trial\\AppData\\Local" },
    { shellRoamingAppData: "C:\\Users\\trial\\AppData" },
    { tokenElevated: undefined as unknown as boolean },
    { administratorMember: undefined as unknown as boolean },
  ])("refuses an identity or location mismatch: %j", (change) => {
    expect(() => planDedicatedTrialAccount({ ...facts(), ...change })).toThrow();
  });
});
