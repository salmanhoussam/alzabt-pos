/**
 * The invoice's amount in words.
 *
 * 🔴 The anchor case is a REAL sentence from a real hand-written invoice this feature replaces:
 * a total of 474.40 USD is written "فقط أربعمئة وأربعة وسبعون دولاراً وأربعون سنتاً لا غير".
 * If this file ever stops producing that string, the generated invoice no longer matches the
 * document the merchant has been issuing by hand — which is the whole point of the field.
 *
 * (The amount is the only thing taken from that invoice. No merchant name, product or price from it
 * appears in this repository.)
 */
import { describe, expect, it } from "vitest";
import { amountInWordsAr, wholeNumberInWords } from "../../src/domain/amountInWords";
import { DomainError } from "../../src/domain/errors";
import { money } from "../../src/domain/money";

const usd = (minor: bigint) => money(minor, "USD");
const words = (minor: bigint) => amountInWordsAr(usd(minor));

describe("🔴 the real invoice's own sentence", () => {
  it("474.40 USD is spelled exactly as the hand-written invoice spells it", () => {
    expect(words(47440n)).toBe("فقط أربعمئة وأربعة وسبعون دولاراً وأربعون سنتاً لا غير");
  });
});

describe("whole numbers", () => {
  it("0 to 10", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => wholeNumberInWords(BigInt(n)))).toEqual([
      "صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
    ]);
  });

  it("the irregular teens", () => {
    expect(wholeNumberInWords(11n)).toBe("أحد عشر");
    expect(wholeNumberInWords(12n)).toBe("اثنا عشر");
    expect(wholeNumberInWords(13n)).toBe("ثلاثة عشر");
    expect(wholeNumberInWords(19n)).toBe("تسعة عشر");
  });

  it("the unit comes BEFORE the ten, which is how Arabic says it", () => {
    expect(wholeNumberInWords(21n)).toBe("واحد وعشرون");
    expect(wholeNumberInWords(74n)).toBe("أربعة وسبعون");
    expect(wholeNumberInWords(99n)).toBe("تسعة وتسعون");
    expect(wholeNumberInWords(20n)).toBe("عشرون");
    expect(wholeNumberInWords(90n)).toBe("تسعون");
  });

  it("hundreds, including the two irregular ones", () => {
    expect(wholeNumberInWords(100n)).toBe("مئة");
    expect(wholeNumberInWords(200n)).toBe("مئتان");
    expect(wholeNumberInWords(300n)).toBe("ثلاثمئة");
    expect(wholeNumberInWords(474n)).toBe("أربعمئة وأربعة وسبعون");
    expect(wholeNumberInWords(900n)).toBe("تسعمئة");
    expect(wholeNumberInWords(999n)).toBe("تسعمئة وتسعة وتسعون");
  });

  it("thousands — 'ألف' and 'ألفان' stand alone, three upward take a count", () => {
    expect(wholeNumberInWords(1000n)).toBe("ألف");
    expect(wholeNumberInWords(2000n)).toBe("ألفان");
    expect(wholeNumberInWords(3000n)).toBe("ثلاثة آلاف");
    expect(wholeNumberInWords(10000n)).toBe("عشرة آلاف");
    expect(wholeNumberInWords(11000n)).toBe("أحد عشر ألفاً");
    expect(wholeNumberInWords(100000n)).toBe("مئة ألف");
    expect(wholeNumberInWords(1500n)).toBe("ألف وخمسمئة");
  });

  it("millions and above", () => {
    expect(wholeNumberInWords(1000000n)).toBe("مليون");
    expect(wholeNumberInWords(2000000n)).toBe("مليونان");
    expect(wholeNumberInWords(5000000n)).toBe("خمسة ملايين");
    expect(wholeNumberInWords(1000000000n)).toBe("مليار");
  });

  it("a zero group contributes nothing — no 'صفر' in the middle of a number", () => {
    expect(wholeNumberInWords(1000001n)).toBe("مليون وواحد");
    expect(wholeNumberInWords(1000100n)).toBe("مليون ومئة");
    expect(wholeNumberInWords(2000074n)).toBe("مليونان وأربعة وسبعون");
  });
});

