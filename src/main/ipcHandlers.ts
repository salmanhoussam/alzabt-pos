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
import type { SaleRecord } from "../domain/sale";
import { isLanguage } from "../shared/i18n";
import type { TerminalSettings } from "../shared/i18n";
import { MAX_PRODUCT_NAME, MAX_SKU, type ProductDraft } from "../domain/productDraft";
import {
  parseMinor,
  toAdminProductDto,
  toCatalogDto,
  toCompanyProfileDto,
  toInvoiceDto,
  toInvoiceViewDto,
  toReconciliationDto,
  toSaleDto,
  toTodaySalesDto,
  toVoidDto,
} from "../shared/dto";
import type { CatalogUpdateSelection, InvoiceLineDraft, InvoiceService } from "../application/invoiceService";
import { MAX_CUSTOMER_FIELD, MAX_DESCRIPTION, MAX_NOTES } from "../domain/invoice";
import { MAX_UNIT_LABEL } from "../domain/invoiceUnits";
import type { ReconciliationRow } from "../persistence/reconciliationRepository";
import {
  type AppInfoDto,
  CHANNELS,
  type ChannelName,
  INVOICE_HEADER_PATCH_KEYS,
  type InvoiceHeaderPatchKey,
  type IpcError,
  type IpcResult,
} from "../shared/ipcContract";
import { type Logger, nullLogger } from "./logger";
import { accessFor } from "./channelPolicy";

/**
 * A handler answers synchronously, or with a promise for the two channels that genuinely cannot:
 * printing and PDF generation are asynchronous in Electron. `ipcMain.handle` accepts either, and
 * `wrapAsync` below keeps the SAME error envelope either way — a rejected promise becomes the same
 * `{ ok: false, error }` a thrown error does, so no failure can escape as an unhandled rejection.
 */
type Handler = (payload: unknown) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

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
  /**
   * The manual-invoice service. Absent (an older wiring, a headless test) means every invoice
   * channel answers NOT_AVAILABLE rather than silently doing nothing.
   */
  readonly invoices?: InvoiceService;
  /**
   * Prints a FINALIZED invoice. Main is handed only an invoice id by the renderer; this callback
   * loads the frozen document itself and owns the print dialog. There is deliberately no channel
   * that accepts HTML, a path, or anything else executable from the renderer.
   */
  readonly printInvoice?: (invoiceId: string) => Promise<"printed" | "cancelled">;
  /** Save-as dialog + printToPDF of the frozen invoice. Null when the operator cancelled. */
  readonly saveInvoicePdf?: (invoiceId: string) => Promise<SavedFile | null>;
  /**
   * Native image picker. Main copies the chosen file into its own branding folder and returns a
   * BARE FILE NAME; the renderer never sees or supplies a path.
   */
  readonly pickInvoiceLogo?: () => string | null;
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

/**
 * A PATCH object: every key present must be one of `keys`, and a key may be absent.
 *
 * Deliberately NOT `exactObject`, which requires every listed key — that requirement is what forced
 * the renderer to send a whole header built from stale state. Unknown keys are still refused, so a
 * typo cannot silently do nothing.
 */
function patchObject(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    invalid("Expected a patch object");
  }
  const extra = Object.keys(payload).filter((k) => !keys.includes(k));
  if (extra.length) invalid(`Unexpected fields [${extra.join(", ")}]`);
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

