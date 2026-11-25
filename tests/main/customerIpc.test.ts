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
    // 🔴 TRANSITION — SEVENTY-SIX to SEVENTY-NINE with Track 2 phase 3: exportFullBackup,
    // inspectRestoreBackup, applyRestore. None of them is a money write; the closed list of
    // money writers below is unchanged. The old value was 76.
    // 🔴 TRANSITION (SELL-CREDIT): 79 -> 80 with createCustomerCreditSale, the owner's sale on a customer's
    // account (named in the debt-creator list below). The old value was 79.
    // 🔴 TRANSITION (SELL-SPLIT-CASH-WHISH, 2026-11-09): 80 -> 81 with createSplitSale — a PAID sale (cash +
    // Whish = the total exactly), same permission as createSale; it creates no debt, so the debt-creator
    // list below is unchanged. The old value was 80.
    // 🔴 TRANSITION (migration 20, ADV-RECORD-CASH-WHISH, owner DEC-35s): 81 -> 90 with the nine
    // customer-advance channels (record / pending / finish / close / acknowledge / statement /
    // correct / print / PDF). The three that move money are named in their OWN closed list in the
    // next test, because the money-writer pattern there (/payment|receipt/) would not see them.
    // The old value was 81.
    // 🔴 TRANSITION (DEC-35x, Daily Money In/Out): 90 -> 91 with getDailyMoney — owner-only and a READ:
    // it moves no money, so neither the money-writer nor the advance list below changes. The old value was 90.
    // 🔴 TRANSITION (DEC-35x, Apply Advance to Existing Debt): 91 -> 92 with applyAdvanceToDebt — owner-only;
    // it SETTLES an existing debt from an advance (no new money) and creates none. Named in every closed
    // list in the next test. The old value was 91.
    // 🔴 TRANSITION (DEC-35x, Apply Advance to New Sale): 92 -> 93 with sellOnAdvance — owner-only; it CREATES
    // a debt (the sale on account) and settles part of it from an advance, atomically. The old value was 92.
    // 🔴 TRANSITION (DEC-35z+, Cash Refund REF): 93 -> 96 with refundAdvance (owner; MONEY OUT, cash, from an
    // advance's unused balance — no debt created or settled) and its owner-only reprint/PDF pair
    // printAdvanceRefund / saveAdvanceRefundPdf (read by id, write nothing). The old value was 93.
    // 🔴 TRANSITION (DEC-35z+, COL receipts): 96 -> 99 with getCollectionReceipt / printCollectionReceipt /
    // saveCollectionReceiptPdf — owner-only READS of a COL- document by number; they write no payment. The old value was 96.
    // 🔴 TRANSITION (OCR × Advances integration, DEC-35zz+): 99 -> 100 = the advances chain's 99 + OCR's readInvoicePhoto. Old values: 99 (advances) / 82 (OCR).
    // 🔴 TRANSITION (DEC-35zz++ TILL-PRINT): 100 -> 103 with getSaleReceipt / printSaleReceipt / saveSaleReceiptPdf —
    // session READS of one till receipt by sale id (the service limits a non-owner to History's window); they write
    // nothing. The old value was 100.
    // X1 TRANSITION: 103 -> 104, read-only getEntryState; no customer capability added.
    // TRANSITION (M1, Phone Invoice queue DEC-35z16): 104 -> 106 with listPhoneInvoices / releasePhoneInvoice
    // (create-products level; a staged photo FILE, no customer capability). The old value was 104.
    // TRANSITION (M5 LBP display, owner 2026-11-25): 106 -> 108 with setDisplayCurrency (session) and setLbpRate (owner);
    // display settings only — no customer capability, no money. The old value was 106.
    expect(Object.keys(CHANNELS)).toHaveLength(108);
  });

  // TRANSITION (SELL-CREDIT, owner 2026-11-08): this test was named "… and still no way to CREATE a debt".
  // The owner decided every new debt is the OWNER's and opened exactly ONE way to create one from the
  // till: `createCustomerCreditSale` (a whole sale on a customer's account). It is named below, owner-only,
  // and still nothing can post a bare obligation, edit a balance, or reach the supplier side.
  it("🔴 S3C adds ONE money write — a SETTLEMENT — and the ONLY way to CREATE a debt is the owner's credit sale", () => {
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
    // 🔴 TRANSITION (DEC-35x): exactly one became a CLOSED NAMED list of two — applyAdvanceToDebt settles a
    // debt FROM an advance (owner-only). Old value: ["recordCustomerPayment"].
    const financial = names.filter((n) => /payment|settle|obligation|balance|debt/i.test(n)).sort();
    expect(financial).toEqual(["applyAdvanceToDebt", "recordCustomerPayment"]);
    expect(accessFor("applyAdvanceToDebt")).toBe("owner");
    // 🔴 TRANSITION (M17B-S1): "exactly one money writer" became a CLOSED, NAMED list of exactly two.
    // The new one shares one real external receipt across debts; it is owner-only and cannot post a
    // debt. A third money-moving channel must come here and be named — never matched by a pattern.
    // 🔴 TRANSITION (DEC-35z+ COL): the pattern now also sees the three COL- document channels, which are
    // READS (print / PDF / view by number) and move no money — removed BY NAME, so the writers stay two.
    // Old filter: /payment|receipt/ alone.
    const colDocs = ["getCollectionReceipt","printCollectionReceipt","saveCollectionReceiptPdf"];
    // 🔴 TRANSITION (DEC-35zz++ TILL-PRINT): the pattern also sees the three TILL receipt channels — READS of a sale's
    // receipt (view / print / PDF) that move no money — removed BY NAME too. Old exclusion: the COL- three only.
    const saleReceiptDocs = ["getSaleReceipt", "printSaleReceipt", "saveSaleReceiptPdf"];
    const moneyWriters = names.filter((n) => /payment|receipt/i.test(n) && !colDocs.includes(n) && !saleReceiptDocs.includes(n)).sort();
    for (const d of colDocs) expect(accessFor(d as never)).toBe("owner");
    for (const d of saleReceiptDocs) expect(accessFor(d as never)).toBe("session");
    expect(moneyWriters).toEqual(["recordAllocatedReceipt", "recordCustomerPayment"]);
    expect(accessFor("recordAllocatedReceipt")).toBe("owner");
    // SELL-CREDIT: the closed, NAMED list of debt creators. Old value: none.
    // 🔴 TRANSITION (DEC-35x): the pattern now also sees applyAdvanceToDebt, which REDUCES a debt and
    // creates none — so it is removed BY NAME, and the creators stay exactly one. Old filter: unchanged.
    // 🔴 TRANSITION (DEC-35x): sellOnAdvance creates a debt but no pattern word names it — it is ADDED BY NAME.
    // Old value: ["createCustomerCreditSale"].
    const debtCreators = names.filter((n) => (/credit|debt|obligation|onAccount/i.test(n) && n !== "applyAdvanceToDebt") || n === "sellOnAdvance").sort();
    expect(debtCreators).toEqual(["createCustomerCreditSale", "sellOnAdvance"]);
    expect(accessFor("sellOnAdvance")).toBe("owner");
    expect(accessFor("createCustomerCreditSale")).toBe("owner");
    // 🔴 MIGRATION 20 — the advance channels, as a CLOSED NAMED list (the money-writer pattern above
    // cannot see them: an enumeration that skips unknown names goes blind, it does not fail).
    const advanceChannels = names.filter((n) => /advance/i.test(n)).sort();
    expect(advanceChannels).toEqual(
      [
        "acknowledgeAdvance",
        // TRANSITION (DEC-35x): the owner's application of an advance to a debt. Old list: without it.
        "applyAdvanceToDebt",
        "closeAdvance",
        "correctAdvance",
        "finishAdvance",
        "getAdvanceStatement",
        "pendingAdvances",
        "printAdvance",
        "recordAdvance",
        "saveAdvancePdf",
        // TRANSITION (DEC-35x): a new sale on account paid from an advance. Old list: without it.
        "sellOnAdvance",
        // TRANSITION (DEC-35z+): the owner's CASH refund of an advance's unused balance, and its
        // reprint / PDF. Old list: without these three.
        "refundAdvance",
        "printAdvanceRefund",
        "saveAdvanceRefundPdf",
      ].sort(),
    );
    // The three that MOVE money: record and finish (owner + cashier, decision D1 — the cashier takes
    // the money at the till) and correct (owner only). None creates a debt; none settles one.
    expect(accessFor("recordAdvance")).toBe("session");
    expect(accessFor("finishAdvance")).toBe("session");
    expect(accessFor("correctAdvance")).toBe("owner");
    expect(accessFor("getAdvanceStatement")).toBe("owner");
    expect(accessFor("applyAdvanceToDebt")).toBe("owner");
    // DEC-35z+: the one channel that takes money OUT of the drawer for a customer, and its documents — OWNER.
    expect(accessFor("refundAdvance")).toBe("owner");
    expect(accessFor("printAdvanceRefund")).toBe("owner");
    expect(accessFor("saveAdvanceRefundPdf")).toBe("owner");
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
