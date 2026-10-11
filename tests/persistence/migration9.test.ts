/**
 * Migration 9 — Product Master, proven on a POPULATED v8 database.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY A POPULATED PRIOR SCHEMA, NOT AN EMPTY ONE. Migration 7's own history is this project's
 * receipt for the difference: a rebuild that passed on an empty database failed instantly on a real
 * ledger, because the empty one had no child rows to violate a deferred foreign key. So this file
 * seeds a v8 database that looks like a real shop — products, a sale that references a product by
 * SNAPSHOT, an invoice, operators, a claimed terminal, audit rows — and then runs migration 9 over
 * it.
 *
 * 🔴 WHY ONE MIGRATION AND NOT THREE. The approved architecture proposed M9 categories, M10 online
 * content, M11 images. Its own rollback paragraph is the argument against the split: SQLite on this
 * project's pinned path cannot drop a column without rebuilding the table, so rollback for each of
 * the three is the SAME automatic pre-migration snapshot. Three migrations therefore buy zero extra
 * rollback granularity while costing three fingerprints, three populated-upgrade proofs and three
 * seams — for one feature, behind one form, that is never shipped partially.
 *
 * WHAT MUST REMAIN TRUE, and is asserted here rather than assumed: every pre-existing product still
 * sells, every historical row is byte-identical, no backfill ran, nothing was rewritten, and a
 * product with no category, no brand, no description and no photo is still a valid product.
 *
 * Synthetic data throughout. No shop or customer data appears in this repository.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { type Db, openDatabase, schemaVersion } from "../../src/persistence/db";
import { type TempDir, tempDir } from "../helpers/harness";
import { normalizeBarcode } from "../../src/domain/barcode";

const V8 = MIGRATIONS.filter((m) => m.version <= 8);
const V9 = MIGRATIONS.filter((m) => m.version <= 9);

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => {
  t.cleanup();
});

/** A v8 database that looks like a shop that has been trading: products, a sale, an invoice. */
function seedV8(): void {
  const db = openDatabase(t.dbPath, V8);
  try {
    db.exec(`
      INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en,
                                    selling_price_minor, currency, base_unit, price_needs_review,
                                    is_active, created_at, updated_at)
      VALUES ('p-1', 'manual', 'k-1', 'SKU-1', 'مفك براغي', 'Screwdriver', 250000, 'LBP', 'piece',
              0, 1, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z'),
             ('p-2', 'file', 'k-2', NULL, 'إسمنت', NULL, 900000, 'LBP', 'box',
              0, 1, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z'),
             ('p-3', 'manual', 'k-3', 'SKU-3', 'بلاط', NULL, 1500000, 'LBP', 'meter',
              0, 0, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z');

      -- A real sale, whose line carries its own product SNAPSHOT and no foreign key. This is the
      -- discipline that makes an additive migration on catalog_products safe.
      INSERT INTO sales (id, receipt_number, idempotency_key, request_fingerprint, source_type,
                         invoice_id, cashier_id, cashier_name, currency, subtotal_minor, tax_minor,
                         total_minor, paid_minor, balance_due_minor, payment_status, payment_method,
                         line_count, business_date, completed_at, created_at)
      VALUES ('s-1', 1, 'idem-0000001', 'fp-1', 'pos', NULL, 'cashier-01', 'Cashier One',
              'LBP', 250000, 0, 250000, 250000, 0, 'paid', 'cash', 1, '2026-10-02',
              '2026-10-02T09:00:00.000Z', '2026-10-02T09:00:00.000Z');

      INSERT INTO audit_events (id, seq, event_type, entity_type, entity_id, actor_id, actor_name,
                                actor_tier, occurred_at, business_date, changed_json, metadata_json,
                                app_version, schema_version)
      VALUES ('a-1', 1, 'PRODUCT_CREATED', 'product', 'p-1', 'cashier-01', 'Cashier One',
              'owner', '2026-10-01T08:00:00.000Z', '2026-10-01', '{"name_ar":"مفك براغي"}',
              NULL, '0.1.1', 8);
    `);
    // The terminal was claimed, as a trading shop's would be.
    db.prepare(
      `UPDATE terminal_security_state
          SET terminal_claimed = 1, claimed_at = '2026-10-01T07:00:00.000Z',
              claimed_by_operator_id = 'cashier-01'
        WHERE id = 'terminal'`,
    ).run();
  } finally {
    db.close();
  }
}

