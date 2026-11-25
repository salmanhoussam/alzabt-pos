import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../src/shared/ipcContract";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import { makeHarness, tempDir } from "../helpers/harness";
import { DEMO_CHANNEL_POLICY, installDemoSessionBlockers, installDemoWebRequestBlocker, invokeWithDemoPolicy, restrictDemoIpcOptions, isDemoChannelAllowed, isDemoWebRequestAllowed } from "../../src/main/demoPolicy";

const allNames = Object.keys(CHANNELS).sort();
const prohibited = [
  "login", "logout", "completeBootstrapSetup", "listOperators", "createOperator", "resetOperatorPin",
  "importCatalog", "exportCatalog", "exportOnlineCatalog", "exportBackup", "exportFullBackup",
  "inspectRestoreBackup", "applyRestore", "pickInvoiceLogo", "setProductImage", "readInvoicePhoto",
  "startPhoneSession", "cancelPhoneSession", "phoneSessionState",
  "printAdvance", "printAdvanceRefund", "printCollectionReceipt",
  "saveInvoicePdf", "saveAdvancePdf", "saveAdvanceRefundPdf", "saveCollectionReceiptPdf", "saveSaleReceiptPdf",
];

describe("future Demo IPC policy; no Demo mode is activated by X1", () => {
  it("classifies every current channel exactly once and has no stale names", () => {
    expect(Object.keys(DEMO_CHANNEL_POLICY).sort()).toEqual(allNames);
    expect(new Set(Object.values(DEMO_CHANNEL_POLICY))).toEqual(new Set(["allow", "deny"]));
  });
  it("refuses all restricted exits before their handlers run", () => {
    for (const name of prohibited) {
      expect(allNames).toContain(name);
      const invoke = vi.fn(() => ({ ok: true }));
      expect(invokeWithDemoPolicy("demo", name, invoke)).toEqual({
        ok: false, error: { code: "DEMO_RESTRICTED", message: "This operation is unavailable in demo mode." },
      });
      expect(invoke).not.toHaveBeenCalled();
    }
  });
  it("permits daily workflow channels only through their existing handlers", () => {
    for (const name of ["getCatalog", "createSale", "getSaleHistory", "getSaleReceipt", "getInvoice", "finalizeInvoice", "getProductImageBytes"]) {
      const invoke = vi.fn(() => ({ ok: false, error: { code: "NOT_LOGGED_IN", message: "Sign in first" } }));
      expect(invokeWithDemoPolicy("demo", name, invoke)).toEqual({ ok: false, error: { code: "NOT_LOGGED_IN", message: "Sign in first" } });
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects unknown names, prototype keys and invalid modes", () => {
    for (const name of ["__proto__", "constructor", "toString", "newUnclassifiedChannel", ""]) {
      const invoke = vi.fn();
      expect(isDemoChannelAllowed(name)).toBe(false);
      expect(invokeWithDemoPolicy("demo", name, invoke)).toMatchObject({ ok: false });
      expect(invoke).not.toHaveBeenCalled();
    }
    for (const mode of [undefined, null, true, "DEMO", "", { mode: "real" }]) {
      const invoke = vi.fn();
      expect(invokeWithDemoPolicy(mode, "getCatalog", invoke)).toMatchObject({ ok: false });
      expect(invoke).not.toHaveBeenCalled();
    }
  });
  it("applies Demo refusal before real handlers, both with and without a synthetic session", () => {
    for (const login of [false, true]) {
      const t = tempDir();
      const h = makeHarness(t.dbPath, { login });
      try {
        const exportBackup = vi.fn(() => ({ fileName: "synthetic" }));
        const handlers = createIpcHandlers(h.service, { exportBackup });
        const backupHandler = vi.fn(() => handlers.exportBackup(undefined));
        expect(invokeWithDemoPolicy("demo", "exportBackup", backupHandler)).toMatchObject({
          ok: false, error: { code: "DEMO_RESTRICTED" },
        });
        expect(backupHandler).not.toHaveBeenCalled();
        expect(exportBackup).not.toHaveBeenCalled();
        const catalog = invokeWithDemoPolicy("demo", "getCatalog", () => handlers.getCatalog(undefined));
        expect(catalog).toMatchObject(login ? { ok: true } : { ok: false, error: { code: "NOT_LOGGED_IN" } });
      } finally {
        h.db.close();
        t.cleanup();
      }
    }
  });
  it("preserves all existing real-mode handler behavior, including real refusals", () => {
    for (const name of allNames) {
      const result = { ok: false, error: { code: "FORBIDDEN", message: "original" } };
      const invoke = vi.fn(() => result);
      expect(invokeWithDemoPolicy("real", name, invoke)).toBe(result);
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });
});

describe("future Demo webRequest primitive", () => {
  it("denies network and file URLs, including local endpoints, without leaking paths", () => {
    for (const url of ["http://127.0.0.1/x", "https://example.invalid/", "ws://localhost/", "wss://example.invalid/", "file:///C:/private/x", "ftp://example.invalid/", "invalid", ""]) {
      expect(isDemoWebRequestAllowed(url)).toBe(false);
    }
    expect(isDemoWebRequestAllowed("data:text/plain,synthetic")).toBe(true);
    expect(isDemoWebRequestAllowed("blob:null/synthetic")).toBe(true);
  });
  it("installs the callback independently on each explicitly supplied session", () => {
    type Listener = (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void;
    const listeners: Listener[] = [];
    const sessionA = { onBeforeRequest: (listener: Listener) => listeners.push(listener) };
    const sessionB = { onBeforeRequest: (listener: Listener) => listeners.push(listener) };
    installDemoWebRequestBlocker(sessionA);
    installDemoWebRequestBlocker(sessionB);
    expect(listeners).toHaveLength(2);
    for (const listener of listeners) {
      const reply = vi.fn();
      listener({ url: "https://example.invalid/" }, reply);
      expect(reply).toHaveBeenCalledWith({ cancel: true });
      listener({ url: "data:text/plain,synthetic" }, reply);
      expect(reply).toHaveBeenLastCalledWith({ cancel: false });
    }
  });
  it("guards known and later-created sessions without replacing the hook twice", () => {
    type Listener = (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void;
    const first = { webRequest: { onBeforeRequest: vi.fn((_listener: Listener) => undefined) } };
    const later = { webRequest: { onBeforeRequest: vi.fn((_listener: Listener) => undefined) } };
    let onCreated: ((session: typeof first) => void) | undefined;
    const events = { on: (_event: "session-created", fn: (session: typeof first) => void) => { onCreated = fn; } };
    installDemoSessionBlockers(events, [first]);
    expect(first.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(onCreated).toBeDefined();
    onCreated!(first);
    onCreated!(later);
    onCreated!(later);
    expect(first.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(later.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
  });

});

it("allows only synthetic company text edits with the fixed logo and tax disabled", () => {
  const good = {logoPath:"synthetic-demo-logo.png", taxEnabled:false, legalName:null,
    taxpayerNumber:null, commercialRegister:null, vatNumber:null, taxLabel:null, taxRatePercent:"0"};
  const invoke=vi.fn(()=>({ok:true}));
  expect(invokeWithDemoPolicy("demo","saveCompanyProfile",invoke,good)).toEqual({ok:true});
  for(const bad of [undefined, {...good,logoPath:"../private.png"}, {...good,logoPath:null},
    {...good,taxEnabled:true}, {...good,vatNumber:"real-like"}, {...good,legalName:"changed"}]) {
    const blocked=vi.fn();
    expect(invokeWithDemoPolicy("demo","saveCompanyProfile",blocked,bad)).toMatchObject({ok:false});
    expect(blocked).not.toHaveBeenCalled();
  }
  expect(invokeWithDemoPolicy("demo","getDailyMoney",invoke)).toEqual({ok:true});
});

it("never forwards external callbacks or the post-sale backup hook to Demo handlers",()=>{
  const effect=vi.fn();
  const restricted=restrictDemoIpcOptions({
    afterSale:effect, pickCatalogFile:effect, saveCatalogExport:effect,
    exportBackup:effect, exportOnlineCatalog:effect, pickInvoiceLogo:effect,
    pickProductPhoto:effect, readInvoicePhoto:effect, printInvoice:effect,
    saveInvoicePdf:effect, printAdvance:effect, printAdvanceRefund:effect,
    printCollectionReceipt:effect, printSaleReceipt:effect, saveAdvancePdf:effect,
    saveAdvanceRefundPdf:effect, saveCollectionReceiptPdf:effect, saveSaleReceiptPdf:effect,
  });
  for (const key of ["afterSale","pickCatalogFile","saveCatalogExport","exportBackup",
    "exportOnlineCatalog","pickInvoiceLogo","pickProductPhoto","readInvoicePhoto",
    "printInvoice","saveInvoicePdf","printAdvance","printAdvanceRefund","printCollectionReceipt",
    "printSaleReceipt","saveAdvancePdf","saveAdvanceRefundPdf","saveCollectionReceiptPdf","saveSaleReceiptPdf"])
    expect(restricted).not.toHaveProperty(key);
  expect(effect).not.toHaveBeenCalled();
});
