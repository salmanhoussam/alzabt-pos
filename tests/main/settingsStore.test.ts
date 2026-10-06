import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/i18n";
import { SETTINGS_FILE, SettingsStore, type SettingsFs, parseSettings } from "../../src/main/settingsStore";

/**
 * 🔴 The path is built the same way SettingsStore builds it — with `join`, and with the filename
 * taken from the module rather than retyped. The first version of this file hardcoded
 * "/profile/settings.json", which is only the right string on POSIX: on Windows `join` produces
 * `\profile\settings.json`, the fake file system's Map never matched, and the test failed in
 * Windows CI while passing here. Worse, the corrupt-file case PASSED on Windows for the wrong
 * reason — it expects the defaults, and a file the store cannot find also yields the defaults.
 *
 * `seen` is what stops that from recurring silently: every path the store touches is recorded, so a
 * test can assert the store actually looked where we put the file instead of inferring it from a
 * result that both branches produce.
 */
const PROFILE = join("/", "profile");
const SETTINGS_PATH = join(PROFILE, SETTINGS_FILE);

function fakeFs(initial?: string) {
  const files = new Map<string, string>();
  const seen: string[] = [];
  if (initial !== undefined) files.set(SETTINGS_PATH, initial);
  const fs: SettingsFs = {
    exists: (p) => {
      seen.push(p);
      return files.has(p);
    },
    read: (p) => {
      seen.push(p);
      return files.get(p)!;
    },
    writeAtomic: (p, c) => {
      seen.push(p);
      files.set(p, c);
    },
  };
  return { fs, files, seen };
}

describe("parseSettings", () => {
  it("keeps valid languages", () => {
    expect(parseSettings({ terminalLanguage: "en", receiptLanguage: "ar" })).toEqual({
      terminalLanguage: "en",
      receiptLanguage: "ar",
    });
  });

  it("falls back to the default for anything it does not understand", () => {
    expect(parseSettings({ terminalLanguage: "fr" })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ terminalLanguage: 1, receiptLanguage: [] })).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the two languages independent — one setting could never stand for both", () => {
    expect(parseSettings({ terminalLanguage: "en", receiptLanguage: "ar" }).receiptLanguage).toBe("ar");
  });
});

describe("SettingsStore", () => {
  it("defaults to Arabic on a fresh profile", () => {
    const { fs, seen } = fakeFs();
    expect(new SettingsStore(PROFILE, fs).get()).toEqual({ terminalLanguage: "ar", receiptLanguage: "ar" });
    expect(seen, "the store must have looked for the file at the platform's own path").toContain(SETTINGS_PATH);
  });

  it("persists a language choice and reads it back on the next start", () => {
    const { fs, files } = fakeFs();
    new SettingsStore(PROFILE, fs).setTerminalLanguage("en");
    expect(files.get(SETTINGS_PATH)).toContain('"terminalLanguage": "en"');
    expect(new SettingsStore(PROFILE, fs).get().terminalLanguage).toBe("en");
  });

  it("a corrupt settings file never stops the till — it opens on the defaults", () => {
    const { fs, seen } = fakeFs("{ this is not json");
    expect(new SettingsStore(PROFILE, fs).get()).toEqual(DEFAULT_SETTINGS);
    // Without this line the test passes even when the store never found the file at all.
    expect(seen.filter((p) => p === SETTINGS_PATH).length, "the corrupt file must actually have been read").toBeGreaterThanOrEqual(2);
  });

  it("a failed write still changes the language for this session", () => {
    const fs: SettingsFs = {
      exists: () => false,
      read: () => "",
      writeAtomic: () => {
        throw new Error("EACCES");
      },
    };
    const store = new SettingsStore(PROFILE, fs);
    expect(store.setTerminalLanguage("en").terminalLanguage).toBe("en");
    expect(store.get().terminalLanguage).toBe("en");
  });
});
