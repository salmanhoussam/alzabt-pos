import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/i18n";
import { SettingsStore, type SettingsFs, parseSettings } from "../../src/main/settingsStore";

function fakeFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("/profile/settings.json", initial);
  const fs: SettingsFs = {
    exists: (p) => files.has(p),
    read: (p) => files.get(p)!,
    writeAtomic: (p, c) => void files.set(p, c),
  };
  return { fs, files };
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
    const { fs } = fakeFs();
    expect(new SettingsStore("/profile", fs).get()).toEqual({ terminalLanguage: "ar", receiptLanguage: "ar" });
  });

  it("persists a language choice and reads it back on the next start", () => {
    const { fs, files } = fakeFs();
    new SettingsStore("/profile", fs).setTerminalLanguage("en");
    expect(files.get("/profile/settings.json")).toContain('"terminalLanguage": "en"');
    expect(new SettingsStore("/profile", fs).get().terminalLanguage).toBe("en");
  });

  it("a corrupt settings file never stops the till — it opens on the defaults", () => {
    const { fs } = fakeFs("{ this is not json");
    expect(new SettingsStore("/profile", fs).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("a failed write still changes the language for this session", () => {
    const fs: SettingsFs = {
      exists: () => false,
      read: () => "",
      writeAtomic: () => {
        throw new Error("EACCES");
      },
    };
    const store = new SettingsStore("/profile", fs);
    expect(store.setTerminalLanguage("en").terminalLanguage).toBe("en");
    expect(store.get().terminalLanguage).toBe("en");
  });
});
