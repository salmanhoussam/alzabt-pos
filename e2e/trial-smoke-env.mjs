// Pure helpers for the disposable Windows runner's installed-app smoke.
// The caller must still establish that it is running on a disposable runner.
import { win32 } from "node:path";

export const RUNNER_FLAGS = ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "ALZABT_SYNTHETIC_RUNNER_ONLY", "RUNNER_TEMP"];

export function requireStandardLocalAccount(hostname, whoamiUser, whoamiGroups) {
  const user = whoamiUser.trim().match(/^"([^"\r\n]+)","(S-1-5-21-\d+-\d+-\d+-\d+)"$/i);
  if (!user || !hostname || user[1].toLowerCase() !== `${hostname}\\alzabt-test`.toLowerCase()) {
    throw new Error("Installed local smoke requires the local alzabt-test account");
  }
  const groups = new Set(Array.from(whoamiGroups.matchAll(/"(S-\d+(?:-\d+)+)"/gi), (match) => match[1].toUpperCase()));
  if (!["S-1-1-0", "S-1-5-113", "S-1-5-32-545", "S-1-16-8192"].every((sid) => groups.has(sid)) ||
      groups.has("S-1-5-32-544") || [...groups].some((sid) => /^S-1-16-\d+$/.test(sid) && Number(sid.slice(7)) > 8192)) {
    throw new Error("Installed local smoke requires a standard-user medium-integrity token");
  }
}

export function selectTrialAppEnvironment(env, mode, localRoaming) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" ||
      env.ALZABT_SYNTHETIC_RUNNER_ONLY !== "1" || !env.RUNNER_TEMP) {
    throw new Error("Smoke requires a disposable hosted Windows runner");
  }
  const result = { ...env };
  if (mode === "local") {
    if (!localRoaming || !win32.isAbsolute(localRoaming) || !env.APPDATA ||
        win32.resolve(localRoaming).toLowerCase() !== win32.resolve(env.APPDATA).toLowerCase()) {
      throw new Error("Local smoke requires the account's Windows roaming app-data path");
    }
    for (const key of RUNNER_FLAGS) delete result[key];
    result.APPDATA = localRoaming;
  } else if (mode === "runner") {
    if (!env.APPDATA || win32.resolve(env.APPDATA).toLowerCase() !==
        win32.resolve(win32.join(env.RUNNER_TEMP, "alzabt-trial-appdata")).toLowerCase()) {
      throw new Error("Runner smoke requires its fixed synthetic profile root");
    }
  } else {
    throw new Error("Unsupported trial smoke environment");
  }
  return result;
}
