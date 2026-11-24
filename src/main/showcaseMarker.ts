/**
 * SHOWCASE PROFILE MARKER (owner, DEC-35h §5, approved with guards) — a visible "this is a showcase
 * profile" banner for a deliberately prepared demo profile, and NOTHING else.
 *
 * WHY A MARKER AT ALL. DEMO-FALLBACK (./demoCatalog.ts) shows its banner only while the bundled
 * sample catalog is served, which it refuses on any ledger holding merchant data. A showcase profile
 * that imported 40 realistic products is, by that rule, a merchant profile — correctly — so it showed
 * no banner. Importing products similar to the demo ones must NOT make a shop "demo" either. The
 * identity therefore has to be an explicit act of the TOOLING that prepares the profile.
 *
 * 🔴 THE GUARDS, each enforced by construction here and pinned by tests:
 *   - READ-ONLY. The app never creates, edits or deletes this file; no channel writes it, and no
 *     screen offers it. Only test / showcase tooling (e2e/demo-catalog.mjs with DEMO_SHOWCASE_DIR)
 *     writes it into a profile it has just built.
 *   - ADDITIVE ONLY. It yields one boolean the renderer turns into a banner. It does not enable the
 *     sample catalog, does not touch DEMO-FALLBACK's decision, permissions, login, payments, or SQLite.
 *   - NOT CARRIED BY BACKUP. The full backup copies an explicit list (ledger, branding, settings.json);
 *     this file is not on it, so a restore cannot carry it into another profile.
 *   - FAILS SAFE. Copied by hand into another profile, the worst it does is show an extra warning.
 *     Anything but the exact expected content — or a directory, a link, an oversized file — is
 *     ignored (no banner): a stray file never changes behaviour.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SHOWCASE_MARKER_FILE = "alzabt-showcase-profile.json";
const MAX_BYTES = 1024;

/** The exact, whole content the tooling writes. */
export const SHOWCASE_MARKER_CONTENT = { kind: "alzabt-pos-showcase-profile", version: 1 } as const;

/** True only for a regular file of the exact expected shape inside `userData`. Never throws. */
export function readShowcaseMarker(userData: string): boolean {
  try {
    const path = join(userData, SHOWCASE_MARKER_FILE);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return false;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed).sort();
    if (keys.join(",") !== "kind,version") return false;
    const o = parsed as Record<string, unknown>;
    return o.kind === SHOWCASE_MARKER_CONTENT.kind && o.version === SHOWCASE_MARKER_CONTENT.version;
  } catch {
    return false;
  }
}
