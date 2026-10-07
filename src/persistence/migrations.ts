/**
 * Versioned, append-only schema migrations. RULES:
 *   - A migration that has shipped is NEVER edited; its SHA-256 is recorded when applied and
 *     checked on every open, so an edited migration stops the app instead of silently diverging.
 *   - A new change is a new entry with the next version number.
 *   - A database whose recorded version is newer than this build knows is refused (no downgrade).
 *
 * Money columns are INTEGER minor units in STRICT tables: SQLite itself rejects a REAL or TEXT
 * value in them, so a float can never be stored even by a buggy caller.
 *
 * Immutability is enforced by the DATABASE, not by convention: triggers abort any UPDATE or DELETE
 * on sales, sale_lines and voids, and abort any attempt to append a line to a sale that already
 * holds its declared line_count.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "initial_ledger",
    sql: `
CREATE TABLE sales (
  id                  TEXT    PRIMARY KEY,
  receipt_number      INTEGER NOT NULL UNIQUE CHECK (receipt_number > 0),
  idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_fingerprint TEXT    NOT NULL,
  cashier_id          TEXT    NOT NULL,
  cashier_name        TEXT    NOT NULL,
  currency            TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  subtotal_minor      INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  total_minor         INTEGER NOT NULL CHECK (total_minor >= 0),
  payment_method      TEXT    NOT NULL CHECK (payment_method IN ('cash', 'card', 'external', 'other')),
  line_count          INTEGER NOT NULL CHECK (line_count > 0),
  business_date       TEXT    NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  completed_at        TEXT    NOT NULL,
  created_at          TEXT    NOT NULL
) STRICT;

CREATE INDEX sales_business_date ON sales (business_date);

CREATE TABLE sale_lines (
  id                TEXT    PRIMARY KEY,
  sale_id           TEXT    NOT NULL REFERENCES sales (id),
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  product_id        TEXT    NOT NULL,
  sku               TEXT    NOT NULL,
  product_name      TEXT    NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor  INTEGER NOT NULL CHECK (line_total_minor = quantity * unit_price_minor),
  UNIQUE (sale_id, line_no)
) STRICT;

CREATE INDEX sale_lines_sale_id ON sale_lines (sale_id);

CREATE TABLE voids (
  id              TEXT PRIMARY KEY,
  sale_id         TEXT NOT NULL UNIQUE REFERENCES sales (id),
  cashier_id      TEXT NOT NULL,
  cashier_name    TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  business_date   TEXT NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at      TEXT NOT NULL
) STRICT;

CREATE TRIGGER sales_immutable_update BEFORE UPDATE ON sales
BEGIN SELECT RAISE(ABORT, 'ledger: completed sales are immutable'); END;
CREATE TRIGGER sales_immutable_delete BEFORE DELETE ON sales
BEGIN SELECT RAISE(ABORT, 'ledger: completed sales cannot be deleted'); END;

CREATE TRIGGER sale_lines_immutable_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'ledger: sale lines are immutable'); END;
CREATE TRIGGER sale_lines_immutable_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'ledger: sale lines cannot be deleted'); END;
CREATE TRIGGER sale_lines_closed_sale BEFORE INSERT ON sale_lines
WHEN (SELECT count(*) FROM sale_lines WHERE sale_id = NEW.sale_id)
     >= (SELECT line_count FROM sales WHERE id = NEW.sale_id)
BEGIN SELECT RAISE(ABORT, 'ledger: sale already holds all of its lines'); END;

CREATE TRIGGER voids_immutable_update BEFORE UPDATE ON voids
BEGIN SELECT RAISE(ABORT, 'ledger: voids are immutable'); END;
CREATE TRIGGER voids_immutable_delete BEFORE DELETE ON voids
BEGIN SELECT RAISE(ABORT, 'ledger: voids cannot be deleted'); END;
`,
  },
  {
    version: 2,
    name: "cashier_pin_lockout",
    // Mutable operational state, NOT ledger: rows are updated and deleted freely. One row per
    // cashier that has failed at least once; see src/domain/pinLockout.ts for the policy.
    sql: `
CREATE TABLE cashier_pin_state (
  cashier_id      TEXT    PRIMARY KEY,
  failed_attempts INTEGER NOT NULL CHECK (failed_attempts >= 0),
  locked_until    TEXT,
  updated_at      TEXT    NOT NULL
) STRICT;
`,
  },
  {
    version: 3,
    name: "local_catalog",
    // The terminal's own product list, imported from a local file (field pilot). Mutable master
    // data, NOT ledger: rows are updated in place and deactivated, never deleted, and no sale
    // references them — sale_lines keep their own name/price snapshot, so nothing here can alter
    // a past sale. Money is INTEGER minor units, as everywhere. base_unit is validated in code
    // (src/domain/catalog.ts BASE_UNITS) so a new unit needs no table rebuild.
    sql: `
CREATE TABLE catalog_products (
  id                  TEXT    PRIMARY KEY,
  source              TEXT    NOT NULL CHECK (length(source) > 0),
  source_key          TEXT    NOT NULL CHECK (length(source_key) > 0),
  sku                 TEXT    CHECK (sku IS NULL OR length(sku) > 0),
  name_ar             TEXT    NOT NULL CHECK (length(trim(name_ar)) > 0),
  name_en             TEXT    CHECK (name_en IS NULL OR length(trim(name_en)) > 0),
  selling_price_minor INTEGER NOT NULL CHECK (selling_price_minor > 0),
  currency            TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  base_unit           TEXT    NOT NULL CHECK (length(base_unit) > 0),
  price_needs_review  INTEGER NOT NULL CHECK (price_needs_review IN (0, 1)),
  is_active           INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  UNIQUE (source, source_key)
) STRICT;

CREATE UNIQUE INDEX catalog_products_sku ON catalog_products (sku) WHERE sku IS NOT NULL;

CREATE TABLE catalog_imports (
  id           TEXT    PRIMARY KEY,
  source       TEXT    NOT NULL,
  file_name    TEXT    NOT NULL,
  file_sha256  TEXT    NOT NULL CHECK (length(file_sha256) = 64),
  row_count    INTEGER NOT NULL CHECK (row_count >= 0),
  inserted     INTEGER NOT NULL CHECK (inserted >= 0),
  updated      INTEGER NOT NULL CHECK (updated >= 0),
  unchanged    INTEGER NOT NULL CHECK (unchanged >= 0),
  deactivated  INTEGER NOT NULL CHECK (deactivated >= 0),
  cashier_id   TEXT    NOT NULL,
  imported_at  TEXT    NOT NULL
) STRICT;
`,
  },
  {
    version: 4,
    name: "exact_sale_quantity",
    // ── Single-table rebuild of sale_lines ──────────────────────────────────────────────────────
    // `quantity INTEGER` (whole sale units) becomes `quantity_milli INTEGER` (thousandths), and the
    // line gains `sale_unit`: the unit this line was ACTUALLY SOLD IN, snapshotted exactly like
    // product_name and unit_price_minor. It is NOT product.base_unit — the product can be edited and
    // will one day carry several sell units; see docs/plans/exact-quantity-contract.md §18.
    //
    // Why a rebuild and not ALTER TABLE: the old CHECK is `line_total_minor = quantity *
    // unit_price_minor`, and SQLite cannot drop or replace a CHECK. The rebuild is safe here, and
    // every word of that was measured rather than assumed:
    //   - sale_lines is a LEAF table: nothing anywhere REFERENCES it, so dropping it with foreign
    //     keys ON is sound. (`PRAGMA foreign_keys=OFF` is silently IGNORED inside a transaction,
    //     which the migration runner always is, so this migration must never depend on it.)
    //   - DROP TABLE does NOT fire the BEFORE DELETE trigger, so the append-only rule does not
    //     block its own replacement.
    //   - the runner wraps each migration in db.transaction(...).immediate(), so a crash part-way
    //     leaves the v3 table, its rows and its triggers exactly as they were.
    //
    // Historical rows: quantity N becomes N*1000, and `sale_unit` stays NULL, meaning UNKNOWN. The
    // unit of a past sale is NOT recoverable — the product may have been edited, and a fixture
    // product is not in catalog_products at all — so nothing here consults today's catalog to
    // invent one. Every other column is copied byte for byte; no total is ever recomputed.
    sql: `
CREATE TABLE sale_lines_v4 (
  id                TEXT    PRIMARY KEY,
  sale_id           TEXT    NOT NULL REFERENCES sales (id),
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  product_id        TEXT    NOT NULL,
  sku               TEXT    NOT NULL,
  product_name      TEXT    NOT NULL,
  -- NULL means UNKNOWN, and only a row written before this migration may be unknown; the
  -- sale_lines_require_unit trigger below refuses a new one.
  sale_unit         TEXT             CHECK (sale_unit IS NULL OR length(trim(sale_unit)) > 0),
  quantity_milli    INTEGER NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 9999000),
  -- 922429446630 = floor((2^63 - 1 - 500) / 9999000). Above it, quantity_milli * unit_price_minor
  -- overflows signed 64-bit INTEGER and SQLite SILENTLY yields a REAL, which would make the CHECK
  -- below evaluate in floating point. The bound keeps the multiplication itself integral.
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0 AND unit_price_minor <= 922429446630),
  -- Exact round-half-up. Integer division on INTEGER operands admits exactly one value, ties
  -- included; there is no tolerance and no second arithmetic anywhere in the app.
  line_total_minor  INTEGER NOT NULL
      CHECK (line_total_minor = (quantity_milli * unit_price_minor + 500) / 1000),
  -- Fractions belong to the units named here and to nothing else, so a unit added to BASE_UNITS
  -- later is whole-only until a migration says otherwise: it fails CLOSED.
  CHECK (sale_unit IS NULL OR sale_unit IN ('kg', 'meter') OR quantity_milli % 1000 = 0),
  UNIQUE (sale_id, line_no)
) STRICT;

INSERT INTO sale_lines_v4 (id, sale_id, line_no, product_id, sku, product_name,
                           sale_unit, quantity_milli, unit_price_minor, line_total_minor)
SELECT id, sale_id, line_no, product_id, sku, product_name,
       NULL, quantity * 1000, unit_price_minor, line_total_minor
  FROM sale_lines;

DROP TABLE sale_lines;
ALTER TABLE sale_lines_v4 RENAME TO sale_lines;

CREATE INDEX sale_lines_sale_id ON sale_lines (sale_id);

CREATE TRIGGER sale_lines_immutable_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'ledger: sale lines are immutable'); END;
CREATE TRIGGER sale_lines_immutable_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'ledger: sale lines cannot be deleted'); END;
CREATE TRIGGER sale_lines_closed_sale BEFORE INSERT ON sale_lines
WHEN (SELECT count(*) FROM sale_lines WHERE sale_id = NEW.sale_id)
     >= (SELECT line_count FROM sales WHERE id = NEW.sale_id)
BEGIN SELECT RAISE(ABORT, 'ledger: sale already holds all of its lines'); END;

-- Created AFTER the copy on purpose: the migrated rows keep their honest NULL, and from here on a
-- line without its unit is impossible. A NOT NULL column could not express both.
CREATE TRIGGER sale_lines_require_unit BEFORE INSERT ON sale_lines
WHEN NEW.sale_unit IS NULL
BEGIN SELECT RAISE(ABORT, 'ledger: a sale line must record the unit it was sold in'); END;
`,
  },
];
