/**
 * The `catalog_categories` table. Prepared statements, no business rules.
 *
 * FLAT by decision, not by omission: there is no `parent_id`, because a category tree is not an
 * approved feature and a hardware shop's list ("عدد", "دهان", "سباكة") is one level deep in
 * practice. Adding a parent later is an additive column on a table nothing else references.
 *
 * 🔴 WHAT THIS FILE REFUSES TO DO. It does not decide whether a category may be deleted — that
 * needs a count of referencing products inside the caller's transaction, and the decision is a
 * business rule. It exposes the count and the delete separately, so the service can take both in
 * one transaction and this file stays a set of statements.
 */
import type { Db } from "./db";

export interface CategoryRow {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string | null;
  readonly is_active: number;
  readonly sort_order: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS = `id, name_ar, name_en, is_active, sort_order, created_at, updated_at`;

function normalise(row: Record<string, unknown> | undefined): CategoryRow | null {
  if (!row) return null;
  return {
    id: row.id as string,
    name_ar: row.name_ar as string,
    name_en: (row.name_en as string | null) ?? null,
    is_active: Number(row.is_active),
    sort_order: Number(row.sort_order),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export class CategoryRepository {
  constructor(private readonly db: Db) {}

  /**
   * Every category, active first, then in the owner's own order.
   *
   * Ordered by `sort_order` rather than alphabetically on purpose: a hardware shop thinks "عدد"
   * before "دهان", and an Arabic alphabetical sort is not the order anyone reaches for.
   */
  listAll(): CategoryRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM catalog_categories ORDER BY is_active DESC, sort_order, id`)
        .all() as Array<Record<string, unknown>>
    ).map((r) => normalise(r)!);
  }

  /** Only the categories an operator may still choose. The products screen's dropdown. */
  listActive(): CategoryRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM catalog_categories WHERE is_active = 1 ORDER BY sort_order, id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => normalise(r)!);
  }

  findById(id: string): CategoryRow | null {
    return normalise(
      this.db.prepare(`SELECT ${COLUMNS} FROM catalog_categories WHERE id = ?`).get(id) as
        | Record<string, unknown>
        | undefined,
    );
  }

  /**
   * Finds a category by name the way the UNIQUE INDEX compares them.
   *
   * 🔴 `lower(trim(?))` MIRRORS THE INDEX EXACTLY. If this predicate and
   * `catalog_categories_name_ar` ever disagree, the service would report "that name is free" and
   * then the insert would fail — so the duplicate check must ask the same question the constraint
   * will.
   */
  findByNameAr(nameAr: string): CategoryRow | null {
    return normalise(
      this.db
        .prepare(`SELECT ${COLUMNS} FROM catalog_categories WHERE lower(trim(name_ar)) = lower(trim(?))`)
        .get(nameAr) as Record<string, unknown> | undefined,
    );
  }

  /** The next free position, so a new category lands at the end of the owner's list. */
  nextSortOrder(): number {
    const row = this.db
      .prepare(`SELECT max(sort_order) AS n FROM catalog_categories`)
      .get() as { n: bigint | number | null };
    return row.n === null ? 0 : Number(row.n) + 1;
  }

  insert(input: {
    readonly id: string;
    readonly nameAr: string;
    readonly nameEn: string | null;
    readonly sortOrder: number;
    readonly now: string;
  }): CategoryRow {
    this.db
      .prepare(
        `INSERT INTO catalog_categories (id, name_ar, name_en, is_active, sort_order,
                                         created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(input.id, input.nameAr, input.nameEn, input.sortOrder, input.now, input.now);
    return this.findById(input.id)!;
  }

  rename(id: string, nameAr: string, nameEn: string | null, now: string): CategoryRow {
    this.db
      .prepare(
        `UPDATE catalog_categories SET name_ar = ?, name_en = ?, updated_at = ? WHERE id = ?`,
      )
      .run(nameAr, nameEn, now, id);
    return this.findById(id)!;
  }

  setActive(id: string, active: boolean, now: string): CategoryRow {
    this.db
      .prepare(`UPDATE catalog_categories SET is_active = ?, updated_at = ? WHERE id = ?`)
      .run(active ? 1 : 0, now, id);
    return this.findById(id)!;
  }

  /**
   * How many products point at this category — ACTIVE OR NOT.
   *
   * 🔴 THE "OR NOT" IS THE WHOLE POINT. A deactivated product still carries its category, and
   * deleting the category out from under it would silently change a row the owner can still see
   * and reactivate. Counting only active products would make `delete` destructive in exactly the
   * case nobody is looking at.
   */
  countProductsUsing(id: string): number {
    const row = this.db
      .prepare(`SELECT count(*) AS n FROM catalog_products WHERE category_id = ?`)
      .get(id) as { n: bigint | number };
    return Number(row.n);
  }

  /**
   * Deletes the row. The caller must have established that nothing uses it, in the same
   * transaction — this file does not decide.
   *
   * The schema's `ON DELETE SET NULL` is the floor under that decision, not a substitute for it:
   * if this ever ran against a used category the product would lose its category rather than a
   * transaction aborting somewhere the owner cannot diagnose.
   */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM catalog_categories WHERE id = ?`).run(id);
  }
}
