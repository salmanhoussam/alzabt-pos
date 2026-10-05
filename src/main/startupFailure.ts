/**
 * Startup failure: what went wrong opening the ledger, and what the merchant is told.
 *
 * Pure (no Electron import) so every message is unit-tested. main.ts shows the result in a native
 * error box and exits; the till never opens on a ledger it could not open correctly, and never
 * replaces it with a new empty one.
 *
 * The message deliberately contains no stack trace and no file path — only a short code that support
 * can match against the local log (<userData>/logs/alzabt-pos.log), plus the version and build.
 */
import { BackupError } from "../persistence/backup";
import { MigrationMismatchError, SchemaNewerThanAppError } from "../persistence/db";
import { LedgerMissingError } from "./ledgerGuard";

export type StartupFailureCode =
  | "DB_NEWER_THAN_APP"
  | "DB_MIGRATION_MISMATCH"
  | "DB_CORRUPT"
  | "DB_UNAVAILABLE"
  | "LEDGER_MISSING"
  | "BACKUP_FAILED"
  | "STARTUP_FAILED";

const SQLITE_CORRUPT = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);
const UNAVAILABLE = new Set(["SQLITE_CANTOPEN", "SQLITE_READONLY", "SQLITE_BUSY", "SQLITE_IOERR", "SQLITE_FULL", "EACCES", "EPERM", "EBUSY", "ENOSPC", "EROFS"]);

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

export function classifyStartupError(err: unknown): StartupFailureCode {
  if (err instanceof SchemaNewerThanAppError) return "DB_NEWER_THAN_APP";
  if (err instanceof MigrationMismatchError) return "DB_MIGRATION_MISMATCH";
  if (err instanceof LedgerMissingError) return "LEDGER_MISSING";
  if (err instanceof BackupError) return "BACKUP_FAILED";
  const code = codeOf(err);
  if (SQLITE_CORRUPT.has(code) || code.startsWith("SQLITE_CORRUPT")) return "DB_CORRUPT";
  if (UNAVAILABLE.has(code) || code.startsWith("SQLITE_IOERR") || code.startsWith("SQLITE_CANTOPEN")) return "DB_UNAVAILABLE";
  return "STARTUP_FAILED";
}

const DETAIL: Record<StartupFailureCode, { en: string; ar: string }> = {
  DB_NEWER_THAN_APP: {
    en: "The database was created by a newer version of Alzabt POS. Install that version again.",
    ar: "قاعدة البيانات أُنشئت بنسخة أحدث من Alzabt POS. ثبّت تلك النسخة من جديد.",
  },
  DB_MIGRATION_MISMATCH: {
    en: "The database does not match this version of Alzabt POS.",
    ar: "قاعدة البيانات لا تطابق هذه النسخة من Alzabt POS.",
  },
  DB_CORRUPT: {
    en: "The database file appears to be damaged. A backup can be restored by support.",
    ar: "يبدو أن ملف قاعدة البيانات تالف. يمكن للدعم استرجاع نسخة احتياطية.",
  },
  DB_UNAVAILABLE: {
    en: "The database file could not be opened (it may be in use, read-only, or the disk is full).",
    ar: "تعذّر فتح ملف قاعدة البيانات (قد يكون مستخدماً أو للقراءة فقط، أو أن القرص ممتلئ).",
  },
  LEDGER_MISSING: {
    en: "The sales database is missing from its folder. A new empty one was NOT created.",
    ar: "ملف قاعدة بيانات المبيعات غير موجود في مكانه. لم يتم إنشاء ملف جديد فارغ.",
  },
  BACKUP_FAILED: {
    en: "A safety backup could not be made before updating the database, so the update was not applied.",
    ar: "تعذّر إنشاء نسخة احتياطية قبل تحديث قاعدة البيانات، لذلك لم يُطبَّق التحديث.",
  },
  STARTUP_FAILED: {
    en: "An unexpected error occurred while starting.",
    ar: "حدث خطأ غير متوقع أثناء التشغيل.",
  },
};

export interface StartupFailureMessage {
  readonly title: string;
  readonly body: string;
}

export function startupFailureMessage(code: StartupFailureCode, buildLabel: string): StartupFailureMessage {
  const d = DETAIL[code];
  return {
    title: "Alzabt POS — cannot start",
    body: [
      "Alzabt POS could not open its local database.",
      "Your sales data was not modified.",
      d.en,
      "Please contact support.",
      "",
      "تعذّر على Alzabt POS فتح قاعدة البيانات المحلية.",
      "لم يتم تعديل بيانات المبيعات.",
      d.ar,
      "يرجى التواصل مع الدعم.",
      "",
      `Code: ${code}`,
      buildLabel,
    ].join("\n"),
  };
}
