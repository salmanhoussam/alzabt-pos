/**
 * IPC handlers — pure functions from an untrusted payload to an IpcResult. No Electron import, so
 * every handler is tested in plain Node (tests/main/ipcHandlers.test.ts).
 *
 * Every payload is validated for EXACT shape: wrong types, missing keys and unexpected extra keys
 * are all rejected before the service is called. Business errors become { ok:false, code, message };
 * any other error becomes a generic INTERNAL error so internals never leak to the renderer.
 */
import type { PosService } from "../application/posService";
import { DomainError } from "../domain/errors";
import { assertPaymentMethod } from "../domain/sale";
import {
  parseMinor,
  toCatalogDto,
  toSaleDto,
  toTodaySalesDto,
  toVoidDto,
} from "../shared/dto";
import { CHANNELS, type ChannelName, type IpcResult } from "../shared/ipcContract";

type Handler = (payload: unknown) => IpcResult<unknown>;

/** A file the cashier picked in the main process's native dialog; null when they cancelled. */
export interface PickedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface IpcHandlerOptions {
  /** Shows the native "open file" dialog. Absent (tests, headless) means import is unavailable. */
  readonly pickCatalogFile?: () => PickedFile | null;
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

function noPayload(payload: unknown): void {
  if (payload !== undefined && payload !== null) invalid("This operation takes no payload");
}

function wrap(fn: (payload: unknown) => unknown): Handler {
  return (payload) => {
    try {
      return { ok: true, data: fn(payload) };
    } catch (err) {
      if (err instanceof DomainError) return { ok: false, error: { code: err.code, message: err.message } };
      console.error("[pos] internal error", err);
      return { ok: false, error: { code: "INTERNAL", message: "Unexpected error — the sale was not recorded" } };
    }
  };
}

export function createIpcHandlers(service: PosService, options: IpcHandlerOptions = {}): Record<ChannelName, Handler> {
  return {
    listCashiers: wrap((p) => {
      noPayload(p);
      return service.listCashiers();
    }),
    login: wrap((p) => {
      const o = exactObject(p, ["cashierId", "pin"]);
      return service.login(str(o.cashierId, "cashierId", 64), str(o.pin, "pin", 16));
    }),
    logout: wrap((p) => {
      noPayload(p);
      service.logout();
      return null;
    }),
    currentCashier: wrap((p) => {
      noPayload(p);
      return service.currentCashier();
    }),
    getCatalog: wrap((p) => {
      noPayload(p);
      return toCatalogDto(service.getCatalog());
    }),
    createSale: wrap((p) => {
      const o = exactObject(p, ["idempotencyKey", "lines", "paymentMethod", "expectedTotalMinor"]);
      if (!Array.isArray(o.lines) || o.lines.length === 0 || o.lines.length > 200) invalid("'lines' must be a non-empty array");
      const lines = o.lines.map((raw) => {
        const l = exactObject(raw, ["productId", "quantity"]);
        if (typeof l.quantity !== "number" || !Number.isSafeInteger(l.quantity)) invalid("'quantity' must be an integer");
        return { productId: str(l.productId, "productId", 64), quantity: l.quantity };
      });
      assertPaymentMethod(o.paymentMethod);
      const result = service.createSale({
        idempotencyKey: str(o.idempotencyKey, "idempotencyKey", 100),
        lines,
        paymentMethod: o.paymentMethod,
        expectedTotalMinor: parseMinor(o.expectedTotalMinor),
      });
      return { sale: toSaleDto(result.sale), duplicate: result.duplicate };
    }),
    voidSale: wrap((p) => {
      const o = exactObject(p, ["saleId", "reason"]);
      return toVoidDto(service.voidSale(str(o.saleId, "saleId", 64), str(o.reason, "reason", 400)));
    }),
    getTodaySales: wrap((p) => {
      noPayload(p);
      return toTodaySalesDto(service.getTodaySales());
    }),
    getSaleHistory: wrap((p) => {
      const o = exactObject(p, ["limit"]);
      if (typeof o.limit !== "number" || !Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > 200) {
        invalid("'limit' must be an integer between 1 and 200");
      }
      return service.getSaleHistory(o.limit).map((h) => ({ sale: toSaleDto(h.sale), void: h.void ? toVoidDto(h.void) : null }));
    }),
    importCatalog: wrap((p) => {
      noPayload(p);
      // Logged-in check BEFORE any dialog opens; the service checks again.
      if (!service.currentCashier()) throw new DomainError("NOT_LOGGED_IN", "A cashier must be logged in");
      if (!options.pickCatalogFile) throw new DomainError("NOT_AVAILABLE", "Catalog import is not available here");
      const file = options.pickCatalogFile();
      if (!file) return { status: "cancelled" };
      return service.importCatalogCsv(file.name, file.bytes);
    }),
  };
}

/** Every handler maps to exactly one fixed channel string. */
export const CHANNEL_NAMES = Object.keys(CHANNELS) as ChannelName[];
