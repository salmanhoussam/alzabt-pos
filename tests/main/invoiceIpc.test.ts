/**
 * The invoice IPC contract: what the renderer may ask for, what it may NOT send, and that nothing
 * loses precision crossing the boundary.
 *
 * The handlers are pure functions of an untrusted payload, so this runs without Electron.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNELS, type ChannelName } from "../../src/shared/ipcContract";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;

const ok = <T>(result: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data as T;
};
const errCode = (result: { ok: boolean; error?: { code: string } }) => (result.ok ? null : result.error!.code);

const PROFILE = {
  nameAr: "متجر اختباري",
  nameEn: "Test Store",
  legalName: null,
  tagline: null,
  address: "شارع الاختبار",
  phone1: "0000000",
  phone2: null,
  email: null,
  logoPath: null,
  taxpayerNumber: "TP-1",
  commercialRegister: "CR-2",
  vatNumber: "VAT-3",
  taxEnabled: false,
  taxRatePercent: null,
  taxLabel: null,
};

const LINE = {
  description: "صنف اختباري",
  unitLabel: "حبة",
  canonicalUnit: null,
  productId: null,
  quantity: "1",
  unitPrice: "474.40",
};

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { invoices: h.invoices }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("the invoice channels exist and answer", () => {
  it("every invoice channel has a handler", () => {
    const expected: ChannelName[] = [
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
    ];
    const handlers = createIpcHandlers(h.service, { invoices: h.invoices });
    for (const name of expected) {
      expect(CHANNELS[name]).toBe(`pos:${name}`);
      expect(typeof handlers[name]).toBe("function");
    }
  });

  it("printInvoice and saveInvoicePdf are the ONLY asynchronous channels", () => {
    // `syncHandlers` assumes exactly this. Asserting it keeps that assumption honest rather than
    // leaving a cast that would quietly hand a Promise to a caller expecting a result.
    const handlers = createIpcHandlers(h.service, { invoices: h.invoices });
    const async_: string[] = [];
    for (const name of Object.keys(handlers) as ChannelName[]) {
      if (name === "importCatalog" || name === "exportCatalog" || name === "exportBackup") continue;
      let result: unknown;
      try {
        result = handlers[name](undefined);
      } catch {
        continue;
      }
      if (result instanceof Promise) {
        async_.push(name);
        void (result as Promise<unknown>).catch(() => undefined);
      }
    }
    expect(async_.sort()).toEqual(["printInvoice", "saveInvoicePdf"]);
  });

  it("without the invoice service wired, every invoice channel says NOT_AVAILABLE", () => {
    const bare = syncHandlers(createIpcHandlers(h.service));
    expect(errCode(bare.getCompanyProfile(undefined))).toBe("NOT_AVAILABLE");
    expect(errCode(bare.createInvoiceDraft(undefined))).toBe("NOT_AVAILABLE");
    expect(errCode(bare.getInvoice({ invoiceId: "x" }))).toBe("NOT_AVAILABLE");
    expect(errCode(bare.finalizeInvoice({ invoiceId: "x" }))).toBe("NOT_AVAILABLE");
    expect(errCode(bare.listReconciliationQueue({ filter: "unresolved", limit: 50 }))).toBe("NOT_AVAILABLE");
    // Silently doing nothing would be the alternative, and the operator would never learn.
  });
});

describe("what the renderer cannot send", () => {
  it("rejects a finalize payload that tries to supply the totals or the number", () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    const view = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined));
    ok(ipc.addInvoiceLine({ invoiceId: view.invoice.id, line: LINE }));

    // 🔴 Extra keys are REFUSED, not ignored. A renderer that tried to assert the money is told no.
    for (const extra of [
      { invoiceId: view.invoice.id, total: "1" },
      { invoiceId: view.invoice.id, subtotalMinor: "1" },
      { invoiceId: view.invoice.id, invoiceNumber: 99 },
      { invoiceId: view.invoice.id, amountInWords: "فقط" },
      { invoiceId: view.invoice.id, status: "final" },
    ]) {
      expect(errCode(ipc.finalizeInvoice(extra))).toBe("INVALID_INPUT");
    }
    // The real call, with an id and nothing else, works.
    expect(ok<{ invoice: { invoiceNumber: number } }>(ipc.finalizeInvoice({ invoiceId: view.invoice.id })).invoice.invoiceNumber).toBe(1);
  });

  it("rejects a line payload carrying a line total", () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    expect(errCode(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, lineTotal: "47440" } }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, lineTotalMinor: "47440" } }))).toBe("INVALID_INPUT");
  });

  it("has no channel that writes a catalog row or sets a resolution status directly", () => {
    const names = Object.keys(CHANNELS);
    // The only product writes are the three product-screen channels that predate invoices; nothing
    // in the invoice set writes a product, and nothing accepts a status at all.
    expect(names.filter((n) => /^resolve/.test(n)).sort()).toEqual([
      "resolveCreateProduct",
      "resolveKeepCatalog",
      "resolveKeepInvoiceOnly",
      "resolveLinkProduct",
      "resolveUpdateCatalog",
    ]);
    expect(names.some((n) => /status|setReconcil|markResolved|setPrice|writeCatalog/i.test(n))).toBe(false);
  });

  it("resolveUpdateCatalog takes FIELD NAMES, never values, and refuses an unknown field", () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    const product = h.service.createProduct({ nameAr: "مفك", nameEn: null, sku: null, price: "5.00", baseUnit: "piece" });
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    ok(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, description: "مفك", unitPrice: "6.50" } }));
    ok(ipc.finalizeInvoice({ invoiceId: id }));
    const items = ok<Array<{ id: string }>>(ipc.listReconciliation({ invoiceId: id }));

    // A value the renderer invented is not even a legal payload shape.
    expect(
      errCode(
        ipc.resolveUpdateCatalog({
          reconciliationId: items[0]!.id,
          fields: ["selling_price_minor"],
          canonicalUnit: null,
          nameEn: null,
          sellingPriceMinor: "999999",
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      errCode(
        ipc.resolveUpdateCatalog({ reconciliationId: items[0]!.id, fields: ["is_active"], canonicalUnit: null, nameEn: null }),
      ),
    ).toBe("INVALID_INPUT");

    // The legal call reads the price from the frozen line — 6.50, not anything a payload claimed.
    ok(ipc.resolveUpdateCatalog({ reconciliationId: items[0]!.id, fields: ["selling_price_minor"], canonicalUnit: null, nameEn: null }));
    expect(h.service.listProducts().find((p) => p.id === product.id)!.selling_price_minor).toBe(650n);
  });

  it("refuses printing or saving a PDF of a draft", async () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    const handlers = createIpcHandlers(h.service, {
      invoices: h.invoices,
      printInvoice: async () => "printed",
      saveInvoicePdf: async () => ({ fileName: "x.pdf" }),
    });
    expect(errCode((await handlers.printInvoice({ invoiceId: id })) as { ok: boolean; error?: { code: string } })).toBe(
      "INVOICE_NOT_DRAFT",
    );
    expect(errCode((await handlers.saveInvoicePdf({ invoiceId: id })) as { ok: boolean; error?: { code: string } })).toBe(
      "INVOICE_NOT_DRAFT",
    );
  });

  it("print is unavailable rather than pretending when no printer path is wired", async () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    ok(ipc.addInvoiceLine({ invoiceId: id, line: LINE }));
    ok(ipc.finalizeInvoice({ invoiceId: id }));
    const handlers = createIpcHandlers(h.service, { invoices: h.invoices });
    expect(await handlers.printInvoice({ invoiceId: id })).toEqual({ ok: true, data: { status: "unavailable" } });
    expect(errCode((await handlers.saveInvoicePdf({ invoiceId: id })) as { ok: boolean; error?: { code: string } })).toBe(
      "NOT_AVAILABLE",
    );
  });
});

describe("precision across the boundary", () => {
  it("every scaled value crosses as a string of minor units", () => {
    ok(ipc.saveCompanyProfile({ ...PROFILE, taxEnabled: true, taxRatePercent: "11" }));
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    ok(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, quantity: "3", unitPrice: "2.50" } }));
    // The channel now takes a PATCH: only the keys that changed. Absent keys are left as stored.
    ok(ipc.updateInvoiceHeader({
      invoiceId: id,
      patch: { invoiceDate: "2026-10-08", customerName: "زبون", paid: "1.00" },
    }));
    const view = ok<{
      invoice: Record<string, unknown>;
      lines: Array<Record<string, unknown>>;
    }>(ipc.getInvoice({ invoiceId: id }));

    for (const key of ["subtotal", "tax", "total", "paid", "balanceDue"]) {
      const m = view.invoice[key] as { minor: unknown; currency: unknown };
      expect(typeof m.minor).toBe("string");
      expect(m.currency).toBe("USD");
    }
    expect(view.invoice.subtotal).toEqual({ minor: "750", currency: "USD" });
    // 750 * 1100 / 10000 = 82.5 -> 83, half up, in exact integers.
    expect(view.invoice.tax).toEqual({ minor: "83", currency: "USD" });
    expect(view.invoice.total).toEqual({ minor: "833", currency: "USD" });
    expect(view.invoice.balanceDue).toEqual({ minor: "733", currency: "USD" });

    const line = view.lines[0]!;
    expect(line.unitPrice).toEqual({ minor: "250", currency: "USD" });
    expect(line.lineTotal).toEqual({ minor: "750", currency: "USD" });
    // The quantity is a safe integer by schema (<= 9,999,000) and the formatted text travels with it.
    expect(line.quantityMilli).toBe(3000);
    expect(line.quantityText).toBe("3");
  });

  it("a very large amount reconstructs as the exact same bigint", () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    ok(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, quantity: "1000", unitPrice: "9000000000.00" } }));
    const view = ok<{ invoice: { subtotal: { minor: string } } }>(ipc.getInvoice({ invoiceId: id }));
    expect(view.invoice.subtotal.minor).toBe("900000000000000");
    expect(BigInt(view.invoice.subtotal.minor)).toBe(900_000_000_000_000n);

    // 🔴 Being precise about WHY the string form is used, because two tempting reasons are FALSE
    // and this comment exists so nobody re-derives them:
    //
    //   - It is NOT that a stored amount overflows a double. `MAX_MINOR` is 10^15, which is below
    //     Number.MAX_SAFE_INTEGER (~9.007 x 10^15).
    expect(900_000_000_000_000 < Number.MAX_SAFE_INTEGER).toBe(true);
    //   - It is NOT that a bigint cannot be cloned. Structured clone handles bigint fine.
    expect(structuredClone({ minor: 1n })).toEqual({ minor: 1n });
    //
    // The reason is the repository's stated convention (see the header of src/shared/ipcContract.ts),
    // and what makes that convention worth keeping: a string of digits is lossless through every
    // boundary this value ever crosses — IPC, a log line, a JSON file, DevTools — and it removes the
    // one representation a caller would otherwise reach for by habit. A `number` is the real hazard,
    // because the ARITHMETIC these amounts come from genuinely exceeds a double: this product is
    // exactly what migration 4's overflow bound exists for, and SQLite would silently yield a REAL
    // instead of raising.
    const widest = 9_999_000n * 922_429_446_630n;
    expect(widest > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(BigInt(Number(widest)) !== widest).toBe(true); // a double loses these digits
  });

  it("a reconciliation candidate's price crosses as digits too", () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    h.service.createProduct({ nameAr: "مفك", nameEn: null, sku: null, price: "5.00", baseUnit: "piece" });
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    ok(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, description: "مفك", unitPrice: "6.50" } }));
    ok(ipc.finalizeInvoice({ invoiceId: id }));
    const items = ok<
      Array<{
        candidates: Array<{ sellingPriceMinor: unknown }>;
        differences: Array<{ invoice: string; catalog: string | null; comparable: boolean }>;
        line: { lineTotal: { minor: string } } | null;
      }>
    >(ipc.listReconciliation({ invoiceId: id }));

    expect(typeof items[0]!.candidates[0]!.sellingPriceMinor).toBe("string");
    expect(items[0]!.candidates[0]!.sellingPriceMinor).toBe("500");
    expect(items[0]!.differences[0]).toEqual({
      field: "selling_price_minor",
      invoice: "650",
      catalog: "500",
      comparable: true,
    });
    // The FROZEN line travels with the item, so the panel never re-reads today's catalog for it.
    expect(items[0]!.line!.lineTotal.minor).toBe("650");
  });
});

describe("the company profile across the boundary", () => {
  it("saves and reloads, keeping the three identifiers separate", () => {
    const saved = ok<Record<string, unknown>>(ipc.saveCompanyProfile(PROFILE));
    expect(saved.taxpayerNumber).toBe("TP-1");
    expect(saved.commercialRegister).toBe("CR-2");
    expect(saved.vatNumber).toBe("VAT-3");
    expect(ok<Record<string, unknown>>(ipc.getCompanyProfile(undefined))).toMatchObject({
      nameAr: "متجر اختباري",
      taxpayerNumber: "TP-1",
      commercialRegister: "CR-2",
      vatNumber: "VAT-3",
      taxEnabled: false,
      taxRatePercent: "0",
      nextInvoiceNumber: 1,
    });
  });

  it("reports null before anything has been saved", () => {
    expect(ok<unknown>(ipc.getCompanyProfile(undefined))).toBeNull();
  });

  it("round-trips the tax rate as the plain percentage the form re-submits", () => {
    for (const [percent, expected] of [["11", "11"], ["11.5", "11.5"], ["0", "0"]] as const) {
      const saved = ok<{ taxRatePercent: string; taxEnabled: boolean }>(
        ipc.saveCompanyProfile({ ...PROFILE, taxEnabled: true, taxRatePercent: percent }),
      );
      expect(saved.taxEnabled).toBe(true);
      expect(saved.taxRatePercent).toBe(expected);
    }
  });

  it("refuses an unknown profile field rather than ignoring it", () => {
    expect(errCode(ipc.saveCompanyProfile({ ...PROFILE, nextInvoiceNumber: 500 }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.saveCompanyProfile({ ...PROFILE, taxRateBp: 1100 }))).toBe("INVALID_INPUT");
  });

  it("a later profile change does not alter a finalized invoice's frozen issuer", () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    ok(ipc.addInvoiceLine({ invoiceId: id, line: LINE }));
    ok(ipc.finalizeInvoice({ invoiceId: id }));

    ok(ipc.saveCompanyProfile({ ...PROFILE, nameAr: "اسم جديد", phone1: "9999999", vatNumber: "VAT-NEW" }));

    const reopened = ok<{ invoice: { issuer: Record<string, unknown> } }>(ipc.getInvoice({ invoiceId: id }));
    expect(reopened.invoice.issuer).toMatchObject({
      nameAr: "متجر اختباري",
      phone1: "0000000",
      vatNumber: "VAT-3",
    });
    // The live profile really did change — the snapshot simply is not a reference to it.
    expect(ok<{ nameAr: string }>(ipc.getCompanyProfile(undefined)).nameAr).toBe("اسم جديد");
  });
});

describe("history and the queue across the boundary", () => {
  it("lists, searches and opens by number", () => {
    ok(ipc.saveCompanyProfile({ ...PROFILE }));
    const ids = ["1.00", "2.00"].map((price) => {
      const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
      ok(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, unitPrice: price } }));
      ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerName: `زبون ${price}` } }));
      ok(ipc.finalizeInvoice({ invoiceId: id }));
      return id;
    });

    expect(ok<Array<{ invoiceNumber: number }>>(ipc.listInvoices({ term: null, limit: 50 })).map((i) => i.invoiceNumber)).toEqual([2, 1]);
    expect(ok<Array<{ id: string }>>(ipc.searchInvoices({ term: "زبون 1.00", limit: 50 })).map((i) => i.id)).toEqual([ids[0]]);
    const byNumber = ok<{ invoice: { id: string; status: string } } | null>(ipc.findInvoiceByNumber({ invoiceNumber: 2 }));
    expect(byNumber!.invoice.id).toBe(ids[1]);
    expect(byNumber!.invoice.status).toBe("final");
    expect(ok<unknown>(ipc.findInvoiceByNumber({ invoiceNumber: 999 }))).toBeNull();
    expect(errCode(ipc.findInvoiceByNumber({ invoiceNumber: 0 }))).toBe("INVALID_INPUT");
  });

  it("filters the queue and reports the counts", () => {
    ok(ipc.saveCompanyProfile(PROFILE));
    h.service.createProduct({ nameAr: "مفك", nameEn: null, sku: null, price: "5.00", baseUnit: "piece" });
    const id = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined)).invoice.id;
    ok(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, description: "مفك", unitPrice: "6.50" } }));
    ok(ipc.addInvoiceLine({ invoiceId: id, line: { ...LINE, description: "مجهول", unitPrice: "1.00" } }));
    ok(ipc.finalizeInvoice({ invoiceId: id }));

    const unresolved = ok<{ items: unknown[]; unresolved: number; byStatus: Record<string, number> }>(
      ipc.listReconciliationQueue({ filter: "unresolved", limit: 50 }),
    );
    expect(unresolved.items).toHaveLength(2);
    expect(unresolved.unresolved).toBe(2);

    const items = ok<Array<{ id: string; classification: string }>>(ipc.listReconciliation({ invoiceId: id }));
    ok(ipc.resolveKeepCatalog({ reconciliationId: items.find((i) => i.classification === "PRICE_DIFFERENCE")!.id }));

    expect(ok<{ items: unknown[] }>(ipc.listReconciliationQueue({ filter: "unresolved", limit: 50 })).items).toHaveLength(1);
    expect(ok<{ items: unknown[] }>(ipc.listReconciliationQueue({ filter: "resolved", limit: 50 })).items).toHaveLength(1);
    expect(ok<{ items: unknown[] }>(ipc.listReconciliationQueue({ filter: "failed", limit: 50 })).items).toHaveLength(0);
    expect(ok<{ items: unknown[] }>(ipc.listReconciliationQueue({ filter: "all", limit: 50 })).items).toHaveLength(2);
    expect(errCode(ipc.listReconciliationQueue({ filter: "everything", limit: 50 }))).toBe("INVALID_INPUT");
  });
});

describe("the preload bridge exposes every channel, and nothing else", () => {
  // Read as source rather than imported: the preload may only require "electron", so it cannot be
  // loaded in a Node test. The compiler already pins its channel STRINGS to the contract
  // (`satisfies typeof CHANNELS`); what no compiler can check is whether a channel that exists in
  // the contract and has a handler was ever actually WIRED into the object the renderer receives.
  // A channel missing from that object is a dead channel — reachable from main, unreachable from the
  // UI, and silent about it.
  const preload = readFileSync(join(__dirname, "..", "..", "src", "preload", "preload.ts"), "utf8");

  it("every channel in the contract is bridged into the api object", () => {
    const api = /const api: PosApi = \{([\s\S]*?)\n\};/.exec(preload);
    expect(api).not.toBeNull();
    const body = api![1]!;
    const missing = (Object.keys(CHANNELS) as ChannelName[]).filter((name) => !new RegExp(`\\b${name}:`).test(body));
    expect(missing).toEqual([]);
  });

  it("the bridge hands the renderer no ipcRenderer, no channel map and no generic invoke", () => {
    expect(preload).toContain("contextBridge.exposeInMainWorld(\"pos\", Object.freeze(api))");
    // Only the one frozen api object crosses. Nothing else is exposed under any name.
    expect([...preload.matchAll(/exposeInMainWorld\(/g)]).toHaveLength(1);
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*["'](?!pos["'])/);
    // No pass-through that would let a caller name its own channel.
    expect(preload).not.toMatch(/invoke\(\s*(channel|name|arguments|\.\.\.)/);
  });

  it("every invoice payload is rebuilt key by key rather than forwarded whole", () => {
    // 🔴 `createSale` forwards its request object (it predates this rule and its handler validates
    // exactly); every invoice bridge method below names its fields, so a caller cannot smuggle an
    // extra key through the bridge even before `exactObject` refuses it in the handler.
    for (const [method, field] of [
      ["saveCompanyProfile", "taxpayerNumber: req.taxpayerNumber"],
      // 🔴 WAS "paid: req.paid", when the bridge listed all six header fields unconditionally.
      // That is exactly what had to go: naming every key turned an untouched field into an explicit
      // null. The bridge now copies only the keys the caller set, and `headerPatch` is the function
      // that does it — still key by key, still nothing forwarded whole.
      ["updateInvoiceHeader", "patch: headerPatch(req.patch)"],
      ["resolveCreateProduct", "baseUnit: req.baseUnit"],
      ["resolveUpdateCatalog", "fields: [...req.fields]"],
      ["finalizeInvoice", "{ invoiceId: req.invoiceId }"],
      ["printInvoice", "{ invoiceId: req.invoiceId }"],
    ] as const) {
      expect(preload).toContain(field);
      expect(preload).toContain(`${method}:`);
    }
  });
});
