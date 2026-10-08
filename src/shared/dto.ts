/** Pure conversions between domain objects and IPC DTOs. Used by main (encode) and renderer (decode). */
import type { Catalog, Product } from "../domain/catalog";
import { DomainError } from "../domain/errors";
import { type Money, money } from "../domain/money";
import type { TodaySalesReport } from "../domain/report";
import type { SaleRecord, VoidRecord } from "../domain/sale";
import type { AdminProductRow } from "../persistence/catalogRepository";
import { formatDecimal } from "../domain/money";
import { formatInvoiceQuantity } from "../domain/invoice";
import type { CompanyProfileRow } from "../persistence/companyProfileRepository";
import type { InvoiceLineRow, InvoiceRow } from "../persistence/invoiceRepository";
import type { ReconciliationRow } from "../persistence/reconciliationRepository";
import type {
  AdminProductDto,
  CatalogDto,
  CompanyProfileDto,
  DifferenceDto,
  InvoiceDto,
  InvoiceLineDto,
  InvoiceTaxSnapshotDto,
  InvoiceViewDto,
  IssuerSnapshotDto,
  MoneyDto,
  ProductDto,
  ReconciliationCandidateDto,
  ReconciliationClassificationDto,
  ReconciliationDto,
  ResolutionStateDto,
  SaleDto,
  TodaySalesDto,
  VoidDto,
} from "./ipcContract";

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
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    price: toMoneyDto(p.price),
    baseUnit: p.baseUnit,
    priceNeedsReview: p.priceNeedsReview,
  };
}

export function toCatalogDto(c: Catalog): CatalogDto {
  return { currency: c.currency, products: c.products.map(toProductDto) };
}

/** Rebuilds a usable Catalog in the renderer (for display totals only — main always reprices). */
export function fromCatalogDto(dto: CatalogDto): Catalog {
  const products: Product[] = dto.products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    price: fromMoneyDto(p.price),
    baseUnit: p.baseUnit,
    priceNeedsReview: p.priceNeedsReview,
  }));
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
      saleUnit: l.saleUnit,
      quantityMilli: l.quantityMilli,
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

/**
 * A catalog row as the administration screen needs it. `bigint` columns become decimal strings and
 * SQLite's 0/1 integers become booleans here, once, so no renderer code ever sees a `bigint` or
 * has to remember that `is_active` is a number.
 */
export function toAdminProductDto(row: AdminProductRow): AdminProductDto {
  const price = money(row.selling_price_minor, row.currency);
  return {
    id: row.id,
    source: row.source,
    sourceKey: row.source_key,
    sku: row.sku,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    price: toMoneyDto(price),
    priceDecimal: formatDecimal(price),
    baseUnit: row.base_unit,
    priceNeedsReview: row.price_needs_review === 1n,
    isActive: row.is_active === 1n,
    updatedAt: row.updated_at,
  };
}

// ── Manual invoices (migration 6) ───────────────────────────────────────────────────────────────
//
// 🔴 Every scaled value leaves as a STRING of minor units. A bigint cannot be structured-cloned
// across IPC, and a `number` would silently lose precision — which on a money column is the exact
// class of bug this codebase refuses to allow anywhere.

/** Parses the issuer snapshot stored on a finalized invoice. Returns null for a draft. */
export function toIssuerDto(json: string | null): IssuerSnapshotDto | null {
  if (json === null) return null;
  const o = JSON.parse(json) as Record<string, unknown>;
  const text = (key: string) => (typeof o[key] === "string" ? (o[key] as string) : null);
  return {
    nameAr: text("name_ar"),
    nameEn: text("name_en"),
    legalName: text("legal_name"),
    tagline: text("tagline"),
    address: text("address"),
    phone1: text("phone1"),
    phone2: text("phone2"),
    email: text("email"),
    logoPath: text("logo_path"),
    taxpayerNumber: text("taxpayer_number"),
    commercialRegister: text("commercial_register"),
    vatNumber: text("vat_number"),
  };
}

export function toInvoiceTaxSnapshotDto(json: string | null): InvoiceTaxSnapshotDto | null {
  if (json === null) return null;
  const o = JSON.parse(json) as { enabled?: unknown; rate_basis_points?: unknown; label?: unknown };
  return {
    enabled: o.enabled === true,
    rateBasisPoints: typeof o.rate_basis_points === "number" ? o.rate_basis_points : 0,
    label: typeof o.label === "string" ? o.label : null,
  };
}

