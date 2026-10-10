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
  {
    version: 5,
    name: "durable_local_audit",
    // ── The authoritative durable business audit trail ──────────────────────────────────────────
    //
    // Purely ADDITIVE: one new table, four indexes, three triggers. No existing table is altered,
    // no existing trigger is touched, and NOTHING is backfilled — `audit_events` starts empty on a
    // migrated ledger, and that is deliberate and truthful. The rotating JSON logfile that carried
    // audit lines until now rotates and is deleted, was written AFTER the business commit, and is
    // therefore not transactionally trustworthy historical evidence; inventing pre-v5 history out
    // of it would be worse than having none. The durable trail starts here, prospectively.
    //
    // WHY `seq` AND NOT `occurred_at` FOR ORDERING: the clock is injectable (frozen to a constant
    // in tests) and one user action may emit several events, so two rows can legitimately share
    // `occurred_at` to the millisecond. Timestamp equality is allowed on purpose; `seq` is the only
    // ordering authority, allocated as max(seq)+1 inside the same BEGIN IMMEDIATE as the business
    // mutation — exactly how sales.receipt_number is allocated.
    //
    // WHY TEXT TIMESTAMPS: every other table in this ledger stores ISO-8601 UTC text
    // (sales.completed_at, voids.created_at, catalog_products.updated_at). Consistency beats
    // cleverness, and GLOB can then shape-check them as it already does for business_date.
    //
    // NO FOREIGN KEY TO AN ACTOR — and it is not merely unwise, it is impossible: there is no
    // cashiers TABLE, the cashiers are a TypeScript fixture. actor_id/actor_name/actor_tier are
    // plain snapshots, exactly as sale_lines.product_name is, so editing or removing an actor
    // tomorrow cannot invalidate or erase a historical row.
    //
    // 🔴 WHAT THE TRIGGERS DO AND DO NOT PROTECT. They make UPDATE and DELETE impossible through
    // this application and through any normal SQL access to the table, and they make a back-dated
    // seq impossible. They are NOT tamper-proof against someone who owns the file: DROP TABLE does
    // not fire BEFORE DELETE, and the sqlite3 CLI can do as it likes. Hash chaining would raise
    // that bar and is deliberately NOT in this migration.
    sql: `
CREATE TABLE audit_events (
  id             TEXT    PRIMARY KEY,
  seq            INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  event_type     TEXT    NOT NULL CHECK (event_type IN
                   ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED',
                    'PRODUCT_DEACTIVATED', 'CATALOG_IMPORTED')),
  entity_type    TEXT    NOT NULL CHECK (entity_type IN ('product', 'catalog')),
  entity_id      TEXT    NOT NULL CHECK (length(entity_id) > 0),
  actor_id       TEXT    NOT NULL CHECK (length(actor_id) > 0),
  actor_name     TEXT    NOT NULL CHECK (length(trim(actor_name)) > 0),
  actor_tier     TEXT    NOT NULL CHECK (actor_tier IN
                   ('owner', 'admin', 'cashier', 'system', 'unspecified')),
  occurred_at    TEXT    NOT NULL CHECK (occurred_at GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  business_date  TEXT    NOT NULL CHECK (business_date GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_json   TEXT    NOT NULL CHECK (json_valid(changed_json)
                                         AND json_type(changed_json) = 'object'),
  metadata_json  TEXT             CHECK (metadata_json IS NULL
                                         OR (json_valid(metadata_json)
                                             AND json_type(metadata_json) = 'object')),
  app_version    TEXT    NOT NULL CHECK (length(app_version) > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  -- A product event may only describe a product, and an import only the catalog. The same pairing
  -- is enforced in src/domain/audit.ts; this is the backstop that no code path can talk past.
  CHECK (
    (entity_type = 'product' AND event_type IN
       ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED'))
    OR (entity_type = 'catalog' AND event_type = 'CATALOG_IMPORTED')
  )
) STRICT;

-- Four indexes, each for one named question. "Newest events" needs none: seq is UNIQUE, so
-- ORDER BY seq DESC LIMIT n is already an index scan. No specialized JSON index is created here:
-- there is no audit query UI yet, and coupling the schema to one JSON field before a real query
-- has been measured would be premature.
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, seq DESC);
CREATE INDEX audit_events_type   ON audit_events (event_type, seq DESC);
CREATE INDEX audit_events_actor  ON audit_events (actor_id, seq DESC);
CREATE INDEX audit_events_date   ON audit_events (business_date, seq DESC);

CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: the audit trail is append-only'); END;
CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: audit events cannot be deleted'); END;

-- The one thing a CHECK cannot do: a CHECK sees only its own row, so it cannot know the current
-- max(seq). Back-dating a row to slot it between two existing events is therefore the single
-- forgery a CHECK is blind to, and this trigger is what closes it.
CREATE TRIGGER audit_events_seq_monotonic BEFORE INSERT ON audit_events
WHEN NEW.seq <= coalesce((SELECT max(seq) FROM audit_events), 0)
BEGIN SELECT RAISE(ABORT, 'audit: seq must be monotonic'); END;
`,
  },
  {
    version: 6,
    name: "manual_invoices",
    // ── The manual invoice, its issuer, and the catalog reconciliation queue ─────────────────────
    //
    // Purely ADDITIVE: four new tables, their indexes and their triggers. Migrations 1-5 are not
    // touched, and NOTHING is synthesized — a migrated ledger has zero invoices, zero invoice lines
    // and zero reconciliation rows, which is the honest state of a shop that has not written one
    // yet.
    //
    // 🔴 AN INVOICE IS NOT A SALE, BY DECISION. Nothing here references `sales`, writes to it, or
    // is read by the daily report. Finalizing an invoice enters no till total, moves no stock and
    // creates no customer ledger entry. `paid_minor` and `balance_due_minor` are fields ON THE
    // DOCUMENT, not an accounts-receivable system.
    //
    // 🔴 WHY A DRAFT CANNOT LIVE IN `sale_lines`, measured rather than preferred: `sale_lines` has
    // forbidden UPDATE and DELETE by trigger since migration 1, and a draft invoice is edited.
    // Reusing the ledger's tables was therefore impossible, not merely inelegant. What IS reused is
    // every primitive: integer minor units, `quantity_milli` at scale 1000, the same half-up line
    // arithmetic and the same overflow bound as migration 4.
    //
    // THE ISSUER IS SNAPSHOTTED, not referenced. `company_profile` is live settings; a finalized
    // invoice carries `issuer_snapshot_json`. Changing the shop's phone number tomorrow must not
    // change an invoice issued yesterday, and a foreign key would have done exactly that.
    //
    // IMMUTABILITY APPLIES ONLY ONCE FINAL. A draft is meant to be edited; a finalized invoice is a
    // commercial document. The triggers below express that difference instead of forcing one rule
    // on both. Correction of a finalized invoice (credit note / replacement) is future scope and is
    // deliberately NOT faked by allowing an edit.
    sql: `
-- One row, the shop's own identity. A CHECK pins the id so a second row is impossible.
--
-- The three official identifiers are SEPARATE optional fields on purpose: a taxpayer number, a
-- commercial register number and a VAT registration number are three different things, and
-- collapsing them would print one under another's label. Printing them does NOT make an invoice
-- legally or tax compliant, and nothing in this schema claims otherwise.
CREATE TABLE company_profile (
  id                   TEXT    PRIMARY KEY CHECK (id = 'company'),
  name_ar              TEXT    NOT NULL CHECK (length(trim(name_ar)) > 0),
  name_en              TEXT    CHECK (name_en IS NULL OR length(trim(name_en)) > 0),
  legal_name           TEXT    CHECK (legal_name IS NULL OR length(trim(legal_name)) > 0),
  tagline              TEXT,
  address              TEXT,
  phone1               TEXT,
  phone2               TEXT,
  email                TEXT,
  logo_path            TEXT,
  taxpayer_number      TEXT,
  commercial_register  TEXT,
  vat_number           TEXT,
  -- Tax is OFF unless this says otherwise, and the rate lives in basis points so it is exact:
  -- 1100 = 11.00%. No rate is hard-coded anywhere in the application.
  tax_enabled          INTEGER NOT NULL CHECK (tax_enabled IN (0, 1)),
  tax_rate_bp          INTEGER NOT NULL CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 10000),
  tax_label            TEXT,
  -- The next number to assign. A shop continuing a paper invoice book starts at 61, not 1; this may
  -- only be set while no invoice has been finalized yet, which the service enforces.
  next_invoice_number  INTEGER NOT NULL CHECK (next_invoice_number > 0),
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
) STRICT;

CREATE TABLE invoices (
  id                   TEXT    PRIMARY KEY,
  status               TEXT    NOT NULL CHECK (status IN ('draft', 'final')),
  -- NULL while a draft. SQLite's UNIQUE permits many NULLs, which is exactly what is wanted: the
  -- number is scarce and is assigned at FINALIZE, not when a disposable draft is opened.
  invoice_number       INTEGER UNIQUE CHECK (invoice_number IS NULL OR invoice_number > 0),
  invoice_date         TEXT    CHECK (invoice_date IS NULL OR invoice_date GLOB
                           '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  currency             TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  customer_name        TEXT,
  customer_address     TEXT,
  customer_phone       TEXT,
  notes                TEXT,
  subtotal_minor       INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor            INTEGER NOT NULL CHECK (tax_minor >= 0),
  total_minor          INTEGER NOT NULL CHECK (total_minor >= 0),
  paid_minor           INTEGER NOT NULL CHECK (paid_minor >= 0),
  balance_due_minor    INTEGER NOT NULL CHECK (balance_due_minor >= 0),
  amount_in_words      TEXT,
  issuer_snapshot_json TEXT    CHECK (issuer_snapshot_json IS NULL
                                      OR (json_valid(issuer_snapshot_json)
                                          AND json_type(issuer_snapshot_json) = 'object')),
  tax_snapshot_json    TEXT    CHECK (tax_snapshot_json IS NULL
                                      OR (json_valid(tax_snapshot_json)
                                          AND json_type(tax_snapshot_json) = 'object')),
  created_by_id        TEXT    NOT NULL CHECK (length(created_by_id) > 0),
  created_by_name      TEXT    NOT NULL CHECK (length(trim(created_by_name)) > 0),
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  finalized_at         TEXT,
  -- The arithmetic the document itself prints, checked by the database.
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (balance_due_minor = total_minor - paid_minor),
  CHECK (paid_minor <= total_minor),
  -- What being FINAL means, as a constraint rather than a convention: a finalized invoice has its
  -- number, its date, its words and its issuer frozen onto it, or it is not final.
  CHECK (
    status = 'draft'
    OR (invoice_number IS NOT NULL
        AND invoice_date IS NOT NULL
        AND amount_in_words IS NOT NULL
        AND length(trim(amount_in_words)) > 0
        AND issuer_snapshot_json IS NOT NULL
        AND finalized_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX invoices_status ON invoices (status, created_at DESC);
CREATE INDEX invoices_number ON invoices (invoice_number DESC);
CREATE INDEX invoices_date ON invoices (invoice_date DESC);

CREATE TABLE invoice_lines (
  id                TEXT    PRIMARY KEY,
  invoice_id        TEXT    NOT NULL REFERENCES invoices (id),
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  -- Free text, always. The operator may write what the catalog has never heard of.
  description       TEXT,
  -- Exactly as printed: "حبة", "كيلو", "كيس (50PCS)". Historical truth, never rewritten.
  unit_label        TEXT,
  -- Present only when a known mapping exists or the operator chose one. Fails CLOSED: a unit added
  -- to BASE_UNITS later is not silently accepted here until a migration says so.
  canonical_unit    TEXT    CHECK (canonical_unit IS NULL OR canonical_unit IN
                        ('piece', 'box', 'pack', 'kg', 'meter', 'other')),
  -- Set when the operator picked an existing product during entry. NOT a foreign key: the invoice
  -- must survive unchanged whatever later happens to the catalog row.
  product_id        TEXT,
  quantity_milli    INTEGER NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 9999000),
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0 AND unit_price_minor <= 922429446630),
  -- The identical half-up rule the sales ledger uses, so the two can never disagree about money.
  line_total_minor  INTEGER NOT NULL
      CHECK (line_total_minor = (quantity_milli * unit_price_minor + 500) / 1000),
  created_at        TEXT    NOT NULL,
  UNIQUE (invoice_id, line_no)
) STRICT;

CREATE INDEX invoice_lines_invoice_id ON invoice_lines (invoice_id, line_no);
CREATE INDEX invoice_lines_product_id ON invoice_lines (product_id) WHERE product_id IS NOT NULL;

-- The catalog review queue. Operational state, NOT a ledger: a row is updated as a person works
-- through it, exactly like cashier_pin_state. The decision it records is what matters, and the
-- decision never alters the finalized invoice it came from.
CREATE TABLE invoice_reconciliation (
  id                   TEXT    PRIMARY KEY,
  invoice_id           TEXT    NOT NULL REFERENCES invoices (id),
  invoice_line_id      TEXT    NOT NULL UNIQUE REFERENCES invoice_lines (id),
  classification       TEXT    NOT NULL CHECK (classification IN
                           ('MATCHED', 'PRICE_DIFFERENCE', 'UNIT_DIFFERENCE', 'DESCRIPTION_DIFFERENCE',
                            'MULTIPLE_DIFFERENCES', 'PRODUCT_NOT_FOUND', 'AMBIGUOUS_MATCH')),
  match_tier           TEXT    NOT NULL CHECK (match_tier IN
                           ('explicit', 'sku', 'name_ar', 'name_en', 'none')),
  matched_product_id   TEXT,
  candidates_json      TEXT    CHECK (candidates_json IS NULL
                                      OR (json_valid(candidates_json)
                                          AND json_type(candidates_json) = 'array')),
  differences_json     TEXT    NOT NULL CHECK (json_valid(differences_json)
                                               AND json_type(differences_json) = 'array'),
  status               TEXT    NOT NULL CHECK (status IN
                           ('PENDING', 'KEPT_CATALOG', 'UPDATED_CATALOG', 'CREATED_PRODUCT',
                            'LINKED_PRODUCT', 'KEPT_INVOICE_ONLY', 'FAILED')),
  selected_fields_json TEXT    CHECK (selected_fields_json IS NULL
                                      OR (json_valid(selected_fields_json)
                                          AND json_type(selected_fields_json) = 'array')),
  resolved_at          TEXT,
  resolution_actor_id   TEXT,
  resolution_actor_name TEXT,
  failure_code         TEXT,
  failure_message      TEXT,
  attempt_count        INTEGER NOT NULL CHECK (attempt_count >= 0),
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  -- A resolved item names who resolved it and when. PENDING and FAILED are the two that still need
  -- a person, and FAILED must say why.
  CHECK (status = 'PENDING' OR status = 'FAILED'
         OR (resolved_at IS NOT NULL AND resolution_actor_id IS NOT NULL)),
  CHECK (status <> 'FAILED' OR failure_code IS NOT NULL)
) STRICT;

CREATE INDEX invoice_reconciliation_status ON invoice_reconciliation (status, created_at DESC);
CREATE INDEX invoice_reconciliation_invoice ON invoice_reconciliation (invoice_id);
CREATE INDEX invoice_reconciliation_class ON invoice_reconciliation (classification, status);

-- ── Immutability, once and only once an invoice is FINAL ────────────────────────────────────────
--
-- A draft is edited freely: that is what a draft is for. These fire on OLD.status = 'final', so the
-- draft -> final transition itself passes, and everything after it does not.
CREATE TRIGGER invoices_final_immutable_update BEFORE UPDATE ON invoices
WHEN OLD.status = 'final'
BEGIN SELECT RAISE(ABORT, 'invoice: a finalized invoice is immutable'); END;

CREATE TRIGGER invoices_final_immutable_delete BEFORE DELETE ON invoices
WHEN OLD.status = 'final'
BEGIN SELECT RAISE(ABORT, 'invoice: a finalized invoice cannot be deleted'); END;

CREATE TRIGGER invoice_lines_final_immutable_update BEFORE UPDATE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) = 'final'
BEGIN SELECT RAISE(ABORT, 'invoice: a finalized invoice line is immutable'); END;

CREATE TRIGGER invoice_lines_final_immutable_delete BEFORE DELETE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) = 'final'
BEGIN SELECT RAISE(ABORT, 'invoice: a finalized invoice line cannot be deleted'); END;

CREATE TRIGGER invoice_lines_closed_invoice BEFORE INSERT ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) = 'final'
BEGIN SELECT RAISE(ABORT, 'invoice: a finalized invoice cannot take new lines'); END;
`,
  },
  {
    version: 7,
    name: "invoice_sales_integration",
    // ── A finalized manual invoice becomes a real sale ───────────────────────────────────────────
    //
    // 🔴 THIS REVERSES A STATED MIGRATION 6 DECISION, and the reversal is the point. Migration 6
    // says, in its own comment, "AN INVOICE IS NOT A SALE, BY DECISION". Field use of the released
    // v6 build (2026-10-09) showed that is not the business behaviour the shop needs: a finalized
    // invoice IS a sale for reporting. Migration 6's source is NOT edited — it is released and its
    // fingerprint must stay identical. The reversal lands here, additively.
    //
    // WHY THIS REBUILDS THREE TABLES INSTEAD OF ADDING COLUMNS. Three things the invoice can express
    // and the v6 ledger cannot, each measured against the real schema rather than assumed:
    //   1. Paid 0 / Balance 100. `sales` has no paid or balance column, and `payment_method` is
    //      NOT NULL over a closed four-value CHECK. SQLite cannot drop or replace either.
    //   2. Tax. `sales` has no tax column and the repository refuses to COMMIT unless
    //      total_minor = subtotal_minor, so a tax-enabled invoice is unrepresentable even when
    //      fully paid.
    //   3. A free-text / PRODUCT_NOT_FOUND line. `sale_lines.product_id` and `sku` are NOT NULL,
    //      and `sale_lines_require_unit` refuses a line without a canonical unit. Forcing an
    //      invoice line through that would mean either inventing a SKU or moving reconciliation
    //      BEFORE finalization. Both are refused: reconciliation stays after finalization.
    //
    // 🔴 WHY ALL THREE AND IN THIS ORDER — `sales` IS NOT A LEAF TABLE. Migration 4 could rebuild
    // `sale_lines` plainly because nothing references it. `sales` is referenced by `voids.sale_id`
    // AND by `sale_lines.sale_id`, and `PRAGMA foreign_keys` is ON (db.ts) while
    // `PRAGMA foreign_keys=OFF` is SILENTLY IGNORED inside a transaction — which the migration
    // runner always is. With foreign keys enforced, DROP TABLE performs an implicit DELETE of every
    // row, so dropping `sales` while another table holds referencing rows is a violation.
    //
    // 🔴 AND `PRAGMA defer_foreign_keys` DOES NOT SOLVE IT, which is the single most important
    // thing to know before editing this migration. The first version of it leaned on exactly that:
    // defer enforcement to COMMIT, by which point the schema is whole again. It is wrong, and it is
    // wrong in a way an EMPTY ledger hides. The implicit DELETE inside DROP TABLE *counts* one
    // deferred violation per referencing child row, and renaming the replacement table into place
    // afterwards never clears that counter — so COMMIT fails with "FOREIGN KEY constraint failed".
    // A fresh database passed every test; a real v3 ledger carrying one sale, its lines and a void
    // failed instantly. Measured, not reasoned.
    //
    // What makes the swap below correct is ORDERING: both new child tables are created pointing at
    // `sales_v7`, so when the three old tables are dropped nothing that survives references them.
    // The pragma is kept because it costs nothing and keeps transient mid-transaction states from
    // failing early, but it is NOT what makes this work. Do not reorder these statements.
    //
    // `voids` is therefore rebuilt too, and for ONE reason only: its foreign key must point at the
    // new parent, and SQLite offers no way to repoint a foreign key in place. Every column, CHECK
    // and constraint in it is copied from migration 1 verbatim — its shape does not change.
    //
    // DROP TABLE does not fire a BEFORE DELETE trigger, so the append-only rule does not block its
    // own replacement — the same fact migration 4 relied on.
    //
    // NOTHING IS INVENTED FOR HISTORICAL ROWS. Every existing sale migrates as source_type='pos',
    // invoice_id=NULL, tax_minor=0, paid_minor=total_minor, balance_due_minor=0,
    // payment_status='paid', and its own payment_method byte for byte. A SQLite column DEFAULT
    // cannot be another column's value, so the backfill is an explicit SELECT, not a default.
    //
    // THE NEW CHECKS ARE DELIBERATELY ABLE TO FAIL AN UPGRADE. `total_minor = subtotal_minor +
    // tax_minor` must hold for every historical row; it does, because the repository has refused to
    // commit anything else since migration 1. If a ledger somewhere violated it, this migration
    // ABORTS and the pre-migration backup plus the v6 database are left untouched. That is the
    // correct outcome: a loud refusal beats silently rewriting money.
    //
    // WHAT IS NOT BUILT HERE, on purpose: no discount, no stock movement, no accounts receivable,
    // no credit note. `sales` stays immutable by trigger, so a balance recorded here can never be
    // "collected" later by an UPDATE — collecting payment is a future feature with its own schema,
    // not a side effect of this one.
    sql: `
PRAGMA defer_foreign_keys = ON;

-- ── sales ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE sales_v7 (
  id                  TEXT    PRIMARY KEY,
  receipt_number      INTEGER NOT NULL UNIQUE CHECK (receipt_number > 0),
  idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_fingerprint TEXT    NOT NULL,
  -- Explicit origin. Never inferred from a string pattern in another column.
  source_type         TEXT    NOT NULL CHECK (source_type IN ('pos', 'invoice')),
  -- The durable link, one direction only. UNIQUE makes a second sale for the same invoice
  -- structurally impossible; SQLite admits many NULLs in a UNIQUE column, so every POS sale is
  -- unaffected. A real foreign key, so the link cannot point at an invoice that does not exist.
  -- There is deliberately NO invoices.sale_id: a finalized invoice is immutable, and a second
  -- physical pointer would have to be written into it after the fact.
  invoice_id          TEXT    UNIQUE REFERENCES invoices (id),
  cashier_id          TEXT    NOT NULL,
  cashier_name        TEXT    NOT NULL,
  currency            TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  subtotal_minor      INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  -- 0 for every POS sale and for a tax-disabled invoice. Copied from the invoice's FROZEN tax,
  -- never recomputed here.
  tax_minor           INTEGER NOT NULL CHECK (tax_minor >= 0),
  total_minor         INTEGER NOT NULL CHECK (total_minor >= 0),
  -- Money actually received against this sale, and what is still owed. Truthful fields, not an
  -- accounts-receivable system: nothing updates them later, because sales are immutable.
  paid_minor          INTEGER NOT NULL CHECK (paid_minor >= 0),
  balance_due_minor   INTEGER NOT NULL CHECK (balance_due_minor >= 0),
  -- 🔴 STATE, not method. 'unpaid' and 'credit' are NOT payment methods and are deliberately
  -- absent from payment_method below.
  payment_status      TEXT    NOT NULL CHECK (payment_status IN ('paid', 'partial', 'unpaid')),
  -- HOW money was received, when it was. NULL means "not recorded", which is the truth for a
  -- manual invoice that captured no method. The four values are unchanged from migration 1.
  payment_method      TEXT    CHECK (payment_method IS NULL
                                     OR payment_method IN ('cash', 'card', 'external', 'other')),
  line_count          INTEGER NOT NULL CHECK (line_count > 0),
  business_date       TEXT    NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  completed_at        TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  -- The arithmetic, checked by the database rather than trusted from a service.
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (paid_minor + balance_due_minor = total_minor),
  -- The status cannot disagree with the money it describes.
  CHECK (
    (payment_status = 'paid'    AND balance_due_minor = 0)
    OR (payment_status = 'unpaid'  AND paid_minor = 0 AND balance_due_minor > 0)
    OR (payment_status = 'partial' AND paid_minor > 0 AND balance_due_minor > 0)
  ),
  -- 🔴 THE POS CONTRACT IS NOT WEAKENED. Only an invoice-origin sale may omit the method.
  CHECK (source_type = 'invoice' OR payment_method IS NOT NULL),
  -- The link exists exactly when the sale came from an invoice, in both directions.
  CHECK ((source_type = 'invoice' AND invoice_id IS NOT NULL)
         OR (source_type = 'pos' AND invoice_id IS NULL))
) STRICT;

INSERT INTO sales_v7 (id, receipt_number, idempotency_key, request_fingerprint, source_type,
                      invoice_id, cashier_id, cashier_name, currency, subtotal_minor, tax_minor,
                      total_minor, paid_minor, balance_due_minor, payment_status, payment_method,
                      line_count, business_date, completed_at, created_at)
SELECT id, receipt_number, idempotency_key, request_fingerprint, 'pos',
       NULL, cashier_id, cashier_name, currency, subtotal_minor, 0,
       total_minor, total_minor, 0, 'paid', payment_method,
       line_count, business_date, completed_at, created_at
  FROM sales;

-- ── sale_lines ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_lines_v7 (
  id                TEXT    PRIMARY KEY,
  -- 🔴 POINTS AT sales_v7 ON PURPOSE, not at "sales". See the swap block below: this is what makes
  -- dropping the old parent legal. The ALTER TABLE RENAME rewrites this reference for us.
  sale_id           TEXT    NOT NULL REFERENCES sales_v7 (id),
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  -- The invoice line this sale line froze, when it came from one. UNIQUE, so one invoice line can
  -- never appear as two sale lines. NULL for every POS line.
  invoice_line_id   TEXT    UNIQUE,
  -- 🔴 NULLABLE FROM HERE ON, and only for an invoice-origin line. A manual invoice may sell
  -- something the catalog has never heard of; the sale_lines_pos_shape trigger below keeps a POS
  -- line exactly as strict as it has always been.
  product_id        TEXT,
  sku               TEXT,
  product_name      TEXT    NOT NULL,
  -- NULL means UNKNOWN. Pre-migration-4 rows are genuinely unknown; an invoice line whose printed
  -- unit maps to no base unit is also genuinely unknown, and is NOT guessed.
  sale_unit         TEXT             CHECK (sale_unit IS NULL OR length(trim(sale_unit)) > 0),
  -- What the paper said, verbatim: "كيس (50PCS)". Historical commercial truth. A later catalog
  -- reconciliation choosing 'pack' for the PRODUCT must never rewrite this.
  unit_label        TEXT             CHECK (unit_label IS NULL OR length(trim(unit_label)) > 0),
  quantity_milli    INTEGER NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 9999000),
  -- 922429446630 = floor((2^63 - 1 - 500) / 9999000), unchanged from migration 4. Above it the
  -- multiplication overflows signed 64-bit and SQLite SILENTLY yields a REAL.
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0 AND unit_price_minor <= 922429446630),
  -- The identical half-up rule as migration 4 and as invoice_lines, so no two of the three can
  -- ever disagree about money.
  line_total_minor  INTEGER NOT NULL
      CHECK (line_total_minor = (quantity_milli * unit_price_minor + 500) / 1000),
  -- Migration 4's rule, kept as a table CHECK (the strongest form) and exempting invoice-origin
  -- rows by a column ON THE ROW, so a till line still faces it in full.
  --
  -- 🔴 WHY THE EXEMPTION EXISTS, and it is not a convenience. domain/invoice.ts's
  -- assertInvoiceQuantity applies NO unit-based restriction, so a finalized invoice may legitimately
  -- read "2.5 حبة" — 2.5 of something whose canonical unit is 'piece'. Without this exemption,
  -- finalizing that invoice would ABORT on this CHECK, and the only ways out would be to drop the
  -- canonical unit, round the quantity, or refuse a document the shop really received. All three
  -- are the silent normalisation this whole feature exists to prevent. The invoice is historical
  -- commercial truth; the fraction rule is a CATALOG rule about what a till may sell.
  CHECK (invoice_line_id IS NOT NULL
         OR sale_unit IS NULL OR sale_unit IN ('kg', 'meter') OR quantity_milli % 1000 = 0),
  UNIQUE (sale_id, line_no)
) STRICT;

INSERT INTO sale_lines_v7 (id, sale_id, line_no, invoice_line_id, product_id, sku, product_name,
                           sale_unit, unit_label, quantity_milli, unit_price_minor, line_total_minor)
SELECT id, sale_id, line_no, NULL, product_id, sku, product_name,
       sale_unit, NULL, quantity_milli, unit_price_minor, line_total_minor
  FROM sale_lines;

-- ── voids: rebuilt only so its foreign key can follow the new parent ──────────────────────────
-- 🔴 ITS SHAPE IS UNCHANGED — every column, CHECK and constraint below is copied from migration 1
-- verbatim. It is rebuilt for ONE reason: its foreign key must point at the new sales table, and
-- SQLite offers no way to repoint a foreign key in place.
CREATE TABLE voids_v7 (
  id              TEXT PRIMARY KEY,
  sale_id         TEXT NOT NULL UNIQUE REFERENCES sales_v7 (id),
  cashier_id      TEXT NOT NULL,
  cashier_name    TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  business_date   TEXT NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at      TEXT NOT NULL
) STRICT;

INSERT INTO voids_v7 (id, sale_id, cashier_id, cashier_name, reason, business_date, created_at)
SELECT id, sale_id, cashier_id, cashier_name, reason, business_date, created_at FROM voids;

-- ── swap ──────────────────────────────────────────────────────────────────────────────────────
-- 🔴 THIS ORDER IS LOAD-BEARING, and it was MEASURED, not reasoned. The first version of this
-- migration dropped the old "sales" while the new children still referenced it by that name and
-- leaned on PRAGMA defer_foreign_keys to settle it at COMMIT. That is wrong, and it fails in a way
-- an empty ledger hides: with foreign keys enforced, DROP TABLE performs an implicit DELETE of
-- every row, which COUNTS one deferred violation per referencing child row — and renaming the
-- replacement table into place afterwards never clears that counter, so COMMIT fails with
-- "FOREIGN KEY constraint failed". A fresh database passed (no rows, no violations); a real v3
-- ledger carrying one sale, its lines and a void failed instantly.
--
-- What makes it correct is that NOTHING references the old tables when they are dropped: both new
-- children were created pointing at "sales_v7", so dropping "voids", then "sale_lines", then
-- "sales" removes three tables that no surviving row points into. ALTER TABLE RENAME then rewrites
-- the children's foreign keys from sales_v7 to sales for us (SQLite >= 3.25, and legacy_alter_table
-- is never set in this app).
DROP TABLE voids;
DROP TABLE sale_lines;
DROP TABLE sales;
ALTER TABLE sales_v7 RENAME TO sales;
ALTER TABLE sale_lines_v7 RENAME TO sale_lines;
ALTER TABLE voids_v7 RENAME TO voids;

CREATE INDEX sales_business_date ON sales (business_date);
CREATE INDEX sale_lines_sale_id ON sale_lines (sale_id);
-- The invoice-origin reads: "show me invoice sales", and the join back to the invoice.
CREATE INDEX sales_source_type ON sales (source_type, completed_at DESC);

-- ── the ledger's immutability, re-established exactly as it was ───────────────────────────────
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

-- 🔴 THE OLD POS LINE CONTRACT, MOVED NOT DROPPED. A table-level CHECK cannot see the parent
-- sale's source_type, so the rule that was NOT NULL + sale_lines_require_unit becomes a
-- source-aware trigger. It replaces sale_lines_require_unit and is STRICTLY STRONGER for a POS
-- line: product, sku, a non-empty name, a unit, and no invoice line id.
CREATE TRIGGER sale_lines_pos_shape BEFORE INSERT ON sale_lines
WHEN (SELECT source_type FROM sales WHERE id = NEW.sale_id) = 'pos'
 AND (NEW.product_id IS NULL
      OR NEW.sku IS NULL
      OR NEW.sale_unit IS NULL
      OR NEW.invoice_line_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ledger: a POS sale line requires its product, sku and unit'); END;

-- 🔴 WHY "IS NULL" AND NOT "IS NULL OR EMPTY", measured rather than preferred. The first version of
-- this trigger also refused an empty sku, and that BROKE A FIELD-PROVEN RULE: domain/cart.ts has
-- snapshotted sku = "" for a product that has no SKU since Gate 1, deliberately, because
-- sale_lines.sku was NOT NULL. Two existing tests caught it immediately. NOT NULL is exactly what
-- the old contract said, so NOT NULL is exactly what this trigger says — no more. The two kinds of
-- absence now both exist and mean different things: "" is a POS product with no SKU, NULL is an
-- invoice line the catalog does not have at all.

-- An invoice-origin line must name the invoice line it froze, and must still carry a real
-- description. Everything else about it may legitimately be unknown.
CREATE TRIGGER sale_lines_invoice_shape BEFORE INSERT ON sale_lines
WHEN (SELECT source_type FROM sales WHERE id = NEW.sale_id) = 'invoice'
 AND (NEW.invoice_line_id IS NULL OR length(trim(NEW.product_name)) = 0)
BEGIN SELECT RAISE(ABORT, 'ledger: an invoice-origin sale line must name its invoice line and description'); END;

-- Restored byte for byte from migration 1, because the rebuild dropped them with their table.
CREATE TRIGGER voids_immutable_update BEFORE UPDATE ON voids
BEGIN SELECT RAISE(ABORT, 'ledger: voids are immutable'); END;
CREATE TRIGGER voids_immutable_delete BEFORE DELETE ON voids
BEGIN SELECT RAISE(ABORT, 'ledger: voids cannot be deleted'); END;
`,
  },
  {
    version: 8,
    name: "operator_accounts",
    // ── Real operator accounts, and the audit vocabulary to describe managing them ───────────────
    //
    // 🔴 WHAT WAS WRONG. There was no operator table at all. `FIXTURE_CASHIERS` — a frozen
    // TypeScript array in src/fixtures/cashiers.ts, whose own header says "NOT real accounts" —
    // WAS the account store, so the shop ran on two accounts named "Cashier One" and "Cashier Two"
    // whose PINs are 1111 and 2222 and are published in this repository. Changing a name or a PIN
    // meant editing source, rebuilding and reinstalling.
    //
    // WHY THE LEDGER IS NOT TOUCHED, measured rather than assumed. `sales.cashier_id`,
    // `sales.cashier_name`, `voids.cashier_id` and `voids.cashier_name` are plain TEXT NOT NULL
    // with NO REFERENCES: every sale carries its own cashier SNAPSHOT, the same discipline that
    // already stops a renamed product from altering a past sale. So there is no backfill, no
    // foreign key added to any ledger table, and the old ids stay meaningful because they are
    // PRESERVED here — not because anything points at a row.
    //
    // 🔴 WHY audit_events IS REBUILT AND NOT ALTERED. Three of its constraints name `event_type`
    // or `entity_type` — the column CHECK, the entity_type CHECK, and the pairing CHECK — and
    // SQLite cannot alter a CHECK in place.
    //
    // AND WHY THAT IS THE CHEAP KIND OF REBUILD. `audit_events` is a LEAF table: nothing anywhere
    // REFERENCES it (checked). So this is migration 4's plain create-copy-drop-rename, NOT
    // migration 7's problem — there is no child table whose rows make DROP TABLE count deferred
    // foreign-key violations, which is the trap that passed on an empty database and failed
    // instantly on a real v3 ledger. No `defer_foreign_keys` pragma is needed and none is used.
    //
    // DROP TABLE does not fire a BEFORE DELETE trigger, so the append-only rule does not block its
    // own table's replacement — the same fact migrations 4 and 7 both relied on. The indexes and
    // triggers are recreated AFTER the copy, so `audit_events_seq_monotonic` does not fire once per
    // historical row on the way in.
    //
    // NOTHING IS TRANSFORMED. `INSERT INTO ... SELECT *` with no expression, so every historical
    // row crosses byte for byte. The new CHECKs therefore cannot fail the upgrade: every existing
    // row is 'product' or 'catalog', and those two branches are unchanged. If one somehow were
    // not, this migration ABORTS and the pre-migration backup plus the v7 database are untouched.
    //
    // 🔴 actor_tier IS NOT BACKFILLED. Every historical row stays 'unspecified', exactly as
    // src/domain/audit.ts promised when it chose that value: writing a tier the application could
    // not have known would be a permanent lie on an append-only trail. Real tiers begin
    // PROSPECTIVELY. History will contain a visible boundary and that is the truthful outcome.
    //
    // 🔴 TWO ROLES IN THE PRODUCT: OWNER IS THE ADMINISTRATOR, CASHIER IS THE EMPLOYEE. Confirmed
    // 2026-10-10. There is no separate Admin account type.
    //
    // The CHECK admits 'admin' as a RESERVED, UNUSED value, and it stays only because it is already
    // here: a CHECK cannot be widened without rebuilding this table, and rebuilding it merely to
    // remove a value nothing writes would add risk for no gain. The application refuses it at the
    // IPC boundary AND in the service, bootstrap never assigns it, and no v1 path writes
    // actor_tier='admin'. A hand-edited 'admin' row is not an owner — the guard asks whether the
    // role IS owner, never whether it is cashier — so it fails closed rather than falling into a
    // gap. Asserted in tests/main/channelPolicy.test.ts.
    //
    // 🔴 ROLLBACK CHANGES MEANING WITH THIS MIGRATION, and it is the first time in this product's
    // history. Every installer up to b18b5b4 is schema v7, so rolling back meant reinstalling an
    // EXE. A v7 build opening a v8 database raises SchemaNewerThanAppError and refuses. So:
    // rollback from v8 is RESTORE THE PRE-MIGRATION BACKUP, then install the v7 EXE. Reinstalling
    // the old EXE alone is NOT a rollback. Worse, if an operator completes PIN setup on v8 and a
    // v7 build is then run against an un-restored database, that build reads its hashes from
    // FIXTURE_CASHIERS — so 1111 would authenticate again and the newly set PIN would not exist in
    // its account model. The pre-migration backup is the only coherent rollback boundary.
    sql: `
-- ── Operators ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE operators (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  role           TEXT    NOT NULL CHECK (role IN ('owner', 'admin', 'cashier')),
  -- scrypt, per-operator salt, hex. Shaped exactly like the fixture's own fields, so the two
  -- migrated accounts need no re-hashing and no plaintext PIN exists at any point.
  pin_salt_hex   TEXT    NOT NULL CHECK (length(pin_salt_hex) BETWEEN 16 AND 64),
  pin_hash_hex   TEXT    NOT NULL CHECK (length(pin_hash_hex) = 64),
  -- 1 means the stored PIN is a LEGACY BOOTSTRAP credential: it authenticates ONLY into mandatory
  -- setup and is replaced there. It is not a "change your password soon" nag.
  must_reset_pin INTEGER NOT NULL CHECK (must_reset_pin IN (0, 1)),
  is_active      INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;

-- Two operators must not share a name: an audit row naming "أحمد" has to identify one person.
CREATE UNIQUE INDEX operators_name ON operators (name);
CREATE INDEX operators_active ON operators (is_active, role);

-- The two fixture accounts become real rows, KEEPING THEIR IDS so every historical
-- sales.cashier_id, voids.cashier_id and cashier_pin_state.cashier_id stays resolvable.
--
-- The hashes are carried across as bootstrap credentials with must_reset_pin = 1 — not because
-- they are good (they are 1111 and 2222, in a public repository) but because an upgrade must not
-- lock a shop out of its own terminal. They authenticate into setup and nothing else.
--
-- The literals are written HERE rather than read from the fixture at runtime: a migration's SQL is
-- fingerprinted and must mean the same thing for ever, and a TypeScript constant can be edited.
INSERT INTO operators (id, name, role, pin_salt_hex, pin_hash_hex, must_reset_pin, is_active,
                       created_at, updated_at)
SELECT 'cashier-01', 'Cashier One', 'owner',
       'a1f3c9e27b4d6058', 'a8f8c45b97712daec733a8b4d198ac96376c05697b5935a7b30f965e27478bce',
       1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
UNION ALL
SELECT 'cashier-02', 'Cashier Two', 'cashier',
       '5c8e01d7f9a3b264', '0ca57b50d33e8f2f395a2a636e8babd96c096120e439cc069d17a6586fb90537',
       1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- ── audit_events, rebuilt to widen three CHECKs ───────────────────────────────────────────────
CREATE TABLE audit_events_v8 (
  id             TEXT    PRIMARY KEY,
  seq            INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  event_type     TEXT    NOT NULL CHECK (event_type IN
                   ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED',
                    'PRODUCT_DEACTIVATED', 'CATALOG_IMPORTED',
                    'OPERATOR_CREATED', 'OPERATOR_RENAMED', 'OPERATOR_PIN_RESET',
                    'OPERATOR_ACTIVATED', 'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED')),
  entity_type    TEXT    NOT NULL CHECK (entity_type IN ('product', 'catalog', 'operator')),
  entity_id      TEXT    NOT NULL CHECK (length(entity_id) > 0),
  actor_id       TEXT    NOT NULL CHECK (length(actor_id) > 0),
  actor_name     TEXT    NOT NULL CHECK (length(trim(actor_name)) > 0),
  actor_tier     TEXT    NOT NULL CHECK (actor_tier IN
                   ('owner', 'admin', 'cashier', 'system', 'unspecified')),
  occurred_at    TEXT    NOT NULL CHECK (occurred_at GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  business_date  TEXT    NOT NULL CHECK (business_date GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_json   TEXT    NOT NULL CHECK (json_valid(changed_json)
                                         AND json_type(changed_json) = 'object'),
  metadata_json  TEXT             CHECK (metadata_json IS NULL
                                         OR (json_valid(metadata_json)
                                             AND json_type(metadata_json) = 'object')),
  app_version    TEXT    NOT NULL CHECK (length(app_version) > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  -- The pairing, extended with the operator branch. A product event may only describe a product,
  -- an import only the catalog, and an operator event only an operator. The same pairing is
  -- enforced in src/domain/audit.ts; this is the backstop no code path can talk past.
  CHECK (
    (entity_type = 'product' AND event_type IN
       ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED'))
    OR (entity_type = 'catalog' AND event_type = 'CATALOG_IMPORTED')
    OR (entity_type = 'operator' AND event_type IN
       ('OPERATOR_CREATED', 'OPERATOR_RENAMED', 'OPERATOR_PIN_RESET',
        'OPERATOR_ACTIVATED', 'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED'))
  )
) STRICT;

-- Byte for byte, in seq order. No expression, nothing invented, nothing dropped.
INSERT INTO audit_events_v8 SELECT * FROM audit_events ORDER BY seq;

DROP TABLE audit_events;
ALTER TABLE audit_events_v8 RENAME TO audit_events;

CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, seq DESC);
CREATE INDEX audit_events_type   ON audit_events (event_type, seq DESC);
CREATE INDEX audit_events_actor  ON audit_events (actor_id, seq DESC);
CREATE INDEX audit_events_date   ON audit_events (business_date, seq DESC);

CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: the audit trail is append-only'); END;
CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: audit events cannot be deleted'); END;
CREATE TRIGGER audit_events_seq_monotonic BEFORE INSERT ON audit_events
WHEN NEW.seq <= coalesce((SELECT max(seq) FROM audit_events), 0)
BEGIN SELECT RAISE(ABORT, 'audit: seq must be monotonic'); END;
`,
  },
];
