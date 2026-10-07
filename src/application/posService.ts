/**
 * PosService — the business operations the UI may ask for. Nothing else is exposed over IPC.
 *
 * Trust boundary: the renderer supplies only product ids, quantities, a payment method, an
 * idempotency key and the total it DISPLAYED. Prices, names, SKUs, the cashier, the time, the
 * business day and the receipt number are all decided here, from the catalog and the logged-in
 * session — never taken from the renderer.
 */
import { createHash, randomUUID } from "node:crypto";
import { businessDateOf } from "../domain/businessDay";
import { type CartLine, priceCart } from "../domain/cart";
import { type Catalog, loadCatalog } from "../domain/catalog";
import { decodeUtf8Strict, toImportCsv, validateImport, type ImportRejection } from "../domain/catalogImport";
import { DomainError } from "../domain/errors";
import { money } from "../domain/money";
import { type TodaySalesReport, buildTodaySales } from "../domain/report";
import {
  type PaymentMethod,
  type SaleRecord,
  type VoidRecord,
  assertPaymentMethod,
  normalizeVoidReason,
} from "../domain/sale";
import {
  CLEAR_PIN_STATE,
  PIN_LOCKOUT_POLICY,
  afterFailure,
  attemptsRemaining,
  checkLock,
  minutesRemaining,
} from "../domain/pinLockout";
import type { CashierFixture } from "../fixtures/cashiers";
import type { TerminalConfig } from "../fixtures/terminal";
import { validateProductDraft, type ProductDraft } from "../domain/productDraft";
import {
  type AdminProductRow,
  CSV_SOURCE,
  type CatalogRepository,
  type ImportCounts,
  MANUAL_SOURCE,
} from "../persistence/catalogRepository";
import type { PinStateRepository } from "../persistence/pinStateRepository";
import type { SaleRepository } from "../persistence/saleRepository";
import { type Cashier, pinMatches } from "./cashierAuth";

export interface PosServiceDeps {
  readonly repository: SaleRepository;
  readonly pinStates: PinStateRepository;
  readonly catalog: Catalog;
  /** The local catalog table. Without it (tests, older callers) catalog import is unavailable. */
  readonly catalogStore?: CatalogRepository;
  readonly cashiers: ReadonlyArray<CashierFixture>;
  readonly terminal: TerminalConfig;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /**
   * Called after every administrative write, with the actor and a before/after diff. Wired in
   * main.ts to the file logger, so "who changed this price" is answerable TODAY without a schema
   * change — see the honest limits of that in `AuditEvent` below.
   */
  readonly audit?: (event: AuditEvent) => void;
}

/**
 * One administrative action by one operator. This is NOT the sales ledger (immutable, in SQLite)
 * and NOT the future inventory movement ledger — it records who changed master data.
 *
 * 🔴 WHAT THIS IS AND IS NOT, TODAY. The only sink wired is the application log file. That makes
 * the record append-only and timestamped, and it answers a support question by reading a file. It
 * is NOT queryable from the app, NOT retained forever, and NOT protected by database triggers. The
 * real `audit_events` table is a proposed migration awaiting approval; this hook is what the same
 * events will be written through when it lands, so no call site changes then.
 *
 * NEVER carries a PIN, a PIN hash, a token or any secret: the fields below are the whole contract.
 */
export type AuditAction =
  | "PRODUCT_CREATED"
  | "PRODUCT_UPDATED"
  | "PRODUCT_DEACTIVATED"
  | "PRODUCT_ACTIVATED"
  | "PRICE_CHANGED"
  | "UNIT_CHANGED"
  | "CATALOG_IMPORTED";

export interface AuditEvent {
  readonly id: string;
  readonly at: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly action: AuditAction;
  readonly entityType: "product" | "catalog";
  readonly entityId: string;
  readonly source: string;
  /** Changed fields only, as { before, after } — never the whole row, never a secret. */
  readonly changes?: Readonly<Record<string, { readonly before: unknown; readonly after: unknown }>>;
  readonly reason?: string;
}

export interface CreateSaleInput {
  readonly idempotencyKey: string;
  readonly lines: ReadonlyArray<CartLine>;
  readonly paymentMethod: PaymentMethod;
  /** The total the cashier saw, in minor units. A mismatch means the screen was stale: refuse. */
  readonly expectedTotalMinor: bigint;
}

export interface CreateSaleResult {
  readonly sale: SaleRecord;
  /** True when this idempotency key had already completed a sale; no new sale was written. */
  readonly duplicate: boolean;
}

