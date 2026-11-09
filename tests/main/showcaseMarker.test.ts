/**
 * SHOWCASE MARKER guards (owner, DEC-35h §5). The marker may only ADD a banner. These tests pin:
 * the exact-content reader (anything else → no banner, never a throw); that NO source file in the app
 * writes it; that the full-backup file list does not carry it; and that it is independent of the
 * DEMO-FALLBACK decision.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideDemoCatalog } from "../../src/main/demoCatalog";
import { SHOWCASE_MARKER_CONTENT, SHOWCASE_MARKER_FILE, readShowcaseMarker } from "../../src/main/showcaseMarker";
import * as backupPackage from "../../src/persistence/backupPackage";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-showcase-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (content: string) => writeFileSync(join(dir, SHOWCASE_MARKER_FILE), content, "utf8");

describe("readShowcaseMarker — exact content or nothing", () => {
  it("absent → false (every real shop)", () => {
    expect(readShowcaseMarker(dir)).toBe(false);
  });
  it("the exact tooling content → true", () => {
    put(JSON.stringify(SHOWCASE_MARKER_CONTENT) + "\n");
    expect(readShowcaseMarker(dir)).toBe(true);
  });
  it("anything else → false, never a throw", () => {
    for (const bad of [
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({ kind: "alzabt-pos-showcase-profile" }),
      JSON.stringify({ kind: "alzabt-pos-showcase-profile", version: 2 }),
      JSON.stringify({ kind: "something-else", version: 1 }),
      JSON.stringify({ ...SHOWCASE_MARKER_CONTENT, demoCatalog: true }), // no extra powers smuggled in
      " ".repeat(2000) + JSON.stringify(SHOWCASE_MARKER_CONTENT), // oversized
    ]) {
      put(bad);
      expect(readShowcaseMarker(dir), bad.slice(0, 40)).toBe(false);
    }
  });
  it("a DIRECTORY with the marker's name → false", () => {
    mkdirSync(join(dir, SHOWCASE_MARKER_FILE));
    expect(readShowcaseMarker(dir)).toBe(false);
  });
  it("a missing profile folder → false", () => {
    expect(readShowcaseMarker(join(dir, "nope"))).toBe(false);
  });
});

describe("🔴 the app never writes the marker", () => {
  it("no source file under src/ writes, copies or renames anything named like the marker", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e)) files.push(p);
      }
    };
    walk("src");
    const writers: string[] = [];
    for (const f of files) {
      // Comments stripped: a sentence ABOUT the file is not code that writes it.
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const mentions = code.includes(SHOWCASE_MARKER_FILE) || code.includes("SHOWCASE_MARKER_FILE");
      if (mentions && /\b(writeFile|writeFileSync|copyFile|copyFileSync|cpSync|rename|renameSync|appendFile|createWriteStream)\b/.test(code)) {
        writers.push(f);
      }
    }
    expect(writers).toEqual([]);
  });
});

describe("🔴 backup does not carry it; DEMO-FALLBACK does not see it", () => {
  it("the full-backup source list names the ledger, branding and settings — never the marker", () => {
    const exported = (Object.values(backupPackage) as unknown[]).filter((v): v is string => typeof v === "string");
    expect(exported).toContain("settings.json");
    expect(exported.some((v) => v.includes("showcase"))).toBe(false);
    const src = readFileSync("src/persistence/backupPackage.ts", "utf8");
    expect(src.includes(SHOWCASE_MARKER_FILE)).toBe(false);
  });
  it("the demo decision takes no marker input: a merchant ledger stays merchant whatever the profile says", () => {
    const merchant = { productRows: 40, parties: 0, invoices: 0, merchantSaleLines: 0 };
    expect(decideDemoCatalog(true, merchant)).toEqual({ mode: "merchant", demoRefused: true, reason: "merchant-data" });
    expect(decideDemoCatalog.length).toBe(2); // (requested, probe) — no third, marker-shaped argument
  });
});
