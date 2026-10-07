/**
 * Real process-death tests. A child process writes to the ledger and is killed with SIGKILL at a
 * chosen point; this process then reopens the same file (WAL recovery runs) and inspects it.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/persistence/db";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

const CHILD = join(__dirname, "..", "helpers", "crashChild.ts");

function runChild(mode: string, dbPath: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", CHILD, mode, dbPath], {
    encoding: "utf8",
    timeout: 60000,
  });
  return result;
}

/** The child died abruptly at its kill point — not from an ordinary exception, not normally. */
function expectHardKill(r: ReturnType<typeof runChild>): void {
  expect(r.stderr, r.stderr).toContain("KILL-POINT-REACHED");
  expect(r.stderr).not.toMatch(/Error|unreachable/);
  if (process.platform === "win32") {
    expect(r.status).not.toBe(0); // TerminateProcess: an exit code, no signal
  } else {
    expect(r.signal).toBe("SIGKILL");
  }
}

function integrity(dbPath: string): string {
  const db = openDatabase(dbPath);
  const v = db.pragma("integrity_check", { simple: true }) as string;
  db.close();
  return v;
}

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

describe("abrupt process death (SIGKILL)", () => {
  it("killed mid-transaction: the reopened ledger holds no sale and no orphan lines", () => {
    const r = runChild("kill-mid-transaction", t.dbPath);
    expectHardKill(r);
    expect(integrity(t.dbPath)).toBe("ok");
    const db = openDatabase(t.dbPath);
    expect(countRows(db)).toEqual({ sales: 0, lines: 0, voids: 0 });
    db.close();

    // And the till keeps working afterwards.
    const h = makeHarness(t.dbPath);
    const { sale } = h.service.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId: "prod-0004", quantityMilli: 4000 }],
      paymentMethod: "cash",
      expectedTotalMinor: 300n,
    });
    expect(sale.receiptNumber).toBe(1);
    h.db.close();
  });

  it("NEGATIVE CONTROL: killed at the same point without a transaction, a partial sale survives", () => {
    const r = runChild("kill-no-transaction", t.dbPath);
    expectHardKill(r);
    const db = openDatabase(t.dbPath);
    expect(countRows(db)).toEqual({ sales: 1, lines: 2, voids: 0 });
    db.close();
  });

  it("killed right after COMMIT without closing: the completed sale survives restart intact", () => {
    const r = runChild("commit-then-kill", t.dbPath);
    expectHardKill(r);
    expect(integrity(t.dbPath)).toBe("ok");
    const h = makeHarness(t.dbPath);
    expect(countRows(h.db)).toEqual({ sales: 1, lines: 3, voids: 0 });
    const report = h.service.getTodaySales();
    expect(report.completedSalesCount).toBe(1);
    expect(report.netSales.minor).toBe(1955n);
    h.db.close();
  });
});
