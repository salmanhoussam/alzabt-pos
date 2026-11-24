/**
 * Pure policy candidate for a later dedicated-account trial. This module does
 * not obtain Windows identity, validate filesystem objects, or authorize app
 * startup. A reviewed native identity adapter and path checks are still needed.
 */
import { win32 } from "node:path";
import { TRIAL_APP_NAME } from "./trialIsolation";

export interface TrialAccountFacts {
  platform: string;
  packaged: boolean;
  appName: string;
  executablePath: string;
  tokenAccount: string;
  tokenDomain: string;
  computerName: string;
  tokenSid: string;
  resolvedLocalAccountSid: string;
  tokenElevated: boolean;
  /** Must include unfiltered/linked-token or local account group membership;
   * CheckTokenMembership on a filtered token alone is insufficient. */
  administratorMember: boolean;
  shellRoamingAppData: string;
  shellLocalAppData: string;
}

const LOCAL_ACCOUNT = "alzabt-test";
const INSTALL_DIR = "Alzabt-POS-NSIS-TEST-ONLY";
const PROFILE_DIR = "Alzabt POS TRIAL Test Data";

function fixedLocalPath(value: string): string {
  // Reject UNC, device paths, drive-relative paths and dot segments. Native
  // checks for reparse points, aliases and file identity remain mandatory.
  if (!/^[a-z]:\\/i.test(value) || value.startsWith("\\\\") ||
      value.slice(3).split(/[\\/]+/).some((part) => part === "." || part === ".." ||
        /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part))) {
    throw new Error("Trial requires an ordinary absolute local Shell path");
  }
  const resolved = win32.resolve(value);
  if (resolved.toLowerCase() === win32.parse(resolved).root.toLowerCase()) throw new Error("Trial rejects a volume root");
  return resolved;
}

function samePath(a: string, b: string): boolean {
  return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
}

export function planDedicatedTrialAccount(facts: TrialAccountFacts): { installDir: string; profileDir: string } {
  if (facts.platform !== "win32" || facts.packaged !== true || facts.appName !== TRIAL_APP_NAME) {
    throw new Error("Trial requires the packaged Windows trial identity");
  }
  if (facts.tokenAccount.toLowerCase() !== LOCAL_ACCOUNT || !facts.computerName ||
      facts.tokenDomain.toLowerCase() !== facts.computerName.toLowerCase() ||
      !/^S-1-5-21-\d+-\d+-\d+-\d+$/i.test(facts.tokenSid) ||
      facts.tokenSid.toUpperCase() !== facts.resolvedLocalAccountSid.toUpperCase() ||
      facts.tokenElevated !== false || facts.administratorMember !== false) {
    throw new Error("Trial requires the dedicated local standard-user token");
  }
  const roaming = fixedLocalPath(facts.shellRoamingAppData);
  const local = fixedLocalPath(facts.shellLocalAppData);
  const relative = win32.relative(roaming, local);
  const reverse = win32.relative(local, roaming);
  if (samePath(roaming, local) || (!relative.startsWith("..\\") && !win32.isAbsolute(relative)) ||
      (!reverse.startsWith("..\\") && !win32.isAbsolute(reverse))) {
    throw new Error("Trial Shell data roots must be separate");
  }
  const installDir = win32.join(local, "Programs", INSTALL_DIR);
  const profileDir = win32.join(roaming, PROFILE_DIR);
  if (!samePath(fixedLocalPath(facts.executablePath), win32.join(installDir, `${TRIAL_APP_NAME}.exe`))) {
    throw new Error("Trial executable is not in the fixed trial installation directory");
  }
  return { installDir, profileDir };
}
