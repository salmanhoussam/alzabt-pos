/**
 * ADV-RECORD-CASH-WHISH through the REAL IPC handlers (migration 20).
 *
 *   · the cashier and the owner record; the statement and every correction are OWNER only;
 *   · a lost reply: the same request key returns the SAME ADV receipt and writes nothing;
 *   · Card / Other are refused at the channel, leaving nothing;
 *   · the payload is strict (no unknown keys); print / PDF take an advance ID only;
 *   · the statement keeps advances separate from debt, with the live balance (0 once corrected);
 *   · without the service wired every advance channel says NOT_AVAILABLE.
 * Synthetic data only; real SQLite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessFor } from "../../src/main/channelPolicy";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { renderAdvanceDocument } from "../../src/main/advanceDocument";
import type { AdvanceDto, IpcResult } from "../../src/shared/ipcContract";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data as T;
};
const errCode = (r: IpcResult<unknown>) => (r.ok ? "OK" : r.error.code);
const count = (table: string) => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);

function wired(extra: Parameters<typeof createIpcHandlers>[1] = {}) {
  const advances = makeAdvances(h);
  const all = createIpcHandlers(h.service, { advances, ...extra });
  return { all, sync: syncHandlers(all) };
}
const customer = (name = "زبون") => h.parties.create({ kind: "customer", displayName: name }).party;

describe("ADV IPC — policy", () => {
  it("record / pending / finish / close / acknowledge / print / PDF are session; statement and correction are owner", () => {
    for (const c of ["recordAdvance", "pendingAdvances", "finishAdvance", "closeAdvance", "acknowledgeAdvance", "printAdvance", "saveAdvancePdf"] as const) {
      expect(accessFor(c), c).toBe("session");
    }
    expect(accessFor("getAdvanceStatement")).toBe("owner");
    expect(accessFor("correctAdvance")).toBe("owner");
  });
});

describe("ADV IPC — record", () => {
  it("a cashier records a cash advance: ADV-000001 with the receiver's name; the retry of the same key is the SAME receipt", () => {
    const c = customer("زبون الكاشير");
    h.service.login("cashier-02", "2222");
    const { sync } = wired();
    const req = { customerId: c.id, amountMinor: "2500", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "ipc-adv-key-0001" };
    const first = ok<{ advance: AdvanceDto; duplicate: boolean }>(sync.recordAdvance(req));
    expect(first.duplicate).toBe(false);
    expect(first.advance).toMatchObject({ number: "ADV-000001", customerName: "زبون الكاشير", amount: { minor: "2500", currency: "USD" }, channel: "cash", origin: "receipt" });
    expect(first.advance.receivedByName.length).toBeGreaterThan(0);
    const again = ok<{ advance: AdvanceDto; duplicate: boolean }>(sync.recordAdvance(req));
    expect(again.duplicate).toBe(true);
    expect(again.advance.number).toBe("ADV-000001");
    expect(count("customer_advances")).toBe(1);
    // the receipt was not acknowledged yet → listed as recorded, with its receipt
    expect(ok<unknown[]>(sync.pendingAdvances(undefined))).toEqual([expect.objectContaining({ status: "recorded", key: "ipc-adv-key-0001" })]);
    ok(sync.acknowledgeAdvance({ idempotencyKey: "ipc-adv-key-0001" }));
    expect(ok<unknown[]>(sync.pendingAdvances(undefined))).toEqual([]);
    // a cashier does not read balances
    expect(errCode(sync.getAdvanceStatement({ customerId: c.id }))).toBe("NOT_AUTHORIZED");
  });

  it("Whish needs reference + confirmation; Card / Other refused; unknown keys refused — nothing written", () => {
    const c = customer();
    const { sync } = wired();
    const base = { customerId: c.id, amountMinor: "4000", reference: "WH-1", fundsConfirmed: true };
    expect(errCode(sync.recordAdvance({ ...base, channel: "card", idempotencyKey: "ipc-adv-key-0002" }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(errCode(sync.recordAdvance({ ...base, channel: "other", idempotencyKey: "ipc-adv-key-0003" }))).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    expect(errCode(sync.recordAdvance({ ...base, channel: "whish", fundsConfirmed: false, idempotencyKey: "ipc-adv-key-0004" }))).toBe("FUNDS_NOT_CONFIRMED");
    expect(errCode(sync.recordAdvance({ ...base, channel: "whish", reference: "", idempotencyKey: "ipc-adv-key-0005" }))).toBe("INVALID_INPUT");
    expect(errCode(sync.recordAdvance({ ...base, channel: "whish", idempotencyKey: "ipc-adv-key-0006", extra: 1 }))).toBe("INVALID_INPUT");
    expect(errCode(sync.recordAdvance({ ...base, channel: "whish", amountMinor: "0", idempotencyKey: "ipc-adv-key-0007" }))).not.toBe("OK");
    expect(count("customer_advances")).toBe(0);
    expect(count("advance_attempts")).toBe(0);
    const w = ok<{ advance: AdvanceDto }>(sync.recordAdvance({ ...base, channel: "whish", idempotencyKey: "ipc-adv-key-0008" }));
    expect(w.advance).toMatchObject({ channel: "whish", reference: "WH-1" });
  });

  it("the owner's statement: advances separate from debt, live balance, the correction shown on both sides", () => {
    const [x, y] = [customer("خطأ"), customer("صحيح")];
    const { sync } = wired();
    const a = ok<{ advance: AdvanceDto }>(
      sync.recordAdvance({ customerId: x.id, amountMinor: "5000", channel: "whish", reference: "WH-9", fundsConfirmed: true, idempotencyKey: "ipc-adv-key-0010" }),
    ).advance;
    ok(sync.acknowledgeAdvance({ idempotencyKey: "ipc-adv-key-0010" }));
    const corr = ok<{ successor: AdvanceDto; duplicate: boolean }>(
      sync.correctAdvance({ advanceId: a.id, kind: "replaced", customerId: y.id, reason: "زبون خطأ", idempotencyKey: "ipc-corr-key-0001" }),
    );
    expect(corr.successor).toMatchObject({ number: "ADV-000002", origin: "correction", correctsNumber: "ADV-000001", customerName: "صحيح" });
    const sx = ok<{ lines: Array<{ unused: { minor: string }; correction: { successorNumber: string } | null }> }>(sync.getAdvanceStatement({ customerId: x.id }));
    expect(sx.lines).toEqual([expect.objectContaining({ unused: { minor: "0", currency: "USD" }, correction: expect.objectContaining({ kind: "replaced", successorNumber: "ADV-000002" }) })]);
    const sy = ok<{ lines: Array<{ unused: { minor: string } }> }>(sync.getAdvanceStatement({ customerId: y.id }));
    expect(sy.lines).toEqual([expect.objectContaining({ unused: { minor: "5000", currency: "USD" } })]);
    // the correction channel is owner only, by the service too
    h.service.login("cashier-02", "2222");
    expect(errCode(sync.correctAdvance({ advanceId: corr.successor.id, kind: "not_received", reason: "لا", confirmNotReceived: true, idempotencyKey: "ipc-corr-key-0002" }))).toBe("NOT_AUTHORIZED");
  });

  it("an open intent (crash between the two transactions) is listed open and finished under its own key", () => {
    const c = customer();
    const { sync } = wired();
    h.db
      .prepare("INSERT INTO advance_attempts (idempotency_key, customer_id, currency, amount_minor, channel, request_fingerprint, created_by, created_at) VALUES ('ipc-open-key-001', ?, 'USD', 700, 'cash', ?, 'cashier-01', '2026-10-04T09:00:00.000Z')")
      .run(c.id, "x");
    const rows = ok<Array<{ status: string; customerName: string }>>(sync.pendingAdvances(undefined));
    expect(rows).toEqual([expect.objectContaining({ status: "open", customerName: "زبون" })]);
  });
});

describe("ADV IPC — documents", () => {
  it("print / PDF take an ID only, refuse an unknown advance before any window, and say unavailable when unwired", async () => {
    const c = customer();
    const { all, sync } = wired();
    const a = ok<{ advance: AdvanceDto }>(sync.recordAdvance({ customerId: c.id, amountMinor: "100", channel: "cash", idempotencyKey: "ipc-adv-key-0020" })).advance;
    expect(errCode(await all.printAdvance({ advanceId: "nope" }))).toBe("ADVANCE_NOT_FOUND");
    expect(errCode(await all.printAdvance({ advanceId: a.id, html: "<b>x</b>" }))).toBe("INVALID_INPUT");
    expect(ok<{ status: string }>(await all.printAdvance({ advanceId: a.id }))).toEqual({ status: "unavailable" });
    let printed = "";
    const { all: withPrint } = wired({ printAdvance: async (id) => ((printed = id), "printed") });
    expect(ok<{ status: string }>(await withPrint.printAdvance({ advanceId: a.id }))).toEqual({ status: "printed" });
    expect(printed).toBe(a.id);
  });

  it("the document escapes every value, says it is not a sale, and a correction says it is NOT new money", () => {
    const base: AdvanceDto = {
      id: "a",
      docNo: 2,
      number: "ADV-000002",
      customerId: "c",
      customerName: "<script>x</script>",
      amount: { minor: "5000", currency: "USD" },
      channel: "whish",
      reference: "WH-1",
      receivedByName: "كاشير",
      receivedAt: "2026-10-04T09:00:00.000Z",
      businessDate: "2026-10-04",
      origin: "correction",
      correctsNumber: "ADV-000001",
    };
    const html = renderAdvanceDocument({ advance: base, correction: null, shopName: "محل & شركاه" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("محل &amp; شركاه");
    expect(html).toContain("50.00&nbsp;USD");
    expect(html).toContain("ليس قبضاً جديداً");
    expect(html).toContain("ADV-000001");
    expect(html).toContain("ليست فاتورة بيع ولا تسديداً لدين");
    const stamped = renderAdvanceDocument({
      advance: { ...base, origin: "receipt", correctsNumber: null },
      correction: { kind: "not_received", reason: "لم يدفع", fundsNotReceived: true, correctedByName: "المالك", correctedAt: "2026-10-06T09:00:00.000Z", businessDate: "2026-10-06", successorNumber: null },
      shopName: null,
    });
    expect(stamped).toContain("مصحَّح — لم يُقبض المبلغ");
    // printed in the shop's zone, not UTC: 09:00Z is 12:00 in Beirut in October (UTC+3)
    const local = renderAdvanceDocument({ advance: { ...base, origin: "receipt", correctsNumber: null }, correction: null, shopName: null, timeZone: "Asia/Beirut" });
    expect(local).toContain("2026-10-04 12:00");
    expect(local).not.toContain("UTC");
  });
});

describe("ADV IPC — not wired", () => {
  it("every advance channel says NOT_AVAILABLE without the service", () => {
    const bare = syncHandlers(createIpcHandlers(h.service));
    expect(errCode(bare.recordAdvance({ customerId: "c", amountMinor: "1", channel: "cash", idempotencyKey: "ipc-adv-key-0099" }))).toBe("NOT_AVAILABLE");
    expect(errCode(bare.pendingAdvances(undefined))).toBe("NOT_AVAILABLE");
    expect(errCode(bare.getAdvanceStatement({ customerId: "c" }))).toBe("NOT_AVAILABLE");
  });
});
