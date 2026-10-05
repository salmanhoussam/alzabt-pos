/**
 * Version and build identity shown in the app ("Alzabt POS 0.1.1 · Build 1a2b3c4") and written to
 * the log. The version comes from package.json (single source of truth, read by Electron as
 * app.getVersion()); the build is the git commit embedded at build time by
 * scripts/write-build-info.mjs into dist/build-info.json, so it works on a PC without git.
 */
import { readFileSync } from "node:fs";

export interface BuildInfo {
  readonly version: string;
  readonly build: string;
}

export function readBuildInfo(file: string, appVersion: string): BuildInfo {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; build?: unknown };
    const build = typeof parsed.build === "string" && /^[0-9a-f]{7}(-dirty)?$|^unknown$/.test(parsed.build) ? parsed.build : "unknown";
    // package.json is the single source; a mismatch means a stale build-info file — show it, don't hide it.
    const version = parsed.version === appVersion ? appVersion : `${appVersion} (build-info ${String(parsed.version)})`;
    return { version, build };
  } catch {
    return { version: appVersion, build: "unknown" };
  }
}

export function buildLabel(info: BuildInfo): string {
  return `Alzabt POS ${info.version} · Build ${info.build}`;
}
