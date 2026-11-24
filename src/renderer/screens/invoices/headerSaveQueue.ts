/**
 * INV-FIRST-CLICK (F2-5): the invoice sheet's ordering of background saves and operator actions.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS EXISTS FOR. Every header field saves on blur. That save used to set the
 * sheet's `busy` flag, and eleven buttons carry `disabled={busy}`. A mouse press on a button moves
 * focus first, so the field's blur ran, `busy` became true and was committed before the mouse was
 * released, and the button the merchant was pressing was disabled before its click arrived. The click
 * was silently lost: «إصدار», «حفظ», «خروج», «اختيار حساب» and «+ سطر» all needed a second press after
 * typing. Measured in a screen-only Chromium harness on the frozen candidate: 0 of 50 single clicks.
 *
 * THE RULE NOW, in two halves:
 *   · A background save (a blur, a unit change, the tax switch) NEVER disables anything. It is
 *     queued, so two saves never overlap and arrive in the order the operator made them.
 *   · An operator action (a button) WAITS for every save queued before it, then runs, and runs
 *     once: a second press while one is waiting or running is ignored, which is what `disabled`
 *     used to provide.
 *
 * 🔴 A FAILED SAVE STOPS THE ACTION THAT WAS WAITING FOR IT. The failure has already been shown to
 * the operator by the save itself; carrying on would issue, save or leave over a value that was
 * refused, as if it had been stored. Only saves that were still pending when the button was
 * pressed count: a refusal the operator has already seen and moved past does not block for ever,
 * and the action's own flush re-sends what is typed and is refused again if it is still invalid.
 *
 * Pure TypeScript, no React, so the ordering can be tested without a DOM.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

export type ActionOutcome = "ran" | "ignored" | "blocked";

export interface SaveQueue {
  /**
   * Queues a background save after every earlier step. Resolves `true` when it succeeded and `false`
   * when it threw — it never rejects, so a `void` caller cannot leak an unhandled rejection. The
   * operation is responsible for showing its own failure.
   */
  save(op: () => Promise<unknown>): Promise<boolean>;
  /**
   * Runs an operator action after every save queued before it.
   *   · "ignored" — another action is already waiting or running (a double press);
   *   · "blocked" — a save that was pending at the press failed; `op` was not called;
   *   · "ran"     — `op` was called (its own errors are its own to show; they propagate).
   * Saves queued while the action runs wait for it.
   */
  action(op: () => Promise<void> | void): Promise<ActionOutcome>;
  /** True from the press until the action settles. */
  readonly acting: boolean;
}

export function createSaveQueue(): SaveQueue {
  // The tail never rejects: every link settles it with `undefined`.
  let tail: Promise<void> = Promise.resolve();
  let nextId = 0;
  const pending = new Set<number>();
  const failed = new Set<number>();
  let acting = false;

  return {
    save(op) {
      const id = nextId++;
      pending.add(id);
      const run = tail.then(async () => {
        try {
          await op();
          return true;
        } catch {
          failed.add(id);
          return false;
        } finally {
          pending.delete(id);
        }
      });
      tail = run.then(() => undefined);
      return run;
    },

    async action(op) {
      if (acting) return "ignored";
      acting = true;
      // Decided at the press, synchronously: exactly the saves the operator's own gesture is racing.
      const waitFor = [...pending];
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await prior;
        if (waitFor.some((id) => failed.has(id))) return "blocked";
        await op();
        return "ran";
      } finally {
        for (const id of waitFor) failed.delete(id);
        acting = false;
        release();
      }
    },

    get acting() {
      return acting;
    },
  };
}

/**
 * F2-5-R2 (Abu Abbas's review): which background-save refusals are still UNRESOLVED, by field.
 *
 * 🔴 A LATER SUCCESS MUST NOT ERASE AN EARLIER REFUSAL. A refused name followed by an accepted phone
 * used to leave the sheet silent, because every save cleared the one error string as it started. A
 * refusal stays here until a save of the SAME field succeeds, and the newest one is what is shown.
 */
export interface FailureLedger {
  /** Records a refusal for these fields; the newest refusal becomes the one `latest()` returns. */
  refused(keys: readonly string[], message: string): void;
  /** Clears these fields' refusals. Returns true when anything was cleared. */
  saved(keys: readonly string[]): boolean;
  /** The newest unresolved refusal's message, or null. */
  latest(): string | null;
  /** INV-LINE-EDIT-FAIL: the newest unresolved refusal whose field key starts with `prefix`, or null. */
  latestFor(prefix: string): string | null;
  /** INV-LINE-EDIT-FAIL v2: is this exact field key unresolved? */
  has(key: string): boolean;
  /** INV-LINE-EDIT-FAIL v2: every unresolved key starting with `prefix`. */
  keysWithPrefix(prefix: string): string[];
}

