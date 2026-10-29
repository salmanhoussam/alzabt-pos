/**
 * The official ARABIC product name is «عالضبط» — alone (owner decision, 2026-10-25). The English name stays
 * ALZABT POS. «الصندوق» may still name the till/device in running text, never the product.
 *
 * Covers: `app.name`; the two recovery texts that name the product; the four §47 unknown/conflict texts
 * (byte-identical, pinned by SHA-256 of their UTF-8 bytes); the phone-page titles and error wording (source
 * level, comments stripped, interpolation and HTML escaping preserved); and that none of the three rejected
 * spellings survives as a product name in user-facing source.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, translate } from "../../src/shared/i18n";

const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string): string => code(readFileSync(p, "utf8"));
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("the Arabic product name", () => {
  it("app.name is exactly «عالضبط» — not «الضبط», «الزبط» or «صندوق الزبط»", () => {
    expect(translate("ar", "app.name")).toBe("عالضبط");
    // («عالضبط» itself CONTAINS the letters «الضبط», so the exact equality above is what rules that spelling out)
    for (const bad of ["الزبط", "صندوق"]) expect(translate("ar", "app.name")).not.toContain(bad);
    expect(translate("ar", "app.name")).not.toBe("الضبط");
  });
  it("the English name is unchanged, and the brand constant is still not translated", () => {
    expect(BRAND).toBe("Alzabt POS");
    expect(translate("en", "app.name")).not.toBe("عالضبط");
  });
});

describe("the two recovery texts name the product «عالضبط» and keep their meaning", () => {
  it("M17A (collect.pending.not_recorded) AR is exactly the approved text; EN unchanged", () => {
    expect(translate("ar", "collect.pending.not_recorded")).toBe(
      "ما في عملية قبض مسجّلة في برنامج «عالضبط» لهالمحاولة. هيدا ما بيعني بالضرورة إن المبلغ ما وصل. تأكّد من استلام المبلغ فعلياً قبل إعادة محاولة تسجيل القبض.",
    );
    expect(translate("en", "collect.pending.not_recorded")).toBe(
      "No collection was recorded in ALZABT POS for this attempt. This does not confirm whether the money was received. Check the actual payment before retrying the recording.",
    );
  });
  it("M17B-S1 (allocReceipt.pending.not_recorded) AR is exactly the approved text; EN unchanged", () => {
    expect(translate("ar", "allocReceipt.pending.not_recorded")).toBe(
      "ما في دفعة مسجّلة في برنامج «عالضبط» لهالمحاولة. هيدا ما بيعني بالضرورة إن المبلغ ما وصل. تأكّد من استلام المبلغ فعلياً قبل إعادة محاولة تسجيل الدفعة.",
    );
    expect(translate("en", "allocReceipt.pending.not_recorded")).toBe(
      "No payment was recorded in ALZABT POS for this attempt. This does not confirm whether the money was received. Check the actual payment before retrying the recording.",
    );
  });
  it("they still make no claim about the external money and no longer say «في الضبط»", () => {
    for (const k of ["collect.pending.not_recorded", "allocReceipt.pending.not_recorded"]) {
      const ar = translate("ar", k);
      expect(ar).toContain("هيدا ما بيعني بالضرورة إن المبلغ ما وصل");
      expect(ar).toContain("تأكّد من استلام المبلغ فعلياً");
      expect(ar).not.toContain("في الضبط");
      expect(ar).not.toContain("لم يُؤخَذ");
    }
  });
});

describe("the four §47 unknown/conflict strings are byte-identical", () => {
  it("SHA-256 of each value's UTF-8 bytes is the approved one", () => {
    expect(sha(translate("en", "allocReceipt.pending.unknown"))).toBe("f4fa999fc02b9e6328c0384fbc3514f5add512c1f7937ff00d95a4961644457e");
    expect(sha(translate("en", "allocReceipt.pending.conflict"))).toBe("a78aa71fe3588f7c60a42ad3cf4241e86f67674b73ef20b2f33bf81eeb849dc6");
    expect(sha(translate("ar", "allocReceipt.pending.unknown"))).toBe("ed332c708de6825418b9aded571c694a3bf2ced55f67bcf02f784e84248bb3bd");
    expect(sha(translate("ar", "allocReceipt.pending.conflict"))).toBe("7aa50ea9272f7dc07e7fca3df8dd34262f29fb169aff1f18ee9ec8b56613c1aa");
  });
});

describe("the phone pages carry the Arabic brand, and nothing else about them changed", () => {
  const bridge = read("src/main/phoneSessionBridge.ts");
  const server = read("src/main/phoneSessionServer.ts");
  const page = read("src/main/phonePage.ts");
  it("browser titles", () => {
    expect(bridge).toContain("<title>عالضبط</title>");
    expect(server).toContain("<title>عالضبط — ${heading}</title>"); // dynamic heading preserved
    expect(page).toContain("<title>عالضبط — ${esc(title)}</title>"); // HTML escaping preserved
  });
  it("the network error names the program, in the approved words", () => {
    expect(page).toContain('errorNetwork: "انقطع الاتصال مع برنامج «عالضبط». لم يتم حفظ الصنف.",');
  });
  it("«الصندوق» still names the till where it did, and the neighbouring wording is untouched", () => {
    expect(page).toContain("لا تحتاج إلى إنترنت — الصندوق هو الذي يخدم هذه الصفحة.");
    expect(server).toContain("تم ربط الهاتف بالصندوق بنجاح.");
    expect(bridge).toContain("تم ربط الهاتف بالصندوق، لكن إدخال الأصناف غير متاح على هذا الصندوق.");
  });
});

describe("no rejected spelling survives as a product name in user-facing source", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|html)$/.test(name)) out.push(p);
    }
    return out;
  };
  it("«الزبط» / «صندوق الزبط» / «في الضبط» do not appear in src (comments excluded)", () => {
    for (const f of walk("src")) {
      const src = code(readFileSync(f, "utf8"));
      expect(src, f).not.toContain("الزبط");
      expect(src, f).not.toContain("في الضبط");
    }
  });
});
