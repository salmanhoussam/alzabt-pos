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
import { BOOTSTRAP_OWNER_ID, OperatorRepository } from "../../src/persistence/operatorRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from "../../src/domain/pinRule";
import { type TempDir, tempDir } from "../helpers/harness";
import { scryptSync } from "node:crypto";
import { SCRYPT } from "../../src/application/cashierAuth";

let t: TempDir;
let db: Db;
let svc: OperatorService;
let operators: OperatorRepository;
let ids = 0;

const OWNER = { id: "cashier-01", name: "Cashier One", role: "owner" as const };
const OWNER_PIN = "431987";

/**
 * 🔴 THE NEXT OPERATOR ID, WHEN A TEST NEEDS TO CONTROL THE ORDERING.
 *
 * Default ids stay `id-N`. The real generator is `randomUUID`, whose first character is a hex
 * digit, and "id-1" sorts AFTER "cashier-01" while a uuid sorts BEFORE it for twelve of sixteen
 * first characters. The old suite therefore could not see the two-owner lock-out defect at all:
 * its own fixture ordering masked the exact comparison that caused it. Tests that care about that
 * now set this explicitly, from both sides.
 */
let nextOpId: string | null = null;

/**
 * A second owner's REAL credential, so a land-grab refusal fails for the right reason.
 *
 * Computed with the product's own scrypt parameters rather than written as a literal, because a
 * refusal test whose credential is merely wrong proves nothing about the terminal guard — it would
 * pass identically with the guard removed.
 */
const SECOND_PIN = "908172";
const SECOND_SALT_HEX = "b2e4d0a86c195f73";
const SECOND_HASH_HEX = scryptSync(
  SECOND_PIN,
  Buffer.from(SECOND_SALT_HEX, "hex"),
  32,
  SCRYPT,
).toString("hex");

function newService(): OperatorService {
  return new OperatorService({
    operators,
    audit: new AuditRepository(db, { appVersion: "0.1.1", schemaVersion: 8 }),
    transact: (fn) => db.transaction(fn).immediate(),
    terminal: FIXTURE_TERMINAL,
    now: () => new Date("2026-10-11T09:00:00.000Z"),
    newId: () => {
      if (nextOpId !== null) {
        const held = nextOpId;
        nextOpId = null;
        return held;
      }
      return `id-${++ids}`;
    },
  });
}

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
  operators = new OperatorRepository(db);
  ids = 0;
  nextOpId = null;
  svc = newService();
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

