/**
 * DEC-35y review — APPLY ADVANCE TO A NEW SALE: the owner's explicit cases (advance below / equal /
 * above the sale, the balance changing before confirm, a refunded advance, the same key with other
 * details, the statement, a LOST REPLY after commit by real process death, and two REAL processes
 * racing on one advance). Every case checks that the sale, its debt, the settlement and the advance
 * balance AGREE — no test may leave an unmatched sale, debt or ADV balance.
 *
 * Synthetic data only. Minor units (USD cents). Harness clock: 2026-10-04, Beirut.
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdvanceService } from "../../src/application/advanceService";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { IpcResult } from "../../src/shared/ipcContract";
import { makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let ipc: ReturnType<typeof syncHandlers>;
const DAY = "2026-10-04";
const LINES = [{ productId: "prod-0001", quantityMilli: 2000 }]; // 2 × 2.50 = 5.00
const CHILD = join(__dirname, "..", "helpers", "advanceCrashChild.ts");

function wire() {
  adv = makeAdvances(h);
  ipc = syncHandlers(createIpcHandlers(h.service, { parties: h.parties, ledger: h.ledger, advances: adv }));
}
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  wire();
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `RAW: ${(e as Error).message}`;
  }
  return "OK";
};
const ok = <T>(r: IpcResult<unknown>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};
const count = (table: string) => Number((h.db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);
const footprint = () => ["sales", "sale_lines", "sale_tenders", "obligations", "settlements", "advance_applications", "external_references", "receipts"].map(count);
const customer = (name: string) => h.parties.create({ kind: "customer", displayName: name }).party;
const advance = (customerId: string, minor: bigint) => {
  const k = newKey();
  const r = adv.record({ customerId, amountMinor: minor, channel: "cash", idempotencyKey: k });
  adv.acknowledge(k);
  return r.record;
};
const sell = (customerId: string, advanceId: string, amountMinor: bigint, idempotencyKey = newKey(), over: Record<string, unknown> = {}) =>
  adv.sellOnAdvance({ idempotencyKey, customerId, lines: LINES, expectedTotalMinor: 500n, advanceId, amountMinor, ...over });

/** The sale, its debt, the settlement and the application must agree exactly. */
function ledgerAgrees(saleId: string) {
  const sale = h.db.prepare("SELECT total_minor AS t, balance_due_minor AS b, paid_minor AS p FROM sales WHERE id = ?").get(saleId) as { t: bigint; b: bigint; p: bigint };
  const ob = h.db.prepare("SELECT id, amount_minor AS a FROM obligations WHERE sale_id = ?").get(saleId) as { id: string; a: bigint };
  const settled = (h.db.prepare("SELECT coalesce(sum(amount_minor),0) AS s FROM settlements WHERE obligation_id = ?").get(ob.id) as { s: bigint }).s;
  const applied = (
    h.db.prepare("SELECT coalesce(sum(aa.amount_minor),0) AS s FROM advance_applications aa JOIN settlements st ON st.id = aa.settlement_id WHERE st.obligation_id = ?").get(ob.id) as { s: bigint }
  ).s;
  expect([sale.p, sale.b, ob.a]).toEqual([0n, sale.t, sale.t]); // no cash/Whish taken; the debt is the whole sale
  expect(settled).toBe(applied); // every settlement of this debt came from the advance
  return { total: sale.t, applied, owed: sale.t - settled };
}

describe("amounts", () => {
  it("advance BELOW the sale (3.00 < 5.00): all of it applied, 2.00 stays debt, advance 0", () => {
    const c = customer("زبون");
    const a = advance(c.id, 300n);
    const r = sell(c.id, a.id, 300n);
    expect(ledgerAgrees(r.sale.id)).toEqual({ total: 500n, applied: 300n, owed: 200n });
    expect(r.application.unusedMinor).toBe(0n);
  });

  it("advance EQUAL to the sale (5.00 = 5.00): nothing owed, advance 0", () => {
    const c = customer("زبون");
    const a = advance(c.id, 500n);
    const r = sell(c.id, a.id, 500n);
    expect(ledgerAgrees(r.sale.id)).toEqual({ total: 500n, applied: 500n, owed: 0n });
    expect(r.application.unusedMinor).toBe(0n);
  });

  it("advance ABOVE the sale (30.00 > 5.00): 5.00 applied, 25.00 stays on the advance, nothing owed", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const r = sell(c.id, a.id, 500n);
    expect(ledgerAgrees(r.sale.id)).toEqual({ total: 500n, applied: 500n, owed: 0n });
    expect(r.application.unusedMinor).toBe(2500n);
  });
});

