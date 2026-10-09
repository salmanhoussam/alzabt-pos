/**
 * InvoiceService — the manual invoice's business operations, and the one path by which reviewing an
 * invoice may change the catalog.
 *
 * 🔴 TOTALS ARE NEVER TAKEN FROM THE RENDERER. The UI sends descriptions, typed quantities and
 * typed prices; every line total, subtotal, tax amount, grand total and balance due is computed
 * here from persisted values, exactly as `createSale` already refuses to trust a displayed total.
 *
 * 🔴 THE CATALOG IS NEVER WRITTEN FROM THIS FILE. Every product create and product edit goes
 * through `PosService` (the `ProductWriter` slice below), which owns the transaction that binds a
 * catalog mutation to its migration-5 audit row. There is deliberately no second write path, and
 * no `CatalogRepository` write method is reachable from here.
 *
 * 🔴 NOTHING IS AUTOMATIC. Finalization CLASSIFIES every line against the catalog and writes a
 * review queue. It changes no product, creates no product and clears no flag. Each of those is a
 * separate, explicit, named decision by a person.
 */
import { createHash } from "node:crypto";
import { businessDateOf } from "../domain/businessDay";
import { DomainError } from "../domain/errors";
import {
  MAX_CUSTOMER_FIELD,
  MAX_DESCRIPTION,
  MAX_INVOICE_LINES,
  MAX_NOTES,
  type TaxConfig,
  TAX_DISABLED,
  assertLineFinalizable,
  cleanText,
  computeInvoiceTotals,
  invoiceLineTotal,
  parseInvoiceQuantity,
  requireText,
} from "../domain/invoice";
import { amountInWordsAr } from "../domain/amountInWords";
import { MAX_UNIT_LABEL, canonicalUnitFor, isCanonicalUnit } from "../domain/invoiceUnits";
import {
  type CatalogCandidate,
  type Difference,
  type DifferenceField,
  type InvoiceLineObservation,
  RESOLUTION_STATES,
  type ResolutionState,
  classifyInvoiceLine,
  isUnresolved,
} from "../domain/invoiceMatching";
import { type Money, formatDecimal, money, parseDecimal } from "../domain/money";
import { MAX_PRODUCT_NAME, MAX_SKU, type ProductDraft } from "../domain/productDraft";
import { assertUnitPriceMinor } from "../domain/quantity";
import type { Cashier } from "./cashierAuth";
import type { ProductWriteProvenance } from "./posService";
import type { AdminProductRow, CatalogRepository } from "../persistence/catalogRepository";
import type { CompanyProfileInput, CompanyProfileRepository, CompanyProfileRow } from "../persistence/companyProfileRepository";
import type {
  InvoiceLineInput,
  InvoiceLineRow,
  InvoiceRepository,
  InvoiceRow,
} from "../persistence/invoiceRepository";
import type { ReconciliationRepository, ReconciliationRow } from "../persistence/reconciliationRepository";
import type { NewSaleLine, NewSaleHeader } from "../persistence/saleRepository";
import { type SaleRecord, paymentStatusFor } from "../domain/sale";
import type { TerminalConfig } from "../fixtures/terminal";

/** Where a reconciliation edit says it came from, in audit metadata. */
/** 100% in basis points. A rate above this is refused, not clamped. */
export const MAX_TAX_BASIS_POINTS = 10_000;

/**
 * A percentage typed as TEXT becomes exact basis points: "11" -> 1100, "11.5" -> 1150.
 *
 * 🔴 ONE PARSER, USED BY BOTH the shop setting and a single invoice's own rate, so the two can
 * never disagree about what "11.5" means. No float is ever constructed from the typed text.
 */
export function parseTaxPercent(value: unknown): number {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new DomainError("INVALID_AMOUNT", "A tax rate must be a percentage like '11' or '11.5'");
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  if (bp > MAX_TAX_BASIS_POINTS) throw new DomainError("INVALID_AMOUNT", "A tax rate may not exceed 100 percent");
  return bp;
}

export const RECONCILIATION_ORIGIN = "invoice_reconciliation";

/**
 * The narrow slice of `PosService` this service is allowed to use.
 *
 * It is an interface so the dependency is visible and auditable — not so the real service can be
 * replaced by something weaker. The tests inject the REAL `PosService`, because a fake would prove
 * the invoice code calls a method and nothing about whether an audit row was actually written.
 */
export interface ProductWriter {
  currentCashier(): Cashier | null;
  listProducts(): AdminProductRow[];
  createProduct(draft: ProductDraft, provenance?: ProductWriteProvenance): AdminProductRow;
  updateProduct(
    id: string,
    draft: ProductDraft,
    isActive: boolean,
    provenance?: ProductWriteProvenance,
  ): AdminProductRow;
}

/**
 * The narrow slice of `SaleRepository` this service may use, for the same reason `ProductWriter`
 * exists: the dependency is visible and auditable, and the tests inject the REAL repository so a
 * passing test means a real row in `sales`, not a method call on a fake.
 */
export interface SaleWriter {
  commitSale(header: NewSaleHeader, lines: ReadonlyArray<NewSaleLine>): number;
  findByIdempotencyKey(key: string): { sale: SaleRecord; fingerprint: string } | undefined;
  findByInvoiceId(invoiceId: string): SaleRecord | undefined;
}

/**
 * The deterministic idempotency key of an invoice's sale.
 *
 * 🔴 DETERMINISTIC ON PURPOSE, and it is the second of two independent defences against a duplicate
 * sale. The first is `sales.invoice_id UNIQUE`, which makes a second sale for one invoice
 * structurally impossible at the database level. This one makes a RETRY recognisable before it is
 * attempted, so the service can answer "already done" instead of hitting a constraint. It fits the
 * existing contract unchanged: /^[A-Za-z0-9-]{8,100}$/ accepts "inv-" plus a UUID.
 */
export function invoiceSaleIdempotencyKey(invoiceId: string): string {
  return `inv-${invoiceId}`;
}