// 🔴 THE TERMINAL'S OWN STATE, READ DIRECTLY. Not a proxy over pending-owner rows — reading a
// proxy is what let the previous build's lock-out defect through four reviews.
const claimed = () => operators.terminalClaimed();

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("1 · OWNER SETUP REQUIRED — the install/upgrade ceremony", () => {
  it("a freshly migrated terminal is UNCLAIMED, and the claim identity is the seeded owner", () => {
    // 🔴 TEST A. The durable terminal fact, and the two account facts, asserted as the separate
    // things they are. Migration 8 seeds all three, so a fresh v8 install and a real v7 -> v8
    // upgrade arrive here identically — and neither is derived from the other.
    expect(claimed()).toBe(false);
    expect(operators.terminalClaim()).toBeNull();
    expect(BOOTSTRAP_OWNER_ID).toBe("cashier-01");
    const owner = operators.findById(BOOTSTRAP_OWNER_ID)!;
    expect(owner.role).toBe("owner");
    expect(flagOf("cashier-01")).toBe(1);
    expect(flagOf("cashier-02")).toBe(1);
    // And there is exactly one owner to begin with, so "the seeded identity" is unambiguous.
    expect(operators.listAll().filter((o) => o.role === "owner").map((o) => o.id)).toEqual([
      "cashier-01",
    ]);
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

  it("🔴 claiming the terminal sets the durable flag, and then the other operator may set up", () => {
    // 🔴 TEST C. The claim is the transition, and it is asserted on the terminal row itself.
    const session = claimTerminal();
    expect(claimed()).toBe(true);
    expect(operators.terminalClaim()).toEqual({
      claimedAt: "2026-10-11T09:00:00.000Z",
      byOperatorId: "cashier-01",
    });
    expect(flagOf("cashier-01")).toBe(0);
    expect(session.role).toBe("owner");
    // The bootstrap credential is dead and the owner's own 6-8 digit PIN is live.
    expect(() => svc.authenticate("cashier-01", "1111")).toThrow(/Operator or PIN is incorrect/);
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");

    // cashier-02 is still a bootstrap account, so it gets setup — but now it is allowed to.
    const second = svc.authenticate("cashier-02", "2222");
    expect(second.kind).toBe("setup");
    if (second.kind !== "setup") throw new Error("unreachable");
    svc.completeSetup(second.ticket, "جعفر صالح", "567812");
    expect(flagOf("cashier-02")).toBe(0);
    expect(svc.authenticate("cashier-02", "567812").kind).toBe("session");
  });

  it("🔴 ONCE CLAIMED, NO account lifecycle action can return terminal_claimed to 0", () => {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // 🔴 THIS TEST'S TITLE USED TO BE FALSE, TWICE, AND EACH TIME THE FIX WAS A NARROWER CLAIM.
    //
    // Round 1 it said "the state cannot come back" and checked only the cashier case. The ceremony
    // then keyed on (owner, must_reset_pin = 1, active), and TWO ordinary actions produced that
    // row — creating an owner, or promoting a not-yet-set-up cashier. Both re-armed the ceremony
    // and locked everyone out. Round 2 added a NOT EXISTS clause and the title became "no PRODUCT
    // ACTION can re-arm it", which was also false: an owner resetting their own PIN re-armed it.
    // Round 3 wrote that down as benign — and it was not, because with two owners the exemption
    // went to the lowest id rather than to the person acting.
    //
    // 🔴 THE TITLE IS TRUE NOW FOR A DIFFERENT REASON THAN WORDING: terminal_claimed is a durable
    // column, written once, with no statement anywhere in the application that can set it back to
    // 0. So this asserts the TERMINAL'S OWN STATE after every lifecycle action in turn, instead of
    // asserting a proxy over pending-owner rows. Reading the proxy is what let three rounds pass.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const session = claimTerminal();
    expect(claimed()).toBe(true);

    // H · promote a pending cashier — the two-click route that used to re-arm it.
    const created = svc.create(session, { name: "جعفر", role: "cashier", pin: "567812" });
    expect(claimed()).toBe(true);
    expect(() => svc.setRole(session, created.id, "owner")).toThrow(/has not set their own PIN/);
    expect(claimed()).toBe(true);

    // I · create an owner outright — refused at the service, and no effect on the terminal.
    expect(() => svc.create(session, { name: "مالك ثانٍ", role: "owner", pin: "123456" })).toThrow(
      /created as a cashier/,
    );
    expect(claimed()).toBe(true);

    // owner resets a CASHIER's PIN
    svc.resetPin(session, created.id, "876543");
    expect(flagOf(created.id)).toBe(1);
    expect(claimed()).toBe(true);

    // promotion once they have claimed their own account — this is the supported route to a second
    // owner, and it is where the two-owner lock-out defect lived.
    const ticket = svc.authenticate(created.id, "876543");
    if (ticket.kind !== "setup") throw new Error("expected setup");
    svc.completeSetup(ticket.ticket, "جعفر صالح", "135790");
    expect(claimed()).toBe(true);
    svc.setRole(session, created.id, "owner");
    expect(claimed()).toBe(true);

    // J · deactivate and reactivate
    svc.setActive(session, created.id, false);
    expect(claimed()).toBe(true);
    svc.setActive(session, created.id, true);
    expect(claimed()).toBe(true);

    // rename
    svc.rename(session, created.id, "جعفر ص");
    expect(claimed()).toBe(true);

    // 🔴 AND THE CLAIM RECORD ITSELF IS UNMOVED by all of it — not merely still 1, but still the
    // same instant and the same operator. A re-attributed claim would be a silent rewrite of the
    // terminal's only ownership record.
    expect(operators.terminalClaim()).toEqual({
      claimedAt: "2026-10-11T09:00:00.000Z",
      byOperatorId: "cashier-01",
    });
    // Both owners can still sign in. This is the assertion that failed before the first fix.
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");
    expect(svc.authenticate(created.id, "135790").kind).toBe("session");
  });

  it("🔴 TEST E · the owner resets their OWN PIN: setup-only, and THEY complete it", () => {
    // The product decision stands — an owner may reset their own PIN, and no self-reset
    // prohibition was added to hide the ceremony defect. What changes is that it is now an
    // ACCOUNT event with no terminal consequence whatsoever.
    const session = claimTerminal();
    svc.resetPin(session, "cashier-01", "654321");

    expect(claimed()).toBe(true);           // the terminal is untouched
    expect(flagOf("cashier-01")).toBe(1);   // the account needs a new private credential

    // Setup only — the reset credential buys the form and nothing else.
    const again = svc.authenticate("cashier-01", "654321");
    expect(again.kind).toBe("setup");
    if (again.kind !== "setup") throw new Error("unreachable");

    // 🔴 AND THEY COMPLETE THEIR OWN. No other identity is required or even involved.
    const back = svc.completeSetup(again.ticket, "حسين رقا", "431987");
    expect(back.id).toBe("cashier-01");
    expect(back.role).toBe("owner");
    expect(svc.authenticate("cashier-01", "431987").kind).toBe("session");
    // The published credential does not return, and the claim was not re-attributed.
    expect(() => svc.authenticate("cashier-01", "1111")).toThrow(/Operator or PIN is incorrect/);
    expect(operators.terminalClaim()!.claimedAt).toBe("2026-10-11T09:00:00.000Z");
  });

  it("🔴 TEST E2 · the SOLE active owner self-resets and is still the one who completes it", () => {
    // The narrower shape of E: nobody else has claimed anything, which is the common state right
    // after an upgrade and the exact state the old NOT EXISTS predicate mistook for "unclaimed".
    const session = claimTerminal();
    expect(operators.countActiveOwners()).toBe(1);
    expect(flagOf("cashier-02")).toBe(1); // the other seeded account never claimed anything

    svc.resetPin(session, "cashier-01", "654321");
    // Every row in the table now has must_reset_pin = 1 — the condition the old predicate read as
    // "this terminal has never been claimed". It no longer answers that question.
    expect(operators.listAll().every((o) => o.must_reset_pin === 1)).toBe(true);
    expect(claimed()).toBe(true);

    const again = svc.authenticate("cashier-01", "654321");
    expect(again.kind).toBe("setup");
    if (again.kind !== "setup") throw new Error("unreachable");
    expect(svc.completeSetup(again.ticket, "حسين رقا", "431987").id).toBe("cashier-01");
  });

  it("🔴 TEST F+G · two owners, A resets B then A — A completes A's setup, ids are irrelevant", () => {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // 🔴 THE REGRESSION TEST FOR THE REAL DEFECT, which was reproduced by execution before this
    // fix: owner A reset B's PIN and then their own, every row went pending, and the old
    // `ORDER BY id LIMIT 1` handed the exemption to whichever owner sorted first. A was refused
    // their own setup screen, and the only way back in was to sign in AS B.
    //
    // Both id orderings are covered in one test — B BEFORE and B AFTER "cashier-01" — because the
    // defect was invisible in the old suite precisely for want of that control: the harness's own
    // newId produced "id-1", which sorts after "cashier-01", so the fixture masked it while real
    // randomUUID ids hit it roughly three times in four.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    for (const bId of ["0f2a81c4-9b0e-4d77-8a21-6c5e4b1d90ff", "f0f2a81c-9b0e-4d77-8a21-6c5e4b1d90ff"]) {
      // A fresh terminal per ordering, so neither run can inherit the other's state.
      db.close();
      t.cleanup();
      t = tempDir();
      db = openDatabase(t.dbPath);
      operators = new OperatorRepository(db);
      svc = newService();

      const A = claimTerminal();
      // 🔴 SET IMMEDIATELY BEFORE THE CREATE, not before the claim: `newId` also allocates audit
      // row ids, so the claim's own two audit writes would otherwise consume this one. The
      // assertion below is what catches that — and it caught it once already while this test was
      // being written, which is why it is an assertion rather than a comment.
      nextOpId = bId;
      const b = svc.create(A, { name: "هاشم", role: "cashier", pin: "246813" });
      expect(b.id).toBe(bId);
      const bt = svc.authenticate(b.id, "246813");
      if (bt.kind !== "setup") throw new Error("expected setup for B");
      svc.completeSetup(bt.ticket, "هاشم", "975312");
      svc.setRole(A, b.id, "owner");

      // A resets B's forgotten PIN, then A resets their own from the same screen.
      svc.resetPin(A, b.id, "864213");
      svc.resetPin(A, A.id, "135790");

      // 🔴 The terminal never moved, whichever way the ids sort.
      expect(claimed()).toBe(true);
      expect(operators.terminalClaim()!.byOperatorId).toBe("cashier-01");

      // 🔴 A reaches A's OWN setup and completes it. No login as B, anywhere.
      const back = svc.authenticate(A.id, "135790");
      expect(back.kind).toBe("setup");
      if (back.kind !== "setup") throw new Error("unreachable");
      const session = svc.completeSetup(back.ticket, "حسين رقا", "246801");
      expect(session.id).toBe("cashier-01");

      // 🔴 B REMAINS B: still an owner, still pending their own choice, and the credential A typed
      // for them opens setup only — never a session.
      const bRow = operators.findById(b.id)!;
      expect(bRow.role).toBe("owner");
      expect(bRow.must_reset_pin).toBe(1);
      expect(svc.authenticate(b.id, "864213").kind).toBe("setup");
    }
  });

  it("🔴 a hand-written pending owner row cannot re-arm a claimed terminal", () => {
    // Written directly against the table, bypassing every service guard, because the guards and
    // the durable state must BOTH hold: the guards are the cheap half, and a hand-edited or
    // future-written row must still not re-arm a terminal somebody has already claimed.
    claimTerminal();
    db.prepare(
      `INSERT INTO operators (id, name, role, pin_salt_hex, pin_hash_hex, must_reset_pin, is_active,
                              created_at, updated_at)
       VALUES ('aaa-hand-edited', 'مزروع', 'owner', 'aaaaaaaaaaaaaaaa', ?, 1, 1, ?, ?)`,
    ).run("b".repeat(64), "2026-10-11T09:00:00.000Z", "2026-10-11T09:00:00.000Z");
    // 🔴 Deliberately an id that sorts BEFORE "cashier-01": under the old predicate this row would
    // have become the terminal's bootstrap owner and locked the real one out.
    expect(claimed()).toBe(true);
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");
  });

  it("🔴 an UNCLAIMED terminal admits ONLY the seeded owner — no second owner can take it", () => {
    // The land-grab axis. A hand-written second owner on an unclaimed terminal used to be able to
    // become the claim identity through `ORDER BY id`. Now the identity is the seeded one, named.
    db.prepare(
      `INSERT INTO operators (id, name, role, pin_salt_hex, pin_hash_hex, must_reset_pin, is_active,
                              created_at, updated_at)
       VALUES ('aaa-second-owner', 'مالك مزروع', 'owner', ?, ?, 1, 1, ?, ?)`,
    ).run(
      SECOND_SALT_HEX,
      SECOND_HASH_HEX,
      "2026-10-11T09:00:00.000Z",
      "2026-10-11T09:00:00.000Z",
    );
    expect(claimed()).toBe(false);
    // 🔴 It holds a VALID credential — the refusal is about the terminal, not about the PIN, which
    // is what makes this assertion fail for the right reason.
    expect(() => svc.authenticate("aaa-second-owner", SECOND_PIN)).toThrow(
      /waiting for the shop owner/,
    );
    expect(claimed()).toBe(false);
    // And the seeded owner still claims it.
    claimTerminal();
    expect(operators.terminalClaim()!.byOperatorId).toBe("cashier-01");
  });

  it("🔴 a DEACTIVATED seeded owner leaves the terminal unclaimable — it fails CLOSED", () => {
    // Reachable only by writing the database directly: `setActive` is owner-only and
    // `assertNotLastOwner` protects the sole owner. Recorded as deliberate behaviour rather than
    // discovered during an incident — and it is the safe direction. Previously cashier-02 could
    // then set itself up on an unclaimed terminal; now nobody can, and the shop's route back is
    // the pre-migration backup, which is the documented rollback path either way.
    db.prepare("UPDATE operators SET is_active = 0 WHERE id = 'cashier-01'").run();
    expect(claimed()).toBe(false);
    expect(operators.countActiveOwners()).toBe(0);
    expect(() => svc.authenticate("cashier-01", "1111")).toThrow(/Operator or PIN is incorrect/);
    expect(() => svc.authenticate("cashier-02", "2222")).toThrow(/waiting for the shop owner/);
    expect(claimed()).toBe(false);
  });

  it("🔴 TEST D+K · the claim survives reopening the database — it is durable, not in memory", () => {
    claimTerminal();
    const before = operators.terminalClaim();
    db.close();

    // Same file, new connection, new repository: exactly what a restart does, and what restoring
    // a VACUUM INTO backup of this database would also produce.
    db = openDatabase(t.dbPath);
    operators = new OperatorRepository(db);
    svc = newService();

    expect(operators.terminalClaimed()).toBe(true);
    expect(operators.terminalClaim()).toEqual(before);
    // And the owner's own PIN still opens a session, with no ceremony in the way.
    expect(svc.authenticate("cashier-01", OWNER_PIN).kind).toBe("session");
  });

  it("the singleton is structural — a second terminal row cannot exist", () => {
    // "Which row is authoritative" is not a question the application can get wrong, because the
    // CHECK makes a second row unrepresentable rather than merely unused.
    expect(() =>
      db
        .prepare(
          `INSERT INTO terminal_security_state (id, terminal_claimed, claimed_at,
                                                claimed_by_operator_id)
           VALUES ('other', 0, NULL, NULL)`,
        )
        .run(),
    ).toThrow();
    // And a half-written claim is unrepresentable too: the flag and its two facts travel together.
    expect(() =>
      db
        .prepare(`UPDATE terminal_security_state SET terminal_claimed = 1 WHERE id = 'terminal'`)
        .run(),
    ).toThrow();
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
    expect(claimed()).toBe(false);
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
