/**
 * S3C — the owner's collection form, asserted on its SOURCE.
 *
 * 🔴 WHY SOURCE ASSERTIONS. `vitest.config.mts` is `environment: "node"`, so there is no DOM to
 * click. What these guard are the properties that make a double collection impossible, each of
 * which is visible in the code: a busy guard around the await, an idempotency key that is NOT
 * regenerated on failure, and the absence of any money arithmetic. The behavioural proof is the
 * Windows gate against the installed app; these stop a silent regression between gates.
 *
 * 🔴 COMMENTS ARE STRIPPED BEFORE EVERY SEARCH. A comment explaining why something is absent must
 * never be what satisfies a search for its presence — this file's own standing trap.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allKeys, translate } from "../../src/shared/i18n";
import { CHANNELS } from "../../src/shared/ipcContract";

const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (path: string): string => code(readFileSync(path, "utf8"));

const STATEMENT = read("src/renderer/screens/CustomerStatement.tsx");

describe("the collection form cannot post twice", () => {
  it("🔴 guards the submit with `busy` BEFORE the await and clears it only in finally", () => {
    expect(STATEMENT).toMatch(/if \(busy \|\| blocked\) return;/);
    expect(STATEMENT).toMatch(/setBusy\(true\);/);
    expect(STATEMENT).toMatch(/finally \{\s*setBusy\(false\);\s*\}/);
    // The confirm button is disabled while in flight, so the pointer cannot queue a second click.
    expect(STATEMENT).toMatch(/data-testid="collect-confirm"/);
    expect(STATEMENT).toMatch(/disabled=\{busy\}/);
  });

  it("🔴 does NOT regenerate the idempotency key in the catch — a retry replays the same one", () => {
    const catchBlock = STATEMENT.slice(STATEMENT.indexOf("} catch (err) {"), STATEMENT.indexOf("} finally {"));
    expect(catchBlock).not.toMatch(/newIdempotencyKey/);
    // And it DOES regenerate after a success, so the next collection is a new attempt.
    const trySide = STATEMENT.slice(STATEMENT.indexOf("const result = await call"), STATEMENT.indexOf("} catch (err) {"));
    expect(trySide).toMatch(/setAttemptKey\(newIdempotencyKey\(\)\)/);
  });

  it("🔴 a changed amount is a new attempt and gets a new key", () => {
    const onChange = STATEMENT.slice(STATEMENT.indexOf("onChange={(e) => {\n                            setAmountText"));
    expect(onChange.slice(0, 400)).toMatch(/setAttemptKey\(newIdempotencyKey\(\)\)/);
  });

  it("🔴 the key comes from the shared 128-bit generator, not an ad-hoc one", () => {
    expect(STATEMENT).toMatch(/newIdempotencyKey/);
    expect(STATEMENT).not.toMatch(/Date\.now\(\)|Math\.random\(\)|counter\+\+/);
  });

  it("🔴 after RECORDED or UNKNOWN the confirm button is REMOVED, not merely warned about", () => {
    expect(STATEMENT).toMatch(/PAYMENT_RECORDED/);
    expect(STATEMENT).toMatch(/PAYMENT_STATUS_UNKNOWN/);
    expect(STATEMENT).toMatch(/UNSAFE_TO_RETRY\.has\(err\.code\)/);
    expect(STATEMENT).toMatch(/\{!blocked && \(/);
  });

  it("🔴 PAYMENT_NOT_RECORDED is NOT in the unsafe set — the safe retry stays offered", () => {
    // The anti-vacuity control for the test above: if every code blocked, the distinction the
    // whole outcome vocabulary exists for would be lost.
    const set = STATEMENT.slice(STATEMENT.indexOf("UNSAFE_TO_RETRY"), STATEMENT.indexOf("]);") + 3);
    expect(set).not.toMatch(/PAYMENT_NOT_RECORDED/);
  });
});

describe("the form does no money arithmetic", () => {
  it("🔴 no addition, subtraction or rounding of any amount in the renderer", () => {
    for (const forbidden of [/\.minor\s*[-+*/]/, /BigInt\(/, /Number\(.*minor/, /reduce\(/, /toFixed\(/]) {
      expect(STATEMENT, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("🔴 the typed amount is parsed by the DOMAIN's parser, not by code written here", () => {
    expect(STATEMENT).toMatch(/import \{ parseDecimal \} from "\.\.\/\.\.\/domain\/money"/);
    expect(STATEMENT).toMatch(/parseDecimal\(amountText\.trim\(\), o\.outstanding\.currency\)/);
  });

  it("🔴 the new balance is REPLACED from the server, never patched locally", () => {
    expect(STATEMENT).toMatch(/setStatement\(result\.statement\)/);
  });
});

describe("what the form offers", () => {
  it("🔴 cash only — no other method is selectable", () => {
    expect(STATEMENT).toMatch(/method: "cash"/);
    for (const m of ["whish", "credit", '"card"', '"external"']) {
      expect(STATEMENT.toLowerCase(), m).not.toContain(m.toLowerCase().replace(/"/g, ""));
    }
  });

  it("🔴 collection is offered only on a debt that is still owed", () => {
    expect(STATEMENT).toMatch(/!o\.fullyPaid &&/);
  });

  it("🔴 a duplicate is reported as ALREADY recorded, never as a second payment", () => {
    expect(STATEMENT).toMatch(/result\.duplicate \? "duplicate" : "done"/);
    expect(translate("ar", "collect.alreadyDone")).toContain("مرّتين");
    expect(translate("en", "collect.alreadyDone")).toMatch(/not been counted twice/i);
  });

  it("🔴 names and amounts are bidirectionally isolated", () => {
    expect(STATEMENT).toMatch(/<bdi data-testid="collect-customer">/);
    expect(STATEMENT).toMatch(/<bdi dir="ltr" data-testid="collect-outstanding">/);
  });
});

describe("the words and the contract", () => {
  it("🔴 every collect.* key exists in BOTH dictionaries and neither is empty", () => {
    const keys = allKeys().filter((k) => k.startsWith("collect."));
    expect(keys.length).toBeGreaterThanOrEqual(15);
    for (const k of keys) {
      for (const lang of ["ar", "en"] as const) expect(translate(lang, k).trim().length, `${lang} ${k}`).toBeGreaterThan(0);
    }
  });

  it("🔴 collect.* and pay.* are DIFFERENT namespaces — the Sell step is not reused here", () => {
    // 🔴 A KEY'S NAME IS PART OF THE CONTRACT. `pay.*` already belongs to the Sell checkout step.
    // Reusing it for debt collection would make two unrelated moments share a vocabulary, and the
    // first draft of this slice did exactly that and collided on `pay.title`.
    const collect = allKeys().filter((k) => k.startsWith("collect."));
    const pay = allKeys().filter((k) => k.startsWith("pay."));
    expect(pay.length).toBeGreaterThan(0);
    expect(collect.some((k) => pay.includes(k))).toBe(false);
  });

  it("🔴 the read-only line no longer claims a payment cannot be recorded", () => {
    // S3B's sentence said no payment could be recorded here. It can now, so the screen says so.
    expect(translate("ar", "statement.readOnly")).toContain("دفعة");
    expect(translate("en", "statement.readOnly")).toMatch(/only a payment against an existing debt/i);
    // 🔴 AND IT STILL SAYS A DEBT CANNOT BE CREATED, which remains true.
    expect(translate("en", "statement.readOnly")).toMatch(/No debt can be recorded/i);
  });

  it("🔴 the renderer reaches exactly one money-writing channel", () => {
    const used = Object.keys(CHANNELS).filter((c) => STATEMENT.includes(`pos().${c}(`));
    expect(used.sort()).toEqual(["getCustomerStatement", "recordCustomerPayment"]);
  });
});