describe("the counted noun follows the last two digits", () => {
  it("1 and 2 are said the Arabic way, not as 'واحد دولار'", () => {
    expect(words(100n)).toBe("فقط دولار واحد لا غير");
    expect(words(200n)).toBe("فقط دولاران لا غير");
  });

  it("3 to 10 take the plural", () => {
    expect(words(300n)).toBe("فقط ثلاثة دولارات لا غير");
    expect(words(1000n)).toBe("فقط عشرة دولارات لا غير");
  });

  it("11 to 99 take the singular accusative", () => {
    expect(words(1100n)).toBe("فقط أحد عشر دولاراً لا غير");
    expect(words(7400n)).toBe("فقط أربعة وسبعون دولاراً لا غير");
    expect(words(9900n)).toBe("فقط تسعة وتسعون دولاراً لا غير");
  });

  it("a round hundred takes the singular", () => {
    expect(words(10000n)).toBe("فقط مئة دولار لا غير");
    expect(words(100000n)).toBe("فقط ألف دولار لا غير");
  });

  it("the rule reads the LAST TWO digits, not the magnitude", () => {
    // 101 ends in 01 -> singular; 102 ends in 02 -> dual; 103 -> plural
    expect(words(10100n)).toBe("فقط مئة وواحد دولار لا غير");
    expect(words(10200n)).toBe("فقط مئة واثنان دولاران لا غير");
    expect(words(10300n)).toBe("فقط مئة وثلاثة دولارات لا غير");
  });
});

describe("the minor part", () => {
  it("is omitted entirely when it is zero, as a hand-written invoice does", () => {
    expect(words(500n)).toBe("فقط خمسة دولارات لا غير");
    expect(words(500n)).not.toContain("سنت");
  });

  it("is joined with و and takes its own noun form", () => {
    expect(words(501n)).toBe("فقط خمسة دولارات وسنت واحد لا غير");
    expect(words(502n)).toBe("فقط خمسة دولارات وسنتان لا غير");
    expect(words(505n)).toBe("فقط خمسة دولارات وخمسة سنتات لا غير");
    expect(words(525n)).toBe("فقط خمسة دولارات وخمسة وعشرون سنتاً لا غير");
    expect(words(550n)).toBe("فقط خمسة دولارات وخمسون سنتاً لا غير");
  });

  it("a total under one dollar still reads correctly", () => {
    expect(words(5n)).toBe("فقط صفر دولار وخمسة سنتات لا غير");
    expect(words(99n)).toBe("فقط صفر دولار وتسعة وتسعون سنتاً لا غير");
  });

  it("zero", () => {
    expect(words(0n)).toBe("فقط صفر دولار لا غير");
  });
});

describe("it is deterministic and refuses what it cannot spell", () => {
  it("the same amount always produces the identical string", () => {
    const once = words(47440n);
    for (let i = 0; i < 50; i++) expect(words(47440n)).toBe(once);
  });

  it("digits never leak into the words — the whole point of the field", () => {
    for (const minor of [1n, 47440n, 999999n, 123456789n]) {
      expect(words(minor), String(minor)).not.toMatch(/[0-9٠-٩]/);
    }
  });

  it("every sentence is bracketed by فقط … لا غير", () => {
    for (const minor of [0n, 1n, 100n, 47440n, 123456789n]) {
      const s = words(minor);
      expect(s.startsWith("فقط ")).toBe(true);
      expect(s.endsWith(" لا غير")).toBe(true);
    }
  });

  it("a currency this build has not been taught is REFUSED, not guessed", () => {
    expect(() => amountInWordsAr(money(100n, "JOD"))).toThrow(DomainError);
    expect(() => amountInWordsAr(money(100n, "SAR"))).toThrow(/cannot spell/);
  });

  it("LBP is spelled with its own nouns", () => {
    expect(amountInWordsAr(money(300000n, "LBP"))).toBe("فقط ثلاثة آلاف ليرة لا غير");
  });

  it("a negative amount is refused", () => {
    expect(() => wholeNumberInWords(-1n)).toThrow(/negative/);
  });
});