const upgrade = (): Db => {
  const db = openDatabase(t.dbPath, V9);
  expect(schemaVersion(db)).toBe(9);
  return db;
};
const rows = (db: Db, sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
const one = (db: Db, sql: string) => rows(db, sql)[0]!;
const cols = (db: Db, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe("migration 9 on a populated v8 database", () => {
  it("upgrades a real trading ledger to v9 with integrity intact", () => {
    seedV8();
    const db = upgrade();
    try {
      expect(schemaVersion(db)).toBe(9);
      // The failure mode migration 7 actually hit: an unsatisfied foreign key commits nothing.
      expect(one(db, "PRAGMA foreign_key_check")).toBeUndefined();
      expect(one(db, "PRAGMA integrity_check").integrity_check).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("🔴 leaves every pre-existing product row byte for byte — no backfill, nothing rewritten", () => {
    seedV8();
    const before = (() => {
      const db = openDatabase(t.dbPath, V8);
      try {
        return rows(db, "SELECT * FROM catalog_products ORDER BY id");
      } finally {
        db.close();
      }
    })();
    const db = upgrade();
    try {
      const after = rows(db, "SELECT * FROM catalog_products ORDER BY id");
      expect(after).toHaveLength(before.length);
      for (const [i, row] of before.entries()) {
        // Every column that existed before holds exactly what it held.
        for (const [k, v] of Object.entries(row)) {
          expect(after[i]![k], `${row.id as string}.${k}`).toEqual(v);
        }
      }
      // 🔴 AND THE NEW COLUMNS ARE EMPTY, not guessed. A migration that invented a category or a
      // brand for an existing product would be writing the shop's data for it.
      for (const r of after) {
        expect(r.category_id).toBeNull();
        expect(r.barcode).toBeNull();
        expect(r.brand).toBeNull();
        expect(r.description_ar).toBeNull();
        expect(r.description_en).toBeNull();
        // DEFAULT 0 — every existing product is OFF the website until the owner says otherwise.
        expect(Number(r.is_online_visible)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("🔴 the ledger, the invoice trail and the operator state are untouched", () => {
    seedV8();
    const db = upgrade();
    try {
      expect(Number(one(db, "SELECT count(*) AS n FROM sales").n)).toBe(1);
      expect(one(db, "SELECT cashier_name AS n FROM sales").n).toBe("Cashier One");
      expect(Number(one(db, "SELECT count(*) AS n FROM audit_events").n)).toBe(1);
      // 🔴 No audit row describes this migration. A schema change is not a business event, and
      // inventing one would put a lie on an append-only trail.
      expect(one(db, "SELECT event_type AS t FROM audit_events").t).toBe("PRODUCT_CREATED");
      // Operator accounts and the terminal claim survive a schema change, obviously — asserted
      // because "obviously" is what the last four defects had in common.
      expect(Number(one(db, "SELECT count(*) AS n FROM operators").n)).toBe(2);
      const st = one(db, "SELECT * FROM terminal_security_state");
      expect(Number(st.terminal_claimed)).toBe(1);
      expect(st.claimed_by_operator_id).toBe("cashier-01");
    } finally {
      db.close();
    }
  });

  it("adds exactly five columns to catalog_products, all nullable or defaulted", () => {
    seedV8();
    const db = upgrade();
    try {
      const after = cols(db, "catalog_products");
      // 🔴 TRANSITION: this read `slice(-5)` without `barcode` until barcode was approved into
      // this same unreleased migration rather than becoming a migration 10 for one column.
      expect(after.slice(-6)).toEqual([
        "category_id",
        "barcode",
        "brand",
        "description_ar",
        "description_en",
        "is_online_visible",
      ]);
      // 🔴 An INSERT that names only migration 3's columns must still work, because the import path
      // and every existing caller do exactly that. A NOT NULL column without a default here would
      // have broken catalog import on upgrade day.
      expect(() =>
        db
          .prepare(
            `INSERT INTO catalog_products (id, source, source_key, sku, name_ar, name_en,
                                           selling_price_minor, currency, base_unit,
                                           price_needs_review, is_active, created_at, updated_at)
             VALUES ('p-new', 'file', 'k-new', NULL, 'منشار', NULL, 400000, 'LBP', 'piece',
                     0, 1, '2026-10-11T09:00:00.000Z', '2026-10-11T09:00:00.000Z')`,
          )
          .run(),
      ).not.toThrow();
      expect(Number(one(db, "SELECT is_online_visible AS v FROM catalog_products WHERE id = 'p-new'").v)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("categories", () => {
  it("are flat, owner-ordered, and refuse a duplicate name whatever the case or spacing", () => {
    seedV8();
    const db = upgrade();
    try {
      const ins = db.prepare(
        `INSERT INTO catalog_categories (id, name_ar, name_en, is_active, sort_order,
                                         created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, '2026-10-11T09:00:00.000Z', '2026-10-11T09:00:00.000Z')`,
      );
      ins.run("c-1", "عدد", "Tools", 0);
      ins.run("c-2", "دهان", "Paint", 1);

      // 🔴 Same name with surrounding space, and in a different case for the Latin one. A shop that
      // ends up with two "عدد" categories has a filter that silently splits its own catalog.
      expect(() => ins.run("c-3", " عدد ", null, 2)).toThrow();
      expect(() => ins.run("c-4", "عدد", null, 3)).toThrow();
      // A blank name is not a name.
      expect(() => ins.run("c-5", "   ", null, 4)).toThrow();
      // There is NO parent_id: a tree is not approved, and its absence is the assertion.
      expect(cols(db, "catalog_categories")).not.toContain("parent_id");
      expect(Number(one(db, "SELECT count(*) AS n FROM catalog_categories").n)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("🔴 a category a product uses can be DEACTIVATED without the product losing it", () => {
    seedV8();
    const db = upgrade();
    try {
      db.prepare(
        `INSERT INTO catalog_categories (id, name_ar, name_en, is_active, sort_order,
                                         created_at, updated_at)
         VALUES ('c-1', 'عدد', 'Tools', 1, 0, '2026-10-11T09:00:00.000Z', '2026-10-11T09:00:00.000Z')`,
      ).run();
      db.prepare("UPDATE catalog_products SET category_id = 'c-1' WHERE id = 'p-1'").run();

      db.prepare("UPDATE catalog_categories SET is_active = 0 WHERE id = 'c-1'").run();
      // The product keeps its link. The owner simply stops being offered the category.
      expect(one(db, "SELECT category_id AS c FROM catalog_products WHERE id = 'p-1'").c).toBe("c-1");
      // And renaming it does not touch the link either — the id is the identity, not the name.
      db.prepare("UPDATE catalog_categories SET name_ar = 'عدد يدوية' WHERE id = 'c-1'").run();
      expect(one(db, "SELECT category_id AS c FROM catalog_products WHERE id = 'p-1'").c).toBe("c-1");
      expect(one(db, "SELECT name_ar AS n FROM catalog_categories WHERE id = 'c-1'").n).toBe("عدد يدوية");
    } finally {
      db.close();
    }
  });

  it("ON DELETE SET NULL is the floor under the service, not the rule", () => {
    seedV8();
    const db = upgrade();
    try {
      db.prepare(
        `INSERT INTO catalog_categories (id, name_ar, name_en, is_active, sort_order,
                                         created_at, updated_at)
         VALUES ('c-1', 'عدد', NULL, 1, 0, '2026-10-11T09:00:00.000Z', '2026-10-11T09:00:00.000Z')`,
      ).run();
      db.prepare("UPDATE catalog_products SET category_id = 'c-1' WHERE id = 'p-1'").run();
      // The service refuses to delete a category in use; this proves what the SCHEMA does if a
      // future path ever gets past it — the product loses its category and keeps selling, rather
      // than a transaction aborting somewhere the owner cannot see.
      db.prepare("DELETE FROM catalog_categories WHERE id = 'c-1'").run();
      expect(one(db, "SELECT category_id AS c FROM catalog_products WHERE id = 'p-1'").c).toBeNull();
      expect(Number(one(db, "SELECT count(*) AS n FROM catalog_products WHERE id = 'p-1'").n)).toBe(1);
      // A category id that does not exist cannot be attached in the first place.
      expect(() =>
        db.prepare("UPDATE catalog_products SET category_id = 'nope' WHERE id = 'p-2'").run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("product images", () => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
      "0d0a2db40000000049454e44ae426082",
    "hex",
  );
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  function insertImage(db: Db, over: Record<string, unknown> = {}): void {
    const r = {
      id: "img-1",
      product_id: "p-1",
      bytes: png,
      mime: "image/png",
      sha256_hex: sha(png),
      byte_size: png.length,
      width_px: 1,
      height_px: 1,
      is_primary: 1,
      origin: "desktop",
      created_at: "2026-10-11T09:00:00.000Z",
      updated_at: "2026-10-11T09:00:00.000Z",
      ...over,
    };
    db.prepare(
      `INSERT INTO catalog_product_images (id, product_id, bytes, mime, sha256_hex, byte_size,
                                           width_px, height_px, is_primary, origin,
                                           created_at, updated_at)
       VALUES (@id, @product_id, @bytes, @mime, @sha256_hex, @byte_size, @width_px, @height_px,
               @is_primary, @origin, @created_at, @updated_at)`,
    ).run(r);
  }

  it("🔴 live in a CHILD table, so the products list never reads image bytes", () => {
    seedV8();
    const db = upgrade();
    try {
      // The decision that is load-bearing rather than tidy: the products list selects from
      // catalog_products, so a BLOB column there would load every photo on every list render.
      expect(cols(db, "catalog_products")).not.toContain("bytes");
      expect(cols(db, "catalog_products")).not.toContain("image");
      expect(cols(db, "catalog_products")).not.toContain("image_url");
      insertImage(db);
      // Reading the whole product row still carries no image bytes.
      expect(Object.keys(one(db, "SELECT * FROM catalog_products WHERE id = 'p-1'"))).not.toContain("bytes");
    } finally {
      db.close();
    }
  });

  it("store real bytes, and round-trip them unchanged with a matching hash", () => {
    seedV8();
    const db = upgrade();
    try {
      insertImage(db);
      const got = one(db, "SELECT * FROM catalog_product_images WHERE id = 'img-1'");
      expect(Buffer.isBuffer(got.bytes)).toBe(true);
      expect((got.bytes as Buffer).equals(png)).toBe(true);
      expect(got.sha256_hex).toBe(sha(png));
      expect(Number(got.byte_size)).toBe(png.length);
      // 🔴 The hash is what the online export verifies its written file against, so a corruption
      // between database and website cannot pass unnoticed.
      expect(sha(got.bytes as Buffer)).toBe(got.sha256_hex);
    } finally {
      db.close();
    }
  });

  it("🔴 ONE primary image per product is enforced by the schema, not remembered by the service", () => {
    seedV8();
    const db = upgrade();
    try {
      insertImage(db, { id: "img-1" });
      // A second primary for the SAME product is refused.
      expect(() => insertImage(db, { id: "img-2" })).toThrow();
      // A non-primary row is fine — this is the seam a future gallery uses, with no migration.
      expect(() => insertImage(db, { id: "img-2", is_primary: 0 })).not.toThrow();
      // And another product may have its own primary.
      expect(() => insertImage(db, { id: "img-3", product_id: "p-2" })).not.toThrow();
      expect(Number(one(db, "SELECT count(*) AS n FROM catalog_product_images WHERE is_primary = 1").n)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("refuse what is not a storable image, at the schema level", () => {
    seedV8();
    const db = upgrade();
    try {
      expect(() => insertImage(db, { mime: "image/webp" })).toThrow();       // not measured, not promised
      expect(() => insertImage(db, { mime: "application/pdf" })).toThrow();
      expect(() => insertImage(db, { bytes: Buffer.alloc(0) })).toThrow();   // zero bytes is not an image
      expect(() => insertImage(db, { sha256_hex: "ABCD" })).toThrow();       // wrong length
      expect(() => insertImage(db, { sha256_hex: sha(png).toUpperCase() })).toThrow(); // must be lower-case
      expect(() => insertImage(db, { width_px: 0 })).toThrow();
      expect(() => insertImage(db, { origin: "whatsapp" })).toThrow();       // desktop or phone, nothing else
      expect(() => insertImage(db, { product_id: "no-such-product" })).toThrow();
    } finally {
      db.close();
    }
  });

  it("are deleted with their product, and never leave an orphan", () => {
    seedV8();
    const db = upgrade();
    try {
      insertImage(db);
      // Products are deactivated rather than deleted in this product, so this is the schema's
      // floor again: if a row ever does go, its image goes with it rather than becoming an orphan
      // the export would later try to write.
      db.prepare("DELETE FROM catalog_products WHERE id = 'p-1'").run();
      expect(Number(one(db, "SELECT count(*) AS n FROM catalog_product_images").n)).toBe(0);
      expect(one(db, "PRAGMA foreign_key_check")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("barcode", () => {
  it("is nullable — most of this shop's stock carries no barcode at all", () => {
    seedV8();
    const db = upgrade();
    try {
      // Three pre-existing products, none of which has one, and all of which still sell.
      expect(Number(one(db, "SELECT count(*) AS n FROM catalog_products WHERE barcode IS NULL").n)).toBe(3);
      expect(() =>
        db.prepare("UPDATE catalog_products SET barcode = NULL WHERE id = 'p-1'").run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("🔴 is unique WHEN PRESENT, and many NULLs are not a collision", () => {
    seedV8();
    const db = upgrade();
    try {
      db.prepare("UPDATE catalog_products SET barcode = '5901234123457' WHERE id = 'p-1'").run();
      // The same barcode on a second product is refused — one physical symbol, one product.
      expect(() =>
        db.prepare("UPDATE catalog_products SET barcode = '5901234123457' WHERE id = 'p-2'").run(),
      ).toThrow();
      // 🔴 But two products WITHOUT one are not duplicates of each other.
      //
      // AND MY FIRST COMMENT HERE WAS WRONG ABOUT WHY. It said this is "the whole reason the index
      // is partial, and the assertion a plain UNIQUE index would fail". It is not: SQLite treats
      // NULLs as distinct in a PLAIN unique index too — measured, three NULL rows inserted into a
      // plain `UNIQUE INDEX t (bc)` on SQLite 3.45.1, all accepted. A negative control caught the
      // claim: replacing the partial index with a plain one failed only the shape test below, not
      // this one.
      //
      // The real reasons for `WHERE barcode IS NOT NULL` are that it indexes only the rows that
      // have a barcode — most of this shop's catalog does not — and that it states the intent in
      // the schema where a reader meets it. Not NULL-collision avoidance, which SQLite gives for
      // free either way.
      expect(Number(one(db, "SELECT count(*) AS n FROM catalog_products WHERE barcode IS NULL").n)).toBe(2);
      expect(() =>
        db.prepare("UPDATE catalog_products SET barcode = '96385074' WHERE id = 'p-2'").run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("is shaped exactly like sku's partial index — the pattern is not reinvented", () => {
    seedV8();
    const db = upgrade();
    try {
      const idx = rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'catalog_products_%'");
      const barcode = idx.find((r) => r.name === "catalog_products_barcode")!;
      const sku = idx.find((r) => r.name === "catalog_products_sku")!;
      expect(barcode.sql).toMatch(/UNIQUE INDEX .* \(barcode\) WHERE barcode IS NOT NULL/);
      // Same shape, same clause, so one cannot drift from the other unnoticed.
      expect(String(barcode.sql).replace(/barcode/g, "X")).toBe(String(sku.sql).replace(/sku/g, "X"));
    } finally {
      db.close();
    }
  });

  it("🔴 the canonical form is what reaches the database — the UPC-A equivalence, end to end", () => {
    seedV8();
    const db = upgrade();
    try {
      // The domain normalizes; the database stores. This test runs the real normalizer so the two
      // halves cannot disagree: a typed UPC-A and a decoded EAN-13 must collide, not coexist.
      const typed = normalizeBarcode("036000291452")!;   // merchant reads the box
      const decoded = normalizeBarcode("0036000291452")!; // phone photographs the same box
      expect(typed.value).toBe(decoded.value);

      db.prepare("UPDATE catalog_products SET barcode = ? WHERE id = 'p-1'").run(typed.value);
      expect(one(db, "SELECT barcode AS b FROM catalog_products WHERE id = 'p-1'").b).toBe("0036000291452");
      // 🔴 AND THE SECOND ROUTE IS REFUSED BY THE INDEX, which is only true because both routes
      // normalize to one string. Without normalization this insert would succeed and the shop
      // would own two products for one box.
      expect(() =>
        db.prepare("UPDATE catalog_products SET barcode = ? WHERE id = 'p-2'").run(decoded.value),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("is searchable by exact canonical value", () => {
    seedV8();
    const db = upgrade();
    try {
      db.prepare("UPDATE catalog_products SET barcode = '0036000291452' WHERE id = 'p-2'").run();
      const hit = one(db, "SELECT id, name_ar FROM catalog_products WHERE barcode = '0036000291452'");
      expect(hit.id).toBe("p-2");
      // And the 12-digit form finds nothing on its own, which is exactly why the application must
      // normalize before it queries — asserted so nobody later "fixes" search with a LIKE.
      expect(rows(db, "SELECT id FROM catalog_products WHERE barcode = '036000291452'")).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("the migration is fingerprinted, additive and immutable", () => {
  it("registers with its own checksum, and migrations 1-8 are byte-identical after it", () => {
    seedV8();
    const db = upgrade();
    try {
      const applied = rows(db, "SELECT version, name, checksum FROM schema_migrations ORDER BY version");
      expect(applied).toHaveLength(9);
      const m9 = applied[8]! as { version: bigint; name: string; checksum: string };
      expect(Number(m9.version)).toBe(9);
      expect(m9.name).toBe("product_master");
      expect(m9.checksum).toMatch(/^[0-9a-f]{64}$/);
      const sums = applied.map((r) => r.checksum);
      expect(new Set(sums).size).toBe(sums.length);
    } finally {
      db.close();
    }
    // Editing any released migration would make every real ledger refuse to open.
    expect(MIGRATIONS.filter((m) => m.version <= 8)).toHaveLength(8);
    expect(MIGRATIONS[8]!.name).toBe("product_master");
  });

  it("🔴 is purely ADDITIVE — no rebuild, no backfill, no DROP, no UPDATE of existing rows", () => {
    const sql = MIGRATIONS[8]!.sql;
    // The grep is on the SQL this migration really carries, with its comments stripped, so a
    // sentence in prose cannot satisfy or trip any of these.
    const code = sql.replace(/^\s*--.*$/gm, "");
    expect(code).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\w/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i); // no seeded categories: the owner's list is theirs
    expect(code).not.toMatch(/\bRENAME\b/i);
    // 🔴 `DELETE FROM`, not a bare /DELETE/. The first draft of this line used the bare word and
    // failed — correctly — on `ON DELETE SET NULL` and `ON DELETE CASCADE`, which are foreign-key
    // CONSTRAINT clauses, not statements. The assertion was wrong, not the migration; a referential
    // action that fires only when something else deletes a row is the opposite of this migration
    // deleting anything.
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    // And the two referential actions it DOES declare are named, so neither can change unnoticed.
    expect(code).toMatch(/ON DELETE SET NULL/);
    expect(code).toMatch(/ON DELETE CASCADE/);
    // What it DOES do, named: two tables and five columns.
    expect(code.match(/CREATE TABLE/gi)).toHaveLength(2);
    expect(code.match(/ADD COLUMN/gi)).toHaveLength(6); // was 5 before barcode joined this migration
    // 🔴 And it does not touch any table an earlier migration owns, apart from the five columns.
    for (const table of ["sales", "sale_lines", "voids", "invoices", "invoice_lines", "operators", "audit_events"]) {
      expect(code, `migration 9 must not mention ${table}`).not.toMatch(new RegExp(`\\b${table}\\b`, "i"));
    }
  });

  it("🔴 a v8 BUILD REFUSES a v9 database — the rollback contract, as code", () => {
    seedV8();
    upgrade().close();
    // So rollback from v9 is: restore the pre-migration snapshot, THEN run the older build.
    expect(() => openDatabase(t.dbPath, V8)).toThrow(/newer than this build/);
  });
});
