/**
 * Local operational log for field support: one JSON line per event in
 * <userData>/logs/alzabt-pos.log, rotated by size (alzabt-pos.1.log … alzabt-pos.<N>.log) so it can
 * never grow without bound. No cloud upload, no telemetry.
 *
 * What is logged: lifecycle events with codes, counts, versions and short error messages. What is
 * NOT logged, by construction: field names that look like secrets (PIN, password, token, secret,
 * credential, key) are replaced with "[redacted]" at any depth, and callers never pass catalog rows,
 * sale lines or payment details.
 *
 * Never throws: logging must never break the till.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const LOG_FILE_NAME = "alzabt-pos.log";
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_MAX_FILES = 5;

const SECRET_KEY = /pin|password|passwd|token|secret|credential|^key$|apikey|api_key/i;

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  readonly file: string | null;
}

export interface FileLoggerOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly now?: () => Date;
}

/** Renames alzabt-pos.log → .1 → .2 … dropping the oldest when the current file is too big. */
function rotate(dir: string, maxFiles: number): void {
  const name = (i: number) => join(dir, i === 0 ? LOG_FILE_NAME : LOG_FILE_NAME.replace(/\.log$/, `.${i}.log`));
  rmSync(name(maxFiles - 1), { force: true });
  for (let i = maxFiles - 2; i >= 0; i--) {
    if (existsSync(name(i))) renameSync(name(i), name(i + 1));
  }
}

export function createFileLogger(dir: string, options: FileLoggerOptions = {}): Logger {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const maxFiles = Math.max(2, options.maxFiles ?? LOG_MAX_FILES);
  const now = options.now ?? (() => new Date());
  const file = join(dir, LOG_FILE_NAME);

  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(file) && statSync(file).size >= maxBytes) rotate(dir, maxFiles);
      const line = JSON.stringify({ t: now().toISOString(), level, event, pid: process.pid, ...(redact(fields) as LogFields) });
      appendFileSync(file, line + "\n", "utf8");
    } catch {
      // never let logging affect the till
    }
  };
  return {
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
    file,
  };
}

/** Used until the profile folder is known, and in tests. */
export const nullLogger: Logger = { info() {}, warn() {}, error() {}, file: null };
