/**
 * OWNER PREVIEW first start — the regression test for hosted run 45698905020 (2026-11-25).
 *
 * Root cause: the preview created `synthetic-demo-root-v1` with a bare mkdir; the root marker that the existing safety
 * check requires was missing, so every FRESH machine refused at startup. These tests reproduce that exact state and
 * prove the fix, on the real filesystem (a temp folder), with no Electron.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePreviewSyntheticStorage, syntheticDemoRetention } from "../../src/main/demoProfile";

const made: string[] = [];
const parent = () => {
  const d = mkdtempSync(join(tmpdir(), "alzabt-preview-storage-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("preview first start: synthetic storage", () => {
  it("🔴 REPRODUCES run 45698905020: a root created by a bare mkdir (no marker) is REFUSED by the existing check", () => {
    const p = parent();
    mkdirSync(join(p, "Alzabt-R5-Owner-Preview"));
    mkdirSync(join(p, "Alzabt-R5-Owner-Preview", "synthetic-demo-root-v1"));
    expect(() => syntheticDemoRetention(join(p, "Alzabt-R5-Owner-Preview", "synthetic-demo-root-v1"))).toThrow();
  });

  it("a FRESH machine: creates base, a MARKED root and control; the retention check now passes", () => {
    const p = parent();
    const s = ensurePreviewSyntheticStorage(p, "Alzabt-R5-Owner-Preview");
    expect(readFileSync(join(s.root, ".alzabt-synthetic-demo-root"), "utf8")).toBe("alzabt-synthetic-demo-root-v1");
    expect(syntheticDemoRetention(s.root)).toMatchObject({ retained: 0, reached: false });
  });

  it("the second start reuses the same storage (idempotent), and nothing is recreated", () => {
    const p = parent();
    const first = ensurePreviewSyntheticStorage(p, "Alzabt-R5-Owner-Preview");
    const second = ensurePreviewSyntheticStorage(p, "Alzabt-R5-Owner-Preview");
    expect(second).toEqual(first);
  });

  it("🔴 fail closed: an EXISTING root without its marker is never repaired — it stays refused", () => {
    const p = parent();
    mkdirSync(join(p, "Alzabt-R5-Owner-Preview"));
    mkdirSync(join(p, "Alzabt-R5-Owner-Preview", "synthetic-demo-root-v1"));
    expect(() => ensurePreviewSyntheticStorage(p, "Alzabt-R5-Owner-Preview")).toThrow();
  });

  it("🔴 fail closed: a base folder that is a junction is refused", () => {
    const p = parent();
    const elsewhere = join(p, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(p, "Alzabt-R5-Owner-Preview"), "junction");
    expect(() => ensurePreviewSyntheticStorage(p, "Alzabt-R5-Owner-Preview")).toThrow();
  });
});
