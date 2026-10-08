/**
 * The IPC handlers are the renderer's entire reach into the main process. These tests drive them
 * with hostile and malformed payloads exactly as the renderer could send them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL_NAMES, createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { CHANNELS, type IpcResult } from "../../src/shared/ipcContract";
import { type TempDir, countRows, makeHarness, newKey, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

function setup() {
  const h = makeHarness(t.dbPath, { login: false });
  return { ...h, ipc: syncHandlers(createIpcHandlers(h.service)) };
}

function errCode(r: IpcResult<unknown>): string {
  if (r.ok) throw new Error(`expected failure, got ${JSON.stringify(r)}`);
  return r.error.code;
}

const goodSale = () => ({
  idempotencyKey: newKey(),
  lines: [{ productId: "prod-0003", quantityMilli: 3000 }],
  paymentMethod: "cash",
  expectedTotalMinor: "597",
});

describe("IPC surface", () => {
  // The surface grew from THIRTEEN channels to NINETEEN when offline product management landed:
  // listProducts, createProduct, updateProduct, setProductActive, getSettings, setTerminalLanguage.
  // It then grew from NINETEEN to FORTY-FOUR with manual invoices (migration 6) — the twenty-five
  // channels listed below the blank line.
  //
  // The old values are named here on purpose — this assertion is the record of what the renderer
  // may ask for, so every addition has to be written down, and the shape rule below still holds:
  // each channel is one named business operation, and there is still no SQL, query, file or generic
  // one. 🔴 Note what is NOT in this list: no channel that accepts a total, a computed line total,
  // an amount in words, an invoice number, a catalog row, a reconciliation status, HTML, or a
  // filesystem path. Those are the things the renderer must not be able to assert.
  it("exposes only the fixed business channels — no SQL, query, file or generic invoke", () => {
    expect(CHANNEL_NAMES.sort()).toEqual(
      [
        "createSale",
        "currentCashier",
        "exportBackup",
        "exportCatalog",
        "getAppInfo",
        "getCatalog",
        "getSaleHistory",
        "getSettings",
        "getTodaySales",
        "importCatalog",
        "listCashiers",
        "listProducts",
        "login",
        "logout",
        "createProduct",
        "setProductActive",
        "setTerminalLanguage",
        "updateProduct",
        "voidSale",

        // Manual invoices (migration 6)
        "getCompanyProfile",
        "saveCompanyProfile",
        "setNextInvoiceNumber",
        "createInvoiceDraft",
        "getInvoice",
        "updateInvoiceHeader",
        "addInvoiceLine",
        "updateInvoiceLine",
        "removeInvoiceLine",
        "discardInvoiceDraft",
        "finalizeInvoice",
        "listInvoices",
        "listInvoiceDrafts",
        "findInvoiceByNumber",
        "searchInvoices",
        "listReconciliation",
        "listReconciliationQueue",
        "resolveKeepCatalog",
        "resolveKeepInvoiceOnly",
        "resolveLinkProduct",
        "resolveCreateProduct",
        "resolveUpdateCatalog",
        "pickInvoiceLogo",
        "printInvoice",
        "saveInvoicePdf",
      ].sort(),
    );
    expect(CHANNEL_NAMES).toHaveLength(44); // was 19 before manual invoices
    for (const ch of Object.values(CHANNELS)) expect(ch).toMatch(/^pos:[a-zA-Z]+$/);

    // Still nothing that would let the renderer speak SQL, name a path or invoke anything generic.
    //
    // 🔴 This check used to be a SUBSTRING match on /sql|query|exec|file|path|invoke|raw/. It was
    // changed to match whole camelCase WORDS when `getCompanyProfile` arrived, because "Profile"
    // contains the letters "file" — a false positive, not a finding. The word form is what the rule
    // always meant, and it is strictly more precise: `pos:readFile`, `pos:execSql`, `pos:queryRaw`
    // and `pos:invoke` are all still rejected, which the self-test below proves rather than assumes.
    const words = (channel: string) =>
      channel
        .replace(/^pos:/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(" ");
    const FORBIDDEN = ["sql", "query", "exec", "file", "path", "invoke", "raw"];
    for (const ch of Object.values(CHANNELS)) {
      for (const word of words(ch)) expect(FORBIDDEN).not.toContain(word);
    }
    // The guard's own correctness: each of these WOULD be caught.
    for (const bad of ["pos:execSql", "pos:readFile", "pos:queryRaw", "pos:invoke", "pos:getFilePath"]) {
      expect(words(bad).some((w) => FORBIDDEN.includes(w))).toBe(true);
    }
    // And a legitimate name that merely contains one of those letter runs is not caught.
    expect(words("pos:getCompanyProfile")).toEqual(["get", "company", "profile"]);
  });

  it("full flow through the handlers: login → sale → today → void → today", () => {
    const { db, ipc } = setup();
    expect(errCode(ipc.createSale(goodSale()))).toBe("NOT_LOGGED_IN");
    expect(ipc.login({ cashierId: "cashier-02", pin: "2222" })).toEqual({
      ok: true,
      data: { id: "cashier-02", name: "Cashier Two" },
    });

    const created = ipc.createSale(goodSale());
    if (!created.ok) throw new Error(JSON.stringify(created));
    const sale = (created.data as { sale: { id: string; total: unknown; cashierId: string } }).sale;
    expect(sale.total).toEqual({ minor: "597", currency: "USD" });
    expect(sale.cashierId).toBe("cashier-02");

    expect(ipc.getTodaySales(undefined)).toMatchObject({
      ok: true,
      data: { completedSalesCount: 1, netSales: { minor: "597", currency: "USD" } },
    });
    expect(ipc.voidSale({ saleId: sale.id, reason: "rang twice" }).ok).toBe(true);
    expect(ipc.getTodaySales(undefined)).toMatchObject({
      ok: true,
      data: { voidedSalesCount: 1, grossSales: { minor: "597" }, voidTotal: { minor: "597" }, netSales: { minor: "0" } },
    });
    expect(countRows(db)).toEqual({ sales: 1, lines: 1, voids: 1 });
    db.close();
  });

  it("the renderer cannot choose the cashier, price, name or receipt number", () => {
    const { db, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    for (const extra of [
      { cashierId: "cashier-02" },
      { unitPrice: "1" },
      { receiptNumber: 7 },
      { sql: "DELETE FROM sales" },
    ]) {
      expect(errCode(ipc.createSale({ ...goodSale(), ...extra })), JSON.stringify(extra)).toBe("INVALID_INPUT");
    }
    const lineWithPrice = { ...goodSale(), lines: [{ productId: "prod-0003", quantityMilli: 3000, unitPrice: "1" }] };
    expect(errCode(ipc.createSale(lineWithPrice))).toBe("INVALID_INPUT");
    expect(countRows(db).sales).toBe(0);
    db.close();
  });

  it("rejects malformed money, quantities and methods", () => {
    const { db, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ expectedTotalMinor: 597 }, "INVALID_INPUT"], // a number, not a string
      [{ expectedTotalMinor: "5.97" }, "INVALID_INPUT"],
      [{ expectedTotalMinor: "-597" }, "INVALID_INPUT"],
      [{ expectedTotalMinor: "5e2" }, "INVALID_INPUT"],
      [{ expectedTotalMinor: "596" }, "TOTAL_MISMATCH"],
      [{ paymentMethod: "crypto" }, "INVALID_PAYMENT_METHOD"],
      [{ lines: [] }, "INVALID_INPUT"],
      // quantityMilli is an INTEGER count of thousandths: 1.5 of a thousandth is not a quantity.
      [{ lines: [{ productId: "prod-0003", quantityMilli: 1.5 }] }, "INVALID_INPUT"],
      [{ lines: [{ productId: "prod-0003", quantityMilli: "3000" }] }, "INVALID_INPUT"],
      // Was INVALID_QUANTITY from the domain; the IPC boundary now refuses the range itself.
      [{ lines: [{ productId: "prod-0003", quantityMilli: -3000 }] }, "INVALID_INPUT"],
      [{ lines: [{ productId: "prod-0003", quantityMilli: 9999001 }] }, "INVALID_INPUT"],
      [{ lines: [{ productId: "prod-0003", quantity: 3 }] }, "INVALID_INPUT"], // the old key is gone
      [{ lines: [{ productId: "x' OR 1=1 --", quantityMilli: 1000 }], expectedTotalMinor: "0" }, "UNKNOWN_PRODUCT"],
      [{ idempotencyKey: "short" }, "INVALID_INPUT"],
    ];
    for (const [patch, code] of cases) {
      expect(errCode(ipc.createSale({ ...goodSale(), ...patch })), JSON.stringify(patch)).toBe(code);
    }
    expect(errCode(ipc.createSale(null))).toBe("INVALID_INPUT");
    expect(errCode(ipc.createSale("DROP TABLE sales"))).toBe("INVALID_INPUT");
    expect(errCode(ipc.getTodaySales({ date: "2020-01-01" }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.getSaleHistory({ limit: 100000 }))).toBe("INVALID_INPUT");
    expect(countRows(db).sales).toBe(0);
    db.close();
  });

  it("an unexpected failure on a non-sale channel is generic and says nothing about sales", () => {
    const { db, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    db.close(); // force a non-domain error inside the service
    const r = ipc.getTodaySales(undefined);
    expect(r).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Unexpected error. Please try again; if it keeps happening, contact support." },
    });
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).not.toMatch(/sale/i);
  });

  it("createSale after an unexpected failure says NOT recorded only when the ledger has no such sale", () => {
    const { db, repository, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    // A failure BEFORE the commit: nothing is written.
    const commit = repository.commitSale.bind(repository);
    repository.commitSale = () => {
      throw new Error("disk exploded");
    };
    const failed = ipc.createSale(goodSale());
    expect(failed).toMatchObject({ ok: false, error: { code: "SALE_NOT_RECORDED" } });
    expect(countRows(db).sales).toBe(0);

    // A failure AFTER the commit (the sale is in the ledger): the answer must say so.
    const sale = goodSale();
    repository.commitSale = commit;
    const getSale = repository.getSale.bind(repository);
    let calls = 0;
    repository.getSale = (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("read-back exploded");
      return getSale(id);
    };
    const r = ipc.createSale(sale);
    expect(r).toMatchObject({ ok: false, error: { code: "SALE_RECORDED" } });
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toMatch(/WAS recorded \(receipt #1\)/);
    expect(countRows(db).sales).toBe(1);

    // Retrying the same attempt is safe: it returns the recorded sale, no second sale.
    repository.getSale = getSale;
    const retry = ipc.createSale(sale);
    expect(retry).toMatchObject({ ok: true, data: { duplicate: true, sale: { receiptNumber: 1 } } });
    expect(countRows(db).sales).toBe(1);
    db.close();
  });

  it("createSale reports 'unknown' when even the ledger lookup fails", () => {
    const { db, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    db.close();
    expect(ipc.createSale(goodSale())).toMatchObject({ ok: false, error: { code: "SALE_STATUS_UNKNOWN" } });
  });

  it("a product id at the import limit (77 chars) can be sold — import and sale share one limit", () => {
    const { db, service, ipc } = setup();
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    const sourceId = "x".repeat(64);
    const bytes = new TextEncoder().encode(
      `source_id,name_ar,name_en,price,currency,base_unit,price_needs_review\n${sourceId},مياه,,0.50,USD,piece,0\n`,
    );
    const imported = service.importCatalogCsv("c.csv", bytes);
    expect(imported.status).toBe("imported");
    const productId = `merchant-csv:${sourceId}`;
    expect(productId.length).toBe(77);
    const r = ipc.createSale({
      idempotencyKey: newKey(),
      lines: [{ productId, quantityMilli: 2000 }],
      paymentMethod: "cash",
      expectedTotalMinor: "100",
    });
    expect(r).toMatchObject({ ok: true, data: { sale: { lines: [{ productName: "مياه", quantityMilli: 2000, saleUnit: "piece" }] } } });
    // Longer than the shared limit is still refused as input.
    expect(
      ipc.createSale({ idempotencyKey: newKey(), lines: [{ productId: "y".repeat(129), quantityMilli: 1000 }], paymentMethod: "cash", expectedTotalMinor: "1" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    db.close();
  });
});