export function createFailureLedger(): FailureLedger {
  const byKey = new Map<string, string>();
  return {
    refused(keys, message) {
      for (const k of keys) {
        byKey.delete(k); // re-inserted so insertion order = recency
        byKey.set(k, message);
      }
    },
    saved(keys) {
      let changed = false;
      for (const k of keys) changed = byKey.delete(k) || changed;
      return changed;
    },
    latest() {
      let last: string | null = null;
      for (const message of byKey.values()) last = message;
      return last;
    },
    latestFor(prefix) {
      let last: string | null = null;
      for (const [key, message] of byKey) if (key.startsWith(prefix)) last = message;
      return last;
    },
    has(key) {
      return byKey.has(key);
    },
    keysWithPrefix(prefix) {
      return [...byKey.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

/**
 * F2-5-R1 (pre-existing on the frozen baseline): is the typed «paid» amount NOT what is stored?
 *
 * The «paid» input is uncontrolled, so after «2» is saved it still reads «2» while the stored row displays
 * «2.00»; comparing TEXT called a saved draft unsaved and «خروج» asked again. `parse` must be the service's
 * own parser (`parseDecimal`, which `invoiceService.ts` applies to `paid.trim()`), so «2», «2.0» and «2.00»
 * are clean when 2.00 is stored, while a different amount or anything the service would refuse stays
 * unsaved. Empty means 0, as the service reads a cleared field.
 */
export function isTypedPaidUnsaved(
  typedPaid: string | null,
  storedMinor: string,
  parse: (text: string) => { readonly minor: bigint },
): boolean {
  const text = (typedPaid ?? "").trim();
  if (text === "") return storedMinor !== "0";
  try {
    return parse(text).minor !== BigInt(storedMinor);
  } catch {
    return true;
  }
}

/**
 * CURRENCY-P1 / Finding C, corrected in R2 (Abu Abbas P1-1): what a blur, a full header flush, the exit check and the
 * late pre-issue/pre-"saved" checks do with the paid field. Decided from the VISIBLE VALUE ONLY — never from events.
 *   · "omit"    — the visible text IS the sheet's own rendering of the stored amount (`storedRendering`, rendered at
 *                 the currency's exponent). Nothing is sent: this is how an untouched field is recognised, and it is
 *                 never written back (Finding C). Any earlier paid refusal is resolved — screen and store agree;
 *   · "resolve" — different text, same amount when parsed in the invoice currency ("5" for a stored 5.00): nothing
 *                 is sent, any earlier refusal is resolved;
 *   · "send"    — a different amount, a cleared field, or unparseable text (the service then stores or refuses it).
 *
 * 🔴 R2: NO TOUCH FLAG. Phase 1 decided "untouched" from an `input` event and returned "omit" WITHOUT LOOKING AT THE
 * VALUE. A value that changed with only a `change` event, or with no event at all, was therefore shown but never sent,
 * and Save said "saved", Leave closed without asking and Issue used the old amount (Abu Abbas P1-1). An event is a hint
 * about how a value changed; the value is the fact. Since Phase 1 the rendering is exact for every currency in the
 * table, so "visible text === own rendering of the stored amount" is a sufficient — and event-free — test of untouched.
 */
export type PaidWriteDecision = "omit" | "resolve" | "send";
export function paidWriteDecision(
  visible: string,
  storedRendering: string,
  storedMinor: string,
  parse: (text: string) => { readonly minor: bigint },
): PaidWriteDecision {
  if (visible === storedRendering) return "omit";
  return isTypedPaidUnsaved(visible.trim() === "" ? null : visible, storedMinor, parse) ? "send" : "resolve";
}

/** INV-LINE-EDIT-FAIL v2: the typed fields of an EXISTING invoice line (the unit is a props-controlled select). */
export type LineInputField = "description" | "quantity" | "unitPrice";

/** The stored line values `lineInputMatchesStored` compares against — exactly what the service returned. */
export interface StoredLineValues {
  readonly description: string | null;
  readonly quantityMilli: number;
  readonly unitPriceMinor: string;
}

/** The service's OWN parsers (`invoiceService.ts` `parseLine`), injected so this stays pure and testable. */
export interface LineParsers {
  readonly cleanText: (value: string) => string | null;
  readonly quantityMilli: (text: string) => number;
  readonly priceMinor: (text: string) => bigint;
}

/**
 * INV-LINE-EDIT-FAIL v2 (Abu Abbas L-R1): does what the merchant SEES in one line input equal what is STORED?
 *
 * 🔴 VALUE-LEVEL, NOT REQUEST-LEVEL. v1 cleared a line's refusal on ANY successful save of that line — and an
 * edit of the description is a successful save of the line that carries the STORED price, so a refused «9»
 * vanished while the input still read «9». A field's refusal is now resolved only when the value on screen
 * parses, through the service's own parser, to exactly the stored value: a successful retry of that field,
 * an explicit revert, or a later write that really stored it. Anything the service would refuse is "not
 * equal", so it stays unresolved. This never guesses a success.
 */
export function lineInputMatchesStored(
  field: LineInputField,
  shown: string,
  stored: StoredLineValues,
  parse: LineParsers,
): boolean {
  try {
    if (field === "description") return parse.cleanText(shown) === (stored.description === null ? null : parse.cleanText(stored.description));
    if (field === "quantity") return parse.quantityMilli(shown) === stored.quantityMilli;
    return parse.priceMinor(shown) === BigInt(stored.unitPriceMinor);
  } catch {
    return false;
  }
}
