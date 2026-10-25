/**
 * M17B-S1 — the ONE new bridge surface, `recordAllocatedReceipt`: classified owner, registered,
 * forwarded by the preload with every field named, strict about extra fields, and with
 * `recordCustomerPayment` left exactly as it was.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accessFor } from "../../src/main/channelPolicy";
import { CHANNELS } from "../../src/shared/ipcContract";

const PRELOAD = readFileSync("src/preload/preload.ts", "utf8");
const HANDLERS = readFileSync("src/main/ipcHandlers.ts", "utf8");

describe("the channel", () => {
  it("exists, is owner-classified and is named exactly once", () => {
    expect(CHANNELS.recordAllocatedReceipt).toBe("pos:recordAllocatedReceipt");
    expect(accessFor("recordAllocatedReceipt")).toBe("owner");
    expect(Object.values(CHANNELS).filter((c) => c === "pos:recordAllocatedReceipt")).toHaveLength(1);
  });
  it("the preload carries a literal copy of the channel and forwards EVERY field by name", () => {
    expect(PRELOAD).toContain('recordAllocatedReceipt: "pos:recordAllocatedReceipt"');
    const body = PRELOAD.slice(PRELOAD.indexOf("recordAllocatedReceipt: (req) =>"), PRELOAD.indexOf("renameCategory: (req) =>"));
    for (const f of ["customerId", "idempotencyKey", "channel", "reference", "fundsConfirmed", "currency", "totalMinor", "allocations"]) {
      expect(body, f).toContain(`${f}:`);
    }
    // each share is rebuilt field by field: nothing the renderer adds rides along
    expect(body).toContain("req.allocations.map((a) => ({ obligationId: a.obligationId, amountMinor: a.amountMinor }))");
    expect(body).not.toMatch(/\.\.\.req/);
  });
  it("the handler is strict: exact keys, a closed channel list, a bounded allocation list, the ledger decides", () => {
    const h = HANDLERS.slice(HANDLERS.indexOf("recordAllocatedReceipt: wrap("), HANDLERS.indexOf("setCustomerActive: wrap("));
    expect(h).toContain("exactObject(p, [");
    expect(h).toContain('o.channel !== "whish" && o.channel !== "bank_transfer"');
    expect(h).toContain("o.allocations.length > 50");
    expect(h).toContain("exactObject(raw, [\"obligationId\", \"amountMinor\"])");
    expect(h).toContain("ledger().recordAllocatedReceipt(");
    // no money arithmetic and no direct database access in the handler
    expect(h).not.toMatch(/\+=|reduce\(|\.prepare\(/);
  });
  it("recordCustomerPayment is untouched: same channel, same five keys, same single ledger.collect call", () => {
    expect(CHANNELS.recordCustomerPayment).toBe("pos:recordCustomerPayment");
    const h = HANDLERS.slice(HANDLERS.indexOf("recordCustomerPayment: wrap("), HANDLERS.indexOf("recordAllocatedReceipt: wrap("));
    expect(h).toContain('["customerId", "obligationId", "idempotencyKey", "amountMinor", "method"]');
    expect(h).toContain('["reference", "fundsConfirmed"]');
    expect(h).toContain("ledger().collect({");
    expect(h).not.toContain("recordAllocatedReceipt");
  });
});
