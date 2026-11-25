/**
 * O-1 Phase 1: `enrollOwner` — the ONLY way a new shop gets its first owner once the published PINs stopped working.
 *
 * It must succeed on exactly one state (an unclaimed, EMPTY ledger whose seeded owner row is intact) and refuse
 * every other one, leaving nothing behind. Every refusal below asserts the shop is unchanged afterwards: no claim, no
 * renamed row, no new credential, no audit row. Synthetic ledgers only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatorService } from "../../src/application/operatorService";
import { pinMatches } from "../../src/application/cashierAuth";
import { DomainError } from "../../src/domain/errors";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { ledgerEmptiness } from "../../src/persistence/ledgerEmptiness";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
let operators: OperatorRepository;

function service(on: Db = db, opts: { ledgerEmpty?: (() => boolean) | null } = {}) {
  let n = 0;
  return new OperatorService({
    operators: new OperatorRepository(on),
    audit: new AuditRepository(on, { appVersion: "test", schemaVersion: 21 }),
    transact: (fn) => on.transaction(fn).immediate(),
    terminal: FIXTURE_TERMINAL,
    now: () => new Date("2026-11-25T12:00:00.000Z"),
    newId: () => `e-${++n}`,
    ...(opts.ledgerEmpty === null ? {} : { ledgerEmpty: opts.ledgerEmpty ?? (() => ledgerEmptiness(on).empty) }),
  });
}

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
  operators = new OperatorRepository(db);
});
afterEach(() => {
  db.close();
  t.cleanup();
});

/** Everything a refused enrollment must leave exactly as it was. */
const shopState = () => ({
  owner: { ...operators.findById("cashier-01")! },
  cashier: { ...operators.findById("cashier-02")! },
  claim: operators.terminalClaim(),
  audit: (db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: bigint }).n,
});

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("enrollOwner — the one accepted state", () => {
  it("enrolls on an unclaimed, empty ledger: owner named + private PIN, cashier retired (D-O2), terminal claimed", () => {
    const session = service().enrollOwner("حسين رقا", "482613");
    expect(session).toEqual({ id: "cashier-01", name: "حسين رقا", role: "owner" });
    const owner = operators.findById("cashier-01")!;
    expect(owner.must_reset_pin).toBe(0);
    expect(pinMatches({ pinSaltHex: owner.pin_salt_hex, pinHashHex: owner.pin_hash_hex }, "482613")).toBe(true);
    expect(pinMatches({ pinSaltHex: owner.pin_salt_hex, pinHashHex: owner.pin_hash_hex }, "1111")).toBe(false);
    expect(operators.findById("cashier-02")!.is_active).toBe(0);
    expect(operators.terminalClaim()).toEqual({ claimedAt: "2026-11-25T12:00:00.000Z", byOperatorId: "cashier-01" });
    // The audit says what happened and why, with no credential material.
    const rows = db
      .prepare("SELECT event_type AS type, entity_id AS target, metadata_json AS meta FROM audit_events ORDER BY seq")
      .all() as Array<{ type: string; target: string; meta: string }>;
    expect(rows.map((r) => [r.type, r.target])).toEqual([
      ["OPERATOR_RENAMED", "cashier-01"],
      ["OPERATOR_PIN_RESET", "cashier-01"],
      ["OPERATOR_DEACTIVATED", "cashier-02"],
    ]);
    expect(rows.every((r) => JSON.parse(r.meta).origin === "owner_enrollment")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("482613");
    // The new PIN signs in as a session.
    expect(service().authenticate("cashier-01", "482613").kind).toBe("session");
  });
});

describe("enrollOwner — every refusal leaves the shop unchanged", () => {
  it("🔴 not wired (no emptiness check given): NOT_AVAILABLE — it never assumes «empty»", () => {
    const before = shopState();
    expect(refusal(() => service(db, { ledgerEmpty: null }).enrollOwner("حسين", "482613")).code).toBe("NOT_AVAILABLE");
    expect(shopState()).toEqual(before);
  });

  it("🔴 a published PIN cannot be CHOSEN (1111, 2222) — and short ones fail the 6-8 digit rule first", () => {
    const before = shopState();
    for (const pin of ["1111", "2222"]) expect(refusal(() => service().enrollOwner("حسين", pin)).code).toBe("INVALID_PIN");
    expect(refusal(() => service().enrollOwner("حسين", "12345")).code).toBe("INVALID_PIN");
    expect(refusal(() => service().enrollOwner("حسين", "123456789")).code).toBe("INVALID_PIN");
    expect(shopState()).toEqual(before);
  });

  it("refuses an empty name, and a name already used by the other seeded operator", () => {
    const before = shopState();
    expect(refusal(() => service().enrollOwner("   ", "482613")).message).toMatch(/needs a name/);
    expect(refusal(() => service().enrollOwner(" cashier two ", "482613")).message).toMatch(/already called/);
    expect(shopState()).toEqual(before);
  });

  it("🔴 an already-claimed shop: ENROLLMENT_NOT_AVAILABLE, and the real owner keeps their PIN", () => {
    service().enrollOwner("حسين رقا", "482613");
    const before = shopState();
    expect(refusal(() => service().enrollOwner("Stranger", "735190"))).toEqual({
      code: "ENROLLMENT_NOT_AVAILABLE",
      message: "This shop already has an owner",
    });
    expect(shopState()).toEqual(before);
    expect(service().authenticate("cashier-01", "482613").kind).toBe("session");
  });

  it("🔴 an UNCLAIMED ledger with history (the upgraded-shop case): ENROLLMENT_NOT_AVAILABLE", () => {
    db.prepare(
      "INSERT INTO catalog_products (id, source, source_key, name_ar, selling_price_minor, currency, base_unit, price_needs_review, is_active, created_at, updated_at) VALUES ('legacy-1','manual','k','صنف',100,'USD','piece',0,1,'2026-01-01','2026-01-01')",
    ).run();
    const before = shopState();
    expect(refusal(() => service().enrollOwner("Stranger", "735190")).code).toBe("ENROLLMENT_NOT_AVAILABLE");
    expect(shopState()).toEqual(before);
  });

  it("🔴 an unclassified table counts as history: refused (fail closed)", () => {
    db.exec("CREATE TABLE unknown_future (x TEXT)");
    expect(refusal(() => service().enrollOwner("Stranger", "735190")).code).toBe("ENROLLMENT_NOT_AVAILABLE");
    expect(operators.terminalClaimed()).toBe(false);
  });

  it("🔴 the emptiness answer is read INSIDE the transaction (a check that says «not empty» at that moment wins)", () => {
    // The service's own pre-checks run first; the emptiness callback is consulted only inside the transaction.
    let calls = 0;
    const svc = service(db, {
      ledgerEmpty: () => {
        calls += 1;
        expect(db.inTransaction).toBe(true);
        return false;
      },
    });
    expect(refusal(() => svc.enrollOwner("حسين", "482613")).code).toBe("ENROLLMENT_NOT_AVAILABLE");
    expect(calls).toBe(1);
    expect(operators.terminalClaimed()).toBe(false);
  });

  it("🔴 the seeded owner row is not in its initial state (deactivated, or demoted): refused", () => {
    db.prepare("UPDATE operators SET is_active = 0 WHERE id = 'cashier-01'").run();
    expect(refusal(() => service().enrollOwner("حسين", "482613")).message).toMatch(/not in its initial state/);
    db.prepare("UPDATE operators SET is_active = 1, role = 'cashier' WHERE id = 'cashier-01'").run();
    expect(refusal(() => service().enrollOwner("حسين", "482613")).message).toMatch(/not in its initial state/);
    expect(operators.terminalClaimed()).toBe(false);
  });

  it("🔴 SECOND CONNECTION: two connections to the same file enroll one after the other — the second is refused by the in-transaction re-read", () => {
    const second = openDatabase(t.dbPath);
    try {
      const a = service(db);
      const b = service(second);
      expect(a.enrollOwner("الأول", "482613").name).toBe("الأول");
      expect(refusal(() => b.enrollOwner("الثاني", "735190")).code).toBe("ENROLLMENT_NOT_AVAILABLE");
      expect(operators.findById("cashier-01")!.name).toBe("الأول");
      expect(service(second).authenticate("cashier-01", "482613").kind).toBe("session");
      expect(refusal(() => service(second).authenticate("cashier-01", "735190")).code).toBe("INVALID_CREDENTIALS");
    } finally {
      second.close();
    }
  });
});
