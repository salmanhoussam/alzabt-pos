import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accessFor } from "../../src/main/channelPolicy";
import { translate } from "../../src/shared/i18n";

/**
 * QW-CASHIER-TOOLS (owner finding DEC-33 #4, FIELD UAT 2026-11-06). A cashier saw the owner-only
 * catalog and backup buttons and met an English refusal box. Code read: visibility only — every channel
 * is `owner` and refused before its handler runs. Now the buttons are hidden for a non-owner; the
 * channel policy stays the authority (asserted here, and against the installed app in
 * e2e/operator-accounts.mjs).
 */
const code = readFileSync("src/renderer/screens/ToolsScreen.tsx", "utf8").replace(/^\s*\/\/.*$/gm, "");

/** The JSX between `{isOwner && (` and the next `)}` that closes it. */
function ownerBlocks(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf("{isOwner && (");
  while (i !== -1) {
    const end = src.indexOf("\n      )}", i);
    out.push(src.slice(i, end));
    i = src.indexOf("{isOwner && (", end);
  }
  return out;
}

describe("a cashier sees no owner-only tool", () => {
  it("🔴 import, export and the database copy render ONLY inside an owner block", () => {
    const owner = ownerBlocks(code).join("\n");
    for (const id of ["import-catalog", "export-catalog", "export-backup"]) {
      expect(owner, `${id} inside an owner block`).toContain(`data-testid="${id}"`);
      expect(code.split(`data-testid="${id}"`).length - 1, `${id} rendered exactly once`).toBe(1);
    }
    expect(code).toContain('const isOwner = props.operator.role === "owner";');
    expect(code).toContain("{isOwner && <BackupRestoreSection />}");
    expect(code).toContain("{isOwner && <OperatorsSection selfId={props.operator.id} />}");
  });

  it("the cashier is told why, in both languages, and still sees About", () => {
    expect(code).toMatch(/\{!isOwner && \(\s*<section className="card" data-testid="tools-owner-only">/);
    expect(translate("ar", "tools.ownerOnly")).toContain("المالك فقط");
    expect(translate("en", "tools.ownerOnly")).toContain("owner only");
    expect(code).toContain('data-testid="about"');
    expect(ownerBlocks(code).join("\n")).not.toContain('data-testid="about"');
  });

  it("🔴 hiding is a courtesy: the channels themselves stay owner-only", () => {
    for (const channel of ["importCatalog", "exportCatalog", "exportBackup", "exportFullBackup", "applyRestore"] as const) {
      expect(accessFor(channel), channel).toBe("owner");
    }
  });
});
