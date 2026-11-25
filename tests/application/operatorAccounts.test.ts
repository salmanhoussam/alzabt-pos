/**
 * Operator accounts: bootstrap setup, the lifecycle, and the rules that keep a shop from locking
 * itself out of its own terminal.
 *
 * 🔴 WHAT THESE ARE FOR. The dangerous parts of this feature are not the CRUD. They are: a legacy
 * bootstrap credential that must buy exactly one thing and then die; an audit trail that must never
 * carry PIN material even by accident; and three cross-row rules that a database CHECK cannot
 * express, so if they are not tested they are not enforced.
 *
 * Synthetic throughout. `cashier-01`/`cashier-02` and the PINs 1111/2222 are the product's own
 * published test fixtures, which is precisely why migration 8 exists.
 *
 * TRANSITION (O-1 Phase 1, P1 + D-O1/D-O2, owner R9, 2026-11-25). The published PINs no longer authenticate, so
 * nothing reaches a setup ticket through 1111/2222 any more. Each test keeps its subject and reaches its state
 * through a path that still exists: the first owner through `enrollOwner` (new-shop enrollment), and the
 * setup-ticket mechanics through an operator the owner CREATED (a created account is pending, so its temporary
 * PIN yields a ticket). The test that asserted «1111 yields a ticket» is FLIPPED to its refusal. Register:
 * CLAUDE-TAKEOVER-2026-11-25/p1-tests/transition-register.md.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { OperatorService } from "../../src/application/operatorService";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { ledgerEmptiness } from "../../src/persistence/ledgerEmptiness";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
let svc: OperatorService;
let operators: OperatorRepository;

const OWNER = { id: "cashier-01", name: "Cashier One", role: "owner" as const };

let ids = 0;

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
    now: () => new Date("2026-10-10T12:00:00.000Z"),
    newId: () => `id-${++ids}`,
    ledgerEmpty: () => ledgerEmptiness(db).empty,
  });
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const auditRows = () =>
  db
    .prepare(
      `SELECT event_type AS type, entity_type AS entity, entity_id AS target, actor_id AS actor,
              actor_tier AS tier, changed_json AS changed, metadata_json AS meta
         FROM audit_events WHERE entity_type = 'operator' ORDER BY seq`,
    )
    .all() as Array<Record<string, string>>;

/**
 * A REAL second owner, by the only route the product now allows.
 *
 * 🔴 `create(..., role: "owner")` is refused, and promoting a PENDING operator is refused, because a
 * pending owner row is exactly what used to re-arm the install ceremony and lock the terminal. So a
 * second owner is made the way a shop makes one: create the cashier, let them claim their own
 * account with their own PIN, then promote. Four tests below needed "a second owner" and were
 * written against the old shortcut; this is the real sequence, in one place.
 */
function secondOwner(name = "شريك", pin = "567812") {
  const created = svc.create(OWNER, { name, role: "cashier", pin });
  const ticket = svc.authenticate(created.id, pin);
  if (ticket.kind !== "setup") throw new Error("expected setup");
  svc.completeSetup(ticket.ticket, name, pin === "567812" ? "135790" : "246813");
  return svc.setRole(OWNER, created.id, "owner");
}

/**
 * The shop's first owner. TRANSITION (O-1 P1): was «authenticate(cashier-01, 1111) → completeSetup», which P1 now
 * refuses. A new shop's owner is enrolled through `enrollOwner` (renames + sets the PIN of the seeded owner row,
 * retires the seeded cashier (D-O2), claims the terminal), so tests that need «an owner» start here.
 */
function bootstrapOwner(name = "حسين", pin = "431987") {
  return svc.enrollOwner(name, pin);
}

/**
 * An operator in mandatory setup, holding a ticket: the owner creates them with a temporary PIN, and that
 * temporary PIN yields a setup ticket — the ticket mechanics these tests are about, reached without 1111.
 */
function pendingOperator(name = "جعفر", tempPin = "567812") {
  const created = svc.create(OWNER, { name, role: "cashier", pin: tempPin });
  const outcome = svc.authenticate(created.id, tempPin);
  if (outcome.kind !== "setup") throw new Error("expected setup");
  return { id: created.id, ticket: outcome.ticket, tempPin };
}

