/**
 * OWNER PREVIEW candidate pins (preview R3, after hosted run 45703295291).
 *
 * 1. The hosted workflow's branch filter, its `if` guard and the build script's REF name the SAME branch, and that
 *    branch can never start windows-delivery (whose filter includes `claude/**`). A mismatch would either build
 *    nothing or start the wrong pipeline.
 * 2. Every `data-testid` the installed smoke waits for exists in the renderer source. R2 waited for
 *    `lbp-equivalent`, which no Sell-screen element ever carried — the wait could not succeed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// GitHub branch-filter glob: `**` any chars, `*` any chars except `/`.
const glob = (p: string) =>
  new RegExp("^" + p.split("**").map((s) => s.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");

describe("preview candidate branch", () => {
  const workflow = read(".github/workflows/preview-installed-windows.yml");
  const filter = /branches:\s*\[([^\]]+)\]/.exec(workflow)?.[1]?.trim();
  const guard = /github\.ref == 'refs\/heads\/([^']+)'/.exec(workflow)?.[1];
  const ref = /const REF = 'refs\/heads\/([^']+)';/.exec(read("scripts/preview-build-candidate.cjs"))?.[1];

  it("filter, guard and build REF name one branch", () => {
    expect(filter).toBeTruthy();
    expect(guard).toBe(filter);
    expect(ref).toBe(filter);
  });

  it("the branch is outside every other workflow's push filter (windows-delivery's claude/** included)", () => {
    const dir = join(root, ".github", "workflows");
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n) && n !== "preview-installed-windows.yml")) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.matchAll(/branches:\s*\[([^\]]+)\]/g)) {
        for (const b of m[1]!.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))) {
          expect(glob(b).test(filter!), `${f} filter ${b} matches ${filter}`).toBe(false);
        }
      }
    }
    expect(glob("claude/**").test(filter!)).toBe(false);
  });
});

describe("installed smoke selectors", () => {
  const smoke = read("e2e/preview-demo-smoke.mjs");
  const rendererText = (() => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) out.push(read(p));
      }
    };
    walk("src/renderer");
    return out.join("\n");
  })();

  it("every test id the smoke uses exists in the renderer", () => {
    const ids = new Set<string>();
    for (const m of smoke.matchAll(/testid\([^,]+,\s*"([^"]+)"\)/g)) ids.add(m[1]!);
    for (const m of smoke.matchAll(/data-testid="([^"]+)"/g)) if (!m[1]!.includes("${")) ids.add(m[1]!); // skip the helper's template
    expect(ids.size).toBeGreaterThan(3);
    for (const id of ids) {
      const present = rendererText.includes(`data-testid="${id}"`) || rendererText.includes(`testid="${id}"`) || rendererText.includes("data-testid={`tab-${name}`}") && id.startsWith("tab-");
      expect(present, `smoke waits for "${id}", which the renderer never renders`).toBe(true);
    }
  });

  it("R2's dead selector is gone and the reload is not used to flip the display", () => {
    expect(smoke).not.toMatch(/testid\([^)]*"lbp-equivalent"\)/);
    expect(smoke).not.toMatch(/page\.reload\(/);
    expect(smoke).toContain('[data-testid="product-price-lbp"]');
    expect(smoke).toContain('testid(page, "display-currency-toggle")');
  });
});
