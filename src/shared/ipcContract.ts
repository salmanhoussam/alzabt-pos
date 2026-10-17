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
  // Migration 8 — operator accounts. `completeBootstrapSetup` is PUBLIC and takes a one-operator
  // setup ticket; the six management channels are owner-only (src/main/channelPolicy.ts).
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
  // ── Product Master (migration 9) ─────────────────────────────────────────────────────────────
  //
  // 🔴 THERE IS NO CHANNEL THAT CARRIES IMAGE BYTES INTO MAIN. `setProductImage` names a product
  // and nothing else; main runs the picker, decodes and normalizes, exactly as `pickInvoiceLogo`
  // already does for the invoice logo. The renderer never supplies a path or a buffer.
  listCategories: "pos:listCategories",
  listBrands: "pos:listBrands",
  createCategory: "pos:createCategory",
  renameCategory: "pos:renameCategory",
  setCategoryActive: "pos:setCategoryActive",
  deleteCategory: "pos:deleteCategory",
  getProductImageMeta: "pos:getProductImageMeta",
  getProductImageBytes: "pos:getProductImageBytes",
  setProductImage: "pos:setProductImage",
  removeProductImage: "pos:removeProductImage",
  // ── Phone entry over the LAN (slice H1) ──────────────────────────────────────────────────────
  //
  // 🔴 NEITHER CHANNEL EVER RETURNS THE TOKEN. `startPhoneSession` answers with the QR to show and
  // the address to read out for support — the secret is inside the encoded URL and nowhere else in
  // the DTO, so a renderer (or a screenshot of one) cannot leak a reusable credential.
  startPhoneSession: "pos:startPhoneSession",
  cancelPhoneSession: "pos:cancelPhoneSession",
  phoneSessionState: "pos:phoneSessionState",
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
} as const;

export type ChannelName = keyof typeof CHANNELS;

export interface MoneyDto {
  readonly minor: string;
  readonly currency: string;
}

export interface CashierDto {
  readonly id: string;
  readonly name: string;
  /** Migration 8. Present on a SESSION; the login list deliberately carries only id and name. */
  readonly role?: OperatorRoleDto;
  /**
   * Migration 11. Present on a SESSION only, and CONVENIENCE ONLY: it decides which buttons are
   * worth drawing, never whether an act is allowed. The service re-reads the durable row on every
   * create, so a stale `true` here buys a renderer nothing but a refusal.
   */
  readonly mayCreateProducts?: boolean;
}

export type OperatorRoleDto = "owner" | "admin" | "cashier";

/** An operator as the owner's management list sees them. No salt, no hash — there is nothing to show. */
export interface OperatorDto {
  readonly id: string;
  readonly name: string;
  readonly role: OperatorRoleDto;
  readonly isActive: boolean;
  readonly mustResetPin: boolean;
  /** Migration 11 — the narrow "may add products" grant. Meaningless on an owner, who always may. */
  readonly mayCreateProducts: boolean;
}

/**
 * What `login` answers.
 *
 * 🔴 TWO OUTCOMES, NOT A SESSION WITH A FLAG. A legacy bootstrap credential yields `setup` and NO
 * session, so there is no logged-in state for a reload to find and nothing for the rest of the API
 * to accept. The ticket is the only thing it buys, and `completeBootstrapSetup` is the only channel
 * that takes one.
 */
export type LoginResponse =
  | { readonly status: "session"; readonly cashier: CashierDto }
  | { readonly status: "setup"; readonly ticket: string; readonly operatorId: string; readonly name: string };

export interface CompleteSetupRequest {
  readonly ticket: string;
  readonly name: string;
  readonly pin: string;
}

export interface CreateOperatorRequest {
  readonly name: string;
  readonly role: OperatorRoleDto;
  readonly pin: string;
}

export interface OperatorIdRequest {
  readonly operatorId: string;
}

export interface RenameOperatorRequest extends OperatorIdRequest {
  readonly name: string;
}