describe("the two migrated accounts", () => {
  it("exist with the approved roles and both require a reset", () => {
    // 🔴 `mayCreateProducts` ARRIVED WITH MIGRATION 11 AND IS FALSE ON BOTH. The seeded rows
    // predate the capability, and an upgrade must grant nobody anything — the owner does not need
    // it, and the cashier must be given it deliberately. The old shape carried four keys.
    expect(svc.listAll()).toEqual([
      {
        id: "cashier-01",
        name: "Cashier One",
        role: "owner",
        isActive: true,
        mustResetPin: true,
        mayCreateProducts: false,
      },
      {
        id: "cashier-02",
        name: "Cashier Two",
        role: "cashier",
        isActive: true,
        mustResetPin: true,
        mayCreateProducts: false,
      },
    ]);
  });

  it("🔴 FLIPPED (O-1 P1): the published bootstrap PIN yields NEITHER a session NOR a setup ticket", () => {
    // TRANSITION. Was: «a correct bootstrap PIN yields a SETUP TICKET and NO session». The «no session» half is
    // kept and strengthened: the published PIN now yields nothing at all, with the generic wrong-PIN message.
    const refusal = (id: string, pin: string) => {
      try {
        svc.authenticate(id, pin);
      } catch (e) {
        return { code: (e as DomainError).code, message: (e as DomainError).message };
      }
      return null;
    };
    const wrongPin = refusal("cashier-01", "0000");
    expect(wrongPin?.code).toBe("INVALID_CREDENTIALS");
    expect(refusal("cashier-01", "1111")).toEqual(wrongPin);
    expect(refusal("cashier-02", "2222")).toEqual(wrongPin);
    // And no ticket slot was armed: there is nothing for completeSetup to consume.
    expect(() => svc.completeSetup("0".repeat(48), "x", "431987")).toThrow(/Sign in again/);
    expect(operators.findById("cashier-01")!.must_reset_pin).toBe(1);
  });

  it("a wrong PIN is refused with the generic message", () => {
    expect(() => svc.authenticate("cashier-01", "9999")).toThrow(/Operator or PIN is incorrect/);
  });

  it("an unknown operator is refused IDENTICALLY, so the screen cannot enumerate accounts", () => {
    const unknown = (() => {
      try {
        svc.authenticate("nobody", "1111");
      } catch (e) {
        return (e as DomainError).message;
      }
      throw new Error("expected a refusal");
    })();
    const wrongPin = (() => {
      try {
        svc.authenticate("cashier-01", "0000");
      } catch (e) {
        return (e as DomainError).message;
      }
      throw new Error("expected a refusal");
    })();
    expect(unknown).toBe(wrongPin);
  });
});

