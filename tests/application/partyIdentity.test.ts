/**
 * Customer and supplier accounts: identity, authorization, and the history an edit leaves behind.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS GUARDING. S1A builds a DIRECTORY, and the two ways a directory quietly
 * becomes dangerous are (1) treating a shared name as a shared identity, which merges two
 * strangers' debts the moment obligations land, and (2) letting a correction overwrite the past, so
 * "what number did we have in March" stops having an answer. Both are asserted here, and so is the
 * thing that must NOT be here: any money at all.
 *
 * Disposable database per test. Synthetic names only.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PartyService, type PartyActor } from "../../src/application/partyService";
import { PartyRepository } from "../../src/persistence/partyRepository";
import { normalizedName, sameNameAs } from "../../src/domain/party";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let actor: PartyActor | null;
let service: PartyService;
let repo: PartyRepository;
let clockMs: number;

const OWNER: PartyActor = { id: "cashier-01", name: "Owner One", role: "owner" };
const CASHIER: PartyActor = { id: "cashier-02", name: "Cashier Two", role: "cashier" };

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  repo = new PartyRepository(h.db);
  actor = OWNER;
  clockMs = Date.parse("2026-10-22T08:00:00.000Z");
  let n = 0;
  service = new PartyService({
    parties: repo,
    actor: () => actor,
    transact: (fn) => h.db.transaction(fn).immediate(),
    now: () => new Date((clockMs += 1000)),
    newId: () => `party-${++n}`,
  });
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "NO_CODE";
  }
  throw new Error("expected a refusal");
};

describe("party identity", () => {
  // ── Identity ────────────────────────────────────────────────────────────────────────────────
  it("a customer needs a name, and gets a durable id that is not the name", () => {
    const { party } = service.create({ kind: "customer", displayName: "أبو خالد" });
    expect(party.id).toBe("party-1");
    expect(party.kind).toBe("customer");
    expect(party.display_name).toBe("أبو خالد");
    expect(party.is_active).toBe(1);
    expect(party.created_by).toBe("cashier-01");
    // Renaming does not change the id — which is the whole point of having one.
    const renamed = service.updateContact("customer", party.id, { displayName: "خالد عبدالله" });
    expect(renamed.id).toBe(party.id);
    expect(renamed.display_name).toBe("خالد عبدالله");
  });

  it("🔴 refuses an empty, blank or non-string name", () => {
    for (const bad of ["", "   ", "\t\n", null, undefined, 7, {}]) {
      expect(code(() => service.create({ kind: "customer", displayName: bad })), String(bad)).toBe("INVALID_INPUT");
    }
    expect(repo.countByKind("customer")).toBe(0);
  });

  it("Arabic and English names both survive storage unchanged, trimmed but never folded", () => {
    const ar = service.create({ kind: "customer", displayName: "  مؤسسة الزبط التجارية  " }).party;
    const en = service.create({ kind: "customer", displayName: "Alzabt Trading Co." }).party;
    expect(ar.display_name).toBe("مؤسسة الزبط التجارية");
    expect(en.display_name).toBe("Alzabt Trading Co.");
    // Case is preserved: the merchant reads back what they typed.
    expect(service.create({ kind: "customer", displayName: "AHMAD" }).party.display_name).toBe("AHMAD");
  });

  it("contact details are optional, and empty text means absent rather than blank", () => {
    const bare = service.create({ kind: "customer", displayName: "بلا تفاصيل" }).party;
    expect(bare.phone).toBeNull();
    expect(bare.address).toBeNull();
    expect(bare.note).toBeNull();
    const blanked = service.create({
      kind: "customer",
      displayName: "فراغات",
      phone: "   ",
      address: "",
      note: "\t",
    }).party;
    expect(blanked.phone).toBeNull();
    expect(blanked.address).toBeNull();
    expect(blanked.note).toBeNull();
  });

  // ── Duplicates are reported, never merged ───────────────────────────────────────────────────
  it("🔴 two customers may share a name — both exist, with different ids, and NOTHING merges", () => {
    const first = service.create({ kind: "customer", displayName: "محمد علي" });
    expect(first.sameName).toEqual([]);
    const second = service.create({ kind: "customer", displayName: "محمد علي" });

    // The second creation is NOT refused, and it reports the first as information.
    expect(second.party.id).not.toBe(first.party.id);
    expect(second.sameName.map((p) => p.id)).toEqual([first.party.id]);
    expect(repo.countByKind("customer")).toBe(2);

    // And they stay two rows with two independent sets of details.
    service.updateContact("customer", first.party.id, { phone: "0100" });
    expect(service.get("customer", second.party.id).phone).toBeNull();
  });

  it("a same-name warning ignores case, spacing and Arabic-Indic digits — it does not ignore people", () => {
    const first = service.create({ kind: "customer", displayName: "Ahmad  Saleh" }).party;
    const again = service.create({ kind: "customer", displayName: "ahmad saleh" });
    expect(again.sameName.map((p) => p.id)).toEqual([first.id]);
    expect(sameNameAs("شركة ٧", "شركة 7")).toBe(true);
    expect(normalizedName("  A   B ")).toBe("a b");
    // Two accounts, still.
    expect(repo.countByKind("customer")).toBe(2);
  });

  it("a shared phone number does not make one account either", () => {
    const a = service.create({ kind: "customer", displayName: "الأب", phone: "0111" }).party;
    const b = service.create({ kind: "customer", displayName: "الابن", phone: "0111" }).party;
    expect(a.id).not.toBe(b.id);
    expect(service.search("customer", "0111").map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  // ── Customers and suppliers never mix ───────────────────────────────────────────────────────
  it("🔴 a trader who is BOTH is two accounts, and neither list shows the other", () => {
    const customer = service.create({ kind: "customer", displayName: "تاجر مشترك" }).party;
    const supplier = service.create({ kind: "supplier", displayName: "تاجر مشترك" }).party;
    expect(customer.id).not.toBe(supplier.id);

    expect(service.list("customer").map((p) => p.id)).toEqual([customer.id]);
    expect(service.list("supplier").map((p) => p.id)).toEqual([supplier.id]);
    expect(service.search("customer", "تاجر").map((p) => p.id)).toEqual([customer.id]);
    expect(service.search("supplier", "تاجر").map((p) => p.id)).toEqual([supplier.id]);
    // A same-name warning is scoped to its own kind, so the two sides never inform each other.
    expect(service.findDuplicateNames("supplier", "تاجر مشترك").map((p) => p.id)).toEqual([supplier.id]);
  });

  it("🔴 a search result is bound to the right id, and the wrong kind's id is REFUSED", () => {
    const customer = service.create({ kind: "customer", displayName: "زبون" }).party;
    const supplier = service.create({ kind: "supplier", displayName: "مورّد" }).party;
    expect(service.get("customer", customer.id).id).toBe(customer.id);
    // Asking for a supplier by a customer's id must not quietly return the customer.
    expect(code(() => service.get("supplier", customer.id))).toBe("PARTY_NOT_FOUND");
    expect(code(() => service.get("customer", supplier.id))).toBe("PARTY_NOT_FOUND");
    expect(code(() => service.get("customer", "no-such-id"))).toBe("PARTY_NOT_FOUND");
  });

  it("🔴 the kind cannot be changed, so an obligation can never land on the wrong side", () => {
    const customer = service.create({ kind: "customer", displayName: "ثابت" }).party;
    expect(() =>
      h.db.prepare(`UPDATE parties SET kind = 'supplier' WHERE id = ?`).run(customer.id),
    ).toThrow(/kind cannot change/);
    expect(service.get("customer", customer.id).kind).toBe("customer");
  });

  // ── Authorization ───────────────────────────────────────────────────────────────────────────
  it("any signed-in operator may register a CUSTOMER — a cashier takes the name at the till", () => {
    actor = CASHIER;
    const { party } = service.create({ kind: "customer", displayName: "زبون الكاشير" });
    expect(party.created_by).toBe("cashier-02");
    expect(service.search("customer", "الكاشير").length).toBe(1);
  });

  it("🔴 a cashier may NOT create, read, edit or archive a SUPPLIER", () => {
    const supplier = service.create({ kind: "supplier", displayName: "مورّد" }).party;
    actor = CASHIER;
    expect(code(() => service.create({ kind: "supplier", displayName: "مورّد جديد" }))).toBe("NOT_AUTHORIZED");
    expect(code(() => service.list("supplier"))).toBe("NOT_AUTHORIZED");
    expect(code(() => service.get("supplier", supplier.id))).toBe("NOT_AUTHORIZED");
    expect(code(() => service.updateContact("supplier", supplier.id, { phone: "0100" }))).toBe("NOT_AUTHORIZED");
    expect(code(() => service.setActive("supplier", supplier.id, false))).toBe("NOT_AUTHORIZED");
    // The refusal wrote nothing.
    actor = OWNER;
    expect(repo.countByKind("supplier")).toBe(1);
    expect(service.get("supplier", supplier.id).phone).toBeNull();
  });

  it("🔴 nobody signed in may do anything at all", () => {
    const customer = service.create({ kind: "customer", displayName: "زبون" }).party;
    actor = null;
    for (const call of [
      () => service.create({ kind: "customer", displayName: "خفي" }),
      () => service.list("customer"),
      () => service.search("customer", "ز"),
      () => service.get("customer", customer.id),
      () => service.updateContact("customer", customer.id, { phone: "0100" }),
      () => service.setActive("customer", customer.id, false),
      () => service.history("customer", customer.id),
    ]) {
      expect(code(call)).toBe("NOT_LOGGED_IN");
    }
    actor = OWNER;
    expect(repo.countByKind("customer")).toBe(1);
  });

  // ── History ─────────────────────────────────────────────────────────────────────────────────
  it("🔴 a correction APPENDS history and never loses the old value", () => {
    const { party } = service.create({ kind: "customer", displayName: "قديم", phone: "0100" });
    service.updateContact("customer", party.id, { displayName: "جديد", phone: "0200", address: "شارع" });

    const rows = service.history("customer", party.id);
    expect(rows.map((r) => [r.field, r.old_value, r.new_value])).toEqual([
      ["display_name", "قديم", "جديد"],
      ["phone", "0100", "0200"],
      ["address", null, "شارع"],
    ]);
    for (const r of rows) expect(r.changed_by).toBe("cashier-01");
    expect(service.get("customer", party.id).display_name).toBe("جديد");
  });

  it("clearing a field is history too, and a no-op change writes none", () => {
    const { party } = service.create({ kind: "customer", displayName: "زبون", phone: "0100" });
    service.updateContact("customer", party.id, { phone: null });
    expect(service.history("customer", party.id).map((r) => [r.field, r.old_value, r.new_value])).toEqual([
      ["phone", "0100", null],
    ]);
    // Writing the same values again changes nothing and records nothing.
    service.updateContact("customer", party.id, { displayName: "زبون", phone: null });
    expect(service.history("customer", party.id).length).toBe(1);
  });

  it("🔴 contact history is append-only in the DATABASE, not merely in the service", () => {
    const { party } = service.create({ kind: "customer", displayName: "أ", phone: "1" });
    service.updateContact("customer", party.id, { phone: "2" });
    const id = service.history("customer", party.id)[0]!.id;
    expect(() => h.db.prepare(`UPDATE party_contact_history SET new_value = 'x' WHERE id = ?`).run(id)).toThrow(
      /append-only/,
    );
    expect(() => h.db.prepare(`DELETE FROM party_contact_history WHERE id = ?`).run(id)).toThrow(/cannot be deleted/);
  });

  // ── Archive, never delete ───────────────────────────────────────────────────────────────────
  it("🔴 an account is archived, never deleted — and stays resolvable by id", () => {
    const { party } = service.create({ kind: "customer", displayName: "مؤرشف" });
    expect(() => h.db.prepare(`DELETE FROM parties WHERE id = ?`).run(party.id)).toThrow(/never deleted/);

    service.setActive("customer", party.id, false);
    expect(service.list("customer").map((p) => p.id)).toEqual([]);
    expect(service.list("customer", true).map((p) => p.id)).toEqual([party.id]);
    expect(service.get("customer", party.id).is_active).toBe(0);
    // And it can come back.
    service.setActive("customer", party.id, true);
    expect(service.list("customer").map((p) => p.id)).toEqual([party.id]);
  });

  // ── Transactions ────────────────────────────────────────────────────────────────────────────
  it("🔴 a failed write inside the transaction leaves NO half-account and NO orphan history", () => {
    const { party } = service.create({ kind: "customer", displayName: "سليم", phone: "0100" });
    const append = repo.appendHistory.bind(repo);
    repo.appendHistory = () => {
      throw new Error("history write exploded");
    };
    expect(() => service.updateContact("customer", party.id, { phone: "0200" })).toThrow(/exploded/);
    repo.appendHistory = append;

    // The row is unchanged and nothing was recorded: the update and its history commit together.
    expect(service.get("customer", party.id).phone).toBe("0100");
    expect(service.history("customer", party.id)).toEqual([]);
  });

  // ── No money, anywhere ──────────────────────────────────────────────────────────────────────
  it("🔴 creating accounts posts NOTHING financial — no sale, invoice, void or audit row", () => {
    const counts = () => ({
      sales: Number((h.db.prepare(`SELECT count(*) AS n FROM sales`).get() as { n: bigint }).n),
      lines: Number((h.db.prepare(`SELECT count(*) AS n FROM sale_lines`).get() as { n: bigint }).n),
      invoices: Number((h.db.prepare(`SELECT count(*) AS n FROM invoices`).get() as { n: bigint }).n),
      voids: Number((h.db.prepare(`SELECT count(*) AS n FROM voids`).get() as { n: bigint }).n),
      audit: Number((h.db.prepare(`SELECT count(*) AS n FROM audit_events`).get() as { n: bigint }).n),
    });
    const before = counts();
    service.create({ kind: "customer", displayName: "زبون" });
    const supplier = service.create({ kind: "supplier", displayName: "مورّد" }).party;
    service.updateContact("supplier", supplier.id, { phone: "0100", note: "دفعة شهرية" });
    service.setActive("supplier", supplier.id, false);
    expect(counts()).toEqual(before);
  });

  it("🔴 the service exposes no balance of any kind — a directory is not a ledger", () => {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
    for (const forbidden of ["balance", "owed", "debt", "credit", "settle", "pay", "obligation", "statement"]) {
      expect(
        names.filter((n) => n.toLowerCase().includes(forbidden)),
        `PartyService must expose no ${forbidden} method in S1A`,
      ).toEqual([]);
    }
  });
});