export interface ResetOperatorPinRequest extends OperatorIdRequest {
  readonly pin: string;
}

export interface SetOperatorActiveRequest extends OperatorIdRequest {
  readonly isActive: boolean;
}

export interface SetOperatorRoleRequest extends OperatorIdRequest {
  readonly role: OperatorRoleDto;
}

export interface SetOperatorMayCreateProductsRequest extends OperatorIdRequest {
  readonly mayCreateProducts: boolean;
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

/**
 * What a finished Online Catalog export tells the owner.
 *
 * 🔴 `folderName`, NOT A PATH. The owner chose the parent folder a moment ago, so naming the
 * package inside it is all they need — and an absolute path on screen is one that ends up in a
 * screenshot, a support email, or a log, carrying the operator's Windows username with it.
 */
export interface OnlineCatalogExportDto {
  readonly folderName: string;
  readonly products: number;
  readonly images: number;
  /** Exported products missing a photo, English name, category, brand or description. */
  readonly incomplete: number;
}

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
  // ── Product Master (migration 9) ─────────────────────────────────────────────────────────────
  //
  // 🔴 EVERY ONE OF THESE IS OPTIONAL FOR SELLING, and they travel on the ordinary list because
  // they are small: an id, a code and some text. What does NOT travel is the photo — `hasImage` is
  // a boolean computed from one small query over the image table, never the bytes. The products
  // screen renders every product, and a blob here would load the shop's whole photo library to
  // draw a list that shows none of them.
  readonly categoryId: string | null;
  /** Canonical form only — a 12-digit UPC-A is already its 13-digit EAN-13 here. */
  readonly barcode: string | null;
  readonly brand: string | null;
  readonly descriptionAr: string | null;
  readonly descriptionEn: string | null;
  readonly isOnlineVisible: boolean;
  // ── The product's photo, as STATE rather than as an image ────────────────────────────────────
  //
  // 🔴 EXACTLY ENOUGH TO DRAW A LIST AND THEN ASK FOR WHAT IS ON SCREEN. `hasImage` decides
  // thumbnail-or-placeholder with no further call; `primaryImageId` is what
  // `getProductImageBytes` takes; `imageVersion` is the stored CONTENT HASH, so a renderer cache
  // keyed on it is exact — replacing a photo changes the key, and nothing has to guess whether a
  // cached thumbnail is stale. Three small scalars, and still not one byte of any photo.
  readonly hasImage: boolean;
  readonly primaryImageId: string | null;
  readonly imageMime: "image/jpeg" | "image/png" | null;
  /** The sha256 of the stored bytes. A cache key that cannot be wrong, not a version counter. */
  readonly imageVersion: string | null;
}

/** One category, as every surface sees it. Flat: there is no parent and no tree in V1. */
export interface CategoryDto {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly updatedAt: string;
}

/**
 * A product photo's metadata. There is no `bytes` field, in the DTO as in the repository row.
 *
 * 🔴 The absence is the contract, not an omission: a screen holding this object cannot reach the
 * image data, so it must ask for it by name through `getProductImageBytes`.
 */
/**
 * Asking for a phone session. `productId` is present only for an edit.
 *
 * 🔴 The renderer names an ACTION and, for an edit, a product. It cannot choose the port, the
 * address, the token or the expiry — all four are main's, so a compromised or buggy renderer
 * cannot widen the surface or weaken the credential.
 */
export interface StartPhoneSessionRequest {
  readonly action: "NEW_PRODUCT" | "EDIT_PRODUCT";
  readonly productId?: string | null;
}

/** One plausible LAN address, offered when the machine has more than one real candidate. */
export interface LanCandidateDto {
  readonly interfaceName: string;
  readonly address: string;
  readonly note: string;
}