export interface SaleWithVoid {
  readonly sale: SaleRecord;
  readonly void: VoidRecord | null;
}

export const MAX_HISTORY = 200;

export type CatalogImportResult =
  | ({ readonly status: "imported"; readonly rowCount: number; readonly placeholderPrices: number } & ImportCounts)
  | { readonly status: "rejected"; readonly rejected: ReadonlyArray<ImportRejection> };

/**
 * Which catalog the till starts with: the local catalog when it has active products, otherwise the
 * bundled demo fixture (a fresh install, and every automated test, starts on the fixture).
 */
export function startupCatalog(
  store: CatalogRepository,
  fixture: Catalog,
  currency: string,
): { readonly catalog: Catalog; readonly origin: "local" | "fixture" } {
  const local = store.loadActiveSource(currency);
  return local ? { catalog: loadCatalog(local), origin: "local" } : { catalog: fixture, origin: "fixture" };
}

type LoginOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "wrong"; readonly left: number }
  | { readonly kind: "locked"; readonly remainingMs: number };

export class PosService {
  private readonly repository: SaleRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private cashier: Cashier | null = null;
  private catalog: Catalog;

  constructor(private readonly deps: PosServiceDeps) {
    this.assertTerminalCurrency(deps.catalog);
    this.catalog = deps.catalog;
    this.repository = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  // ── Session ─────────────────────────────────────────────────────────────────────────────────────

  listCashiers(): Cashier[] {
    return this.deps.cashiers.map((c) => ({ id: c.id, name: c.name }));
  }

  /**
   * PIN login with per-cashier lockout (policy: src/domain/pinLockout.ts). The lock is checked
   * BEFORE the PIN, so a correct PIN cannot bypass it. An unknown cashier id gets the generic
   * error and creates no state.
   */
  login(cashierId: string, pin: string): Cashier {
    const fixture = this.deps.cashiers.find((c) => c.id === cashierId);
    if (!fixture) throw new DomainError("INVALID_CREDENTIALS", "Cashier or PIN is incorrect");
    const now = this.now();
    const lockMinutes = PIN_LOCKOUT_POLICY.lockDurationMs / 60000;

    const outcome = this.deps.pinStates.update<LoginOutcome>(fixture.id, now, (state) => {
      const lock = checkLock(state, now);
      if (lock.locked) return { next: state, result: { kind: "locked", remainingMs: lock.remainingMs } };
      if (pinMatches(fixture, pin)) return { next: CLEAR_PIN_STATE, result: { kind: "ok" } };
      const next = afterFailure(state, now);
      const nowLocked = checkLock(next, now);
      return nowLocked.locked
        ? { next, result: { kind: "locked", remainingMs: nowLocked.remainingMs } }
        : { next, result: { kind: "wrong", left: attemptsRemaining(next) } };
    });

    if (outcome.kind === "locked") {
      const minutes = minutesRemaining(outcome.remainingMs);
      throw new DomainError(
        "CASHIER_LOCKED",
        `Too many incorrect PIN attempts. ${fixture.name} is locked — try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      );
    }
    if (outcome.kind === "wrong") {
      throw new DomainError(
        "INVALID_CREDENTIALS",
        `Cashier or PIN is incorrect. ${outcome.left} attempt${outcome.left === 1 ? "" : "s"} left before a ${lockMinutes}-minute lock.`,
      );
    }
    this.cashier = { id: fixture.id, name: fixture.name };
    return this.cashier;
  }

  logout(): void {
    this.cashier = null;
  }

  currentCashier(): Cashier | null {
    return this.cashier;
  }

  private requireCashier(): Cashier {
    if (!this.cashier) throw new DomainError("NOT_LOGGED_IN", "A cashier must be logged in");
    return this.cashier;
  }

  // ── Catalog ─────────────────────────────────────────────────────────────────────────────────────

  getCatalog(): Catalog {
    return this.catalog;
  }

  private assertTerminalCurrency(catalog: Catalog): void {
    if (catalog.currency !== this.deps.terminal.currency) {
      throw new DomainError(
        "MIXED_CURRENCY",
        `Catalog currency ${catalog.currency} differs from terminal currency ${this.deps.terminal.currency}`,
      );
    }
  }

  /**
   * Imports a merchant catalog file (strict format: src/domain/catalogImport.ts) into the local
   * catalog and makes it the live catalog. All or nothing: any rejected row refuses the whole file
   * and nothing is written. A cart priced against the old catalog is re-checked at checkout by the
   * existing TOTAL_MISMATCH / PRODUCT_NOT_FOUND guards, so a mid-sale import cannot mis-charge.
   */
  importCatalogCsv(fileName: string, bytes: Uint8Array): CatalogImportResult {
    const cashier = this.requireCashier();
    const store = this.deps.catalogStore;
    if (!store) throw new DomainError("NOT_AVAILABLE", "Catalog import is not available on this terminal");
    const currency = this.deps.terminal.currency;
    const { rows, rejected } = validateImport(decodeUtf8Strict(bytes), currency);
    if (rejected.length > 0) return { status: "rejected", rejected };

    const counts = store.applyImport(CSV_SOURCE, rows, {
      importId: this.newId(),
      fileName: fileName.slice(0, 200),
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      cashierId: cashier.id,
      now: this.now(),
    });
    const source = store.loadActiveSource(currency);
    if (!source) throw new DomainError("LEDGER_INTEGRITY", "Imported catalog could not be read back");
    const next = loadCatalog(source);
    this.assertTerminalCurrency(next);
    this.catalog = next;
    this.record(cashier, "CATALOG_IMPORTED", "catalog", CSV_SOURCE, CSV_SOURCE, {
      rows: { before: null, after: rows.length },
      inserted: { before: null, after: counts.inserted },
      updated: { before: null, after: counts.updated },
      deactivated: { before: null, after: counts.deactivated },
    });
    return {
      status: "imported",
      rowCount: rows.length,
      placeholderPrices: rows.filter((r) => r.priceNeedsReview).length,
      ...counts,
    };
  }

  /**
   * The imported catalog in the import format, for editing (e.g. prices in Excel) and importing again
   * through importCatalogCsv. Only the imported source is exported — never the demo fixture.
   */
  exportCatalogCsv(): { readonly csv: string; readonly productCount: number } {
    this.requireCashier();
    const store = this.deps.catalogStore;
    if (!store) throw new DomainError("NOT_AVAILABLE", "Catalog export is not available on this terminal");
    const rows = store.listForExport(CSV_SOURCE);
    if (rows.length === 0) {
      throw new DomainError("NOT_AVAILABLE", "There is no imported catalog to export yet");
    }
    return { csv: toImportCsv(rows), productCount: rows.length };
  }

  // ── Product administration ──────────────────────────────────────────────────────────────────────
  //
  // Master data. Every write goes through here, re-reads the local catalog and replaces the live
  // one, so the Sell screen and the price used at checkout can never lag behind an edit. A past
  // sale is untouched by construction: `sale_lines` holds its own name/SKU/price snapshot and no
  // sale references these rows.

  private requireStore(): CatalogRepository {
    const store = this.deps.catalogStore;
    if (!store) throw new DomainError("NOT_AVAILABLE", "Product management is not available on this terminal");
    return store;
  }

  /**
   * Reloads the live catalog from the local table after an administrative write. When the last
   * active product has just been deactivated the local catalog is empty; the till then falls back
   * to the bundled demo fixture exactly as a fresh install does, rather than holding a stale list.
   */
  private refreshCatalogFromStore(store: CatalogRepository): void {
    const currency = this.deps.terminal.currency;
    const local = store.loadActiveSource(currency);
    const next = local ? loadCatalog(local) : this.deps.catalog;
    this.assertTerminalCurrency(next);
    this.catalog = next;
  }

  private record(
    cashier: Cashier,
    action: AuditAction,
    entityType: AuditEvent["entityType"],
    entityId: string,
    source: string,
    changes?: AuditEvent["changes"],
  ): void {
    this.deps.audit?.({
      id: this.newId(),
      at: this.now().toISOString(),
      actorId: cashier.id,
      actorName: cashier.name,
      action,
      entityType,
      entityId,
      source,
      ...(changes && Object.keys(changes).length > 0 ? { changes } : {}),
    });
  }

  /** Every local product, active and inactive — the administration list, not the sellable catalog. */
  listProducts(): AdminProductRow[] {
    this.requireCashier();
    return this.requireStore().listAll();
  }

  /**
   * Creates one product from what the operator typed. `price_needs_review` is 0: a typed price is a
   * real price, unlike a placeholder that arrives in a file.
   */
  createProduct(draft: ProductDraft): AdminProductRow {
    const cashier = this.requireCashier();
    const store = this.requireStore();
    const valid = validateProductDraft(draft, this.deps.terminal.currency);
    if (valid.sku !== null && store.findBySku(valid.sku)) {
      throw new DomainError("DUPLICATE_SKU", `Another product already uses the SKU '${valid.sku}'`);
    }
    const row = store.createManual(
      {
        nameAr: valid.nameAr,
        nameEn: valid.nameEn,
        sku: valid.sku,
        priceMinor: valid.price.minor,
        currency: valid.price.currency,
        baseUnit: valid.baseUnit,
      },
      this.now(),
    );
    this.refreshCatalogFromStore(store);
    this.record(cashier, "PRODUCT_CREATED", "product", row.id, row.source, {
      name_ar: { before: null, after: row.name_ar },
      selling_price_minor: { before: null, after: row.selling_price_minor.toString() },
      base_unit: { before: null, after: row.base_unit },
    });
    return row;
  }

  /**
   * Edits an existing product — imported or manual. Identity (`source`, `source_key`) is never
   * changed, so a later re-import still recognises an imported row it has edited.
   *
   * A price or unit change emits its OWN audit action in addition to PRODUCT_UPDATED, because
   * "who changed this item's price" must be answerable without reading every diff.
   */
  updateProduct(id: string, draft: ProductDraft, isActive: boolean): AdminProductRow {
    const cashier = this.requireCashier();
    const store = this.requireStore();
    const before = store.findById(id);
    if (!before) throw new DomainError("PRODUCT_NOT_FOUND", "This product no longer exists");
    const valid = validateProductDraft(draft, before.currency);
    if (valid.sku !== null) {
      const owner = store.findBySku(valid.sku);
      if (owner && owner.id !== id) {
        throw new DomainError("DUPLICATE_SKU", `Another product already uses the SKU '${valid.sku}'`);
      }
    }
    const after = store.updateProduct(
      id,
      {
        nameAr: valid.nameAr,
        nameEn: valid.nameEn,
        sku: valid.sku,
        priceMinor: valid.price.minor,
        baseUnit: valid.baseUnit,
        isActive,
      },
      this.now(),
    );
    this.refreshCatalogFromStore(store);

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const diff = (field: string, b: unknown, a: unknown) => {
      if (b !== a) changes[field] = { before: b, after: a };
    };
    diff("name_ar", before.name_ar, after.name_ar);
    diff("name_en", before.name_en, after.name_en);
    diff("sku", before.sku, after.sku);
    diff("selling_price_minor", before.selling_price_minor.toString(), after.selling_price_minor.toString());
    diff("base_unit", before.base_unit, after.base_unit);
    diff("is_active", before.is_active === 1n, after.is_active === 1n);

    if (before.selling_price_minor !== after.selling_price_minor) {
      this.record(cashier, "PRICE_CHANGED", "product", id, after.source, {
        selling_price_minor: {
          before: before.selling_price_minor.toString(),
          after: after.selling_price_minor.toString(),
        },
      });
    }
    if (before.base_unit !== after.base_unit) {
      this.record(cashier, "UNIT_CHANGED", "product", id, after.source, {
        base_unit: { before: before.base_unit, after: after.base_unit },
      });
    }
    this.record(cashier, "PRODUCT_UPDATED", "product", id, after.source, changes);
    return after;
  }

  /** Deactivates or reactivates. Never deletes — a product that has been sold stays on record. */
  setProductActive(id: string, active: boolean): AdminProductRow {
    const cashier = this.requireCashier();
    const store = this.requireStore();
    const before = store.findById(id);
    if (!before) throw new DomainError("PRODUCT_NOT_FOUND", "This product no longer exists");
    const after = store.setActive(id, active, this.now());
    this.refreshCatalogFromStore(store);
    this.record(cashier, active ? "PRODUCT_ACTIVATED" : "PRODUCT_DEACTIVATED", "product", id, after.source, {
      is_active: { before: before.is_active === 1n, after: active },
    });
    return after;
  }

  // ── Sales ───────────────────────────────────────────────────────────────────────────────────────

  createSale(input: CreateSaleInput): CreateSaleResult {
    const cashier = this.requireCashier();
    assertPaymentMethod(input.paymentMethod);
    if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(input.idempotencyKey)) {
      throw new DomainError("INVALID_INPUT", "A valid idempotency key is required");
    }

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          cashierId: cashier.id,
          paymentMethod: input.paymentMethod,
          // Exact thousandths, never a decimal string: 2.5 and 2.500 cannot hash differently,
          // and 2 kg vs 2.001 kg cannot hash the same.
          lines: input.lines.map((l) => [l.productId, l.quantityMilli]),
          expectedTotalMinor: input.expectedTotalMinor.toString(),
        }),
      )
      .digest("hex");

    // Idempotency: the same key never produces a second sale.
    const existing = this.repository.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "This sale key was already used for a different sale");
      }
      return { sale: existing.sale, duplicate: true };
    }

    const priced = priceCart(this.catalog, input.lines);
    if (priced.total.minor !== input.expectedTotalMinor) {
      throw new DomainError(
        "TOTAL_MISMATCH",
        "The displayed total no longer matches the catalog; please review the cart",
      );
    }

    const instant = this.now();
    const timestamp = instant.toISOString();
    const saleId = this.newId();
    this.repository.commitSale(
      {
        id: saleId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        cashierId: cashier.id,
        cashierName: cashier.name,
        currency: priced.currency,
        subtotalMinor: priced.subtotal.minor,
        totalMinor: priced.total.minor,
        paymentMethod: input.paymentMethod,
        businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
        completedAt: timestamp,
        createdAt: timestamp,
      },
      priced.lines.map((l) => ({
        id: this.newId(),
        lineNo: l.lineNo,
        productId: l.productId,
        sku: l.sku,
        productName: l.productName,
        saleUnit: l.saleUnit,
        quantityMilli: l.quantityMilli,
        unitPriceMinor: l.unitPrice.minor,
        lineTotalMinor: l.lineTotal.minor,
      })),
    );
    const sale = this.repository.getSale(saleId);
    if (!sale) throw new DomainError("LEDGER_INTEGRITY", "Committed sale could not be read back");
    return { sale, duplicate: false };
  }

  /**
   * Read-only: the sale already committed under this idempotency key, if any. Used to tell the
   * cashier the truth after an unexpected error ("recorded" vs "not recorded"), never to write.
   */
  saleForIdempotencyKey(key: string): SaleRecord | null {
    return this.repository.findByIdempotencyKey(key)?.sale ?? null;
  }

  getSale(saleId: string): SaleWithVoid {
    const sale = this.repository.getSale(saleId);
    if (!sale) throw new DomainError("SALE_NOT_FOUND", "Sale not found");
    return { sale, void: this.repository.getVoid(saleId) ?? null };
  }

  getSaleHistory(limit = 50): SaleWithVoid[] {
    const bounded = Math.max(1, Math.min(MAX_HISTORY, Math.trunc(limit)));
    const sales = this.repository.listSales(bounded);
    const voids = this.repository.listVoidsForSales(sales.map((s) => s.id));
    return sales.map((sale) => ({ sale, void: voids.get(sale.id) ?? null }));
  }

  /**
   * Voids a completed sale by writing a NEW void record. The sale itself is never touched.
   * Gate 1 rule: only a sale from the current business day can be voided; correcting an older
   * sale is a refund, which is out of scope.
   */
  voidSale(saleId: string, reason: unknown): VoidRecord {
    const cashier = this.requireCashier();
    const cleanReason = normalizeVoidReason(reason);
    const sale = this.repository.getSale(saleId);
    if (!sale) throw new DomainError("SALE_NOT_FOUND", "Sale not found");
    if (this.repository.getVoid(saleId)) throw new DomainError("ALREADY_VOIDED", "This sale is already voided");
    const instant = this.now();
    const today = businessDateOf(instant, this.deps.terminal.timeZone);
    if (sale.businessDate !== today) {
      throw new DomainError("VOID_NOT_ALLOWED", "Only sales from the current business day can be voided");
    }
    const record: VoidRecord = {
      id: this.newId(),
      saleId,
      cashierId: cashier.id,
      cashierName: cashier.name,
      reason: cleanReason,
      businessDate: today,
      createdAt: instant.toISOString(),
    };
    try {
      this.repository.insertVoid(record);
    } catch (err) {
      // The UNIQUE(sale_id) constraint is the final guard against a double void.
      if (this.repository.getVoid(saleId)) throw new DomainError("ALREADY_VOIDED", "This sale is already voided");
      throw err;
    }
    return record;
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────────────────

  getTodaySales(): TodaySalesReport {
    const date = businessDateOf(this.now(), this.deps.terminal.timeZone);
    const rows = this.repository
      .reportRows(date)
      .map((r) => ({ total: money(r.totalMinor, r.currency), voided: r.voided }));
    return buildTodaySales(date, this.deps.terminal.currency, rows);
  }
}
