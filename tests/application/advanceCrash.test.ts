/**
 * REAL process death while recording a cash advance (owner decision D5, migration 20 draft part 1).
 *
 * A child process records ONE cash advance and is killed at a chosen point; this process reopens the
 * same ledger (SQLite WAL recovery runs) and must find EXACTLY what the design promises:
 *
 *   after-intent        the intent survives, no money row, no number used → listed as OPEN; new advances
 *                       for that customer are held; finishing it under the ORIGINAL key gives ADV-000001
 *   inside-money-tx     the half-written advance and its number rolled back → OPEN, no gap: ADV-000001
 *   after-money-commit  the advance exists, the receipt was never seen → listed as RECORDED with the SAME
 *                       ADV number; the operator's retry with the same key writes nothing new
 *
 * In no case is "same customer, same amount, same day" used to decide anything.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAdvances } from "../helpers/advanceHarness";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";

const CHILD = join(__dirname, "..", "helpers", "advanceCrashChild.ts");
const KEY = "adv-crash-key-0001";

let t: TempDir;
let customerId: string;
beforeEach(() => {
  t = tempDir();
  const h = makeHarness(t.dbPath);
  customerId = h.parties.create({ kind: "customer", displayName: "زبون الانهيار" }).party.id;
  h.db.close();
});
afterEach(() => t.cleanup());

function crashAt(mode: string): void {
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, mode, t.dbPath, customerId, KEY], { encoding: "utf8", timeout: 60000 });
  expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
  expect(r.stderr).not.toMatch(/Error|unreachable/);
  if (process.platform === "win32") expect(r.status).not.toBe(0);
  else expect(r.signal).toBe("SIGKILL");
}

function reopen() {
  const h = makeHarness(t.dbPath);
  const q = (sql: string) => Number((h.db.prepare(sql).get() as { c: bigint }).c);
  return {
    h,
    adv: makeAdvances(h),
    advances: () => q("SELECT count(*) AS c FROM customer_advances"),
    lastNo: () => q("SELECT last_no AS c FROM document_numbers WHERE kind = 'advance'"),
    integrity: () => h.db.pragma("integrity_check", { simple: true }),
  };
}

describe("cash advance — real process death", () => {
  it("killed AFTER the intent committed: the intent survives OPEN, nothing else; finishing gives ADV-000001", () => {
    crashAt("after-intent");
    const s = reopen();
    try {
      expect(s.integrity()).toBe("ok");
      expect(s.advances()).toBe(0);
      expect(s.lastNo()).toBe(0);
      expect(s.adv.pending()).toEqual([expect.objectContaining({ status: "open", key: KEY })]);
      expect(() => s.adv.record({ customerId, amountMinor: 2500n, channel: "cash", idempotencyKey: "adv-crash-key-0002" })).toThrow(
        expect.objectContaining({ code: "ADVANCE_UNRESOLVED" }),
      );
      const done = s.adv.finish(KEY);
      expect(done.record.docNo).toBe(1);
      expect(s.advances()).toBe(1);
    } finally {
      s.h.db.close();
    }
  });

  it("killed INSIDE the money transaction: advance AND number rolled back; finishing gives ADV-000001 (no gap)", () => {
    crashAt("inside-money-tx");
    const s = reopen();
    try {
      expect(s.integrity()).toBe("ok");
      expect(s.advances()).toBe(0);
      expect(s.lastNo()).toBe(0);
      expect(s.adv.pending()).toEqual([expect.objectContaining({ status: "open", key: KEY })]);
      expect(s.adv.finish(KEY).record.docNo).toBe(1);
    } finally {
      s.h.db.close();
    }
  });

  it("🔴 killed AFTER the money committed (receipt never shown): RECORDED, same ADV; the retry writes nothing", () => {
    crashAt("after-money-commit");
    const s = reopen();
    try {
      expect(s.integrity()).toBe("ok");
      expect(s.advances()).toBe(1);
      expect(s.lastNo()).toBe(1);
      const p = s.adv.pending();
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ status: "recorded", key: KEY });
      const retry = s.adv.record({ customerId, amountMinor: 2500n, channel: "cash", idempotencyKey: KEY });
      expect(retry.duplicate).toBe(true);
      expect(retry.record.docNo).toBe(1);
      expect(s.advances()).toBe(1);
      s.adv.acknowledge(KEY);
      expect(s.adv.pending()).toHaveLength(0);
    } finally {
      s.h.db.close();
    }
  });
});

describe("advance CORRECTION (G2) — real process death", () => {
  const CKEY = "adv-corr-crash-0001";
  const correction = (advanceId: string) => ({
    advanceId,
    kind: "replaced",
    amountMinor: 2000n,
    confirmNotReceived: true,
    reason: "المبلغ أقل",
    idempotencyKey: CKEY,
  });
  /** One cash advance of 2500, recorded and seen, before the child corrects it. */
  function seedAdvance(): string {
    const h = makeHarness(t.dbPath);
    const adv = makeAdvances(h);
    const r = adv.record({ customerId, amountMinor: 2500n, channel: "cash", idempotencyKey: KEY });
    adv.acknowledge(KEY);
    h.db.close();
    return r.record.id;
  }
  function crashCorrect(mode: string, advanceId: string): void {
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, mode, t.dbPath, advanceId, CKEY], { encoding: "utf8", timeout: 60000 });
    expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
    expect(r.stderr).not.toMatch(/Error|unreachable/);
    if (process.platform === "win32") expect(r.status).not.toBe(0);
    else expect(r.signal).toBe("SIGKILL");
  }
  const corrections = (s: ReturnType<typeof reopen>) =>
    Number((s.h.db.prepare("SELECT count(*) AS c FROM advance_corrections").get() as { c: bigint }).c);

  it("killed INSIDE the correction transaction: NOTHING survives (no correction, no successor, no number); the retry corrects once", () => {
    const id = seedAdvance();
    crashCorrect("correct-inside-tx", id);
    const s = reopen();
    try {
      expect(s.integrity()).toBe("ok");
      expect(s.advances()).toBe(1);
      expect(s.lastNo()).toBe(1);
      expect(corrections(s)).toBe(0);
      const r = s.adv.correct(correction(id));
      expect(r.duplicate).toBe(false);
      expect(r.successor!.docNo).toBe(2); // no gap
      expect(corrections(s)).toBe(1);
    } finally {
      s.h.db.close();
    }
  });

  it("🔴 killed AFTER the correction committed (reply lost): the retry returns the SAME correction and writes nothing", () => {
    const id = seedAdvance();
    crashCorrect("correct-after-commit", id);
    const s = reopen();
    try {
      expect(s.integrity()).toBe("ok");
      expect(s.advances()).toBe(2);
      expect(s.lastNo()).toBe(2);
      expect(corrections(s)).toBe(1);
      const r = s.adv.correct(correction(id));
      expect(r.duplicate).toBe(true);
      expect(r.successor!.docNo).toBe(2);
      expect(s.advances()).toBe(2);
      expect(s.lastNo()).toBe(2);
      expect(corrections(s)).toBe(1);
    } finally {
      s.h.db.close();
    }
  });
});
