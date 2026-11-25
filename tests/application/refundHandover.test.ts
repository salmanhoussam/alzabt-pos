/**
 * DEC-35zz++ REF Option A — the operational safeguard against handing a refund's cash over twice (no migration).
 *
 *   · a SECOND refund of the SAME advance on the SAME business day is refused unless the owner confirms it is a NEW
 *     one — enforced in the SERVICE (and the channel validates the flag), not only on the screen;
 *   · the replay of the earlier request (same key) is never blocked: it answers duplicate, writes nothing;
 *   · the next business day needs no confirmation;
 *   · «استردادات اليوم»: the owner's Daily Money carries the day's REF- documents BY NAME (number, customer, amount,
 *     time, by) — after a crash the recorded refund is found there, and finding it writes nothing.
 *
 * 🔴 None of this PROVES the cash was handed over (a tick and a receipt are not evidence of a drawer movement):
 *    the residual risk stays operational, closed by the owner's manual drawer count.
 * Synthetic data. Harness clock: 2026-10-04, Beirut.
 */
import { TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdvanceService } from "../../src/application/advanceService";
import { DailyMoneyService } from "../../src/application/dailyMoneyService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { DailyMoneyRepository } from "../../src/persistence/dailyMoneyRepository";
import type { AdvanceStatementDto, DailyMoneyDto, IpcResult } from "../../src/shared/ipcContract";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let ipc: ReturnType<typeof syncHandlers>;
function wire() {
  adv = makeAdvances(h);
  const dm = new DailyMoneyService({
    repository: new DailyMoneyRepository(h.db),
    actor: () => {
      const c = h.service.currentCashier();
      const role = h.service.currentRole();
      return c && role ? { id: c.id, role } : null;
    },
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone, currency: FIXTURE_TERMINAL.currency },
    now: h.clock.now,
  });
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger, advances: adv, dailyMoney: dm }));
}
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  wire();
});
afterEach(() => {
  if (h.db.open) h.db.close();
  t.cleanup();
});

const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const code = (r: IpcResult<unknown>) => (r.ok ? "OK" : r.error.code);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return "OK";
};
const n = (sql: string) => Number(Object.values(h.db.prepare(sql).get() as Record<string, unknown>)[0]);
const footprint = () => [n("SELECT count(*) FROM advance_refunds"), n("SELECT last_no FROM document_numbers WHERE kind = 'advance_refund'")];
const advance = (name: string, minor: bigint) => {
  const c = h.parties.create({ kind: "customer", displayName: name }).party;
  const k = newKey();
  const a = adv.record({ customerId: c.id, amountMinor: minor, channel: "cash", idempotencyKey: k }).record;
  adv.acknowledge(k);
  return a;
};

describe("Option A — a same-day second refund needs the owner's explicit «new refund»", () => {
  it("🔴 refused without the confirmation (service AND channel), nothing written; accepted with it", () => {
    const a = advance("زبون الحماية", 1000n);
    adv.refund({ advanceId: a.id, amountMinor: 300n, reason: "طلب أول", idempotencyKey: "handover-key-0001" });
    const fp = footprint();
    expect(codeOf(() => adv.refund({ advanceId: a.id, amountMinor: 300n, reason: "طلب ثانٍ", idempotencyKey: newKey() }))).toBe("ADVANCE_REFUND_REPEAT_UNCONFIRMED");
    expect(code(ipc.refundAdvance({ advanceId: a.id, amountMinor: "300", reason: "طلب ثانٍ", idempotencyKey: newKey() }))).toBe("ADVANCE_REFUND_REPEAT_UNCONFIRMED");
    expect(code(ipc.refundAdvance({ advanceId: a.id, amountMinor: "300", reason: "طلب ثانٍ", idempotencyKey: newKey(), confirmRepeat: false }))).toBe("ADVANCE_REFUND_REPEAT_UNCONFIRMED");
    expect(code(ipc.refundAdvance({ advanceId: a.id, amountMinor: "300", reason: "طلب ثانٍ", idempotencyKey: newKey(), confirmRepeat: "yes" }))).toBe("INVALID_INPUT");
    expect(footprint()).toEqual(fp);
    const second = ok<{ refund: { number: string } }>(ipc.refundAdvance({ advanceId: a.id, amountMinor: "300", reason: "طلب ثانٍ", idempotencyKey: newKey(), confirmRepeat: true }));
    expect(second.refund.number).toBe("REF-000002");
  });

  it("the REPLAY of the earlier request is never blocked: same key → duplicate, nothing written", () => {
    const a = advance("زبون الإعادة", 1000n);
    const first = adv.refund({ advanceId: a.id, amountMinor: 300n, reason: "طلب", idempotencyKey: "handover-key-0002" });
    const fp = footprint();
    const replay = adv.refund({ advanceId: a.id, amountMinor: 300n, reason: "طلب", idempotencyKey: "handover-key-0002" });
    expect([replay.duplicate, replay.refund.id]).toEqual([true, first.refund.id]);
    expect(footprint()).toEqual(fp);
  });

  it("another advance, or the next business day, needs no confirmation", () => {
    const a = advance("زبون أ", 1000n);
    const b = advance("زبون ب", 1000n);
    adv.refund({ advanceId: a.id, amountMinor: 100n, reason: "اليوم", idempotencyKey: newKey() });
    expect(adv.refund({ advanceId: b.id, amountMinor: 100n, reason: "دفعة أخرى", idempotencyKey: newKey() }).refund.docNo).toBe(2);
    h.clock.set("2026-10-05T09:00:00.000Z");
    expect(adv.refund({ advanceId: a.id, amountMinor: 100n, reason: "غداً", idempotencyKey: newKey() }).refund.docNo).toBe(3);
  });
});