export interface InvoiceServiceDeps {
  readonly invoices: InvoiceRepository;
  readonly reconciliation: ReconciliationRepository;
  readonly company: CompanyProfileRepository;
  /** Read-only here. Every WRITE goes through `products`. */
  readonly catalogStore: CatalogRepository;
  readonly products: ProductWriter;
  /** Where a finalized invoice becomes a real sale (migration 7). */
  readonly sales: SaleWriter;
  /** `db.transaction(fn).immediate()` — the one connection, the one transaction. */
  readonly transact: <T>(fn: () => T) => T;
  readonly terminal: TerminalConfig;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** What the UI receives: the document, its lines, and the totals it must display. */
export interface InvoiceView {
  readonly invoice: InvoiceRow;
  readonly lines: ReadonlyArray<InvoiceLineRow>;
}

/** The header fields an operator may edit while a draft is open. */
export interface InvoiceHeaderDraft {
  readonly invoiceDate?: string | null;
  readonly customerName?: string | null;
  readonly customerAddress?: string | null;
  readonly customerPhone?: string | null;
  readonly notes?: string | null;
  /** Typed text, e.g. "100.00". Null or absent means nothing paid. */
  readonly paid?: string | null;
}

/** One line as typed. Quantity and price arrive as text and are parsed here, never as numbers. */
export interface InvoiceLineDraft {
  readonly description?: string | null;
  readonly unitLabel?: string | null;
  /** An operator-chosen canonical unit. Absent lets the known-label map decide, or stay null. */
  readonly canonicalUnit?: string | null;
  readonly productId?: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
}

/** The fields an operator explicitly selected to copy from the invoice into the catalog. */
export interface CatalogUpdateSelection {
  readonly fields: ReadonlyArray<DifferenceField>;
  /**
   * Required when `base_unit` is selected and the invoice's printed label maps to nothing — the
   * "كيس (50PCS)" case. The operator names the catalog unit; it is never guessed.
   */
  readonly canonicalUnit?: string;
  /**
   * Required when `name_en` is selected. An English name is NEVER inferred from a free-text
   * invoice description, so selecting that field without supplying a value is refused.
   */
  readonly nameEn?: string | null;
}

/** What the operator typed when creating a product from a line nothing matched. */
export interface NewProductFromInvoice {
  readonly nameAr?: string | null;
  readonly nameEn?: string | null;
  readonly sku?: string | null;
  /** A catalog base unit. Required when the invoice's label maps to nothing. */
  readonly baseUnit?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Narrows the stored status text to the domain union. The column carries a CHECK listing exactly
 * these seven values, so an unknown one means the database has been edited outside this
 * application — which is reported rather than coerced into a state the code recognises.
 */
function resolutionState(status: string): ResolutionState {
  if (!(RESOLUTION_STATES as ReadonlyArray<string>).includes(status)) {
    throw new DomainError("LEDGER_INTEGRITY", `'${status}' is not a reconciliation state this build knows`);
  }
  return status as ResolutionState;
}

/** The selling price as the product screen would have typed it — exact minor units, no float. */
function priceText(minor: bigint, currency: string): string {
  return formatDecimal(money(minor, currency));
}

export class InvoiceService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: InvoiceServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  private requireCashier(): Cashier {
    const cashier = this.deps.products.currentCashier();
    if (!cashier) throw new DomainError("NOT_LOGGED_IN", "Sign in first");
    return cashier;
  }

  // ── Company profile ─────────────────────────────────────────────────────────────────────────────

  getCompanyProfile(): CompanyProfileRow | null {
    this.requireCashier();
    return this.deps.company.find();
  }

  /**
   * Saves the shop's own identity. The three official identifiers stay three fields.
   *
   * 🔴 Printing a taxpayer number, a commercial register number or a VAT number does NOT make an
   * invoice legally or tax compliant, and nothing in this build claims it does. They are fields the
   * merchant asked to be able to print.
   */
  saveCompanyProfile(input: {
    readonly nameAr: unknown;
    readonly nameEn?: unknown;
    readonly legalName?: unknown;
    readonly tagline?: unknown;
    readonly address?: unknown;
    readonly phone1?: unknown;
    readonly phone2?: unknown;
    readonly email?: unknown;
    readonly logoPath?: unknown;
    readonly taxpayerNumber?: unknown;
    readonly commercialRegister?: unknown;
    readonly vatNumber?: unknown;
    readonly taxEnabled?: unknown;
    readonly taxRatePercent?: unknown;
    readonly taxLabel?: unknown;
    readonly startNumber?: unknown;
  }): CompanyProfileRow {
    this.requireCashier();
    const instant = this.now();

    const taxEnabled = input.taxEnabled === true;
    let taxRateBp = 0;
    // The SAME parser a single invoice's own rate uses — see parseTaxPercent.
    if (taxEnabled) taxRateBp = parseTaxPercent(input.taxRatePercent);

    const profile: CompanyProfileInput = {
      nameAr: requireText(input.nameAr, "name_ar", MAX_PRODUCT_NAME),
      nameEn: cleanText(input.nameEn, "name_en", MAX_PRODUCT_NAME),
      legalName: cleanText(input.legalName, "legal_name", MAX_PRODUCT_NAME),
      tagline: cleanText(input.tagline, "tagline", MAX_CUSTOMER_FIELD),
      address: cleanText(input.address, "address", MAX_NOTES),
      phone1: cleanText(input.phone1, "phone1", MAX_CUSTOMER_FIELD),
      phone2: cleanText(input.phone2, "phone2", MAX_CUSTOMER_FIELD),
      email: cleanText(input.email, "email", MAX_CUSTOMER_FIELD),
      logoPath: cleanText(input.logoPath, "logo_path", MAX_NOTES),
      taxpayerNumber: cleanText(input.taxpayerNumber, "taxpayer_number", MAX_CUSTOMER_FIELD),
      commercialRegister: cleanText(input.commercialRegister, "commercial_register", MAX_CUSTOMER_FIELD),
      vatNumber: cleanText(input.vatNumber, "vat_number", MAX_CUSTOMER_FIELD),
      taxEnabled,
      taxRateBp,
      taxLabel: cleanText(input.taxLabel, "tax_label", MAX_CUSTOMER_FIELD),
    };

    const start = this.parseStartNumber(input.startNumber);
    return this.deps.transact(() => this.deps.company.save(profile, instant, start));
  }

  private parseStartNumber(value: unknown): number {
    if (value === null || value === undefined || value === "") return 1;
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new DomainError("INVALID_INPUT", "The first invoice number must be a whole number of 1 or more");
    }
    return n;
  }

  /**
   * Moves the invoice sequence's starting point — the shop continuing a paper book at 61.
   *
   * 🔴 Allowed ONLY while no invoice has been finalized. Afterwards, moving the sequence could
   * reissue a number that is already printed on a document in somebody's hands, and the UNIQUE
   * index would eventually refuse it anyway — with a database error instead of an explanation.
   */
  setNextInvoiceNumber(next: unknown): CompanyProfileRow {
    this.requireCashier();
    const value = this.parseStartNumber(next);
    const instant = this.now();
    return this.deps.transact(() => {
      if (this.deps.invoices.countFinalized() > 0) {
        throw new DomainError(
          "INVOICE_NUMBERING_LOCKED",
          "The invoice numbering cannot be changed once an invoice has been issued",
        );
      }
      if (!this.deps.company.find()) {
        throw new DomainError("COMPANY_PROFILE_REQUIRED", "Save the shop's own details first");
      }
      return this.deps.company.setNextInvoiceNumber(value, instant);
    });
  }

  private taxConfig(profile: CompanyProfileRow | null): TaxConfig {
    if (!profile || profile.tax_enabled !== 1n) return TAX_DISABLED;
    return {
      enabled: true,
      rateBasisPoints: Number(profile.tax_rate_bp),
      label: profile.tax_label,
    };
  }

