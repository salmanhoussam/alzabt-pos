/**
 * The i18n / RTL foundation — the React half. The shared half (languages, the dictionaries, the
 * direction rule) is `src/shared/i18n.ts`, so a test or the main process can translate without React.
 *
 * What this provides, and why each piece exists:
 *   useT()          t("key") in any component, with no prop threading
 *   dir / lang      set on <html>, so the WHOLE tree flips and `:dir()`-free CSS logical
 *                   properties (inline-start/inline-end) do the layout work automatically
 *   setLanguage()   persists through the main process (settings.json), so the choice survives a
 *                   restart — a till that forgets its language every morning is not bilingual
 *
 * The language loads asynchronously; until it arrives the tree renders in the default (Arabic)
 * rather than blocking, because a blank screen on a till is worse than one re-render.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type Language, dirFor, translate, unitLabel } from "../shared/i18n";
import { call, pos } from "./api";

interface I18nValue {
  readonly lang: Language;
  readonly dir: "rtl" | "ltr";
  readonly t: (key: string) => string;
  readonly unit: (baseUnit: string) => string;
  readonly setLanguage: (lang: Language) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>("ar");

  useEffect(() => {
    let cancelled = false;
    call(pos().getSettings())
      .then((s) => {
        if (!cancelled) setLang(s.terminalLanguage);
      })
      // No settings channel (an older build, or a test harness): the default stands.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The document element carries both, so native form controls, scrollbars and text selection all
  // follow the language — not only the elements we styled.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
  }, [lang]);

  const setLanguage = useCallback((next: Language) => {
    // Optimistic: the operator sees the switch immediately; persistence is best-effort and a
    // failure to write settings.json must not undo a language they just chose.
    setLang(next);
    call(pos().setTerminalLanguage({ language: next })).catch(() => undefined);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      dir: dirFor(lang),
      t: (key) => translate(lang, key),
      unit: (baseUnit) => unitLabel(lang, baseUnit),
      setLanguage,
    }),
    [lang, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useT must be used inside <I18nProvider>");
  return value;
}
