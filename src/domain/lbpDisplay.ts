/**
 * M5 — Lebanese-lira DISPLAY (owner decision 2026-11-25; OD-CUR-01..03).
 *
 * 🔴 DISPLAY ONLY. USD stays the accounting and persisted currency. Nothing here is ever stored as money,
 * sent in a payload, printed, or used to settle anything: it turns a USD amount the screen already shows
 * into an INDICATIVE «≈ … ل.ل.» figure at the owner's rate. The owner's words: «بس سكريبت يضرب سعر
 * بالدولار بال rate تبع التحويل … حطلي هيدا الrate بالsetting يكون قابل للتعديل».
 *
 * EXACT ARITHMETIC, NO FLOATING POINT. Amounts are integer minor units (`money.ts`: USD and LBP both have
 * exponent 2). The rate is held as an integer number of hundredths of a pound per dollar. So
 *   LBP minor = USD minor × rate          (cents × LBP/USD = hundredths of a pound)
 *             = USD minor × rateHundredths / 100
 * and the single division by 100 is rounded ROUND_HALF_UP (half away from zero), the owner's rule. No
 * rounding to 1,000 is applied.
 */

export type DisplayCurrency = "USD" | "LBP";

export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ["USD", "LBP"];
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = "USD";
/** The rate in force when the owner set the requirement (2026-11-25): 89,000 LBP per USD. */
export const DEFAULT_LBP_RATE = "89000";

/** Bounds keep every product in the `MAX_MINOR` range and refuse an obvious typo (0, or a missing digit group). */
export const MIN_LBP_RATE_HUNDREDTHS = 100n; // 1 LBP per USD
export const MAX_LBP_RATE_HUNDREDTHS = 1_000_000_000n; // 10,000,000 LBP per USD

export function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return value === "USD" || value === "LBP";
}

/**
 * Parses an owner-typed rate: digits, an optional dot and at most two decimals. Thousands separators
 * («89,000» or «89 000») are accepted and removed. Anything else — a sign, an exponent, three decimals,
 * zero, or a value outside the bounds — is refused with null, never guessed.
 */
export function parseLbpRate(text: unknown): bigint | null {
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(/[,\s٬ ]/g, "");
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const hundredths = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  if (hundredths < MIN_LBP_RATE_HUNDREDTHS || hundredths > MAX_LBP_RATE_HUNDREDTHS) return null;
  return hundredths;
}

/** The canonical stored form of a valid rate: no separators, no trailing zero decimals («89000», «89500.5»). */
export function canonicalLbpRate(hundredths: bigint): string {
  const whole = hundredths / 100n;
  const frac = hundredths % 100n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")}`;
}

/** USD minor units -> LBP minor units at `rateHundredths`, ROUND_HALF_UP (half away from zero). */
export function usdMinorToLbpMinor(usdMinor: bigint, rateHundredths: bigint): bigint {
  const product = usdMinor * rateHundredths;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const q = abs / 100n;
  const r = abs % 100n;
  const rounded = r >= 50n ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** «1,780,000.00» — grouped, always two decimals (the owner's precision). Western digits, like every amount. */
export function formatLbpMinor(lbpMinor: bigint): string {
  const negative = lbpMinor < 0n;
  const abs = negative ? -lbpMinor : lbpMinor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * The whole display step for one amount. Returns null — and the screen shows NO equivalent — whenever
 * the input is not a USD amount or the rate is not valid: a missing or corrupt rate never produces a
 * guessed figure (OD-CUR-04).
 */
export function lbpEquivalent(minor: bigint, currency: string, rate: string): string | null {
  if (currency !== "USD") return null;
  const hundredths = parseLbpRate(rate);
  if (hundredths === null) return null;
  return formatLbpMinor(usdMinorToLbpMinor(minor, hundredths));
}