describe("mandatory setup", () => {
  it("replaces the credential, clears the flag, and opens the session", () => {
    const session = bootstrapOwner("حسين رقا", "431987");
    expect(session).toEqual({ id: "cashier-01", name: "حسين رقا", role: "owner" });

    const row = operators.findById("cashier-01")!;
    expect(row.must_reset_pin).toBe(0);
    expect(row.name).toBe("حسين رقا");
    expect(row.pin_hash_hex).not.toBe("a8f8c45b97712daec733a8b4d198ac96376c05697b5935a7b30f965e27478bce");
    expect(row.pin_salt_hex).not.toBe("a1f3c9e27b4d6058");
  });

  it("🔴 the OLD bootstrap PIN stops authenticating, and the NEW one works", () => {
    bootstrapOwner("حسين", "431987");
    expect(() => svc.authenticate("cashier-01", "1111")).toThrow(/incorrect/);
    const again = svc.authenticate("cashier-01", "431987");
    expect(again.kind).toBe("session");
  });

  it("🔴 the ticket is consumed — it cannot be replayed to rewrite the PIN", () => {
    // REACH (O-1 P1): the ticket comes from a created operator's temporary PIN, not from 1111.
    bootstrapOwner();
    const op = pendingOperator();
    svc.completeSetup(op.ticket, "جعفر", "431987");
    expect(() => svc.completeSetup(op.ticket, "مهاجم", "9999")).toThrow(/Sign in again/);
    // And the PIN the attacker tried does not work.
    expect(() => svc.authenticate(op.id, "9999")).toThrow(/incorrect/);
  });

  it("a forged or stale ticket is refused", () => {
    bootstrapOwner();
    pendingOperator(); // REACH (O-1 P1): a real ticket is held, and a forged one is still refused
    expect(() => svc.completeSetup("f".repeat(48), "x", "431987")).toThrow(/Sign in again/);
  });

  it("🔴 a ticket for one operator cannot set up ANOTHER operator", () => {
    // 🔴 THE OWNER CLAIMS THE TERMINAL FIRST, because the ceremony now requires it. This test used
    // to authenticate cashier-02 while cashier-01 was still unclaimed, which OWNER_SETUP_REQUIRED
    // forbids; the SUBJECT — one ticket slot, and a ticket that names its own operator — is
    // unchanged and is now exercised between two operators who are both allowed to be there.
    bootstrapOwner("حسين رقا", "431987");
    const created = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });

    const first = svc.authenticate(created.id, "567812");
    if (first.kind !== "setup") throw new Error("expected setup");
    // A second bootstrap login replaces the single slot, so the first ticket dies. The ticket names
    // its operator, so there is no field in which to substitute a different one.
    // REACH (O-1 P1): the second operator was cashier-02 with 2222; enrollment retired that row (D-O2) and 2222
    // is a wrong PIN, so the second operator is another created account. The subject (one slot) is unchanged.
    const other = svc.create(OWNER, { name: "سمير", role: "cashier", pin: "246824" });
    const second = svc.authenticate(other.id, "246824");
    if (second.kind !== "setup") throw new Error("expected setup");
    expect(() => svc.completeSetup(first.ticket, "x", "431987")).toThrow(/Sign in again/);

    svc.completeSetup(second.ticket, "سمير", "778899");
    // Only the second operator was set up. The operator whose ticket died is still waiting.
    expect(operators.findById(created.id)!.must_reset_pin).toBe(1);
    expect(operators.findById(other.id)!.must_reset_pin).toBe(0);
  });

  it("a restart does not bypass the reset — the flag is on disk, the ticket is not", () => {
    // REACH (O-1 P1): a created operator's pending state, not the published 1111.
    bootstrapOwner();
    const op = pendingOperator();
    // A fresh service is a fresh process: the in-memory ticket is gone.
    const restarted = new OperatorService({
      operators,
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
    });
    expect(restarted.authenticate(op.id, op.tempPin).kind).toBe("setup");
    expect(operators.findById(op.id)!.must_reset_pin).toBe(1);
    // And a restart does not revive the published PIN either.
    expect(() => restarted.authenticate("cashier-01", "1111")).toThrow(/incorrect/);
  });

  it("refuses a PIN that is not 6-8 digits, and leaves the account in setup", () => {
    bootstrapOwner();
    const op = pendingOperator(); // REACH (O-1 P1)
    for (const bad of ["123", "123456789", "12a4", "", "12 34", " 1234"]) {
      expect(() => svc.completeSetup(op.ticket, "جعفر", bad)).toThrow(DomainError);
    }
    expect(operators.findById(op.id)!.must_reset_pin).toBe(1);
    // 🔴 The ticket SURVIVES a refused PIN, so a typo does not send the operator back to login.
    expect(() => svc.completeSetup(op.ticket, "جعفر", "431987")).not.toThrow();
  });

  it("refuses an empty name", () => {
    bootstrapOwner();
    const op = pendingOperator(); // REACH (O-1 P1)
    expect(() => svc.completeSetup(op.ticket, "   ", "431987")).toThrow(/needs a name/);
  });

  it("🔴 writes TWO events when the name changed — a rename and a reset, not one ambiguous act", () => {
    // REACH (O-1 P1): the setup is a created operator's; only the rows that setup wrote are inspected.
    bootstrapOwner();
    const op = pendingOperator("جعفر");
    const before = auditRows().length;
    svc.completeSetup(op.ticket, "جعفر صالح", "431987");
    const rows = auditRows().slice(before);
    expect(rows.map((r) => r.type)).toEqual(["OPERATOR_RENAMED", "OPERATOR_PIN_RESET"]);
    expect(rows.every((r) => r.target === op.id)).toBe(true);
    expect(rows.every((r) => JSON.parse(r.meta!).origin === "bootstrap_setup")).toBe(true);
    // The rename says what it changed, from what, to what.
    expect(JSON.parse(rows[0]!.changed!)).toEqual({
      name: { before: "جعفر", after: "جعفر صالح" },
    });
  });

  it("writes ONLY the reset when the operator kept the name — no empty rename", () => {
    bootstrapOwner();
    const op = pendingOperator("جعفر"); // REACH (O-1 P1)
    const before = auditRows().length;
    svc.completeSetup(op.ticket, "جعفر", "431987");
    expect(auditRows().slice(before).map((r) => r.type)).toEqual(["OPERATOR_PIN_RESET"]);
  });

  it("🔴 a PIN reset's audit row carries NO credential material at all", () => {
    bootstrapOwner("حسين", "431987");
    const reset = auditRows().find((r) => r.type === "OPERATOR_PIN_RESET")!;
    expect(JSON.parse(reset.changed!)).toEqual({});
    const blob = JSON.stringify(reset);
    // Neither PIN appears anywhere in the row.
    expect(blob).not.toContain("431987");
    expect(blob).not.toContain("1111");
    // Nor the stored credential itself — read from the row and searched for, so this cannot pass
    // by the hash simply having changed.
    const stored = operators.findById("cashier-01")!;
    expect(blob).not.toContain(stored.pin_hash_hex);
    expect(blob).not.toContain(stored.pin_salt_hex);
    // 🔴 And no KEY in the payload matches the audit domain's own secret pattern. Asserted on the
    // keys, not on the whole serialized row: `OPERATOR_PIN_RESET` is an event TYPE and contains
    // "PIN" legitimately — a blanket substring check would fail for the one correct reason and
    // teach nothing. (My first version of this assertion did exactly that.)
    const keys = [...Object.keys(JSON.parse(reset.changed!)), ...Object.keys(JSON.parse(reset.meta ?? "{}"))];
    expect(keys.filter((k) => /pin|password|token|secret|credential|hash|salt/i.test(k))).toEqual([]);
    // What it DOES carry: who, to whom, and when.
    expect(reset.actor).toBe("cashier-01");
    expect(reset.target).toBe("cashier-01");
    expect(reset.tier).toBe("owner");
  });

  it("records the real actor tier prospectively, never 'unspecified'", () => {
    bootstrapOwner();
    expect(auditRows().every((r) => r.tier === "owner")).toBe(true);
  });
});