  /**
   * The tax that governs ONE invoice.
   *
   * 🔴 THE INVOICE'S OWN STATE WINS, and the shop setting is only the default a draft starts from.
   * Tax used to be read from `company_profile` at finalize time, which meant issuing one taxed
   * invoice required toggling a global switch on and off around it — and anything finalized in
   * between silently inherited the wrong state. The invoice carries its own answer from the moment
   * the operator sets it, so two consecutive invoices cannot leak tax into each other.
   *
   * A draft created before this existed has no tax state of its own; it falls back to the shop
   * setting, which is exactly how it behaved yesterday.
   */
  private invoiceTax(invoice: InvoiceRow): TaxConfig {
    if (invoice.tax_snapshot_json === null) return this.taxConfig(this.deps.company.find());
    const parsed = JSON.parse(invoice.tax_snapshot_json) as {
      enabled?: unknown;
      rate_basis_points?: unknown;
      label?: unknown;
    };
    if (parsed.enabled !== true) return TAX_DISABLED;
    const bp = Number(parsed.rate_basis_points);
    if (!Number.isSafeInteger(bp) || bp < 0 || bp > MAX_TAX_BASIS_POINTS) {
      throw new DomainError("LEDGER_INTEGRITY", "This invoice carries an unusable tax rate");
    }
    return { enabled: true, rateBasisPoints: bp, label: typeof parsed.label === "string" ? parsed.label : null };
  }

  /**
   * Sets whether THIS invoice is taxed, and at what rate. Draft only.
   *
   * The percentage arrives as TYPED TEXT and is converted to exact basis points by the same parser
   * the company profile uses — never a float, and never a rate the renderer worked out.
   */
  setInvoiceTax(invoiceId: string, input: { readonly enabled: unknown; readonly ratePercent?: unknown; readonly label?: unknown }): InvoiceView {
    this.requireCashier();
    const instant = this.now();
    return this.deps.transact(() => {
      const invoice = this.requireDraft(invoiceId);
      const enabled = input.enabled === true;
      let snapshot: string | null;
      if (!enabled) {
        snapshot = JSON.stringify({ enabled: false, rate_basis_points: 0, label: null });
      } else {
        const rateBasisPoints = parseTaxPercent(input.ratePercent);
        const label = cleanText(input.label ?? null, "tax_label", MAX_CUSTOMER_FIELD);
        snapshot = JSON.stringify({ enabled: true, rate_basis_points: rateBasisPoints, label });
      }
      this.deps.invoices.setTaxSnapshot(invoiceId, snapshot, instant);
      // Re-read, so the totals below are computed from what was actually stored.
      const stored = this.deps.invoices.requireById(invoiceId);
      const updated = this.rewriteTotals(stored, null, instant);
      return { invoice: updated, lines: this.deps.invoices.listLines(invoiceId) };
    });
  }

  // ── Drafts ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Opens an empty draft.
   *
   * 🔴 NO INVOICE NUMBER IS CONSUMED HERE. The number is scarce — it is printed on paper and it is
   * audited — and it is allocated at FINALIZE. A hundred abandoned drafts leave the sequence
   * exactly where it was.
   */
  createDraft(): InvoiceView {
    const cashier = this.requireCashier();
    const instant = this.now();
    const id = this.newId();
    return this.deps.transact(() => {
      const invoice = this.deps.invoices.createDraft(id, this.deps.terminal.currency, cashier, instant);
      return { invoice, lines: [] };
    });
  }

  getInvoice(invoiceId: string): InvoiceView {
    this.requireCashier();
    const invoice = this.deps.invoices.findById(invoiceId);
    if (!invoice) throw new DomainError("INVOICE_NOT_FOUND", "This invoice no longer exists");
    return { invoice, lines: this.deps.invoices.listLines(invoiceId) };
  }

  listDrafts(limit?: number): InvoiceRow[] {
    this.requireCashier();
    return this.deps.invoices.listDrafts(limit);
  }

  listFinalized(limit?: number, offset?: number): InvoiceRow[] {
    this.requireCashier();
    return this.deps.invoices.listFinalized(limit, offset);
  }

  searchFinalized(term: unknown, limit?: number): InvoiceRow[] {
    this.requireCashier();
    const text = cleanText(term, "search", MAX_CUSTOMER_FIELD);
    if (text === null) return this.deps.invoices.listFinalized(limit ?? 50, 0);
    return this.deps.invoices.searchFinalized(text, limit);
  }

  /**
   * The draft guard, read INSIDE the caller's transaction. The database triggers are the final
   * safeguard and would abort any edit to a finalized invoice regardless; this exists so the
   * operator is told "this invoice has been issued" instead of seeing a trigger message.
   */
  private requireDraft(invoiceId: string): InvoiceRow {
    const invoice = this.deps.invoices.findById(invoiceId);
    if (!invoice) throw new DomainError("INVOICE_NOT_FOUND", "This invoice no longer exists");
    if (invoice.status !== "draft") {
      throw new DomainError(
        "INVOICE_NOT_DRAFT",
        `Invoice ${invoice.invoice_number} has been issued and cannot be changed`,
      );
    }
    return invoice;
  }

  /**
   * Recomputes and stores the money columns from the lines that are actually in the database.
   *
   * Called after every line and header change, because the table CHECKs its own arithmetic: a
   * draft is never left in a state where `total <> subtotal + tax`, not even for an instant.
   */
  private rewriteTotals(invoice: InvoiceRow, header: InvoiceHeaderDraft | null, instant: Date): InvoiceRow {
    const lines = this.deps.invoices.listLines(invoice.id);
    const currency = invoice.currency;
    const lineTotals = lines.map((l) => money(l.line_total_minor, currency));

    const paid = this.resolvePaid(invoice, header, currency);
    // 🔴 THE INVOICE'S OWN TAX, not the shop's current switch — see invoiceTax().
    const tax = this.invoiceTax(invoice);

    let totals;
    try {
      totals = computeInvoiceTotals(lineTotals, currency, tax, paid);
    } catch (error) {
      if (error instanceof DomainError && error.code === "INVALID_AMOUNT") {
        // The one real trap: removing a line can leave `paid` above the new total, which the table's
        // own CHECK forbids. Say exactly that, with both numbers, and name the way out — never a
        // bare constraint failure.
        const subtotal = lineTotals.reduce((a, b) => a + b.minor, 0n);
        throw new DomainError(
          "INVALID_AMOUNT",
          `The paid amount (${priceText(paid.minor, currency)}) is more than this invoice now totals ` +
            `(${priceText(subtotal, currency)}). Reduce the paid amount first.`,
        );
      }
      throw error;
    }

    return this.deps.invoices.updateDraft(
      invoice.id,
      {
        invoiceDate:
          header && header.invoiceDate !== undefined
            ? this.cleanDate(header.invoiceDate)
            : invoice.invoice_date,
        customerName:
          header && header.customerName !== undefined
            ? cleanText(header.customerName, "customer_name", MAX_CUSTOMER_FIELD)
            : invoice.customer_name,
        customerAddress:
          header && header.customerAddress !== undefined
            ? cleanText(header.customerAddress, "customer_address", MAX_NOTES)
            : invoice.customer_address,
        customerPhone:
          header && header.customerPhone !== undefined
            ? cleanText(header.customerPhone, "customer_phone", MAX_CUSTOMER_FIELD)
            : invoice.customer_phone,
        notes: header && header.notes !== undefined ? cleanText(header.notes, "notes", MAX_NOTES) : invoice.notes,
        paidMinor: totals.paid.minor,
      },
      {
        subtotalMinor: totals.subtotal.minor,
        taxMinor: totals.tax.minor,
        totalMinor: totals.total.minor,
        balanceDueMinor: totals.balanceDue.minor,
      },
      instant,
    );
  }

