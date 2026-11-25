/**
 * Restricted-mode policy for a FUTURE trusted Demo process.
 *
 * X1 DOES NOT create or select a Demo profile, issue sessions, activate a mode,
 * install the web request hook, or establish filesystem/network isolation.
 * The application currently supplies only "real" at the IPC call site.
 * Any future use of "demo" must be bound to the separately reviewed main-owned
 * lifecycle before database opening; renderer, environment and argv do not
 * authorize it. Existing service authorization still applies after this guard.
 */
import { SYNTHETIC_DEMO_LOGO } from "./demoConstants";
import type { ChannelName, IpcResult } from "../shared/ipcContract";
import type { IpcHandlerOptions } from "./ipcHandlers";

export type DemoDecision = "allow" | "deny";

/** Every existing channel has an explicit decision; a new one fails typecheck. */
export const DEMO_CHANNEL_POLICY = Object.freeze({
  listCashiers: "deny",
  login: "deny",
  // Do not strand a Demo operator at a login screen that Demo policy denies.
  // A separately reviewed main-owned exit flow must close the session instead.
  logout: "deny",
  completeBootstrapSetup: "deny",
  // O-1 Phase 1: the Demo's accounts are seeded by main (demoSeedAccounts → enrollOwner in-process); the renderer
  // never enrolls an owner in Demo.
  enrollOwner: "deny",
  listOperators: "deny",
  createOperator: "deny",
  renameOperator: "deny",
  resetOperatorPin: "deny",
  setOperatorActive: "deny",
  setOperatorRole: "deny",
  setOperatorMayCreateProducts: "deny",
  currentCashier: "allow",
  getEntryState: "allow",
  getCatalog: "allow",
  createSale: "allow",
  createCustomerCreditSale: "deny",
  createSplitSale: "deny",
  voidSale: "deny",
  getTodaySales: "allow",
  getSaleHistory: "allow",
  importCatalog: "deny",
  exportCatalog: "deny",
  exportOnlineCatalog: "deny",
  exportBackup: "deny",
  exportFullBackup: "deny",
  inspectRestoreBackup: "deny",
  applyRestore: "deny",
  getAppInfo: "allow",
  listProducts: "allow",
  createProduct: "allow",
  updateProduct: "allow",
  setProductActive: "deny",
  listCategories: "allow",
  listBrands: "allow",
  createCategory: "allow",
  searchCustomers: "deny",
  getCustomer: "deny",
  createCustomer: "deny",
  updateCustomerContact: "deny",
  setCustomerActive: "deny",
  getCustomerStatement: "deny",
  recordCustomerPayment: "deny",
  recordAllocatedReceipt: "deny",
  renameCategory: "deny",
  setCategoryActive: "deny",
  deleteCategory: "deny",
  getProductImageMeta: "allow",
  getProductImageBytes: "allow",
  setProductImage: "deny",
  removeProductImage: "deny",
  startPhoneSession: "deny",
  cancelPhoneSession: "deny",
  phoneSessionState: "deny",
  getSettings: "allow",
  setTerminalLanguage: "allow",
  // M5: a Demo visitor may switch the indicative display (its own profile's settings); never the owner's rate.
  setDisplayCurrency: "allow",
  // TRANSITION (owner R5 preview, 2026-11-25): was "deny". F8 makes LBP display require an owner-CONFIRMED rate,
  // so a Demo that could not set one could never show LBP. In Demo it writes only that Demo profile's own
  // settings.json (the Demo's own storage root), never the shop's; main still requires the owner role.
  setLbpRate: "allow",
  getCompanyProfile: "allow",
  saveCompanyProfile: "allow",
  setNextInvoiceNumber: "deny",
  createInvoiceDraft: "allow",
  getInvoice: "allow",
  updateInvoiceHeader: "allow",
  setInvoiceTax: "allow",
  addInvoiceLine: "allow",
  addInvoiceLines: "allow",
  updateInvoiceLine: "allow",
  removeInvoiceLine: "allow",
  discardInvoiceDraft: "allow",
  finalizeInvoice: "allow",
  listInvoices: "allow",
  listInvoiceDrafts: "allow",
  findInvoiceByNumber: "allow",
  searchInvoices: "allow",
  listReconciliation: "allow",
  listReconciliationQueue: "allow",
  resolveKeepCatalog: "deny",
  resolveKeepInvoiceOnly: "deny",
  resolveLinkProduct: "deny",
  resolveCreateProduct: "deny",
  resolveUpdateCatalog: "deny",
  pickInvoiceLogo: "deny",
  printInvoice: "allow",
  saveInvoicePdf: "deny",
  recordAdvance: "deny",
  pendingAdvances: "deny",
  finishAdvance: "deny",
  closeAdvance: "deny",
  acknowledgeAdvance: "deny",
  getAdvanceStatement: "deny",
  getDailyMoney: "allow",
  correctAdvance: "deny",
  applyAdvanceToDebt: "deny",
  sellOnAdvance: "deny",
  printAdvance: "deny",
  saveAdvancePdf: "deny",
  refundAdvance: "deny",
  printAdvanceRefund: "deny",
  saveAdvanceRefundPdf: "deny",
  getCollectionReceipt: "deny",
  printCollectionReceipt: "deny",
  saveCollectionReceiptPdf: "deny",
  getSaleReceipt: "allow",
  printSaleReceipt: "allow",
  saveSaleReceiptPdf: "deny",
  readInvoicePhoto: "deny",
  // M1 integration (R5 × Phone Invoice, 2026-11-25): the phone-invoice queue arrived after the Demo table was written.
  // Denied like every other phone channel above (startPhoneSession, phoneSessionState): the Demo never stages or
  // releases a real supplier photo.
  listPhoneInvoices: "deny",
  releasePhoneInvoice: "deny",
} satisfies Readonly<Record<ChannelName, DemoDecision>>);

