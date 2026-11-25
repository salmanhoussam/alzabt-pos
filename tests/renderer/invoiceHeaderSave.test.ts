/**
 * INV-FIRST-CLICK (F2-5) — the invoice sheet's first click after typing is no longer lost.
 *
 * Two halves, because there is no DOM test environment here:
 *   1. `headerSaveQueue.ts` BEHAVIOUR — the ordering contract, tested directly with controllable promises.
 *   2. `InvoiceSheet.tsx` WIRING — source-level pins (comments stripped), so a later edit that routes a blur
 *      back through `busy`, or a button around the queue, fails here.
 * The click itself is measured in a screen-only Chromium harness (real component, fake `window.pos`), outside
 * this repository: baseline 0 / 50 single clicks acted, after the fix 50 / 50 (Arabic and English).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createFailureLedger,
  createSaveQueue,
  isTypedPaidUnsaved,
  lineInputMatchesStored,
} from "../../src/renderer/screens/invoices/headerSaveQueue";
import { cleanText, parseInvoiceQuantity } from "../../src/domain/invoice";
import { formatDecimal, money, parseDecimal } from "../../src/domain/money";

/** A promise the test resolves or rejects by hand, so ordering is decided by the test, not by timers. */
function gate() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("headerSaveQueue — ordering", () => {
  it("an action pressed while a save is in flight runs AFTER it, exactly once", async () => {
    const q = createSaveQueue();
    const log: string[] = [];
    const save = gate();
    void q.save(async () => {
      log.push("save:start");
      await save.promise;
      log.push("save:end");
    });
    let ran = 0;
    const outcome = q.action(async () => {
      ran++;
      log.push("action");
    });
    await tick();
    expect(log).toEqual(["save:start"]); // the action is waiting, not skipped and not racing
    expect(q.acting).toBe(true);
    save.resolve();
    expect(await outcome).toBe("ran");
    expect(ran).toBe(1);
    expect(log).toEqual(["save:start", "save:end", "action"]);
    expect(q.acting).toBe(false);
  });

  it("saves never overlap and keep the operator's order", async () => {
    const q = createSaveQueue();
    const log: string[] = [];
    const a = gate();
    const b = gate();
    void q.save(async () => {
      log.push("a:start");
      await a.promise;
      log.push("a:end");
    });
    void q.save(async () => {
      log.push("b:start");
      await b.promise;
      log.push("b:end");
    });
    await tick();
    expect(log).toEqual(["a:start"]);
    a.resolve();
    await tick();
    expect(log).toEqual(["a:start", "a:end", "b:start"]);
    b.resolve();
    await tick();
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("a save queued while an action runs waits for the action", async () => {
    const q = createSaveQueue();
    const log: string[] = [];
    const act = gate();
    const outcome = q.action(async () => {
      log.push("action:start");
      await act.promise;
      log.push("action:end");
    });
    await tick();
    void q.save(async () => {
      log.push("save");
    });
    await tick();
    expect(log).toEqual(["action:start"]);
    act.resolve();
    await outcome;
    await tick();
    expect(log).toEqual(["action:start", "action:end", "save"]);
  });
});

describe("headerSaveQueue — refusals and repeats", () => {
  it("a save that FAILS while the action waits blocks it: the action never runs (nothing issued over a refused value)", async () => {
    const q = createSaveQueue();
    const save = gate();
    const result = q.save(async () => {
      await save.promise;
    });
    let ran = 0;
    const outcome = q.action(async () => {
      ran++;
    });
    save.reject(new Error("refused"));
    expect(await outcome).toBe("blocked");
    expect(await result).toBe(false);
    expect(ran).toBe(0);
    expect(q.acting).toBe(false);
  });

  it("a failure the operator has already seen (settled before the press) does not block for ever", async () => {
    const q = createSaveQueue();
    expect(await q.save(async () => Promise.reject(new Error("refused earlier")))).toBe(false);
    let ran = 0;
    expect(await q.action(async () => { ran++; })).toBe("ran");
    expect(ran).toBe(1);
  });

  it("after a blocked action, pressing again runs (the block is not sticky)", async () => {
    const q = createSaveQueue();
    const save = gate();
    void q.save(async () => {
      await save.promise;
    });
    const first = q.action(async () => undefined);
    save.reject(new Error("refused"));
    expect(await first).toBe("blocked");
    let ran = 0;
    expect(await q.action(async () => { ran++; })).toBe("ran");
    expect(ran).toBe(1);
  });

  it("a second press while the first is waiting or running is ignored — one action, never two", async () => {
    const q = createSaveQueue();
    const save = gate();
    void q.save(async () => {
      await save.promise;
    });
    let ran = 0;
    const first = q.action(async () => { ran++; });
    expect(await q.action(async () => { ran++; })).toBe("ignored"); // pressed while waiting
    save.resolve();
    expect(await first).toBe("ran");
    const running = gate();
    const third = q.action(async () => {
      ran++;
      await running.promise;
    });
    await tick();
    expect(await q.action(async () => { ran++; })).toBe("ignored"); // pressed while running
    running.resolve();
    expect(await third).toBe("ran");
    expect(ran).toBe(2);
  });

  it("save() never rejects, so a `void` caller cannot leak an unhandled rejection", async () => {
    const q = createSaveQueue();
    await expect(q.save(async () => { throw new Error("x"); })).resolves.toBe(false);
    await expect(q.save(async () => undefined)).resolves.toBe(true);
  });

  it("an action that throws propagates its own error and still releases the queue", async () => {
    const q = createSaveQueue();
    await expect(q.action(async () => { throw new Error("own error"); })).rejects.toThrow("own error");
    expect(q.acting).toBe(false);
    let saved = false;
    await q.save(async () => { saved = true; });
    expect(saved).toBe(true);
  });
});

describe("F2-5-R2 — failure ledger: a later success never erases an earlier, unresolved refusal", () => {
  it("Abu Abbas's sequence: name refused, then phone accepted → the name refusal is still the one shown", () => {
    const l = createFailureLedger();
    l.refused(["customerName"], "name refused");
    expect(l.saved(["customerPhone"])).toBe(false); // an unrelated success clears nothing
    expect(l.latest()).toBe("name refused");
  });
  it("recovery: a successful save of the SAME field resolves it, and nothing is shown any more", () => {
    const l = createFailureLedger();
    l.refused(["customerName"], "name refused");
    expect(l.saved(["customerName"])).toBe(true);
    expect(l.latest()).toBeNull();
  });
  it("several unresolved refusals: the NEWEST is shown, and resolving it falls back to the older one", () => {
    const l = createFailureLedger();
    l.refused(["customerName"], "name refused");
    l.refused(["tax"], "tax refused");
    expect(l.latest()).toBe("tax refused");
    l.saved(["tax"]);
    expect(l.latest()).toBe("name refused");
    l.refused(["customerName"], "name refused again");
    expect(l.latest()).toBe("name refused again");
  });
  it("a full header flush (every bound field accepted) resolves all header refusals at once", () => {
    const l = createFailureLedger();
    l.refused(["customerName"], "a");
    l.refused(["customerPhone"], "b");
    l.saved(["invoiceDate", "customerName", "customerAddress", "customerPhone", "notes", "paid"]);
    expect(l.latest()).toBeNull();
  });
});

describe("F2-5-R1 — «paid» typed vs stored, through the service's own parser", () => {
  const usd = (text: string) => parseDecimal(text, "USD");
  it("«2», «2.0», «2.00» and « 2 » are CLEAN when 2.00 is stored (the false exit prompt)", () => {
    for (const typed of ["2", "2.0", "2.00", " 2 "]) expect(isTypedPaidUnsaved(typed, "200", usd)).toBe(false);
  });
  it("a different amount, or text the service would refuse, stays UNSAVED", () => {
    for (const typed of ["2.01", "3", "2.005", "2,00", "-2", "abc", "2e0"]) expect(isTypedPaidUnsaved(typed, "200", usd)).toBe(true);
  });
  it("empty means 0, as the service reads a cleared field", () => {
    expect(isTypedPaidUnsaved("", "0", usd)).toBe(false);
    expect(isTypedPaidUnsaved(null, "0", usd)).toBe(false);
    expect(isTypedPaidUnsaved("", "200", usd)).toBe(true);
  });
});

describe("InvoiceSheet wiring (source, comments stripped)", () => {
  const SHEET = readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\}/g, "{}");

  it("every blur-driven save goes through `background`, never through `run` (which sets busy)", () => {
    expect(SHEET).toMatch(/const header = \(patch: InvoiceHeaderPatch\) =>\s*background\(/);
    expect(SHEET).toMatch(/const applyTax = \([^)]*\) =>\s*background\(/);
    expect(SHEET).toMatch(/const editLine = \([^)]*\) =>\s*background\(/);
    const bg = SHEET.slice(SHEET.indexOf("const background ="), SHEET.indexOf("const act ="));
    expect(bg.length).toBeGreaterThan(0);
    expect(bg).not.toMatch(/setBusy/);
  });

  // TRANSITION (INV-LINE-EDIT-FAIL v3, Finding B): an existing-line blur is now `isTouched(…) && editLine(…)` — the
  // guard is skipped here and the CALLED function is still asserted to be header / applyTax / editLine.
  // TRANSITION (CURRENCY-P1, Finding C): the paid blur is now a block — `paidDecision()` then `void header({ paid: … })`
  // or `markSaved(["paid"])` — so it is asserted separately below; the other blurs keep the one-call shape (8 of them).
  it("every onBlur in the sheet calls header / applyTax / editLine — none calls run or setBusy", () => {
    const blurs = [...SHEET.matchAll(/onBlur=\{\(e\) =>\s*(?:void\s+)?(?:isTouched\([^)]*\) &&\s*)?(\w+)\(/g)].map((m) => m[1]);
    expect(blurs.length).toBeGreaterThanOrEqual(8);
    for (const fn of blurs) expect(["header", "applyTax", "editLine"]).toContain(fn);
    const paidBlur = SHEET.match(/onBlur=\{\(e\) => \{\s*const decision = paidDecision\(\);([\s\S]*?)\}\}/);
    expect(paidBlur).not.toBeNull();
    expect(paidBlur![1]).toMatch(/if \(decision === "send"\) void header\(\{ paid: /);
    // TRANSITION (R2): "omit" and "resolve" both mean "screen and store agree" — both resolve a paid refusal.
    expect(paidBlur![1]).toMatch(/else markSaved\(\["paid"\]\);/);
    expect(paidBlur![1]).not.toMatch(/\brun\(|setBusy/);
  });

  const ACTIONS = [
    "account-change",
    "account-unlink",
    "account-choose",
    "add-row",
    "finalize",
    "save-draft",
    "leave-draft",
    "exit-save",
    "finalize-confirm-yes",
    "discard-confirm-yes",
  ];
  for (const id of ACTIONS) {
    it(`button ${id} runs through the queue (act), so it waits for pending saves and ignores a second press`, () => {
      const at = SHEET.indexOf(`data-testid="${id}"`);
      expect(at).toBeGreaterThan(0);
      const open = SHEET.lastIndexOf("<button", at);
      const tag = SHEET.slice(open, at);
      expect(tag).toMatch(/onClick=\{\(\) => act\(/);
    });
  }

  it("the line «remove» button and the customer finder's pick also go through act", () => {
    expect(SHEET).toMatch(/onClick=\{\(\) => act\(\(\) => removeLine\(l\.id\)\)\}/);
    // TRANSITION (R5): the finder is closed through `closeModal` (the ref is cleared at once), then the pick is an action.
    expect(SHEET).toMatch(/closeModal\("customer", \(\) => setFindingCustomer\(false\)\);\s*act\(\(\) => chooseAccount\(c\)\);/);
  });

  it("F2-5-R1: the exit decision reads the NEWEST stored row (viewRef), never the render the handler came from", () => {
    for (const fn of ["const storedDisplay =", "const taxDirty =", "const isDirty ="]) {
      const at = SHEET.indexOf(fn);
      expect(at).toBeGreaterThan(0);
      const body = SHEET.slice(at, SHEET.indexOf("\n  };", at));
      expect(body).toMatch(/viewRef\.current/);
      expect(body).not.toMatch(/\bview\?\.invoice/);
      expect(body).not.toMatch(/\bsnapshot\b/);
    }
  });

  it("F2-5-R1: the separate «إلغاء» (sheet-close) also waits on the queue for an editable draft", () => {
    expect(SHEET).toMatch(/onClick=\{readOnly \? onClosed : \(\) => act\(leave\)\} data-testid="sheet-close"/);
  });

  // TRANSITION ×2 (INV-LINE-EDIT-FAIL): v2 asserted line edits were NOT tracked (`…, null)`); line-v1 tracked them
  // per LINE (`[`line:${lineId}`]`), which Abu Abbas's L-R1 broke. They are tracked per FIELD now, and a line
  // success resolves by VALUE (`resolveOnSuccess`), never by clearing the keys it did not carry.
  it("F2-5-R2 + INV-LINE-EDIT-FAIL: header, tax and existing-line refusals go to the failure ledger, lines per FIELD", () => {
    expect(SHEET).toMatch(/background\(\(\) => call\(pos\(\)\.updateInvoiceHeader\(\{ invoiceId, patch \}\)\), Object\.keys\(patch\)\)/);
    expect(SHEET).toMatch(/\["tax"\],\s*\);/);
    expect(SHEET).toMatch(
      /background\(\s*\(\) => call\(pos\(\)\.updateInvoiceLine\(\{ invoiceId, lineId, line \}\)\),\s*\[lineKey\(lineId, touched\)\],\s*\(e\) => `\$\{t\("inv\.sheet\.lineEditUnsaved"\)\} \$\{errorText\(e\)\}`,/,
    );
    const bg = SHEET.slice(SHEET.indexOf("const background ="), SHEET.indexOf("const unresolvedLineEdit ="));
    expect(bg).toMatch(/markRefused\(failureKeys, describe\(e\)\)/);
    expect(bg).toMatch(/if \(resolveOnSuccess\) resolveOnSuccess\(next\);\s*else if \(failureKeys\) markSaved\(failureKeys\);/);
  });

  it("F2-5-R2: successful writes of the same fields resolve refusals — flushHeader, flushTax and the account link", () => {
    const flush = SHEET.slice(SHEET.indexOf("const flushHeader ="), SHEET.indexOf("const storedDisplay ="));
    // TRANSITION (CURRENCY-P1): an untouched paid field is no longer in the patch; a typed-but-equal one is resolved too.
    expect(flush).toMatch(/markSaved\(paidResolved \? \[\.\.\.Object\.keys\(patch\), "paid"\] : Object\.keys\(patch\)\)/);
    const tax = SHEET.slice(SHEET.indexOf("const flushTax ="), SHEET.indexOf("const prepareFinalize ="));
    expect(tax).toMatch(/markSaved\(\["tax"\]\)/);
    expect(SHEET).toMatch(/markSaved\(\["customerPartyId", \.\.\.Object\.keys\(fill\)\]\)/);
  });

  it("F2-5-R2: the sheet shows the action error, else the newest unresolved refusal — the container renders for either", () => {
    expect(SHEET).toMatch(/const shownError = error \?\? unresolvedFailure\(\);/);
    expect(SHEET).toMatch(/\{\(shownError \|\| logoWarning \|\| logoUnverified\) && \(/);
    expect(SHEET).toMatch(/\{shownError && <p className="error" data-testid="sheet-error">\{shownError\}<\/p>\}/);
  });

  it("the header-save IPC contract is unchanged: blur still sends ONE key per field through updateInvoiceHeader", () => {
    // TRANSITION (CURRENCY-P1): `paid` is asserted after the loop — its blur sends through `header` only when it sends.
    expect(SHEET).toMatch(/if \(decision === "send"\) void header\(\{ paid: e\.target\.value\.trim\(\) === "" \? null : e\.target\.value \}\);/);
    for (const key of ["customerName", "customerAddress", "customerPhone", "notes"]) {
      expect(SHEET).toMatch(new RegExp(`onBlur=\\{\\(e\\) => void header\\(\\{ ${key}: `));
    }
    expect(SHEET).toMatch(/pos\(\)\.updateInvoiceHeader\(\{ invoiceId, patch \}\)/);
  });
});

describe("INV-LINE-EDIT-FAIL v2 — screen vs store, through the service's OWN line parsers", () => {
  const P = {
    cleanText: (v: string) => cleanText(v, "description", Number.MAX_SAFE_INTEGER),
    quantityMilli: (v: string) => parseInvoiceQuantity(v),
    priceMinor: (v: string) => parseDecimal(v.trim(), "USD").minor,
  };
  const stored = { description: "بند 1", quantityMilli: 1000, unitPriceMinor: "100" };
  it("L-R1: the refused «9» does NOT match the stored 1.00 — a description success cannot make it match", () => {
    expect(lineInputMatchesStored("unitPrice", "9", stored, P)).toBe(false);
  });
  it("the stored price in any form the service reads the same — «1», «1.0», «1.00», « 1.00 » — matches", () => {
    for (const v of ["1", "1.0", "1.00", " 1.00 "]) expect(lineInputMatchesStored("unitPrice", v, stored, P)).toBe(true);
  });
  it("anything the service would refuse never matches (no guessed success)", () => {
    for (const v of ["", "abc", "1.005", "-1", "1e0", "1,00"]) expect(lineInputMatchesStored("unitPrice", v, stored, P)).toBe(false);
    for (const v of ["", "x", "-1"]) expect(lineInputMatchesStored("quantity", v, stored, P)).toBe(false);
  });
  it("quantity by value («1», «1.0», «1.000») and description after the service's trim", () => {
    for (const v of ["1", "1.0", "1.000"]) expect(lineInputMatchesStored("quantity", v, stored, P)).toBe(true);
    expect(lineInputMatchesStored("quantity", "2", stored, P)).toBe(false);
    expect(lineInputMatchesStored("description", "  بند 1  ", stored, P)).toBe(true);
    expect(lineInputMatchesStored("description", "بند 2", stored, P)).toBe(false);
    expect(lineInputMatchesStored("description", "   ", { ...stored, description: null }, P)).toBe(true);
  });
  it("ledger: per-field keys of one line are independent; keysWithPrefix scopes to exactly that line", () => {
    const l = createFailureLedger();
    l.refused(["line:l1:unitPrice"], "price refused");
    l.refused(["line:l1:quantity"], "qty refused");
    l.refused(["line:l10:unitPrice"], "other line");
    l.saved(["line:l1:quantity"]); // the same line's OTHER field accepted
    expect(l.has("line:l1:unitPrice")).toBe(true);
    expect(l.keysWithPrefix("line:l1:")).toEqual(["line:l1:unitPrice"]); // `line:l1:` never matches `line:l10:`
    l.saved(l.keysWithPrefix("line:l1:")); // the line removed
    expect(l.latestFor("line:")).toBe("other line");
  });
});

describe("INV-LINE-EDIT-FAIL — a refused edit to an existing line stays unresolved until THAT line is saved", () => {
  it("an unrelated successful header save does not resolve a line refusal", () => {
    const l = createFailureLedger();
    l.refused(["line:l1"], "line refused");
    l.saved(["customerName"]);
    l.saved(["invoiceDate", "customerName", "customerAddress", "customerPhone", "notes", "paid"]); // a full flushHeader
    l.saved(["tax"]);
    expect(l.latestFor("line:")).toBe("line refused");
  });
  it("a header refusal is not a line refusal, and a line refusal is found among others", () => {
    const l = createFailureLedger();
    l.refused(["customerName"], "name refused");
    expect(l.latestFor("line:")).toBeNull();
    l.refused(["line:l2"], "line 2 refused");
    l.refused(["tax"], "tax refused");
    expect(l.latestFor("line:")).toBe("line 2 refused");
    expect(l.latest()).toBe("tax refused");
  });
  it("retry: a successful save of the SAME line clears only that line; another refused line still blocks", () => {
    const l = createFailureLedger();
    l.refused(["line:l1"], "line 1 refused");
    l.refused(["line:l2"], "line 2 refused");
    l.saved(["line:l2"]);
    expect(l.latestFor("line:")).toBe("line 1 refused");
    l.saved(["line:l1"]);
    expect(l.latestFor("line:")).toBeNull();
  });
});

describe("INV-LINE-EDIT-FAIL wiring (source, comments stripped)", () => {
  const SHEET = readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const body = (start: string, end: string) => {
    const a = SHEET.indexOf(start);
    expect(a, start).toBeGreaterThan(0);
    return SHEET.slice(a, SHEET.indexOf(end, a));
  };
  // v2: every guard runs the value-level sweep (`verifyLines`), not just the ledger read.
  const GUARD = /const lineRefusal = verifyLines\(\);\s*if \(lineRefusal !== null\) \{\s*setError\(lineRefusal\);\s*return( next)?;\s*\}/;

  it("ISSUE: prepareFinalize and finalize refuse BEFORE anything else while a line edit is unresolved", () => {
    const prep = body("const prepareFinalize = async () => {", "setBusy(true);");
    expect(prep).toMatch(GUARD);
    const fin = body("const finalize = async () => {", "setConfirming(false);");
    expect(fin).toMatch(/if \(!payReady\) return;/);
    expect(fin).toMatch(GUARD);
  });

  it("SAVE: «محفوظة» is never set while a line edit is unresolved — the guard sits right before setSaved(true)", () => {
    const save = body("const saveDraft = () => {", "\n  };");
    const guard = save.search(GUARD);
    expect(guard).toBeGreaterThan(0);
    expect(save.indexOf("setSaved(true)")).toBeGreaterThan(guard);
  });

  it("LEAVE: isDirty counts an unresolved line edit, and «حفظ وخروج» refuses before onClosed()", () => {
    expect(body("const isDirty = (): boolean => {", "\n  };")).toMatch(/if \(verifyLines\(\) !== null\) return true;/);
    const sal = body("const saveAndLeave = async () => {", "\n  };");
    const guard = sal.search(GUARD);
    expect(guard).toBeGreaterThan(0);
    expect(sal.indexOf("onClosed()")).toBeGreaterThan(guard);
  });

  it("removing a line resolves every field of THAT line; the ledger query is by the line: prefix", () => {
    expect(body("const removeLine = (lineId: string) =>", "\n  const ")).toMatch(/markSaved\(saveFailures\.keysWithPrefix\(`line:\$\{lineId\}:`\)\)/);
    expect(SHEET).toMatch(/const unresolvedLineEdit = \(\): string \| null => saveFailures\.latestFor\("line:"\);/);
  });

  it("L-R1: every existing-line write names the ONE thing it carries; success resolves by value plus its own unit/pick", () => {
    for (const touched of ["description", "quantity", "unit", "unitPrice", "pick"]) {
      // TRANSITION (R5): the picker's write also names the dialog it comes from (`, "picker"`), so it passes the gate.
      expect(SHEET, touched).toMatch(new RegExp(`\\}, "${touched}"(, "picker")?\\)`));
    }
    // TRANSITION (R5): the signature now spans lines (it gained the `by` origin), so the anchor is its name.
    const edit = body("const editLine = (", "\n  const ");
    expect(edit).toMatch(/if \(touched === "unit" \|\| touched === "pick"\) markSaved\(\[lineKey\(lineId, touched\)\]\);/);
    expect(edit).toMatch(/reconcileLineInputs\(next\.lines\.filter\(\(l\) => l\.id === lineId\)\);/);
  });

  it("the sweep checks the sheet's own default rendering FIRST (no false block on a 3-decimal currency), then the parsers", () => {
    const rec = body("const reconcileLineInputs =", "\n  };");
    // TRANSITION (v3, Finding B): the shortcut is now `!touched && …` — v2's unconditional form hid a refused edit.
    expect(rec).toMatch(/const unchanged = !touched && input\.value === defaultLineText\(line, field\);/);
    expect(rec).toMatch(/if \(unchanged \|\| lineInputMatchesStored\(field, input\.value, storedOf\(line\), LINE_PARSERS\)\) \{\s*markSaved\(\[key\]\);/);
    expect(rec).toMatch(/else if \(!saveFailures\.has\(key\)\) markRefused\(\[key\], t\("inv\.sheet\.lineEditUnverified"\)\);/);
    expect(body("const verifyLines = (): string | null => {", "\n  };")).toMatch(/reconcileLineInputs\(viewRef\.current\?\.lines \?\? \[\]\);/);
  });

  it("L-R2: the rejected input keeps its value, is aria-invalid and described by its own note; «تراجع» goes through act", () => {
    for (const field of ["description", "quantity", "unitPrice"]) {
      // TRANSITION (v3): `onInput={touchLineInput(…)}` now sits between the ref and the unsaved props.
      expect(SHEET, field).toMatch(new RegExp(`ref=\\{bindLineInput\\(l\\.id, "${field}"\\)\\}\\s*onInput=\\{touchLineInput\\(l\\.id, "${field}"\\)\\}\\s*\\{\\.\\.\\.unsavedInputProps\\(l, "${field}"\\)\\}`));
      expect(SHEET, field).toMatch(new RegExp(`\\{unsavedNote\\(l, "${field}"\\)\\}`));
    }
    expect(SHEET).toMatch(/\{ "aria-invalid": true as const, "aria-describedby": `unsaved-\$\{line\.id\}-\$\{field\}` \}/);
    expect(SHEET).toMatch(/id=\{`unsaved-\$\{line\.id\}-\$\{field\}`\} data-testid="line-unsaved"/);
    expect(SHEET).toMatch(/onClick=\{\(\) => act\(\(\) => revertLineField\(line, field\)\)\}/);
    expect(SHEET).not.toMatch(/value=\{[^}]*\}\s*onBlur/); // inputs stay uncontrolled: nothing resets the typed value
  });

  it("L-R2: while any line shows an unsaved value the totals say they are the STORED values, and line totals point there", () => {
    expect(SHEET).toMatch(/\{view\.lines\.some\(lineHasUnsaved\) && \(\s*<p className="notice" role="note" id="totals-saved-only" data-testid="totals-saved-only">/);
    expect(SHEET).toMatch(/\{\.\.\.\(lineHasUnsaved\(l\) \? \{ "aria-describedby": "totals-saved-only" \} : \{\}\)\}/);
  });

  it("the dedicated sentence exists in Arabic and English, and the Arabic one is Arabic", async () => {
    const { translate } = await import("../../src/shared/i18n");
    const ar = translate("ar", "inv.sheet.lineEditUnsaved");
    const en = translate("en", "inv.sheet.lineEditUnsaved");
    expect(ar).not.toBe("inv.sheet.lineEditUnsaved");
    expect(en).not.toBe("inv.sheet.lineEditUnsaved");
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(en).toMatch(/^[\x20-\x7E]+$/);
  });

  it("L-R2: the new sentences exist in both languages; «{saved}» is in both unsaved notes; the Revert label matches", async () => {
    const { translate } = await import("../../src/shared/i18n");
    for (const key of ["inv.sheet.lineEditUnverified", "inv.sheet.totalsSavedOnly", "inv.line.unsaved", "inv.line.revert"]) {
      expect(translate("ar", key), key).not.toBe(key);
      expect(translate("en", key), key).not.toBe(key);
      expect(translate("ar", key), key).toMatch(/[؀-ۿ]/);
    }
    expect(translate("ar", "inv.line.unsaved")).toContain("{saved}");
    expect(translate("en", "inv.line.unsaved")).toContain("{saved}");
    // The unverified sentence names the button by its own label, in each language.
    expect(translate("ar", "inv.sheet.lineEditUnverified")).toContain(`«${translate("ar", "inv.line.revert")}»`);
    expect(translate("en", "inv.sheet.lineEditUnverified")).toContain(`«${translate("en", "inv.line.revert")}»`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// INV-LINE-EDIT-FAIL v3 — Abu Abbas's v2 review, Findings A and B. Every test below FAILS on v2 (stated per test).
// The behaviour is also proven by ordering-controlled screen scenarios (`scenarios-v3.mjs`, ?holdHeader=N), since
// there is no DOM test environment here.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("v3 Finding B — the 3-decimal facts the fix relies on (service's own money functions)", () => {
  it("[fails on v2: n/a — pins the domain] a stored 0.100 JOD written back through formatDecimal parses to the SAME minor units", () => {
    for (const [minor, cur, text] of [[100n, "JOD", "0.100"], [100n, "KWD", "0.100"], [100n, "USD", "1.00"], [12345n, "JOD", "12.345"]] as const) {
      expect(formatDecimal(money(minor, cur))).toBe(text);
      expect(parseDecimal(formatDecimal(money(minor, cur)), cur).minor).toBe(minor);
    }
  });
  it("the lossy 2-decimal rendering of 0.100 JOD («1.00») is a DIFFERENT amount (1.000) — so it can never stand in for the stored value", () => {
    expect(parseDecimal("1.00", "JOD").minor).toBe(1000n);
    const jod = { cleanText: (v: string) => cleanText(v, "d", 9999), quantityMilli: (v: string) => parseInvoiceQuantity(v), priceMinor: (v: string) => parseDecimal(v.trim(), "JOD").minor };
    expect(lineInputMatchesStored("unitPrice", "1.00", { description: null, quantityMilli: 1000, unitPriceMinor: "100" }, jod)).toBe(false);
  });
});

describe("v3 wiring (source, comments stripped) — every test here FAILS on v2", () => {
  const SHEET = readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const between = (start: string, end: string) => {
    const a = SHEET.indexOf(start);
    expect(a, start).toBeGreaterThan(0);
    const b = SHEET.indexOf(end, a);
    expect(b, end).toBeGreaterThan(a);
    return SHEET.slice(a, b);
  };
  const LATE = /const lateLineRefusal = verifyLines\(\);\s*if \(lateLineRefusal !== null\) \{\s*setError\(lateLineRefusal\);\s*return;\s*\}/;

  it("A: prepareFinalize re-verifies lines AFTER its flushes and BEFORE the confirmation is offered", () => {
    // TRANSITION (R4): the confirmation now opens through the one-modal gate (`openModal("confirm", …)`).
    const body = between("const prepareFinalize = async () => {", 'openModal("confirm", () => setConfirming(true)');
    const flushed = body.indexOf("await flushHeader();");
    const late = body.search(LATE);
    expect(flushed).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(flushed);
  });

  it("A: finalize re-verifies lines AFTER its flushes and BEFORE the irreversible finalizeInvoice call", () => {
    const body = between("const finalize = async () => {", "pos().finalizeInvoice({");
    const flushed = body.lastIndexOf("await flushHeader();");
    const late = body.search(LATE);
    expect(flushed).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(flushed);
  });

  it("A: every existing-line input and the unit select are locked while an action is in flight", () => {
    const rows = between("{view.lines.map((l) => (", "{view.lines.length === 0 && draftRows.length === 0 && (");
    expect((rows.match(/disabled=\{readOnly \|\| busy\}/g) ?? []).length).toBe(4);
    expect(rows).not.toMatch(/disabled=\{readOnly\}/);
  });

  it("A: the header inputs, the tax rate and the paid amount are locked while an action is in flight", () => {
    // TRANSITION (CURRENCY-P1 R3): the section now carries `inert={confirming}` (background locked while the issue
    // confirmation is open); the four header locks below are unchanged.
    // TRANSITION (R4): and since R4 `inert={modalOpen}` — locked while ANY modal is open, not only the confirmation.
    const header = between('<section className="inv-customer" inert={modalOpen}>', '<div className="field wide inv-account"');
    expect((header.match(/disabled=\{readOnly \|\| busy\}/g) ?? []).length).toBe(4);
    expect(SHEET).toMatch(/defaultValue=\{taxRate\}\s*disabled=\{busy\}/);
    // TRANSITION (CURRENCY-P1): the paid rendering now names its currency; the lock is unchanged.
    expect(SHEET).toMatch(/defaultValue=\{inv\.paid\.minor === "0" \? "" : paidText\(inv\.paid\.minor, inv\.paid\.currency\)\}\s*disabled=\{busy\}/);
  });

  it("B: the display shortcut applies only to an input NOBODY typed into; a touched input must match by value", () => {
    const rec = between("const reconcileLineInputs =", "\n  };");
    expect(rec).toMatch(/const touched = isTouched\(line\.id, field\);/);
    expect(rec).toMatch(/const unchanged = !touched && input\.value === defaultLineText\(line, field\);/);
  });

  it("B: typing marks an input touched; blur writes ONLY a touched input (focus alone never sends the lossy rendering)", () => {
    for (const field of ["description", "quantity", "unitPrice"]) {
      expect(SHEET, field).toMatch(new RegExp(`onInput=\\{touchLineInput\\(l\\.id, "${field}"\\)\\}`));
      expect(SHEET, field).toMatch(new RegExp(`onBlur=\\{\\(e\\) =>\\s*isTouched\\(l\\.id, "${field}"\\) &&\\s*editLine\\(`));
    }
  });

  it("B: touched is cleared only when the value is confirmed stored, on «تراجع», or when the line is removed", () => {
    const deletes = SHEET.match(/touchedLineInputs\.current\.delete\(/g) ?? [];
    expect(deletes.length).toBe(3);
    expect(between("const reconcileLineInputs =", "\n  };")).toMatch(/markSaved\(\[key\]\);\s*touchedLineInputs\.current\.delete/);
    expect(between("const revertLineField =", "\n  };")).toMatch(/touchedLineInputs\.current\.delete/);
    expect(between("const removeLine = (lineId: string) =>", "\n  const ")).toMatch(/touchedLineInputs\.current\.delete/);
  });

  it("B: a whole-line write carries the STORED price exactly (formatDecimal at the currency's exponent), never priceText", () => {
    const rows = between("{view.lines.map((l) => (", "{view.lines.length === 0 && draftRows.length === 0 && (");
    expect((rows.match(/unitPrice: storedPriceForWrite\(l\),/g) ?? []).length).toBe(3);
    expect(rows).not.toMatch(/unitPrice: priceText\(/);
    expect(SHEET).toMatch(/function storedPriceForWrite\(line: InvoiceLineDto\): string \{\s*return formatDecimal\(money\(BigInt\(line\.unitPrice\.minor\), line\.unitPrice\.currency\)\);\s*\}/);
  });
});
