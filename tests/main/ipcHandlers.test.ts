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

/**
 * The same harness with a real operator-language setting.
 *
 * 🔴 `setup()` passes NO settings, and that is now load-bearing rather than incidental: with no
 * settings the handlers fall back to `DEFAULT_TERMINAL_LANGUAGE`, which is Arabic — the product's
 * real default. So the unexpected-error assertions in `setup()`-based tests are Arabic on purpose,
 * and this helper is how the English half is proven.
 */
function setupIn(lang: "ar" | "en") {
  const h = makeHarness(t.dbPath, { login: false });
  const settings = {
    get: () => ({ terminalLanguage: lang, receiptLanguage: lang }) as const,
    setTerminalLanguage: () => ({ terminalLanguage: lang, receiptLanguage: lang }) as const,
  };
  return { ...h, ipc: syncHandlers(createIpcHandlers(h.service, { settings })) };
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
  // channels listed below the blank line. Operator accounts (migration 8) took it to FIFTY-THREE.
  //
  // 🔴 TRANSITION — FIFTY-THREE to SIXTY-THREE with Product Master (migration 9). The ten added:
  // listCategories, listBrands, createCategory, renameCategory, setCategoryActive, deleteCategory,
  // getProductImageMeta, getProductImageBytes, setProductImage, removeProductImage.
  //
  // 🔴 TRANSITION — SIXTY-FOUR to SIXTY-SIX with the phone LAN bridge (slice H1). The two added:
  // startPhoneSession, cancelPhoneSession. The old value was 64 and is named rather than replaced.
  //
  // 🔴 AND WHAT IS STILL ABSENT IS AGAIN THE POINT. H1 opens this product's first inbound network
  // surface, and the obvious channels to add — one that returns the session TOKEN, one that lets
  // the renderer choose a port or an address, one that proxies a request from the phone to a named
  // service method — are NOT here. `startPhoneSession` names an action; main owns the token, the
  // port, the address and the socket, and the phone's own surface answers exactly one route.
  //
  // 🔴 AND WHAT IS STILL ABSENT IS THE POINT OF THE TRANSITION. Product Master stores PHOTOS, and
  // the obvious channel to add — one that takes image bytes from the renderer — is NOT here.
  // `setProductImage` names a product and nothing else; main runs the picker, reads the file and
  // normalizes it, exactly as `pickInvoiceLogo` does. So the rule below still holds unbroken: no
  // channel accepts a filesystem path, and none accepts a blob.
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
        // 🔴 S1B adds five CUSTOMER channels and no supplier one. Listed here by name, with every
        // earlier entry untouched, because this list failing on each addition is what proves no
        // channel was added without a reviewer seeing it.
        "createCustomer",
        "getCustomer",
        "searchCustomers",
        "setCustomerActive",
        "updateCustomerContact",
        // 🔴 S3B adds exactly ONE, and it is a READ. There is still no channel here that posts an
        // obligation, records a settlement or sets a balance — the renderer cannot write money at
        // all, which is why this list is the right place to notice if that ever changes.
        "getCustomerStatement",
        // TRANSITION with M17B-S1: one more name in the closed list — owner-only, shares ONE real external receipt.
        "recordAllocatedReceipt",
        "recordCustomerPayment",
        "createCategory",
        "createSale",
        "currentCashier",
        "exportBackup",
        "exportCatalog",
        // Slice G3. An OWNER channel; it names no path in either direction.
        "exportOnlineCatalog",
        "getAppInfo",
        "getCatalog",
        "getSaleHistory",
        "getProductImageBytes",
        "getProductImageMeta",
        "getSettings",
        "getTodaySales",
        "importCatalog",
        "listBrands",
        "listCashiers",
        "listCategories",
        "listProducts",
        "login",
        "logout",
        "createProduct",
        "setCategoryActive",
        "setProductActive",
        "setProductImage",
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
        // Added 2026-10-10 with the multi-row invoice sheet: several typed rows in ONE
        // transaction. The list stays EXHAUSTIVE on purpose — this assertion exists to catch a
        // channel nobody meant to expose, so a new one is declared here deliberately.
        "addInvoiceLines",
        // Added 2026-10-10 by migration 8 — operator accounts. The list stays EXHAUSTIVE: it
        // exists to catch a channel nobody meant to expose, so each new one is declared here
        // deliberately. `completeBootstrapSetup` is the only PUBLIC one of the seven.
        "completeBootstrapSetup",
        "createOperator",
        "listOperators",
        "renameCategory",
        "renameOperator",
        "resetOperatorPin",
        "setOperatorActive",
        "setOperatorMayCreateProducts",
        "setOperatorRole",
        "updateInvoiceLine",
        "removeInvoiceLine",
        "removeProductImage",
        "deleteCategory",
        "discardInvoiceDraft",
        "finalizeInvoice",
        "listInvoices",
        "listInvoiceDrafts",
        "findInvoiceByNumber",
        "searchInvoices",
        "setInvoiceTax",
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
        "startPhoneSession",
        "cancelPhoneSession",
        "phoneSessionState",
        // 🔴 Track 2 phase 3: full backup and restore, all owner-only. None takes a path: main runs
        // the pickers and stages only the package IT previewed.
        "exportFullBackup",
        "inspectRestoreBackup",
        "applyRestore",
      ].sort(),
    );
    // 45 -> 46 (addInvoiceLines) -> 53 (operator accounts, migration 8) -> 63 (Product Master,
    // migration 9) -> 64 (exportOnlineCatalog, slice G3 — the old value is named, not replaced)
    // -> 66 (slice H1: startPhoneSession, cancelPhoneSession)
    // -> 67 (slice H2: phoneSessionState — the dialog's poll; see ipcContract for why it is not
    //        named "...Status", which invoiceIpc.test.ts forbids on purpose)
    // -> 68 (migration 11: setOperatorMayCreateProducts — the owner grants one cashier the
    //        narrow right to add products; see channelPolicy for why it is owner-only itself)
    // 🔴 TRANSITION — SIXTY-EIGHT to SEVENTY-THREE with the customer directory (slice S1B). The
    // five added: searchCustomers, getCustomer, createCustomer, updateCustomerContact,
    // setCustomerActive. The old value was 68 and is named rather than replaced. They are
    // CUSTOMER-only: there is deliberately no supplier channel and no `kind` parameter, so the
    // supplier half of PartyService is unreachable from the renderer.
    // 🔴 TRANSITION — SEVENTY-THREE to SEVENTY-FOUR with the account statement (slice S3B). The
    // one added: getCustomerStatement. The old value was 73 and is named rather than replaced. It
    // is a READ, owner-classified.
    // 🔴 TRANSITION — SEVENTY-FOUR to SEVENTY-FIVE with owner cash collection (slice S3C). The one
    // added: recordCustomerPayment. The old value was 74. It is this bridge's FIRST money write,
    // owner-classified, and it can only SETTLE an existing obligation — there is still no channel
    // anywhere here that creates one.
    // 🔴 TRANSITION — SEVENTY-FIVE to SEVENTY-SIX with M17B-S1. The one added: recordAllocatedReceipt,
    // an owner-only money write that shares ONE real external receipt across two or more debts of one
    // customer. The old value was 75.
    // 🔴 TRANSITION — SEVENTY-SIX to SEVENTY-NINE with Track 2 phase 3 (full backup and restore).
    // The three added: exportFullBackup, inspectRestoreBackup, applyRestore — owner-only, and
    // refused again by PosService.assertOwner. The old value was 76.
    expect(CHANNEL_NAMES).toHaveLength(79);
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
    // 🔴 TRANSITION, migration 8. This returned the CashierDto directly. `login` now answers one
    // of TWO outcomes, because a legacy bootstrap credential yields a setup ticket and NO session —
    // so the session case is tagged rather than being the only possible shape. Old value:
    // `data: { id: "cashier-02", name: "Cashier Two" }`.
    // 🔴 THE OWNER, NOT CASHIER TWO. This flow ends in a VOID, and voiding is an owner-only
    // channel since migration 8 — reversing money is not a till operator's decision. Signing in as
    // a cashier here would now be refused with NOT_AUTHORIZED, which is the feature working.
    expect(ipc.login({ cashierId: "cashier-01", pin: "1111" })).toEqual({
      ok: true,
      // 🔴 `mayCreateProducts` JOINED THE SESSION SHAPE WITH MIGRATION 11 — convenience for the
      // Products screen, never authority. True here because this session is the owner, who may
      // always. The old shape was { id, name, role }.
      data: {
        status: "session",
        cashier: { id: "cashier-01", name: "Cashier One", role: "owner", mayCreateProducts: true },
      },
    });

    const created = ipc.createSale(goodSale());
    if (!created.ok) throw new Error(JSON.stringify(created));
    const sale = (created.data as { sale: { id: string; total: unknown; cashierId: string } }).sale;
    expect(sale.total).toEqual({ minor: "597", currency: "USD" });
    // Follows the login above, which is now the OWNER because this flow voids.
    expect(sale.cashierId).toBe("cashier-01");

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
    // 🔴 TRANSITION. This asserted the English sentence verbatim:
    //   "Unexpected error. Please try again; if it keeps happening, contact support."
    // That exact string is preserved and is still asserted — in `setupIn("en")` below and in
    // tests/main/saleOutcomeText.test.ts. What changed is that a terminal with NO settings reads
    // the product's real default language, Arabic, instead of English.
    expect(r).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "حدث خطأ غير متوقّع. حاول مرّة أخرى، وإذا تكرّر الأمر فاتّصل بالدعم." },
    });
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).not.toMatch(/sale/i);
    expect(r.error.message).not.toContain("فاتورة");
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
    // 🔴 TRANSITION. This asserted /WAS recorded \(receipt #1\)/ — the English wording, which is
    // preserved and asserted in the English test below. Here, with no settings, the till is Arabic;
    // what must survive the translation is the REAL receipt number and the do-not-repeat
    // instruction, so both are asserted rather than the prose.
    expect(r.error.message).toContain("إيصال رقم 1");
    expect(r.error.message).toContain("لا تُعِد إدخالها");
    expect(r.error.message).not.toContain("يمكنك إعادة المحاولة");
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The sale-outcome sentences ON THE WIRE, in both languages.
  //
  // 🔴 WHY THESE EXIST ALONGSIDE tests/main/saleOutcomeText.test.ts. That file proves the SENTENCES
  // are right. These prove the right sentence actually reaches the renderer through the real
  // channel, carrying the real receipt number off the real row — the seam where a wiring mistake
  // (the wrong language read, the receipt number lost, the code and the text drifting apart) would
  // live. A pure-function test cannot see any of those.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("🔴 an ENGLISH till still reads the exact English sentences that shipped", () => {
    const { db, repository, ipc } = setupIn("en");
    ipc.login({ cashierId: "cashier-01", pin: "1111" });

    // A failure before the commit.
    const commit = repository.commitSale.bind(repository);
    repository.commitSale = () => {
      throw new Error("disk exploded");
    };
    expect(ipc.createSale(goodSale())).toEqual({
      ok: false,
      error: { code: "SALE_NOT_RECORDED", message: "Unexpected error \u2014 the sale was not recorded. You can try again." },
    });

    // A failure after the commit: the receipt number must survive onto the wire.
    repository.commitSale = commit;
    const getSale = repository.getSale.bind(repository);
    let calls = 0;
    repository.getSale = (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("read-back exploded");
      return getSale(id);
    };
    expect(ipc.createSale(goodSale())).toEqual({
      ok: false,
      error: {
        code: "SALE_RECORDED",
        message:
          "The sale WAS recorded (receipt #1) but an unexpected error followed. Check History \u2014 do not ring it up again.",
      },
    });
    repository.getSale = getSale;
    db.close();
  });

  it("🔴 an ARABIC till reads Arabic, with the SAME codes and the SAME real receipt number", () => {
    const { db, repository, ipc } = setupIn("ar");
    ipc.login({ cashierId: "cashier-01", pin: "1111" });

    const commit = repository.commitSale.bind(repository);
    repository.commitSale = () => {
      throw new Error("disk exploded");
    };
    const notRecorded = ipc.createSale(goodSale());
    expect(errCode(notRecorded)).toBe("SALE_NOT_RECORDED");
    if (notRecorded.ok) throw new Error("unreachable");
    expect(notRecorded.error.message).toContain("لم تُسجَّل الفاتورة");
    expect(notRecorded.error.message).toContain("يمكنك إعادة المحاولة");
    expect(notRecorded.error.message).not.toMatch(/[A-Za-z]/);

    repository.commitSale = commit;
    const getSale = repository.getSale.bind(repository);
    let calls = 0;
    repository.getSale = (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("read-back exploded");
      return getSale(id);
    };
    const recorded = ipc.createSale(goodSale());
    expect(errCode(recorded)).toBe("SALE_RECORDED");
    if (recorded.ok) throw new Error("unreachable");
    // 🔴 THE NUMBER IS THE LEDGER'S, NOT A GUESS. Each test opens its own harness, so this is the
    // first committed sale and its receipt is 1 — the same row the retry below returns.
    expect(recorded.error.message).toContain("إيصال رقم 1");
    expect(recorded.error.message).toContain("لا تُعِد إدخالها");
    expect(recorded.error.message).not.toContain("يمكنك إعادة المحاولة");
    repository.getSale = getSale;
    db.close();
  });

  it("🔴 a settings store that THROWS does not cost the cashier the truth about their sale", () => {
    const h = makeHarness(t.dbPath, { login: false });
    const ipc = syncHandlers(
      createIpcHandlers(h.service, {
        settings: {
          get: () => {
            throw new Error("settings.json is unreadable");
          },
          setTerminalLanguage: () => ({ terminalLanguage: "ar", receiptLanguage: "ar" }) as const,
        },
      }),
    );
    ipc.login({ cashierId: "cashier-01", pin: "1111" });
    h.db.close();
    const r = ipc.createSale(goodSale());
    // Still a truthful, readable answer — in the default language — rather than a thrown error.
    expect(errCode(r)).toBe("SALE_STATUS_UNKNOWN");
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toContain("راجع السجلّ");
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
