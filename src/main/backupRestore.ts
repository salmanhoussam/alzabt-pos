/**
 * Full backup and restore, as the three things the owner can ask main to do (Track 2 phase 3).
 *
 * A module rather than code inside main.ts for the same reason as invoiceLogo.ts: main.ts exports
 * nothing, so anything there is reachable only through a packaged app. The dialogs and the restart
 * arrive as functions; every decision below is testable through the REAL IPC handlers.
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 THE PREVIEW LIVES HERE, NOT IN THE RENDERER. `inspect` remembers which folder it verified and
 * what it found. `apply` takes only the manifest hash the owner confirmed and whether they accepted
 * the missing files; it stages the folder THIS module previewed, never one the renderer names, and
 * builds the consent from the missing-files list THIS module showed. `stageRestore` then verifies
 * the package again and refuses it if it is no longer the one previewed.
 *
 * Nothing is staged by opening or previewing a folder. Staging happens only on `apply`, and only
 * after it, the program restarts; the swap itself runs at the next start (restoreStartup.ts).
 * ═══════════════════════════════════════════════════════════
 */
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import { DomainError } from "../domain/errors";
import {
  type BackupFs,
  type BackupPackageErrorCode,
  BackupPackageError,
  type MissingAsset,
  createFullBackup,
  fullBackupFolderName,
} from "../persistence/backupPackage";
import type { Db } from "../persistence/db";
import { MIGRATIONS, type Migration } from "../persistence/migrations";
import { RestoreError, type RestorePreview, inspectRestorePackage, stageRestore } from "../persistence/restoreEngine";
import type {
  ApplyRestoreRequest,
  ApplyRestoreResponse,
  FullBackupExportResponse,
  InspectRestoreResponse,
  RestorePreviewDto,
  RestoreRefusalReason,
} from "../shared/ipcContract";
import type { Logger } from "./logger";
import type { RestoreLock } from "./restoreLock";

export interface BackupRestoreDeps {
  /** The app's userData folder: the ledger, branding/ and settings.json live here. */
  readonly userDataDir: string;
  /** The open ledger, or null when there is none to back up. */
  readonly ledger: () => Db | null;
  readonly appVersion: string;
  readonly now: () => Date;
  /** The native folder picker. Null means the owner cancelled. */
  readonly chooseFolder: (purpose: "export-backup" | "restore-backup") => string | null;
  /**
   * Restarts the program. Called once, after a restore is staged; main schedules it so the IPC
   * answer reaches the window first.
   */
  readonly relaunch: () => void;
  /** Engaged the moment staging succeeds — before the restart is even asked for. */
  readonly lock: RestoreLock;
  readonly log: Logger;
  readonly fs?: BackupFs;
  readonly migrations?: ReadonlyArray<Migration>;
}

export interface BackupRestoreActions {
  exportFullBackup(): FullBackupExportResponse;
  inspectRestoreBackup(): InspectRestoreResponse;
  applyRestore(req: ApplyRestoreRequest): ApplyRestoreResponse;
}

const COUNTED = ["sales", "invoices", "parties", "obligations", "settlements", "receipts", "operators"] as const;

