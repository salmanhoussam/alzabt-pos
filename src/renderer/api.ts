import { DomainError } from "../domain/errors";
import { DEFAULT_TERMINAL_LANGUAGE, type Language, isLanguage } from "../shared/i18n";
import { arabicRefusal } from "./refusalText";
import type { IpcResult, PosApi } from "../shared/ipcContract";
import { formatDecimal } from "../domain/money";
import { fromMoneyDto } from "../shared/dto";
import type { MoneyDto } from "../shared/ipcContract";

declare global {
  interface Window {
    readonly pos: PosApi;
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Unwraps an IpcResult or throws an ApiError carrying the main process's error code. */
export async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new ApiError(result.error.code, result.error.message);
  return result.data;
}

export const pos = (): PosApi => window.pos;

export function fmt(m: MoneyDto): string {
  return `${formatDecimal(fromMoneyDto(m))} ${m.currency}`;
}

/** 128-bit random idempotency key for one checkout attempt. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The terminal's language, without threading a prop or a hook into 39 call sites.
 *
 * 🔴 `document.documentElement.lang` IS THE TERMINAL LANGUAGE, and it is not a hack: `I18nProvider`
 * sets it on every language change for exactly this purpose ("so the WHOLE tree flips"), so it is
 * already a maintained single source of truth rather than a second copy introduced here. Reading it
 * keeps `errorText`'s signature — and therefore all 39 call sites, several of which live in the
 * just-accepted Products and Sell screens — completely untouched.
 *
 * Before the provider's first effect runs, and in a test with no DOM, it falls back to
 * `DEFAULT_TERMINAL_LANGUAGE`. That is Arabic, which is both the product's default and the
 * provider's own initial state, so the two cannot disagree.
 */
function currentLanguage(): Language {
  const fromDocument = typeof document === "undefined" ? null : document.documentElement.lang;
  return isLanguage(fromDocument) ? fromDocument : DEFAULT_TERMINAL_LANGUAGE;
}

/**
 * The text an operator reads when something is refused.
 *
 * An ApiError carries the main process's own message. A DomainError is one the RENDERER raised
 * itself — `parseQuantity` is the first of these, and it must explain why a typed quantity was
 * refused rather than hide behind "Unexpected error", because the whole point of refusing a
 * fraction on a whole-only unit is that the operator is told instead of being handed a rounded
 * number. Anything else really is unexpected and is never shown verbatim.
 */
export function errorText(err: unknown, lang: Language = currentLanguage()): string {
  // 🔴 THE CODE DECIDES, THE PROSE NEVER DOES. `arabicRefusal` answers only for codes whose meaning
  // is unambiguous across every throw site, and answers `null` for everything else — including
  // every sale and invoice OUTCOME code, whose Arabic is already composed in the main process with
  // the real receipt and invoice numbers. A null means "show what the main process sent", which is
  // the behaviour this function has always had.
  if (err instanceof ApiError) return arabicRefusal(lang, err.code) ?? err.message;
  if (err instanceof DomainError) return arabicRefusal(lang, err.code) ?? err.message;
  return "Unexpected error";
}
