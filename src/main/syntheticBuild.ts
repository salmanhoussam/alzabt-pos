/**
 * OWNER-ONLY R5 PREVIEW (owner decision 2026-11-25): where the synthetic (Demo) path may run.
 *
 * Before this module, every synthetic gate read `app.isPackaged`: an unpackaged development build only. The owner
 * approved ONE packaged exception, the «owner-preview» build, so the gates now ask this module instead:
 *   - unpackaged development build            → allowed (unchanged behaviour)
 *   - packaged build marked "owner-preview"   → allowed, still behind the SAME identity gate (demoDevGate: the
 *                                               standard Windows user `alzabt-test`, not an administrator, with a
 *                                               verified profile) — and the preview REFUSES to start otherwise
 *   - any other packaged build                → never
 *
 * The mark is `alzabtFlavor` in the PACKAGED package.json, written only by build/preview.electron-builder.cjs
 * (electron-builder `extraMetadata`). The standard build's package.json has no such field, and the standard build does
 * not even contain the Demo modules (package.json `build.files` excludes them), so a forged field there finds nothing
 * to run. Same-user tampering with the installed files stays out of scope (threat model T6).
 */
import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const OWNER_PREVIEW_FLAVOR = "owner-preview";

let cachedFlavor: string | null | undefined;

/** The packaged build's flavor, or null (standard build, or unpackaged). Read once. */
export function packagedFlavor(): string | null {
  if (cachedFlavor !== undefined) return cachedFlavor;
  cachedFlavor = null;
  if (app.isPackaged) {
    try {
      const pkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { alzabtFlavor?: unknown };
      if (pkg.alzabtFlavor === OWNER_PREVIEW_FLAVOR) cachedFlavor = OWNER_PREVIEW_FLAVOR;
    } catch {
      cachedFlavor = null;
    }
  }
  return cachedFlavor;
}

/** True for the packaged owner-only preview build. */
export function isOwnerPreviewBuild(): boolean {
  return app.isPackaged && packagedFlavor() === OWNER_PREVIEW_FLAVOR;
}

/** May the synthetic (Demo) path run in this build at all? Identity is decided separately (demoDevGate). */
export function syntheticBuildAllowed(): boolean {
  return !app.isPackaged || isOwnerPreviewBuild();
}
