/**
 * Preload — runs sandboxed, so it may require only "electron". It exposes exactly the PosApi
 * business methods as `window.pos`; the renderer gets no ipcRenderer, no channel names and no
 * way to call anything else.
 *
 * Channel strings are repeated here (a sandboxed preload cannot require project files); the
 * `satisfies typeof CHANNELS` check makes the compiler fail if they ever drift from the contract.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  CHANNELS,
  InvoiceHeaderPatch,
  InvoiceLineRequest,
  PosApi,
  ProductDraftRequest,
  ProductMasterPatch,
} from "../shared/ipcContract";

/**
 * The header keys this bridge forwards, declared HERE as literals.
 *
 * 🔴 THIS FILE MAY NOT IMPORT A VALUE FROM ANYWHERE BUT "electron", AND THE REASON IS BRUTAL. The
 * window runs with `sandbox: true` (main.ts), and a sandboxed preload cannot require an arbitrary
 * relative file — only `electron` and a few polyfilled built-ins. Importing
 * INVOICE_HEADER_PATCH_KEYS from ../shared/ipcContract looked harmless and typechecked and built
 * and passed 602 unit tests, and it made the PACKAGED app show NOTHING AT ALL: the preload threw,
 * `window.pos` was never exposed, the renderer's first call threw, and #root stayed empty. Only the
 * Windows gate caught it, on the third round, after phase D was taught to report what it saw.
 *
 * That is why `CH` below is a literal copy of CHANNELS rather than an import of it, and why this
 * list is a literal copy too. The duplication is deliberate: tests/main/invoiceIpc.test.ts pins
 * both against the contract, so a drift fails by name instead of at a shop counter.
 */
const HEADER_PATCH_KEYS = [
  "invoiceDate",
  "customerName",
  "customerAddress",
  "customerPhone",
  "notes",
  "paid",
] as const satisfies ReadonlyArray<keyof InvoiceHeaderPatch>;

/**
 * The Product Master patch keys, declared HERE as literals for the same brutal reason as
 * HEADER_PATCH_KEYS above: this file may import a TYPE from the contract but never a VALUE.
 *
 * `satisfies ReadonlyArray<keyof ProductMasterPatch>` makes the compiler refuse a typo or a
 * forgotten key, and tests/main/productMasterIpc.test.ts pins this list against the contract's own
 * PRODUCT_MASTER_PATCH_KEYS so a drift fails by name rather than at a shop counter.
 */
const MASTER_PATCH_KEYS = [
  "categoryId",
  "barcode",
  "brand",
  "descriptionAr",
  "descriptionEn",
  "isOnlineVisible",
] as const satisfies ReadonlyArray<keyof ProductMasterPatch>;

/**
 * Only the enrichment keys the caller actually set, each copied by value.
 *
 * 🔴 `in` IS THE TEST, AND A KEY HOLDING `undefined` IS DROPPED. Listing all six unconditionally
 * would turn an untouched field into an explicit null and CLEAR it — the exact bug the patch shape
 * exists to remove. And a renderer building this object from optional form state produces keys
 * holding `undefined`, which a structured clone faithfully preserves; dropping them here is what
 * makes "I did not touch the brand" survive the bridge.
 */
const masterPatch = (patch: ProductMasterPatch): ProductMasterPatch => {
  const out: Record<string, string | boolean | null> = {};
  for (const key of MASTER_PATCH_KEYS) {
    if (key in patch && patch[key] !== undefined) out[key] = patch[key] as string | boolean | null;
  }
  return out as ProductMasterPatch;
};

/**
 * A product draft, rebuilt field by field — and `master` carried ONLY when the caller sent one.
 *
 * The five selling fields are always present; `master` is forwarded only if this caller deals in
 * enrichment at all, so an import or a reconciliation call reaches the handler with no `master`
 * key, which is what tells the repository to leave every enrichment field exactly as it is.
 */
const draftPayload = (draft: ProductDraftRequest): ProductDraftRequest => {
  const base = {
    nameAr: draft.nameAr,
    nameEn: draft.nameEn,
    sku: draft.sku,
    price: draft.price,
    baseUnit: draft.baseUnit,
  };
  return draft.master === undefined ? base : { ...base, master: masterPatch(draft.master) };
};

