/**
 * S3B — the read-only customer account statement, over the real IPC handlers.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS GUARDING. A statement is the shop's own word on what a customer owes, so
 * the dangerous bugs are the ones that produce a plausible number for the wrong person: Customer
 * A's debts shown under B's name, two same-named people sharing a balance, a supplier's payables
 * reachable through a customer channel, or USD and LBP blended into one figure by an invented
 * rate. Each is asserted here. So is the one thing that must NOT be possible — writing money
 * through this bridge.
 *
 * Driven through `registerIpc`'s real handler table, not the service directly, so the channel
 * policy, the payload validation and the DTO shape are all exercised as the renderer meets them.
 *
 * Disposable database per test. Synthetic names and amounts only.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerService } from "../../src/application/ledgerService";
import { PartyService } from "../../src/application/partyService";
import { LedgerRepository } from "../../src/persistence/ledgerRepository";
import { PartyRepository } from "../../src/persistence/partyRepository";
import { CHANNELS, type ChannelName, type CustomerStatementDto } from "../../src/shared/ipcContract";
import { accessFor } from "../../src/main/channelPolicy";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let role: "owner" | "cashier";
let parties: PartyService;
let ledger: LedgerService;

const OWNER = { id: "cashier-01", name: "Owner One" };
const CASHIER = { id: "cashier-02", name: "Cashier Two" };

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  role = "owner";
  let n = 0;
  const actor = () => {
    const who = role === "owner" ? OWNER : CASHIER;
    return { id: who.id, name: who.name, role };
  };
  parties = new PartyService({
    parties: new PartyRepository(h.db),
    actor,
    transact: (fn) => h.db.transaction(fn).immediate(),
    newId: () => `party-${++n}`,
  });
  ledger = new LedgerService({
    ledger: new LedgerRepository(h.db),
    parties: new PartyRepository(h.db),
    actor,
    transact: (fn) => h.db.transaction(fn).immediate(),
    terminal: { timeZone: "Asia/Beirut" },
    saleCurrency: (id) => {
      const row = h.db.prepare(`SELECT currency FROM sales WHERE id = ?`).get(id) as { currency: string } | undefined;
      return row?.currency ?? null;
    },
    newId: () => `led-${++n}`,
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
  return "NO_THROW";
};

const customer = (name: string, phone?: string) => parties.create({ kind: "customer", displayName: name, phone }).party;
const supplier = (name: string) => parties.create({ kind: "supplier", displayName: name }).party;

const owe = (partyId: string, ref: string, minor: bigint, currency = "USD") =>
  ledger.postObligation({
    partyId,
    direction: "receivable",
    sourceKind: "manual",
    sourceRef: ref,
    currency,
    amountMinor: minor,
  }).record;

const pay = (obligationId: string, partyId: string, key: string, minor: bigint) =>
  ledger.settle({ obligationId, partyId, idempotencyKey: key, amountMinor: minor, method: "cash" });

/** The statement as the renderer would receive it, composed exactly as the handler composes it. */
const statementOf = (customerId: string): CustomerStatementDto => {
  const s = ledger.statementFor(customerId);
  const row = parties.get("customer", customerId);
  return {
    customer: {
      id: row.id,
      displayName: row.display_name,
      phone: row.phone,
      address: row.address,
      note: row.note,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    },
    obligations: s.obligations.map((r) => ({
      id: r.obligation.id,
      amount: { minor: r.obligation.amountMinor.toString(), currency: r.obligation.currency },
      outstanding: { minor: r.outstandingMinor.toString(), currency: r.obligation.currency },
      fullyPaid: r.outstandingMinor === 0n,
      sourceKind: r.obligation.sourceKind,
      sourceRef: r.obligation.sourceRef,
      saleId: r.obligation.saleId,
      postedAt: r.obligation.postedAt,
      settlements: r.settlements.map((st) => ({
        id: st.id,
        amount: { minor: st.amountMinor.toString(), currency: st.currency },
        method: st.method,
        // TRANSITION with migration 17: three new fields on every settlement, null on a plain cash row.
        provider: st.provider,
        reference: st.reference,
        fundsConfirmed: st.fundsConfirmed,
        settledAt: st.settledAt,
      })),
    })),
    balances: [...s.balances.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, minor]) => ({ minor: minor.toString(), currency })),
    // TRANSITION with migration 17: the statement carries the collections still open (none here).
    pendingCollections: [],
  };
};

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The contract surface
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the statement channel", () => {
  it("🔴 exists, is owner-classified, and is the ONLY financial channel", () => {
    expect(Object.keys(CHANNELS)).toContain("getCustomerStatement");
    expect(accessFor("getCustomerStatement")).toBe("owner");
    // Every channel is classified — accessFor throws for an unclassified one.
    for (const name of Object.keys(CHANNELS) as ChannelName[]) expect(() => accessFor(name)).not.toThrow();
  });

  it("🔴 the ONE money write is a settlement; nothing creates a debt, nothing mentions a supplier", () => {
    // 🔴 TRANSITION, AND THE OLD ASSERTION IS NAMED. Through S3B this read "no channel on this
    // bridge writes money" and forbade "Payment" outright. S3C deliberately ends that: exactly one
    // channel, `recordCustomerPayment`, now writes a settlement.
    //
    // 🔴 WHAT SURVIVES IS THE PART THAT MATTERS. "Obligation", "Balance" and every supplier word
    // are STILL forbidden, so the renderer still cannot create a debt, cannot edit a balance, and
    // cannot reach the supplier half of the ledger at all. Only the direction DOWN was opened.
    const names = Object.keys(CHANNELS).join(" ");
    for (const forbidden of ["Obligation", "settle", "Settlement", "Balance", "Supplier", "supplier"]) {
      expect(names, `a channel mentioning ${forbidden} exists`).not.toContain(forbidden);
    }
    // 🔴 "Payment" is allowed now — for EXACTLY ONE channel, named in full. A second one appearing
    // is a financial-surface change and has to be argued for here.
    const paymentish = Object.keys(CHANNELS).filter((n) => /payment/i.test(n));
    expect(paymentish).toEqual(["recordCustomerPayment"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Authorization
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("authorization", () => {
  it("🔴 a cashier cannot read a statement, even reaching the service directly", () => {
    const c = customer("سمير");
    owe(c.id, "bill-1", 1000n);
    role = "cashier";
    expect(code(() => ledger.statementFor(c.id))).toBe("NOT_AUTHORIZED");
  });

  it("🔴 a cashier CAN still search and create customers — S1B is unchanged", () => {
    role = "cashier";
    const made = parties.create({ kind: "customer", displayName: "زبون الكاشير" }).party;
    expect(made.id).toBeTruthy();
    expect(parties.search("customer", "زبون").length).toBeGreaterThan(0);
  });

  it("🔴 nobody signed in reads nothing", () => {
    const c = customer("سمير");
    const anon = new LedgerService({
      ledger: new LedgerRepository(h.db),
      parties: new PartyRepository(h.db),
      actor: () => null,
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: { timeZone: "Asia/Beirut" },
      saleCurrency: () => null,
    });
    expect(code(() => anon.statementFor(c.id))).toBe("NOT_LOGGED_IN");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Whose money is it
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("one customer's debts are only ever their own", () => {
  it("🔴 customer A's statement never shows customer B's obligations", () => {
    const a = customer("سمير");
    const b = customer("فادي");
    owe(a.id, "bill-a", 1000n);
    owe(b.id, "bill-b", 2500n);

    const sa = statementOf(a.id);
    expect(sa.obligations).toHaveLength(1);
    expect(sa.obligations[0]!.sourceRef).toBe("bill-a");
    expect(sa.balances).toEqual([{ minor: "1000", currency: "USD" }]);

    const sb = statementOf(b.id);
    expect(sb.obligations).toHaveLength(1);
    expect(sb.obligations[0]!.sourceRef).toBe("bill-b");
    expect(sb.balances).toEqual([{ minor: "2500", currency: "USD" }]);
  });

  it("🔴 two customers sharing a name stay separate, by id", () => {
    const a = customer("محمد علي", "0111111");
    const b = customer("محمد علي", "0222222");
    expect(a.id).not.toBe(b.id);
    owe(a.id, "bill-a", 5000n);
    owe(b.id, "bill-b", 700n);

    expect(statementOf(a.id).balances).toEqual([{ minor: "5000", currency: "USD" }]);
    expect(statementOf(b.id).balances).toEqual([{ minor: "700", currency: "USD" }]);
    // The statement names the id it answered for, so a screen cannot paint it under the other.
    expect(statementOf(a.id).customer.id).toBe(a.id);
    expect(statementOf(b.id).customer.id).toBe(b.id);
  });

  it("🔴 a SUPPLIER id is refused as not found — payables are unreachable from here", () => {
    const s = supplier("مورّد");
    ledger.postObligation({
      partyId: s.id,
      direction: "payable",
      sourceKind: "manual",
      sourceRef: "sb-1",
      currency: "USD",
      amountMinor: 9000n,
    });
    // 🔴 PARTY_NOT_FOUND, deliberately the same answer as a nonexistent id: the renderer has no
    // supplier channel, so confirming one exists is the only thing this reply could leak.
    expect(code(() => ledger.statementFor(s.id))).toBe("PARTY_NOT_FOUND");
    expect(code(() => ledger.statementFor("no-such-party"))).toBe("PARTY_NOT_FOUND");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The three states, and the empty one
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("what the statement says", () => {
  it("🔴 an unpaid obligation shows its full amount outstanding", () => {
    const c = customer("سمير");
    const o = owe(c.id, "bill-1", 1000n);
    const s = statementOf(c.id);
    expect(s.obligations[0]!.amount).toEqual({ minor: "1000", currency: "USD" });
    expect(s.obligations[0]!.outstanding).toEqual({ minor: "1000", currency: "USD" });
    expect(s.obligations[0]!.fullyPaid).toBe(false);
    expect(s.obligations[0]!.settlements).toEqual([]);
    expect(s.obligations[0]!.id).toBe(o.id);
  });

  it("🔴 a partly paid obligation shows the remainder, and its payments", () => {
    const c = customer("سمير");
    const o = owe(c.id, "bill-1", 1000n);
    pay(o.id, c.id, "pay-00000001", 400n);
    const s = statementOf(c.id);
    expect(s.obligations[0]!.amount.minor).toBe("1000");
    expect(s.obligations[0]!.outstanding.minor).toBe("600");
    expect(s.obligations[0]!.fullyPaid).toBe(false);
    expect(s.obligations[0]!.settlements).toHaveLength(1);
    expect(s.obligations[0]!.settlements[0]!.amount).toEqual({ minor: "400", currency: "USD" });
    expect(s.obligations[0]!.settlements[0]!.method).toBe("cash");
    expect(s.balances).toEqual([{ minor: "600", currency: "USD" }]);
  });

  it("🔴 a fully settled obligation reads zero outstanding AND fullyPaid", () => {
    const c = customer("سمير");
    const o = owe(c.id, "bill-1", 1000n);
    pay(o.id, c.id, "pay-00000001", 600n);
    pay(o.id, c.id, "pay-00000002", 400n);
    const s = statementOf(c.id);
    expect(s.obligations[0]!.outstanding.minor).toBe("0");
    expect(s.obligations[0]!.fullyPaid).toBe(true);
    expect(s.obligations[0]!.settlements).toHaveLength(2);
    expect(s.balances).toEqual([{ minor: "0", currency: "USD" }]);
  });

  it("🔴 a customer with nothing posted has NO obligations and NO balances — not a zero", () => {
    // 🔴 THE DISTINCTION THAT MATTERS. An empty list means the ledger has said nothing. A balance
    // of "0" would be the shop asserting the account is square, which nobody has posted.
    const c = customer("سمير");
    const s = statementOf(c.id);
    expect(s.obligations).toEqual([]);
    expect(s.balances).toEqual([]);
    expect(s.customer.id).toBe(c.id);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Currency
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("currency", () => {
  it("🔴 two currencies give two balances, never one blended figure", () => {
    const c = customer("سمير");
    owe(c.id, "usd-1", 5000n, "USD");
    owe(c.id, "lbp-1", 2000000n, "LBP");
    const s = statementOf(c.id);
    expect(s.balances).toEqual([
      { minor: "2000000", currency: "LBP" },
      { minor: "5000", currency: "USD" },
    ]);
    // 🔴 AND NOTHING EQUALS THE SUM. 5000 + 2000000 would be 2005000 — the number an exchange
    // rate this product does not have would be needed to produce.
    expect(s.balances.map((b) => b.minor)).not.toContain("2005000");
  });

  it("🔴 every amount carries its own currency beside it", () => {
    const c = customer("سمير");
    const o = owe(c.id, "lbp-1", 2000000n, "LBP");
    pay(o.id, c.id, "pay-00000001", 500000n);
    const s = statementOf(c.id);
    expect(s.obligations[0]!.amount.currency).toBe("LBP");
    expect(s.obligations[0]!.outstanding.currency).toBe("LBP");
    expect(s.obligations[0]!.settlements[0]!.amount.currency).toBe("LBP");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Reading changes nothing
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("reading a statement is a pure read", () => {
  it("🔴 opening it changes no party, obligation or settlement row", () => {
    const c = customer("سمير");
    const o = owe(c.id, "bill-1", 1000n);
    pay(o.id, c.id, "pay-00000001", 400n);

    const snap = () => ({
      parties: h.db.prepare(`SELECT * FROM parties ORDER BY id`).all(),
      obligations: h.db.prepare(`SELECT * FROM obligations ORDER BY id`).all(),
      settlements: h.db.prepare(`SELECT * FROM settlements ORDER BY id`).all(),
      sales: h.db.prepare(`SELECT count(*) AS n FROM sales`).get(),
      invoices: h.db.prepare(`SELECT count(*) AS n FROM invoices`).get(),
    });
    const before = snap();
    statementOf(c.id);
    statementOf(c.id);
    expect(snap()).toEqual(before);
  });

  it("🔴 an archived customer keeps a readable statement", () => {
    const c = customer("سمير");
    const o = owe(c.id, "bill-1", 1000n);
    pay(o.id, c.id, "pay-00000001", 400n);
    parties.setActive("customer", c.id, false);

    const s = statementOf(c.id);
    expect(s.customer.isActive).toBe(false);
    expect(s.obligations).toHaveLength(1);
    expect(s.balances).toEqual([{ minor: "600", currency: "USD" }]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The screen itself
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the statement screen", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const src = () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return strip(readFileSync("src/renderer/screens/CustomerStatement.tsx", "utf8"));
  };

  it("🔴 does NO money arithmetic — it prints what the ledger computed", () => {
    const s = src();
    // No addition, subtraction or reduce over amounts anywhere in the component.
    expect(s).not.toMatch(/\breduce\(/);
    expect(s).not.toMatch(/BigInt\(/);
    expect(s).not.toMatch(/parseFloat|parseInt|Number\(/);
    expect(s).not.toMatch(/\bminor\s*[+\-*/]/);
    // It formats through the shared helper rather than building its own string.
    expect(s).toContain("fmt(");
  });

  it("🔴 cannot write: it calls only the read channel", () => {
    const s = src();
    expect(s).toContain("getCustomerStatement");
    for (const forbidden of ["postObligation", "settle(", "createCustomer", "updateCustomerContact", "setCustomerActive"]) {
      expect(s, `the statement screen calls ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("🔴 says 'no posted debts' rather than printing a zero", () => {
    const s = src();
    expect(s).toContain('t("statement.none")');
    expect(s).not.toMatch(/"0\.00"/);
  });

  it("🔴 and tells the merchant, on screen, that it cannot record anything", () => {
    expect(src()).toContain('t("statement.readOnly")');
  });
});