  private resolvePaid(invoice: InvoiceRow, header: InvoiceHeaderDraft | null, currency: string): Money {
    if (!header || header.paid === undefined) return money(invoice.paid_minor, currency);
    if (header.paid === null || header.paid.trim() === "") return money(0n, currency);
    return parseDecimal(header.paid.trim(), currency);
  }

  private cleanDate(value: unknown): string | null {
    const text = cleanText(value, "invoice_date", 10);
    if (text === null) return null;
    if (!ISO_DATE.test(text)) {
      throw new DomainError("INVALID_INPUT", "An invoice date must be written as YYYY-MM-DD");
    }
    return text;
  }

  /** Edits the draft's header. A draft may stay incomplete — none of these fields is required yet. */
  updateDraftHeader(invoiceId: string, header: InvoiceHeaderDraft): InvoiceView {
    this.requireCashier();
    const instant = this.now();
    return this.deps.transact(() => {
      const invoice = this.requireDraft(invoiceId);
      const updated = this.rewriteTotals(invoice, header, instant);
      return { invoice: updated, lines: this.deps.invoices.listLines(invoiceId) };
    });
  }

  /**
   * Parses one typed line into exact integers.
   *
   * The unit LABEL is kept verbatim — "كيس (50PCS)" and all. A canonical unit is attached only when
   * the reviewed label map knows one or the operator chose one; otherwise it stays null, which is a
   * result and not a failure.
   */
  private parseLine(draft: InvoiceLineDraft, currency: string): InvoiceLineInput {
    const description = cleanText(draft.description, "description", MAX_DESCRIPTION);
    const unitLabel = cleanText(draft.unitLabel, "unit_label", MAX_UNIT_LABEL);
    const quantityMilli = parseInvoiceQuantity(draft.quantity);
    const unitPrice = parseDecimal(String(draft.unitPrice ?? "").trim(), currency);
    assertUnitPriceMinor(unitPrice.minor);

    let canonicalUnit: string | null = null;
    if (draft.canonicalUnit !== undefined && draft.canonicalUnit !== null && draft.canonicalUnit !== "") {
      if (!isCanonicalUnit(draft.canonicalUnit)) {
        throw new DomainError("UNSUPPORTED_UNIT", `'${draft.canonicalUnit}' is not a unit this terminal uses`);
      }
      canonicalUnit = draft.canonicalUnit;
    } else if (unitLabel !== null) {
      canonicalUnit = canonicalUnitFor(unitLabel);
    }

    const productId = cleanText(draft.productId, "product_id", 100);
    return {
      description,
      unitLabel,
      canonicalUnit,
      productId,
      quantityMilli,
      unitPriceMinor: unitPrice.minor,
      lineTotalMinor: invoiceLineTotal(unitPrice, quantityMilli).minor,
    };
  }

  addLine(invoiceId: string, draft: InvoiceLineDraft): InvoiceView {
    this.requireCashier();
    const instant = this.now();
    const lineId = this.newId();
    return this.deps.transact(() => {
      const invoice = this.requireDraft(invoiceId);
      if (this.deps.invoices.countLines(invoiceId) >= MAX_INVOICE_LINES) {
        throw new DomainError("INVALID_INPUT", `An invoice may hold at most ${MAX_INVOICE_LINES} lines`);
      }
      const input = this.parseLine(draft, invoice.currency);
      this.deps.invoices.addLine(lineId, invoiceId, this.deps.invoices.nextLineNo(invoiceId), input, instant);
      const updated = this.rewriteTotals(invoice, null, instant);
      return { invoice: updated, lines: this.deps.invoices.listLines(invoiceId) };
    });
  }

  updateLine(invoiceId: string, lineId: string, draft: InvoiceLineDraft): InvoiceView {
    this.requireCashier();
    const instant = this.now();
    return this.deps.transact(() => {
      const invoice = this.requireDraft(invoiceId);
      const line = this.deps.invoices.findLine(lineId);
      if (!line || line.invoice_id !== invoiceId) {
        throw new DomainError("INVALID_INPUT", "This line is not on this invoice");
      }
      this.deps.invoices.updateLine(lineId, this.parseLine(draft, invoice.currency));
      const updated = this.rewriteTotals(invoice, null, instant);
      return { invoice: updated, lines: this.deps.invoices.listLines(invoiceId) };
    });
  }

  removeLine(invoiceId: string, lineId: string): InvoiceView {
    this.requireCashier();
    const instant = this.now();
    return this.deps.transact(() => {
      const invoice = this.requireDraft(invoiceId);
      const line = this.deps.invoices.findLine(lineId);
      if (!line || line.invoice_id !== invoiceId) {
        throw new DomainError("INVALID_INPUT", "This line is not on this invoice");
      }
      this.deps.invoices.deleteLine(lineId);
      const updated = this.rewriteTotals(invoice, null, instant);
      return { invoice: updated, lines: this.deps.invoices.listLines(invoiceId) };
    });
  }

  /** Discards a draft. Impossible once final — the triggers refuse, and `requireDraft` says why. */
  discardDraft(invoiceId: string): void {
    this.requireCashier();
    this.deps.transact(() => {
      this.requireDraft(invoiceId);
      this.deps.invoices.deleteDraft(invoiceId);
    });
  }