export function isDemoChannelAllowed(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEMO_CHANNEL_POLICY, name) &&
    DEMO_CHANNEL_POLICY[name as ChannelName] === "allow";
}

const DEMO_REFUSAL: IpcResult<never> = Object.freeze({
  ok: false,
  error: Object.freeze({ code: "DEMO_RESTRICTED", message: "This operation is unavailable in demo mode." }),
});

/** Invalid modes and unknown Demo channels fail closed before their handler runs. */
function safeDemoCompanyEdit(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  const empty = (value: unknown): boolean => value === null || value === "";
  // No file picker or logo replacement and no synthetic tax/legal registration.
  return p.logoPath === SYNTHETIC_DEMO_LOGO && p.taxEnabled === false &&
    empty(p.legalName) && empty(p.taxpayerNumber) && empty(p.commercialRegister) &&
    empty(p.vatNumber) && empty(p.taxLabel) &&
    (empty(p.taxRatePercent) || p.taxRatePercent === "0" || p.taxRatePercent === "0.00");
}
export function invokeWithDemoPolicy<T>(mode: unknown, name: string, invoke: () => T, payload?: unknown): T | IpcResult<never> {
  if (mode === "real") return invoke();
  if (mode !== "demo" || !isDemoChannelAllowed(name)) return DEMO_REFUSAL;
  if (name === "saveCompanyProfile" && !safeDemoCompanyEdit(payload)) return DEMO_REFUSAL;
  return invoke();
}

/**
 * A restrictive webRequest primitive for future per-session integration.
 * No session installs it in X1. It denies all network AND local file URLs;
 * a future reviewed local-asset policy is required before a Demo can run.
 * This only controls requests seen by Electron webRequest, not Node/network
 * calls outside that session, and it is not an operating-system sandbox.
 */
export function isDemoWebRequestAllowed(rawUrl: string): boolean {
  try {
    const scheme = new URL(rawUrl).protocol;
    return scheme === "data:" || scheme === "blob:";
  } catch {
    return false;
  }
}

export interface DemoWebRequestPort {
  onBeforeRequest(listener: (details: { readonly url: string }, callback: (result: { cancel: boolean }) => void) => void): void;
}

export function installDemoWebRequestBlocker(webRequest: DemoWebRequestPort): void {
  webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isDemoWebRequestAllowed(details.url) }));
}

export interface DemoSessionPort {
  readonly webRequest: DemoWebRequestPort;
}

export interface DemoSessionEvents {
  on(event: "session-created", listener: (session: DemoSessionPort) => void): unknown;
}

/**
 * Prepare every known session plus sessions announced later. The caller must
 * supply all already-existing sessions and register before any window/session
 * is created. No caller activates this in X1. Electron permits another
 * onBeforeRequest listener to replace this one: future integration must prove
 * exclusive ownership of the hook, and restrict Node-side operations separately.
 */
export function installDemoSessionBlockers(events: DemoSessionEvents, existing: ReadonlyArray<DemoSessionPort>): void {
  const installed = new WeakSet<DemoSessionPort>();
  const install = (session: DemoSessionPort): void => {
    if (installed.has(session)) return;
    installDemoWebRequestBlocker(session.webRequest);
    installed.add(session);
  };
  events.on("session-created", install);
  for (const session of existing) install(session);
}

/** Main-side defense in depth: never pass external-effect callbacks to Demo handlers. */
export function restrictDemoIpcOptions(o:IpcHandlerOptions):IpcHandlerOptions {
  return {
    showcaseProfile:o.showcaseProfile,
    appInfo:o.appInfo,
    entryState:o.entryState,
    logger:o.logger,
    now:o.now,
    invoices:o.invoices,
    parties:o.parties,
    ledger:o.ledger,
    advances:o.advances,
    dailyMoney:o.dailyMoney,
    saleReceipts:o.saleReceipts,
    settings:o.settings,
  };
}
