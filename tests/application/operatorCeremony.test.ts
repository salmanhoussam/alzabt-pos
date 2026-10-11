/**
 * The install/upgrade ceremony, the temporary reset PIN, and the real PIN length.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * Three product rules closed on 2026-10-11 after an independent security review, each of which
 * exists because the previous behaviour was defensible in writing and unsafe in a shop:
 *
 * 1 · OWNER SETUP REQUIRED. The seeded bootstrap credentials are published in this repository, so
 *     a terminal that has been upgraded but not CLAIMED is claimable by whoever reaches it first —
 *     and whoever claims the owner row sets its PIN permanently, with no in-product recovery. The
 *     review measured the real shape of that window: not "the first login" but "until somebody
 *     takes it", with `listCashiers` advertising which name to click and the lockout available to
 *     hold the real owner out while it happens. So the window is closed by construction: until the
 *     bootstrap owner has claimed the terminal, nobody else gets a session OR a setup ticket.
 *
 * 2 · AN OWNER-SET PIN IS TEMPORARY. `setPin` used to hard-code `must_reset_pin = 0`, so a PIN the
 *     owner typed became that employee's permanent credential — and the owner could then sign in as
 *     them and ring a sale the ledger attributes to them. Impersonation inside the one record
 *     operator accounts exist to make trustworthy. `create` had always done this correctly, for the
 *     reason it states in its own comment; a reset is the same act performed later.
 *
 * 3 · SIX DIGITS, NOT FOUR. Measured, not disliked: scrypt at this product's fixed parameters runs
 *     ~41.8 ms per guess, so the whole four-digit space is ~418 seconds single-threaded, and the
 *     review recovered the seeded owner's `1111` from its real salt in 46 s. The hashes sit
 *     unencrypted in the ledger, readable by anyone with the physical access this product already
 *     assumes. Four digits was not a weak rule; it was no rule at all.
 *
 * 🔴 AND THE LEGACY CREDENTIALS MUST KEEP VERIFYING. 1111 and 2222 are four digits. If raising the
 * minimum had also governed verification, migration 8 would lock every upgrading shop out of its
 * own terminal on upgrade day. That asymmetry — four to TYPE at the door, six to CHOOSE in setup —
 * is the single most dangerous thing in this change, so it is asserted from both sides.
 *
 * Synthetic throughout. `cashier-01`/`cashier-02` and 1111/2222 are the product's own published
 * fixtures, which is why migration 8 and this ceremony exist at all.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatorService } from "../../src/application/operatorService";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from "../../src/domain/pinRule";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
let svc: OperatorService;
let operators: OperatorRepository;
let ids = 0;

const OWNER = { id: "cashier-01", name: "Cashier One", role: "owner" as const };
const OWNER_PIN = "431987";

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
  operators = new OperatorRepository(db);
  ids = 0;
  svc = new OperatorService({
    operators,
    audit: new AuditRepository(db, { appVersion: "0.1.1", schemaVersion: 8 }),
    transact: (fn) => db.transaction(fn).immediate(),
    terminal: FIXTURE_TERMINAL,
    now: () => new Date("2026-10-11T09:00:00.000Z"),
    newId: () => `id-${++ids}`,
  });
});
afterEach(() => {
  db.close();
  t.cleanup();
});

/** The owner claims the terminal. Every ordinary test needs this to have happened. */
function claimTerminal(pin = OWNER_PIN) {
  const outcome = svc.authenticate("cashier-01", "1111");
  if (outcome.kind !== "setup") throw new Error("expected setup");
  return svc.completeSetup(outcome.ticket, "حسين رقا", pin);
}

