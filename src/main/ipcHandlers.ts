/**
 * IPC handlers — pure functions from an untrusted payload to an IpcResult. No Electron import, so
 * every handler is tested in plain Node (tests/main/ipcHandlers.test.ts).
 *
 * Every payload is validated for EXACT shape: wrong types, missing keys and unexpected extra keys
 * are all rejected before the service is called. Business errors become { ok:false, code, message };
 * any other error is logged and becomes a fixed message so internals never leak to the renderer.
 *
 * Unexpected-error messages tell the TRUTH for the channel that failed. createSale used to answer
 * "the sale was not recorded" for every channel and every failure — false when the error happened
 * after the commit, or when a concurrent attempt with the same idempotency key had committed it.
 * createSale now checks the ledger by the request's idempotency key and says "recorded",
 * "not recorded" or "unknown"; other channels never claim anything about sales.
 */
import type { PosService } from "../application/posService";
import { MAX_PRODUCT_ID_LENGTH } from "../domain/catalog";
import { DomainError } from "../domain/errors";
import { MAX_QUANTITY_MILLI } from "../domain/quantity";
import { assertPaymentMethod } from "../domain/sale";
import { isLanguage } from "../shared/i18n";
import type { TerminalSettings } from "../shared/i18n";
import { MAX_PRODUCT_NAME, MAX_SKU, type ProductDraft } from "../domain/productDraft";
import {
  parseMinor,
  toAdminProductDto,
  toCatalogDto,
  toSaleDto,
  toTodaySalesDto,
  toVoidDto,
} from "../shared/dto";
import { type AppInfoDto, CHANNELS, type ChannelName, type IpcError, type IpcResult } from "../shared/ipcContract";
import { type Logger, nullLogger } from "./logger";

type Handler = (payload: unknown) => IpcResult<unknown>;

/** A file the cashier picked in the main process's native dialog; null when they cancelled. */
export interface PickedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Result of a main-process save dialog + write; null when the cashier cancelled. */
export interface SavedFile {
  readonly fileName: string;
}

export interface IpcHandlerOptions {
  /** Shows the native "open file" dialog. Absent (tests, headless) means import is unavailable. */
  readonly pickCatalogFile?: () => PickedFile | null;
  /** Native "save as" dialog + atomic write of the exported catalog. Absent means unavailable. */
  readonly saveCatalogExport?: (suggestedName: string, contents: string) => SavedFile | null;
  /** Native "save as" dialog + verified consistent snapshot of the ledger. Absent means unavailable. */
  readonly exportBackup?: () => SavedFile | null;
  /** Version/build identity of this installation. */
  readonly appInfo?: () => AppInfoDto;
  /** Called after a NEW sale is committed (the daily-backup trigger). Must not throw. */
  readonly afterSale?: () => void;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** Operator settings (language). Absent (tests, headless) means the defaults are reported. */
  readonly settings?: {
    get(): TerminalSettings;
    setTerminalLanguage(lang: "ar" | "en"): TerminalSettings;
  };
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function exactObject(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) invalid("Expected an object");
  const actual = Object.keys(payload);
  const extra = actual.filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !actual.includes(k));
  if (extra.length || missing.length) {
    invalid(`Unexpected fields [${extra.join(", ")}] / missing fields [${missing.join(", ")}]`);
  }
  return payload as Record<string, unknown>;
}

function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid(`'${field}' must be a string`);
  return value;
}

/** An optional text field: null, undefined and "" all mean "not given". */
function optionalStr(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") invalid(`'${field}' must be text`);
  if (value.length > max) invalid(`'${field}' must be at most ${max} characters`);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`'${field}' must be true or false`);
  return value;
}

/**
 * The product form's exact shape. Validation of MEANING (a required Arabic name, an exact price, a
 * known unit) belongs to the domain — `validateProductDraft` — not here; this only refuses a
 * payload that is not the right shape, so a malformed IPC call never reaches the service.
 */
function productDraft(value: unknown): ProductDraft {
  const d = exactObject(value, ["nameAr", "nameEn", "sku", "price", "baseUnit"]);
  return {
    nameAr: str(d.nameAr, "nameAr", MAX_PRODUCT_NAME),
    nameEn: optionalStr(d.nameEn, "nameEn", MAX_PRODUCT_NAME),
    sku: optionalStr(d.sku, "sku", MAX_SKU),
    price: str(d.price, "price", 32),
    baseUnit: str(d.baseUnit, "baseUnit", 32),
  };
}

function noPayload(payload: unknown): void {
  if (payload !== undefined && payload !== null) invalid("This operation takes no payload");
}

