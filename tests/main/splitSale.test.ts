import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { CHANNEL_POLICY } from "../../src/main/channelPolicy";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

/**
 * SELL-SPLIT-CASH-WHISH (owner, 2026-11-09) through the REAL bridge: the `createSplitSale` channel. The
 * service rules are in splitSale.test.ts; this file proves what the renderer can and cannot send, the
 * channel's permission (the same as createSale: a paid sale, never a debt), and that a customer-linked
 * split sale reads honestly on the owner's statement — both parts named, no fabricated single method.
 */

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger }));
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

type R = { ok: boolean; data?: any; error?: { code: string } };
const code = (r: unknown) => ((r as R).ok ? "OK" : (r as R).error!.code);
const n = (table: string) => Number((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
const footprint = () => ({ sales: n("sales"), tenders: n("sale_tenders"), obligations: n("obligations"), references: n("external_references") });
const base = () => ({
  idempotencyKey: newKey(),
  lines: [{ productId: "prod-0001", quantityMilli: 2000 }],
  expectedTotalMinor: "500",
  cashMinor: "200",
  whishMinor: "300",
  whish: { reference: `WH-${newKey().slice(0, 8)}`, fundsConfirmed: true },
});
const send = (req: unknown) => ipc.createSplitSale(req as never) as R;

describe("the bridge records a split sale", () => {
  it("cash 2.00 + Whish 3.00: one paid sale whose DTO names both parts", () => {
    const r = send({ ...base(), whish: { reference: "WH-IPC-SPLIT", fundsConfirmed: true } });
    expect(r.ok).toBe(true);
    expect(r.data.sale.paymentStatus).toBe("paid");
    expect(r.data.sale.paymentMethod).toBeNull();
    expect(r.data.sale.tenders.map((x: any) => [x.seq, x.method, x.amount.minor, x.reference])).toEqual([
      [1, "cash", "200", null],
      [2, "external", "300", "WH-IPC-SPLIT"],
    ]);
    expect(footprint()).toEqual({ sales: 1, tenders: 2, obligations: 0, references: 1 });
  });

  it("the channel's permission is createSale's — a paid sale, never a debt — and a cashier may use it", () => {
    expect(CHANNEL_POLICY.createSplitSale).toBe(CHANNEL_POLICY.createSale);
    expect(CHANNEL_POLICY.createSplitSale).toBe("session");
    h.service.login("cashier-02", "2222");
    expect(code(send(base()))).toBe("OK");
  });

  it("🔴 the owner's statement shows a customer-linked split sale with BOTH parts and no invented method", () => {
    const c = h.parties.create({ kind: "customer", displayName: "زبون مقسوم" }).party;
    expect(code(send({ ...base(), customerId: c.id, whish: { reference: "WH-STMT", fundsConfirmed: true } }))).toBe("OK");
    const st = (ipc.getCustomerStatement({ customerId: c.id }) as R).data;
    expect(st.obligations).toEqual([]);
    expect(st.paidSales).toHaveLength(1);
    const ps = st.paidSales[0];
    expect(ps.paymentMethod).toBeNull();
    expect(ps.tenders.map((x: any) => [x.method, x.amount.minor, x.reference])).toEqual([
      ["cash", "200", null],
      ["external", "300", "WH-STMT"],
    ]);
  });
});

describe("🔴 what the renderer cannot send — and nothing is written", () => {
  it("exact keys; amounts are whole minor-unit strings (no float, no negative, no number)", () => {
    for (const bad of [
      { ...base(), paymentMethod: "cash" },
      { ...base(), debtMinor: "0" },
      (({ whish: _w, ...rest }) => rest)(base()),
      (({ cashMinor: _c, ...rest }) => rest)(base()),
      { ...base(), cashMinor: "2.00" },
      { ...base(), cashMinor: "-200", whishMinor: "700" },
      { ...base(), cashMinor: 200 },
      { ...base(), whish: { reference: "WH-X", fundsConfirmed: true, extra: 1 } },
      { ...base(), whish: { reference: "WH-X", fundsConfirmed: "true" } },
    ]) {
      expect(code(send(bad))).toBe("INVALID_INPUT");
    }
    expect(footprint()).toEqual({ sales: 0, tenders: 0, obligations: 0, references: 0 });
  });

  it("the amount rules come back as their own codes", () => {
    expect(code(send({ ...base(), cashMinor: "0", whishMinor: "500" }))).toBe("SPLIT_AMOUNT_INVALID");
    expect(code(send({ ...base(), cashMinor: "200", whishMinor: "200" }))).toBe("SPLIT_TOTAL_MISMATCH");
    expect(code(send({ ...base(), cashMinor: "300", whishMinor: "300" }))).toBe("SPLIT_TOTAL_MISMATCH");
    expect(footprint().sales).toBe(0);
  });

  it("not signed in → NOT_LOGGED_IN; nothing written", () => {
    h.service.logout();
    expect(code(send(base()))).toBe("NOT_LOGGED_IN");
    expect(footprint().sales).toBe(0);
  });
});
