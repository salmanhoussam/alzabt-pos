import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticDemoRoot, DemoProfileError, reserveSyntheticDemoProfile, syntheticDemoRetention } from "../../src/main/demoProfile";

// All generated test artifacts are retained below this isolated worktree.
// No existing directory/profile is removed or modified.
const parent = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-profile-test-"));
function worker(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const file = join(process.cwd(), "tests", "helpers", "demoReservationWorker.ts");
    const child = spawn(process.execPath, [cli, file, root], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (part: Buffer) => { out += part.toString(); });
    child.stderr.on("data", (part: Buffer) => { err += part.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error("synthetic worker failed: " + err)));
  });
}

describe("synthetic-only demo profile reservations", () => {
  it("creates five distinct fresh slots and refuses the sixth without deleting data", () => {
    const root = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    expect(syntheticDemoRetention(root)).toEqual({ retained: 0, max: 5, reached: false });
    const values = Array.from({ length: 5 }, () => reserveSyntheticDemoProfile(root));
    expect(syntheticDemoRetention(root)).toEqual({ retained: 5, max: 5, reached: true });
    expect(new Set(values.map((v) => v.path)).size).toBe(5);
    for (const value of values) expect(existsSync(join(value.path, ".alzabt-synthetic-demo-profile"))).toBe(true);
    expect(() => reserveSyntheticDemoProfile(root)).toThrow("Demo retention limit reached.");
    expect(readdirSync(root).filter((x) => x.startsWith("slot-"))).toHaveLength(5);
  });

  it("does not create a second root under the same trusted parent when five slots are retained", () => {
    const oneParent = mkdtempSync(join(parent, "capacity-"));
    const root = createSyntheticDemoRoot(oneParent);
    for (let i = 0; i < 5; i++) reserveSyntheticDemoProfile(root);
    expect(() => createSyntheticDemoRoot(oneParent)).toThrow("Demo profile unavailable.");
    expect(() => reserveSyntheticDemoProfile(root)).toThrow("Demo retention limit reached.");
    expect(readdirSync(oneParent)).toHaveLength(1);
  });

  it("counts an interrupted reservation rather than reusing or deleting it", () => {
    const root = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    mkdirSync(join(root, "slot-1"));
    expect(syntheticDemoRetention(root)).toEqual({ retained: 1, max: 5, reached: false });
    expect(reserveSyntheticDemoProfile(root).slot).toBe(2);
    expect(existsSync(join(root, "slot-1"))).toBe(true);
  });

  it("refuses an unmarked root and unexpected entries without changing them", () => {
    expect(() => reserveSyntheticDemoProfile(parent)).toThrow(DemoProfileError);
    const root = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    const unknown = join(root, "not-a-slot");
    writeFileSync(unknown, "synthetic", { flag: "wx" });
    expect(() => reserveSyntheticDemoProfile(root)).toThrow("Demo profile unavailable.");
    expect(() => syntheticDemoRetention(root)).toThrow("Demo profile unavailable.");
    expect(existsSync(unknown)).toBe(true);
  });

  it("rejects a junction placed in a slot using only two new synthetic directories", () => {
    const root = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    const other = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    symlinkSync(other, join(root, "slot-1"), "junction");
    expect(() => reserveSyntheticDemoProfile(root)).toThrow("Demo profile unavailable.");
    expect(existsSync(other)).toBe(true);
  });

  it("permits at most five successful reservations across eight concurrent processes", async () => {
    const root = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    const results = await Promise.all(Array.from({ length: 8 }, () => worker(root)));
    expect(results.filter((r) => r === "OK")).toHaveLength(5);
    expect(results.filter((r) => r === "LIMIT")).toHaveLength(3);
    expect(readdirSync(root).filter((x) => x.startsWith("slot-"))).toHaveLength(5);
  }, 60000);
});
