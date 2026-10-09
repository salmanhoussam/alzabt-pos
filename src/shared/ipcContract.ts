/**
 * The complete renderer ↔ main contract. These business operations are the ONLY things the UI can
 * ask the main process to do. There is deliberately no query, SQL, file or generic "invoke" channel.
 *
 * Money crosses this boundary as a string of minor units ("1250" = 12.50 USD), never a number.
 */
import type { PaymentMethod, PaymentStatus, SaleSourceType } from "../domain/sale";
import type { Language, TerminalSettings } from "./i18n";

export const CHANNELS = {
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
  // ── Manual invoices (migration 6) ────────────────────────────────────────────────────────────
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
} as const;

export type ChannelName = keyof typeof CHANNELS;

export interface MoneyDto {
  readonly minor: string;
  readonly currency: string;
}

export interface CashierDto {
  readonly id: string;
  readonly name: string;
}

export interface ProductDto {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly price: MoneyDto;
  readonly baseUnit: string;
  readonly priceNeedsReview: boolean;
}

export interface CatalogDto {
  readonly currency: string;
  readonly products: ReadonlyArray<ProductDto>;
}

export interface SaleLineDto {
  readonly lineNo: number;
  /** The invoice line this froze, or null on a till line. */
  readonly invoiceLineId: string | null;
  /** Null only on an invoice-origin line whose product the catalog does not have yet. */
  readonly productId: string | null;
  readonly sku: string | null;
  readonly productName: string;
  /** The unit exactly as the invoice printed it. Null on a till line. */
  readonly unitLabel: string | null;
  /** The unit sold; null only on a line written before migration 4. */
  readonly saleUnit: string | null;
  /** Thousandths of one sale unit. Formatted for display by domain/quantity.ts. */
  readonly quantityMilli: number;
  readonly unitPrice: MoneyDto;
  readonly lineTotal: MoneyDto;
}

export interface SaleDto {
  readonly id: string;
  readonly receiptNumber: number;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly currency: string;
  /** Where the sale came from: a till checkout, or a finalized manual invoice. */
  readonly sourceType: SaleSourceType;
  readonly invoiceId: string | null;
  /** Present only for an invoice-origin sale, so history can show the document's own number. */
  readonly invoiceNumber: number | null;
  readonly subtotal: MoneyDto;
  readonly tax: MoneyDto;
  readonly total: MoneyDto;
  readonly paid: MoneyDto;
  readonly balanceDue: MoneyDto;
  readonly paymentStatus: PaymentStatus;
  /** 🔴 Null means NOT RECORDED. The UI must say so, never substitute a method. */
  readonly paymentMethod: PaymentMethod | null;
  readonly businessDate: string;
  readonly completedAt: string;
  readonly lines: ReadonlyArray<SaleLineDto>;
}

export interface VoidDto {
  readonly id: string;
  readonly saleId: string;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly reason: string;
  readonly businessDate: string;
  readonly createdAt: string;
}

export interface SaleWithVoidDto {
  readonly sale: SaleDto;
  readonly void: VoidDto | null;
}

export interface TodaySalesDto {
  readonly date: string;
  readonly currency: string;
  readonly completedSalesCount: number;
  readonly voidedSalesCount: number;
  readonly grossSales: MoneyDto;
  readonly voidTotal: MoneyDto;
  readonly netSales: MoneyDto;
}

export interface LoginRequest {
  readonly cashierId: string;
  readonly pin: string;
}

export interface CreateSaleRequest {
  readonly idempotencyKey: string;
  readonly lines: ReadonlyArray<{ readonly productId: string; readonly quantityMilli: number }>;
  readonly paymentMethod: PaymentMethod;
  readonly expectedTotalMinor: string;
}

export interface CreateSaleResponse {
  readonly sale: SaleDto;
  readonly duplicate: boolean;
}

export interface VoidSaleRequest {
  readonly saleId: string;
  readonly reason: string;
}

