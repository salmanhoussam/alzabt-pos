/**
 * The local catalog (migration 3). Master data, not ledger: an import upserts rows by
 * (source, source_key) and deactivates rows of the same source that the new file no longer
 * contains. Nothing is ever deleted, and no sale references these rows (sale lines carry their own
 * snapshot), so an import can never change a past sale.
 */
import { formatDecimal, money } from "../domain/money";
import { type CatalogSource, displayName } from "../domain/catalog";
import type { ExportRow, ImportRow } from "../domain/catalogImport";
import type { AuditScalar } from "../domain/audit";
import type { Db } from "./db";

/** The only import source in the field pilot: a merchant CSV in the strict import format. */
export const CSV_SOURCE = "merchant-csv";

/**
 * Products the operator typed on the till. A SEPARATE source from the CSV on purpose:
 * `UNIQUE (source, source_key)` then keeps the two origins from ever colliding, a re-import can
 * never deactivate a hand-made product (`applyImport` only touches rows of its own source), and
 * `source` stays an honest record of where a product came from.
 */
export const MANUAL_SOURCE = "manual";

/**
 * The audited fields of a product, normalised for the audit trail: booleans as booleans, money as
 * bigint, everything else as it is stored. ONE projection, used for a manual edit and for an import
 * alike, so the two can never disagree about what a change looks like.
 */
export type AuditedProductState = Readonly<Record<string, AuditScalar>>;

export function auditedProductState(row: {
  readonly sku: string | null;
  readonly name_ar: string;
  readonly name_en: string | null;
  readonly selling_price_minor: bigint;
  readonly currency: string;
  readonly base_unit: string;
  readonly price_needs_review: bigint;
  readonly is_active: bigint;
}): AuditedProductState {
  return {
    base_unit: row.base_unit,
    currency: row.currency,
    is_active: row.is_active === 1n,
    name_ar: row.name_ar,
    name_en: row.name_en,
    price_needs_review: row.price_needs_review === 1n,
    selling_price_minor: row.selling_price_minor,
    sku: row.sku,
  };
}

/**
 * Exactly what an import did to ONE product. Returned by `applyImport` so the caller can write the
 * durable audit INSIDE the same transaction.
 *
 * 🔴 Why the repository returns this instead of taking an audit callback: a callback would put
 * arbitrary caller code inside the repository's transaction, where a throw means a half-written
 * import, and it would make the repository's behaviour depend on what it was handed. A bounded,
 * typed change-set keeps the transaction boundary legible and the repository ignorant of auditing.
 */
export interface ProductChange {
  readonly id: string;
  readonly kind: "inserted" | "updated" | "deactivated";
  /** null for an insertion — there was no previous state. */
  readonly before: AuditedProductState | null;
  readonly after: AuditedProductState;
}

export interface ImportOutcome {
  readonly counts: ImportCounts;
  /** One entry per product the import actually touched. Unchanged products are absent. */
  readonly changes: ReadonlyArray<ProductChange>;
}

export interface ImportCounts {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deactivated: number;
}

export interface ImportMeta {
  readonly importId: string;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly cashierId: string;
  readonly now: Date;
}

interface ProductRow {
  id: string;
  sku: string | null;
  name_ar: string;
  name_en: string | null;
  selling_price_minor: bigint;
  currency: string;
  base_unit: string;
  price_needs_review: bigint;
  is_active: bigint;
}

export function productIdFor(source: string, sourceKey: string): string {
  return `${source}:${sourceKey}`;
}

