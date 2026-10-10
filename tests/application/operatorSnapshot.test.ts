/**
 * The ledger's operator SNAPSHOT contract, after the fixture → repository swap.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE PROPERTY THIS PROVES. `sales.cashier_id` / `cashier_name` and `voids.cashier_id` /
 * `cashier_name` are plain TEXT with NO foreign key, by design since migration 1. They are a
 * SNAPSHOT: what was true at the moment of the act. So renaming an operator must leave every past
 * sale reading exactly as it read before — a receipt reprinted next year must still name the person
 * who rang it up, under the name they had that day.
 *
 * The failure this guards against is the natural-looking one: joining `sales` to `operators` to
 * "show the real name". That would silently rewrite history every time anyone was renamed, and it
 * would look like a feature.
 *
 * Every row below is read back from the DATABASE, not from a service return value, because the
 * claim is about what is stored.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

const OWNER = { id: "cashier-01", name: "Cashier One", role: "owner" as const };

beforeEach(() => {
  t = tempDir();
  // `login: false` so each test chooses who is signed in; the harness has already cleared the
  // bootstrap flags, so a plain login is a real session with a real role.
  h = makeHarness(t.dbPath, { login: false });
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

/** The same shape posService.test.ts uses, copied rather than guessed. */
const ESPRESSO_X2 = { lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n };

function sell(): string {
  const { sale } = h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", ...ESPRESSO_X2 });
  return sale.id;
}

/** Read with the service untouched: this is what the ledger actually holds. */
const saleRow = (id: string) =>
  h.db.prepare("SELECT cashier_id AS id, cashier_name AS name FROM sales WHERE id = ?").get(id) as {
    id: string;
    name: string;
  };

describe("a sale snapshots the operator who made it", () => {
  it("A-D · records the REAL operator id and their name at the moment of sale", () => {
    // A · a real operator signs in — cashier-02 is a real `operators` row, not a fixture lookup.
    const outcome = h.service.login("cashier-02", "2222");
    expect(outcome.kind).toBe("session");

    // B · a real sale.
    const saleId = sell();

    // C/D · read from the database.
    expect(saleRow(saleId)).toEqual({ id: "cashier-02", name: "Cashier Two" });
  });

  it("🔴 E-G · renaming the operator does NOT touch a sale already recorded", () => {
    h.service.login("cashier-02", "2222");
    const before = sell();
    const asRecorded = saleRow(before);
    expect(asRecorded.name).toBe("Cashier Two");

    // E · the owner renames them.
    h.service.login("cashier-01", "1111");
    h.operators.rename(OWNER, "cashier-02", "جعفر صالح");
    expect(h.operators.listAll().find((o) => o.id === "cashier-02")!.name).toBe("جعفر صالح");

    // F/G · the OLD sale is byte-identical. If anything resolved the name through a join, this is
    // the assertion that would fail.
    expect(saleRow(before)).toEqual(asRecorded);
    expect(saleRow(before).name).toBe("Cashier Two");
  });

  it("🔴 H-I · a sale made AFTER the rename carries the same id and the NEW name", () => {
    h.service.login("cashier-02", "2222");
    const before = sell();

    h.service.login("cashier-01", "1111");
    h.operators.rename(OWNER, "cashier-02", "جعفر صالح");

    // The operator signs in again and sells.
    h.service.login("cashier-02", "2222");
    const after = sell();

    expect(saleRow(after)).toEqual({ id: "cashier-02", name: "جعفر صالح" });
    // The id is the stable identity across the rename; the NAME is what differs between the two
    // rows. That pairing is the whole snapshot contract in one assertion.
    expect(saleRow(before).id).toBe(saleRow(after).id);
    expect(saleRow(before).name).not.toBe(saleRow(after).name);
  });

  it("🔴 a rename DURING a session reaches the next sale — the snapshot is the act, not the login", () => {
    // The operator stays signed in while the owner renames them from another surface. Reading the
    // name from the SESSION would snapshot what was true at login, hours and one rename ago.
    h.service.login("cashier-02", "2222");
    const early = sell();

    // Rename without that operator signing in again.
    h.operators.rename(OWNER, "cashier-02", "جعفر صالح");

    const late = sell();
    expect(saleRow(early).name).toBe("Cashier Two");
    expect(saleRow(late).name).toBe("جعفر صالح");
  });

  it("falls back to the session name when the operator row has gone", () => {
    // An operator is never deleted by the application, so this is a torn-database case rather than
    // a reachable one. A missing name must not be what stops a sale from being recorded — the
    // column is NOT NULL with a non-empty CHECK.
    h.service.login("cashier-02", "2222");
    h.db.prepare("DELETE FROM operators WHERE id = 'cashier-02'").run();
    const saleId = sell();
    expect(saleRow(saleId)).toEqual({ id: "cashier-02", name: "Cashier Two" });
  });
});

