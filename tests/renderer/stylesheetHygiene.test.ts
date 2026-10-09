import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(__dirname, "../../src/renderer/styles.css");
const css = readFileSync(CSS_PATH, "utf8");

/**
 * Parses selectors properly rather than grepping for them.
 *
 * 🔴 WHY NOT A REGEX. The Foundation spec demotes the one-line grep to a developer sanity check
 * for a measured reason: it is line-based, so a GROUPED selector written across two lines
 * ("a,\n b { … }") reports as a duplicate of itself. That exact false positive appeared while
 * doing this cleanup. A parser splits groups and normalises whitespace; a regex cannot.
 */
function selectors(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const ch of withoutComments) {
    if (ch === "{") {
      if (depth === 0) {
        for (const one of buffer.split(",")) {
          const clean = one.trim().replace(/\s+/g, " ");
          // @media / @supports open a block whose contents are rules of their own; the at-rule
          // itself is not a selector.
          if (clean && !clean.startsWith("@")) out.push(clean);
        }
      }
      depth += 1;
      buffer = "";
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      buffer = "";
    } else if (depth === 0) {
      buffer += ch;
    }
  }
  return out;
}

const duplicates = (source: string) => {
  const seen = new Map<string, number>();
  for (const sel of selectors(source)) seen.set(sel, (seen.get(sel) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([sel]) => sel);
};

describe("the renderer stylesheet declares each selector once", () => {
  // 🔴 POSITIVE CONTROL FIRST. A check that cannot fail proves nothing, and this project has
  // already shipped two blind probes that passed while measuring nothing.
  it("the detector actually detects a known duplicate", () => {
    const planted = css + "\n.alzabt-planted-duplicate { color: red; }\n.alzabt-planted-duplicate { color: blue; }\n";
    expect(duplicates(planted)).toContain(".alzabt-planted-duplicate");
  });

  it("and it does NOT mistake a grouped selector for a duplicate", () => {
    // The false positive the grep produced: one rule, two selectors, written on two lines.
    const grouped = "a.one,\nb.two { color: red; }\n";
    expect(duplicates(grouped)).toEqual([]);
  });

  it("the real stylesheet has no duplicated selector", () => {
    expect(duplicates(css)).toEqual([]);
  });

  it("every colour comes from a token, not a stray literal", () => {
    // Literals are allowed only inside :root, where the tokens are defined.
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "").split(":root")[1] ?? "";
    const afterRoot = body.slice(body.indexOf("}") + 1);
    const strays = afterRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    // .notice's info-banner pair is the one documented exception, kept as its own component.
    const allowed = new Set(["#eef6ff", "#bcd8f7", "#fff", "#ffffff"]);
    expect(strays.filter((c) => !allowed.has(c.toLowerCase()))).toEqual([]);
  });
});