describe("operator management", () => {
  beforeEach(() => bootstrapOwner("حسين", "431987"));

  it("creates an operator who must set their own PIN on first login", () => {
    const created = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    expect(created).toMatchObject({ name: "جعفر", role: "cashier", isActive: true, mustResetPin: true });
    // 🔴 The owner typed that PIN, so the owner knows it. An employee's real PIN must not be known
    // to anyone else, which is why a created account still goes through setup.
    expect(svc.authenticate(created.id, "567812").kind).toBe("setup");
  });

  it("refuses a duplicate name, case- and space-insensitively", () => {
    svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    expect(() => svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "123456" })).toThrow(/already called/);
    svc.create(OWNER, { name: "Ali", role: "cashier", pin: "123456" });
    // 🔴 The UNIQUE index is on the raw column, so SQLite would accept these as two rows. The
    // service is what actually stops two operators reading as the same person.
    expect(() => svc.create(OWNER, { name: "  ali ", role: "cashier", pin: "1111" })).toThrow(/already called/);
  });

  it("refuses an invalid PIN at creation", () => {
    expect(() => svc.create(OWNER, { name: "x", role: "cashier", pin: "12" })).toThrow(DomainError);
    expect(svc.listAll().some((o) => o.name === "x")).toBe(false);
  });

  it("🔴 refuses 'admin' — reserved in the schema, not assignable in v1", () => {
    expect(() => svc.create(OWNER, { name: "y", role: "admin" as never, pin: "123456" })).toThrow(
      /owner or cashier/,
    );
  });

  it("renames, resets a PIN, deactivates and reactivates, each with its own event", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    svc.rename(OWNER, op.id, "جعفر صالح");
    svc.resetPin(OWNER, op.id, "876543");
    svc.setActive(OWNER, op.id, false);
    svc.setActive(OWNER, op.id, true);
    expect(auditRows().map((r) => r.type)).toEqual([
      // TRANSITION (O-1 P1, D-O2): enrollment writes three rows: the rename, the PIN, and retiring the seeded cashier.
      "OPERATOR_RENAMED",
      "OPERATOR_PIN_RESET",
      "OPERATOR_DEACTIVATED",
      "OPERATOR_CREATED",
      "OPERATOR_RENAMED",
      "OPERATOR_PIN_RESET",
      "OPERATOR_DEACTIVATED",
      "OPERATOR_ACTIVATED",
    ]);
  });

  it("🔴 an INACTIVE operator cannot authenticate, even with the right PIN", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    const outcome = svc.authenticate(op.id, "567812");
    if (outcome.kind !== "setup") throw new Error("expected setup");
    svc.completeSetup(outcome.ticket, "جعفر", "135790");
    expect(svc.authenticate(op.id, "135790").kind).toBe("session");

    svc.setActive(OWNER, op.id, false);
    expect(() => svc.authenticate(op.id, "135790")).toThrow(/incorrect/);
    // ...and they are not offered on the login screen either.
    expect(svc.listForLogin().some((o) => o.id === op.id)).toBe(false);
  });

  it("🔴 the LAST ACTIVE OWNER cannot be deactivated", () => {
    expect(() => svc.setActive(OWNER, "cashier-01", false)).toThrow(/last active owner/);
    expect(operators.findById("cashier-01")!.is_active).toBe(1);
  });

  it("🔴 the LAST ACTIVE OWNER cannot be demoted", () => {
    const other = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    expect(() => svc.setRole({ ...OWNER, id: other.id, name: "جعفر" }, "cashier-01", "cashier")).toThrow(
      /last active owner/,
    );
    expect(operators.findById("cashier-01")!.role).toBe("owner");
  });

  it("allows demoting an owner once a SECOND active owner exists", () => {
    const second = secondOwner();
    const demoted = svc.setRole({ id: second.id, name: "شريك", role: "owner" }, "cashier-01", "cashier");
    expect(demoted.role).toBe("cashier");
  });

  it("🔴 counts only ACTIVE owners — a deactivated owner does not protect the last one", () => {
    const second = secondOwner();
    svc.setActive(OWNER, second.id, false);
    // Only cashier-01 is an active owner now, so it is protected again.
    expect(() => svc.setActive(OWNER, "cashier-01", false)).toThrow(/last active owner/);
  });

  it("🔴 an operator cannot change their OWN role", () => {
    secondOwner();
    // Even though a second owner exists, so the last-owner rule is not what refuses this.
    expect(() => svc.setRole(OWNER, "cashier-01", "cashier")).toThrow(/their own role/);
    expect(operators.findById("cashier-01")!.role).toBe("owner");
  });

  it("records a role change with before and after", () => {
    // Promotion requires them to have claimed their own account first, so this goes the real route.
    const op = secondOwner("جعفر");
    const changed = auditRows().find((r) => r.type === "OPERATOR_ROLE_CHANGED")!;
    void op;
    expect(JSON.parse(changed.changed!)).toEqual({ role: { before: "cashier", after: "owner" } });
  });

  it("never exposes a salt or a hash in anything the UI receives", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "567812" });
    const blob = JSON.stringify([op, svc.listAll(), svc.listForLogin()]);
    expect(blob.toLowerCase()).not.toMatch(/salt|hash|pin_/);
    expect(blob).not.toContain("567812");
  });

  it("refuses to act on an operator who does not exist", () => {
    expect(() => svc.rename(OWNER, "ghost", "x")).toThrow(/no longer exists/);
    expect(() => svc.resetPin(OWNER, "ghost", "123456")).toThrow(/no longer exists/);
    expect(() => svc.setActive(OWNER, "ghost", false)).toThrow(/no longer exists/);
    expect(() => svc.setRole(OWNER, "ghost", "cashier")).toThrow(/no longer exists/);
  });

  it("a refused mutation writes no audit row at all", () => {
    const before = auditRows().length;
    expect(() => svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "1" })).toThrow();
    expect(() => svc.setActive(OWNER, "cashier-01", false)).toThrow();
    expect(auditRows()).toHaveLength(before);
  });
});