export function toCompanyProfileDto(row: CompanyProfileRow): CompanyProfileDto {
  const bp = Number(row.tax_rate_bp);
  return {
    nameAr: row.name_ar,
    nameEn: row.name_en,
    legalName: row.legal_name,
    tagline: row.tagline,
    address: row.address,
    phone1: row.phone1,
    phone2: row.phone2,
    email: row.email,
    logoPath: row.logo_path,
    taxpayerNumber: row.taxpayer_number,
    commercialRegister: row.commercial_register,
    vatNumber: row.vat_number,
    taxEnabled: row.tax_enabled === 1n,
    // Basis points back to the plain percentage the form re-submits, exactly and without a float:
    // 1150 -> "11.5", 1100 -> "11", 0 -> "0".
    taxRatePercent: bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, ""),
    taxLabel: row.tax_label,
    nextInvoiceNumber: Number(row.next_invoice_number),
    updatedAt: row.updated_at,
  };
}

export function toInvoiceLineDto(row: InvoiceLineRow, currency: string): InvoiceLineDto {
  const quantityMilli = Number(row.quantity_milli);
  return {
    id: row.id,
    lineNo: Number(row.line_no),
    description: row.description,
    unitLabel: row.unit_label,
    canonicalUnit: row.canonical_unit,
    productId: row.product_id,
    quantityMilli,
    // Formatted by the ONE domain formatter, so the sheet, the PDF and the service agree.
    quantityText: formatInvoiceQuantity(quantityMilli),
    unitPrice: toMoneyDto(money(row.unit_price_minor, currency)),
    lineTotal: toMoneyDto(money(row.line_total_minor, currency)),
  };
}

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  const c = row.currency;
  return {
    id: row.id,
    status: row.status === "final" ? "final" : "draft",
    invoiceNumber: row.invoice_number === null ? null : Number(row.invoice_number),
    invoiceDate: row.invoice_date,
    currency: c,
    customerName: row.customer_name,
    customerAddress: row.customer_address,
    customerPhone: row.customer_phone,
    notes: row.notes,
    subtotal: toMoneyDto(money(row.subtotal_minor, c)),
    tax: toMoneyDto(money(row.tax_minor, c)),
    total: toMoneyDto(money(row.total_minor, c)),
    paid: toMoneyDto(money(row.paid_minor, c)),
    balanceDue: toMoneyDto(money(row.balance_due_minor, c)),
    amountInWords: row.amount_in_words,
    issuer: toIssuerDto(row.issuer_snapshot_json),
    taxSnapshot: toInvoiceTaxSnapshotDto(row.tax_snapshot_json),
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
  };
}

export function toInvoiceViewDto(view: {
  readonly invoice: InvoiceRow;
  readonly lines: ReadonlyArray<InvoiceLineRow>;
}): InvoiceViewDto {
  return {
    invoice: toInvoiceDto(view.invoice),
    lines: view.lines.map((l) => toInvoiceLineDto(l, view.invoice.currency)),
  };
}

/**
 * One review item, with the frozen invoice line it came from.
 *
 * `line` is passed in rather than looked up here so this stays a pure conversion; the caller owns
 * the read. A null line would mean the invoice line is gone, which migration 6's foreign key makes
 * impossible — it is typed nullable rather than asserted away.
 */
/** The observed catalog rows, as stored by the service: snake_case keys, price as exact digits. */
function toCandidateDtos(json: string): ReconciliationCandidateDto[] {
  const rows = JSON.parse(json) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id ?? ""),
    sku: typeof r.sku === "string" ? r.sku : null,
    nameAr: String(r.name_ar ?? ""),
    nameEn: typeof r.name_en === "string" ? r.name_en : null,
    sellingPriceMinor: String(r.selling_price_minor ?? "0"),
    baseUnit: String(r.base_unit ?? ""),
    isActive: r.is_active === true,
  }));
}

export function toReconciliationDto(
  row: ReconciliationRow,
  context: {
    readonly invoice: InvoiceRow | null;
    readonly line: InvoiceLineRow | null;
  },
): ReconciliationDto {
  const currency = context.invoice?.currency ?? "USD";
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: context.invoice?.invoice_number == null ? null : Number(context.invoice.invoice_number),
    invoiceDate: context.invoice?.invoice_date ?? null,
    line: context.line ? toInvoiceLineDto(context.line, currency) : null,
    classification: row.classification as ReconciliationClassificationDto,
    matchTier: row.match_tier as ReconciliationDto["matchTier"],
    matchedProductId: row.matched_product_id,
    // The snapshot is STORED in the database's snake_case, like every other column in this
    // codebase; the DTO is camelCase, like every other DTO. Mapping here is what keeps both true —
    // `JSON.parse` alone silently produced an object that did not match the declared type, which no
    // compiler could catch across a parse and which `tests/main/invoiceIpc.test.ts` now asserts.
    candidates: row.candidates_json === null ? [] : toCandidateDtos(row.candidates_json),
    differences: JSON.parse(row.differences_json) as DifferenceDto[],
    status: row.status as ResolutionStateDto,
    selectedFields: row.selected_fields_json === null ? null : (JSON.parse(row.selected_fields_json) as string[]),
    resolvedAt: row.resolved_at,
    resolutionActorName: row.resolution_actor_name,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    attemptCount: Number(row.attempt_count),
    createdAt: row.created_at,
  };
}
