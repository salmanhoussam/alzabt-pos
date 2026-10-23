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
import type { OnlineCatalogSnapshot } from "../application/posService";
import { MAX_QUANTITY_MILLI } from "../domain/quantity";
import { assertPaymentMethod } from "../domain/sale";
import { formatDecimal, money } from "../domain/money";
import type { SaleRecord } from "../domain/sale";
import { DEFAULT_TERMINAL_LANGUAGE, isLanguage } from "../shared/i18n";
import { MAX_PARTY_ADDRESS, MAX_PARTY_NAME, MAX_PARTY_NOTE, MAX_PARTY_PHONE } from "../domain/party";
import type { Language, TerminalSettings } from "../shared/i18n";
import { saleOutcomeError } from "./saleOutcomeText";
import { invoiceOutcomeError } from "./invoiceOutcomeText";
import { paymentOutcomeError } from "./paymentOutcomeText";
import type { PartyService } from "../application/partyService";
import type { LedgerService } from "../application/ledgerService";
import type { PartyRow } from "../persistence/partyRepository";
import type { CustomerDto, CustomerStatementDto } from "../shared/ipcContract";
import {
  MAX_BRAND,
  MAX_DESCRIPTION as MAX_PRODUCT_DESCRIPTION,
  MAX_PRODUCT_NAME,
  MAX_SKU,
  type ProductDraft,
  type ProductMasterDraft,
} from "../domain/productDraft";
import { MAX_CATEGORY_NAME } from "../domain/category";
import { MAX_BARCODE } from "../domain/barcode";
import type { PhoneSessionSpec } from "../domain/phoneSession";
import {
  parseMinor,
  toAdminProductDto,
  toCategoryDto,
  toProductImageMetaDto,
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
  PRODUCT_MASTER_PATCH_KEYS,
  type ProductMasterPatchKey,
  OnlineCatalogExportDto,
  type PhoneSessionDto,
  type PhoneSessionState,
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

/**
 * A photo main has already read AND normalized, on its way to the service.
 *
 * No path and no original filename: the shop owns these bytes from here on, and the file the
 * operator picked may be deleted, renamed or on a USB stick that is gone by tomorrow. Storing
 * where it came from would be storing a promise the product cannot keep — the same reason the
 * invoice logo is copied into the app's own folder rather than referenced where it was found.
 */
export interface PickedPhoto {
  readonly bytes: Buffer;
  readonly mime: "image/jpeg" | "image/png";
  readonly widthPx: number;
  readonly heightPx: number;
  readonly origin: "desktop" | "phone";
}

/**
 * Opening and closing the temporary phone surface.
 *
 * One session at a time, by contract: `start` replaces whatever was open, because two QRs on one
 * till is a state nobody can reason about and the desktop only ever shows one.
 */
export interface PhoneSessionBridge {
  readonly start: (spec: PhoneSessionSpec) => Promise<PhoneSessionDto>;
  /** True when something was actually closed; false when nothing was open. */
  readonly cancel: () => Promise<boolean>;
  /** Slice H2. What the desktop dialog polls. Reports a save exactly once. */
  readonly status: () => PhoneSessionState;
}

export interface IpcHandlerOptions {
  /** Shows the native "open file" dialog. Absent (tests, headless) means import is unavailable. */
  readonly pickCatalogFile?: () => PickedFile | null;
  /** Native "save as" dialog + atomic write of the exported catalog. Absent means unavailable. */
  readonly saveCatalogExport?: (suggestedName: string, contents: string) => SavedFile | null;
  /** Native "save as" dialog + verified consistent snapshot of the ledger. Absent means unavailable. */
  readonly exportBackup?: () => SavedFile | null;
  /**
   * Shows the native "choose a folder" dialog and writes the Online Catalog package into it.
   *
   * 🔴 THE WHOLE OPERATION LIVES IN MAIN, deliberately. The renderer cannot name a destination,
   * cannot see a path, and cannot write a byte; it asks for an export and is told what happened.
   * Absent (a headless test, a terminal without a window) answers NOT_AVAILABLE rather than
   * half-working.
   */
  readonly exportOnlineCatalog?: (snapshot: OnlineCatalogSnapshot) => OnlineCatalogExportDto | null;
  /**
   * The phone-entry LAN bridge (slice H1). Absent means this terminal cannot open one at all, and
   * the channel answers NOT_AVAILABLE — which is what every headless test gets, so no test
   * accidentally opens a socket.
   *
   * 🔴 IT TAKES AN ALREADY-AUTHORIZED SPEC. The handler calls `service.authorizePhoneSession`
   * first; this seam is the mechanism, never the permission. Giving it the raw request would move
   * the owner check into main, where the listener could not re-use it.
   */
  readonly phoneSessions?: PhoneSessionBridge;
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
  /**
   * `logoMissing` is true when the invoice NAMED a frozen logo asset that is not on disk, so the
   * document printed without its own branding. It is reported, never silently substituted — see
   * src/main/invoiceLogo.ts.
   */
  readonly printInvoice?: (
    invoiceId: string,
  ) => Promise<{ readonly status: "printed" | "cancelled"; readonly logoMissing: boolean }>;
  /** Save-as dialog + printToPDF of the frozen invoice. Null when the operator cancelled. */
  readonly saveInvoicePdf?: (
    invoiceId: string,
  ) => Promise<(SavedFile & { readonly logoMissing: boolean }) | null>;
  /**
   * Native image picker. Main copies the chosen file into its own branding folder and returns a
   * BARE FILE NAME; the renderer never sees or supplies a path.
   */
  readonly pickInvoiceLogo?: () => string | null;
  /**
   * Native photo picker for a product. Main shows the dialog, reads the file and NORMALIZES it
   * (decode, re-encode, bound the dimensions), then returns the bytes it produced — so the only
   * thing that crosses the IPC bridge in the other direction is a product id.
   *
   * 🔴 ABSENT UNTIL SLICE F. Product Master's authorization, channel and service boundary land
   * first (slice D); the `nativeImage` pipeline that can actually prove a file is an image is its
   * own slice. While this is absent, `setProductImage` answers NOT_AVAILABLE.
   */
  readonly pickProductPhoto?: (productId: string) => PickedPhoto | null;
  /**
   * The customer/supplier directory (migration 12). Absent on a terminal without it, where every
   * customer channel answers NOT_AVAILABLE — the same shape `invoices` already uses.
   */
  readonly parties?: PartyService;
  /** S3B: the read-only statement source. Absent on a terminal without the ledger. */
  readonly ledger?: LedgerService;
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
 * An object whose `required` keys must all be present and whose `optional` keys may be absent.
 * Unknown keys are refused, exactly as `exactObject` refuses them.
 *
 * 🔴 Why this exists rather than widening `exactObject`'s key list: a product draft's five
 * selling fields are genuinely required — a payload missing a price is malformed — while the
 * enrichment group must be omittable, because omitting it is what every caller that predates
 * Product Master means. One function cannot express both with a single flat key list.
 */
function objectWithOptional(
  payload: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) invalid("Expected an object");
  const actual = Object.keys(payload);
  const extra = actual.filter((k) => !required.includes(k) && !optional.includes(k));
  const missing = required.filter((k) => !actual.includes(k));
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
  // 🔴 `master` IS OPTIONAL AND EVERY OTHER KEY IS REQUIRED, which is why this is not a plain
  // `exactObject`. An exact object would refuse a legacy caller that omits `master` (the import
  // path, invoice reconciliation) and force it to invent one — and a caller that invents an
  // enrichment group sends nulls, which CLEAR fields. The optional key is what keeps absence
  // expressible all the way from the renderer to `keep()` in the repository.
  const d = objectWithOptional(value, ["nameAr", "nameEn", "sku", "price", "baseUnit"], ["master"]);
  const base = {
    nameAr: str(d.nameAr, "nameAr", MAX_PRODUCT_NAME),
    nameEn: optionalStr(d.nameEn, "nameEn", MAX_PRODUCT_NAME),
    sku: optionalStr(d.sku, "sku", MAX_SKU),
    price: str(d.price, "price", 32),
    baseUnit: str(d.baseUnit, "baseUnit", 32),
  };
  return d.master === undefined ? base : { ...base, master: productMasterPatch(d.master) };
}

/**
 * The Product Master enrichment patch.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 BUILT KEY BY KEY, AND ABSENCE IS CARRIED, NOT NORMALIZED AWAY. A key the caller did not send
 * must still be MISSING from the object this returns — not present holding `undefined`, and
 * certainly not present holding `null`. Spreading, defaulting with `??`, or listing the six keys
 * unconditionally would each turn "I am not touching the description" into "clear the
 * description", and a re-import would silently wipe what the owner typed.
 *
 * 🔴 A key present with `undefined` is treated as ABSENT. Electron's structured clone preserves a
 * property whose value is `undefined`, so `{ brand: undefined }` arrives with the key present — and
 * a renderer building an object from optional React state produces exactly that. The `in` test
 * alone would read it as "clear the brand".
 *
 * MEANING is still the domain's job: `validateProductMaster` canonicalizes the barcode and trims
 * the text. This refuses a payload that is the wrong SHAPE, so a malformed call never gets that far.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
function productMasterPatch(value: unknown): ProductMasterDraft {
  const m = patchObject(value, PRODUCT_MASTER_PATCH_KEYS);
  const out: {
    categoryId?: string | null;
    barcode?: string | null;
    brand?: string | null;
    descriptionAr?: string | null;
    descriptionEn?: string | null;
    isOnlineVisible?: boolean;
  } = {};
  const sent = (key: ProductMasterPatchKey) => key in m && m[key] !== undefined;

  if (sent("categoryId")) out.categoryId = optionalStr(m.categoryId, "categoryId", MAX_PRODUCT_ID_LENGTH);
  if (sent("barcode")) out.barcode = optionalStr(m.barcode, "barcode", MAX_BARCODE);
  if (sent("brand")) out.brand = optionalStr(m.brand, "brand", MAX_BRAND);
  if (sent("descriptionAr")) {
    out.descriptionAr = optionalStr(m.descriptionAr, "descriptionAr", MAX_PRODUCT_DESCRIPTION);
  }
  if (sent("descriptionEn")) {
    out.descriptionEn = optionalStr(m.descriptionEn, "descriptionEn", MAX_PRODUCT_DESCRIPTION);
  }
  if (sent("isOnlineVisible")) out.isOnlineVisible = bool(m.isOnlineVisible, "isOnlineVisible");
  return out;
}

function noPayload(payload: unknown): void {
  if (payload !== undefined && payload !== null) invalid("This operation takes no payload");
}

/**
 * The fallback for an unexpected fault on ANY channel, in the operator's language.
 *
 * 🔴 IT WAS A FROZEN CONSTANT AND IS NOW A FUNCTION OF THE LANGUAGE. The old value was the exact
 * English sentence now stored as `outcome.internal`, so English mode is unchanged; what changed is
 * that an Arabic till no longer reads it in English. It still says nothing whatsoever about sales —
 * that distinction is the whole reason `saleFailureTruth` exists separately.
 */
function genericInternal(lang: Language): IpcError {
  return saleOutcomeError(lang, "internal");
}

/** What the cashier is told after an unexpected error in createSale, decided by reading the ledger. */
export function saleFailureTruth(service: PosService, payload: unknown, lang: Language): IpcError {
  const key =
    payload && typeof payload === "object" && typeof (payload as { idempotencyKey?: unknown }).idempotencyKey === "string"
      ? (payload as { idempotencyKey: string }).idempotencyKey
      : null;
  // 🔴 NO KEY MEANS THE LEDGER CANNOT BE ASKED, so no retry is offered. `not_recorded_retry` below
  // is the other half of the same code and DOES offer one, because there the ledger answered.
  // Collapsing the two would leave the cashier without the one fact that decides whether pressing
  // the button again is safe.
  if (key === null) return saleOutcomeError(lang, "not_recorded");
  try {
    const sale = service.saleForIdempotencyKey(key);
    // 🔴 THE RECEIPT NUMBER COMES OFF THE ROW, as a number, and is validated by
    // `isReceiptNumber` before it is printed. It is never parsed back out of a sentence.
    return sale
      ? saleOutcomeError(lang, "recorded", sale.receiptNumber)
      : saleOutcomeError(lang, "not_recorded_retry");
  } catch {
    return saleOutcomeError(lang, "unknown");
  }
}

/**
 * What the OWNER is told after an unexpected error in `recordCustomerPayment`, decided by READING
 * the ledger rather than by guessing from the exception.
 *
 * 🔴 AN ERROR THROWN AFTER THE COMMIT LOOKS IDENTICAL TO ONE THROWN BEFORE IT. The only thing that
 * can tell them apart is the ledger itself, asked by the key the caller sent. Guessing "not
 * recorded" is how a shop collects the same debt twice; guessing "recorded" is how a real payment
 * goes missing. So this asks, and when it cannot ask it says so.
 *
 * Same shape as `saleFailureTruth` immediately above, deliberately — see `paymentOutcomeText.ts`.
 */
export function paymentFailureTruth(ledger: LedgerService, payload: unknown, lang: Language): IpcError {
  const key =
    payload && typeof payload === "object" && typeof (payload as { idempotencyKey?: unknown }).idempotencyKey === "string"
      ? (payload as { idempotencyKey: string }).idempotencyKey
      : null;
  // 🔴 NO KEY MEANS THE LEDGER CANNOT BE ASKED, so no retry is offered — the other half of this
  // same code DOES offer one, because there the ledger answered.
  if (key === null) return paymentOutcomeError(lang, "not_recorded");
  try {
    const settled = ledger.settlementForIdempotencyKey(key);
    // 🔴 THE AMOUNT COMES OFF THE ROW, formatted from its own minor units and currency. It is
    // never parsed back out of a sentence and never taken from the request.
    return settled
      // 🔴 FORMATTED, NOT RAW MINOR UNITS. The first draft printed `amountMinor` directly, so a
      // 4.00 payment was reported to the shop as "400 USD" — a hundred times too large, in the one
      // sentence whose whole job is to be exact about money. `formatDecimal` is the domain's own.
      ? paymentOutcomeError(lang, "recorded", `${formatDecimal(money(settled.amountMinor, settled.currency))} ${settled.currency}`)
      : paymentOutcomeError(lang, "not_recorded_retry");
  } catch {
    return paymentOutcomeError(lang, "unknown");
  }
}

/**
 * What the cashier is told after an unexpected error in `finalizeInvoice`, decided by READING the
 * ledger rather than by guessing from the exception.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS CLOSES. `finalizeInvoice` had no `onInternal`, so every unexpected fault —
 * before the commit, during it, or after it — produced `GENERIC_INTERNAL`: "Unexpected error.
 * Please try again…". For a fault AFTER the commit that sentence is false in the direction that
 * costs the merchant work: the invoice has a number, the sale is in the ledger, and the operator
 * is being invited to issue it again.
 *
 * 🔴 WHY THE SALE ROW IS A SOUND PROXY FOR "THE COMMIT HAPPENED". `invoiceService.finalizeInvoice`
 * runs its whole body inside ONE `transact` — reread, validate, allocate the number, freeze the
 * issuer, write the finalized row, write the sale, write the reconciliation — and returns from
 * inside it. SQLite commits all of it or none of it. So "a sale exists for this invoice" is a
 * faithful statement about the transaction's outcome, and it is read through
 * `invoiceService.saleForInvoice`, which already existed for exactly this kind of question and is
 * documented read-only.
 *
 * 🔴 IT NEVER RE-FINALIZES ANYTHING. Two read-only calls, no write, no transaction. Diagnosing an
 * error must not change what it is diagnosing.
 *
 * 🔴 AND IT CANNOT CLAIM "NOT ISSUED" WITHOUT EVIDENCE. A payload that never named an invoice gets
 * the blind wording with no retry offered — the same split the sale path makes — because that
 * branch has read nothing. A lookup that throws becomes "unknown", never "not issued".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function invoiceFinalizeTruth(invoices: InvoiceService, payload: unknown, lang: Language): IpcError {
  const id =
    payload && typeof payload === "object" && typeof (payload as { invoiceId?: unknown }).invoiceId === "string"
      ? (payload as { invoiceId: string }).invoiceId
      : null;
  // No id means nothing can be looked up. `invoiceId()` would have refused such a payload with a
  // DomainError before the service ran, so reaching here with no id means the service was never
  // entered — but the wording still offers no retry, because this branch has read no evidence.
  if (id === null) return invoiceOutcomeError(lang, "not_finalized");
  try {
    const sale = invoices.saleForInvoice(id);
    if (!sale) return invoiceOutcomeError(lang, "not_finalized_retry");
    // 🔴 BOTH NUMBERS COME OFF REAL ROWS. `invoiceNumberOf` returns undefined for a draft or an
    // unknown id, and `invoiceOutcomeError` prints neither number unless it really is one.
    return invoiceOutcomeError(lang, "finalized", {
      invoiceNumber: invoices.invoiceNumberOf(id),
      receiptNumber: sale.receiptNumber,
    });
  } catch {
    return invoiceOutcomeError(lang, "unknown");
  }
}

export function createIpcHandlers(service: PosService, options: IpcHandlerOptions = {}): Record<ChannelName, Handler> {
  const log = options.logger ?? nullLogger;
  const now = options.now ?? (() => new Date());

  /**
   * The language the operator reads, for the handful of messages composed here.
   *
   * 🔴 IT CANNOT THROW, BECAUSE EVERY CALLER IS ALREADY IN AN ERROR PATH. A settings file that has
   * gone unreadable must not turn a truthful "the sale WAS recorded" into an unhandled exception
   * that reaches the renderer as nothing at all. Arabic is the product's default
   * (`DEFAULT_TERMINAL_LANGUAGE`), and `options.settings` is absent in tests and headless runs, so
   * the fallback is the real default rather than a convenient English one.
   */
  function operatorLanguage(): Language {
    try {
      return options.settings?.get().terminalLanguage ?? DEFAULT_TERMINAL_LANGUAGE;
    } catch {
      return DEFAULT_TERMINAL_LANGUAGE;
    }
  }

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
    // 🔴 ASKED OF THE SERVICE, NOT COMPUTED HERE. The per-operator half of this answer lives in
    // the durable row, and `canCreateProducts()` is the one method that reads it — so this guard
    // and the service's own `requireProductCreator()` cannot drift into disagreeing. The service
    // checks again regardless: this layer stops the call early and politely, it does not decide.
    if (access === "create-products" && !service.canCreateProducts()) {
      throw new DomainError("NOT_AUTHORIZED", "You are not allowed to add products");
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
        return { ok: false, error: onInternal ? onInternal(payload) : genericInternal(operatorLanguage()) };
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
        return { ok: false, error: genericInternal(operatorLanguage()) };
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
  /**
   * The phone session's action, from the renderer.
   *
   * 🔴 An enumerated check rather than a cast: the action is the ONLY thing that decides whether a
   * token may create a product or touch an existing one, so a third value must be refused here
   * rather than reaching the session as something `switch` quietly ignores.
   */
  function phoneAction(value: unknown): "NEW_PRODUCT" | "EDIT_PRODUCT" {
    if (value !== "NEW_PRODUCT" && value !== "EDIT_PRODUCT") {
      invalid("'action' must be NEW_PRODUCT or EDIT_PRODUCT");
    }
    return value;
  }

  function role(value: unknown): "owner" | "cashier" {
    if (value !== "owner" && value !== "cashier") invalid("'role' must be owner or cashier");
    return value;
  }

  /** The login/session shape, with the role the UI uses to hide what the service would refuse. */
  function cashierDto(c: { id: string; name: string }) {
    const r = service.currentRole();
    if (!r) return { id: c.id, name: c.name };
    // 🔴 CONVENIENCE, NOT AUTHORITY. The Products screen uses this to decide whether drawing the
    // create actions is worth it; the service re-reads the durable row on every create regardless,
    // so a stale `true` here earns a refusal rather than a product. Read defensively: a terminal
    // whose operator store is unavailable answers `false` and the screen simply offers less.
    let mayCreateProducts = false;
    try {
      mayCreateProducts = service.canCreateProducts();
    } catch {
      mayCreateProducts = false;
    }
    return { id: c.id, name: c.name, role: r, mayCreateProducts };
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
          // the length, so there is ONE definition every write path meets; a second copy here could
          // drift — and it DID: this comment said "4-8" for a day after the rule became 6-8, which
          // is precisely the drift it warns about, written in the file a reviewer reads first. The
          // range is deliberately not repeated here; `PIN_MIN_DIGITS`/`PIN_MAX_DIGITS` are the only
          // place it is stated.
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

    setOperatorMayCreateProducts: wrap("setOperatorMayCreateProducts", (p) => {
      const o = exactObject(p, ["operatorId", "mayCreateProducts"]);
      return operators().setMayCreateProducts(
        service.requireOperatorSession(),
        str(o.operatorId, "operatorId", 100),
        bool(o.mayCreateProducts, "mayCreateProducts"),
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
    }, (p) => saleFailureTruth(service, p, operatorLanguage())),
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
    /**
     * Export Online Catalog — owner only, and the authorization is NOT merely this channel's.
     *
     * `onlineCatalogSnapshot()` calls `requireOwner()` itself, so a cashier is refused by the
     * service even on a terminal where `channelPolicy` were somehow bypassed — the same
     * belt-and-braces every other owner operation here uses, and the reason slice H's LAN listener
     * can call the service directly without inheriting a hole.
     */
    exportOnlineCatalog: wrap("exportOnlineCatalog", (p) => {
      noPayload(p);
      const run = options.exportOnlineCatalog;
      if (!run) throw new DomainError("NOT_AVAILABLE", "Exporting the online catalogue is not available here");
      const snapshot = service.onlineCatalogSnapshot();
      const result = run(snapshot);
      // The owner cancelled the folder picker. Nothing was written, and that is not an error.
      if (result === null) return null;
      log.info("online-catalog-export", {
        folder: result.folderName,
        products: result.products,
        images: result.images,
        incomplete: result.incomplete,
      });
      return result;
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
      // 🔴 TWO SMALL READS, NEVER A JOIN THAT CARRIES BLOBS. `primaryPhotoIndex` is one query over
      // an index returning metadata — an id, a MIME and a content hash per photographed product.
      // Reading the image row itself alongside each product would load the shop's entire photo
      // library to render a list that shows each one at forty pixels.
      const photos = service.primaryPhotoIndex();
      return service.listProducts().map((row) => toAdminProductDto(row, photos.get(row.id) ?? null));
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

    // ── Product Master: categories, brands and photos (migration 9) ─────────────────────────────
    listCategories: wrap("listCategories", (p) => {
      noPayload(p);
      return service.listCategories().map(toCategoryDto);
    }),
    listBrands: wrap("listBrands", (p) => {
      noPayload(p);
      return service.listBrands();
    }),
    // ── Customer directory (S1B) ────────────────────────────────────────────────────────────────
    //
    // 🔴 EVERY ONE OF THESE PASSES "customer" AS A LITERAL. The kind never comes from the payload,
    // so the supplier half of the service is unreachable from the renderer — structurally, not by
    // a validation that could be forgotten. The service checks authorization again regardless.
    //
    // 🔴 AND NOTHING HERE LOGS A NAME, A PHONE OR AN ADDRESS. A customer's contact details are the
    // merchant's private data and a log file is the easiest place to leak them; the only thing any
    // of these would log is nothing at all.
    searchCustomers: wrap("searchCustomers", (p) => {
      const o = exactObject(p, ["query", "includeArchived"]);
      if (typeof o.includeArchived !== "boolean") invalid("'includeArchived' must be true or false");
      if (typeof o.query !== "string" || o.query.length > 120) invalid("'query' must be text");
      return customers().search("customer", o.query, o.includeArchived).map(toCustomerDto);
    }),

    getCustomer: wrap("getCustomer", (p) => {
      const o = exactObject(p, ["customerId"]);
      return toCustomerDto(customers().get("customer", str(o.customerId, "customerId", 100)));
    }),

    createCustomer: wrap("createCustomer", (p) => {
      const o = exactObject(p, ["displayName", "phone", "address", "note"]);
      const created = customers().create({
        kind: "customer",
        displayName: str(o.displayName, "displayName", MAX_PARTY_NAME),
        phone: optionalStr(o.phone, "phone", MAX_PARTY_PHONE),
        address: optionalStr(o.address, "address", MAX_PARTY_ADDRESS),
        note: optionalStr(o.note, "note", MAX_PARTY_NOTE),
      });
      return { customer: toCustomerDto(created.party), sameName: created.sameName.map(toCustomerDto) };
    }),

    updateCustomerContact: wrap("updateCustomerContact", (p) => {
      const o = exactObject(p, ["customerId", "patch"]);
      // 🔴 A PATCH, NOT A WHOLE RECORD. Only the keys the operator actually changed are sent, so a
      // field edited on another screen while this form was open is not reverted to what this form
      // happened to be showing — the same rule the invoice header patch already follows.
      const patch = patchObject(o.patch, ["displayName", "phone", "address", "note"]);
      const draft: Record<string, string | null> = {};
      if (patch.displayName !== undefined) draft.displayName = str(patch.displayName, "displayName", MAX_PARTY_NAME);
      if (patch.phone !== undefined) draft.phone = optionalStr(patch.phone, "phone", MAX_PARTY_PHONE);
      if (patch.address !== undefined) draft.address = optionalStr(patch.address, "address", MAX_PARTY_ADDRESS);
      if (patch.note !== undefined) draft.note = optionalStr(patch.note, "note", MAX_PARTY_NOTE);
      return toCustomerDto(customers().updateContact("customer", str(o.customerId, "customerId", 100), draft));
    }),

    // 🔴 READ-ONLY, OWNER-ONLY. Classified "owner" in channelPolicy AND refused again by
    // `LedgerService.requireOwner`. A supplier id comes back as PARTY_NOT_FOUND rather than as a
    // different error, so this reply cannot confirm that a supplier exists.
    getCustomerStatement: wrap("getCustomerStatement", (p) => {
      const o = exactObject(p, ["customerId"]);
      const id = str(o.customerId, "customerId", 100);
      const statement = ledger().statementFor(id);
      return toStatementDto(customers().get("customer", id), statement);
    }),

    /**
     * An OWNER records a payment against ONE existing posted debt. S3C.
     *
     * 🔴 THIS CHANNEL CANNOT CREATE A DEBT. It calls `settle` and nothing else; there is no
     * obligation-posting channel on this contract at all. The amount only ever goes down.
     *
     * 🔴 THE CURRENCY IS NOT A PARAMETER. `LedgerService.settle` reads it off the obligation, so a
     * wrong-currency payment is unrepresentable rather than merely refused.
     *
     * 🔴 THE REFRESHED STATEMENT IS READ BACK AFTER THE COMMIT and returned with the result, so
     * the screen replaces what it holds instead of subtracting anything itself.
     */
    recordCustomerPayment: wrap(
      "recordCustomerPayment",
      (p) => {
        const o = exactObject(p, ["customerId", "obligationId", "idempotencyKey", "amountMinor", "method"]);
        const customerId = str(o.customerId, "customerId", 100);
        const obligationId = str(o.obligationId, "obligationId", 100);
        const idempotencyKey = str(o.idempotencyKey, "idempotencyKey", 100);
        // 🔴 S3C RECORDS CASH AND NOTHING ELSE. The ledger column accepts more, but a method this
        // screen cannot truthfully take must not be reachable through it — Whish and Credit are a
        // separate, still-unauthorized decision.
        if (o.method !== "cash") invalid("'method' must be 'cash'");
        const amountMinor = parseMinor(o.amountMinor);

        // 🔴 THE CUSTOMER IS RESOLVED **BEFORE** THE SETTLE, AND THAT ORDER IS THE WHOLE POINT.
        // The first draft settled first and read the customer afterwards, to build the response.
        // `settle` only checks that the party id matches the obligation's — which a SUPPLIER's own
        // payable satisfies perfectly — so a supplier debt was settled and COMMITTED, and only then
        // did the customer lookup throw. The caller saw an error; the ledger had already moved. A
        // test for exactly that found it. Resolving the customer first makes the whole thing refuse
        // before any write.
        const party = customers().get("customer", customerId);

        const result = ledger().settle({
          obligationId,
          partyId: customerId,
          idempotencyKey,
          amountMinor,
          method: "cash",
        });

        const statement = ledger().statementFor(customerId);
        const dto = toStatementDto(party, statement);
        const settlement = {
          id: result.record.id,
          amount: { minor: result.record.amountMinor.toString(), currency: result.record.currency },
          method: result.record.method,
          settledAt: result.record.settledAt,
        } as const;
        log.info("customer-payment-recorded", { id: result.record.id, duplicate: result.duplicate });
        return { settlement, duplicate: result.duplicate, statement: dto };
      },
      (p) => paymentFailureTruth(ledger(), p, operatorLanguage()),
    ),

    setCustomerActive: wrap("setCustomerActive", (p) => {
      const o = exactObject(p, ["customerId", "isActive"]);
      if (typeof o.isActive !== "boolean") invalid("'isActive' must be true or false");
      return toCustomerDto(customers().setActive("customer", str(o.customerId, "customerId", 100), o.isActive));
    }),

    createCategory: wrap("createCategory", (p) => {
      const o = exactObject(p, ["nameAr", "nameEn"]);
      const row = toCategoryDto(
        service.createCategory(str(o.nameAr, "nameAr", MAX_CATEGORY_NAME), optionalStr(o.nameEn, "nameEn", MAX_CATEGORY_NAME)),
      );
      log.info("category-created", { id: row.id });
      return row;
    }),
    renameCategory: wrap("renameCategory", (p) => {
      const o = exactObject(p, ["categoryId", "nameAr", "nameEn"]);
      const row = toCategoryDto(
        service.renameCategory(
          str(o.categoryId, "categoryId", MAX_PRODUCT_ID_LENGTH),
          str(o.nameAr, "nameAr", MAX_CATEGORY_NAME),
          optionalStr(o.nameEn, "nameEn", MAX_CATEGORY_NAME),
        ),
      );
      log.info("category-renamed", { id: row.id });
      return row;
    }),
    setCategoryActive: wrap("setCategoryActive", (p) => {
      const o = exactObject(p, ["categoryId", "isActive"]);
      const row = toCategoryDto(
        service.setCategoryActive(str(o.categoryId, "categoryId", MAX_PRODUCT_ID_LENGTH), bool(o.isActive, "isActive")),
      );
      log.info("category-active-changed", { id: row.id, isActive: row.isActive });
      return row;
    }),
    deleteCategory: wrap("deleteCategory", (p) => {
      const o = exactObject(p, ["categoryId"]);
      const result = service.deleteCategoryIfUnused(str(o.categoryId, "categoryId", MAX_PRODUCT_ID_LENGTH));
      log.info("category-deleted", { id: result.deletedId });
      return result;
    }),

    getProductImageMeta: wrap("getProductImageMeta", (p) => {
      const o = exactObject(p, ["productId"]);
      const meta = service.productImageMeta(str(o.productId, "productId", MAX_PRODUCT_ID_LENGTH));
      return meta === null ? null : toProductImageMetaDto(meta);
    }),
    getProductImageBytes: wrap("getProductImageBytes", (p) => {
      const o = exactObject(p, ["imageId"]);
      const { meta, bytes } = service.productImageBytes(str(o.imageId, "imageId", MAX_PRODUCT_ID_LENGTH));
      // A fresh Uint8Array over a COPY: handing the renderer a view onto the Buffer better-sqlite3
      // returned would share memory with whatever that row is backed by.
      return { meta: toProductImageMetaDto(meta), bytes: new Uint8Array(bytes) };
    }),
    /**
     * 🔴 THIS CHANNEL ACCEPTS NO IMAGE DATA — only which product the owner means. Main runs the
     * picker, reads the file, decodes and normalizes it, and hands the service the result; the
     * renderer never supplies a path or a buffer. That is the same shape `pickInvoiceLogo` has
     * used since migration 6, for the same reason: a renderer-supplied path is a filesystem read
     * primitive, and renderer-supplied bytes are an unvalidated blob straight into the ledger.
     *
     * 🔴 AND THE PRODUCER DOES NOT EXIST YET. `pickProductPhoto` is slice F's `nativeImage`
     * pipeline. Until it is wired this answers NOT_AVAILABLE — the same fail-closed shape every
     * other optional main-process capability here uses, rather than a channel that half-works.
     */
    setProductImage: wrap("setProductImage", (p) => {
      const o = exactObject(p, ["productId"]);
      const productId = str(o.productId, "productId", MAX_PRODUCT_ID_LENGTH);
      const pick = options.pickProductPhoto;
      if (!pick) {
        throw new DomainError("NOT_AVAILABLE", "Adding a product photo is not available on this terminal yet");
      }
      const picked = pick(productId);
      // The operator cancelled the dialog. Not an error, and nothing was written.
      if (picked === null) return null;
      const meta = toProductImageMetaDto(
        service.setProductPrimaryImage({
          productId,
          bytes: picked.bytes,
          mime: picked.mime,
          widthPx: picked.widthPx,
          heightPx: picked.heightPx,
          origin: picked.origin,
        }),
      );
      log.info("product-photo-set", { productId, byteSize: meta.byteSize, origin: meta.origin });
      return meta;
    }),
    removeProductImage: wrap("removeProductImage", (p) => {
      const o = exactObject(p, ["productId"]);
      const productId = str(o.productId, "productId", MAX_PRODUCT_ID_LENGTH);
      const result = service.removeProductPrimaryImage(productId);
      log.info("product-photo-removed", { productId, removed: result.removed });
      return result;
    }),

    // ── Phone entry over the LAN (slice H1) ─────────────────────────────────────────────────────
    //
    // 🔴 THE AUTHORIZATION HAPPENS TWICE AND THAT IS THE DESIGN. `wrap` refuses a cashier from the
    // channel table before the payload is examined; `service.authorizePhoneSession` refuses one
    // again from inside the service, because the listener this opens calls the service directly.
    //
    // 🔴 MAIN OWNS THE SURFACE. The renderer cannot name a port, an address, a token or an expiry.
    // It asks for an action and is handed a picture to show.
    startPhoneSession: wrapAsync("startPhoneSession", async (p) => {
      const o = objectWithOptional(p, ["action"], ["productId"]);
      const action = phoneAction(o.action);
      const productId =
        "productId" in o && o.productId !== undefined && o.productId !== null
          ? str(o.productId, "productId", MAX_PRODUCT_ID_LENGTH)
          : null;

      const open = options.phoneSessions;
      if (!open) {
        throw new DomainError("NOT_AVAILABLE", "Entering a product from a phone is not available on this terminal");
      }
      // The service decides WHO and WHAT. It opens nothing.
      const spec = service.authorizePhoneSession(action, productId);
      const dto = await open.start(spec);
      log.info("phone-session-started", {
        action: spec.action,
        editing: spec.productId !== null,
        host: dto.host,
        port: dto.port,
        ambiguous: dto.addressAmbiguous,
      });
      return dto;
    }),
    /**
     * 🔴 SYNCHRONOUS AND READ-ONLY. It touches no socket and performs no save — it reports state
     * the bridge already holds, so the dialog can poll it every second or two without queuing work
     * behind a server operation.
     */
    phoneSessionState: wrap("phoneSessionState", (p) => {
      noPayload(p);
      const open = options.phoneSessions;
      if (!open) {
        return { state: "closed", savedProductId: null, action: null, expiresAt: null, claimed: false };
      }
      return open.status();
    }),
    cancelPhoneSession: wrapAsync("cancelPhoneSession", async (p) => {
      noPayload(p);
      // 🔴 Cancellation is authorized but NOT gated on a session existing: answering "there was
      // nothing open" honestly is better than an error the owner cannot act on, and a desktop that
      // cancels twice (a click plus a navigation) must not show a failure the second time.
      const open = options.phoneSessions;
      if (!open) return { closed: false };
      const closed = await open.cancel();
      if (closed) log.info("phone-session-cancelled", {});
      return { closed };
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
    },
    // 🔴 `options.invoices` DIRECTLY, NOT `invoices()`. This callback runs INSIDE `wrap`'s catch
    // block, and `invoices()` throws when the terminal has no invoice service. A throw here would
    // escape the catch and leave the renderer with a rejected promise and no message at all —
    // strictly worse than the generic sentence it was meant to improve on. Reaching this callback
    // normally implies the service exists (the handler body used it), but `authorize()` can also
    // fail with a non-DomainError before the body runs, so the guard is real.
    (p) =>
      options.invoices
        ? invoiceFinalizeTruth(options.invoices, p, operatorLanguage())
        : genericInternal(operatorLanguage())),

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
      const printed = await options.printInvoice(id);
      return { status: printed.status, logoMissing: printed.logoMissing };
    }),
    saveInvoicePdf: wrapAsync("saveInvoicePdf", async (p) => {
      const id = invoiceId(p);
      if (!options.saveInvoicePdf) throw new DomainError("NOT_AVAILABLE", "Saving a PDF is not available here");
      requireFinalized(id);
      const saved = await options.saveInvoicePdf(id);
      return saved
        ? { status: "saved" as const, fileName: saved.fileName, logoMissing: saved.logoMissing }
        : { status: "cancelled" as const };
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

  /**
   * A party row as the renderer sees it.
   *
   * 🔴 IT DROPS `kind` AND `created_by`, AND ADDS NOTHING. `kind` is always "customer" on these
   * channels, so sending it would invite a renderer to think it could ask for another; `created_by`
   * is an operator id with no use on screen. And no balance is synthesized: see the DTO's own note.
   */
  function toCustomerDto(row: PartyRow): CustomerDto {
    return {
      id: row.id,
      displayName: row.display_name,
      phone: row.phone,
      address: row.address,
      note: row.note,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    };
  }

  function ledger(): LedgerService {
    if (!options.ledger) {
      throw new DomainError("NOT_AVAILABLE", "Customer accounts are not available on this terminal");
    }
    return options.ledger;
  }

  /**
   * The statement DTO.
   *
   * 🔴 EVERY FIGURE IS ALREADY DECIDED BY THE LEDGER. This maps bigints to strings and nothing
   * else — no addition, no rounding, no "0" substituted for an absent value. A mapper that did
   * arithmetic would be a second place where what a customer owes is computed.
   */
  function toStatementDto(customer: PartyRow, s: ReturnType<LedgerService["statementFor"]>): CustomerStatementDto {
    return {
      customer: toCustomerDto(customer),
      obligations: s.obligations.map((row) => ({
        id: row.obligation.id,
        amount: { minor: row.obligation.amountMinor.toString(), currency: row.obligation.currency },
        outstanding: { minor: row.outstandingMinor.toString(), currency: row.obligation.currency },
        fullyPaid: row.outstandingMinor === 0n,
        sourceKind: row.obligation.sourceKind,
        sourceRef: row.obligation.sourceRef,
        saleId: row.obligation.saleId,
        postedAt: row.obligation.postedAt,
        settlements: row.settlements.map((st) => ({
          id: st.id,
          amount: { minor: st.amountMinor.toString(), currency: st.currency },
          method: st.method,
          settledAt: st.settledAt,
        })),
      })),
      // One entry per currency, in a stable order so the screen does not reshuffle between reads.
      balances: [...s.balances.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([currency, minor]) => ({ minor: minor.toString(), currency })),
    };
  }

  function customers(): PartyService {
    if (!options.parties) {
      throw new DomainError("NOT_AVAILABLE", "The customer directory is not available on this terminal");
    }
    return options.parties;
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