/**
 * 🔴 completeSetup IS ALL OR NOTHING, and this is the proof rather than the claim.
 *
 * It does five things — rename if the name changed, write the new salt and hash, clear
 * must_reset_pin, append OPERATOR_RENAMED, append OPERATOR_PIN_RESET — and a partial outcome is the
 * dangerous one. A cleared flag with the OLD hash would leave a published bootstrap PIN live as an
 * ordinary credential. A new hash with the flag still set would trap the operator in setup for ever.
 * A rename that committed without its audit row would be an unexplained change of identity.
 *
 * The fault is injected at the LAST step, which is the only position that can prove the earlier
 * writes roll back.
 */
describe("completeSetup atomicity", () => {
  /**
   * A service whose audit repository throws on the Nth append.
   *
   * REACH (O-1 P1, 2026-11-25): these tests used to drive the OWNER's bootstrap setup through 1111, which P1 now
   * refuses. The subject is completeSetup's transaction, so they now drive a CREATED operator's setup (the
   * remaining path into completeSetup) on a terminal whose owner was enrolled first. The injected failure counts
   * only this service's own appends, so N means the same step it always meant.
   */
  function serviceFailingAuditAt(n: number) {
    let calls = 0;
    const real = new AuditRepository(db, { appVersion: "0.1.1", schemaVersion: 8 });
    const failing = {
      append: (draft: Parameters<AuditRepository["append"]>[0], id: string) => {
        calls += 1;
        if (calls === n) throw new Error("injected audit failure");
        return real.append(draft, id);
      },
    } as unknown as AuditRepository;
    return new OperatorService({
      operators,
      audit: failing,
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: () => new Date("2026-10-10T12:00:00.000Z"),
      newId: () => `id-${++ids}`,
      ledgerEmpty: () => ledgerEmptiness(db).empty,
    });
  }

  /** An enrolled owner, and a created operator with a temporary PIN, ready to authenticate on any service. */
  function created(tempPin = "567812") {
    bootstrapOwner("حسين", "431987");
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: tempPin });
    return { id: op.id, tempPin, rowsBefore: auditRows().length };
  }

  const snapshot = (id: string) => {
    const r = operators.findById(id)!;
    return { name: r.name, salt: r.pin_salt_hex, hash: r.pin_hash_hex, flag: r.must_reset_pin };
  };

  it("🔴 rolls back EVERYTHING when the final audit append fails", () => {
    const op = created();
    const before = snapshot(op.id);
    // The name changes, so the flow is: rename -> audit(1) -> setPin -> audit(2). Failing at 2 is
    // the case where the rename AND the new credential are already written in this transaction.
    const failing = serviceFailingAuditAt(2);
    const outcome = failing.authenticate(op.id, op.tempPin);
    if (outcome.kind !== "setup") throw new Error("expected setup");
    expect(() => failing.completeSetup(outcome.ticket, "جعفر صالح", "431988")).toThrow(/injected audit failure/);

    // Nothing moved: not the name, not the credential, not the flag.
    expect(snapshot(op.id)).toEqual(before);
    // No audit row survived either — not even the rename that had already been appended.
    expect(auditRows().length).toBe(op.rowsBefore);
    // And the OLD temporary PIN still leads to setup, while the attempted new one does not. This is the
    // assertion that matters: a half-applied setup would have made the new PIN live with the flag set, or
    // left the old one live with the flag cleared.
    expect(failing.authenticate(op.id, op.tempPin).kind).toBe("setup");
    expect(() => failing.authenticate(op.id, "431988")).toThrow(/incorrect/);
  });

  it("rolls back when the FIRST audit append fails, before the credential is written", () => {
    const op = created();
    const before = snapshot(op.id);
    const failing = serviceFailingAuditAt(1);
    const outcome = failing.authenticate(op.id, op.tempPin);
    if (outcome.kind !== "setup") throw new Error("expected setup");
    expect(() => failing.completeSetup(outcome.ticket, "جعفر صالح", "431988")).toThrow();
    expect(snapshot(op.id)).toEqual(before);
    expect(auditRows().length).toBe(op.rowsBefore);
  });

  it("🔴 the ticket SURVIVES a rolled-back attempt, so the operator is not locked out", () => {
    const op = created();
    const failing = serviceFailingAuditAt(2);
    const outcome = failing.authenticate(op.id, op.tempPin);
    if (outcome.kind !== "setup") throw new Error("expected setup");
    expect(() => failing.completeSetup(outcome.ticket, "جعفر صالح", "431988")).toThrow();
    // A crash in the app's own audit layer must not strand the operator at a login screen whose only
    // credential leads to a flow that already failed. The same ticket still works.
    expect(failing.completeSetup(outcome.ticket, "جعفر", "431988").role).toBe("cashier");
    // And a fresh process (no ticket in memory) can still start the setup over with the temporary PIN.
    const working = new OperatorService({
      operators,
      audit: new AuditRepository(db, { appVersion: "0.1.1", schemaVersion: 8 }),
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
    });
    expect(working.authenticate(op.id, "431988").kind).toBe("session");
  });

  it("a rolled-back setup leaves the audit sequence unbroken for the next real write", () => {
    const op = created();
    const failing = serviceFailingAuditAt(1);
    const o1 = failing.authenticate(op.id, op.tempPin);
    if (o1.kind !== "setup") throw new Error("expected setup");
    expect(() => failing.completeSetup(o1.ticket, "جعفر صالح", "431988")).toThrow();
    // seq is allocated as max(seq)+1 inside the transaction, so a rolled-back append must not have
    // consumed a number.
    const retry = svc.authenticate(op.id, op.tempPin);
    if (retry.kind !== "setup") throw new Error("expected setup");
    svc.completeSetup(retry.ticket, "جعفر صالح", "431988");
    const seqs = (db.prepare("SELECT seq FROM audit_events ORDER BY seq").all() as Array<{ seq: bigint }>).map(
      (r) => Number(r.seq),
    );
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(seqs.length).toBe(op.rowsBefore + 2);
  });
});

