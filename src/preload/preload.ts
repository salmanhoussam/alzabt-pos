/**
 * Preload — runs sandboxed, so it may require only "electron". It exposes exactly the PosApi
 * business methods as `window.pos`; the renderer gets no ipcRenderer, no channel names and no
 * way to call anything else.
 *
 * Channel strings are repeated here (a sandboxed preload cannot require project files); the
 * `satisfies typeof CHANNELS` check makes the compiler fail if they ever drift from the contract.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { CHANNELS, InvoiceHeaderPatch, InvoiceLineRequest, PosApi } from "../shared/ipcContract";
import { INVOICE_HEADER_PATCH_KEYS } from "../shared/ipcContract";

/** One invoice line, rebuilt key by key — the same allowlisting every payload here uses. */
/** Only the header keys the caller set, each copied by value. Presence is the signal. */
const headerPatch = (patch: InvoiceHeaderPatch): InvoiceHeaderPatch => {
  const out: Record<string, string | null> = {};
  for (const key of INVOICE_HEADER_PATCH_KEYS) {
    if (key in patch) out[key] = patch[key] ?? null;
  }
  return out as InvoiceHeaderPatch;
};

function line(l: InvoiceLineRequest): InvoiceLineRequest {
  return {
    description: l.description,
    unitLabel: l.unitLabel,
    canonicalUnit: l.canonicalUnit,
    productId: l.productId,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
  };
}

const CH = {
  listCashiers: "pos:listCashiers",
  login: "pos:login",
  logout: "pos:logout",
  currentCashier: "pos:currentCashier",
  getCatalog: "pos:getCatalog",
  createSale: "pos:createSale",
  voidSale: "pos:voidSale",
  getTodaySales: "pos:getTodaySales",
  getSaleHistory: "pos:getSaleHistory",
  importCatalog: "pos:importCatalog",
  exportCatalog: "pos:exportCatalog",
  exportBackup: "pos:exportBackup",
  getAppInfo: "pos:getAppInfo",
  listProducts: "pos:listProducts",
  createProduct: "pos:createProduct",
  updateProduct: "pos:updateProduct",
  setProductActive: "pos:setProductActive",
  getSettings: "pos:getSettings",
  setTerminalLanguage: "pos:setTerminalLanguage",
  getCompanyProfile: "pos:getCompanyProfile",
  saveCompanyProfile: "pos:saveCompanyProfile",
  setNextInvoiceNumber: "pos:setNextInvoiceNumber",
  createInvoiceDraft: "pos:createInvoiceDraft",
  getInvoice: "pos:getInvoice",
  updateInvoiceHeader: "pos:updateInvoiceHeader",
  setInvoiceTax: "pos:setInvoiceTax",
  addInvoiceLine: "pos:addInvoiceLine",
  updateInvoiceLine: "pos:updateInvoiceLine",
  removeInvoiceLine: "pos:removeInvoiceLine",
  discardInvoiceDraft: "pos:discardInvoiceDraft",
  finalizeInvoice: "pos:finalizeInvoice",
  listInvoices: "pos:listInvoices",
  listInvoiceDrafts: "pos:listInvoiceDrafts",
  findInvoiceByNumber: "pos:findInvoiceByNumber",
  searchInvoices: "pos:searchInvoices",
  listReconciliation: "pos:listReconciliation",
  listReconciliationQueue: "pos:listReconciliationQueue",
  resolveKeepCatalog: "pos:resolveKeepCatalog",
  resolveKeepInvoiceOnly: "pos:resolveKeepInvoiceOnly",
  resolveLinkProduct: "pos:resolveLinkProduct",
  resolveCreateProduct: "pos:resolveCreateProduct",
  resolveUpdateCatalog: "pos:resolveUpdateCatalog",
  pickInvoiceLogo: "pos:pickInvoiceLogo",
  printInvoice: "pos:printInvoice",
  saveInvoicePdf: "pos:saveInvoicePdf",
} as const satisfies typeof CHANNELS;

