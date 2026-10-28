/**
 * The restore engine's place in startup, as functions main.ts calls — so the decision is unit-tested
 * rather than reachable only through a packaged application (main.ts exports nothing).
 *
 * 🔴 ORDER IS THE WHOLE CONTRACT. `runPendingRestore` is called first thing in `startTill`: before
 * `planLedgerOpen`, before `openDatabase`, before any repository, and before the phone bridge has a
 * service to call. At that moment this process holds no SQLite connection at all, which is the only
 * moment a ledger file may be replaced. A `halted` outcome is THROWN, so it reaches `failStartup`
 * like any other refusal to open the ledger: a native message, a log line, and no window.
 */
import type { BackupFs } from "../persistence/backupPackage";
import { type ApplyOutcome, applyPendingRestore } from "../persistence/restoreEngine";
import { type Language, translate } from "../shared/i18n";
import type { Logger } from "./logger";

/** A restore could neither be finished nor undone. The till must not open. */
export class RestoreHaltedError extends Error {
  constructor(readonly reason: string) {
    super(`A backup restore could not be finished or undone: ${reason}`);
    this.name = "RestoreHaltedError";
  }
}

/**
 * Applies a pending restore, if any. Returns the outcome for every case the till may open on, and
 * throws RestoreHaltedError for the one it may not.
 */
export function runPendingRestore(opts: {
  readonly userDataDir: string;
  readonly now: Date;
  readonly log: Logger;
  readonly fs?: BackupFs;
}): ApplyOutcome {
  const outcome = applyPendingRestore({ userDataDir: opts.userDataDir, now: opts.now, ...(opts.fs ? { fs: opts.fs } : {}) });
  if (outcome.kind === "none") return outcome;
  if (outcome.kind === "halted") {
    opts.log.error("restore-halted", { id: outcome.id, reason: outcome.reason });
    throw new RestoreHaltedError(outcome.reason);
  }
  if (outcome.kind === "restored") {
    opts.log.info("restore-applied", {
      id: outcome.id,
      complete: outcome.complete,
      missingAssets: outcome.missingAssets.length,
      // The relative folder, so support can find the kept copy without a path in the UI.
      preRestore: `restore/pre-restore-${outcome.id}`,
    });
  } else {
    opts.log.warn(`restore-${outcome.kind}`, { id: outcome.id, reason: outcome.reason });
  }
  return outcome;
}

/**
 * What the owner is told once the till opens after a restore ran. Null when nothing ran.
 *
 * 🔴 EACH OUTCOME HAS ITS OWN SENTENCE. "Restored", "undone" and "not started" are three different
 * facts about the shop's money, and a shared "restore finished" would hide which one happened.
 */
export function restoreNoticeFor(outcome: ApplyOutcome, lang: Language): { readonly title: string; readonly body: string } | null {
  const t = (key: string) => translate(lang, key);
  switch (outcome.kind) {
    case "none":
    case "halted":
      return null;
    case "restored":
      return {
        title: t("restore.notice.restoredTitle"),
        body: [t("restore.notice.restored"), outcome.complete ? null : t("restore.notice.restoredIncomplete"), t("restore.notice.keptCopy")]
          .filter((line): line is string => line !== null)
          .join("\n\n"),
      };
    case "rolled-back":
      return { title: t("restore.notice.notRestoredTitle"), body: t("restore.notice.rolledBack") };
    case "aborted":
      return { title: t("restore.notice.notRestoredTitle"), body: t("restore.notice.aborted") };
  }
}
