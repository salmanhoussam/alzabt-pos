import { describe, expect, it, vi } from "vitest";
import { readRealEntryState } from "../../src/main/entryState";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import { makeHarness, tempDir } from "../helpers/harness";

const empty = { productRows: 0, parties: 0, invoices: 0, merchantSaleLines: 0, salesRows: 0 };

describe("read-only real entry routing hint", () => {
  it("returns only the agreed fields, with Demo disabled and no session or credentials", () => {
    expect(readRealEntryState(() => false, () => empty)).toEqual({
      profile: "real", terminalClaimed: false, firstRunEligible: true, demoAvailable: false,
    });
  });
  it("keeps a claimed terminal on legacy login without probing data", () => {
    const probe = vi.fn(() => empty);
    expect(readRealEntryState(() => true, probe)).toMatchObject({ terminalClaimed: true, firstRunEligible: false });
    expect(probe).not.toHaveBeenCalled();
  });
  it("fails closed when any probed count is nonzero or invalid", () => {
    for (const probe of [
      { ...empty, productRows: 1 }, { ...empty, parties: 1 }, { ...empty, invoices: 1 },
      { ...empty, merchantSaleLines: 1 }, { ...empty, salesRows: 1 }, { ...empty, salesRows: NaN }, { ...empty, productRows: -1 }, { ...empty, parties: NaN },
    ]) expect(readRealEntryState(() => false, () => probe).firstRunEligible).toBe(false);
    expect(readRealEntryState(() => false, () => { throw new Error("private"); }).firstRunEligible).toBe(false);
  });
  it("returns a safe error rather than inventing claim state or exposing underlying errors", () => {
    expect(() => readRealEntryState(() => { throw new Error("private path"); }, () => empty)).toThrow("Entry state is unavailable");
    expect(() => readRealEntryState(() => undefined as unknown as boolean, () => empty)).toThrow("Entry state is unavailable");
  });
  it("exposes the read-only hint without a session and refuses forged payloads", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const entry = vi.fn(() => readRealEntryState(() => false, () => empty));
      const handlers = createIpcHandlers(h.service, { entryState: entry });
      expect(handlers.getEntryState(undefined)).toEqual({
        ok: true, data: { profile: "real", terminalClaimed: false, firstRunEligible: true, demoAvailable: false },
      });
      expect(handlers.getEntryState({ profile: "demo" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(entry).toHaveBeenCalledTimes(1);
      expect(h.service.currentCashier()).toBeNull();
    } finally { h.db.close(); t.cleanup(); }
  });
});