/** A bounded positive integer. Refuses a float, a string and anything out of range. */
function count(value: unknown, field: string, min: number, max = 1_000_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`'${field}' must be a whole number between ${min} and ${max}`);
  }
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

  /**
   * 🔴 THE AUTHORIZATION GATE. It runs BEFORE the handler body, on every channel, for both the sync
   * and async wrappers — so a restricted action is refused whether or not any UI drew a button for
   * it. The renderer is the untrusted side of this bridge: `page.evaluate` on `window.pos` reaches
   * every channel directly, and an E2E test does exactly that to prove this is real.
   *
   * FAIL CLOSED: `accessFor` THROWS for a channel it does not know, and the policy table is typed
   * `Record<ChannelName, Access>` so an unclassified channel is a compile error in the first place.
   *
   * ONE refusal code for every restricted channel, deliberately: the operator learns that this
   * needs an owner, not which channels exist to probe.
   */
  function authorize(channel: ChannelName): void {
    const access = accessFor(channel);
    if (access === "public") return;
    // 🔴 LIVE. `requireLiveRole` re-reads the durable operator row and fails closed on a missing or
    // deactivated account, so a promotion or demotion takes effect on the NEXT action with no
    // logout and no restart, and a deactivated operator's session stops working immediately.
    const role = service.requireLiveRole();
    if (access === "owner" && role !== "owner") {
      // 'admin' exists in the schema CHECK as a reserved value and is never assignable, so it can
      // only arrive from a hand-edited database. It is NOT an owner, and lands here.
      throw new DomainError("NOT_AUTHORIZED", "Only the shop owner can do that");
    }
  }

  function wrap(channel: ChannelName, fn: (payload: unknown) => unknown, onInternal?: (payload: unknown) => IpcError): Handler {
    return (payload) => {
      try {
        authorize(channel);
        return { ok: true, data: fn(payload) };
      } catch (err) {
        if (err instanceof DomainError) return { ok: false, error: { code: err.code, message: err.message } };
        log.error("ipc-internal-error", { channel, error: err });
        console.error("[pos] internal error", channel, err);
        return { ok: false, error: onInternal ? onInternal(payload) : GENERIC_INTERNAL };
      }
    };
  }

  function wrapAsync(channel: ChannelName, fn: (payload: unknown) => Promise<unknown>): Handler {
    return async (payload) => {
      try {
        authorize(channel);
        return { ok: true, data: await fn(payload) };
      } catch (err) {
        if (err instanceof DomainError) return { ok: false, error: { code: err.code, message: err.message } };
        log.error("ipc-internal-error", { channel, error: err });
        console.error("[pos] internal error", channel, err);
        return { ok: false, error: GENERIC_INTERNAL };
      }
    };
  }

  const stamp = () => now().toISOString().slice(0, 10).replace(/-/g, "");

  /** The operator service, or a refusal. A terminal without accounts has no management surface. */
  function operators() {
    const svc = service.operatorAccounts();
    if (!svc) throw new DomainError("NOT_AVAILABLE", "Operator accounts are not available");
    return svc;
  }

  /**
   * A role from the renderer. 'admin' is refused HERE as well as in the service: it is reserved in
   * the schema so widening the CHECK later costs no rebuild, and it has no v1 behaviour.
   */
  function role(value: unknown): "owner" | "cashier" {
    if (value !== "owner" && value !== "cashier") invalid("'role' must be owner or cashier");
    return value;
  }

  /** The login/session shape, with the role the UI uses to hide what the service would refuse. */
  function cashierDto(c: { id: string; name: string }) {
    const r = service.currentRole();
    return r ? { id: c.id, name: c.name, role: r } : { id: c.id, name: c.name };
  }

  return {
    listCashiers: wrap("listCashiers", (p) => {
      noPayload(p);
      return service.listCashiers();
    }),
    login: wrap("login", (p) => {
      const o = exactObject(p, ["cashierId", "pin"]);
      const outcome = service.login(str(o.cashierId, "cashierId", 64), str(o.pin, "pin", 16));
      // 🔴 The SETUP outcome carries the ticket and NOTHING resembling a session, so a renderer
      // cannot mistake one for the other — and the only channel that accepts a ticket is
      // completeBootstrapSetup. The service's internal `kind` is mapped to the DTO's `status`
      // rather than leaked: the IPC contract is the boundary, not an echo of the service.
      if (outcome.kind === "setup") {
        return { status: "setup", ticket: outcome.ticket, operatorId: outcome.operatorId, name: outcome.name };
      }
      return { status: "session", cashier: cashierDto(outcome.session) };
    }),
    completeBootstrapSetup: wrap("completeBootstrapSetup", (p) => {
      const o = exactObject(p, ["ticket", "name", "pin"]);
      return cashierDto(
        service.completeBootstrapSetup(
          str(o.ticket, "ticket", 128),
          str(o.name, "name", 60),
          // 🔴 Bounded, and NOT validated for shape here. `domain/pinRule.ts` owns digits-only and
          // 4-8, so there is ONE definition every write path meets; a second copy here could drift.
          str(o.pin, "pin", 16),
        ),
      );
    }),
    listOperators: wrap("listOperators", (p) => {
      noPayload(p);
      return operators().listAll();
    }),
    createOperator: wrap("createOperator", (p) => {
      const o = exactObject(p, ["name", "role", "pin"]);
      return operators().create(service.requireOperatorSession(), {
        name: str(o.name, "name", 60),
        role: role(o.role),
        pin: str(o.pin, "pin", 16),
      });
    }),
    renameOperator: wrap("renameOperator", (p) => {
      const o = exactObject(p, ["operatorId", "name"]);
      return operators().rename(
        service.requireOperatorSession(),
        str(o.operatorId, "operatorId", 100),
        str(o.name, "name", 60),
      );
    }),
    resetOperatorPin: wrap("resetOperatorPin", (p) => {
      const o = exactObject(p, ["operatorId", "pin"]);
      return operators().resetPin(
        service.requireOperatorSession(),
        str(o.operatorId, "operatorId", 100),
        str(o.pin, "pin", 16),
      );
    }),
    setOperatorActive: wrap("setOperatorActive", (p) => {
      const o = exactObject(p, ["operatorId", "isActive"]);
      if (typeof o.isActive !== "boolean") invalid("'isActive' must be a boolean");
      return operators().setActive(
        service.requireOperatorSession(),
        str(o.operatorId, "operatorId", 100),
        o.isActive,
      );
    }),
    setOperatorRole: wrap("setOperatorRole", (p) => {
      const o = exactObject(p, ["operatorId", "role"]);
      return operators().setRole(
        service.requireOperatorSession(),
        str(o.operatorId, "operatorId", 100),
        role(o.role),
      );
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
      return { sale: toSaleDto(result.sale, invoiceNumberFor(result.sale)), duplicate: result.duplicate };
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
      return service.getSaleHistory(o.limit).map((h) => ({
        sale: toSaleDto(h.sale, invoiceNumberFor(h.sale)),
        void: h.void ? toVoidDto(h.void) : null,
      }));
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

    // ── Manual invoices (migration 6) ───────────────────────────────────────────────────────────
    //
    // 🔴 WHAT THE RENDERER CANNOT SEND, and the reason the shapes below look so narrow: no total,
    // no subtotal, no line total, no tax amount, no amount in words, no invoice number, no catalog
    // row, and no reconciliation status. `exactObject` refuses any extra key outright, so adding
    // `"total"` to a payload is rejected before the service is reached — not ignored.
    getCompanyProfile: wrap("getCompanyProfile", (p) => {
      noPayload(p);
      const row = invoices().getCompanyProfile();
      return row === null ? null : toCompanyProfileDto(row);
    }),
    saveCompanyProfile: wrap("saveCompanyProfile", (p) => {
      const o = exactObject(p, [
        "nameAr",
        "nameEn",
        "legalName",
        "tagline",
        "address",
        "phone1",
        "phone2",
        "email",
        "logoPath",
        "taxpayerNumber",
        "commercialRegister",
        "vatNumber",
        "taxEnabled",
        "taxRatePercent",
        "taxLabel",
      ]);
      const saved = invoices().saveCompanyProfile({
        nameAr: str(o.nameAr, "nameAr", MAX_PRODUCT_NAME),
        nameEn: optionalStr(o.nameEn, "nameEn", MAX_PRODUCT_NAME),
        legalName: optionalStr(o.legalName, "legalName", MAX_PRODUCT_NAME),
        tagline: optionalStr(o.tagline, "tagline", MAX_CUSTOMER_FIELD),
        address: optionalStr(o.address, "address", MAX_NOTES),
        phone1: optionalStr(o.phone1, "phone1", MAX_CUSTOMER_FIELD),
        phone2: optionalStr(o.phone2, "phone2", MAX_CUSTOMER_FIELD),
        email: optionalStr(o.email, "email", MAX_CUSTOMER_FIELD),
        logoPath: optionalStr(o.logoPath, "logoPath", MAX_NOTES),
        // Three separate identifiers, carried separately all the way through the boundary.
        taxpayerNumber: optionalStr(o.taxpayerNumber, "taxpayerNumber", MAX_CUSTOMER_FIELD),
        commercialRegister: optionalStr(o.commercialRegister, "commercialRegister", MAX_CUSTOMER_FIELD),
        vatNumber: optionalStr(o.vatNumber, "vatNumber", MAX_CUSTOMER_FIELD),
        taxEnabled: bool(o.taxEnabled, "taxEnabled"),
        taxRatePercent: optionalStr(o.taxRatePercent, "taxRatePercent", 8),
        taxLabel: optionalStr(o.taxLabel, "taxLabel", MAX_CUSTOMER_FIELD),
      });
      log.info("company-profile-saved", { taxEnabled: saved.tax_enabled === 1n });
      return toCompanyProfileDto(saved);
    }),
    setNextInvoiceNumber: wrap("setNextInvoiceNumber", (p) => {
      const o = exactObject(p, ["nextInvoiceNumber"]);
      return toCompanyProfileDto(invoices().setNextInvoiceNumber(count(o.nextInvoiceNumber, "nextInvoiceNumber", 1)));
    }),

    createInvoiceDraft: wrap("createInvoiceDraft", (p) => {
      noPayload(p);
      const view = invoices().createDraft();
      log.info("invoice-draft-created", { id: view.invoice.id });
      return toInvoiceViewDto(view);
    }),
    getInvoice: wrap("getInvoice", (p) => toInvoiceViewDto(invoices().getInvoice(invoiceId(p)))),
    updateInvoiceHeader: wrap("updateInvoiceHeader", (p) => {
      const o = exactObject(p, ["invoiceId", "patch"]);
      // 🔴 ONLY THE KEYS THE OPERATOR ACTUALLY CHANGED ARE BUILT INTO THE DRAFT. Every key left out
      // of the patch is left out of the object handed to the service, so the service's
      // `header.X !== undefined ? clean(X) : invoice.X` reads it from the CURRENT ROW. That logic
      // was always written correctly and was unreachable, because the old payload demanded every
      // field and `optionalStr` turned a missing one into an explicit null.
      const draft: Record<string, string | null> = {};
      const limits: Record<InvoiceHeaderPatchKey, number> = {
        invoiceDate: 10,
        customerName: MAX_CUSTOMER_FIELD,
        customerAddress: MAX_NOTES,
        customerPhone: MAX_CUSTOMER_FIELD,
        notes: MAX_NOTES,
        // A typed decimal, parsed by the domain. Never a balance the renderer worked out.
        paid: 32,
      };
      const patch = patchObject(o.patch, INVOICE_HEADER_PATCH_KEYS);
      for (const key of INVOICE_HEADER_PATCH_KEYS) {
        if (!(key in patch)) continue;
        draft[key] = optionalStr(patch[key], key, limits[key]);
      }
      return toInvoiceViewDto(invoices().updateDraftHeader(str(o.invoiceId, "invoiceId", 100), draft));
    }),
    setInvoiceTax: wrap("setInvoiceTax", (p) => {
      const o = exactObject(p, ["invoiceId", "enabled", "ratePercent", "label"]);
      if (typeof o.enabled !== "boolean") invalid("'enabled' must be true or false");
      return toInvoiceViewDto(
        invoices().setInvoiceTax(str(o.invoiceId, "invoiceId", 100), {
          enabled: o.enabled,
          // Typed text. The domain turns it into exact basis points; this layer never does maths.
          ratePercent: optionalStr(o.ratePercent, "ratePercent", 8),
          label: optionalStr(o.label, "label", MAX_CUSTOMER_FIELD),
        }),
      );
    }),
    addInvoiceLine: wrap("addInvoiceLine", (p) => {
      const o = exactObject(p, ["invoiceId", "line"]);
      return toInvoiceViewDto(invoices().addLine(str(o.invoiceId, "invoiceId", 100), invoiceLine(o.line)));
    }),
    addInvoiceLines: wrap("addInvoiceLines", (p) => {
      const o = exactObject(p, ["invoiceId", "lines"]);
      if (!Array.isArray(o.lines) || o.lines.length === 0) {
        invalid("'lines' must be a non-empty array");
      }
      return toInvoiceViewDto(
        invoices().addLines(
          str(o.invoiceId, "invoiceId", 100),
          o.lines.map((l) => invoiceLine(l)),
        ),
      );
    }),
    updateInvoiceLine: wrap("updateInvoiceLine", (p) => {
      const o = exactObject(p, ["invoiceId", "lineId", "line"]);
      return toInvoiceViewDto(
        invoices().updateLine(str(o.invoiceId, "invoiceId", 100), str(o.lineId, "lineId", 100), invoiceLine(o.line)),
      );
    }),
    removeInvoiceLine: wrap("removeInvoiceLine", (p) => {
      const o = exactObject(p, ["invoiceId", "lineId"]);
      return toInvoiceViewDto(
        invoices().removeLine(str(o.invoiceId, "invoiceId", 100), str(o.lineId, "lineId", 100)),
      );
    }),
    discardInvoiceDraft: wrap("discardInvoiceDraft", (p) => {
      invoices().discardDraft(invoiceId(p));
      return null;
    }),

    finalizeInvoice: wrap("finalizeInvoice", (p) => {
      // The payload is an id and nothing else: every frozen value is computed in the service.
      const view = invoices().finalizeInvoice(invoiceId(p));
      log.info("invoice-finalized", {
        id: view.invoice.id,
        number: Number(view.invoice.invoice_number),
        lines: view.lines.length,
      });
      return toInvoiceViewDto(view);
    }),

    listInvoices: wrap("listInvoices", (p) => {
      const o = search(p);
      return invoices().listFinalized(o.limit, 0).map(toInvoiceDto);
    }),
    listInvoiceDrafts: wrap("listInvoiceDrafts", (p) => {
      const o = search(p);
      return invoices().listDrafts(o.limit).map(toInvoiceDto);
    }),
    findInvoiceByNumber: wrap("findInvoiceByNumber", (p) => {
      const o = exactObject(p, ["invoiceNumber"]);
      const found = invoices().findFinalizedByNumber(count(o.invoiceNumber, "invoiceNumber", 1));
      return found === null ? null : toInvoiceViewDto(found);
    }),
    searchInvoices: wrap("searchInvoices", (p) => {
      const o = search(p);
      return invoices().searchFinalized(o.term, o.limit).map(toInvoiceDto);
    }),

    listReconciliation: wrap("listReconciliation", (p) => {
      const id = invoiceId(p);
      return invoices()
        .listReconciliation(id)
        .map((row) => reconciliationDto(row));
    }),
    listReconciliationQueue: wrap("listReconciliationQueue", (p) => {
      const o = exactObject(p, ["filter", "limit"]);
      const filter = o.filter;
      if (filter !== "unresolved" && filter !== "failed" && filter !== "resolved" && filter !== "all") {
        invalid("'filter' must be 'unresolved', 'failed', 'resolved' or 'all'");
      }
      const limit = count(o.limit, "limit", 1, 500);
      const counts = invoices().reconciliationCounts();
      return {
        items: invoices()
          .listReconciliationByFilter(filter, limit)
          .map((row) => reconciliationDto(row)),
        unresolved: counts.unresolved,
        byStatus: counts.byStatus,
      };
    }),
    resolveKeepCatalog: wrap("resolveKeepCatalog", (p) =>
      reconciliationDto(invoices().keepCatalog(reconciliationId(p))),
    ),
    resolveKeepInvoiceOnly: wrap("resolveKeepInvoiceOnly", (p) =>
      reconciliationDto(invoices().keepInvoiceOnly(reconciliationId(p))),
    ),
    resolveLinkProduct: wrap("resolveLinkProduct", (p) => {
      const o = exactObject(p, ["reconciliationId", "productId"]);
      return reconciliationDto(
        invoices().linkExistingProduct(
          str(o.reconciliationId, "reconciliationId", 100),
          str(o.productId, "productId", MAX_PRODUCT_ID_LENGTH),
        ),
      );
    }),
    resolveCreateProduct: wrap("resolveCreateProduct", (p) => {
      const o = exactObject(p, ["reconciliationId", "nameAr", "nameEn", "sku", "baseUnit"]);
      const row = invoices().createProductFromInvoice(str(o.reconciliationId, "reconciliationId", 100), {
        nameAr: optionalStr(o.nameAr, "nameAr", MAX_PRODUCT_NAME),
        // 🔴 Never inferred. If it is not typed here, the product has no English name.
        nameEn: optionalStr(o.nameEn, "nameEn", MAX_PRODUCT_NAME),
        sku: optionalStr(o.sku, "sku", MAX_SKU),
        baseUnit: optionalStr(o.baseUnit, "baseUnit", 32),
      });
      log.info("reconciliation-created-product", { id: row.id, productId: row.matched_product_id });
      return reconciliationDto(row);
    }),
    resolveUpdateCatalog: wrap("resolveUpdateCatalog", (p) => {
      const o = exactObject(p, ["reconciliationId", "fields", "canonicalUnit", "nameEn"]);
      if (!Array.isArray(o.fields) || o.fields.length === 0 || o.fields.length > 4) {
        invalid("'fields' must be a non-empty array of field names");
      }
      const allowed = ["selling_price_minor", "base_unit", "name_ar", "name_en"] as const;
      const fields = o.fields.map((f) => {
        if (typeof f !== "string" || !(allowed as ReadonlyArray<string>).includes(f)) {
          invalid("'fields' may only name a price, a unit or a name");
        }
        return f as CatalogUpdateSelection["fields"][number];
      });
      // 🔴 The renderer names the FIELDS. The values come from the frozen invoice line, read by the
      // service — so the UI cannot send a price and have it written.
      const row = invoices().updateCatalogFromInvoice(str(o.reconciliationId, "reconciliationId", 100), {
        fields,
        canonicalUnit: optionalStr(o.canonicalUnit, "canonicalUnit", 32) ?? undefined,
        nameEn: optionalStr(o.nameEn, "nameEn", MAX_PRODUCT_NAME),
      });
      log.info("reconciliation-updated-catalog", { id: row.id, fields });
      return reconciliationDto(row);
    }),

    // ── Print / PDF ─────────────────────────────────────────────────────────────────────────────
    //
    // 🔴 The renderer sends an INVOICE ID. It cannot send HTML, a file path, a command or a
    // template. Main loads the FROZEN invoice from the database and renders it itself, so what is
    // printed is the document that was issued and not whatever the window happens to be showing.
    pickInvoiceLogo: wrap("pickInvoiceLogo", (p) => {
      noPayload(p);
      if (!options.pickInvoiceLogo) return { status: "unavailable" as const };
      const chosen = options.pickInvoiceLogo();
      return chosen === null ? { status: "cancelled" as const } : { status: "chosen" as const, logoPath: chosen };
    }),
    printInvoice: wrapAsync("printInvoice", async (p) => {
      const id = invoiceId(p);
      if (!options.printInvoice) return { status: "unavailable" as const };
      requireFinalized(id);
      return { status: await options.printInvoice(id) };
    }),
    saveInvoicePdf: wrapAsync("saveInvoicePdf", async (p) => {
      const id = invoiceId(p);
      if (!options.saveInvoicePdf) throw new DomainError("NOT_AVAILABLE", "Saving a PDF is not available here");
      requireFinalized(id);
      const saved = await options.saveInvoicePdf(id);
      return saved ? { status: "saved" as const, fileName: saved.fileName } : { status: "cancelled" as const };
    }),
  };

  // ── Shapes used by the invoice channels only ─────────────────────────────────────────────────

  /**
   * The invoice number behind an invoice-origin sale, or null.
   *
   * Looked up here rather than stored on the sale: `sales` carries the invoice id, and the number
   * lives on the invoice, which is immutable once final — so there is nothing to keep in sync. On a
   * terminal with no invoice service configured this is simply null; the sale is still correct.
   */
  function invoiceNumberFor(sale: SaleRecord): number | null {
    if (sale.sourceType !== "invoice" || !sale.invoiceId || !options.invoices) return null;
    const number = options.invoices.invoiceNumberOf(sale.invoiceId);
    return number ?? null;
  }

  function invoices(): InvoiceService {
    if (!options.invoices) {
      throw new DomainError("NOT_AVAILABLE", "Invoices are not available on this terminal");
    }
    return options.invoices;
  }

  function invoiceId(payload: unknown): string {
    const o = exactObject(payload, ["invoiceId"]);
    return str(o.invoiceId, "invoiceId", 100);
  }

  function reconciliationId(payload: unknown): string {
    const o = exactObject(payload, ["reconciliationId"]);
    return str(o.reconciliationId, "reconciliationId", 100);
  }

  function search(payload: unknown): { readonly term: string | null; readonly limit: number } {
    const o = exactObject(payload, ["term", "limit"]);
    return { term: optionalStr(o.term, "term", MAX_CUSTOMER_FIELD), limit: count(o.limit, "limit", 1, 500) };
  }

  function invoiceLine(value: unknown): InvoiceLineDraft {
    const d = exactObject(value, ["description", "unitLabel", "canonicalUnit", "productId", "quantity", "unitPrice"]);
    return {
      description: optionalStr(d.description, "description", MAX_DESCRIPTION),
      // Free text, kept verbatim — the printed label is historical truth.
      unitLabel: optionalStr(d.unitLabel, "unitLabel", MAX_UNIT_LABEL),
      canonicalUnit: optionalStr(d.canonicalUnit, "canonicalUnit", 32),
      productId: optionalStr(d.productId, "productId", MAX_PRODUCT_ID_LENGTH),
      // Text, not numbers: the domain parses both into exact integers and refuses a float.
      quantity: str(d.quantity, "quantity", 32),
      unitPrice: str(d.unitPrice, "unitPrice", 32),
    };
  }

  /** A review item plus the frozen invoice and line behind it, which the panel needs to show. */
  function reconciliationDto(row: ReconciliationRow) {
    const svc = invoices();
    return toReconciliationDto(row, {
      invoice: svc.invoiceRowFor(row.invoice_id),
      line: svc.invoiceLineFor(row.invoice_line_id),
    });
  }

  /** Printing a draft is refused here rather than producing a document with no number on it. */
  function requireFinalized(id: string): void {
    const view = invoices().getInvoice(id);
    if (view.invoice.status !== "final") {
      throw new DomainError("INVOICE_NOT_DRAFT", "Only a finalized invoice can be printed");
    }
  }
}

/**
 * The handler map typed as SYNCHRONOUS, for every caller that does not touch `printInvoice` or
 * `saveInvoicePdf` — the only two channels that answer with a promise, because printing and PDF
 * generation are asynchronous in Electron.
 *
 * This is a guard, not a cast that hides the difference: reaching an asynchronous channel through
 * this view THROWS, instead of handing back a Promise typed as a result and failing somewhere else
 * entirely. `tests/main/invoiceIpc.test.ts` asserts that those two really are the asynchronous ones,
 * so the assumption this function makes is itself tested rather than assumed.
 */
export function syncHandlers(
  handlers: Record<ChannelName, Handler>,
): Record<ChannelName, (payload: unknown) => IpcResult<unknown>> {
  const out = {} as Record<ChannelName, (payload: unknown) => IpcResult<unknown>>;
  for (const name of Object.keys(handlers) as ChannelName[]) {
    out[name] = (payload) => {
      const result = handlers[name](payload);
      if (result instanceof Promise) {
        throw new Error(`ipc: channel '${name}' answers asynchronously — await it instead`);
      }
      return result;
    };
  }
  return out;
}

/** Every handler maps to exactly one fixed channel string. */
export const CHANNEL_NAMES = Object.keys(CHANNELS) as ChannelName[];
