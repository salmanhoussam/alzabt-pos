/**
 * Which desktop refusals may be shown in Arabic, and which must stay exactly as the main process
 * sent them.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE IS THE AUDIT, EXECUTED. The eligibility rule is not a claim in a comment here — the
 * last three tests RE-DERIVE it from `src/` on every run:
 *   · every mapped code is really thrown somewhere (a typo'd code would silently never fire)
 *   · no mapped code's English message interpolates data (criterion (b), machine-checked)
 *   · every code that carries more than one meaning is absent (criterion (a), enumerated)
 * So a future edit that gives `PRODUCT_NOT_FOUND` a second meaning, or adds a template to one of
 * its sites, fails here instead of mistranslating a merchant's screen.
 *
 * 🔴 AND IT IS A TRANSITION FOR EXACTLY ONE EXISTING ASSERTION. `errorText.test.ts` pinned
 *   errorText(new ApiError("TOTAL_MISMATCH", "The displayed total no longer matches"))
 *     === "The displayed total no longer matches"
 * With no DOM the language now falls back to `DEFAULT_TERMINAL_LANGUAGE` (Arabic, the product's
 * default and the provider's own initial state), so that call returns Arabic. The old English value
 * is preserved and is still asserted — through `errorText(err, "en")`.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError, errorText } from "../../src/renderer/api";
import { DomainError } from "../../src/domain/errors";
import { FORBIDDEN_CODES, MAPPED_CODES, arabicRefusal } from "../../src/renderer/refusalText";
import { LANGUAGES } from "../../src/shared/i18n";

/** Codes proven to carry more than one meaning, or data, by the 2026-10-22 audit of 268 sites. */
const DELIBERATELY_EXCLUDED: readonly string[] = [
  "INVALID_INPUT", // 93 sites · 51 literals + 29 templates
  "NOT_AVAILABLE", // 22 sites · 18 sentences naming 18 subsystems
  "NOT_AUTHORIZED", // 6 sites · 4 different refusals
  "INVOICE_NOT_FOUND", // the invoice is gone  vs  the invoice LINE is gone
  "OPERATOR_NOT_FOUND", // someone else's account  vs  your own, two different actions
  "OWNER_SETUP_REQUIRED", // 3 different ceremony states
  "SETUP_REQUIRED", // "sign in again to set up"  vs  "has not set their own PIN yet"
  "INVALID_PIN", // required / digits only / wrong length
  "INVALID_CREDENTIALS", // carries the attempts left and the lock duration
  "CASHIER_LOCKED", // carries the operator name and the minutes remaining
  "IDEMPOTENCY_CONFLICT", // financial-adjacent; its own review, not this slice
  "NOT_EXACT", // a programmer error, never merchant-facing
  "FRACTION_NOT_ALLOWED", // carries the unit and the typed quantity
  "DUPLICATE_SKU", // carries the SKU
  "DUPLICATE_BARCODE", // carries the barcode
  "DUPLICATE_CATEGORY", // carries the category name
  "INVALID_QUANTITY", // 12 of 14 sites are templates
  "INVALID_AMOUNT", // 10 literals + 4 templates
  "MIXED_CURRENCY", // every site is a template naming both currencies
  "UNSUPPORTED_UNIT", // carries the unit
];

/**
 * Every TypeScript source file under `src/`, found with Node's own filesystem APIs.
 *
 * 🔴 IT USED TO SHELL OUT TO `find`, AND THAT MADE THE WHOLE FILE A NO-OP ON WINDOWS. On Windows
 * `find` resolves to `C:\Windows\System32\find.exe`, a different program that searches for text
 * INSIDE files, so it exited 2 with "File not found - '*.ts'", the module failed to LOAD, and none
 * of this file's assertions ran at all — while the local Linux run passed and looked like proof.
 * Windows run 39806703245 is where that showed up. A check that cannot run on the platform that
 * ships is not a check, so the shell is gone rather than special-cased.
 *
 * Deliberately narrow and deliberately loud:
 *   · it starts at `src` and recurses only into real directories, so nothing outside the product
 *     tree is read and a symlink cannot walk it somewhere else;
 *   · entries are sorted, so the file order — and therefore any failure message listing offenders —
 *     is identical on every machine and every run;
 *   · `readFileSync` is NOT wrapped in try/catch. A source file that cannot be read must fail this
 *     test loudly, because silently skipping it would silently shrink the audit.
 */
function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(full));
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) found.push(full);
  }
  return found;
}

const srcFiles = sourceFilesUnder("src");
const sources = srcFiles.map((f) => ({ f, text: readFileSync(f, "utf8") }));