export interface HistoryRequest {
  readonly limit: number;
}

/**
 * importCatalog takes NO payload: the main process asks the cashier to pick the file in a native
 * dialog and reads it itself. The renderer can never name a path or hand over file contents.
 */
export type ImportCatalogResponse =
  | { readonly status: "cancelled" }
  | {
      readonly status: "imported";
      readonly rowCount: number;
      readonly inserted: number;
      readonly updated: number;
      readonly unchanged: number;
      readonly deactivated: number;
      readonly placeholderPrices: number;
    }
  | { readonly status: "rejected"; readonly rejected: ReadonlyArray<{ readonly line: number; readonly reason: string }> };

/** exportCatalog / exportBackup take NO payload: the main process shows the save dialog and writes. */
export type ExportResponse =
  | { readonly status: "cancelled" }
  | { readonly status: "saved"; readonly fileName: string; readonly productCount?: number };

/** Installation identity, shown in the UI for field support. */
export interface AppInfoDto {
  readonly version: string;
  readonly build: string;
}

/**
 * A product as the ADMINISTRATION screen sees it — every field, active or not. Distinct from
 * ProductDto, which is the sellable projection the Sell screen uses: the admin list must show
 * inactive products and where a product came from, and the sell list must not.
 *
 * Money crosses as a decimal string of minor units here too; `price` is the human decimal form so
 * the edit form can show exactly what will be re-parsed, with no formatting round-trip.
 */
export interface AdminProductDto {
  readonly id: string;
  readonly source: string;
  readonly sourceKey: string;
  readonly sku: string | null;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly price: MoneyDto;
  /** The same amount as a plain decimal ("12.50") — what the edit form puts in its price box. */
  readonly priceDecimal: string;
  readonly baseUnit: string;
  readonly priceNeedsReview: boolean;
  readonly isActive: boolean;
  readonly updatedAt: string;
}

/** What the operator typed. Optional fields are null when not given — never an empty string. */
export interface ProductDraftRequest {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string | null;
  readonly price: string;
  readonly baseUnit: string;
}

export interface CreateProductRequest {
  readonly draft: ProductDraftRequest;
}

export interface UpdateProductRequest {
  readonly id: string;
  readonly draft: ProductDraftRequest;
  readonly isActive: boolean;
}

export interface SetProductActiveRequest {
  readonly id: string;
  readonly isActive: boolean;
}

export interface SetTerminalLanguageRequest {
  readonly language: Language;
}

export interface IpcError {
  readonly code: string;
  readonly message: string;
}

export type IpcResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: IpcError };

// ── Manual invoices (migration 6) ───────────────────────────────────────────────────────────────
//
// 🔴 EVERY SCALED VALUE CROSSES AS A STRING OF MINOR UNITS, like `MoneyDto` above — a bigint cannot
// be structured-cloned and a `number` would silently lose precision past 2^53. `quantityMilli` is
// the one exception and is a safe integer by construction: migration 6 CHECKs it at or below
// 9,999,000.
//
// 🔴 AND THE RENDERER SENDS INTENT ONLY. There is no channel that accepts a total, a subtotal, a
// line total, an amount in words, an invoice number, a catalog row or a reconciliation status. The
// service computes every one of those and the renderer is told the result.

export interface CompanyProfileDto {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly legalName: string | null;
  readonly tagline: string | null;
  readonly address: string | null;
  readonly phone1: string | null;
  readonly phone2: string | null;
  readonly email: string | null;
  readonly logoPath: string | null;
  /** Three DIFFERENT official identifiers, three fields. Never collapsed into one. */
  readonly taxpayerNumber: string | null;
  readonly commercialRegister: string | null;
  readonly vatNumber: string | null;
  readonly taxEnabled: boolean;
  /** The rate as a plain decimal percentage ("11", "11.5") — exactly what the form re-submits. */
  readonly taxRatePercent: string;
  readonly taxLabel: string | null;
  readonly nextInvoiceNumber: number;
  readonly updatedAt: string;
}

