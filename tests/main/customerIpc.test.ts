/**
 * The customer channels: what they expose, who may call them, and what they refuse.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE BRIDGE IS THE UNTRUSTED SIDE. Every assertion here calls the handler directly, exactly as
 * `page.evaluate(window.pos.x)` would — so a refusal proven here is a refusal a renderer cannot
 * talk its way past. Hidden buttons are not in this file because hidden buttons are not security.
 *
 * 🔴 AND THE SUPPLIER HALF IS UNREACHABLE BY CONSTRUCTION. Every handler passes the literal
 * "customer"; there is no `kind` parameter to send. The last test proves there is no supplier
 * channel at all, which is a stronger statement than "the supplier channel refuses a cashier".
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNELS, type ChannelName } from "../../src/shared/ipcContract";
import { accessFor } from "../../src/main/channelPolicy";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { PartyService } from "../../src/application/partyService";
import { PartyRepository } from "../../src/persistence/partyRepository";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
let role: "owner" | "cashier" | null;

const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code);

interface Customer {
  id: string;
  displayName: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  isActive: boolean;
  createdAt: string;
}

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  role = "owner";
  const parties = new PartyService({
    parties: new PartyRepository(h.db),
    actor: () => (role === null ? null : { id: "cashier-01", name: "Operator", role }),
    transact: (fn) => h.db.transaction(fn).immediate(),
  });
  ipc = syncHandlers(createIpcHandlers(h.service, { parties }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const create = (displayName: string, phone: string | null = null) =>
  ok<{ customer: Customer; sameName: Customer[] }>(
    ipc.createCustomer({ displayName, phone, address: null, note: null }),
  );

describe("the customer channels", () => {
  // ── Surface ─────────────────────────────────────────────────────────────────────────────────
  it("🔴 the preload surface grew 68 -> 73 (S1B) -> 74 (S3B) -> 75 (S3C), and these are the seven", () => {
    // 🔴 TRANSITION. The old values were 68, then 73, then 74 — named here rather than silently
    // replaced. The five S1B channels are customer-only: there is deliberately no supplier channel
    // and no `kind` parameter. S3B added exactly ONE and it is a READ. S3C adds exactly ONE and it
    // is the FIRST financial WRITE on this bridge — it settles an existing debt and cannot create
    // one, which is what the next test holds it to.
    const added: ChannelName[] = [
      "searchCustomers",
      "getCustomer",
      "createCustomer",
      "updateCustomerContact",
      "setCustomerActive",
      "getCustomerStatement",
      "recordCustomerPayment",
      // 🔴 TRANSITION — SEVENTY-FIVE to SEVENTY-SIX with M17B-S1: the one added channel is
      // `recordAllocatedReceipt`, owner-only, the SECOND and last money write. The old value was 75.
      "recordAllocatedReceipt",
    ];
    for (const name of added) expect(Object.keys(CHANNELS)).toContain(name);
    expect(Object.keys(CHANNELS)).toHaveLength(76);
  });

  it("🔴 S3C adds ONE money write — a SETTLEMENT — and still no way to CREATE a debt", () => {
    // 🔴 TRANSITION, AND THE OLD ASSERTION IS NAMED. Through S3B this test was called "S3B added a
    // READ and nothing else — no channel on this bridge writes money", and that was true then.
    // S3C deliberately ends it: `recordCustomerPayment` writes a settlement. What has NOT changed,
    // and is the whole point, is that nothing here can POST an obligation — so the only direction
    // a customer's debt can move from the renderer is DOWN.
    // The whole financial-write surface, stated as an absence that fails loudly if one appears.
    const names = Object.keys(CHANNELS);
    for (const forbidden of [
      "postObligation",
      "createObligation",
      "settle",
      "recordSettlement",
      "recordPayment",
      "payCustomer",
      "setCustomerBalance",
      "adjustBalance",
    ]) {
      expect(names, `a financial WRITE channel appeared: ${forbidden}`).not.toContain(forbidden);
    }
    // 🔴 THE WRITE THAT DOES EXIST IS THE ONLY ONE, AND IT IS OWNER-CLASSIFIED.
    expect(accessFor("getCustomerStatement")).toBe("owner");
    expect(accessFor("recordCustomerPayment")).toBe("owner");
    // 🔴 EXACTLY ONE CHANNEL MENTIONS PAYMENT OR SETTLEMENT. If a second financial write is ever
    // added, this count moves and whoever adds it has to come and say so here.
    const financial = names.filter((n) => /payment|settle|obligation|balance|debt/i.test(n));
    expect(financial).toEqual(["recordCustomerPayment"]);
    // 🔴 TRANSITION (M17B-S1): "exactly one money writer" became a CLOSED, NAMED list of exactly two.
    // The new one shares one real external receipt across debts; it is owner-only and cannot post a
    // debt. A third money-moving channel must come here and be named — never matched by a pattern.
    const moneyWriters = names.filter((n) => /payment|receipt/i.test(n)).sort();
    expect(moneyWriters).toEqual(["recordAllocatedReceipt", "recordCustomerPayment"]);
    expect(accessFor("recordAllocatedReceipt")).toBe("owner");
  });

  it("🔴 every channel is classified, and the customer ones carry the intended level", () => {
    // accessFor THROWS for an unclassified channel, so this also proves none was forgotten.
    for (const name of Object.keys(CHANNELS) as ChannelName[]) expect(() => accessFor(name)).not.toThrow();
    expect(accessFor("searchCustomers")).toBe("session");
    expect(accessFor("getCustomer")).toBe("session");
    expect(accessFor("createCustomer")).toBe("session");
    expect(accessFor("updateCustomerContact")).toBe("owner");
    expect(accessFor("setCustomerActive")).toBe("owner");
    // 🔴 NOT tied to the product-creation capability: whether an employee may add Products has
    // nothing to do with whether they may write down a customer's name.
    expect(accessFor("createCustomer")).not.toBe("create-products");
  });

  it("🔴 there is NO supplier channel and no generic party write endpoint", () => {
    const names = Object.keys(CHANNELS).map((n) => n.toLowerCase());
    for (const forbidden of ["supplier", "party", "sql", "query", "exec", "writetable"]) {
      expect(names.filter((n) => n.includes(forbidden)), forbidden).toEqual([]);
    }
  });

  // ── Identity ────────────────────────────────────────────────────────────────────────────────
  it("creates a customer with a durable id, in Arabic or English, and finds it again", () => {
    const ar = create("أبو خالد", "0100").customer;
    const en = create("Alzabt Trading").customer;
    expect(ar.id).not.toBe(en.id);
    expect(ar.displayName).toBe("أبو خالد");
    expect(en.displayName).toBe("Alzabt Trading");
    expect(ok<Customer>(ipc.getCustomer({ customerId: ar.id })).id).toBe(ar.id);
    expect(ok<Customer[]>(ipc.searchCustomers({ query: "خالد", includeArchived: false })).map((c) => c.id)).toEqual([
      ar.id,
    ]);
  });

  it("🔴 the DTO carries NO balance, amount or obligation — a directory is not a ledger", () => {
    const c = create("زبون").customer;
    expect(Object.keys(c).sort()).toEqual(
      ["address", "createdAt", "displayName", "id", "isActive", "note", "phone"].sort(),
    );
    for (const forbidden of ["balance", "amount", "owed", "debt", "credit", "total", "currency"]) {
      expect(Object.keys(c).filter((k) => k.toLowerCase().includes(forbidden)), forbidden).toEqual([]);
    }
  });

  it("🔴 duplicate names and shared phones stay separate records, and sameName REPORTS them", () => {
    const first = create("محمد علي", "0111");
    expect(first.sameName).toEqual([]);
    const second = create("محمد علي", "0111");
    // Not refused, not merged — and the first is reported so the operator can tell them apart.
    expect(second.customer.id).not.toBe(first.customer.id);
    expect(second.sameName.map((c) => c.id)).toEqual([first.customer.id]);
    expect(ok<Customer[]>(ipc.searchCustomers({ query: "محمد", includeArchived: false })).length).toBe(2);
  });

  it("a search result is bound to the right id, and an unknown id is refused", () => {
    // Names chosen so neither is a substring of the other: an earlier draft searched for "ب" and
    // matched BOTH, because "زبون" itself contains it. The fixture was wrong, not the search.
    const a = create("سمير").customer;
    const b = create("فادي").customer;
    const found = ok<Customer[]>(ipc.searchCustomers({ query: "فادي", includeArchived: false }));
    expect(found.map((c) => c.id)).toEqual([b.id]);
    expect(errCode(ipc.getCustomer({ customerId: "no-such-id" }))).toBe("PARTY_NOT_FOUND");
    expect(ok<Customer>(ipc.getCustomer({ customerId: a.id })).displayName).toBe("سمير");
  });

  // ── Authorization, through the bridge ───────────────────────────────────────────────────────
  it("🔴 a CASHIER may search, open and CREATE a customer", () => {
    role = "cashier";
    const c = create("زبون الكاشير").customer;
    expect(ok<Customer>(ipc.getCustomer({ customerId: c.id })).id).toBe(c.id);
    expect(ok<Customer[]>(ipc.searchCustomers({ query: "", includeArchived: false }).valueOf() as never).length).toBe(1);
  });

  it("🔴 a CASHIER is refused every MUTATION, through the bridge, and nothing changes", () => {
    const c = create("زبون", "0100").customer;
    role = "cashier";
    expect(errCode(ipc.updateCustomerContact({ customerId: c.id, patch: { phone: "0200" } }))).toBe("NOT_AUTHORIZED");
    expect(errCode(ipc.setCustomerActive({ customerId: c.id, isActive: false }))).toBe("NOT_AUTHORIZED");
    role = "owner";
    const after = ok<Customer>(ipc.getCustomer({ customerId: c.id }));
    expect(after.phone).toBe("0100");
    expect(after.isActive).toBe(true);
  });

  it("🔴 NOBODY SIGNED IN is refused every customer channel", () => {
    const c = create("زبون").customer;
    role = null;
    for (const call of [
      () => ipc.searchCustomers({ query: "", includeArchived: false }),
      () => ipc.getCustomer({ customerId: c.id }),
      () => ipc.createCustomer({ displayName: "خفي", phone: null, address: null, note: null }),
      () => ipc.updateCustomerContact({ customerId: c.id, patch: { phone: "1" } }),
      () => ipc.setCustomerActive({ customerId: c.id, isActive: false }),
    ]) {
      expect(errCode(call())).toBe("NOT_LOGGED_IN");
    }
  });

  it("a terminal with no directory answers NOT_AVAILABLE rather than crashing", () => {
    const bare = syncHandlers(createIpcHandlers(h.service));
    expect(errCode(bare.searchCustomers({ query: "", includeArchived: false }))).toBe("NOT_AVAILABLE");
    expect(errCode(bare.createCustomer({ displayName: "x", phone: null, address: null, note: null }))).toBe(
      "NOT_AVAILABLE",
    );
  });

  // ── Payload shape ───────────────────────────────────────────────────────────────────────────
  it("🔴 refuses a malformed payload, an unexpected field and a missing name", () => {
    expect(errCode(ipc.createCustomer({ displayName: "", phone: null, address: null, note: null }))).toBe(
      "INVALID_INPUT",
    );
    expect(errCode(ipc.createCustomer({ displayName: "  ", phone: null, address: null, note: null }))).toBe(
      "INVALID_INPUT",
    );
    expect(
      errCode(ipc.createCustomer({ displayName: "x", phone: null, address: null, note: null, kind: "supplier" })),
    ).toBe("INVALID_INPUT");
    expect(errCode(ipc.searchCustomers({ query: "x" }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.getCustomer({ customerId: 7 }))).toBe("INVALID_INPUT");
  });

  // ── Edits and history ───────────────────────────────────────────────────────────────────────
  it("an OWNER may correct contact details, and the history records every change", () => {
    const c = create("قديم", "0100").customer;
    const updated = ok<Customer>(
      ipc.updateCustomerContact({ customerId: c.id, patch: { displayName: "جديد", phone: "0200" } }),
    );
    expect(updated.id).toBe(c.id);
    expect(updated.displayName).toBe("جديد");
    // 🔴 SORTED BY FIELD, NOT TRUSTED TO ARRIVE IN ORDER. Two fields changed in ONE call share the
    // same `changed_at`, and `historyFor` breaks that tie on a random id — so asserting a sequence
    // would be asserting a coin toss. What the contract really promises is that BOTH changes are
    // recorded with their old and new values, and that is what is checked.
    const history = new PartyRepository(h.db).historyFor(c.id);
    expect(history.map((r) => [r.field, r.old_value, r.new_value]).sort()).toEqual(
      [
        ["display_name", "قديم", "جديد"],
        ["phone", "0100", "0200"],
      ].sort(),
    );
    for (const row of history) expect(row.changed_by).toBe("cashier-01");
  });

  it("archiving hides a customer from the default search and keeps it findable by id", () => {
    const c = create("مؤرشف").customer;
    ok(ipc.setCustomerActive({ customerId: c.id, isActive: false }));
    expect(ok<Customer[]>(ipc.searchCustomers({ query: "", includeArchived: false })).length).toBe(0);
    expect(ok<Customer[]>(ipc.searchCustomers({ query: "", includeArchived: true })).map((x) => x.id)).toEqual([c.id]);
    expect(ok<Customer>(ipc.getCustomer({ customerId: c.id })).isActive).toBe(false);
  });

  // ── Nothing financial ───────────────────────────────────────────────────────────────────────
  it("🔴 no customer channel creates a sale, an invoice, a void or an audit row", () => {
    const n = (table: string) =>
      Number((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
    const before = { sales: n("sales"), lines: n("sale_lines"), invoices: n("invoices"), voids: n("voids"), audit: n("audit_events") };
    const c = create("زبون", "0100").customer;
    ok(ipc.updateCustomerContact({ customerId: c.id, patch: { note: "ملاحظة" } }));
    ok(ipc.setCustomerActive({ customerId: c.id, isActive: false }));
    ok(ipc.searchCustomers({ query: "", includeArchived: true }));
    expect({ sales: n("sales"), lines: n("sale_lines"), invoices: n("invoices"), voids: n("voids"), audit: n("audit_events") }).toEqual(
      before,
    );
  });
});
