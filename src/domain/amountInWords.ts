/**
 * The invoice's amount in words, in Arabic — "فقط أربعمئة وأربعة وسبعون دولاراً وأربعون سنتاً لا غير".
 *
 * WHY THIS EXISTS AT ALL: a hand-written invoice carries the amount twice, in digits and in words,
 * because the words are what cannot be altered with a pen stroke. The paper invoice this feature
 * replaces prints it in two places. So it is not decoration; it is the document's own check digit.
 *
 * 🔴 DETERMINISTIC, AND NO FLOAT ANYWHERE. The input is `Money` — an exact integer of minor units —
 * and every step below is integer arithmetic on `bigint`. A number that reached here through a
 * float would already have lost the cent this sentence exists to protect.
 *
 * The output is SNAPSHOTTED on the finalized invoice rather than recomputed at print time, so a
 * later correction to this file can never change what an issued invoice says.
 */
import { DomainError } from "./errors";
import type { Money } from "./money";

/** 0-10, then the irregular teens are built from these. */
const ONES = [
  "صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
] as const;

const TENS: Readonly<Record<number, string>> = Object.freeze({
  20: "عشرون", 30: "ثلاثون", 40: "أربعون", 50: "خمسون",
  60: "ستون", 70: "سبعون", 80: "ثمانون", 90: "تسعون",
});

const HUNDREDS: Readonly<Record<number, string>> = Object.freeze({
  1: "مئة", 2: "مئتان", 3: "ثلاثمئة", 4: "أربعمئة", 5: "خمسمئة",
  6: "ستمئة", 7: "سبعمئة", 8: "ثمانمئة", 9: "تسعمئة",
});

/**
 * One counted noun in the four forms Arabic needs. Which form applies is decided by the LAST TWO
 * DIGITS of the count, which is the rule this file implements and tests:
 *
 *   …01        singular              مئة وواحد دولار
 *   …02        dual                  دولاران
 *   …03-…10    plural                ثلاثة دولارات
 *   …11-…99    singular accusative   أربعة وسبعون دولاراً      ← the real invoice's case
 *   …00        singular              مئة دولار · ألف دولار
 */
interface CountedNoun {
  readonly singular: string;
  readonly dual: string;
  readonly plural: string;
  readonly accusative: string;
}

/** The scale words, in the same four forms. */
const SCALES: ReadonlyArray<CountedNoun> = Object.freeze([
  { singular: "", dual: "", plural: "", accusative: "" }, // units
  { singular: "ألف", dual: "ألفان", plural: "آلاف", accusative: "ألفاً" },
  { singular: "مليون", dual: "مليونان", plural: "ملايين", accusative: "مليوناً" },
  { singular: "مليار", dual: "ملياران", plural: "مليارات", accusative: "ملياراً" },
  { singular: "تريليون", dual: "تريليونان", plural: "تريليونات", accusative: "تريليوناً" },
]);

/**
 * Currencies this build can spell. Deliberately a closed table: a currency that is not here throws
 * rather than being spelled in a language nobody checked.
 */
const CURRENCIES: Readonly<Record<string, { readonly major: CountedNoun; readonly minor: CountedNoun }>> =
  Object.freeze({
    USD: {
      major: { singular: "دولار", dual: "دولاران", plural: "دولارات", accusative: "دولاراً" },
      minor: { singular: "سنت", dual: "سنتان", plural: "سنتات", accusative: "سنتاً" },
    },
    LBP: {
      major: { singular: "ليرة", dual: "ليرتان", plural: "ليرات", accusative: "ليرةً" },
      minor: { singular: "قرش", dual: "قرشان", plural: "قروش", accusative: "قرشاً" },
    },
    EUR: {
      major: { singular: "يورو", dual: "يوروان", plural: "يوروهات", accusative: "يورو" },
      minor: { singular: "سنت", dual: "سنتان", plural: "سنتات", accusative: "سنتاً" },
    },
  });