/** What the settings form submits. Every optional field is null when not given, never "". */
export interface SaveCompanyProfileRequest {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly legalName: string | null;
  readonly tagline: string | null;
  readonly address: string | null;
  readonly phone1: string | null;
  readonly phone2: string | null;
  readonly email: string | null;
  readonly logoPath: string | null;
  readonly taxpayerNumber: string | null;
  readonly commercialRegister: string | null;
  readonly vatNumber: string | null;
  readonly taxEnabled: boolean;
  readonly taxRatePercent: string | null;
  readonly taxLabel: string | null;
}

/** The issuer AS FROZEN onto a finalized invoice — never the live profile. */
export interface IssuerSnapshotDto {
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly legalName: string | null;
  readonly tagline: string | null;
  readonly address: string | null;
  readonly phone1: string | null;
  readonly phone2: string | null;
  readonly email: string | null;
  readonly logoPath: string | null;
  readonly taxpayerNumber: string | null;
  readonly commercialRegister: string | null;
  readonly vatNumber: string | null;
}

export interface InvoiceTaxSnapshotDto {
  readonly enabled: boolean;
  readonly rateBasisPoints: number;
  readonly label: string | null;
}

export interface InvoiceLineDto {
  readonly id: string;
  readonly lineNo: number;
  readonly description: string | null;
  /** Exactly as printed, verbatim: "حبة", "كيس (50PCS)". Historical truth. */
  readonly unitLabel: string | null;
  /** A catalog base unit, present only when known or chosen. null is a RESULT, not a failure. */
  readonly canonicalUnit: string | null;
  readonly productId: string | null;
  readonly quantityMilli: number;
  /** The quantity already formatted by the one domain formatter, so the UI cannot disagree. */
  readonly quantityText: string;
  readonly unitPrice: MoneyDto;
  readonly lineTotal: MoneyDto;
}

export interface InvoiceDto {
  readonly id: string;
  readonly status: "draft" | "final";
  /** null until FINALIZE. A draft has no number, by decision — the number is scarce. */
  readonly invoiceNumber: number | null;
  readonly invoiceDate: string | null;
  readonly currency: string;
  readonly customerName: string | null;
  readonly customerAddress: string | null;
  readonly customerPhone: string | null;
  readonly notes: string | null;
  readonly subtotal: MoneyDto;
  readonly tax: MoneyDto;
  readonly total: MoneyDto;
  readonly paid: MoneyDto;
  readonly balanceDue: MoneyDto;
  readonly amountInWords: string | null;
  readonly issuer: IssuerSnapshotDto | null;
  readonly taxSnapshot: InvoiceTaxSnapshotDto | null;
  readonly createdByName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt: string | null;
}

export interface InvoiceViewDto {
  readonly invoice: InvoiceDto;
  readonly lines: ReadonlyArray<InvoiceLineDto>;
}

/**
 * The header fields an operator may change, as a PATCH.
 *
 * 🔴 PRESENCE IS THE SIGNAL, AND THAT IS THE WHOLE POINT. A key that appears is written; a key that
 * is absent is left exactly as the database holds it. The previous shape required every field on
 * every call, so the renderer filled the untouched ones from its own React state — and a response
 * that had not landed yet meant it filled them with STALE values and silently overwrote whatever
 * had just been saved. A commercial invoice lost its customer phone that way, intermittently,
 * depending only on how fast the operator pressed Tab.
 *
 * Absence is expressed by OMITTING the key, never by `undefined`: an absent key and a key holding
 * `undefined` are not reliably distinguishable once a payload has crossed a process boundary, and
 * `Object.keys()` is checkable where `undefined` is not.
 */
export interface InvoiceHeaderPatch {
  readonly invoiceDate?: string | null;
  readonly customerName?: string | null;
  readonly customerAddress?: string | null;
  readonly customerPhone?: string | null;
  readonly notes?: string | null;
  /** A typed decimal ("100.00"), or null for nothing paid. NOT a computed balance. */
  readonly paid?: string | null;
}

