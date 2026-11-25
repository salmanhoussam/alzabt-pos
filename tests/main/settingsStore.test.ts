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
    // TRANSITION (M5, 2026-11-25): the settings shape gained displayCurrency + lbpRate; absent keys take their
    // defaults (USD, 89000). Old shape: the two languages only.
    expect(parseSettings({ terminalLanguage: "en", receiptLanguage: "ar" })).toEqual({
      terminalLanguage: "en",
      receiptLanguage: "ar",
      displayCurrency: "USD",
      lbpRate: "89000",
      // TRANSITION (F8, owner 2026-11-25): a file that never recorded an owner-confirmed rate reads unconfirmed.
      lbpRateConfirmed: false,
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
    // TRANSITION (M5): a fresh profile also shows USD only, at the default rate. Old shape: languages only.
    // TRANSITION (F8, owner 2026-11-25): + lbpRateConfirmed false — the preset is not a confirmed rate.
    expect(new SettingsStore(PROFILE, fs).get()).toEqual({ terminalLanguage: "ar", receiptLanguage: "ar", displayCurrency: "USD", lbpRate: "89000", lbpRateConfirmed: false });
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

describe("M5 — LBP display settings (display only)", () => {
  it("a new profile has no saved preference: USD, at the owner's default rate 89000", () => {
    const { fs } = fakeFs();
    const got = new SettingsStore(PROFILE, fs).get();
    expect(got.displayCurrency).toBe("USD");
    expect(got.lbpRate).toBe("89000");
  });

  it("remembers the display choice and the rate across a restart (a new store reads the file)", () => {
    const { fs, files } = fakeFs();
    const first = new SettingsStore(PROFILE, fs);
    // TRANSITION (F8, owner 2026-11-25): LBP display needs a CONFIRMED rate, so the rate is saved first. Old order:
    // setDisplayCurrency("LBP") then setLbpRate — the first call is now refused (asserted here, not dropped).
    expect(() => first.setDisplayCurrency("LBP")).toThrow(expect.objectContaining({ code: "LBP_RATE_UNCONFIRMED" }));
    first.setLbpRate(8_950_050n); // 89,500.50 LBP per USD
    first.setDisplayCurrency("LBP");
    expect(files.has(SETTINGS_PATH)).toBe(true);
    const restarted = new SettingsStore(PROFILE, fs).get();
    expect(restarted.displayCurrency).toBe("LBP");
    expect(restarted.lbpRate).toBe("89500.5");
    // The languages are untouched by the M5 setters.
    expect(restarted.terminalLanguage).toBe("ar");
  });

  it("a corrupt or out-of-range rate in the file falls back to the default, never to a guess", () => {
    for (const bad of ["0", "-1", "1e5", "89500.001", "", "abc", "99999999999", 89000]) {
      const { fs } = fakeFs(JSON.stringify({ terminalLanguage: "ar", receiptLanguage: "ar", displayCurrency: "LBP", lbpRate: bad }));
      expect(new SettingsStore(PROFILE, fs).get().lbpRate, String(bad)).toBe("89000");
    }
  });

  it("an unknown display currency falls back to USD", () => {
    const { fs } = fakeFs(JSON.stringify({ displayCurrency: "EUR" }));
    expect(new SettingsStore(PROFILE, fs).get().displayCurrency).toBe("USD");
  });

  it("a separator-typed rate stored by an older write is read back canonical", () => {
    const { fs } = fakeFs(JSON.stringify({ lbpRate: "89,000" }));
    expect(new SettingsStore(PROFILE, fs).get().lbpRate).toBe("89000");
  });
});

describe("F7 / F8 — a rate is confirmed only once it is ON DISK, and a failed write is never «saved»", () => {
  function failingFs() {
    const base = fakeFs();
    let fail = false;
    const fs: SettingsFs = {
      ...base.fs,
      writeAtomic: (p, c) => {
        if (fail) throw new Error("disk full");
        base.fs.writeAtomic(p, c);
      },
    };
    return { fs, files: base.files, failNext: () => (fail = true) };
  }

  it("a failed RATE write throws SETTINGS_NOT_SAVED and leaves the rate in force unchanged", () => {
    const f = failingFs();
    const store = new SettingsStore(PROFILE, f.fs);
    f.failNext();
    expect(() => store.setLbpRate(9_000_000n)).toThrow(expect.objectContaining({ code: "SETTINGS_NOT_SAVED" }));
    expect(store.get()).toMatchObject({ lbpRate: "89000", lbpRateConfirmed: false });
    expect(f.files.has(SETTINGS_PATH)).toBe(false);
  });

  it("a failed DISPLAY write throws SETTINGS_NOT_SAVED and the display stays what it was", () => {
    const f = failingFs();
    const store = new SettingsStore(PROFILE, f.fs);
    store.setLbpRate(8_900_000n);
    f.failNext();
    expect(() => store.setDisplayCurrency("LBP")).toThrow(expect.objectContaining({ code: "SETTINGS_NOT_SAVED" }));
    expect(store.get().displayCurrency).toBe("USD");
  });

  it("saving the rate confirms it, and the confirmation survives a restart", () => {
    const { fs } = fakeFs();
    new SettingsStore(PROFILE, fs).setLbpRate(8_900_000n);
    expect(new SettingsStore(PROFILE, fs).get()).toMatchObject({ lbpRate: "89000", lbpRateConfirmed: true });
  });

  it("missing, corrupt, or a «confirmed» flag beside an invalid rate → UNCONFIRMED preset, and LBP stays off", () => {
    for (const content of [undefined, "{not json", JSON.stringify({ lbpRate: "abc", lbpRateConfirmed: true }), JSON.stringify({ lbpRate: "89000" })]) {
      const store = new SettingsStore(PROFILE, fakeFs(content).fs);
      expect(store.get()).toMatchObject({ lbpRate: "89000", lbpRateConfirmed: false });
      expect(() => store.setDisplayCurrency("LBP")).toThrow(expect.objectContaining({ code: "LBP_RATE_UNCONFIRMED" }));
    }
  });

  it("USD is always allowed, confirmed or not", () => {
    const store = new SettingsStore(PROFILE, fakeFs().fs);
    expect(store.setDisplayCurrency("USD").displayCurrency).toBe("USD");
  });
});