/** A product row as the administration screen needs it: every column, active or not. */
export interface AdminProductRow {
  readonly id: string;
  readonly source: string;
  readonly source_key: string;
  readonly sku: string | null;
  readonly name_ar: string;
  readonly name_en: string | null;
  readonly selling_price_minor: bigint;
  readonly currency: string;
  readonly base_unit: string;
  readonly price_needs_review: bigint;
  readonly is_active: bigint;
  readonly created_at: string;
  readonly updated_at: string;
  // ── Migration 9, Product Master ───────────────────────────────────────────────────────────────
  //
  // 🔴 EVERY ONE OF THESE IS OPTIONAL FOR SELLING. A product with no category, no barcode, no
  // brand, no description and `is_online_visible = 0` is a complete, sellable product; these
  // describe it for the website, and local trade must never wait on them.
  //
  // And there is NO `bytes` field, nor any image column. The product's photo lives in
  // `catalog_product_images` and is read through `ProductImageRepository`, because `listAll()`
  // renders every product and a blob here would load every photo with it.
  readonly category_id: string | null;
  /** Canonical form only — `src/domain/barcode.ts` decides what canonical means. */
  readonly barcode: string | null;
  readonly brand: string | null;
  readonly description_ar: string | null;
  readonly description_en: string | null;
  readonly is_online_visible: bigint;
}

/** A validated new product, ready to store. Prices are already exact minor units. */
export interface NewProduct {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string | null;
  readonly priceMinor: bigint;
  readonly currency: string;
  /**
   * Migration 9, optional at creation.
   *
   * Absent is the ordinary case and is what invoice reconciliation passes: a product created from
   * an invoice line knows a name, a unit and a price, and inventing a category or a brand for it
   * would be putting words in the merchant's mouth. The Product Master form passes what the owner
   * actually typed.
   */
  readonly master?: ProductMasterEdit;
  readonly baseUnit: string;
}

/** The editable fields of an existing product. Identity (source, source_key) is not among them. */
/**
 * The Product Master fields, as one optional group.
 *
 * 🔴 ABSENT MEANS "LEAVE IT EXACTLY AS IT IS", never "clear it", and that distinction is the whole
 * reason this is a separate interface rather than six more fields on `ProductEdit`. Three callers
 * write products and only one of them knows about enrichment:
 *
 *   the import path          names none of these — an imported row must not lose its category
 *   invoice reconciliation   names none of these — it knows a name, a unit and a price
 *   the Product Master form  names all of them
 *
 * If absence meant "clear", a re-import or a reconciliation would silently erase the descriptions
 * and the photo link the owner had typed. This is migration 4's `priceNeedsReview` lesson applied
 * to six fields at once: the one caller that means to change a field says so.
 *
 * `null` is a real value here and DOES clear — "remove this product's category" is a thing an
 * owner does. Absent and null are different, deliberately.
 */
export interface ProductMasterEdit {
  readonly categoryId?: string | null;
  /** Canonical form only. The service normalizes; this interface carries the result. */
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly descriptionAr?: string | null;
  readonly descriptionEn?: string | null;
  readonly isOnlineVisible?: boolean;
}

export interface ProductEdit {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string | null;
  readonly priceMinor: bigint;
  readonly baseUnit: string;
  readonly isActive: boolean;
  /**
   * Explicitly sets `price_needs_review`. ABSENT means "leave it exactly as it is", which is what
   * every caller before step 4 meant by never mentioning the column at all — so the default
   * behaviour is byte-identical to before this field existed.
   *
   * 🔴 Why this is explicit rather than inferred: the flag marks a price the shop has not yet
   * confirmed. Writing a new price does not by itself confirm it — an import writes prices too. It
   * is cleared only when a person deliberately accepts a price as correct, and the one caller that
   * does so says so here.
   */
  readonly priceNeedsReview?: boolean;
  /** Migration 9. Absent fields are carried forward unchanged — see `ProductMasterEdit`. */
  readonly master?: ProductMasterEdit;
}

/**
 * The admin column list, named once.
 *
 * 🔴 IT WAS WRITTEN OUT THREE TIMES BEFORE MIGRATION 9, in `listAll`, `findById` and `findBySku`.
 * Six new columns would have meant three places to add them and three chances to miss one — and a
 * read that silently omits `barcode` returns a row whose barcode is `undefined`, which is neither
 * null nor a value and would have been noticed by nothing. One constant, four reads.
 *
 * It names every column explicitly rather than using `*`, deliberately: `SELECT *` here would
 * start returning any column a future migration adds, including one holding bytes.
 */