  // ── Finalize ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Turns a draft into a commercial document, in ONE `BEGIN IMMEDIATE` transaction.
   *
   * Order matters, and it is this order on purpose:
   *
   *   reread -> still a draft? -> validate -> recompute money -> words -> ALLOCATE NUMBER ->
   *   snapshot issuer -> freeze -> classify against the current catalog -> commit
   *
   * 🔴 THE NUMBER IS ALLOCATED AFTER EVERY VALIDATION, so an invoice that is refused for a missing
   * description never consumes one. A throw anywhere rolls the whole transaction back: the number
   * is returned, no reconciliation row survives, and the invoice is still an editable draft. That
   * is asserted by a failure-injection test, not assumed from the word "transaction".
   */
  finalizeInvoice(invoiceId: string): InvoiceView {
    const cashier = this.requireCashier();
    const instant = this.now();

    return this.deps.transact((): InvoiceView => {
      // 1 · reread from the database; whatever the UI believed is irrelevant
      const invoice = this.requireDraft(invoiceId);
      const lines = this.deps.invoices.listLines(invoiceId);

      // 2 · the shop must have an identity to snapshot onto the document
      const profile = this.deps.company.find();
      if (!profile) {
        throw new DomainError(
          "COMPANY_PROFILE_REQUIRED",
          "Save the shop's own details before issuing an invoice",
        );
      }

      // 3 · validate
      if (lines.length === 0) {
        throw new DomainError("INVOICE_NOT_FINALIZABLE", "An invoice needs at least one line");
      }
      for (const line of lines) {
        assertLineFinalizable({
          description: line.description,
          unitLabel: line.unit_label,
          quantityMilli: Number(line.quantity_milli),
        });
      }

      // 4 · recompute EVERY line total from the persisted source values. The table's own CHECK
      //     already enforces the formula, so a mismatch should be impossible — which is exactly why
      //     it is checked here rather than trusted: a line written by some future path that bypassed
      //     the CHECK must not be printed on a document.
      const lineTotals = lines.map((line) => {
        const recomputed = invoiceLineTotal(
          money(line.unit_price_minor, invoice.currency),
          Number(line.quantity_milli),
        );
        if (recomputed.minor !== line.line_total_minor) {
          throw new DomainError(
            "LEDGER_INTEGRITY",
            `Line ${line.line_no} does not add up and this invoice cannot be issued`,
          );
        }
        return recomputed;
      });

      // 5 · totals, from the lines and THIS INVOICE'S OWN tax — not the shop's current switch.
      //     A draft that never set one falls back to the shop setting, which is how it behaved
      //     before per-invoice tax existed.
      const tax = this.invoiceTax(invoice);
      const totals = computeInvoiceTotals(
        lineTotals,
        invoice.currency,
        tax,
        money(invoice.paid_minor, invoice.currency),
      );

      // 6 · the words, frozen onto the document so a later build cannot reword a printed invoice
      const amountInWords = amountInWordsAr(totals.total);

      // 7 · the number — last of the validations to pass, first of the irreversible acts
      const invoiceNumber = this.deps.company.allocateInvoiceNumber(instant);

      // 8 · the issuer, SNAPSHOTTED. A foreign key would have let tomorrow's phone number appear on
      //     yesterday's invoice.
      const issuerSnapshotJson = JSON.stringify({
        name_ar: profile.name_ar,
        name_en: profile.name_en,
        legal_name: profile.legal_name,
        tagline: profile.tagline,
        address: profile.address,
        phone1: profile.phone1,
        phone2: profile.phone2,
        email: profile.email,
        logo_path: profile.logo_path,
        taxpayer_number: profile.taxpayer_number,
        commercial_register: profile.commercial_register,
        vat_number: profile.vat_number,
      });
      const taxSnapshotJson = JSON.stringify({
        enabled: tax.enabled,
        rate_basis_points: tax.rateBasisPoints,
        label: tax.label,
      });

      // 9 · freeze
      const finalizedAt = instant.toISOString();
      const finalized = this.deps.invoices.finalize(
        invoiceId,
        {
          invoiceNumber,
          invoiceDate: invoice.invoice_date ?? businessDateOf(instant, this.deps.terminal.timeZone),
          subtotalMinor: totals.subtotal.minor,
          taxMinor: totals.tax.minor,
          totalMinor: totals.total.minor,
          paidMinor: totals.paid.minor,
          balanceDueMinor: totals.balanceDue.minor,
          amountInWords,
          issuerSnapshotJson,
          taxSnapshotJson,
          finalizedAt,
        },
        instant,
      );

      // 10 · THE SALE. A finalized invoice is a real sale for business reporting (migration 7).
      this.createSaleForInvoice(finalized, lines, cashier, instant);

      // 11 · classify every line against the catalog AS IT IS NOW, and write the review queue
      this.createReconciliation(finalized, lines, cashier, instant);

      return { invoice: finalized, lines: this.deps.invoices.listLines(invoiceId) };
    });
  }

  // ── The sale a finalized invoice is ─────────────────────────────────────────────────────────────