/** 1..999 in words. Returns "" for 0, because a zero group contributes nothing to the sentence. */
function underThousand(n: number): string {
  if (n === 0) return "";
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(HUNDREDS[hundreds]!);
  if (rest > 0) {
    if (rest <= 10) parts.push(ONES[rest]!);
    else if (rest === 11) parts.push("أحد عشر");
    else if (rest === 12) parts.push("اثنا عشر");
    else if (rest < 20) parts.push(`${ONES[rest - 10]!} عشر`);
    else if (rest % 10 === 0) parts.push(TENS[rest]!);
    // 21..99: the unit comes FIRST, joined to the ten — "أربعة وسبعون", not "سبعون وأربعة".
    else parts.push(`${ONES[rest % 10]!} و${TENS[rest - (rest % 10)]!}`);
  }
  return parts.join(" و");
}

/** The form of a counted noun for a given count, by the last-two-digits rule documented above. */
function nounFor(count: bigint, noun: CountedNoun): string {
  const r = Number(count % 100n);
  if (r === 1) return noun.singular;
  if (r === 2) return noun.dual;
  if (r >= 3 && r <= 10) return noun.plural;
  if (r >= 11 && r <= 99) return noun.accusative;
  return noun.singular; // r === 0
}

/**
 * A whole non-negative number in words — no counted noun attached.
 *
 * For 1 and 2 the number word is omitted at the top level by the caller, because Arabic says
 * "دولار واحد" and "دولاران" rather than "واحد دولار" / "اثنان دولاران".
 */
export function wholeNumberInWords(value: bigint): string {
  if (value < 0n) throw new DomainError("INVALID_AMOUNT", "An amount in words must not be negative");
  if (value === 0n) return ONES[0]!;

  // Split into 3-digit groups, least significant first.
  const groups: number[] = [];
  let rest = value;
  while (rest > 0n) {
    groups.push(Number(rest % 1000n));
    rest /= 1000n;
  }
  if (groups.length > SCALES.length) {
    throw new DomainError("INVALID_AMOUNT", "This amount is larger than the invoice can spell");
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    if (group === 0) continue;
    if (i === 0) {
      parts.push(underThousand(group));
      continue;
    }
    const scale = SCALES[i]!;
    // "ألف" and "ألفان" stand alone; from three upward the count precedes the scale word.
    if (group === 1) parts.push(scale.singular);
    else if (group === 2) parts.push(scale.dual);
    else parts.push(`${underThousand(group)} ${nounFor(BigInt(group), scale)}`);
  }
  return parts.join(" و");
}

/** A count plus its counted noun, with 1 and 2 spelled the way Arabic actually says them. */
function countWithNoun(count: bigint, noun: CountedNoun): string {
  if (count === 1n) return `${noun.singular} ${ONES[1]!}`;   // دولار واحد
  if (count === 2n) return noun.dual;                         // دولاران
  return `${wholeNumberInWords(count)} ${nounFor(count, noun)}`;
}

/** ISO-4217 minor units per major unit, for the currencies this file spells. */
const MINOR_PER_MAJOR: Readonly<Record<string, bigint>> = Object.freeze({
  USD: 100n,
  LBP: 100n,
  EUR: 100n,
});

export const AMOUNT_IN_WORDS_PREFIX = "فقط";
export const AMOUNT_IN_WORDS_SUFFIX = "لا غير";

/**
 * The finalized invoice's amount in words.
 *
 *     474.40 USD  ->  "فقط أربعمئة وأربعة وسبعون دولاراً وأربعون سنتاً لا غير"
 *
 * The minor part is omitted entirely when it is zero, exactly as a hand-written invoice does.
 */
export function amountInWordsAr(amount: Money): string {
  const per = MINOR_PER_MAJOR[amount.currency];
  const nouns = CURRENCIES[amount.currency];
  if (!per || !nouns) {
    throw new DomainError("INVALID_AMOUNT", `This build cannot spell ${amount.currency} in Arabic`);
  }
  if (amount.minor < 0n) {
    throw new DomainError("INVALID_AMOUNT", "An invoice total must not be negative");
  }
  const major = amount.minor / per;
  const minor = amount.minor % per;

  const majorWords = countWithNoun(major, nouns.major);
  if (minor === 0n) {
    return `${AMOUNT_IN_WORDS_PREFIX} ${majorWords} ${AMOUNT_IN_WORDS_SUFFIX}`;
  }
  const minorWords = countWithNoun(minor, nouns.minor);
  return `${AMOUNT_IN_WORDS_PREFIX} ${majorWords} و${minorWords} ${AMOUNT_IN_WORDS_SUFFIX}`;
}