/**
 * NEW (O-1 Phase 1, 2026-11-25): `enrollOwner` is ONE transaction — the rename, the PIN, retiring the seeded
 * cashier (D-O2) and the claim. A failure at any audit append must leave the shop exactly as it was: unclaimed,
 * both seeded rows untouched, no audit row, and enrollment still possible afterwards.
 */
describe("enrollOwner atomicity", () => {
  function failingAt(n: number) {
    let calls = 0;
    const real = new AuditRepository(db, { appVersion: "0.1.1", schemaVersion: 8 });
    return new OperatorService({
      operators,
      audit: {
        append: (draft: Parameters<AuditRepository["append"]>[0], id: string) => {
          calls += 1;
          if (calls === n) throw new Error("injected audit failure");
          return real.append(draft, id);
        },
      } as unknown as AuditRepository,
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: () => new Date("2026-10-10T12:00:00.000Z"),
      newId: () => `id-${++ids}`,
      ledgerEmpty: () => ledgerEmptiness(db).empty,
    });
  }
  const state = () => ({
    owner: { ...operators.findById("cashier-01")! },
    cashier: { ...operators.findById("cashier-02")! },
    claimed: operators.terminalClaimed(),
    audit: auditRows().length,
  });

  for (const n of [1, 2, 3]) {
    it(`🔴 a failure at audit append ${n} of 3 rolls back everything, and enrollment can be retried`, () => {
      const before = state();
      expect(before.claimed).toBe(false);
      expect(() => failingAt(n).enrollOwner("حسين رقا", "431987")).toThrow(/injected audit failure/);
      expect(state()).toEqual(before);
      // Retried on a working service, it completes.
      expect(svc.enrollOwner("حسين رقا", "431987")).toEqual({ id: "cashier-01", name: "حسين رقا", role: "owner" });
      expect(operators.terminalClaimed()).toBe(true);
    });
  }
});