const GENERIC_INTERNAL: IpcError = {
  code: "INTERNAL",
  message: "Unexpected error. Please try again; if it keeps happening, contact support.",
};

/** What the cashier is told after an unexpected error in createSale, decided by reading the ledger. */
export function saleFailureTruth(service: PosService, payload: unknown): IpcError {
  const key =
    payload && typeof payload === "object" && typeof (payload as { idempotencyKey?: unknown }).idempotencyKey === "string"
      ? (payload as { idempotencyKey: string }).idempotencyKey
      : null;
  if (key === null) return { code: "SALE_NOT_RECORDED", message: "Unexpected error — the sale was not recorded." };
  try {
    const sale = service.saleForIdempotencyKey(key);
    return sale
      ? {
          code: "SALE_RECORDED",
          message: `The sale WAS recorded (receipt #${sale.receiptNumber}) but an unexpected error followed. Check History — do not ring it up again.`,
        }
      : { code: "SALE_NOT_RECORDED", message: "Unexpected error — the sale was not recorded. You can try again." };
  } catch {
    return {
      code: "SALE_STATUS_UNKNOWN",
      message: "Unexpected error — it is not known whether the sale was recorded. Check History before trying again.",
    };
  }
}

export function createIpcHandlers(service: PosService, options: IpcHandlerOptions = {}): Record<ChannelName, Handler> {
  const log = options.logger ?? nullLogger;
  const now = options.now ?? (() => new Date());

  function wrap(channel: ChannelName, fn: (payload: unknown) => unknown, onInternal?: (payload: unknown) => IpcError): Handler {
    return (payload) => {
      try {
        return { ok: true, data: fn(payload) };
      } catch (err) {
        if (err instanceof DomainError) return { ok: false, error: { code: err.code, message: err.message } };
        log.error("ipc-internal-error", { channel, error: err });
        console.error("[pos] internal error", channel, err);
        return { ok: false, error: onInternal ? onInternal(payload) : GENERIC_INTERNAL };
      }
    };
  }

  const stamp = () => now().toISOString().slice(0, 10).replace(/-/g, "");

  return {
    listCashiers: wrap("listCashiers", (p) => {
      noPayload(p);
      return service.listCashiers();
    }),
    login: wrap("login", (p) => {
      const o = exactObject(p, ["cashierId", "pin"]);
      return service.login(str(o.cashierId, "cashierId", 64), str(o.pin, "pin", 16));
    }),
    logout: wrap("logout", (p) => {
      noPayload(p);
      service.logout();
      return null;
    }),
    currentCashier: wrap("currentCashier", (p) => {
      noPayload(p);
      return service.currentCashier();
    }),
    getCatalog: wrap("getCatalog", (p) => {
      noPayload(p);
      return toCatalogDto(service.getCatalog());
    }),
    createSale: wrap("createSale", (p) => {
      const o = exactObject(p, ["idempotencyKey", "lines", "paymentMethod", "expectedTotalMinor"]);
      if (!Array.isArray(o.lines) || o.lines.length === 0 || o.lines.length > 200) invalid("'lines' must be a non-empty array");
      const lines = o.lines.map((raw) => {
        const l = exactObject(raw, ["productId", "quantityMilli"]);
        // Thousandths of a sale unit, as an integer. The unit's own rule (whole-only vs fractional)
        // needs the catalog and is applied in the domain, not here.
        if (
          typeof l.quantityMilli !== "number" ||
          !Number.isSafeInteger(l.quantityMilli) ||
          l.quantityMilli < 1 ||
          l.quantityMilli > MAX_QUANTITY_MILLI
        ) {
          invalid(`'quantityMilli' must be an integer between 1 and ${MAX_QUANTITY_MILLI}`);
        }
        return {
          productId: str(l.productId, "productId", MAX_PRODUCT_ID_LENGTH),
          quantityMilli: l.quantityMilli as number,
        };
      });
      assertPaymentMethod(o.paymentMethod);
      const result = service.createSale({
        idempotencyKey: str(o.idempotencyKey, "idempotencyKey", 100),
        lines,
        paymentMethod: o.paymentMethod,
        expectedTotalMinor: parseMinor(o.expectedTotalMinor),
      });
      if (!result.duplicate) {
        try {
          options.afterSale?.();
        } catch (err) {
          log.warn("after-sale-hook-failed", { error: err });
        }
      }
      return { sale: toSaleDto(result.sale), duplicate: result.duplicate };
    }, (p) => saleFailureTruth(service, p)),
    voidSale: wrap("voidSale", (p) => {
      const o = exactObject(p, ["saleId", "reason"]);
      return toVoidDto(service.voidSale(str(o.saleId, "saleId", 64), str(o.reason, "reason", 400)));
    }),
    getTodaySales: wrap("getTodaySales", (p) => {
      noPayload(p);
      return toTodaySalesDto(service.getTodaySales());
    }),
    getSaleHistory: wrap("getSaleHistory", (p) => {
      const o = exactObject(p, ["limit"]);
      if (typeof o.limit !== "number" || !Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > 200) {
        invalid("'limit' must be an integer between 1 and 200");
      }
      return service.getSaleHistory(o.limit).map((h) => ({ sale: toSaleDto(h.sale), void: h.void ? toVoidDto(h.void) : null }));
    }),
    importCatalog: wrap("importCatalog", (p) => {
      noPayload(p);
      // Logged-in check BEFORE any dialog opens; the service checks again.
      if (!service.currentCashier()) throw new DomainError("NOT_LOGGED_IN", "A cashier must be logged in");
      if (!options.pickCatalogFile) throw new DomainError("NOT_AVAILABLE", "Catalog import is not available here");
      const file = options.pickCatalogFile();
      if (!file) return { status: "cancelled" };
      const result = service.importCatalogCsv(file.name, file.bytes);
      log.info("catalog-import", result.status === "imported" ? { ...result } : { status: result.status, rejected: result.rejected.length });
      return result;
    }),
    exportCatalog: wrap("exportCatalog", (p) => {
      noPayload(p);
      if (!service.currentCashier()) throw new DomainError("NOT_LOGGED_IN", "A cashier must be logged in");
      if (!options.saveCatalogExport) throw new DomainError("NOT_AVAILABLE", "Catalog export is not available here");
      const { csv, productCount } = service.exportCatalogCsv();
      const saved = options.saveCatalogExport(`alzabt-pos-catalog-${stamp()}.csv`, csv);
      if (!saved) return { status: "cancelled" };
      log.info("catalog-export", { products: productCount });
      return { status: "saved", fileName: saved.fileName, productCount };
    }),
    exportBackup: wrap("exportBackup", (p) => {
      noPayload(p);
      if (!service.currentCashier()) throw new DomainError("NOT_LOGGED_IN", "A cashier must be logged in");
      if (!options.exportBackup) throw new DomainError("NOT_AVAILABLE", "Backup export is not available here");
      const saved = options.exportBackup();
      if (!saved) return { status: "cancelled" };
      return { status: "saved", fileName: saved.fileName };
    }),
    getAppInfo: wrap("getAppInfo", (p) => {
      noPayload(p);
      return options.appInfo?.() ?? { version: "unknown", build: "unknown" };
    }),

    // ── Product administration ──────────────────────────────────────────────────────────────────
    listProducts: wrap("listProducts", (p) => {
      noPayload(p);
      return service.listProducts().map(toAdminProductDto);
    }),
    createProduct: wrap("createProduct", (p) => {
      const o = exactObject(p, ["draft"]);
      const row = toAdminProductDto(service.createProduct(productDraft(o.draft)));
      log.info("product-created", { id: row.id, source: row.source, unit: row.baseUnit });
      return row;
    }),
    updateProduct: wrap("updateProduct", (p) => {
      const o = exactObject(p, ["id", "draft", "isActive"]);
      const row = toAdminProductDto(
        service.updateProduct(str(o.id, "id", MAX_PRODUCT_ID_LENGTH), productDraft(o.draft), bool(o.isActive, "isActive")),
      );
      log.info("product-updated", { id: row.id, source: row.source });
      return row;
    }),
    setProductActive: wrap("setProductActive", (p) => {
      const o = exactObject(p, ["id", "isActive"]);
      const row = toAdminProductDto(
        service.setProductActive(str(o.id, "id", MAX_PRODUCT_ID_LENGTH), bool(o.isActive, "isActive")),
      );
      log.info("product-active-changed", { id: row.id, isActive: row.isActive });
      return row;
    }),

    // ── Operator settings ───────────────────────────────────────────────────────────────────────
    getSettings: wrap("getSettings", (p) => {
      noPayload(p);
      return options.settings?.get() ?? { terminalLanguage: "ar", receiptLanguage: "ar" };
    }),
    setTerminalLanguage: wrap("setTerminalLanguage", (p) => {
      const o = exactObject(p, ["language"]);
      if (!isLanguage(o.language)) invalid("'language' must be 'ar' or 'en'");
      if (!options.settings) throw new DomainError("NOT_AVAILABLE", "Settings are not available here");
      return options.settings.setTerminalLanguage(o.language);
    }),
  };
}

/** Every handler maps to exactly one fixed channel string. */
export const CHANNEL_NAMES = Object.keys(CHANNELS) as ChannelName[];
