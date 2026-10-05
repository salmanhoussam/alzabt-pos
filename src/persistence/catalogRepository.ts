/**
 * The local catalog (migration 3). Master data, not ledger: an import upserts rows by
 * (source, source_key) and deactivates rows of the same source that the new file no longer
 * contains. Nothing is ever deleted, and no sale references these rows (sale lines carry their own
 * snapshot), so an import can never change a past sale.
 */
import { formatDecimal, money } from "../domain/money";
import { type CatalogSource, displayName } from "../domain/catalog";
import type { ImportRow } from "../domain/catalogImport";
import type { Db } from "./db";

/** The only import source in the field pilot: a merchant CSV in the strict import format. */
export const CSV_SOURCE = "merchant-csv";

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

  /** Applies a fully validated import in ONE transaction: all rows land, or none do. */
  applyImport(source: string, rows: ReadonlyArray<ImportRow>, meta: ImportMeta): ImportCounts {
    return this.db
      .transaction((): ImportCounts => {
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
          if (!existing) {
            insert.run(params);
            inserted += 1;
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
        for (const { source_key } of active) {
          if (!keep.has(source_key)) {
            deactivate.run(now, source, source_key);
            deactivated += 1;
          }
        }

        const counts = { inserted, updated, unchanged, deactivated };
        this.db
          .prepare(
            `INSERT INTO catalog_imports (id, source, file_name, file_sha256, row_count, inserted, updated, unchanged,
                                          deactivated, cashier_id, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(meta.importId, source, meta.fileName, meta.fileSha256, rows.length, inserted, updated, unchanged,
            deactivated, meta.cashierId, now);
        return counts;
      })
      .immediate();
  }
}