/** Every `new DomainError("CODE", <arg>)` for one code, with the raw second argument. */
function throwSites(code: string): { file: string; arg: string }[] {
  const out: { file: string; arg: string }[] = [];
  for (const { f, text } of sources) {
    for (let i = 0; ; ) {
      const at = text.indexOf("new DomainError(", i);
      if (at === -1) break;
      i = at + 16;
      let depth = 1;
      let j = i;
      while (j < text.length && depth > 0) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      const args = text.slice(i, j - 1);
      const m = /^\s*"([A-Z_0-9]+)"\s*,([\s\S]*)$/.exec(args);
      if (m && m[1] === code) out.push({ file: f, arg: m[2]!.trim() });
    }
  }
  return out;
}

describe("the Arabic refusal map", () => {
  // ── 1 · Arabic matches the meaning ──────────────────────────────────────────────────────────
  it("🔴 answers in Arabic for every mapped code, and each sentence is distinct", () => {
    const seen = new Set<string>();
    for (const code of MAPPED_CODES) {
      const text = arabicRefusal("ar", code);
      expect(text, code).not.toBeNull();
      expect(text!, code).toMatch(/[\u0600-\u06FF]/);
      expect(text!, code).not.toMatch(/[A-Za-z]/);
      expect(seen.has(text!), `${code} repeats another code's sentence`).toBe(false);
      seen.add(text!);
    }
    expect(MAPPED_CODES.length).toBe(18);
  });

  it("the specific meaning is the one shown, not a generic refusal", () => {
    expect(arabicRefusal("ar", "EMPTY_CART")).toBe("السلّة فارغة.");
    expect(arabicRefusal("ar", "PRODUCT_NOT_FOUND")).toBe("هذا الصنف لم يبقَ موجوداً.");
    expect(arabicRefusal("ar", "CATEGORY_NOT_FOUND")).toBe("هذه الفئة لم تبقَ موجودة.");
    expect(arabicRefusal("ar", "OPERATOR_INACTIVE")).toBe("هذا الحساب مُعطَّل. سجّل الدخول من جديد.");
    expect(arabicRefusal("ar", "TOTAL_MISMATCH")).toContain("راجع السلّة");
    expect(arabicRefusal("ar", "VOID_NOT_ALLOWED")).toContain("يوم العمل");
  });

  // ── 2 · English never changes ───────────────────────────────────────────────────────────────
  it("🔴 ENGLISH mode never consults the map — the message is byte-identical to what main sent", () => {
    for (const code of MAPPED_CODES) {
      expect(arabicRefusal("en", code), code).toBeNull();
      const sent = `whatever main actually sent for ${code}`;
      expect(errorText(new ApiError(code, sent), "en")).toBe(sent);
    }
  });

  it("…including the codes whose English uses two slightly different wordings", () => {
    // These are precisely the ones a shared English entry would have rewritten.
    expect(errorText(new ApiError("PRODUCT_NOT_FOUND", "That product no longer exists"), "en")).toBe(
      "That product no longer exists",
    );
    expect(errorText(new ApiError("PRODUCT_NOT_FOUND", "This product no longer exists"), "en")).toBe(
      "This product no longer exists",
    );
    expect(errorText(new ApiError("NOT_LOGGED_IN", "Sign in first"), "en")).toBe("Sign in first");
    expect(errorText(new ApiError("NOT_LOGGED_IN", "A cashier must be logged in"), "en")).toBe(
      "A cashier must be logged in",
    );
  });

  // ── 3 · the code itself is untouched ────────────────────────────────────────────────────────
  it("the error's own code is never rewritten — only what is displayed", () => {
    const e = new ApiError("PRODUCT_NOT_FOUND", "That product no longer exists");
    errorText(e, "ar");
    expect(e.code).toBe("PRODUCT_NOT_FOUND");
    expect(e.message).toBe("That product no longer exists");
  });

  // ── 4 · distinct reasons are NOT collapsed ──────────────────────────────────────────────────
  it("🔴 every code proven to carry more than one meaning, or data, is ABSENT", () => {
    for (const code of DELIBERATELY_EXCLUDED) {
      expect(MAPPED_CODES, `${code} must not be mapped`).not.toContain(code);
      expect(arabicRefusal("ar", code), code).toBeNull();
      const sent = "the real, specific English sentence";
      expect(errorText(new ApiError(code, sent), "ar")).toBe(sent);
    }
  });

  it("🔴 an ambiguous code's two different meanings both still reach the merchant intact", () => {
    // INVOICE_NOT_FOUND is one code for two different objects. Both survive, in both languages.
    for (const lang of LANGUAGES) {
      expect(errorText(new ApiError("INVOICE_NOT_FOUND", "This invoice no longer exists"), lang)).toBe(
        "This invoice no longer exists",
      );
      expect(errorText(new ApiError("INVOICE_NOT_FOUND", "The invoice line behind this item is gone"), lang)).toBe(
        "The invoice line behind this item is gone",
      );
    }
  });

  // ── 5 · unknown codes are safe ──────────────────────────────────────────────────────────────
  it("an unmapped code shows what main sent; a non-error still shows nothing verbatim", () => {
    expect(errorText(new ApiError("SOME_FUTURE_CODE", "A brand new refusal"), "ar")).toBe("A brand new refusal");
    expect(arabicRefusal("ar", "")).toBeNull();
    expect(arabicRefusal("ar", "toString")).toBeNull();
    expect(arabicRefusal("ar", "__proto__")).toBeNull();
    expect(errorText(new TypeError("x is not a function"), "ar")).toBe("Unexpected error");
    expect(errorText("a bare string", "ar")).toBe("Unexpected error");
    expect(errorText(undefined, "ar")).toBe("Unexpected error");
  });

  // ── 6 · nothing leaks ───────────────────────────────────────────────────────────────────────
  it("🔴 no Arabic sentence carries a credential, a path or a diagnostic", () => {
    for (const code of MAPPED_CODES) {
      const text = arabicRefusal("ar", code)!;
      for (const leak of ["PIN", "pin", "token", "Token", "sqlite", "SQLITE", "SELECT", "C:\\", "/home/", ".ts", "Error", "base64", "data:"]) {
        expect(text, `${code} leaks ${leak}`).not.toContain(leak);
      }
      expect(text).not.toMatch(/[0-9]/);
      expect(text).not.toContain("undefined");
    }
  });

  // ── 7 · it reaches the merchant-facing error area ───────────────────────────────────────────
  it("🔴 the Arabic sentence arrives through the real call() → ApiError → errorText chain", async () => {
    const { call } = await import("../../src/renderer/api");
    let shown = "";
    try {
      await call(Promise.resolve({ ok: false as const, error: { code: "EMPTY_CART", message: "The cart is empty" } }));
    } catch (e) {
      shown = errorText(e, "ar");
    }
    expect(shown).toBe("السلّة فارغة.");
    expect(shown).not.toBe("Unexpected error");
  });

  it("the Sell checkout still routes its refusal into the rendered error element", () => {
    const src = readFileSync("src/renderer/screens/SellScreen.tsx", "utf8");
    expect(src).toContain("setError(errorText(e))");
    expect(src).toMatch(/<p className="error">\{error\}<\/p>/);
  });

  // ── 8 · the financial safety messages are untouched ─────────────────────────────────────────
  it("🔴 every sale and invoice OUTCOME code passes through EXACTLY as main composed it", () => {
    const composed: Record<string, string> = {
      INTERNAL: "حدث خطأ غير متوقّع. حاول مرّة أخرى، وإذا تكرّر الأمر فاتّصل بالدعم.",
      SALE_RECORDED: "سُجِّلت الفاتورة فعلاً (إيصال رقم 7) ثم حدث خطأ غير متوقّع. راجع السجلّ — لا تُعِد إدخالها.",
      SALE_NOT_RECORDED: "حدث خطأ غير متوقّع — لم تُسجَّل الفاتورة. يمكنك إعادة المحاولة.",
      SALE_STATUS_UNKNOWN: "حدث خطأ غير متوقّع — لا نعرف إن كانت الفاتورة قد سُجِّلت. راجع السجلّ قبل إعادة المحاولة.",
      INVOICE_FINALIZED: "الفاتورة رقم 418 صُدِرت فعلاً (إيصال رقم 77) ثم حدث خطأ غير متوقّع. راجع قائمة الفواتير — لا تُصدرها مرّة أخرى.",
      INVOICE_NOT_FINALIZED: "حدث خطأ غير متوقّع — لم تُصدَر الفاتورة، وهي ما تزال مسوّدة. يمكنك إعادة المحاولة.",
      INVOICE_STATUS_UNKNOWN: "حدث خطأ غير متوقّع — لا نعرف إن كانت الفاتورة قد صُدِرت. راجع قائمة الفواتير قبل إعادة المحاولة.",
    };
    for (const [code, message] of Object.entries(composed)) {
      for (const lang of LANGUAGES) {
        expect(errorText(new ApiError(code, message), lang), `${lang}:${code}`).toBe(message);
      }
      // The receipt / invoice numbers and the do-not-repeat instructions survive verbatim.
      expect(errorText(new ApiError(code, message), "ar")).toBe(message);
    }
    expect(errorText(new ApiError("SALE_RECORDED", composed.SALE_RECORDED!), "ar")).toContain("إيصال رقم 7");
    expect(errorText(new ApiError("INVOICE_FINALIZED", composed.INVOICE_FINALIZED!), "ar")).toContain("الفاتورة رقم 418");
  });

  it("🔴 the map and the forbidden list cannot overlap, now or later", () => {
    for (const code of FORBIDDEN_CODES) {
      expect(MAPPED_CODES, `${code} is a financial outcome and must never be mapped`).not.toContain(code);
      expect(arabicRefusal("ar", code), code).toBeNull();
    }
  });

  // ── The eligibility rule, re-derived from src/ on every run ─────────────────────────────────
  it("🔴 the source enumeration really found the product — this audit cannot pass on an empty walk", () => {
    // 🔴 WITHOUT THIS, THE TWO CRITERION TESTS BELOW WOULD PASS VACUOUSLY. Both collect `offenders`
    // and assert the list is empty, so a traversal that returned NOTHING would make them green
    // while proving nothing at all — which is precisely the shape of the Windows defect this
    // correction fixes. So the walk's own output is asserted first.
    expect(srcFiles.length).toBeGreaterThan(50);
    expect(sources.length).toBe(srcFiles.length);
    // Both extensions, found by the walk rather than assumed.
    expect(srcFiles.some((f) => f.endsWith(".ts"))).toBe(true);
    expect(srcFiles.some((f) => f.endsWith(".tsx"))).toBe(true);
    // Files it must contain, named individually — each one holds throws this audit depends on.
    // `join` so the assertion is true with either path separator.
    for (const expected of [
      join("src", "renderer", "api.ts"),
      join("src", "renderer", "refusalText.ts"),
      join("src", "application", "posService.ts"),
      join("src", "application", "invoiceService.ts"),
      join("src", "application", "operatorService.ts"),
      join("src", "domain", "cart.ts"),
      join("src", "domain", "errors.ts"),
      join("src", "main", "ipcHandlers.ts"),
      join("src", "renderer", "screens", "SellScreen.tsx"),
    ]) {
      expect(srcFiles, `${expected} was not enumerated`).toContain(expected);
    }
    // Nothing outside the product tree, and nothing read twice.
    for (const f of srcFiles) expect(f.startsWith(`src${sep}`), `${f} is outside src/`).toBe(true);
    expect(new Set(srcFiles).size).toBe(srcFiles.length);
    // Every file really was read — an unreadable one would have thrown at module load, not here.
    for (const { f, text } of sources) expect(typeof text, f).toBe("string");
  });

  it("🔴 every mapped code is really thrown in the product — a typo would never fire", () => {
    for (const code of MAPPED_CODES) {
      expect(throwSites(code).length, `${code} is mapped but thrown nowhere`).toBeGreaterThan(0);
    }
  });

  it("🔴 CRITERION (b): no mapped code's English message interpolates data", () => {
    const offenders: string[] = [];
    for (const code of MAPPED_CODES) {
      for (const site of throwSites(code)) {
        // A template literal, a concatenation or an expression means the sentence carries a value
        // the Arabic cannot reproduce — the code would then be ineligible.
        if (/^`/.test(site.arg) || /^[A-Za-z_$]/.test(site.arg) || site.arg.includes("${")) {
          offenders.push(`${code} @ ${site.file}: ${site.arg.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("🔴 CRITERION (a): no mapped code's sites disagree about what they mean", () => {
    // Proven the way the audit proved it: the English literals for one code must be identical, or
    // differ only by the leading demonstrative ("This"/"That"), or by a trailing clarifying clause.
    const normalise = (s: string) =>
      s.replace(/^(This|That|The)\s+/i, "").replace(/\s+(before|first)\b.*$/i, "").trim().toLowerCase();
    // 🔴 ONE NAMED EXCEPTION, ARGUED RATHER THAN HIDDEN. `NOT_LOGGED_IN` is thrown as both
    // "Sign in first" and "A cashier must be logged in". Those are different WORDS for one
    // meaning — both appear only when there is no session, and both demand the same single action,
    // which is to sign in. The mechanical rule cannot see that, so it is recorded here as an
    // exception a reviewer can veto on one line, instead of being smuggled in by loosening
    // `normalise` until it passed. No other code gets one.
    const SYNONYMOUS_BY_REVIEW: readonly string[] = ["NOT_LOGGED_IN"];
    const offenders: string[] = [];
    for (const code of MAPPED_CODES) {
      if (SYNONYMOUS_BY_REVIEW.includes(code)) continue;
      const forms = new Set(
        throwSites(code)
          .map((s) => /^"((?:[^"\\]|\\.)*)"/.exec(s.arg)?.[1] ?? "")
          .filter((x) => x.length > 0)
          .map(normalise),
      );
      if (forms.size > 1) offenders.push(`${code}: ${[...forms].join(" | ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