/** Every key a header patch may carry. The IPC boundary refuses anything else. */
export const INVOICE_HEADER_PATCH_KEYS = [
  "invoiceDate",
  "customerName",
  "customerAddress",
  "customerPhone",
  "notes",
  "paid",
] as const;

export type InvoiceHeaderPatchKey = (typeof INVOICE_HEADER_PATCH_KEYS)[number];

/**
 * Whether THIS invoice is taxed, and at what rate.
 *
 * 🔴 PER INVOICE, NOT A GLOBAL SWITCH. Issuing one taxed invoice used to mean toggling the shop
 * setting on and off around it, and anything finalized in between inherited the wrong state.
 */
export interface InvoiceTaxRequest {
  readonly invoiceId: string;
  readonly enabled: boolean;
  /** Typed text — "11", "11.5". Converted to exact basis points by the domain. Null when disabled. */
  readonly ratePercent: string | null;
  readonly label: string | null;
}

export interface InvoiceHeaderRequest {
  readonly invoiceId: string;
  /** Only the fields that actually changed. An empty patch is a no-op, not an erasure. */
  readonly patch: InvoiceHeaderPatch;
}

/** One line as typed. Quantity and price are TEXT and are parsed by the domain, never numbers. */
export interface InvoiceLineRequest {
  readonly description: string | null;
  readonly unitLabel: string | null;
  readonly canonicalUnit: string | null;
  readonly productId: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
}

export interface AddInvoiceLineRequest {
  readonly invoiceId: string;
  readonly line: InvoiceLineRequest;
}

export interface UpdateInvoiceLineRequest {
  readonly invoiceId: string;
  readonly lineId: string;
  readonly line: InvoiceLineRequest;
}

export interface InvoiceLineRefRequest {
  readonly invoiceId: string;
  readonly lineId: string;
}

export interface InvoiceIdRequest {
  readonly invoiceId: string;
}

export interface InvoiceNumberRequest {
  readonly invoiceNumber: number;
}

export interface InvoiceSearchRequest {
  readonly term: string | null;
  readonly limit: number;
}

export interface SetNextInvoiceNumberRequest {
  readonly nextInvoiceNumber: number;
}

/** A catalog row AS OBSERVED when reconciliation looked, not as the catalog stands today. */
export interface ReconciliationCandidateDto {
  readonly id: string;
  readonly sku: string | null;
  readonly nameAr: string;
  readonly nameEn: string | null;
  /** Minor units as a string — the same precision rule as MoneyDto. */
  readonly sellingPriceMinor: string;
  readonly baseUnit: string;
  readonly isActive: boolean;
}

export interface DifferenceDto {
  readonly field: "selling_price_minor" | "base_unit" | "name_ar" | "name_en";
  readonly invoice: string;
  readonly catalog: string | null;
  /**
   * 🔴 False means WE CANNOT TELL, not "they differ". An unmapped unit label such as "كيس (50PCS)"
   * is unknown, and the UI must ask which catalog unit it means rather than assert a disagreement.
   */
  readonly comparable: boolean;
}

export type ReconciliationClassificationDto =
  | "MATCHED"
  | "PRICE_DIFFERENCE"
  | "UNIT_DIFFERENCE"
  | "DESCRIPTION_DIFFERENCE"
  | "MULTIPLE_DIFFERENCES"
  | "PRODUCT_NOT_FOUND"
  | "AMBIGUOUS_MATCH";

export type ResolutionStateDto =
  | "PENDING"
  | "KEPT_CATALOG"
  | "UPDATED_CATALOG"
  | "CREATED_PRODUCT"
  | "LINKED_PRODUCT"
  | "KEPT_INVOICE_ONLY"
  | "FAILED";

