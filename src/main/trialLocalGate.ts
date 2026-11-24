import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { win32 } from "node:path";
import { TRIAL_APP_NAME } from "./trialIsolation";

/** This gate prevents accidental use of the local trial in the wrong account or
 * location. It is not a defense against a malicious process in the same account. */
export interface LocalTrialFacts {
  platform: string;
  packaged: boolean;
  appName: string;
  executablePath: string;
  home: string;
  appData: string;
  localAppData: string;
  computerName: string;
  whoamiUser: string;
  whoamiGroups: string;
}

function ordinaryPath(value: string): string {
  if (!/^[a-z]:\\/i.test(value) || value.slice(3).split(/[\\/]+/).some((part) =>
    part === "." || part === ".." || /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part))) {
    throw new Error("Trial requires ordinary local paths");
  }
  const path = win32.resolve(value);
  if (path.toLowerCase() === win32.parse(path).root.toLowerCase()) throw new Error("Trial rejects a volume root");
  return path;
}

function samePath(left: string, right: string): boolean {
  return ordinaryPath(left).toLowerCase() === ordinaryPath(right).toLowerCase();
}

export function validateLocalTrial(facts: LocalTrialFacts): void {
  if (facts.platform !== "win32" || !facts.packaged || facts.appName !== TRIAL_APP_NAME) {
    throw new Error("Trial requires its packaged Windows identity");
  }
  // whoami uses localized group names, but the SIDs and CSV structure are stable.
  const user = facts.whoamiUser.trim().match(/^"([^"\r\n]+)","(S-1-5-21-\d+-\d+-\d+-\d+)"$/i);
  if (!user || !facts.computerName || user[1]!.toLowerCase() !== `${facts.computerName}\\alzabt-test`.toLowerCase()) {
    throw new Error("Trial requires the local alzabt-test account");
  }
  const groupSids = new Set(Array.from(facts.whoamiGroups.matchAll(/"(S-\d+(?:-\d+)+)"/gi), (match) => match[1]!.toUpperCase()));
  // Reject administrators even when UAC marks their group deny-only. Require a
  // normal medium-integrity token and fail closed on missing/malformed output.
  if (!groupSids.has("S-1-1-0") || !groupSids.has("S-1-5-113") || !groupSids.has("S-1-5-32-545") || !groupSids.has("S-1-16-8192") ||
      groupSids.has("S-1-5-32-544") || [...groupSids].some((sid) => /^S-1-16-\d+$/.test(sid) && Number(sid.slice(7)) > 8192)) {
    throw new Error("Trial requires a standard-user medium-integrity token");
  }
  const home = ordinaryPath(facts.home);
  const roaming = win32.join(home, "AppData", "Roaming");
  const local = win32.join(home, "AppData", "Local");
  const exe = win32.join(local, "Programs", "alzabt-pos-trial", `${TRIAL_APP_NAME}.exe`);
  if (!samePath(facts.appData, roaming) || !samePath(facts.localAppData, local) || !samePath(facts.executablePath, exe)) {
    throw new Error("Trial requires the fixed per-user installation and app-data paths");
  }
}

export function requireLocalTrial(input: Omit<LocalTrialFacts, "computerName" | "whoamiUser" | "whoamiGroups"> & { windowsDir: string }): void {
  if (input.platform !== "win32") throw new Error("Trial requires Windows");
  const whoami = win32.join(ordinaryPath(input.windowsDir), "System32", "whoami.exe");
  const run = (args: string[]) => execFileSync(whoami, args, { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  validateLocalTrial({ ...input, computerName: hostname(), whoamiUser: run(["/user", "/fo", "csv", "/nh"]),
    whoamiGroups: run(["/groups", "/fo", "csv", "/nh"]) });
}
