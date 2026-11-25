import { describe, expect, it, vi } from "vitest";
import type { PosService } from "../../src/application/posService";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import { readRealEntryState } from "../../src/main/entryState";

const fakeService = {} as PosService;
const empty = { productRows: 0, parties: 0, invoices: 0, merchantSaleLines: 0, salesRows: 0 };

describe("entry-state public boundary without database access", () => {
  it("exposes only the approved hint without needing an authenticated service", () => {
    const handlers = createIpcHandlers(fakeService, {
      entryState: () => readRealEntryState(() => false, () => empty),
    });
    expect(handlers.getEntryState(undefined)).toEqual({
      ok: true,
      data: { profile: "real", terminalClaimed: false, firstRunEligible: true, demoAvailable: false },
    });
  });

  it("rejects forged profile payload before calling the provider", () => {
    const entryState = vi.fn(() => readRealEntryState(() => false, () => empty));
    const handlers = createIpcHandlers(fakeService, { entryState });
    expect(handlers.getEntryState({ profile: "demo" })).toMatchObject({
      ok: false, error: { code: "INVALID_INPUT" },
    });
    expect(entryState).not.toHaveBeenCalled();
  });

  it("fails safely when the provider is absent", () => {
    expect(createIpcHandlers(fakeService).getEntryState(undefined)).toEqual({
      ok: false, error: { code: "NOT_AVAILABLE", message: "Entry state is unavailable" },
    });
  });

  it("never exposes an underlying claim-state error", () => {
    const handlers = createIpcHandlers(fakeService, {
      entryState: () => readRealEntryState(() => { throw new Error("synthetic-private-sentinel"); }, () => empty),
    });
    const result = handlers.getEntryState(undefined);
    expect(result).toEqual({
      ok: false, error: { code: "NOT_AVAILABLE", message: "Entry state is unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-sentinel");
  });
});