const ADMIN_COLUMNS = `id, source, source_key, sku, name_ar, name_en, selling_price_minor,
                       currency, base_unit, price_needs_review, is_active, created_at, updated_at,
                       category_id, barcode, brand, description_ar, description_en,
                       is_online_visible`;

/**
 * Absent means unchanged; `null` means clear.
 *
 * Written as a named function rather than inline `??`, because `??` would be WRONG here: it treats
 * `null` as absent, and clearing a category is a real thing an owner does. The distinction between
 * "do not touch this" and "remove this" is the one that would have been lost.
 */
function keep<T>(incoming: T | null | undefined, current: T | null): T | null {
  return incoming === undefined ? current : incoming;
}

export class CatalogRepository {
  constructor(private readonly db: Db) {}

  /**
   * The active local catalog in `currency`, ordered as imported (by source row id when numeric),
   * or null when the terminal has no active local products yet.
   */
  loadActiveSource(currency: string): CatalogSource | null {
    const rows = this.db
      .prepare(
        `SELECT id, sku, name_ar, name_en, selling_price_minor, currency, base_unit, price_needs_review, is_active
           FROM catalog_products
          WHERE is_active = 1 AND currency = ?
          ORDER BY CAST(source_key AS INTEGER), source_key`,
      )
      .all(currency) as ProductRow[];
    if (rows.length === 0) return null;
    return {
      currency,
      products: rows.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: displayName(r.name_ar, r.name_en),
        price: formatDecimal(money(r.selling_price_minor, r.currency)),
        baseUnit: r.base_unit,
        priceNeedsReview: r.price_needs_review === 1n,
      })),
    };
  }

  /**
   * The active rows of one import source, in import order, as exact export rows (prices formatted
   * from integer minor units — no floating point anywhere). Inactive rows are not exported; a
   * re-import of the exported file therefore leaves them inactive.
   */
  listForExport(source: string): ExportRow[] {
    const rows = this.db
      .prepare(
        `SELECT source_key, name_ar, name_en, selling_price_minor, currency, base_unit, price_needs_review
           FROM catalog_products
          WHERE source = ? AND is_active = 1
          ORDER BY CAST(source_key AS INTEGER), source_key`,
      )
      .all(source) as Array<{
      source_key: string;
      name_ar: string;
      name_en: string | null;
      selling_price_minor: bigint;
      currency: string;
      base_unit: string;
      price_needs_review: bigint;
    }>;
    return rows.map((r) => ({
      sourceId: r.source_key,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      price: formatDecimal(money(r.selling_price_minor, r.currency)),
      currency: r.currency,
      baseUnit: r.base_unit,
      priceNeedsReview: r.price_needs_review === 1n,
    }));
  }

  /**
   * Applies a fully validated import in ONE transaction: all rows land, or none do — and returns
   * both the summary counts AND the exact per-product change-set, so the caller can append the
   * durable audit events inside this same transaction.
   *
   * Called from inside the service's outer transaction, where this inner one becomes a SAVEPOINT;
   * called directly (older callers, tests) it is still a complete transaction of its own.
   */
  applyImport(source: string, rows: ReadonlyArray<ImportRow>, meta: ImportMeta): ImportOutcome {
    return this.db
      .transaction((): ImportOutcome => {
        const now = meta.now.toISOString();
        const find = this.db.prepare(
          `SELECT id, sku, name_ar, name_en, selling_price_minor, currency, base_unit, price_needs_review, is_active
             FROM catalog_products WHERE source = ? AND source_key = ?`,
        );
        const insert = this.db.prepare(
          `INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en, selling_price_minor, currency,
                                         base_unit, price_needs_review, is_active, created_at, updated_at)
           VALUES (@id, @source, @sourceKey, NULL, @nameAr, @nameEn, @price, @currency, @baseUnit, @review, 1, @now, @now)`,
        );
        const update = this.db.prepare(
          `UPDATE catalog_products
              SET name_ar = @nameAr, name_en = @nameEn, selling_price_minor = @price, currency = @currency,
                  base_unit = @baseUnit, price_needs_review = @review, is_active = 1, updated_at = @now
            WHERE source = @source AND source_key = @sourceKey`,
        );
        let inserted = 0;
        let updated = 0;
        let unchanged = 0;
        const changes: ProductChange[] = [];
        for (const r of rows) {
          const params = {
            id: productIdFor(source, r.sourceId),
            source,
            sourceKey: r.sourceId,
            nameAr: r.nameAr,
            nameEn: r.nameEn,
            price: r.priceMinor,
            currency: r.currency,
            baseUnit: r.baseUnit,
            review: r.priceNeedsReview ? 1 : 0,
            now,
          };
          const existing = find.get(source, r.sourceId) as ProductRow | undefined;
          // The state this row will hold after the import. An import never writes `sku`, so an
          // existing row keeps the SKU it already has; a new row is inserted with NULL.
          const after = auditedProductState({
            sku: existing?.sku ?? null,
            name_ar: r.nameAr,
            name_en: r.nameEn,
            selling_price_minor: r.priceMinor,
            currency: r.currency,
            base_unit: r.baseUnit,
            price_needs_review: r.priceNeedsReview ? 1n : 0n,
            is_active: 1n,
          });
          if (!existing) {
            insert.run(params);
            inserted += 1;
            changes.push({ id: params.id, kind: "inserted", before: null, after });
          } else if (
            existing.name_ar === r.nameAr &&
            existing.name_en === r.nameEn &&
            existing.selling_price_minor === r.priceMinor &&
            existing.currency === r.currency &&
            existing.base_unit === r.baseUnit &&
            existing.price_needs_review === (r.priceNeedsReview ? 1n : 0n) &&
            existing.is_active === 1n
          ) {
            unchanged += 1;
          } else {
            update.run(params);
            updated += 1;
            changes.push({
              id: params.id,
              kind: "updated",
              before: auditedProductState(existing),
              after,
            });
          }
        }

        // Rows of this source that the new file no longer lists stop being sellable (never deleted).
        const keep = new Set(rows.map((r) => r.sourceId));
        const active = this.db
          .prepare("SELECT source_key FROM catalog_products WHERE source = ? AND is_active = 1")
          .all(source) as Array<{ source_key: string }>;
        const deactivate = this.db.prepare(
          "UPDATE catalog_products SET is_active = 0, updated_at = ? WHERE source = ? AND source_key = ?",
        );
        let deactivated = 0;
        for (const row of active) {
          if (!keep.has(row.source_key)) {
            deactivate.run(now, source, row.source_key);
            deactivated += 1;
            // Only `is_active` moves, so only `is_active` is recorded. The counts say "7
            // deactivated"; these rows say WHICH seven, which the counts cannot.
            changes.push({
              id: productIdFor(source, row.source_key),
              kind: "deactivated",
              before: { is_active: true },
              after: { is_active: false },
            });
          }
        }

        const counts: ImportCounts = { inserted, updated, unchanged, deactivated };
        this.db
          .prepare(
            `INSERT INTO catalog_imports (id, source, file_name, file_sha256, row_count, inserted, updated, unchanged,
                                          deactivated, cashier_id, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(meta.importId, source, meta.fileName, meta.fileSha256, rows.length, inserted, updated, unchanged,
            deactivated, meta.cashierId, now);
        return { counts, changes };
      })
      .immediate();
  }

  // ── Product administration (offline product management) ─────────────────────────────────────────
  //
  // Master data, written in place — NOT ledger. Nothing here can reach a past sale: `sale_lines`
  // snapshots its own product name, SKU and unit price at checkout and no sale row references
  // `catalog_products`, so an edit today is invisible to yesterday's invoice. That is a property of
  // the Gate 1 schema, not a promise made here, and `tests/persistence/productAdmin.test.ts`
  // asserts it against real committed sales.

  /** Every local product, active and inactive, newest source first then by key. For the admin list. */
  listAll(): AdminProductRow[] {
    return this.db
      .prepare(
        `SELECT ${ADMIN_COLUMNS}
           FROM catalog_products
          ORDER BY source, CAST(source_key AS INTEGER), source_key`,
      )
      .all() as AdminProductRow[];
  }

  findById(id: string): AdminProductRow | null {
    const row = this.db
      .prepare(`SELECT ${ADMIN_COLUMNS} FROM catalog_products WHERE id = ?`)
      .get(id) as AdminProductRow | undefined;
    return row ?? null;
  }

  /** The SKU is unique across the whole table when present (migration 3's partial unique index). */
  findBySku(sku: string): AdminProductRow | null {
    const row = this.db
      .prepare(`SELECT ${ADMIN_COLUMNS} FROM catalog_products WHERE sku = ?`)
      .get(sku) as AdminProductRow | undefined;
    return row ?? null;
  }

  /**
   * Finds a product by barcode. Migration 9's partial unique index makes the answer at most one.
   *
   * 🔴 THE CALLER MUST PASS THE CANONICAL FORM, and that is not a convenience — it is the whole
   * contract. A 12-digit UPC-A typed off a box and the 13-digit EAN-13 a decoder returns for the
   * same symbol are different strings, so a raw lookup finds nothing and the shop creates a second
   * product for one item. `normalizeBarcode` in `src/domain/barcode.ts` is the only thing that
   * decides canonical; this method does not normalize, so that there is exactly one place that
   * does and this file stays statements.
   */
  findByBarcode(canonicalBarcode: string): AdminProductRow | null {
    const row = this.db
      .prepare(`SELECT ${ADMIN_COLUMNS} FROM catalog_products WHERE barcode = ?`)
      .get(canonicalBarcode) as AdminProductRow | undefined;
    return row ?? null;
  }

  /**
   * The next manual key, zero-padded so that `CAST(source_key AS INTEGER)` and a plain string sort
   * agree — the existing catalog queries order by both, and a key of "10" must not sort before "9".
   */
  private nextManualKey(): string {
    const row = this.db
      .prepare(
        `SELECT max(CAST(source_key AS INTEGER)) AS n FROM catalog_products WHERE source = ?`,
      )
      .get(MANUAL_SOURCE) as { n: bigint | null };
    return String(Number(row.n ?? 0n) + 1).padStart(6, "0");
  }

  /**
   * Inserts one operator-created product and returns the row as stored. One transaction, so the key
   * it picked and the row it wrote cannot be separated by a crash.
   */
  createManual(input: NewProduct, now: Date): AdminProductRow {
    return this.db
      .transaction((): AdminProductRow => {
        const sourceKey = this.nextManualKey();
        const id = productIdFor(MANUAL_SOURCE, sourceKey);
        const stamp = now.toISOString();
        this.db
          .prepare(
            `INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en, selling_price_minor,
                                           currency, base_unit, price_needs_review, is_active, created_at, updated_at,
                                           category_id, barcode, brand, description_ar, description_en,
                                           is_online_visible)
             VALUES (@id, @source, @sourceKey, @sku, @nameAr, @nameEn, @price, @currency, @baseUnit, 0, 1, @now, @now,
                     @categoryId, @barcode, @brand, @descriptionAr, @descriptionEn, @isOnlineVisible)`,
          )
          .run({
            id,
            source: MANUAL_SOURCE,
            sourceKey,
            sku: input.sku,
            nameAr: input.nameAr,
            nameEn: input.nameEn,
            price: input.priceMinor,
            currency: input.currency,
            baseUnit: input.baseUnit,
            now: stamp,
            // 🔴 `?? null` and `?? 0`, NOT the column defaults, because a named parameter that is
            // `undefined` is an error in better-sqlite3 rather than a skipped column. An absent
            // enrichment group therefore produces exactly the empty product the schema's own
            // defaults would have — and `is_online_visible` starts 0, so nothing is published by
            // being created.
            categoryId: input.master?.categoryId ?? null,
            barcode: input.master?.barcode ?? null,
            brand: input.master?.brand ?? null,
            descriptionAr: input.master?.descriptionAr ?? null,
            descriptionEn: input.master?.descriptionEn ?? null,
            isOnlineVisible: input.master?.isOnlineVisible ? 1 : 0,
          });
        const row = this.findById(id);
        if (!row) throw new Error("catalog: created product could not be read back");
        return row;
      })
      .immediate();
  }

  /**
   * Updates an existing product's editable fields. `source` and `source_key` are NEVER changed —
   * they are the product's identity, and a later re-import matches on them.
   */
  updateProduct(id: string, input: ProductEdit, now: Date): AdminProductRow {
    return this.db
      .transaction((): AdminProductRow => {
        const before = this.findById(id);
        if (!before) throw new Error(`catalog: no product '${id}'`);
        this.db
          .prepare(
            `UPDATE catalog_products
                SET sku = @sku, name_ar = @nameAr, name_en = @nameEn, selling_price_minor = @price,
                    base_unit = @baseUnit, is_active = @active, price_needs_review = @needsReview,
                    updated_at = @now,
                    category_id = @categoryId, barcode = @barcode, brand = @brand,
                    description_ar = @descriptionAr, description_en = @descriptionEn,
                    is_online_visible = @isOnlineVisible
              WHERE id = @id`,
          )
          .run({
            id,
            sku: input.sku,
            nameAr: input.nameAr,
            nameEn: input.nameEn,
            price: input.priceMinor,
            baseUnit: input.baseUnit,
            active: input.isActive ? 1 : 0,
            // Undefined carries the current value forward, so this statement cannot silently
            // clear a review flag that nobody asked it to clear.
            needsReview:
              input.priceNeedsReview === undefined
                ? Number(before.price_needs_review)
                : input.priceNeedsReview
                  ? 1
                  : 0,
            now: now.toISOString(),
            // 🔴 ABSENT CARRIES THE CURRENT VALUE FORWARD, exactly as `needsReview` above does.
            // `keep` is written out per field rather than spread, so that adding a Product Master
            // column later cannot silently inherit "clear me" by being forgotten here.
            categoryId: keep(input.master?.categoryId, before.category_id),
            barcode: keep(input.master?.barcode, before.barcode),
            brand: keep(input.master?.brand, before.brand),
            descriptionAr: keep(input.master?.descriptionAr, before.description_ar),
            descriptionEn: keep(input.master?.descriptionEn, before.description_en),
            isOnlineVisible:
              input.master?.isOnlineVisible === undefined
                ? Number(before.is_online_visible)
                : input.master.isOnlineVisible
                  ? 1
                  : 0,
          });
        const row = this.findById(id);
        if (!row) throw new Error("catalog: updated product could not be read back");
        return row;
      })
      .immediate();
  }

  /**
   * Deactivate or reactivate. There is deliberately no delete: a sold product stays on record.
   *
   * 🔴 NO TRANSACTION HERE, ON PURPOSE. Until Migration 5 this method had none by accident — a bare
   * read, UPDATE, read — which was the one mutation path in the application that was not atomic.
   * It is not given an inner transaction of its own now, because that would be the wrong fix: the
   * whole operation (this write plus its durable audit row) runs under the service-owned outer
   * transaction in `PosService.setProductActive`. A second, narrower transaction here would only
   * add a savepoint that proves nothing.
   */
  setActive(id: string, active: boolean, now: Date): AdminProductRow {
    const before = this.findById(id);
    if (!before) throw new Error(`catalog: no product '${id}'`);
    this.db
      .prepare("UPDATE catalog_products SET is_active = ?, updated_at = ? WHERE id = ?")
      .run(active ? 1 : 0, now.toISOString(), id);
    const row = this.findById(id);
    if (!row) throw new Error("catalog: product could not be read back");
    return row;
  }
}
