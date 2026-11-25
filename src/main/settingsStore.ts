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
import { type DisplayCurrency, canonicalLbpRate, isDisplayCurrency, parseLbpRate } from "../domain/lbpDisplay";
import { DomainError } from "../domain/errors";

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
    // M5: an unknown display currency falls back to USD; a missing or invalid rate falls back to the default
    // rate in canonical form — never to a guessed number.
    displayCurrency: isDisplayCurrency(r.displayCurrency) ? r.displayCurrency : DEFAULT_SETTINGS.displayCurrency,
    lbpRate: (() => {
      const h = parseLbpRate(r.lbpRate);
      return h === null ? DEFAULT_SETTINGS.lbpRate : canonicalLbpRate(h);
    })(),
    // F8: confirmed only if the file says so AND its rate is valid; anything else is the unconfirmed preset.
    lbpRateConfirmed: r.lbpRateConfirmed === true && parseLbpRate(r.lbpRate) !== null,
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

  /**
   * M5: the remembered display choice (survives a restart). Display only; no money changes.
   * F7/F8 (owner, 2026-11-25): LBP needs a CONFIRMED rate, and the choice is only reported once it is on disk.
   */
  setDisplayCurrency(currency: DisplayCurrency): TerminalSettings {
    if (currency === "LBP" && !this.cached.lbpRateConfirmed) {
      throw new DomainError("LBP_RATE_UNCONFIRMED", "Confirm the LBP rate before showing LBP");
    }
    return this.writeStrict({ ...this.cached, displayCurrency: currency });
  }

  /**
   * M5: the owner's LBP rate. The caller has already validated it; it is stored in canonical form.
   * F7: saving it is what CONFIRMS it, and a failed write is an error — never a success held only in memory.
   */
  setLbpRate(rateHundredths: bigint): TerminalSettings {
    return this.writeStrict({ ...this.cached, lbpRate: canonicalLbpRate(rateHundredths), lbpRateConfirmed: true });
  }

  /** F7: write, and only then adopt. A refused write leaves the settings in force untouched and says so. */
  private writeStrict(next: TerminalSettings): TerminalSettings {
    try {
      this.fs.writeAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      throw new DomainError("SETTINGS_NOT_SAVED", "The setting could not be saved on this computer");
    }
    this.cached = next;
    return this.cached;
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

/**
 * OWNER PREVIEW (ephemeral Demo): a settings "disk" that is only memory. The rate and the display choice behave
 * exactly as on a real terminal during the Demo session (validated, confirmed, refused), and vanish with it.
 */
export function memorySettingsFs(): SettingsFs {
  const files = new Map<string, string>();
  return {
    exists: (path) => files.has(path),
    read: (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error("not found");
      return v;
    },
    writeAtomic: (path, contents) => {
      files.set(path, contents);
    },
  };
}
