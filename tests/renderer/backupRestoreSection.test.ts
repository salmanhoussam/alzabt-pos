/**
 * Track 2 phase 3 — the owner's backup/restore section. There is no DOM environment here, so the
 * button rule is BEHAVIOURAL (a pure module) and the markup guarantees are SOURCE-LEVEL. The
 * installed Windows E2E is what will prove the rendered screen (phase 4).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canApplyRestore } from "../../src/renderer/screens/restoreDecision";
import type { BackupMissingAssetDto, BackupSettingsState, RestorePreviewDto, RestoreRefusalReason } from "../../src/shared/ipcContract";
import { allKeys, translate } from "../../src/shared/i18n";

const SECTION = readFileSync("src/renderer/screens/BackupRestoreSection.tsx", "utf8");
const TOOLS = readFileSync("src/renderer/screens/ToolsScreen.tsx", "utf8");
const SHEET = readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const preview = (complete: boolean) => ({ complete }) as RestorePreviewDto;

describe("when the restore button may be pressed", () => {
  it("never without a preview or without the main confirmation", () => {
    expect(canApplyRestore(null, true, true)).toBe(false);
    expect(canApplyRestore(preview(true), false, true)).toBe(false);
  });
  it("a complete backup needs only the confirmation", () => {
    expect(canApplyRestore(preview(true), true, false)).toBe(true);
  });
  it("🔴 an incomplete backup also needs the explicit acceptance of its missing files", () => {
    expect(canApplyRestore(preview(false), true, false)).toBe(false);
    expect(canApplyRestore(preview(false), true, true)).toBe(true);
  });
});

describe("the section's source", () => {
  const code = strip(SECTION);

  it("previewing never stages: the chooser calls inspect only, and apply is reached only from the confirm button", () => {
    const choose = code.slice(code.indexOf("const chooseBackup"), code.indexOf("const applyRestore"));
    expect(choose).toContain("inspectRestoreBackup");
    expect(choose).not.toContain("applyRestore");
    expect(code.match(/pos\(\)\.applyRestore\(/g)).toHaveLength(1);
  });

  it("apply sends the PREVIEW's hash and acceptance only for an incomplete backup — and no path", () => {
    expect(code).toContain("manifestSha256: preview.manifestSha256");
    expect(code).toContain("acceptMissingAssets: !preview.complete && acceptedMissing");
    expect(code).not.toMatch(/packageDir|folderPath|\.path\b/);
  });

  it("is rendered for an owner only (a courtesy; the channels refuse anyone else)", () => {
    expect(strip(TOOLS)).toContain('props.operator.role === "owner" && <BackupRestoreSection />');
  });

  it("the invoice sheet words an UNVERIFIED logo with its own sentence, not the missing-archive one", () => {
    const sheet = strip(SHEET);
    expect(sheet).toContain('data-testid="sheet-logo-unverified"');
    expect(sheet).toContain('t("inv.sheet.logoUnverified")');
  });
});

describe("every state the section can show has a sentence, in both languages", () => {
  const reasons: RestoreRefusalReason[] = [
    "IN_APP_FOLDER",
    "UNPUBLISHED",
    "NOT_A_BACKUP",
    "DAMAGED",
    "NEWER_THAN_APP",
    "OTHER_DATABASE",
    "CHANGED",
    "RESTORE_PENDING",
    "NO_PREVIEW",
    "PREVIEW_MISMATCH",
    "MISSING_NOT_ACCEPTED",
    "FAILED",
  ];
  const missingReasons: BackupMissingAssetDto["reason"][] = [
    "absent-at-source",
    "not-a-regular-file",
    "unsafe-name",
    "content-mismatch",
    "too-large",
    "changed-during-backup",
  ];
  const settings: BackupSettingsState[] = ["included", "absent", "invalid-at-source", "changed-during-backup"];
  const keys = [
    ...reasons.map((r) => `restore.refused.${r}`),
    ...["IN_APP_FOLDER", "DESTINATION_EXISTS", "FAILED"].map((r) => `fullBackup.failed.${r}`),
    ...missingReasons.map((r) => `backup.reason.${r}`),
    ...["frozen-logo", "live-logo"].map((k) => `backup.missing.${k}`),
    ...settings.map((s) => `backup.settings.${s}`),
    ...["sales", "invoices", "parties", "obligations", "settlements", "receipts", "operators"].map((c) => `restore.count.${c}`),
    "inv.sheet.logoUnverified",
  ];

  it("each key exists, differs between Arabic and English, and is not a raw key", () => {
    const all = new Set(allKeys());
    for (const k of keys) {
      expect(all.has(k), k).toBe(true);
      expect(translate("ar", k), k).not.toBe(k);
      expect(translate("ar", k), k).not.toBe(translate("en", k));
    }
  });

  it("🔴 no refusal reuses another's sentence (each is a different fact)", () => {
    for (const lang of ["ar", "en"] as const) {
      const texts = reasons.map((r) => translate(lang, `restore.refused.${r}`));
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it("the unverified-logo sentence is not the missing-archive sentence", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(translate(lang, "inv.sheet.logoUnverified")).not.toBe(translate(lang, "inv.sheet.logoMissing"));
    }
  });
});

describe("the two older backup sentences tell the database-only export from the full backup", () => {
  it("the old export says it is database-only and points to the full backup", () => {
    expect(translate("ar", "tools.backupExcludes")).toContain("لقاعدة البيانات وحدها");
    expect(translate("ar", "tools.backupExcludes")).toContain(translate("ar", "fullBackup.title"));
    expect(translate("en", "tools.backupExcludes")).toContain("database-only");
    expect(translate("en", "tools.backupExcludes")).toContain(translate("en", "fullBackup.title"));
  });

  it("🔴 the cold-copy note no longer implies it is the ONLY copy with the logos", () => {
    expect(translate("ar", "tools.coldCopyNote")).toContain("النسخة الاحتياطيّة الكاملة تحوي شعار الفواتير");
    expect(translate("en", "tools.coldCopyNote").toLowerCase()).toContain("the full backup includes the archived invoice logos");
  });
});