export interface ReconciliationDto {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: number | null;
  readonly invoiceDate: string | null;
  /** What the invoice CONTAINED — the frozen line, so the panel never re-reads the catalog for it. */
  readonly line: InvoiceLineDto | null;
  readonly classification: ReconciliationClassificationDto;
  readonly matchTier: "explicit" | "sku" | "name_ar" | "name_en" | "none";
  readonly matchedProductId: string | null;
  readonly candidates: ReadonlyArray<ReconciliationCandidateDto>;
  readonly differences: ReadonlyArray<DifferenceDto>;
  readonly status: ResolutionStateDto;
  readonly selectedFields: ReadonlyArray<string> | null;
  readonly resolvedAt: string | null;
  readonly resolutionActorName: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
}

export interface ReconciliationQueueDto {
  readonly items: ReadonlyArray<ReconciliationDto>;
  readonly unresolved: number;
  readonly byStatus: Readonly<Record<string, number>>;
}

export type ReconciliationFilterDto = "unresolved" | "failed" | "resolved" | "all";

export interface ReconciliationQueueRequest {
  readonly filter: ReconciliationFilterDto;
  readonly limit: number;
}

export interface ReconciliationIdRequest {
  readonly reconciliationId: string;
}

export interface ResolveLinkProductRequest {
  readonly reconciliationId: string;
  readonly productId: string;
}

export interface ResolveCreateProductRequest {
  readonly reconciliationId: string;
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly sku: string | null;
  /** A catalog base unit. Required when the invoice's printed label maps to nothing. */
  readonly baseUnit: string | null;
}

/**
 * The ONE channel that copies invoice values into the catalog — for a price, a unit, a name, any
 * combination of them, and a retry of a failed attempt. They are one act with a selection, not five
 * endpoints: a second vocabulary for the same operation would let the UI and the service disagree
 * about what "update the unit" means.
 *
 * 🔴 The renderer sends the SELECTED FIELDS. It does not send the values; the service reads them
 * from the frozen invoice line. And it cannot send a resolution status — only this request.
 */
export interface ResolveUpdateCatalogRequest {
  readonly reconciliationId: string;
  readonly fields: ReadonlyArray<"selling_price_minor" | "base_unit" | "name_ar" | "name_en">;
  /** The operator's chosen catalog unit, for a label that maps to nothing. Never a guess. */
  readonly canonicalUnit: string | null;
  /** Required when `name_en` is selected. An English name is NEVER inferred from a description. */
  readonly nameEn: string | null;
}

/**
 * The logo, chosen in a NATIVE dialog by the main process.
 *
 * 🔴 The renderer never names a path. Main shows the picker, copies the file into its own branding
 * folder under userData, and hands back a BARE FILE NAME — so what the profile stores can never be
 * an arbitrary location on disk, and rendering it later cannot be redirected anywhere else.
 */
export type PickInvoiceLogoResponse =
  | { readonly status: "cancelled" }
  | { readonly status: "chosen"; readonly logoPath: string }
  | { readonly status: "unavailable" };

export type PrintInvoiceResponse =
  | { readonly status: "printed" }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable" };

/** What the preload script exposes as `window.pos`. */
export interface PosApi {
  listCashiers(): Promise<IpcResult<CashierDto[]>>;
  login(req: LoginRequest): Promise<IpcResult<CashierDto>>;
  logout(): Promise<IpcResult<null>>;
  currentCashier(): Promise<IpcResult<CashierDto | null>>;
  getCatalog(): Promise<IpcResult<CatalogDto>>;
  createSale(req: CreateSaleRequest): Promise<IpcResult<CreateSaleResponse>>;
  voidSale(req: VoidSaleRequest): Promise<IpcResult<VoidDto>>;
  getTodaySales(): Promise<IpcResult<TodaySalesDto>>;
  getSaleHistory(req: HistoryRequest): Promise<IpcResult<SaleWithVoidDto[]>>;
  importCatalog(): Promise<IpcResult<ImportCatalogResponse>>;
  exportCatalog(): Promise<IpcResult<ExportResponse>>;
  exportBackup(): Promise<IpcResult<ExportResponse>>;
  getAppInfo(): Promise<IpcResult<AppInfoDto>>;
  listProducts(): Promise<IpcResult<AdminProductDto[]>>;
  createProduct(req: CreateProductRequest): Promise<IpcResult<AdminProductDto>>;
  updateProduct(req: UpdateProductRequest): Promise<IpcResult<AdminProductDto>>;
  setProductActive(req: SetProductActiveRequest): Promise<IpcResult<AdminProductDto>>;
  getSettings(): Promise<IpcResult<TerminalSettings>>;
  setTerminalLanguage(req: SetTerminalLanguageRequest): Promise<IpcResult<TerminalSettings>>;