/** True when `dir` is `parent` or inside it. */
function within(parent: string, dir: string): boolean {
  const rel = relative(resolve(parent), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The verifier's refusal, as the reason the owner reads. */
function reasonForPackage(code: BackupPackageErrorCode | null): RestoreRefusalReason {
  switch (code) {
    case "SCHEMA_NEWER":
      return "NEWER_THAN_APP";
    case "SCHEMA_MISMATCH":
      return "OTHER_DATABASE";
    case "NOT_A_PACKAGE":
    case "UNSUPPORTED_FORMAT":
    case "MANIFEST_INVALID":
      return "NOT_A_BACKUP";
    default:
      return "DAMAGED";
  }
}

function refusalFor(err: RestoreError): { reason: RestoreRefusalReason; detail: string | null } {
  switch (err.code) {
    case "PACKAGE_UNPUBLISHED":
      return { reason: "UNPUBLISHED", detail: null };
    case "PACKAGE_CHANGED":
    case "CONSENT_MISMATCH":
      return { reason: "CHANGED", detail: null };
    case "INCOMPLETE_NOT_ACCEPTED":
      return { reason: "MISSING_NOT_ACCEPTED", detail: null };
    case "RESTORE_PENDING":
      return { reason: "RESTORE_PENDING", detail: null };
    case "PACKAGE_INVALID":
    case "STAGE_FAILED":
      return err.packageCode ? { reason: reasonForPackage(err.packageCode), detail: err.packageCode } : { reason: "FAILED", detail: err.code };
    default:
      return { reason: "FAILED", detail: err.code };
  }
}

function toPreviewDto(dir: string, p: RestorePreview, migrations: ReadonlyArray<Migration>): RestorePreviewDto {
  const c = p.manifest.tableCounts;
  return {
    manifestSha256: p.manifestSha256,
    folderName: basename(dir),
    createdAt: p.manifest.createdAt,
    appVersion: p.manifest.appVersion,
    schemaVersion: p.manifest.schemaVersion,
    appSchemaVersion: migrations.length,
    counts: Object.fromEntries(COUNTED.map((t) => [t, c[t] ?? null])) as RestorePreviewDto["counts"],
    complete: p.complete,
    missingAssets: p.missingAssets.map((m) => ({ ...m })),
    settings: p.manifest.settings,
  };
}

export function createBackupRestoreActions(deps: BackupRestoreDeps): BackupRestoreActions {
  const migrations = deps.migrations ?? MIGRATIONS;
  const fsOpt = deps.fs ? { fs: deps.fs } : {};
  /** The ONE package the owner previewed last, held in main. */
  let previewed: { readonly dir: string; readonly manifestSha256: string; readonly complete: boolean; readonly missingAssets: ReadonlyArray<MissingAsset> } | null = null;

  return {
    exportFullBackup() {
      const db = deps.ledger();
      if (!db) throw new DomainError("NOT_AVAILABLE", "There is no open ledger to back up");
      const parent = deps.chooseFolder("export-backup");
      if (!parent) return { status: "cancelled" };
      // A backup inside the program's own data folder is not "somewhere else", and a restore would
      // move it aside with everything it is meant to protect.
      if (within(deps.userDataDir, parent)) return { status: "failed", reason: "IN_APP_FOLDER" };
      const destDir = join(parent, fullBackupFolderName(deps.now()));
      try {
        const created = createFullBackup(db, {
          userDataDir: deps.userDataDir,
          destDir,
          appVersion: deps.appVersion,
          now: deps.now(),
          migrations,
          ...fsOpt,
        });
        deps.log.info("full-backup-export", {
          folder: basename(destDir),
          complete: created.complete,
          missingAssets: created.manifest.missingAssets.length,
          settings: created.manifest.settings,
          files: created.manifest.files.length,
        });
        return {
          status: "saved",
          folderName: basename(destDir),
          location: parent,
          complete: created.complete,
          missingAssets: created.manifest.missingAssets.map((m) => ({ ...m })),
          settings: created.manifest.settings,
        };
      } catch (err) {
        deps.log.error("full-backup-export-failed", { error: err });
        if (err instanceof BackupPackageError && err.code === "DESTINATION_EXISTS") return { status: "failed", reason: "DESTINATION_EXISTS" };
        return { status: "failed", reason: "FAILED" };
      }
    },

    inspectRestoreBackup() {
      // A new look always forgets the old one: consent can only ever be for the latest preview.
      previewed = null;
      const dir = deps.chooseFolder("restore-backup");
      if (!dir) return { status: "cancelled" };
      if (within(deps.userDataDir, dir)) return { status: "refused", reason: "IN_APP_FOLDER", detail: null };
      try {
        const preview = inspectRestorePackage(dir, { migrations, ...fsOpt });
        previewed = { dir, manifestSha256: preview.manifestSha256, complete: preview.complete, missingAssets: preview.missingAssets };
        deps.log.info("restore-inspect", { folder: basename(dir), complete: preview.complete, schema: preview.manifest.schemaVersion });
        return { status: "ready", preview: toPreviewDto(dir, preview, migrations) };
      } catch (err) {
        if (err instanceof RestoreError) {
          const refusal = refusalFor(err);
          deps.log.warn("restore-inspect-refused", { folder: basename(dir), code: err.code, packageCode: err.packageCode });
          return { status: "refused", ...refusal };
        }
        throw err;
      }
    },

    applyRestore(req) {
      const p = previewed;
      if (!p) return { status: "refused", reason: "NO_PREVIEW", detail: null };
      if (req.manifestSha256 !== p.manifestSha256) return { status: "refused", reason: "PREVIEW_MISMATCH", detail: null };
      if (!p.complete && !req.acceptMissingAssets) return { status: "refused", reason: "MISSING_NOT_ACCEPTED", detail: null };
      try {
        const staged = stageRestore({
          userDataDir: deps.userDataDir,
          packageDir: p.dir,
          // Built from what THIS module showed, never from anything the renderer sent.
          consent: { manifestSha256: p.manifestSha256, acceptedMissingAssets: p.complete ? [] : p.missingAssets },
          now: deps.now(),
          migrations,
          ...fsOpt,
        });
        previewed = null;
        // 🔴 LOCK FIRST, restart second: from this line nothing may change the data this restore
        // is about to replace, whether or not the restart ever happens.
        deps.lock.engage();
        deps.log.info("restore-staged", { id: staged.id, complete: staged.preview.complete });
        try {
          deps.relaunch();
        } catch (err) {
          // The restore is staged and locked; it runs at the next start however the program is
          // closed. A failed restart is logged, not reported as a failed restore.
          deps.log.error("restore-relaunch-failed", { error: err });
        }
        return { status: "staged" };
      } catch (err) {
        if (err instanceof RestoreError) {
          deps.log.warn("restore-stage-refused", { code: err.code, packageCode: err.packageCode });
          return { status: "refused", ...refusalFor(err) };
        }
        throw err;
      }
    },
  };
}