describe("«استردادات اليوم» — the day's REF- documents by name (owner)", () => {
  it("Daily Money lists each REF- of the day with customer, amount, time and who refunded; reading it writes nothing", () => {
    const a = advance("زبون القائمة", 1000n);
    const b = advance("زبون آخر", 500n);
    adv.refund({ advanceId: a.id, amountMinor: 250n, reason: "أول", idempotencyKey: newKey() });
    adv.refund({ advanceId: b.id, amountMinor: 500n, reason: "كامل", idempotencyKey: newKey() });
    const fp = footprint();
    const day = ok<DailyMoneyDto>(ipc.getDailyMoney({}));
    expect(day.refundsList.map((r) => [r.number, r.customerName, r.amount.minor, r.refundedByName, r.method])).toEqual([
      ["REF-000001", "زبون القائمة", "250", "Cashier One", "cash"],
      ["REF-000002", "زبون آخر", "500", "Cashier One", "cash"],
    ]);
    expect(day.refundsList.every((r) => typeof r.refundedAt === "string" && r.businessDate === day.date)).toBe(true);
    // a past day lists ITS refunds only, forever the same
    expect(ok<DailyMoneyDto>(ipc.getDailyMoney({ date: "2026-10-03" })).refundsList).toEqual([]);
    expect(footprint()).toEqual(fp);
  });

  it("the advance statement carries the business day, so the sheet can name an earlier REF- of TODAY", () => {
    const a = advance("زبون الكشف", 1000n);
    adv.refund({ advanceId: a.id, amountMinor: 100n, reason: "اليوم", idempotencyKey: newKey() });
    const st = ok<AdvanceStatementDto>(ipc.getAdvanceStatement({ customerId: a.customerId }));
    expect(st.today).toBe("2026-10-04");
    expect(st.lines[0]!.refunds.filter((r) => r.businessDate === st.today).map((r) => r.number)).toEqual(["REF-000001"]);
  });

  it("🔴 a cashier cannot read the list (Daily Money stays owner-only)", () => {
    const a = advance("زبون", 1000n);
    adv.refund({ advanceId: a.id, amountMinor: 100n, reason: "سبب", idempotencyKey: newKey() });
    h.service.logout();
    h.service.login("cashier-02", TEST_CASHIER_PIN);
    expect(code(ipc.getDailyMoney({}))).toBe("NOT_AUTHORIZED");
  });

  it("🔴 CRASH after the commit: on restart the REF- is in «استردادات اليوم», and an accidental re-entry (new key) is stopped", () => {
    const a = advance("زبون الانهيار", 1000n);
    h.db.close();
    const r = spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "..", "helpers", "advanceCrashChild.ts"), "refund-after-commit", t.dbPath, a.id, "handover-crash-01"], {
      encoding: "utf8",
      timeout: 60000,
    });
    expect(r.stderr).toContain("KILL-POINT-REACHED");
    h = makeHarness(t.dbPath);
    wire();
    const day = ok<DailyMoneyDto>(ipc.getDailyMoney({}));
    expect(day.refundsList.map((x) => [x.number, x.customerName, x.amount.minor])).toEqual([["REF-000001", "زبون الانهيار", "400"]]);
    const fp = footprint();
    expect(code(ipc.refundAdvance({ advanceId: a.id, amountMinor: "400", reason: "الزبون طلب استرداد", idempotencyKey: newKey() }))).toBe("ADVANCE_REFUND_REPEAT_UNCONFIRMED");
    expect(footprint()).toEqual(fp);
  });
});