describe("state that moved, and keys", () => {
  it("🔴 the balance CHANGED between opening the screen and confirming: refused, nothing written", () => {
    const c = customer("زبون");
    const a = advance(c.id, 500n);
    const screenSaw = 500n; // what the till read when the panel opened
    const other = h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "OTHER", currency: "USD", amountMinor: 400n }).record;
    adv.applyToDebt({ advanceId: a.id, obligationId: other.id, amountMinor: 400n, idempotencyKey: newKey() });
    const fp = footprint();
    expect(codeOf(() => sell(c.id, a.id, screenSaw))).toBe("ADVANCE_APPLY_ABOVE_BALANCE");
    expect(footprint()).toEqual(fp);
  });

  it("a fully REFUNDED advance cannot pay a sale; nothing written", () => {
    const c = customer("زبون");
    const a = advance(c.id, 500n);
    const at = h.clock.now().toISOString();
    h.db.transaction(() => {
      h.db.prepare("UPDATE document_numbers SET last_no = last_no + 1 WHERE kind = 'advance_refund'").run();
      h.db
        .prepare(
          "INSERT INTO advance_refunds (id, doc_no, advance_id, amount_minor, method, reason, idempotency_key, request_fingerprint, refunded_by, refunded_at, business_date) VALUES ('ref-1', 1, ?, 500, 'cash', 'customer asked', 'refund-key-0001', 'fp', 'cashier-01', ?, ?)",
        )
        .run(a.id, at, DAY);
    })();
    const fp = footprint();
    expect(codeOf(() => sell(c.id, a.id, 100n))).toBe("ADVANCE_APPLY_ABOVE_BALANCE");
    expect(footprint()).toEqual(fp);
  });

  it("🔴 the same key for DIFFERENT sale details (other lines; other advance) is refused; nothing new", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    const b = advance(c.id, 3000n);
    const key = "sale-adv-reuse-0001";
    sell(c.id, a.id, 200n, key);
    const fp = footprint();
    expect(codeOf(() => sell(c.id, a.id, 200n, key, { lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: 250n }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => sell(c.id, b.id, 200n, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(footprint()).toEqual(fp);
  });

  it("the customer statement shows the sale debt, the ADV settlement and what is still owed", () => {
    const c = customer("زبون الكشف");
    const a = advance(c.id, 300n);
    const r = sell(c.id, a.id, 300n);
    const stmt = ok<{ obligations: Array<{ id: string; outstanding: { minor: string }; settlements: Array<{ advance: unknown; amount: unknown }> }> }>(
      ipc.getCustomerStatement({ customerId: c.id }),
    );
    const row = stmt.obligations.find((o) => o.id === r.obligation.id)!;
    expect(row.outstanding.minor).toBe("200");
    expect(row.settlements).toEqual([expect.objectContaining({ amount: { minor: "300", currency: "USD" }, advance: { advanceId: a.id, number: "ADV-000001" } })]);
  });
});

describe("🔴 real processes", () => {
  it("LOST REPLY after commit (real process death): the retry returns the SAME sale — never a second one", () => {
    const c = customer("زبون");
    const a = advance(c.id, 3000n);
    h.db.close();
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, "sale-after-commit", t.dbPath, a.id, "sale-adv-lost-0001"], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, SALE_CUSTOMER: c.id },
    });
    expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
    h = makeHarness(t.dbPath);
    wire();
    expect([count("sales"), count("advance_applications")]).toEqual([1, 1]);
    const again = sell(c.id, a.id, 200n, "sale-adv-lost-0001");
    expect([again.duplicate, count("sales"), count("advance_applications"), count("settlements")]).toEqual([true, 1, 1, 1]);
    expect(ledgerAgrees(again.sale.id)).toEqual({ total: 500n, applied: 200n, owed: 300n });
  });

  type Outcome = { ok: boolean; code?: string; duplicate?: boolean };
  const race = (key: (i: number) => string, amount: string, customerId: string, advanceId: string) =>
    Promise.all(
      [0, 1].map(
        (i) =>
          new Promise<Outcome>((resolve, reject) => {
            const p = spawn(process.execPath, ["--import", "tsx", CHILD, "sale-run", t.dbPath, advanceId, key(i)], {
              env: { ...process.env, SALE_CUSTOMER: customerId, SALE_AMOUNT: amount },
            });
            let out = "";
            let err = "";
            p.stdout.on("data", (d) => (out += d));
            p.stderr.on("data", (d) => (err += d));
            p.on("error", reject);
            p.on("close", () => {
              const last = out.trim().split(/\r?\n/).pop() ?? "";
              try {
                resolve(JSON.parse(last) as Outcome);
              } catch {
                reject(new Error(`no outcome from child ${i}: ${out} ${err}`));
              }
            });
          }),
      ),
    );

  it("CONCURRENT, the SAME key at the same time → exactly ONE sale and ONE application", async () => {
    const c = customer("زبون التزامن");
    const a = advance(c.id, 3000n);
    h.db.close();
    const outcomes = await race(() => "sale-adv-race-same", "200", c.id, a.id);
    h = makeHarness(t.dbPath);
    wire();
    expect([count("sales"), count("obligations"), count("advance_applications"), count("settlements")]).toEqual([1, 1, 1, 1]);
    expect(outcomes.filter((o) => o.ok && !o.duplicate).length).toBe(1);
    expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
    const sid = (h.db.prepare("SELECT id FROM sales").get() as { id: string }).id;
    expect(ledgerAgrees(sid)).toEqual({ total: 500n, applied: 200n, owed: 300n });
    expect(outcomes).toHaveLength(2);
  }, 120000);

  it("CONCURRENT, two keys spending the SAME advance (4.00 + 4.00 of 5.00) → one sale, never above the balance", async () => {
    const c = customer("زبون التزامن");
    const a = advance(c.id, 500n);
    h.db.close();
    const outcomes = await race((i) => `sale-adv-race-k${i}0`, "400", c.id, a.id);
    h = makeHarness(t.dbPath);
    wire();
    const applied = (h.db.prepare("SELECT coalesce(sum(amount_minor),0) AS s FROM advance_applications WHERE advance_id = ?").get(a.id) as { s: bigint }).s;
    expect(applied).toBe(400n);
    expect(outcomes.filter((o) => o.ok).length).toBe(1);
    expect(outcomes.find((o) => !o.ok)?.code).toBe("ADVANCE_APPLY_ABOVE_BALANCE");
    // whichever lost wrote NO sale and NO debt
    expect([count("sales"), count("obligations")]).toEqual([1, 1]);
    expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
  }, 120000);
});