describe("a void snapshots its own actor the same way", () => {
  it("records the owner who voided, and a later rename does not alter it", () => {
    h.service.login("cashier-02", "2222");
    const saleId = sell();

    // Voiding is an owner act.
    h.service.login("cashier-01", "1111");
    h.service.voidSale(saleId, "wrong item rung up");

    const voidRow = () =>
      h.db.prepare("SELECT cashier_id AS id, cashier_name AS name FROM voids WHERE sale_id = ?").get(saleId) as {
        id: string;
        name: string;
      };
    expect(voidRow()).toEqual({ id: "cashier-01", name: "Cashier One" });

    // Rename the owner — their own void must read as it did.
    h.operators.rename(OWNER, "cashier-01", "حسين رقا");
    expect(voidRow()).toEqual({ id: "cashier-01", name: "Cashier One" });
  });
});

describe("audit rows snapshot the actor too", () => {
  it("an operator event keeps the actor name it was written with", () => {
    h.service.login("cashier-01", "1111");
    const created = h.operators.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });

    const row = () =>
      h.db
        .prepare(
          `SELECT actor_name AS actor, actor_tier AS tier FROM audit_events
            WHERE entity_type = 'operator' AND entity_id = ? ORDER BY seq`,
        )
        .get(created.id) as { actor: string; tier: string };
    expect(row()).toEqual({ actor: "Cashier One", tier: "owner" });

    // The audit trail is append-only, so this is also a check that nothing rewrites it on rename.
    h.operators.rename(OWNER, "cashier-01", "حسين رقا");
    expect(row()).toEqual({ actor: "Cashier One", tier: "owner" });
  });
});

describe("the application no longer depends on the bundled fixtures", () => {
  it("🔴 listCashiers comes from the TABLE — a row the fixtures never had is offered", () => {
    h.service.login("cashier-01", "1111");
    const created = h.operators.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    const offered = h.service.listCashiers();
    expect(offered.some((c) => c.id === created.id)).toBe(true);
    // And a deactivated operator disappears from it, which a compiled-in array could never express.
    h.operators.setActive(OWNER, created.id, false);
    expect(h.service.listCashiers().some((c) => c.id === created.id)).toBe(false);
  });

  it("🔴 the login list carries ONLY id and name — no role, no status, no credential", () => {
    const offered = h.service.listCashiers();
    expect(offered.length).toBeGreaterThan(0);
    for (const entry of offered) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name"]);
    }
    const blob = JSON.stringify(offered).toLowerCase();
    expect(blob).not.toMatch(/role|salt|hash|must_reset|isactive|pending/);
  });

  it("a PIN set through the repository authenticates, which the fixture array cannot explain", () => {
    h.service.login("cashier-01", "1111");
    const created = h.operators.create(OWNER, { name: "جعفر", role: "cashier", pin: "5678" });
    const setup = h.service.login(created.id, "5678");
    if (setup.kind !== "setup") throw new Error("expected setup");
    h.service.completeBootstrapSetup(setup.ticket, "جعفر صالح", "1357");
    h.service.logout();
    // A credential that exists ONLY in the database now opens a session.
    expect(h.service.login(created.id, "1357").kind).toBe("session");
  });
});
