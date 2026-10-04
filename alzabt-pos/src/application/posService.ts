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
import type { Catalog } from "../domain/catalog";
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
import type { CashierFixture } from "../fixtures/cashiers";
import type { TerminalConfig } from "../fixtures/terminal";
import type { SaleRepository } from "../persistence/saleRepository";
import { type Cashier, verifyCashierPin } from "./cashierAuth";

export interface PosServiceDeps {
  readonly repository: SaleRepository;
  readonly catalog: Catalog;
  readonly cashiers: ReadonlyArray<CashierFixture>;
  readonly terminal: TerminalConfig;
  readonly now?: () => Date;
  readonly newId?: () => string;
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

export class PosService {
  private readonly repository: SaleRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private cashier: Cashier | null = null;

  constructor(private readonly deps: PosServiceDeps) {
    if (deps.catalog.currency !== deps.terminal.currency) {
      throw new DomainError(
        "MIXED_CURRENCY",
        `Catalog currency ${deps.catalog.currency} differs from terminal currency ${deps.terminal.currency}`,
      );
    }
    this.repository = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  // ── Session ─────────────────────────────────────────────────────────────────────────────────────

  listCashiers(): Cashier[] {
    return this.deps.cashiers.map((c) => ({ id: c.id, name: c.name }));
  }

  login(cashierId: string, pin: string): Cashier {
    this.cashier = verifyCashierPin(this.deps.cashiers, cashierId, pin);
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
    return this.deps.catalog;
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
          lines: input.lines.map((l) => [l.productId, l.quantity]),
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

    const priced = priceCart(this.deps.catalog, input.lines);
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
        quantity: l.quantity,
        unitPriceMinor: l.unitPrice.minor,
        lineTotalMinor: l.lineTotal.minor,
      })),
    );
    const sale = this.repository.getSale(saleId);
    if (!sale) throw new DomainError("LEDGER_INTEGRITY", "Committed sale could not be read back");
    return { sale, duplicate: false };
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