const api: PosApi = {
  listCashiers: () => ipcRenderer.invoke(CH.listCashiers),
  login: (req) => ipcRenderer.invoke(CH.login, { cashierId: req.cashierId, pin: req.pin }),
  logout: () => ipcRenderer.invoke(CH.logout),
  currentCashier: () => ipcRenderer.invoke(CH.currentCashier),
  getCatalog: () => ipcRenderer.invoke(CH.getCatalog),
  createSale: (req) => ipcRenderer.invoke(CH.createSale, req),
  voidSale: (req) => ipcRenderer.invoke(CH.voidSale, { saleId: req.saleId, reason: req.reason }),
  getTodaySales: () => ipcRenderer.invoke(CH.getTodaySales),
  getSaleHistory: (req) => ipcRenderer.invoke(CH.getSaleHistory, { limit: req.limit }),
  importCatalog: () => ipcRenderer.invoke(CH.importCatalog),
  exportCatalog: () => ipcRenderer.invoke(CH.exportCatalog),
  exportBackup: () => ipcRenderer.invoke(CH.exportBackup),
  getAppInfo: () => ipcRenderer.invoke(CH.getAppInfo),
  listProducts: () => ipcRenderer.invoke(CH.listProducts),
  createProduct: (req) => ipcRenderer.invoke(CH.createProduct, { draft: req.draft }),
  updateProduct: (req) => ipcRenderer.invoke(CH.updateProduct, { id: req.id, draft: req.draft, isActive: req.isActive }),
  setProductActive: (req) => ipcRenderer.invoke(CH.setProductActive, { id: req.id, isActive: req.isActive }),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  setTerminalLanguage: (req) => ipcRenderer.invoke(CH.setTerminalLanguage, { language: req.language }),

  // ── Manual invoices ──────────────────────────────────────────────────────────────────────────
  //
  // Every payload below is REBUILT field by field, like the ones above. A caller cannot smuggle an
  // extra key through this bridge, and the handler's `exactObject` would refuse one anyway — two
  // independent reasons the renderer cannot send a total, a number or a resolution status.
  getCompanyProfile: () => ipcRenderer.invoke(CH.getCompanyProfile),
  saveCompanyProfile: (req) =>
    ipcRenderer.invoke(CH.saveCompanyProfile, {
      nameAr: req.nameAr,
      nameEn: req.nameEn,
      legalName: req.legalName,
      tagline: req.tagline,
      address: req.address,
      phone1: req.phone1,
      phone2: req.phone2,
      email: req.email,
      logoPath: req.logoPath,
      taxpayerNumber: req.taxpayerNumber,
      commercialRegister: req.commercialRegister,
      vatNumber: req.vatNumber,
      taxEnabled: req.taxEnabled,
      taxRatePercent: req.taxRatePercent,
      taxLabel: req.taxLabel,
    }),
  setNextInvoiceNumber: (req) =>
    ipcRenderer.invoke(CH.setNextInvoiceNumber, { nextInvoiceNumber: req.nextInvoiceNumber }),

  createInvoiceDraft: () => ipcRenderer.invoke(CH.createInvoiceDraft),
  getInvoice: (req) => ipcRenderer.invoke(CH.getInvoice, { invoiceId: req.invoiceId }),
  updateInvoiceHeader: (req) =>
    // 🔴 REBUILT KEY BY KEY, AND ONLY THE KEYS THE CALLER ACTUALLY SET. Copying the whole object
    // would forward a renderer-owned reference across the bridge; listing every key unconditionally
    // would turn an untouched field into an explicit null, which is the bug this patch shape exists
    // to remove. `in` is the test, so a key holding null is kept and a key never set is dropped.
    ipcRenderer.invoke(CH.updateInvoiceHeader, {
      invoiceId: req.invoiceId,
      patch: headerPatch(req.patch),
    }),
  setInvoiceTax: (req) =>
    ipcRenderer.invoke(CH.setInvoiceTax, {
      invoiceId: req.invoiceId,
      enabled: req.enabled,
      ratePercent: req.ratePercent,
      label: req.label,
    }),
  addInvoiceLine: (req) => ipcRenderer.invoke(CH.addInvoiceLine, { invoiceId: req.invoiceId, line: line(req.line) }),
  updateInvoiceLine: (req) =>
    ipcRenderer.invoke(CH.updateInvoiceLine, { invoiceId: req.invoiceId, lineId: req.lineId, line: line(req.line) }),
  removeInvoiceLine: (req) =>
    ipcRenderer.invoke(CH.removeInvoiceLine, { invoiceId: req.invoiceId, lineId: req.lineId }),
  discardInvoiceDraft: (req) => ipcRenderer.invoke(CH.discardInvoiceDraft, { invoiceId: req.invoiceId }),

  finalizeInvoice: (req) => ipcRenderer.invoke(CH.finalizeInvoice, { invoiceId: req.invoiceId }),

  listInvoices: (req) => ipcRenderer.invoke(CH.listInvoices, { term: req.term, limit: req.limit }),
  listInvoiceDrafts: (req) => ipcRenderer.invoke(CH.listInvoiceDrafts, { term: req.term, limit: req.limit }),
  findInvoiceByNumber: (req) => ipcRenderer.invoke(CH.findInvoiceByNumber, { invoiceNumber: req.invoiceNumber }),
  searchInvoices: (req) => ipcRenderer.invoke(CH.searchInvoices, { term: req.term, limit: req.limit }),

  listReconciliation: (req) => ipcRenderer.invoke(CH.listReconciliation, { invoiceId: req.invoiceId }),
  listReconciliationQueue: (req) =>
    ipcRenderer.invoke(CH.listReconciliationQueue, { filter: req.filter, limit: req.limit }),
  resolveKeepCatalog: (req) =>
    ipcRenderer.invoke(CH.resolveKeepCatalog, { reconciliationId: req.reconciliationId }),
  resolveKeepInvoiceOnly: (req) =>
    ipcRenderer.invoke(CH.resolveKeepInvoiceOnly, { reconciliationId: req.reconciliationId }),
  resolveLinkProduct: (req) =>
    ipcRenderer.invoke(CH.resolveLinkProduct, { reconciliationId: req.reconciliationId, productId: req.productId }),
  resolveCreateProduct: (req) =>
    ipcRenderer.invoke(CH.resolveCreateProduct, {
      reconciliationId: req.reconciliationId,
      nameAr: req.nameAr,
      nameEn: req.nameEn,
      sku: req.sku,
      baseUnit: req.baseUnit,
    }),
  resolveUpdateCatalog: (req) =>
    ipcRenderer.invoke(CH.resolveUpdateCatalog, {
      reconciliationId: req.reconciliationId,
      // A copy, so a live array in the renderer cannot change between here and the handler.
      fields: [...req.fields],
      canonicalUnit: req.canonicalUnit,
      nameEn: req.nameEn,
    }),

  pickInvoiceLogo: () => ipcRenderer.invoke(CH.pickInvoiceLogo),
  printInvoice: (req) => ipcRenderer.invoke(CH.printInvoice, { invoiceId: req.invoiceId }),
  saveInvoicePdf: (req) => ipcRenderer.invoke(CH.saveInvoicePdf, { invoiceId: req.invoiceId }),
};

contextBridge.exposeInMainWorld("pos", Object.freeze(api));