  /**
   * Writes the sale that a finalized invoice IS, inside the SAME transaction that finalized it.
   *
   * 🔴 BUILT FROM THE PERSISTED FINALIZED ROW, not from the values computed a moment earlier. The
   * brief's own step order put sale creation before marking the invoice final; this does it after,
   * deliberately, and the reason is the one step 4 above already gives for recomputing line totals:
   * what the document actually STORED is the only thing worth copying. Reading the frozen row back
   * means invoice and sale cannot disagree even if some future path changed what `finalize` writes.
   * Atomicity is identical either way — both are inside the one transaction — so the ordering costs
   * nothing and buys a stronger guarantee.
   *
   * 🔴 NO PAYMENT METHOD IS INVENTED. A manual invoice captures no method in this patch, so
   * `payment_method` is NULL, which means NOT RECORDED. `payment_status` carries the truth that
   * matters — paid, partial or unpaid — and the history screen says so in words.
   */
  private createSaleForInvoice(
    invoice: InvoiceRow,
    lines: ReadonlyArray<InvoiceLineRow>,
    cashier: Cashier,
    instant: Date,
  ): void {
    const key = invoiceSaleIdempotencyKey(invoice.id);

    // Idempotency, checked twice over. Reaching either branch inside a finalize transaction should
    // be impossible — the invoice was a draft a few statements ago — but a retry that got further
    // than the UI realised must not produce a second sale, and `sales.invoice_id UNIQUE` would
    // raise a constraint error rather than tell us why.
    if (this.deps.sales.findByInvoiceId(invoice.id) || this.deps.sales.findByIdempotencyKey(key)) return;

    const currency = invoice.currency;
    const paid = money(invoice.paid_minor, currency);
    const balanceDue = money(invoice.balance_due_minor, currency);

    const saleLines: NewSaleLine[] = lines.map((line) => {
      // The SKU is snapshotted from the catalog AS IT IS NOW, exactly as a till sale snapshots it,
      // and only when the operator actually linked a product. An unlinked line keeps NULL — the
      // honest statement that the catalog has no such product yet, pending reconciliation.
      const product = line.product_id ? this.deps.catalogStore.findById(line.product_id) : undefined;
      return {
        id: this.newId(),
        lineNo: Number(line.line_no),
        invoiceLineId: line.id,
        productId: line.product_id,
        sku: product ? product.sku : null,
        // assertLineFinalizable has already refused an empty description, so this is never blank.
        productName: line.description ?? "",
        saleUnit: line.canonical_unit,
        // 🔴 THE PRINTED LABEL, VERBATIM. "كيس (50PCS)" stays "كيس (50PCS)" forever; a later
        // reconciliation choosing 'pack' for the CATALOG must never reach back into this row.
        unitLabel: line.unit_label,
        quantityMilli: Number(line.quantity_milli),
        unitPriceMinor: line.unit_price_minor,
        lineTotalMinor: line.line_total_minor,
      };
    });

    const header: NewSaleHeader = {
      id: this.newId(),
      idempotencyKey: key,
      // Deterministic, over the frozen document: the same invoice always hashes the same, so a
      // replay is recognised as the same request rather than a conflicting one.
      requestFingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            invoiceId: invoice.id,
            invoiceNumber: Number(invoice.invoice_number),
            totalMinor: invoice.total_minor.toString(),
            paidMinor: invoice.paid_minor.toString(),
            lines: saleLines.map((l) => [l.lineNo, l.quantityMilli, l.unitPriceMinor.toString()]),
          }),
        )
        .digest("hex"),
      sourceType: "invoice",
      invoiceId: invoice.id,
      cashierId: cashier.id,
      cashierName: cashier.name,
      currency,
      subtotalMinor: invoice.subtotal_minor,
      taxMinor: invoice.tax_minor,
      totalMinor: invoice.total_minor,
      paidMinor: invoice.paid_minor,
      balanceDueMinor: invoice.balance_due_minor,
      paymentStatus: paymentStatusFor(paid.minor, balanceDue.minor),
      paymentMethod: null,
      // 🔴 THE BUSINESS DAY THIS WAS RECORDED, not the date printed on the document. An invoice may
      // be back-dated; "Today's Sales" means what the shop recorded today, and changing that
      // definition would silently alter a report every POS sale already feeds. The document keeps
      // its own `invoice_date`, which is what the printed paper shows.
      businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
      completedAt: invoice.finalized_at ?? instant.toISOString(),
      createdAt: instant.toISOString(),
    };

    this.deps.sales.commitSale(header, saleLines);
  }

  /** The number printed on an invoice, for showing an invoice-origin sale's identity. Read-only. */
  invoiceNumberOf(invoiceId: string): number | undefined {
    const row = this.deps.invoices.findById(invoiceId);
    return row?.invoice_number === null || row?.invoice_number === undefined ? undefined : Number(row.invoice_number);
  }

  /** The sale a finalized invoice produced, if any. Read-only. */
  saleForInvoice(invoiceId: string): SaleRecord | undefined {
    return this.deps.sales.findByInvoiceId(invoiceId);
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────────────────────────

  /** The catalog as matching sees it — active AND inactive, so a dormant row is found, not duplicated. */
  private catalogCandidates(): CatalogCandidate[] {
    return this.deps.products.listProducts().map((p) => ({
      id: p.id,
      sku: p.sku,
      nameAr: p.name_ar,
      nameEn: p.name_en,
      sellingPriceMinor: p.selling_price_minor,
      baseUnit: p.base_unit,
      isActive: p.is_active === 1n,
    }));
  }

  private static snapshot(p: CatalogCandidate): Record<string, unknown> {
    return {
      id: p.id,
      sku: p.sku,
      name_ar: p.nameAr,
      name_en: p.nameEn,
      // A bigint cannot be JSON-serialized; the exact digits go as text, never as a float.
      selling_price_minor: p.sellingPriceMinor.toString(),
      base_unit: p.baseUnit,
      is_active: p.isActive,
    };
  }

  /**
   * One reconciliation row per line, written inside the finalize transaction.
   *
   * 🔴 A MATCHED line is recorded too, and it is recorded as RESOLVED. The classification column
   * holds the truth about the comparison (`MATCHED`); the status column holds the resolution
   * (`KEPT_CATALOG` — there was nothing to change, so the catalog stands). It is attributed to the
   * operator who finalized, because finalizing an invoice whose line agrees with the catalog IS
   * their decision, made at that moment. Leaving these rows out would have made the queue a partial
   * record and lost the catalog values that were actually compared.
   */
  private createReconciliation(
    invoice: InvoiceRow,
    lines: ReadonlyArray<InvoiceLineRow>,
    cashier: Cashier,
    instant: Date,
  ): void {
    const catalog = this.catalogCandidates();
    const stamp = instant.toISOString();

    for (const line of lines) {
      const observation: InvoiceLineObservation = {
        description: line.description ?? "",
        unitLabel: line.unit_label,
        unitPriceMinor: line.unit_price_minor,
        productId: line.product_id,
      };
      const result = classifyInvoiceLine(observation, catalog);
      const observed = result.match.product
        ? [result.match.product, ...result.match.candidates.filter((c) => c.id !== result.match.product!.id)]
        : [...result.match.candidates];
      const matched = result.classification === "MATCHED";

      this.deps.reconciliation.insert(
        this.newId(),
        {
          invoiceId: invoice.id,
          invoiceLineId: line.id,
          classification: result.classification,
          matchTier: result.match.tier,
          matchedProductId: result.match.product?.id ?? null,
          candidatesJson: observed.length > 0 ? JSON.stringify(observed.map(InvoiceService.snapshot)) : null,
          differencesJson: JSON.stringify(result.differences),
          status: matched ? "KEPT_CATALOG" : "PENDING",
          resolvedAt: matched ? stamp : null,
          resolutionActorId: matched ? cashier.id : null,
          resolutionActorName: matched ? cashier.name : null,
        },
        instant,
      );
    }
  }

  /** Opens a finalized invoice by the number printed on the paper. */
  findFinalizedByNumber(invoiceNumber: number): InvoiceView | null {
    this.requireCashier();
    const invoice = this.deps.invoices.findByNumber(invoiceNumber);
    if (!invoice || invoice.status !== "final") return null;
    return { invoice, lines: this.deps.invoices.listLines(invoice.id) };
  }

  /** The frozen invoice behind a review item — read, never recomputed from today's catalog. */
  invoiceRowFor(invoiceId: string): InvoiceRow | null {
    this.requireCashier();
    return this.deps.invoices.findById(invoiceId);
  }

  invoiceLineFor(lineId: string): InvoiceLineRow | null {
    this.requireCashier();
    return this.deps.invoices.findLine(lineId);
  }

  listReconciliationByFilter(
    filter: "unresolved" | "failed" | "resolved" | "all",
    limit: number,
  ): ReconciliationRow[] {
    this.requireCashier();
    switch (filter) {
      case "failed":
        return this.deps.reconciliation.listFailed(limit);
      case "resolved":
        return this.deps.reconciliation.listResolved(limit);
      case "all":
        return this.deps.reconciliation.listAll(limit);
      default:
        return this.deps.reconciliation.listUnresolved(limit);
    }
  }

  listReconciliation(invoiceId: string): ReconciliationRow[] {
    this.requireCashier();
    return this.deps.reconciliation.listForInvoice(invoiceId);
  }

  /** The work queue. Closing a screen never loses it — it is a table, not component state. */
  listUnresolvedReconciliation(limit?: number): ReconciliationRow[] {
    this.requireCashier();
    return this.deps.reconciliation.listUnresolved(limit);
  }

  reconciliationCounts(): { readonly unresolved: number; readonly byStatus: Record<string, number> } {
    this.requireCashier();
    return {
      unresolved: this.deps.reconciliation.countUnresolved(),
      byStatus: this.deps.reconciliation.countByStatus(),
    };
  }

  /** An item still needing a person. Anything already decided is refused rather than re-decided. */
  private requireUnresolved(reconciliationId: string): ReconciliationRow {
    const row = this.deps.reconciliation.findById(reconciliationId);
    if (!row) throw new DomainError("RECONCILIATION_NOT_FOUND", "This review item no longer exists");
    if (!isUnresolved(resolutionState(row.status))) {
      throw new DomainError(
        "RECONCILIATION_ALREADY_RESOLVED",
        `This review item was already settled as ${row.status}`,
      );
    }
    return row;
  }

  // ── Resolutions that change nothing ─────────────────────────────────────────────────────────────
  //
  // 🔴 "Keep" IS A REAL DECISION, not an ignore. It leaves the finalized invoice untouched, performs
  // ZERO catalog mutation, writes ZERO audit event — because nothing changed, and nothing is not an
  // event — and records who settled it and when, so the queue is a record of decisions rather than a
  // list of things people gave up on.

  /** The catalog is right and the invoice simply said something else that day. */
  keepCatalog(reconciliationId: string): ReconciliationRow {
    const cashier = this.requireCashier();
    const instant = this.now();
    return this.deps.transact(() => {
      const row = this.requireUnresolved(reconciliationId);
      return this.deps.reconciliation.resolve(
        row.id,
        {
          status: "KEPT_CATALOG",
          matchedProductId: row.matched_product_id,
          selectedFieldsJson: null,
          actorId: cashier.id,
          actorName: cashier.name,
        },
        instant,
      );
    });
  }

  /** This line belongs on the invoice and nowhere else — a one-off, not a catalog product. */
  keepInvoiceOnly(reconciliationId: string): ReconciliationRow {
    const cashier = this.requireCashier();
    const instant = this.now();
    return this.deps.transact(() => {
      const row = this.requireUnresolved(reconciliationId);
      return this.deps.reconciliation.resolve(
        row.id,
        {
          status: "KEPT_INVOICE_ONLY",
          matchedProductId: null,
          selectedFieldsJson: null,
          actorId: cashier.id,
          actorName: cashier.name,
        },
        instant,
      );
    });
  }

  /**
   * "That's this product." Records the link WITHOUT changing the catalog and without changing the
   * invoice — the finalized line keeps whatever `product_id` it had, because a commercial document
   * is not rewritten by a later opinion about it.
   */
  linkExistingProduct(reconciliationId: string, productId: string): ReconciliationRow {
    const cashier = this.requireCashier();
    const instant = this.now();
    return this.deps.transact(() => {
      const row = this.requireUnresolved(reconciliationId);
      const product = this.deps.catalogStore.findById(productId);
      if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "That product no longer exists");
      return this.deps.reconciliation.resolve(
        row.id,
        {
          status: "LINKED_PRODUCT",
          matchedProductId: product.id,
          selectedFieldsJson: null,
          actorId: cashier.id,
          actorName: cashier.name,
        },
        instant,
      );
    });
  }

  // ── Resolutions that change the catalog ─────────────────────────────────────────────────────────
  //
  // 🔴 TWO TRANSACTIONS, DELIBERATELY. The product mutation and its migration-5 audit row commit
  // together inside `PosService` — that atomicity is the whole point of migration 5 and is not
  // re-implemented here. Marking the review item resolved is a SECOND commit, afterwards, because
  // a status of UPDATED_CATALOG must never be readable for a product update that did not commit.
  // The cost of that order is a window where the catalog has changed and the item still reads
  // PENDING; `retry` closes it by looking at the product's CURRENT state instead of replaying.

  /**
   * Creates a product from what the line observed, through `PosService`.
   *
   * The PRICE comes from the invoice line, because for a product that does not exist yet the
   * invoice is the only information there is. That is the one place an invoice price becomes a
   * catalog price without a comparison — and it is a creation, not an overwrite.
   */
  createProductFromInvoice(reconciliationId: string, input: NewProductFromInvoice): ReconciliationRow {
    const cashier = this.requireCashier();
    const row = this.requireUnresolved(reconciliationId);
    const line = this.deps.invoices.findLine(row.invoice_line_id);
    if (!line) throw new DomainError("INVOICE_NOT_FOUND", "The invoice line behind this item is gone");

    // Already created on a previous attempt whose acknowledgement was lost? Then there is nothing
    // left to do but record it. No second product, no second audit event.
    if (row.matched_product_id && this.deps.catalogStore.findById(row.matched_product_id)) {
      return this.markCreated(row, row.matched_product_id, cashier);
    }

    const baseUnit =
      cleanText(input.baseUnit, "base_unit", MAX_SKU) ??
      (line.canonical_unit ?? (line.unit_label ? canonicalUnitFor(line.unit_label) : null));
    if (!baseUnit) {
      throw new DomainError(
        "RESOLUTION_INCOMPLETE",
        `'${line.unit_label ?? ""}' is not a unit this terminal knows — choose the catalog unit for it`,
      );
    }

    const draft: ProductDraft = {
      nameAr: requireText(input.nameAr ?? line.description, "name_ar", MAX_PRODUCT_NAME),
      // 🔴 Never inferred from the description. Absent stays absent.
      nameEn: cleanText(input.nameEn, "name_en", MAX_PRODUCT_NAME),
      sku: cleanText(input.sku, "sku", MAX_SKU),
      price: priceText(line.unit_price_minor, this.deps.terminal.currency),
      baseUnit,
    };

    this.deps.reconciliation.recordAttempt(row.id, this.now());
    let created: AdminProductRow;
    try {
      created = this.deps.products.createProduct(draft, {
        origin: RECONCILIATION_ORIGIN,
        invoiceId: row.invoice_id,
      });
    } catch (error) {
      this.recordFailure(row.id, error);
      throw error;
    }
    return this.markCreated(row, created.id, cashier);
  }

  private markCreated(row: ReconciliationRow, productId: string, cashier: Cashier): ReconciliationRow {
    const instant = this.now();
    return this.deps.transact(() =>
      this.deps.reconciliation.resolve(
        row.id,
        {
          status: "CREATED_PRODUCT",
          matchedProductId: productId,
          selectedFieldsJson: null,
          actorId: cashier.id,
          actorName: cashier.name,
        },
        instant,
      ),
    );
  }

  /**
   * Copies the EXPLICITLY SELECTED fields from the invoice line into the catalog product.
   *
   * 🔴 THE COMPLETE-DRAFT RULE. `PosService.updateProduct` takes a WHOLE product draft, not a patch.
   * So this reads the CURRENT product row, builds the complete draft from it, overlays only the
   * selected fields, and passes the product's CURRENT `isActive` straight through. Building a draft
   * from invoice data would silently blank every field the invoice does not mention — and passing a
   * guessed `isActive` would silently take a product off sale, or put a withdrawn one back on it.
   */
  updateCatalogFromInvoice(
    reconciliationId: string,
    selection: CatalogUpdateSelection,
  ): ReconciliationRow {
    const cashier = this.requireCashier();
    const row = this.requireUnresolved(reconciliationId);
    const fields = this.validateSelection(selection, row);

    const line = this.deps.invoices.findLine(row.invoice_line_id);
    if (!line) throw new DomainError("INVOICE_NOT_FOUND", "The invoice line behind this item is gone");
    if (!row.matched_product_id) {
      throw new DomainError(
        "RESOLUTION_INCOMPLETE",
        "Link this line to a product before updating the catalog from it",
      );
    }
    const current = this.deps.catalogStore.findById(row.matched_product_id);
    if (!current) throw new DomainError("PRODUCT_NOT_FOUND", "That product no longer exists");

    const target = this.targetState(fields, selection, line, current);

    // ── Idempotent retry, by reading the world rather than replaying the request ────────────────
    //
    // If the product already holds every selected value — and, when the price was selected, the
    // review flag is already cleared — then the mutation committed on an earlier attempt whose
    // acknowledgement was lost. Calling `updateProduct` now would write the same values again;
    // the diff would be empty, so no audit row would be written anyway, but the write itself is
    // meaningless work on a commercial record. Skip it and settle the item.
    if (this.alreadyApplied(fields, target, current)) {
      return this.markUpdated(row, fields, cashier);
    }

    const draft: ProductDraft = {
      nameAr: target.nameAr,
      nameEn: target.nameEn,
      sku: current.sku,
      price: target.price,
      baseUnit: target.baseUnit,
    };

    this.deps.reconciliation.recordAttempt(row.id, this.now());
    try {
      this.deps.products.updateProduct(
        current.id,
        draft,
        // 🔴 CURRENT active state, passed through untouched. Reconciliation has no opinion on it.
        current.is_active === 1n,
        {
          origin: RECONCILIATION_ORIGIN,
          invoiceId: row.invoice_id,
          // 🔴 Cleared ONLY when the operator explicitly accepted the invoice price. Keeping the
          // catalog price, a failed update, or a name/unit-only change all leave it untouched.
          priceNeedsReview: fields.includes("selling_price_minor") ? false : undefined,
        },
      );
    } catch (error) {
      this.recordFailure(row.id, error);
      throw error;
    }
    return this.markUpdated(row, fields, cashier);
  }

  private validateSelection(
    selection: CatalogUpdateSelection,
    row: ReconciliationRow,
  ): DifferenceField[] {
    const allowed: ReadonlyArray<DifferenceField> = ["selling_price_minor", "base_unit", "name_ar", "name_en"];
    if (!Array.isArray(selection.fields) || selection.fields.length === 0) {
      throw new DomainError("RESOLUTION_INCOMPLETE", "Choose at least one field to update");
    }
    const fields: DifferenceField[] = [];
    for (const field of selection.fields) {
      if (!allowed.includes(field)) {
        throw new DomainError("INVALID_INPUT", `'${field}' is not a field reconciliation can update`);
      }
      if (!fields.includes(field)) fields.push(field);
    }
    if (fields.includes("name_en") && cleanText(selection.nameEn, "name_en", MAX_PRODUCT_NAME) === null) {
      // 🔴 An English name is never translated from an Arabic invoice description. If the operator
      // wants one, they type it.
      throw new DomainError(
        "RESOLUTION_INCOMPLETE",
        "Type the English name — it is never guessed from the invoice description",
      );
    }
    void row;
    return fields;
  }

  /** The values the product would hold afterwards. Unselected fields keep the CURRENT value. */
  private targetState(
    fields: ReadonlyArray<DifferenceField>,
    selection: CatalogUpdateSelection,
    line: InvoiceLineRow,
    current: AdminProductRow,
  ): { nameAr: string; nameEn: string | null; price: string; baseUnit: string; priceMinor: bigint } {
    let baseUnit = current.base_unit;
    if (fields.includes("base_unit")) {
      const chosen = cleanText(selection.canonicalUnit, "canonical_unit", MAX_SKU);
      const mapped = line.canonical_unit ?? (line.unit_label ? canonicalUnitFor(line.unit_label) : null);
      const next = chosen ?? mapped;
      if (!next) {
        // 🔴 This is the `comparable: false` case, and it is NOT "the units differ". The invoice's
        // label maps to nothing this build understands, so the operator is asked which catalog unit
        // it means — never told the catalog is wrong.
        throw new DomainError(
          "RESOLUTION_INCOMPLETE",
          `'${line.unit_label ?? ""}' does not map to a catalog unit — choose which unit it means`,
        );
      }
      if (!isCanonicalUnit(next)) {
        throw new DomainError("UNSUPPORTED_UNIT", `'${next}' is not a unit this terminal uses`);
      }
      baseUnit = next;
    }

    const priceMinor = fields.includes("selling_price_minor") ? line.unit_price_minor : current.selling_price_minor;
    return {
      nameAr: fields.includes("name_ar")
        ? requireText(line.description, "name_ar", MAX_PRODUCT_NAME)
        : current.name_ar,
      nameEn: fields.includes("name_en")
        ? cleanText(selection.nameEn, "name_en", MAX_PRODUCT_NAME)
        : current.name_en,
      price: priceText(priceMinor, current.currency),
      baseUnit,
      priceMinor,
    };
  }

  private alreadyApplied(
    fields: ReadonlyArray<DifferenceField>,
    target: { nameAr: string; nameEn: string | null; baseUnit: string; priceMinor: bigint },
    current: AdminProductRow,
  ): boolean {
    if (target.nameAr !== current.name_ar) return false;
    if (target.nameEn !== current.name_en) return false;
    if (target.baseUnit !== current.base_unit) return false;
    if (target.priceMinor !== current.selling_price_minor) return false;
    // The review flag is part of the requested state, not a side effect: an accepted price with the
    // flag still set is unfinished work, even though every other value already matches.
    if (fields.includes("selling_price_minor") && current.price_needs_review !== 0n) return false;
    return true;
  }

  private markUpdated(
    row: ReconciliationRow,
    fields: ReadonlyArray<DifferenceField>,
    cashier: Cashier,
  ): ReconciliationRow {
    const instant = this.now();
    return this.deps.transact(() =>
      this.deps.reconciliation.resolve(
        row.id,
        {
          status: "UPDATED_CATALOG",
          matchedProductId: row.matched_product_id,
          selectedFieldsJson: JSON.stringify([...fields]),
          actorId: cashier.id,
          actorName: cashier.name,
        },
        instant,
      ),
    );
  }

  /**
   * Records WHY an attempt failed, in its own transaction, and keeps the item in the queue.
   *
   * The failure itself is then rethrown: the operator must see it. The finalized invoice is
   * untouched by construction — nothing in this path writes to it.
   */
  private recordFailure(reconciliationId: string, error: unknown): void {
    const code = error instanceof DomainError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    const instant = this.now();
    try {
      this.deps.transact(() => this.deps.reconciliation.fail(reconciliationId, code, message, instant));
    } catch {
      // Recording the failure must not replace the real error with a second one. The item stays
      // PENDING in that case, which still leaves it in the queue — the one thing that must not
      // happen is losing it.
    }
  }

  /** Differences as stored, decoded for the review screen. */
  decodeDifferences(row: ReconciliationRow): Difference[] {
    return JSON.parse(row.differences_json) as Difference[];
  }
}
