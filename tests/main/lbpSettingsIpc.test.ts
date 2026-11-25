/**
 * M5 — the LBP display channels, by EXECUTION (owner decision 2026-11-25).
 *   setLbpRate          owner-only; validated in main; an invalid rate never reaches the store
 *   setDisplayCurrency  any signed-in operator; only "USD" or "LBP"
 * Neither writes the ledger: the harness ledger's sales and catalog are compared before and after.
 */
import { TEST_CASHIER_PIN } from "../helpers/testCredentials";
import { describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { TerminalSettings } from "../../src/shared/i18n";
import { makeHarness, tempDir } from "../helpers/harness";

function fakeStore() {
  let s: TerminalSettings = { terminalLanguage: "ar", receiptLanguage: "ar", displayCurrency: "USD", lbpRate: "89000", lbpRateConfirmed: false };
  const rates: bigint[] = [];
  return {
    rates,
    store: {
      get: () => s,
      setTerminalLanguage: (lang: "ar" | "en") => (s = { ...s, terminalLanguage: lang }),
      setDisplayCurrency: (currency: "USD" | "LBP") => (s = { ...s, displayCurrency: currency }),
      setLbpRate: (h: bigint) => {
        rates.push(h);
        return (s = { ...s, lbpRate: (h / 100n).toString() + (h % 100n === 0n ? "" : `.${(h % 100n).toString().padStart(2, "0")}`) });
      },
    },
  };
}

const ledgerFingerprint = (db: { prepare(sql: string): { get(): unknown } }) =>
  JSON.stringify([
    db.prepare("SELECT count(*) AS n FROM sales").get(),
    db.prepare("SELECT count(*) AS n, coalesce(sum(selling_price_minor), 0) AS p FROM catalog_products").get(),
  ], (_k, v) => (typeof v === "bigint" ? v.toString() : v));

describe("M5 LBP display channels", () => {
  it("the owner sets a valid rate; invalid rates are refused before the store", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath); // signs in the seeded owner
    try {
      const f = fakeStore();
      const ipc = syncHandlers(createIpcHandlers(h.service, { settings: f.store }));
      const before = ledgerFingerprint(h.db);

      expect(ipc.setLbpRate({ rate: "89,500" })).toMatchObject({ ok: true, data: { lbpRate: "89500" } });
      for (const bad of ["0", "-5", "1e5", "89500.001", "", "abc"]) {
        const r = ipc.setLbpRate({ rate: bad }) as { ok: boolean; error?: { code: string } };
        expect(r.ok, bad).toBe(false);
        expect(r.error?.code, bad).toBe("INVALID_INPUT");
      }
      expect(f.rates, "only the valid rate reached the store").toEqual([8_950_000n]);
      // Extra keys are refused outright (exactObject): no amount can ride along.
      expect((ipc.setLbpRate({ rate: "89000", amount: 5 }) as { ok: boolean }).ok).toBe(false);

      expect(ledgerFingerprint(h.db), "the rate is not ledger data").toBe(before);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("the display choice accepts only USD or LBP and writes no ledger data", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath);
    try {
      const f = fakeStore();
      const ipc = syncHandlers(createIpcHandlers(h.service, { settings: f.store }));
      const before = ledgerFingerprint(h.db);
      expect(ipc.setDisplayCurrency({ currency: "LBP" })).toMatchObject({ ok: true, data: { displayCurrency: "LBP" } });
      expect(ipc.getSettings(undefined)).toMatchObject({ ok: true, data: { displayCurrency: "LBP", lbpRate: "89000" } });
      for (const bad of ["EUR", "lbp", "", 1]) {
        expect((ipc.setDisplayCurrency({ currency: bad }) as { ok: boolean }).ok, String(bad)).toBe(false);
      }
      expect(ledgerFingerprint(h.db)).toBe(before);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("a cashier may switch the display but may NOT set the rate", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const f = fakeStore();
      const ipc = syncHandlers(createIpcHandlers(h.service, { settings: f.store }));
      expect((ipc.login({ cashierId: "cashier-02", pin: TEST_CASHIER_PIN }) as { ok: boolean }).ok).toBe(true);
      expect(ipc.setDisplayCurrency({ currency: "LBP" })).toMatchObject({ ok: true });
      const r = ipc.setLbpRate({ rate: "90000" }) as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("NOT_AUTHORIZED");
      expect(f.rates).toEqual([]);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });
});
