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

  it("🔴 a changed amount is a new attempt and gets a new key, only while editing is permitted", () => {
    const onChange = STATEMENT.slice(STATEMENT.indexOf("onChange={(e) => {\n                            setAmountText"));
    expect(onChange.slice(0, 400)).toMatch(/setAttemptKey\(newIdempotencyKey\(\)\)/);
    // The field is disabled after an unknown outcome, so the handler cannot mint another key then.
    expect(STATEMENT).toMatch(/data-testid="collect-amount"[\s\S]*?disabled=\{blocked \|\| busy\}/);
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

  it("🔴 an UNKNOWN outcome cannot be dismissed or switched to another debt inside this form", () => {
    expect(STATEMENT).toMatch(/const closeForm = \(\) => \{[\s\S]*?if \(blocked \|\| busy\) return;/);
    expect(STATEMENT).toMatch(/const openForm = \(obligationId: string\) => \{[\s\S]*?if \(blocked \|\| busy\) return;/);
    expect(STATEMENT).toMatch(/onClick=\{closeForm\} disabled=\{blocked \|\| busy\} data-testid="collect-cancel"/);
    // TRANSITION with the M17A recovery work: the open button is ALSO closed while the ledger cannot
    // answer an earlier collection (lockedByPending), which comes from the statement, not screen state.
    expect(STATEMENT).toMatch(/disabled=\{blocked \|\| busy \|\| lockedByPending\}\s+onClick=\{\(\) => openForm\(o.id\)\}\s+data-testid="collect-open"/);
  });

  it("🔴 a vanished open attempt is NOT mistaken for a recorded payment after an UNKNOWN lookup", () => {
    expect(STATEMENT).toMatch(/resolveFromLedger\(payload\.idempotencyKey, err\.code === "PAYMENT_RECORDED" \? "recorded" : "unknown"\)/);
    expect(STATEMENT).toMatch(/if \(!open\) \{\s*if \(priorOutcome === "recorded"\)/);
    expect(STATEMENT).not.toMatch(/if \(!open\) \{\s*releaseAfterAnswer\(\)/);
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
  // 🔴 TRANSITION with migration 17 (M17A): this pinned CASH ONLY. The form now offers exactly five
  // channels; 'credit' (a state) and 'external' (a stored value, not a channel) are still never a
  // choice, and the method sent is the owner's selection, never a literal.
  it("🔴 offers exactly the five channels — never credit, never a bare 'external'", () => {
    expect(STATEMENT).toContain('["cash", "card", "whish", "bank_transfer", "other"]');
    expect(STATEMENT).not.toMatch(/method: "cash"/);
    expect(STATEMENT).toMatch(/\n\s+method,\n/);
    expect(STATEMENT.toLowerCase()).not.toContain("credit");
    expect(STATEMENT).not.toMatch(/<option[^>]*value="external"/);
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
// M17A — the collection form's payment methods. SOURCE-LEVEL assertions (no DOM environment).
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("payment methods on the collection form (source-level)", () => {
  it("🔴 non-cash rules are the owner's explicit acts: reference and 'money received' start empty and unchecked", () => {
    expect(STATEMENT).toContain('useState("")'); // reference
    expect(STATEMENT).toMatch(/const \[confirmed, setConfirmed\] = useState\(false\)/);
    expect(STATEMENT).not.toMatch(/setConfirmed\(true\)/);
  });
  it("🔴 the confirmation is sent as the owner's choice, and is required for whish, bank transfer and other", () => {
    expect(STATEMENT).toMatch(/method === "whish" \|\| method === "bank_transfer" \|\| method === "other"/);
    expect(STATEMENT).toContain("fundsConfirmed: needsConfirmation ? confirmed : false");
    expect(STATEMENT).toContain('t("collect.confirmRequired")');
    expect(STATEMENT).toContain('t("collect.referenceRequired")');
  });
  it("🔴 a different method, reference or confirmation is a different payment and takes a new key — except while an outcome is UNKNOWN, when the fields are frozen", () => {
    const changes = STATEMENT.match(/setAttemptKey\(newIdempotencyKey\(\)\)/g) ?? [];
    expect(changes.length).toBeGreaterThanOrEqual(5);
    // 5 here + the open button's own `blocked || busy || lockedByPending` (asserted above) = the same six.
    expect((STATEMENT.match(/disabled=\{blocked \|\| busy\}/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
  it("🔴 history labels Whish and bank transfer as themselves, never as cash, in both languages", () => {
    expect(STATEMENT).toContain("statement.channel.${s.provider ?? s.method}");
    for (const lang of ["ar", "en"] as const) {
      for (const k of ["cash", "card", "whish", "bank_transfer", "other"]) {
        expect(translate(lang, `statement.channel.${k}`), `${lang} ${k}`).not.toBe(`statement.channel.${k}`);
        expect(translate(lang, `collect.method.${k}`), `${lang} ${k}`).not.toBe(`collect.method.${k}`);
      }
    }
    expect(translate("en", "statement.channel.whish")).not.toBe(translate("en", "statement.channel.cash"));
  });
  it("🔴 the operator is told the till does not contact Whish or the bank, and never to type a card number", () => {
    expect(translate("en", "collect.fundsHint")).toMatch(/does not contact Whish or the bank/i);
    expect(translate("en", "collect.referenceHint")).toMatch(/never type a card number/i);
    expect(translate("ar", "collect.fundsHint")).toContain("لا يتّصل");
    expect(translate("ar", "collect.referenceHint")).toContain("لا تكتب رقم بطاقة");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// M17A final gate — recovery of an unknown outcome (SOURCE-LEVEL; the behaviour is in
// tests/main/collectionRecovery.test.ts against the real ledger).
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("recovering an unfinished collection (source-level)", () => {
  it("🔴 pending collections come from the statement (the ledger), not from screen state", () => {
    expect(STATEMENT).toContain("statement.pendingCollections");
    expect(STATEMENT).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
  it("🔴 the exact repeat re-sends the ORIGINAL key and payload from the ledger's record — no new key", () => {
    const repeat = STATEMENT.slice(STATEMENT.indexOf("const repeatPending"), STATEMENT.indexOf("useEffect(() => {"));
    expect(repeat).toContain("idempotencyKey: p.idempotencyKey");
    expect(repeat).toContain("amountMinor: p.amount.minor");
    expect(repeat).not.toContain("newIdempotencyKey");
  });
  it("🔴 only a not-recorded attempt offers a repeat; unknown and conflict keep new collections closed", () => {
    expect(STATEMENT).toMatch(/p\.status === "not_recorded" &&/);
    expect(STATEMENT).toMatch(/lockedByPending = statement\.pendingCollections\.some\(\(p\) => p\.status === "unknown" \|\| p\.status === "conflict"\)/);
    expect(STATEMENT).toMatch(/disabled=\{blocked \|\| busy \|\| lockedByPending\}/);
  });
  it("🔴 the lock is released only by an answer from the ledger, and a failed lookup stays locked", () => {
    const resolve = STATEMENT.slice(STATEMENT.indexOf("const resolveFromLedger"), STATEMENT.indexOf("const repeatPending"));
    expect(resolve).toContain('open.status === "not_recorded"');
    // The catch block is EMPTY: a failed lookup changes nothing, so the lock stays.
    expect(resolve).toMatch(/catch \{\s*\}/);
  });
  it("all four ledger answers are explained in both languages, and none says 'collect again'", () => {
    for (const s of ["recorded", "not_recorded", "unknown", "conflict"]) {
      for (const lang of ["ar", "en"] as const) {
        expect(translate(lang, `collect.pending.${s}`), `${lang} ${s}`).not.toBe(`collect.pending.${s}`);
      }
    }
    expect(translate("en", "collect.pending.unknown")).toMatch(/do not collect the money again/i);
    expect(translate("en", "collect.pending.conflict")).toMatch(/do not collect again/i);
    expect(translate("ar", "collect.pending.unknown")).toContain("لا تحصِّل");
    expect(translate("ar", "collect.err.COLLECTION_UNRESOLVED")).not.toBe("collect.err.COLLECTION_UNRESOLVED");
  });
});

describe("🔴 finding A — a missing settlement never claims the money was not received", () => {
  const en = translate("en", "collect.pending.not_recorded");
  const ar = translate("ar", "collect.pending.not_recorded");
  it("neither language says nothing was taken / not received, and both tell the operator to check the real payment", () => {
    expect(en).not.toMatch(/nothing was taken|not in the ledger|no money/i);
    expect(en).toMatch(/does not confirm whether the money was received/i);
    expect(en).toMatch(/check the actual payment/i);
    expect(en).toContain("ALZABT POS");
    expect(ar).not.toContain("لم يُؤخَذ");
    expect(ar).toContain("ما بيعني بالضرورة");
    expect(ar).toContain("تأكّد من استلام المبلغ فعلياً");
  });
  it("the retry button names retrying the POS RECORDING, never paying again", () => {
    expect(translate("en", "collect.pending.retry")).toBe("Retry recording this collection");
    expect(translate("ar", "collect.pending.retry")).toBe("إعادة محاولة تسجيل القبض");
    for (const t of [translate("en", "collect.pending.retry"), translate("ar", "collect.pending.retry")]) {
      expect(t).not.toMatch(/pay again|collect again|دفعة جديدة/i);
    }
  });
  it("both texts render through the pending banner and button and stay short enough for 1024x640", () => {
    expect(STATEMENT).toContain("t(`collect.pending.${p.status}`)");
    expect(STATEMENT).toContain('t("collect.pending.retry")');
    expect(en.length).toBeLessThan(200);
    expect(ar.length).toBeLessThan(200);
  });
  it("the safety wording and behaviour of unknown/conflict are unchanged", () => {
    expect(translate("en", "collect.pending.unknown")).toMatch(/do not collect the money again/i);
    expect(translate("en", "collect.pending.conflict")).toMatch(/do not collect again/i);
    expect(STATEMENT).toContain("lockedByPending");
    expect(STATEMENT).toContain("repeatPending");
  });
});