/** One invoice line, rebuilt key by key — the same allowlisting every payload here uses. */
/** Only the header keys the caller set, each copied by value. Presence is the signal. */
const headerPatch = (patch: InvoiceHeaderPatch): InvoiceHeaderPatch => {
  const out: Record<string, string | null> = {};
  for (const key of HEADER_PATCH_KEYS) {
    if (key in patch) out[key] = patch[key] ?? null;
  }
  // Migration 16: a CHOSEN account id, not a typed field (see INVOICE_HEADER_LINK_KEYS).
  if ("customerPartyId" in patch) out.customerPartyId = patch.customerPartyId ?? null;
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
  completeBootstrapSetup: "pos:completeBootstrapSetup",
  listOperators: "pos:listOperators",
  createOperator: "pos:createOperator",
  renameOperator: "pos:renameOperator",
  resetOperatorPin: "pos:resetOperatorPin",
  setOperatorActive: "pos:setOperatorActive",
  setOperatorRole: "pos:setOperatorRole",
  setOperatorMayCreateProducts: "pos:setOperatorMayCreateProducts",
  currentCashier: "pos:currentCashier",
  getCatalog: "pos:getCatalog",
  createSale: "pos:createSale",
  voidSale: "pos:voidSale",
  getTodaySales: "pos:getTodaySales",
  getSaleHistory: "pos:getSaleHistory",
  importCatalog: "pos:importCatalog",
  exportCatalog: "pos:exportCatalog",
  exportOnlineCatalog: "pos:exportOnlineCatalog",
  exportBackup: "pos:exportBackup",
  getAppInfo: "pos:getAppInfo",
  listProducts: "pos:listProducts",
  createProduct: "pos:createProduct",
  updateProduct: "pos:updateProduct",
  setProductActive: "pos:setProductActive",
  listCategories: "pos:listCategories",
  listBrands: "pos:listBrands",
  createCategory: "pos:createCategory",
  searchCustomers: "pos:searchCustomers",
  getCustomer: "pos:getCustomer",
  createCustomer: "pos:createCustomer",
  updateCustomerContact: "pos:updateCustomerContact",
  setCustomerActive: "pos:setCustomerActive",
  getCustomerStatement: "pos:getCustomerStatement",
  recordCustomerPayment: "pos:recordCustomerPayment",
  recordAllocatedReceipt: "pos:recordAllocatedReceipt",
  renameCategory: "pos:renameCategory",
  setCategoryActive: "pos:setCategoryActive",
  deleteCategory: "pos:deleteCategory",
  getProductImageMeta: "pos:getProductImageMeta",
  getProductImageBytes: "pos:getProductImageBytes",
  setProductImage: "pos:setProductImage",
  removeProductImage: "pos:removeProductImage",
  startPhoneSession: "pos:startPhoneSession",
  cancelPhoneSession: "pos:cancelPhoneSession",
  phoneSessionState: "pos:phoneSessionState",
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
  addInvoiceLines: "pos:addInvoiceLines",
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
  // Each request is rebuilt field by field, exactly like every other call here, so a renderer
  // object cannot smuggle an extra property across the bridge.
  completeBootstrapSetup: (req) =>
    ipcRenderer.invoke(CH.completeBootstrapSetup, { ticket: req.ticket, name: req.name, pin: req.pin }),
  listOperators: () => ipcRenderer.invoke(CH.listOperators),
  createOperator: (req) =>
    ipcRenderer.invoke(CH.createOperator, { name: req.name, role: req.role, pin: req.pin }),
  renameOperator: (req) => ipcRenderer.invoke(CH.renameOperator, { operatorId: req.operatorId, name: req.name }),
  resetOperatorPin: (req) =>
    ipcRenderer.invoke(CH.resetOperatorPin, { operatorId: req.operatorId, pin: req.pin }),
  setOperatorActive: (req) =>
    ipcRenderer.invoke(CH.setOperatorActive, { operatorId: req.operatorId, isActive: req.isActive }),
  setOperatorRole: (req) =>
    ipcRenderer.invoke(CH.setOperatorRole, { operatorId: req.operatorId, role: req.role }),
  setOperatorMayCreateProducts: (req) =>
    ipcRenderer.invoke(CH.setOperatorMayCreateProducts, {
      operatorId: req.operatorId,
      mayCreateProducts: req.mayCreateProducts,
    }),
  currentCashier: () => ipcRenderer.invoke(CH.currentCashier),
  getCatalog: () => ipcRenderer.invoke(CH.getCatalog),
  createSale: (req) => ipcRenderer.invoke(CH.createSale, req),
  voidSale: (req) => ipcRenderer.invoke(CH.voidSale, { saleId: req.saleId, reason: req.reason }),
  getTodaySales: () => ipcRenderer.invoke(CH.getTodaySales),
  getSaleHistory: (req) => ipcRenderer.invoke(CH.getSaleHistory, { limit: req.limit }),
  importCatalog: () => ipcRenderer.invoke(CH.importCatalog),
  exportCatalog: () => ipcRenderer.invoke(CH.exportCatalog),
  exportOnlineCatalog: () => ipcRenderer.invoke(CH.exportOnlineCatalog),
  exportBackup: () => ipcRenderer.invoke(CH.exportBackup),
  getAppInfo: () => ipcRenderer.invoke(CH.getAppInfo),
  listProducts: () => ipcRenderer.invoke(CH.listProducts),
  // 🔴 THE DRAFT IS NOW REBUILT, where it used to be forwarded by reference. Two reasons, and the
  // second is the one that matters: a renderer object crossing the bridge could carry extra
  // properties, and — since Product Master — the draft holds a PATCH whose absent keys are
  // meaningful. `draftPayload` is what preserves that absence.
  createProduct: (req) => ipcRenderer.invoke(CH.createProduct, { draft: draftPayload(req.draft) }),
  updateProduct: (req) =>
    ipcRenderer.invoke(CH.updateProduct, { id: req.id, draft: draftPayload(req.draft), isActive: req.isActive }),
  setProductActive: (req) => ipcRenderer.invoke(CH.setProductActive, { id: req.id, isActive: req.isActive }),

  // ── Product Master (migration 9) ─────────────────────────────────────────────────────────────
  listCategories: () => ipcRenderer.invoke(CH.listCategories),
  listBrands: () => ipcRenderer.invoke(CH.listBrands),
  createCategory: (req) => ipcRenderer.invoke(CH.createCategory, { nameAr: req.nameAr, nameEn: req.nameEn }),
  // ── Customer directory (S1B) ──────────────────────────────────────────────────────────────────
  //
  // 🔴 EVERY FIELD IS NAMED, as every other method here does. A spread would forward whatever the
  // renderer attached, and the main process refuses unexpected keys — so a stray field would turn
  // into an INVALID_INPUT the operator cannot act on, instead of being dropped here.
  searchCustomers: (req) =>
    ipcRenderer.invoke(CH.searchCustomers, { query: req.query, includeArchived: req.includeArchived }),
  getCustomer: (req) => ipcRenderer.invoke(CH.getCustomer, { customerId: req.customerId }),
  createCustomer: (req) =>
    ipcRenderer.invoke(CH.createCustomer, {
      displayName: req.displayName,
      phone: req.phone,
      address: req.address,
      note: req.note,
    }),
  updateCustomerContact: (req) =>
    ipcRenderer.invoke(CH.updateCustomerContact, { customerId: req.customerId, patch: req.patch }),
  setCustomerActive: (req) =>
    ipcRenderer.invoke(CH.setCustomerActive, { customerId: req.customerId, isActive: req.isActive }),
  // 🔴 READ-ONLY. It sends one id and receives a statement. There is no counterpart that posts a
  // debt or records a payment — those are not on this bridge at all.
  getCustomerStatement: (req) => ipcRenderer.invoke(CH.getCustomerStatement, { customerId: req.customerId }),
  // 🔴 EVERY FIELD NAMED EXPLICITLY, like every other method here — the renderer cannot smuggle an
  // extra property (a currency, a party override) through by spreading its own object.
  recordCustomerPayment: (req) =>
    ipcRenderer.invoke(CH.recordCustomerPayment, {
      customerId: req.customerId,
      obligationId: req.obligationId,
      idempotencyKey: req.idempotencyKey,
      amountMinor: req.amountMinor,
      method: req.method,
      reference: req.reference ?? null,
      fundsConfirmed: req.fundsConfirmed === true,
    }),
  // 🔴 EVERY FIELD NAMED EXPLICITLY, and each share rebuilt field by field: nothing rides along.
  recordAllocatedReceipt: (req) =>
    ipcRenderer.invoke(CH.recordAllocatedReceipt, {
      customerId: req.customerId,
      idempotencyKey: req.idempotencyKey,
      channel: req.channel,
      reference: req.reference,
      fundsConfirmed: req.fundsConfirmed === true,
      currency: req.currency,
      totalMinor: req.totalMinor,
      allocations: req.allocations.map((a) => ({ obligationId: a.obligationId, amountMinor: a.amountMinor })),
    }),
  renameCategory: (req) =>
    ipcRenderer.invoke(CH.renameCategory, { categoryId: req.categoryId, nameAr: req.nameAr, nameEn: req.nameEn }),
  setCategoryActive: (req) =>
    ipcRenderer.invoke(CH.setCategoryActive, { categoryId: req.categoryId, isActive: req.isActive }),
  deleteCategory: (req) => ipcRenderer.invoke(CH.deleteCategory, { categoryId: req.categoryId }),
  getProductImageMeta: (req) => ipcRenderer.invoke(CH.getProductImageMeta, { productId: req.productId }),
  getProductImageBytes: (req) => ipcRenderer.invoke(CH.getProductImageBytes, { imageId: req.imageId }),
  // A product id and nothing else. Main owns the dialog, the file and the normalization; no path
  // and no bytes ever travel in this direction.
  setProductImage: (req) => ipcRenderer.invoke(CH.setProductImage, { productId: req.productId }),
  removeProductImage: (req) => ipcRenderer.invoke(CH.removeProductImage, { productId: req.productId }),
  // ── Phone entry over the LAN (slice H1) ──────────────────────────────────────────────────────
  //
  // 🔴 THE PAYLOAD IS REBUILT KEY BY KEY, like every other call here, and `productId` is forwarded
  // ONLY when the caller actually supplied it — `in`, not `??`. An EDIT session's product is the
  // token's whole binding, so turning an absent id into an explicit `null` (or the reverse) would
  // change which product a phone is allowed to touch.
  startPhoneSession: (req) =>
    ipcRenderer.invoke(
      CH.startPhoneSession,
      "productId" in req ? { action: req.action, productId: req.productId } : { action: req.action },
    ),
  cancelPhoneSession: () => ipcRenderer.invoke(CH.cancelPhoneSession),
  phoneSessionState: () => ipcRenderer.invoke(CH.phoneSessionState),
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
  addInvoiceLines: (req) =>
    ipcRenderer.invoke(CH.addInvoiceLines, {
      invoiceId: req.invoiceId,
      lines: req.lines.map(line),
      idempotencyKey: req.idempotencyKey,
    }),
  updateInvoiceLine: (req) =>
    ipcRenderer.invoke(CH.updateInvoiceLine, { invoiceId: req.invoiceId, lineId: req.lineId, line: line(req.line) }),
  removeInvoiceLine: (req) =>
    ipcRenderer.invoke(CH.removeInvoiceLine, { invoiceId: req.invoiceId, lineId: req.lineId }),
  discardInvoiceDraft: (req) => ipcRenderer.invoke(CH.discardInvoiceDraft, { invoiceId: req.invoiceId }),

  finalizeInvoice: (req) =>
    ipcRenderer.invoke(CH.finalizeInvoice, { invoiceId: req.invoiceId, issueOnAccount: req.issueOnAccount === true }),

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