/**
 * What the desktop needs to display a pairing QR — and deliberately not one field more.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IS ABSENT IS THE CONTRACT. There is no `token`, no `url`, no operator id, no operator
 * name, no product name and no database path. The token exists only inside `qrSvg`'s encoded
 * symbol, which is the one place it has to be, because that is what the phone's camera reads.
 *
 * `host` and `port` ARE present: the approved design requires a visible address so a merchant
 * whose phone cannot connect can be asked to read it out, and so a future retry UI can offer the
 * other adapter. An address is not a secret — the token is.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface PhoneSessionDto {
  readonly action: "NEW_PRODUCT" | "EDIT_PRODUCT";
  readonly host: string;
  readonly port: number;
  /** ISO-8601. The desktop counts down from this rather than inventing its own ten minutes. */
  readonly expiresAt: string;
  /** A self-contained SVG. No object URL, no `blob:`, nothing for the renderer's CSP to refuse. */
  readonly qrSvg: string;
  /** True when the machine had more than one real candidate and this one was a best guess. */
  readonly addressAmbiguous: boolean;
  /** Every plausible address, when ambiguous — so a retry path exists without re-measuring. */
  readonly addressCandidates: readonly LanCandidateDto[];
}

/**
 * The live state of the phone session, for the desktop dialog.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY POLLING RATHER THAN A PUSH EVENT. This bridge has no main→renderer event channel and
 * never has: every one of the 60-odd channels is a request the renderer makes. Adding a push
 * channel for one dialog would be a new direction of travel across the contextIsolation boundary,
 * and the thing it would carry — "the phone saved" — is checkable in a poll the dialog is already
 * running to count down the expiry. So the smaller change is the honest one.
 *
 * 🔴 `saved` IS REPORTED EXACTLY ONCE. The bridge clears it on read, so a dialog that keeps
 * polling does not re-announce a save the owner has already been shown.
 *
 * 🔴 AND THERE IS NO TOKEN HERE EITHER. The states are what the owner needs to see; the credential
 * stays inside the QR symbol.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface PhoneSessionState {
  /**
   * `waiting` — open, no phone has scanned yet.
   * `claimed` — a phone has the form open.
   * `saved`   — a product was saved; `savedProductId` names it. Reported once.
   * `closed`  — nothing open (cancelled, expired, or never started).
   */
  readonly state: "waiting" | "claimed" | "saved" | "closed";
  readonly savedProductId: string | null;
  readonly action: "NEW_PRODUCT" | "EDIT_PRODUCT" | null;
  /** ISO-8601 while the session is live, so the dialog counts down from the real deadline. */
  readonly expiresAt: string | null;
  readonly claimed: boolean;
}

export interface ProductImageMetaDto {
  readonly id: string;
  readonly productId: string;
  readonly mime: "image/jpeg" | "image/png";
  readonly sha256Hex: string;
  readonly byteSize: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly origin: "desktop" | "phone";
  readonly updatedAt: string;
}

/**
 * The bytes of one named photo, with the metadata to interpret them.
 *
 * A `Uint8Array` rather than a Buffer: that is what a structured clone delivers to the renderer,
 * and naming it honestly stops a caller assuming Buffer methods that will not be there.
 */
export interface ProductImageBytesDto {
  readonly meta: ProductImageMetaDto;
  readonly bytes: Uint8Array;
}

/**
 * What the operator typed. Optional fields are null when not given — never an empty string.
 *
 * `master` is OPTIONAL AS A WHOLE. Omitting it means this caller does not deal in enrichment, which
 * is what the import path and invoice reconciliation mean; it never means "clear those fields".
 */
