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
  AUDITED_PRODUCT_FIELDS,
  type AuditDraft,
  type AuditEventType,
  type AuditRow,
  CURRENT_ACTOR_TIER,
  diffAuditedFields,
} from "../domain/audit";
import {
  type AdminProductRow,
  CSV_SOURCE,
  type CatalogRepository,
  type ImportCounts,
  MANUAL_SOURCE,
  auditedProductState,
} from "../persistence/catalogRepository";
import type { AuditRepository } from "../persistence/auditRepository";
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
   * The durable audit trail (migration 5). It writes through the SAME connection as the
   * repositories, inside `transact`. Required whenever `catalogStore` is present — see
   * `requireProductStack`.
   */
  readonly auditStore?: AuditRepository;
  /**
   * Runs `fn` inside ONE `BEGIN IMMEDIATE` on the same SQLite connection the repositories use.
   * This is the whole of the atomicity guarantee: the business mutation and its audit row are one
   * transaction, so neither can exist without the other. Orchestration by convention would not be
   * the same thing.
   */
  readonly transact?: <T>(fn: () => T) => T;
  /**
   * A DIAGNOSTIC mirror of each committed audit row, called AFTER the transaction commits. Wired
   * in main.ts to the rotating logfile, which is useful for field support and is NOT the record of
   * truth — it rotates and is deleted. A throw here is swallowed: operational logging may never
   * roll back or invalidate a business mutation that has already committed.
   */
  readonly audit?: (row: AuditRow) => void;
}

/**
 * 🔴 WHERE THE AUDIT RECORD LIVES, AS OF MIGRATION 5.
 *
 * The record of truth is `audit_events` in SQLite: append-only, enforced by database triggers, and
 * written INSIDE the same transaction as the mutation it describes. Before migration 5 these events
 * went only to the rotating JSON logfile — which rotates, is eventually deleted, and was written
 * after the business commit, so it could never be the accountability record. That logfile is kept,
 * unchanged, for diagnostics, and it now MIRRORS committed audit rows.
 *
 * The event registry, the field allowlist and the fail-closed serialization all live in ONE place,
 * `src/domain/audit.ts`. Nothing here invents a field or an event type.
 */
