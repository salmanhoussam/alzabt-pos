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
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { OperatorService } from "../../src/application/operatorService";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
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

/** Signs the owner in with the bootstrap PIN and finishes setup. Returns the session. */
function bootstrapOwner(name = "حسين", pin = "4321") {
  const outcome = svc.authenticate("cashier-01", "1111");
  if (outcome.kind !== "setup") throw new Error("expected setup");
  return svc.completeSetup(outcome.ticket, name, pin);
}

describe("the two migrated accounts", () => {
  it("exist with the approved roles and both require a reset", () => {
    expect(svc.listAll()).toEqual([
      { id: "cashier-01", name: "Cashier One", role: "owner", isActive: true, mustResetPin: true },
      { id: "cashier-02", name: "Cashier Two", role: "cashier", isActive: true, mustResetPin: true },
    ]);
  });

  it("🔴 a correct bootstrap PIN yields a SETUP TICKET and NO session", () => {
    const outcome = svc.authenticate("cashier-01", "1111");
    expect(outcome.kind).toBe("setup");
    if (outcome.kind !== "setup") return;
    expect(outcome.operatorId).toBe("cashier-01");
    expect(outcome.ticket).toMatch(/^[0-9a-f]{48}$/);
    // There is no session field to read, in the type or at runtime: a bootstrap credential cannot
    // produce one, which is the whole point.
    expect("session" in outcome).toBe(false);
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
    const session = bootstrapOwner("حسين رقا", "4321");
    expect(session).toEqual({ id: "cashier-01", name: "حسين رقا", role: "owner" });

    const row = operators.findById("cashier-01")!;
    expect(row.must_reset_pin).toBe(0);
    expect(row.name).toBe("حسين رقا");
    expect(row.pin_hash_hex).not.toBe("a8f8c45b97712daec733a8b4d198ac96376c05697b5935a7b30f965e27478bce");
    expect(row.pin_salt_hex).not.toBe("a1f3c9e27b4d6058");
  });

  it("🔴 the OLD bootstrap PIN stops authenticating, and the NEW one works", () => {
    bootstrapOwner("حسين", "4321");
    expect(() => svc.authenticate("cashier-01", "1111")).toThrow(/incorrect/);
    const again = svc.authenticate("cashier-01", "4321");
    expect(again.kind).toBe("session");
  });

  it("🔴 the ticket is consumed — it cannot be replayed to rewrite the PIN", () => {
    const outcome = svc.authenticate("cashier-01", "1111");
    if (outcome.kind !== "setup") throw new Error("expected setup");
    svc.completeSetup(outcome.ticket, "حسين", "4321");
    expect(() => svc.completeSetup(outcome.ticket, "مهاجم", "9999")).toThrow(/Sign in again/);
    // And the PIN the attacker tried does not work.
    expect(() => svc.authenticate("cashier-01", "9999")).toThrow(/incorrect/);
  });

  it("a forged or stale ticket is refused", () => {
    svc.authenticate("cashier-01", "1111");
    expect(() => svc.completeSetup("f".repeat(48), "x", "4321")).toThrow(/Sign in again/);
  });

  it("🔴 a ticket for one operator cannot set up ANOTHER operator", () => {
    const first = svc.authenticate("cashier-01", "1111");
    if (first.kind !== "setup") throw new Error("expected setup");
    // A second bootstrap login replaces the single slot, so the first ticket dies. The ticket names
    // its operator, so there is no field in which to substitute a different one.
    const second = svc.authenticate("cashier-02", "2222");
    if (second.kind !== "setup") throw new Error("expected setup");
    expect(() => svc.completeSetup(first.ticket, "x", "4321")).toThrow(/Sign in again/);

    svc.completeSetup(second.ticket, "جعفر", "5678");
    // Only cashier-02 was set up. The owner is still waiting.
    expect(operators.findById("cashier-01")!.must_reset_pin).toBe(1);
    expect(operators.findById("cashier-02")!.must_reset_pin).toBe(0);
  });

  it("a restart does not bypass the reset — the flag is on disk, the ticket is not", () => {
    svc.authenticate("cashier-01", "1111");
    // A fresh service is a fresh process: the in-memory ticket is gone.
    const restarted = new OperatorService({
      operators,
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
    });
    expect(restarted.authenticate("cashier-01", "1111").kind).toBe("setup");
    expect(operators.findById("cashier-01")!.must_reset_pin).toBe(1);
  });

  it("refuses a PIN that is not 4-8 digits, and leaves the account in setup", () => {
    const outcome = svc.authenticate("cashier-01", "1111");
    if (outcome.kind !== "setup") throw new Error("expected setup");
    for (const bad of ["123", "123456789", "12a4", "", "12 34", " 1234"]) {
      expect(() => svc.completeSetup(outcome.ticket, "حسين", bad)).toThrow(DomainError);
    }
    expect(operators.findById("cashier-01")!.must_reset_pin).toBe(1);
    // 🔴 The ticket SURVIVES a refused PIN, so a typo does not send the operator back to login.
    expect(() => svc.completeSetup(outcome.ticket, "حسين", "4321")).not.toThrow();
  });

  it("refuses an empty name", () => {
    const outcome = svc.authenticate("cashier-01", "1111");
    if (outcome.kind !== "setup") throw new Error("expected setup");
    expect(() => svc.completeSetup(outcome.ticket, "   ", "4321")).toThrow(/needs a name/);
  });

  it("🔴 writes TWO events when the name changed — a rename and a reset, not one ambiguous act", () => {
    bootstrapOwner("حسين رقا", "4321");
    const rows = auditRows();
    expect(rows.map((r) => r.type)).toEqual(["OPERATOR_RENAMED", "OPERATOR_PIN_RESET"]);
    expect(rows.every((r) => r.target === "cashier-01")).toBe(true);
    expect(rows.every((r) => JSON.parse(r.meta!).origin === "bootstrap_setup")).toBe(true);
    // The rename says what it changed, from what, to what.
    expect(JSON.parse(rows[0]!.changed!)).toEqual({
      name: { before: "Cashier One", after: "حسين رقا" },
    });
  });

  it("writes ONLY the reset when the operator kept the name — no empty rename", () => {
    bootstrapOwner("Cashier One", "4321");
    expect(auditRows().map((r) => r.type)).toEqual(["OPERATOR_PIN_RESET"]);
  });

  it("🔴 a PIN reset's audit row carries NO credential material at all", () => {
    bootstrapOwner("حسين", "4321");
    const reset = auditRows().find((r) => r.type === "OPERATOR_PIN_RESET")!;
    expect(JSON.parse(reset.changed!)).toEqual({});
    const blob = JSON.stringify(reset);
    // Neither PIN appears anywhere in the row.
    expect(blob).not.toContain("4321");
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
  beforeEach(() => bootstrapOwner("حسين", "4321"));

  it("creates an operator who must set their own PIN on first login", () => {
    const created = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    expect(created).toMatchObject({ name: "جعفر", role: "cashier", isActive: true, mustResetPin: true });
    // 🔴 The owner typed that PIN, so the owner knows it. An employee's real PIN must not be known
    // to anyone else, which is why a created account still goes through setup.
    expect(svc.authenticate(created.id, "5678").kind).toBe("setup");
  });

  it("refuses a duplicate name, case- and space-insensitively", () => {
    svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    expect(() => svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "1234" })).toThrow(/already called/);
    svc.create(OWNER, { name: "Ali", role: "cashier", pin: "1234" });
    // 🔴 The UNIQUE index is on the raw column, so SQLite would accept these as two rows. The
    // service is what actually stops two operators reading as the same person.
    expect(() => svc.create(OWNER, { name: "  ali ", role: "cashier", pin: "1111" })).toThrow(/already called/);
  });

  it("refuses an invalid PIN at creation", () => {
    expect(() => svc.create(OWNER, { name: "x", role: "cashier", pin: "12" })).toThrow(DomainError);
    expect(svc.listAll().some((o) => o.name === "x")).toBe(false);
  });

  it("🔴 refuses 'admin' — reserved in the schema, not assignable in v1", () => {
    expect(() => svc.create(OWNER, { name: "y", role: "admin" as never, pin: "1234" })).toThrow(
      /owner or cashier/,
    );
  });

  it("renames, resets a PIN, deactivates and reactivates, each with its own event", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    svc.rename(OWNER, op.id, "جعفر صالح");
    svc.resetPin(OWNER, op.id, "8765");
    svc.setActive(OWNER, op.id, false);
    svc.setActive(OWNER, op.id, true);
    expect(auditRows().map((r) => r.type)).toEqual([
      "OPERATOR_RENAMED",
      "OPERATOR_PIN_RESET",
      "OPERATOR_CREATED",
      "OPERATOR_RENAMED",
      "OPERATOR_PIN_RESET",
      "OPERATOR_DEACTIVATED",
      "OPERATOR_ACTIVATED",
    ]);
  });

  it("🔴 an INACTIVE operator cannot authenticate, even with the right PIN", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    const outcome = svc.authenticate(op.id, "5678");
    if (outcome.kind !== "setup") throw new Error("expected setup");
    svc.completeSetup(outcome.ticket, "جعفر", "1357");
    expect(svc.authenticate(op.id, "1357").kind).toBe("session");

    svc.setActive(OWNER, op.id, false);
    expect(() => svc.authenticate(op.id, "1357")).toThrow(/incorrect/);
    // ...and they are not offered on the login screen either.
    expect(svc.listForLogin().some((o) => o.id === op.id)).toBe(false);
  });

  it("🔴 the LAST ACTIVE OWNER cannot be deactivated", () => {
    expect(() => svc.setActive(OWNER, "cashier-01", false)).toThrow(/last active owner/);
    expect(operators.findById("cashier-01")!.is_active).toBe(1);
  });

  it("🔴 the LAST ACTIVE OWNER cannot be demoted", () => {
    const other = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    expect(() => svc.setRole({ ...OWNER, id: other.id, name: "جعفر" }, "cashier-01", "cashier")).toThrow(
      /last active owner/,
    );
    expect(operators.findById("cashier-01")!.role).toBe("owner");
  });

  it("allows demoting an owner once a SECOND active owner exists", () => {
    const second = svc.create(OWNER, { name: "شريك", role: "owner", pin: "5678" });
    const demoted = svc.setRole({ id: second.id, name: "شريك", role: "owner" }, "cashier-01", "cashier");
    expect(demoted.role).toBe("cashier");
  });

  it("🔴 counts only ACTIVE owners — a deactivated owner does not protect the last one", () => {
    const second = svc.create(OWNER, { name: "شريك", role: "owner", pin: "5678" });
    svc.setActive(OWNER, second.id, false);
    // Only cashier-01 is an active owner now, so it is protected again.
    expect(() => svc.setActive(OWNER, "cashier-01", false)).toThrow(/last active owner/);
  });

  it("🔴 an operator cannot change their OWN role", () => {
    svc.create(OWNER, { name: "شريك", role: "owner", pin: "5678" });
    // Even though a second owner exists, so the last-owner rule is not what refuses this.
    expect(() => svc.setRole(OWNER, "cashier-01", "cashier")).toThrow(/their own role/);
    expect(operators.findById("cashier-01")!.role).toBe("owner");
  });

  it("records a role change with before and after", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    svc.setRole(OWNER, op.id, "owner");
    const changed = auditRows().find((r) => r.type === "OPERATOR_ROLE_CHANGED")!;
    expect(JSON.parse(changed.changed!)).toEqual({ role: { before: "cashier", after: "owner" } });
  });

  it("never exposes a salt or a hash in anything the UI receives", () => {
    const op = svc.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    const blob = JSON.stringify([op, svc.listAll(), svc.listForLogin()]);
    expect(blob.toLowerCase()).not.toMatch(/salt|hash|pin_/);
    expect(blob).not.toContain("5678");
  });

  it("refuses to act on an operator who does not exist", () => {
    expect(() => svc.rename(OWNER, "ghost", "x")).toThrow(/no longer exists/);
    expect(() => svc.resetPin(OWNER, "ghost", "1234")).toThrow(/no longer exists/);
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
