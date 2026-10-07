/**
 * Operator settings, stored as one small JSON file in the per-user profile — NOT in the ledger.
 *
 * WHY NOT A TABLE: a settings table would be a schema migration, and this first offline release is
 * deliberately migration-free. Language is also not ledger data: it must never be able to fail a
 * sale, and losing it costs the operator one tap. The existing `autostart.json` marker already
 * establishes this pattern in the same folder.
 *
 * Written atomically (temp file + rename) like every other write in this app, so a crash mid-write
 * can leave the old file or the new one, never a truncated one. Every failure degrades to the
 * defaults and is reported to the caller; reading a corrupt file is not an error the till stops for.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Language, type TerminalSettings, isLanguage } from "../shared/i18n";

export const SETTINGS_FILE = "settings.json";

export interface SettingsFs {
  exists(path: string): boolean;
  read(path: string): string;
  writeAtomic(path: string, contents: string): void;
}

export const nodeSettingsFs: SettingsFs = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  writeAtomic: (path, contents) => {
    writeFileSync(`${path}.partial`, contents, "utf8");
    renameSync(`${path}.partial`, path);
  },
};

/** Keeps only values this build understands; anything else falls back to the default. */
export function parseSettings(raw: unknown): TerminalSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const r = raw as Record<string, unknown>;
  return {
    terminalLanguage: isLanguage(r.terminalLanguage) ? r.terminalLanguage : DEFAULT_SETTINGS.terminalLanguage,
    receiptLanguage: isLanguage(r.receiptLanguage) ? r.receiptLanguage : DEFAULT_SETTINGS.receiptLanguage,
  };
}

export class SettingsStore {
  private readonly path: string;
  private cached: TerminalSettings;

  constructor(
    userDataDir: string,
    private readonly fs: SettingsFs = nodeSettingsFs,
  ) {
    this.path = join(userDataDir, SETTINGS_FILE);
    this.cached = this.loadFromDisk();
  }

  private loadFromDisk(): TerminalSettings {
    if (!this.fs.exists(this.path)) return DEFAULT_SETTINGS;
    try {
      return parseSettings(JSON.parse(this.fs.read(this.path)));
    } catch {
      // A corrupt or half-written settings file must never stop a till from opening.
      return DEFAULT_SETTINGS;
    }
  }

  get(): TerminalSettings {
    return this.cached;
  }

  /** Persists a new terminal language. Returns the settings now in force, written or not. */
  setTerminalLanguage(lang: Language): TerminalSettings {
    return this.write({ ...this.cached, terminalLanguage: lang });
  }

  setReceiptLanguage(lang: Language): TerminalSettings {
    return this.write({ ...this.cached, receiptLanguage: lang });
  }

  private write(next: TerminalSettings): TerminalSettings {
    this.cached = next;
    try {
      this.fs.writeAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      // In memory for this session; the operator is not interrupted for a settings write.
    }
    return this.cached;
  }
}