export interface ProductDraftRequest {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string | null;
  readonly price: string;
  readonly baseUnit: string;
  readonly master?: ProductMasterPatch;
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

/**
 * The Product Master enrichment group, as a PATCH.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 EVERY KEY IS OPTIONAL, AND ABSENT IS NOT NULL. An absent key means "this caller is not
 * touching that field"; `null` means "clear it". They are different on the wire, in the handler, in
 * the domain and in the repository, and the whole chain exists so that the import path and invoice
 * reconciliation — neither of which knows what a category is — cannot erase a category, a brand or
 * a description the owner typed simply by saving a product.
 *
 * This is why it is a patch and not six more fields on `ProductDraftRequest`: an exact-shape object
 * would force every caller to send all six, and a caller that does not know them would send nulls.
 * The invoice header patch (`InvoiceHeaderPatch`) is the same shape for the same reason.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ProductMasterPatch {
  readonly categoryId?: string | null;
  /** Raw, as typed or as a decoder returned it. Main canonicalizes; a screen never pre-processes. */
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly descriptionAr?: string | null;
  readonly descriptionEn?: string | null;
  readonly isOnlineVisible?: boolean;
}

/** The patch keys, as data, so the preload bridge and the handler cannot drift from this list. */
export const PRODUCT_MASTER_PATCH_KEYS = [
  "categoryId",
  "barcode",
  "brand",
  "descriptionAr",
  "descriptionEn",
  "isOnlineVisible",
] as const satisfies ReadonlyArray<keyof ProductMasterPatch>;

export type ProductMasterPatchKey = (typeof PRODUCT_MASTER_PATCH_KEYS)[number];

export interface CreateCategoryRequest {
  readonly nameAr: string;
  readonly nameEn: string | null;
}

export interface RenameCategoryRequest {
  readonly categoryId: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
}

export interface SetCategoryActiveRequest {
  readonly categoryId: string;
  readonly isActive: boolean;
}

export interface CategoryIdRequest {
  readonly categoryId: string;
}

export interface ProductIdRequest {
  readonly productId: string;
}

export interface ImageIdRequest {
  readonly imageId: string;
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
  /** The immutable content-addressed copy frozen at finalization. Null on pre-freeze invoices. */
  readonly logoAsset: string | null;
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

/**
 * Several typed lines, added in ONE transaction.
 *
 * 🔴 WHY A BATCH EXISTS AT ALL. `addInvoiceLine` is one line, one transaction — correct for a
 * single row, and wrong for a sheet the operator filled in before saving anything. Looping it N
 * times is N transactions: a refusal on row 4 would leave rows 1-3 persisted and rows 4-N not,
 * which is a half-written invoice. This adds all of them or none of them.
 */
export interface AddInvoiceLinesRequest {
  readonly invoiceId: string;
  readonly lines: ReadonlyArray<InvoiceLineRequest>;
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
  login(req: LoginRequest): Promise<IpcResult<LoginResponse>>;
  logout(): Promise<IpcResult<null>>;
  completeBootstrapSetup(req: CompleteSetupRequest): Promise<IpcResult<CashierDto>>;
  listOperators(): Promise<IpcResult<ReadonlyArray<OperatorDto>>>;
  createOperator(req: CreateOperatorRequest): Promise<IpcResult<OperatorDto>>;
  renameOperator(req: RenameOperatorRequest): Promise<IpcResult<OperatorDto>>;
  resetOperatorPin(req: ResetOperatorPinRequest): Promise<IpcResult<OperatorDto>>;
  setOperatorActive(req: SetOperatorActiveRequest): Promise<IpcResult<OperatorDto>>;
  setOperatorRole(req: SetOperatorRoleRequest): Promise<IpcResult<OperatorDto>>;
  setOperatorMayCreateProducts(req: SetOperatorMayCreateProductsRequest): Promise<IpcResult<OperatorDto>>;
  currentCashier(): Promise<IpcResult<CashierDto | null>>;
  getCatalog(): Promise<IpcResult<CatalogDto>>;
  createSale(req: CreateSaleRequest): Promise<IpcResult<CreateSaleResponse>>;
  voidSale(req: VoidSaleRequest): Promise<IpcResult<VoidDto>>;
  getTodaySales(): Promise<IpcResult<TodaySalesDto>>;
  getSaleHistory(req: HistoryRequest): Promise<IpcResult<SaleWithVoidDto[]>>;
  importCatalog(): Promise<IpcResult<ImportCatalogResponse>>;
  exportCatalog(): Promise<IpcResult<ExportResponse>>;
  /**
   * Writes the Online Catalog package to a folder the OWNER chooses.
   *
   * 🔴 NO PAYLOAD, AND NO PATH IN EITHER DIRECTION. The renderer names nothing: main shows the
   * directory picker, main writes, and what comes back is a narrow summary. A renderer that could
   * name a destination would be a filesystem write primitive, which is the one thing this bridge
   * has never granted. `null` means the owner cancelled — not an error, and nothing was written.
   */
  exportOnlineCatalog(): Promise<IpcResult<OnlineCatalogExportDto | null>>;
  exportBackup(): Promise<IpcResult<ExportResponse>>;
  getAppInfo(): Promise<IpcResult<AppInfoDto>>;
  listProducts(): Promise<IpcResult<AdminProductDto[]>>;
  createProduct(req: CreateProductRequest): Promise<IpcResult<AdminProductDto>>;
  updateProduct(req: UpdateProductRequest): Promise<IpcResult<AdminProductDto>>;
  setProductActive(req: SetProductActiveRequest): Promise<IpcResult<AdminProductDto>>;

