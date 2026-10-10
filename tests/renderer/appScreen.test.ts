/**
 * Which screen the shell shows — the ORDER of two decisions, and the defect that order caused.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS PROTECTS. `App.tsx` used to ask `if (setup !== null)` before looking at the session,
 * and never cleared `setup`. So completing mandatory setup set the cashier and then re-rendered
 * SetupScreen anyway, forever. On the FIRST RUN of every installation and every upgrade, an operator
 * would type their real name and PIN, press the button, watch nothing happen, and only get in by
 * restarting the app — at which point `currentCashier()` answered with the session they already had.
 *
 * 🔴 AND IT IS A TRANSITION, NOT AN INVARIANT. Before migration 8 there was no setup screen at all,
 * so this ordering could not be wrong; `screenFor` did not exist. The old behaviour was
 * `setup !== null` winning unconditionally, and that is the value being replaced here.
 *
 * All 717 unit tests passed through the defect, because it lived in the order of two early returns
 * in a component this repository has no DOM harness to mount. `e2e/operator-accounts.mjs` is what
 * caught it, on the first Windows gate this branch ever ran. The decision is now a pure exported
 * function precisely so the next regression is caught here, in milliseconds, instead of there.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { type Screen, screenFor } from "../../src/renderer/App";

const SESSION = { id: "cashier-01", name: "Cashier One", role: "owner" } as const;
const TICKET = { ticket: "t-abc", name: "Cashier One" } as const;

describe("screenFor", () => {
  it("waits before it decides anything — undefined means the question is unanswered", () => {
    expect(screenFor(undefined, null)).toBe<Screen>("loading");
    // Even with a ticket in hand: a half-known state must never render a screen it may have to
    // replace a frame later.
    expect(screenFor(undefined, TICKET)).toBe<Screen>("loading");
  });

  it("offers the login screen when nobody is signed in and nothing is pending", () => {
    expect(screenFor(null, null)).toBe<Screen>("login");
  });

  it("demands setup when a ticket exists and there is NO session", () => {
    expect(screenFor(null, TICKET)).toBe<Screen>("setup");
  });

  it("🔴 A LIVE SESSION WINS OVER AN OUTSTANDING TICKET — the defect this function exists for", () => {
    // This is the exact state the renderer is in the instant completeBootstrapSetup returns:
    // `setup` is still the ticket that got us here, and `cashier` is the brand-new session.
    // The old code answered "setup" here and stranded the operator.
    expect(screenFor(SESSION, TICKET)).toBe<Screen>("app");
  });

  it("and shows the till for a session with no ticket, which is every ordinary login", () => {
    expect(screenFor(SESSION, null)).toBe<Screen>("app");
  });

  it("treats undefined and null alike for the ticket — absent is absent", () => {
    expect(screenFor(null, undefined)).toBe<Screen>("login");
    expect(screenFor(SESSION, undefined)).toBe<Screen>("app");
  });

  it("🔴 never answers 'setup' for any state that carries a session", () => {
    // Exhaustive over the shape: whatever the ticket is, a session means the ticket is spent.
    for (const ticket of [null, undefined, TICKET, { ticket: "", name: "" }]) {
      expect(screenFor(SESSION, ticket)).toBe<Screen>("app");
    }
  });

  it("🔴 and never answers 'app' without one", () => {
    for (const ticket of [null, undefined, TICKET]) {
      expect(screenFor(null, ticket)).not.toBe<Screen>("app");
      expect(screenFor(undefined, ticket)).not.toBe<Screen>("app");
    }
  });
});