export type { AuditRow, AuditEventType } from "../domain/audit";

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
    const { store, auditStore, transact } = this.requireProductStack();
    const currency = this.deps.terminal.currency;
    const { rows, rejected } = validateImport(decodeUtf8Strict(bytes), currency);
    if (rejected.length > 0) return { status: "rejected", rejected };

    const instant = this.now();
    const importId = this.newId();
    const safeFileName = fileName.slice(0, 200);
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");

    // ONE transaction covers the upserts, the deactivations, the catalog_imports summary row AND
    // every audit event. A fault anywhere inside leaves the catalog and the audit trail exactly as
    // they were: everything or nothing.
    const written: AuditRow[] = [];
    const counts = transact((): ImportCounts => {
      const outcome = store.applyImport(CSV_SOURCE, rows, {
        importId,
        fileName: safeFileName,
        fileSha256,
        cashierId: cashier.id,
        now: instant,
      });

      // The summary first, so it holds the lowest `seq` of the import and the per-product events
      // that follow read as its consequences. Bounded metadata only — never a CSV row, never the
      // file.
      written.push(
        auditStore.append(
          this.auditDraft(
            cashier,
            "CATALOG_IMPORTED",
            "catalog",
            importId,
            instant,
            {},
            {
              origin: "catalog_import",
              file_name: safeFileName,
              file_sha256: fileSha256,
              row_count: rows.length,
              inserted: outcome.counts.inserted,
              updated: outcome.counts.updated,
              unchanged: outcome.counts.unchanged,
              deactivated: outcome.counts.deactivated,
            },
          ),
          this.newId(),
        ),
      );

      // One event per product the import actually touched; unchanged products produce none. An
      // inserted product gets PRODUCT_CREATED with its whole audited state — the trail answers
      // "which products did this import introduce" directly, rather than leaving it to be inferred
      // later from created_at and source.
      for (const change of outcome.changes) {
        const eventType: AuditEventType =
          change.kind === "inserted"
            ? "PRODUCT_CREATED"
            : change.kind === "updated"
              ? "PRODUCT_UPDATED"
              : "PRODUCT_DEACTIVATED";
        written.push(
          auditStore.append(
            this.auditDraft(
              cashier,
              eventType,
              "product",
              change.id,
              instant,
              diffAuditedFields(
                change.before,
                change.after,
                change.kind === "deactivated" ? ["is_active"] : AUDITED_PRODUCT_FIELDS,
              ),
              { origin: "catalog_import", catalog_import_id: importId, source: CSV_SOURCE },
            ),
            this.newId(),
          ),
        );
      }
      return outcome.counts;
    });

    // Only once the import is durable does the live catalog move. Refreshing before COMMIT would
    // mean a rolled-back import had already replaced the catalog the till is selling from.
    const source = store.loadActiveSource(currency);
    if (!source) throw new DomainError("LEDGER_INTEGRITY", "Imported catalog could not be read back");
    const next = loadCatalog(source);
    this.assertTerminalCurrency(next);
    this.catalog = next;
    this.mirror(written);
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

  /**
   * Everything a product or catalog audit event needs except its own changes and metadata. The
   * actor tier is `CURRENT_ACTOR_TIER` — 'unspecified' — because this build genuinely cannot know
   * one; see the reasoning at that constant.
   */
  private auditDraft(
    cashier: Cashier,
    eventType: AuditEventType,
    entityType: "product" | "catalog",
    entityId: string,
    instant: Date,
    changes: AuditDraft["changes"],
    metadata: AuditDraft["metadata"],
  ): AuditDraft {
    return {
      eventType,
      entityType,
      entityId,
      actorId: cashier.id,
      actorName: cashier.name,
      actorTier: CURRENT_ACTOR_TIER,
      occurredAt: instant,
      businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
      changes,
      metadata,
    };
  }

  /**
   * Mirrors committed rows to the diagnostic log. Called only after COMMIT, and it cannot fail the
   * operation: the mutation is already durable, and a logging fault must not be reported as a
   * failed sale or a failed edit.
   */
  private mirror(rows: ReadonlyArray<AuditRow>): void {
    const sink = this.deps.audit;
    if (!sink) return;
    for (const row of rows) {
      try {
        sink(row);
      } catch {
        // diagnostics never undo a committed write
      }
    }
  }

  /**
   * Product management needs three things together: the catalog table, the durable audit trail, and
   * one transaction that covers both.
   *
   * 🔴 FAIL CLOSED. A terminal that can change master data but cannot durably record WHO changed it
   * does not get to change master data. That is why this refuses rather than quietly writing an
   * unaudited edit — the whole point of migration 5 would otherwise be optional at runtime.
   */
  private requireProductStack(): {
    readonly store: CatalogRepository;
    readonly auditStore: AuditRepository;
    readonly transact: <T>(fn: () => T) => T;
  } {
    const store = this.requireStore();
    const auditStore = this.deps.auditStore;
    const transact = this.deps.transact;
    if (!auditStore || !transact) {
      throw new DomainError(
        "NOT_AVAILABLE",
        "Product management is unavailable: the durable audit trail is not wired on this terminal",
      );
    }
    return { store, auditStore, transact };
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
    const { store, auditStore, transact } = this.requireProductStack();
    const valid = validateProductDraft(draft, this.deps.terminal.currency);
    const instant = this.now();
    const written: AuditRow[] = [];

    const row = transact((): AdminProductRow => {
      // The SKU check moved inside the transaction: outside it, two near-simultaneous creates could
      // both pass the check and only the unique index would catch the second one.
      if (valid.sku !== null && store.findBySku(valid.sku)) {
        throw new DomainError("DUPLICATE_SKU", `Another product already uses the SKU '${valid.sku}'`);
      }
      const created = store.createManual(
        {
          nameAr: valid.nameAr,
          nameEn: valid.nameEn,
          sku: valid.sku,
          priceMinor: valid.price.minor,
          currency: valid.price.currency,
          baseUnit: valid.baseUnit,
        },
        instant,
      );
      // A creation records its WHOLE audited state, with every `before` null — the same
      // representation an edit uses, so there is one format and not two.
      written.push(
        auditStore.append(
          this.auditDraft(
            cashier,
            "PRODUCT_CREATED",
            "product",
            created.id,
            instant,
            diffAuditedFields(null, auditedProductState(created)),
            { origin: "manual_entry", source: created.source },
          ),
          this.newId(),
        ),
      );
      return created;
    });

    this.refreshCatalogFromStore(store);
    this.mirror(written);
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
    const { store, auditStore, transact } = this.requireProductStack();
    const instant = this.now();
    const written: AuditRow[] = [];

    const after = transact((): AdminProductRow => {
      const before = store.findById(id);
      if (!before) throw new DomainError("PRODUCT_NOT_FOUND", "This product no longer exists");
      const valid = validateProductDraft(draft, before.currency);
      if (valid.sku !== null) {
        const owner = store.findBySku(valid.sku);
        if (owner && owner.id !== id) {
          throw new DomainError("DUPLICATE_SKU", `Another product already uses the SKU '${valid.sku}'`);
        }
      }
      const updated = store.updateProduct(
        id,
        {
          nameAr: valid.nameAr,
          nameEn: valid.nameEn,
          sku: valid.sku,
          priceMinor: valid.price.minor,
          baseUnit: valid.baseUnit,
          isActive,
        },
        instant,
      );
      // ONE event for one user action, however many fields moved — price, unit, name, SKU and
      // active status all travel in this single diff. Separate PRICE_CHANGED / UNIT_CHANGED rows
      // (which earlier builds wrote to the logfile) would restate what this row already carries and
      // would double-count in any "how many changes today" question.
      const changes = diffAuditedFields(auditedProductState(before), auditedProductState(updated));
      if (Object.keys(changes).length > 0) {
        written.push(
          auditStore.append(
            this.auditDraft(cashier, "PRODUCT_UPDATED", "product", id, instant, changes, {
              origin: "manual_entry",
              source: updated.source,
            }),
            this.newId(),
          ),
        );
      }
      return updated;
    });

    this.refreshCatalogFromStore(store);
    this.mirror(written);
    return after;
  }

  /**
   * Deactivates or reactivates. Never deletes — a product that has been sold stays on record.
   *
   * This is a DIFFERENT event from an edit that happens to flip `is_active`, and deliberately so:
   * they are two different operator intents arriving through two different IPC channels. The list's
   * toggle says "stop selling this"; an edit says "these are the product's new details". The
   * durable trail keeps that distinction rather than flattening both into PRODUCT_UPDATED.
   */
  setProductActive(id: string, active: boolean): AdminProductRow {
    const cashier = this.requireCashier();
    const { store, auditStore, transact } = this.requireProductStack();
    const instant = this.now();
    const written: AuditRow[] = [];

    // 🔴 The whole operation is under ONE service-owned transaction. `CatalogRepository.setActive`
    // deliberately has none of its own: until migration 5 it had no transaction at all, which was
    // the one atomicity hole left in the application, and this is where it closes.
    const after = transact((): AdminProductRow => {
      const before = store.findById(id);
      if (!before) throw new DomainError("PRODUCT_NOT_FOUND", "This product no longer exists");
      const updated = store.setActive(id, active, instant);
      const changes = diffAuditedFields(
        { is_active: before.is_active === 1n },
        { is_active: updated.is_active === 1n },
        ["is_active"],
      );
      // Toggling a product to the state it is already in changed nothing, and nothing is not an
      // event.
      if (Object.keys(changes).length > 0) {
        written.push(
          auditStore.append(
            this.auditDraft(
              cashier,
              active ? "PRODUCT_ACTIVATED" : "PRODUCT_DEACTIVATED",
              "product",
              id,
              instant,
              changes,
              { origin: "manual_entry", source: updated.source },
            ),
            this.newId(),
          ),
        );
      }
      return updated;
    });

    this.refreshCatalogFromStore(store);
    this.mirror(written);
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
