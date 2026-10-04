/** Pure conversions between domain objects and IPC DTOs. Used by main (encode) and renderer (decode). */
import type { Catalog, Product } from "../domain/catalog";
import { DomainError } from "../domain/errors";
import { type Money, money } from "../domain/money";
import type { TodaySalesReport } from "../domain/report";
import type { SaleRecord, VoidRecord } from "../domain/sale";
import type { CatalogDto, MoneyDto, ProductDto, SaleDto, TodaySalesDto, VoidDto } from "./ipcContract";

export function toMoneyDto(m: Money): MoneyDto {
  return { minor: m.minor.toString(), currency: m.currency };
}

/** Strict: only a plain non-negative integer string is accepted — "1.5", "1e3", "-1" all fail. */
export function parseMinor(text: unknown): bigint {
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,17})$/.test(text)) {
    throw new DomainError("INVALID_INPUT", "Amount must be a string of whole minor units");
  }
  return BigInt(text);
}

export function fromMoneyDto(dto: MoneyDto): Money {
  return money(parseMinor(dto.minor), dto.currency);
}

export function toProductDto(p: Product): ProductDto {
  return { id: p.id, sku: p.sku, name: p.name, price: toMoneyDto(p.price) };
}

export function toCatalogDto(c: Catalog): CatalogDto {
  return { currency: c.currency, products: c.products.map(toProductDto) };
}

/** Rebuilds a usable Catalog in the renderer (for display totals only — main always reprices). */
export function fromCatalogDto(dto: CatalogDto): Catalog {
  const products: Product[] = dto.products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: fromMoneyDto(p.price) }));
  return { currency: dto.currency, products, byId: new Map(products.map((p) => [p.id, p])) };
}

export function toSaleDto(s: SaleRecord): SaleDto {
  return {
    id: s.id,
    receiptNumber: s.receiptNumber,
    cashierId: s.cashierId,
    cashierName: s.cashierName,
    currency: s.currency,
    subtotal: toMoneyDto(s.subtotal),
    total: toMoneyDto(s.total),
    paymentMethod: s.paymentMethod,
    businessDate: s.businessDate,
    completedAt: s.completedAt,
    lines: s.lines.map((l) => ({
      lineNo: l.lineNo,
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      quantity: l.quantity,
      unitPrice: toMoneyDto(l.unitPrice),
      lineTotal: toMoneyDto(l.lineTotal),
    })),
  };
}

export function toVoidDto(v: VoidRecord): VoidDto {
  return { ...v };
}

export function toTodaySalesDto(r: TodaySalesReport): TodaySalesDto {
  return {
    date: r.date,
    currency: r.currency,
    completedSalesCount: r.completedSalesCount,
    voidedSalesCount: r.voidedSalesCount,
    grossSales: toMoneyDto(r.grossSales),
    voidTotal: toMoneyDto(r.voidTotal),
    netSales: toMoneyDto(r.netSales),
  };
}
