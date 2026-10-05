/**
 * The complete renderer ↔ main contract. These business operations are the ONLY things the UI can
 * ask the main process to do. There is deliberately no query, SQL, file or generic "invoke" channel.
 *
 * Money crosses this boundary as a string of minor units ("1250" = 12.50 USD), never a number.
 */
import type { PaymentMethod } from "../domain/sale";

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
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: MoneyDto;
  readonly lineTotal: MoneyDto;
}

export interface SaleDto {
  readonly id: string;
  readonly receiptNumber: number;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly currency: string;
  readonly subtotal: MoneyDto;
  readonly total: MoneyDto;
  readonly paymentMethod: PaymentMethod;
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
  readonly lines: ReadonlyArray<{ readonly productId: string; readonly quantity: number }>;
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

export interface IpcError {
  readonly code: string;
  readonly message: string;
}

export type IpcResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: IpcError };

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
}