  // ── Manual invoices ──────────────────────────────────────────────────────────────────────────
  getCompanyProfile(): Promise<IpcResult<CompanyProfileDto | null>>;
  saveCompanyProfile(req: SaveCompanyProfileRequest): Promise<IpcResult<CompanyProfileDto>>;
  setNextInvoiceNumber(req: SetNextInvoiceNumberRequest): Promise<IpcResult<CompanyProfileDto>>;

  createInvoiceDraft(): Promise<IpcResult<InvoiceViewDto>>;
  getInvoice(req: InvoiceIdRequest): Promise<IpcResult<InvoiceViewDto>>;
  updateInvoiceHeader(req: InvoiceHeaderRequest): Promise<IpcResult<InvoiceViewDto>>;
  setInvoiceTax(req: InvoiceTaxRequest): Promise<IpcResult<InvoiceViewDto>>;
  addInvoiceLine(req: AddInvoiceLineRequest): Promise<IpcResult<InvoiceViewDto>>;
  updateInvoiceLine(req: UpdateInvoiceLineRequest): Promise<IpcResult<InvoiceViewDto>>;
  removeInvoiceLine(req: InvoiceLineRefRequest): Promise<IpcResult<InvoiceViewDto>>;
  discardInvoiceDraft(req: InvoiceIdRequest): Promise<IpcResult<null>>;

  finalizeInvoice(req: InvoiceIdRequest): Promise<IpcResult<InvoiceViewDto>>;

  listInvoices(req: InvoiceSearchRequest): Promise<IpcResult<InvoiceDto[]>>;
  listInvoiceDrafts(req: InvoiceSearchRequest): Promise<IpcResult<InvoiceDto[]>>;
  findInvoiceByNumber(req: InvoiceNumberRequest): Promise<IpcResult<InvoiceViewDto | null>>;
  searchInvoices(req: InvoiceSearchRequest): Promise<IpcResult<InvoiceDto[]>>;

  listReconciliation(req: InvoiceIdRequest): Promise<IpcResult<ReconciliationDto[]>>;
  listReconciliationQueue(req: ReconciliationQueueRequest): Promise<IpcResult<ReconciliationQueueDto>>;
  resolveKeepCatalog(req: ReconciliationIdRequest): Promise<IpcResult<ReconciliationDto>>;
  resolveKeepInvoiceOnly(req: ReconciliationIdRequest): Promise<IpcResult<ReconciliationDto>>;
  resolveLinkProduct(req: ResolveLinkProductRequest): Promise<IpcResult<ReconciliationDto>>;
  resolveCreateProduct(req: ResolveCreateProductRequest): Promise<IpcResult<ReconciliationDto>>;
  resolveUpdateCatalog(req: ResolveUpdateCatalogRequest): Promise<IpcResult<ReconciliationDto>>;

  pickInvoiceLogo(): Promise<IpcResult<PickInvoiceLogoResponse>>;
  /** The renderer sends an INVOICE ID. Main loads the frozen invoice and owns the print. */
  printInvoice(req: InvoiceIdRequest): Promise<IpcResult<PrintInvoiceResponse>>;
  saveInvoicePdf(req: InvoiceIdRequest): Promise<IpcResult<ExportResponse>>;
}