const flagOf = (id: string) => operators.findById(id)!.must_reset_pin;

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("1 · OWNER SETUP REQUIRED — the install/upgrade ceremony", () => {
  it("a freshly migrated terminal is in the state, and names the owner who must claim it", () => {
    const pending = operators.findBootstrapOwner();
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe("cashier-01");
    expect(pending!.role).toBe("owner");
    // 🔴 Asked in SQL, about the terminal's condition — not about a hardcoded id. The same question
    // answers correctly on a fresh install and on a real v7 -> v8 upgrade.
    expect(flagOf("cashier-01")).toBe(1);
    expect(flagOf("cashier-02")).toBe(1);
  });

  it("🔴 the OTHER operator cannot sign in at all — not even with the correct credential", () => {
    expect(() => svc.authenticate("cashier-02", "2222")).toThrow(/waiting for the shop owner/);
  });

  it("🔴 and cannot obtain a setup ticket, so it cannot begin its own setup either", () => {
    // There is no path to a ticket except `authenticate`, and that refused above. Proven from the
    // other side too: no ticket exists, so `completeSetup` has nothing to accept.
    expect(() => svc.completeSetup("f".repeat(48), "جعفر", "567812")).toThrow(/Sign in again/);
    expect(flagOf("cashier-02")).toBe(1);
  });

  it("🔴 a WRONG PIN still answers INVALID_CREDENTIALS — the state is not an enumeration oracle", () => {
    // The ceremony check sits AFTER credential verification on purpose: someone who cannot
    // authenticate learns nothing about the terminal, and nothing about who exists.
    expect(() => svc.authenticate("cashier-02", "999999")).toThrow(/Operator or PIN is incorrect/);
    expect(() => svc.authenticate("nobody-at-all", "1111")).toThrow(/Operator or PIN is incorrect/);
  });

  it("the owner MAY authenticate, and gets a setup ticket rather than a session", () => {
    const outcome = svc.authenticate("cashier-01", "1111");
    expect(outcome.kind).toBe("setup");
  });

  it("🔴 claiming the terminal clears the state permanently, and then the other operator may set up", () => {
    claimTerminal();
    expect(operators.findBootstrapOwner()).toBeNull();
    expect(flagOf("cashier-01")).toBe(0);

    // cashier-02 is still a bootstrap account, so it gets setup — but now it is allowed to.
    const second = svc.authenticate("cashier-02", "2222");
    expect(second.kind).toBe("setup");
    if (second.kind !== "setup") throw new Error("unreachable");
    svc.completeSetup(second.ticket, "جعفر صالح", "567812");
    expect(flagOf("cashier-02")).toBe(0);
    expect(svc.authenticate("cashier-02", "567812").kind).toBe("session");
  });

  it("🔴 and the state cannot come back — EVERY route that produces a pending owner row", () => {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // 🔴 THIS TEST USED TO PROVE ONE THIRD OF ITS OWN TITLE, AND THAT GAP WAS A REAL DEFECT.
    //
    // It said "the state cannot come back" and checked only the cashier case: create a cashier,
    // reset that cashier's PIN, assert the terminal is still claimed. The predicate behind the
    // ceremony, though, was `role = 'owner' AND must_reset_pin = 1 AND is_active = 1` — and TWO
    // ordinary owner actions produced exactly that row, because `create` took its role from the
    // caller and `setRole` never touched the flag. Creating an owner, or promoting a not-yet-set-up
    // cashier — two clicks on the owner's own screen — re-armed the ceremony and locked EVERY
    // operator out, the real owner included, until the new hire arrived with the PIN the owner had
    // typed. The repository comment, the release note and this test's own title all asserted it
    // could not happen; nothing verified it. An independent review found it by reading the SQL, and
    // it was reproduced by execution from both routes before the fix was written.
    //
    // So the title is now held to its full meaning: every route back, plus the two row shapes the
    // review named as having no test at all.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    claimTerminal();
    expect(operators.findBootstrapOwner()).toBeNull();

    // ROUTE 1 — a reset arms THAT operator's own setup and must not re-close the terminal.
    const created = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    svc.resetPin(OWNER, created.id, "876543");
    expect(flagOf(created.id)).toBe(1);
    expect(operators.findBootstrapOwner()).toBeNull();
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");

    // ROUTE 2 — creating an owner outright is now refused at the service.
    expect(() => svc.create(OWNER, { name: "مالك ثانٍ", role: "owner", pin: "123456" })).toThrow(
      /created as a cashier/,
    );
    expect(operators.findBootstrapOwner()).toBeNull();

    // ROUTE 3 — promoting a PENDING operator is refused, because their PIN is still one the owner
    // typed. This is the two-click route, and it is the one the UI actually offers.
    expect(() => svc.setRole(OWNER, created.id, "owner")).toThrow(/has not set their own PIN/);
    expect(operators.findBootstrapOwner()).toBeNull();
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");

    // 🔴 AND PROMOTION STILL WORKS once they have claimed their own account — the rule is about a
    // credential somebody else chose, not about ownership being unreachable.
    const ticket = svc.authenticate(created.id, "876543");
    if (ticket.kind !== "setup") throw new Error("expected setup");
    svc.completeSetup(ticket.ticket, "جعفر صالح", "135790");
    expect(() => svc.setRole(OWNER, created.id, "owner")).not.toThrow();
    expect(operators.findBootstrapOwner()).toBeNull();
    // Both owners can still sign in. This is the assertion that would have failed before the fix.
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");
    expect(svc.authenticate(created.id, "135790").kind).toBe("session");
  });

  it("🔴 the predicate is about an UNCLAIMED TERMINAL, not about any pending owner row", () => {
    // Written directly against the row shape, bypassing the service guards above, because the
    // guards and the predicate must BOTH hold: the guards are the cheap half, and a hand-edited or
    // future-written row must still not re-arm a terminal somebody has already claimed.
    claimTerminal();
    db.prepare(
      `INSERT INTO operators (id, name, role, pin_salt_hex, pin_hash_hex, must_reset_pin, is_active,
                              created_at, updated_at)
       VALUES ('hand-edited', 'مزروع', 'owner', 'aaaaaaaaaaaaaaaa', ?, 1, 1, ?, ?)`,
    ).run("b".repeat(64), "2026-10-11T09:00:00.000Z", "2026-10-11T09:00:00.000Z");
    expect(operators.findBootstrapOwner()).toBeNull();
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");
  });

  it("two bootstrap owners on an unclaimed terminal resolve deterministically", () => {
    // `LIMIT 1` with no ORDER BY left it to SQLite which row could sign in. Migration 8 seeds one,
    // so this needs a hand-written second row — but "unspecified" is not an answer a security
    // predicate should give, so the ordering is now explicit.
    db.prepare(
      `INSERT INTO operators (id, name, role, pin_salt_hex, pin_hash_hex, must_reset_pin, is_active,
                              created_at, updated_at)
       VALUES ('aaa-second-owner', 'مالك مزروع', 'owner', 'aaaaaaaaaaaaaaaa', ?, 1, 1, ?, ?)`,
    ).run("c".repeat(64), "2026-10-11T09:00:00.000Z", "2026-10-11T09:00:00.000Z");
    const first = operators.findBootstrapOwner();
    expect(first).not.toBeNull();
    expect(first!.id).toBe("aaa-second-owner");
    expect(operators.findBootstrapOwner()!.id).toBe(first!.id);
  });

  it("an INACTIVE bootstrap owner leaves no claimable terminal and no reachable owner channel", () => {
    // The third clause of the predicate had no test. Reachable only by writing the database
    // directly — `setActive` is owner-only and `assertNotLastOwner` protects the sole owner — and
    // the result fails CLOSED on the axis that matters: zero active owners, so no owner channel is
    // ever authorized again. Recorded as behaviour rather than discovered during an incident.
    db.prepare("UPDATE operators SET is_active = 0 WHERE id = 'cashier-01'").run();
    expect(operators.findBootstrapOwner()).toBeNull();
    expect(operators.countActiveOwners()).toBe(0);
    // cashier-02 may now claim its own account — it is a CASHIER, so it gains no owner power.
    const outcome = svc.authenticate("cashier-02", "2222");
    expect(outcome.kind).toBe("setup");
    if (outcome.kind !== "setup") throw new Error("unreachable");
    const session = svc.completeSetup(outcome.ticket, "جعفر صالح", "567812");
    expect(session.role).toBe("cashier");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("2 · an owner-set PIN is TEMPORARY", () => {
  beforeEach(() => claimTerminal());

  it("🔴 a reset arms the operator's own setup instead of handing them a credential", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    svc.completeSetup(
      (() => {
        const o = svc.authenticate(op.id, "567812");
        if (o.kind !== "setup") throw new Error("expected setup");
        return o.ticket;
      })(),
      "جعفر صالح",
      "135790",
    );
    expect(flagOf(op.id)).toBe(0);
    expect(svc.authenticate(op.id, "135790").kind).toBe("session");

    // The owner resets it — because the employee forgot theirs.
    svc.resetPin(OWNER, op.id, "876543");
    expect(flagOf(op.id)).toBe(1);

    // 🔴 THE OWNER'S PIN DOES NOT OPEN A SESSION. It opens the setup form and nothing else.
    const outcome = svc.authenticate(op.id, "876543");
    expect(outcome.kind).toBe("setup");
    if (outcome.kind !== "setup") throw new Error("unreachable");

    // The employee chooses their own, and the owner's temporary one dies with it.
    svc.completeSetup(outcome.ticket, "جعفر صالح", "246813");
    expect(flagOf(op.id)).toBe(0);
    expect(svc.authenticate(op.id, "246813").kind).toBe("session");
    expect(() => svc.authenticate(op.id, "876543")).toThrow(/Operator or PIN is incorrect/);
  });

  it("the old PIN is gone the moment the reset lands — a reset is a replacement, not an addition", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    svc.resetPin(OWNER, op.id, "876543");
    expect(() => svc.authenticate(op.id, "567812")).toThrow(/Operator or PIN is incorrect/);
  });

  it("🔴 the reset's audit row carries the act and no credential material", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    svc.resetPin(OWNER, op.id, "876543");
    const rows = db
      .prepare(
        `SELECT event_type AS t, changed_json AS changed, metadata_json AS meta, actor_tier AS tier
           FROM audit_events WHERE entity_type = 'operator' ORDER BY seq`,
      )
      .all() as Array<Record<string, string>>;
    const reset = rows.find((r) => r.t === "OPERATOR_PIN_RESET");
    expect(reset).toBeTruthy();
    // Asserted on the PAYLOAD, never on the serialised row — the event type contains "PIN" and that
    // is the fact the trail is required to record, not a leak. That distinction has cost this
    // repository four separate false failures.
    for (const field of ["changed", "meta"]) {
      const raw = reset![field];
      if (raw === null || raw === undefined) continue;
      for (const key of Object.keys(JSON.parse(raw))) {
        expect(/pin|hash|salt|secret|token|credential/i.test(key)).toBe(false);
      }
      expect(raw).not.toContain("876543");
      expect(raw).not.toContain("567812");
    }
    // And the real stored credential appears nowhere at all.
    const stored = operators.findById(op.id)!;
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(stored.pin_salt_hex);
    expect(blob).not.toContain(stored.pin_hash_hex);
    expect(reset!.tier).toBe("owner");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("3 · the real PIN length — six to eight, chosen; four, typed", () => {
  it("the rule itself", () => {
    expect(PIN_MIN_DIGITS).toBe(6);
    expect(PIN_MAX_DIGITS).toBe(8);
  });

  it("🔴 the legacy four-digit bootstrap credential still VERIFIES — or upgrade day locks the shop out", () => {
    // This is the assertion that stands between a security improvement and a field disaster.
    const outcome = svc.authenticate("cashier-01", "1111");
    expect(outcome.kind).toBe("setup");
  });

  it("🔴 but four digits is refused as a NEWLY CHOSEN PIN, in setup", () => {
    const outcome = svc.authenticate("cashier-01", "1111");
    if (outcome.kind !== "setup") throw new Error("expected setup");
    expect(() => svc.completeSetup(outcome.ticket, "حسين", "4321")).toThrow(/between 6 and 8 digits/);
    // 🔴 AND THE TERMINAL IS STILL UNCLAIMED. A refused setup must not half-happen.
    expect(flagOf("cashier-01")).toBe(1);
    expect(operators.findBootstrapOwner()).not.toBeNull();
    // The ticket survives a refusal, so the operator retypes rather than signing in again.
    expect(() => svc.completeSetup(outcome.ticket, "حسين", "431987")).not.toThrow();
  });

  it("🔴 refused at creation and at reset too — every path that CHOOSES a PIN", () => {
    claimTerminal();
    expect(() => svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "4321" })).toThrow(
      /between 6 and 8 digits/,
    );
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    expect(() => svc.resetPin(OWNER, op.id, "4321")).toThrow(/between 6 and 8 digits/);
    // The refused reset changed nothing: the original PIN still opens setup.
    expect(svc.authenticate(op.id, "567812").kind).toBe("setup");
  });

  it("accepts six, seven and eight digits, and refuses nine", () => {
    claimTerminal();
    let n = 0;
    for (const pin of ["123456", "1234567", "12345678"]) {
      expect(() => svc.create(OWNER, { name: `op-${++n}`, role: "cashier", pin })).not.toThrow();
    }
    expect(() => svc.create(OWNER, { name: "too-long", role: "cashier", pin: "123456789" })).toThrow(
      /between 6 and 8 digits/,
    );
    expect(() => svc.create(OWNER, { name: "not-digits", role: "cashier", pin: "12345a" })).toThrow(
      /digits only/,
    );
  });

  it("🔴 the bootstrap value is not special-cased into validity — 1111 cannot be CHOSEN", () => {
    claimTerminal();
    expect(() => svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "1111" })).toThrow(
      /between 6 and 8 digits/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("4 · actor_tier on operator events is the actor's REAL role", () => {
  it("an owner's operator actions are recorded as owner", () => {
    claimTerminal();
    svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    const tiers = (
      db
        .prepare("SELECT actor_tier AS tier FROM audit_events WHERE entity_type = 'operator' ORDER BY seq")
        .all() as Array<{ tier: string }>
    ).map((r) => r.tier);
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers.every((x) => x === "owner")).toBe(true);
    // 🔴 Never the old placeholder. audit.ts named this branch as the moment real tiers begin.
    expect(tiers).not.toContain("unspecified");
  });
});