  // ── Product Master (migration 9) ─────────────────────────────────────────────────────────────
  //
  // `listCategories` returns ACTIVE AND INACTIVE rows, deliberately: the form must still display
  // the retired category a product already carries, and it filters the chooser itself. A second
  // "active only" channel would invite a screen to pick the wrong one and lose a product's label.
  listCategories(): Promise<IpcResult<CategoryDto[]>>;
  listBrands(): Promise<IpcResult<string[]>>;
  createCategory(req: CreateCategoryRequest): Promise<IpcResult<CategoryDto>>;
  renameCategory(req: RenameCategoryRequest): Promise<IpcResult<CategoryDto>>;
  setCategoryActive(req: SetCategoryActiveRequest): Promise<IpcResult<CategoryDto>>;
  deleteCategory(req: CategoryIdRequest): Promise<IpcResult<{ readonly deletedId: string }>>;

  getProductImageMeta(req: ProductIdRequest): Promise<IpcResult<ProductImageMetaDto | null>>;
  /** Bytes, by image id, asked for on purpose. The only route to them. */
  getProductImageBytes(req: ImageIdRequest): Promise<IpcResult<ProductImageBytesDto>>;
  /** Names a product; MAIN runs the picker and owns the file. No bytes cross this bridge. */
  setProductImage(req: ProductIdRequest): Promise<IpcResult<ProductImageMetaDto | null>>;
  removeProductImage(req: ProductIdRequest): Promise<IpcResult<{ readonly removed: boolean }>>;

  // ── Phone entry over the LAN (slice H1) ──────────────────────────────────────────────────────
  /** Owner only. Opens a temporary listener and returns the QR to show. Never returns the token. */
  startPhoneSession(req: StartPhoneSessionRequest): Promise<IpcResult<PhoneSessionDto>>;
  /** Owner only. Closes whatever session is open; answers honestly when there was none. */
  cancelPhoneSession(): Promise<IpcResult<{ readonly closed: boolean }>>;
  /**
   * Owner only. What the open dialog polls: waiting / claimed / saved / closed. No token.
   *
   * 🔴 NAMED `...State`, NOT `...Status`, AND THE RENAME WAS FORCED BY A REAL ASSERTION.
   * `invoiceIpc.test.ts` requires that NO channel name matches `/status|setReconcil|markResolved|
   * setPrice|writeCatalog/i`, guarding against the renderer ever being able to set a
   * reconciliation status. `phoneSessionStatus` tripped it. The choice was to weaken a protective
   * assertion or to pick a more precise name; the name was wrong anyway, since the DTO's own field
   * is `state`.
   */
  phoneSessionState(): Promise<IpcResult<PhoneSessionState>>;

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
  addInvoiceLines(req: AddInvoiceLinesRequest): Promise<IpcResult<InvoiceViewDto>>;
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
