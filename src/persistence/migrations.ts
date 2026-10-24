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
    // 🔴 THIS MIGRATION WAS REVISED BEFORE IT SHIPPED, AND THE FINGERPRINT CHANGED WITH IT.
    // Authorised 2026-10-11, while v8 was still unmerged and no installer carrying it had ever
    // reached a shop: migrations 1-7 are released and untouchable, this one was not yet. The
    // revision adds `terminal_security_state` and is a SECURITY fix, not a tidy-up — the first
    // draft had only `must_reset_pin`, and the ownership ceremony deduced the terminal's state from
    // the shape of the operator rows. A fourth independent review falsified that deduction by
    // execution. Preserving the old fingerprint by appending a migration 9 instead would have left
    // the broken schema contract in the file as the thing v8 means. The old fingerprint
    // (530e891e…b318c) is NOT valid for this migration any more, and every gate taken against it
    // was re-run rather than carried forward.
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

-- ── The terminal's own ownership state ────────────────────────────────────────────────────────
--
-- 🔴 TWO QUESTIONS, TWO COLUMNS. The first build of this migration had only must_reset_pin, and
-- the ceremony INFERRED the terminal's state from combinations of it ("no operator holds a
-- credential they chose themselves"). An independent review proved that inference wrong by
-- execution: with two owners, an owner who reset a colleague's PIN and then their own re-armed the
-- bootstrap ceremony, and the exemption went to the LOWEST id rather than to the person acting —
-- so the acting owner was refused their own setup screen and the only way back in was to sign in
-- as the colleague. An account fact was being read as a terminal fact.
--
--   must_reset_pin   does THIS PERSON still need to choose a private credential?
--   terminal_claimed has THIS TERMINAL already been claimed by its real owner?
--
-- Neither is ever inferred from the other again.
--
-- A SINGLETON TABLE rather than a row in company_profile, measured and not assumed:
-- company_profile is live settings the owner edits from a form (name, tax, logo, invoice
-- numbering), so a settings write path could clear a security invariant. This table has no UI, no
-- update path outside the claim transaction, and no DELETE path at all.
--
-- The CHECK makes the singleton structural — one row, for ever — so "which row is authoritative"
-- is not a question the application can get wrong.
CREATE TABLE terminal_security_state (
  id                     TEXT    PRIMARY KEY CHECK (id = 'terminal'),
  -- 0 = never claimed. The install/upgrade ownership ceremony is armed and ONLY the seeded
  -- bootstrap owner may enter it. 1 = claimed; the ceremony is over and cannot be re-armed by any
  -- operator or account lifecycle action.
  terminal_claimed       INTEGER NOT NULL CHECK (terminal_claimed IN (0, 1)),
  -- Both NULL until the claim, and both written in the same transaction that sets the flag.
  claimed_at             TEXT             CHECK (claimed_at IS NULL OR claimed_at GLOB
                           '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Deliberately NOT a foreign key into operators: this records WHO claimed the terminal as a
  -- snapshot, the same discipline the ledger already uses for sales.cashier_id. Deactivating or
  -- renaming that operator later must not be able to touch the terminal's history.
  claimed_by_operator_id TEXT             CHECK (claimed_by_operator_id IS NULL
                                                 OR length(claimed_by_operator_id) > 0),
  -- The two nullable columns travel together: claimed means both are known, unclaimed means
  -- neither is. A half-written claim is not representable.
  CHECK ((terminal_claimed = 1 AND claimed_at IS NOT NULL AND claimed_by_operator_id IS NOT NULL)
         OR (terminal_claimed = 0 AND claimed_at IS NULL AND claimed_by_operator_id IS NULL))
) STRICT;

-- 🔴 UNCLAIMED ON BOTH PATHS, and this is the whole point of seeding it here rather than lazily in
-- code: a fresh v8 install and a real v7 -> v8 upgrade arrive at the identical state. An absent row
-- would have to be interpreted, and interpreting absence is how the first defect happened.
INSERT INTO terminal_security_state (id, terminal_claimed, claimed_at, claimed_by_operator_id)
VALUES ('terminal', 0, NULL, NULL);

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
  {
    version: 9,
    name: "product_master",
    // ── Product Master: the catalog becomes the shop's own product record ───────────────────────
    //
    // 🔴 WHAT WAS WRONG. `catalog_products` carried only what a 7-column import file could say:
    // names, SKU, price, unit, active. A merchant could not record what the product IS — no
    // category, no brand, no description, no photo — so the shop's own knowledge of its own
    // products lived in the owner's head, and an online catalog had nothing to export.
    //
    // 🔴 WHY THIS IS ONE MIGRATION AND NOT THREE. The approved architecture proposed M9 categories,
    // M10 online content, M11 images. Its own rollback paragraph is the argument against that
    // split: SQLite on this project's pinned path cannot drop a column without a table rebuild, so
    // rollback for every one of them is the same automatic pre-migration snapshot. Three
    // migrations therefore buy ZERO additional rollback granularity, while costing three
    // fingerprints, three populated-prior-schema upgrade tests and three seams — for one feature,
    // behind one form, that is never shipped partially. Migration 7's lesson was one commit
    // carrying five UNRELATED things; category, online content and the primary image are one.
    //
    // EVERYTHING HERE IS ADDITIVE. Two CREATE TABLEs and five ADD COLUMNs. No table is rebuilt, no
    // row is rewritten, no backfill runs, and no released migration is touched. `catalog_products`
    // is referenced by nothing — sale lines and invoice lines carry their own snapshots, which is
    // the discipline that makes this safe — so ADD COLUMN on a STRICT table suffices.
    //
    // 🔴 AND EVERY NEW COLUMN IS NULLABLE OR DEFAULTED, because the shop's existing products must
    // keep selling the moment this migration lands. A product with no category, no brand, no
    // description and no photo is a perfectly valid product for the till. Online content is
    // enrichment, never a precondition for trade.
    //
    // 🔴 BARCODE IS IN, approved 2026-10-11 while this migration was still unmerged. It is one
    // additive column and one partial index on a table this migration is already touching, so it
    // rides here rather than becoming a migration 10 for a single adjacent Product Master field.
    // The fingerprint changed again with it, and the previous v9 value is not preserved as if it
    // had been released — it never was.
    //
    // WHAT IS DELIBERATELY ABSENT: stock quantity, warehouses, suppliers, purchase accounting,
    // a category TREE, a photo GALLERY, MULTIPLE barcodes per product, and specifications. Each is
    // either a separate business domain or an unapproved phase. The image table's shape admits a
    // future gallery without any of its UX existing now, and barcode's single column admits a
    // child table later the same way.
    sql: `
-- ── Categories ────────────────────────────────────────────────────────────────────────────────
--
-- FLAT and owner-managed. No parent_id: a tree is not approved, and adding one later is an
-- additive column on a table nothing references, which is exactly the position this table is in.
--
-- Names are compared case- and whitespace-insensitively by a UNIQUE INDEX below rather than by a
-- CHECK, so "عدد" and " عدد " cannot both exist. The shop is Arabic-first, so name_ar is the
-- required one and name_en is optional, matching the rule catalog naming already follows.
CREATE TABLE catalog_categories (
  id         TEXT    PRIMARY KEY,
  name_ar    TEXT    NOT NULL CHECK (length(trim(name_ar)) > 0),
  name_en    TEXT             CHECK (name_en IS NULL OR length(trim(name_en)) > 0),
  -- Deactivated rather than deleted once a product has ever used it: the product keeps its link,
  -- the owner stops being offered the category. Deletion is allowed ONLY while unused, which the
  -- service enforces by counting referencing products inside the same transaction.
  is_active  INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  -- The owner's own display order. Not alphabetical: a hardware shop thinks "عدد" before "دهان".
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX catalog_categories_name_ar ON catalog_categories (lower(trim(name_ar)));
CREATE INDEX catalog_categories_order ON catalog_categories (is_active, sort_order, id);

-- ── Product Master columns ────────────────────────────────────────────────────────────────────
--
-- 🔴 ON DELETE SET NULL, chosen deliberately over RESTRICT. A category the owner is allowed to
-- delete is one no product uses, so this clause should never fire; if a future path ever deletes a
-- used category anyway, a product that loses its category is a product that still sells, whereas
-- RESTRICT would abort a transaction the owner cannot diagnose from the till. The service refuses
-- the delete first; this is the floor under it, not the rule.
ALTER TABLE catalog_products ADD COLUMN category_id TEXT REFERENCES catalog_categories(id) ON DELETE SET NULL;

-- The barcode the manufacturer printed on the box. SEPARATE FROM SKU, and that separation is the
-- point: SKU is what the shop calls the product, barcode is what the world calls it. One shop's
-- SKU-1 is another's; a barcode is global, so it is the field a website and a scanner both key on.
--
-- NULLABLE, because most of this shop's stock is building material sold loose and carries no
-- barcode at all. Unique only WHEN PRESENT, by the partial index below, exactly as sku already is.
--
-- 🔴 STORED CANONICAL. src/domain/barcode.ts owns the one normalization contract: a 12-digit UPC-A
-- is stored as its 13-digit EAN-13 form, because they are THE SAME SYMBOL and a shop that stored
-- both would have two products for one box. That equivalence was found by execution during the
-- mobile-LAN study, when the decoder read back a typed UPC-A as a zero-prefixed EAN-13.
--
-- V1 IS ONE BARCODE PER PRODUCT. A product with several (a box and its singles) needs a child
-- table, which is a real shop requirement nobody has yet reported; one column is the truthful V1.
ALTER TABLE catalog_products ADD COLUMN barcode TEXT;

-- Free text with suggestions drawn from what the shop has already typed, per the approved study: a
-- normalized brands table was measured and rejected as weight this product cannot yet justify.
ALTER TABLE catalog_products ADD COLUMN brand TEXT;

-- ONE description per language. The earlier draft had short + long per language, which the study
-- revised: four fields invite three of them to be stale, and nothing in V1 renders two lengths.
ALTER TABLE catalog_products ADD COLUMN description_ar TEXT;
ALTER TABLE catalog_products ADD COLUMN description_en TEXT;

-- 🔴 DEFAULT 0 — every existing product is OFF the website until the owner says otherwise.
-- Opting a shop's whole catalog into publication by migration would be a decision made for them.
ALTER TABLE catalog_products ADD COLUMN is_online_visible INTEGER NOT NULL DEFAULT 0;

-- Shaped exactly like catalog_products_sku, deliberately. Two honest reasons, and one that is NOT
-- a reason: SQLite treats NULLs as distinct in a PLAIN unique index as well (measured), so the
-- WHERE clause is not what makes "unique when present" work. What it does is keep the index to the
-- rows that actually have a barcode -- most of this catalog will not -- and say the intent in the
-- schema where a reader meets it.
CREATE UNIQUE INDEX catalog_products_barcode ON catalog_products (barcode) WHERE barcode IS NOT NULL;

CREATE INDEX catalog_products_category ON catalog_products (category_id);
CREATE INDEX catalog_products_online ON catalog_products (is_online_visible, is_active);

-- ── Product images ────────────────────────────────────────────────────────────────────────────
--
-- 🔴 A CHILD TABLE, NOT COLUMNS ON catalog_products, and this is the one shape decision that is
-- load-bearing rather than tidy. listProducts selects from catalog_products directly to render
-- the products list; a BLOB column there means every list render reads every photo. Measured on
-- the real repository: listAll() has no column list narrow enough to avoid it.
--
-- Bytes live in SQLite so the EXISTING backup contract already covers them — VACUUM INTO copies
-- the database, and a photo stored beside it in the filesystem would be the frozen-logo gap again,
-- at the scale of a whole catalog. Nothing stores the merchant's original Desktop path: the file
-- they picked may be deleted the moment after import without affecting the product.
--
-- V1 SUPPORTS ONE PRIMARY IMAGE. The table admits many rows per product so a gallery needs no
-- migration later, and is_primary with its partial UNIQUE index makes "the one current image"
-- a fact the schema enforces rather than a convention the service remembers.
CREATE TABLE catalog_product_images (
  id           TEXT    PRIMARY KEY,
  product_id   TEXT    NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  -- The real bytes, already normalized by the application (resized and re-encoded) before arrival.
  bytes        BLOB    NOT NULL CHECK (length(bytes) > 0),
  mime         TEXT    NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
  -- SHA-256 of bytes, lower-case hex. The export contract verifies the file it writes against
  -- this, so a silent corruption between database and website cannot pass unnoticed.
  sha256_hex   TEXT    NOT NULL CHECK (length(sha256_hex) = 64
                                       AND sha256_hex = lower(sha256_hex)),
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0),
  width_px     INTEGER NOT NULL CHECK (width_px > 0),
  height_px    INTEGER NOT NULL CHECK (height_px > 0),
  -- 1 for the product's current image. The index below permits exactly one per product.
  is_primary   INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  -- How it arrived, so a support question has an answer: 'desktop' or 'phone'.
  origin       TEXT    NOT NULL CHECK (origin IN ('desktop', 'phone')),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX catalog_product_images_primary
  ON catalog_product_images (product_id) WHERE is_primary = 1;
CREATE INDEX catalog_product_images_product ON catalog_product_images (product_id);
`,
  },
  {
    version: 10,
    name: "product_master_audit",
    // ════════════════════════════════════════════════════════════════════════════════════════════
    // Migration 10 — the durable trail learns about categories and product photos.
    //
    // 🔴 WHY A WHOLE MIGRATION FOR AN AUDIT VOCABULARY. Migration 9 gave the shop categories and
    // product photos, and migration 9 could not audit them: three of audit_events' CHECKs
    // ENUMERATE the event and entity types, so a CATEGORY_RENAMED row is refused by the database
    // itself, not by a missing feature. Widening an enumerated CHECK in SQLite means rebuilding the
    // table — ALTER TABLE cannot change one — and migration 9 is purely additive by assertion
    // (migration9.test.ts asserts it contains no DROP TABLE, no INSERT INTO, and never names
    // audit_events at all). So this is its own migration, and migrations 8 and 9 are untouched.
    //
    // 🔴 NOTHING ELSE IS IN HERE. No new table, no new column on any business table, no backfill.
    // Slice D shipped the category and photo channels WITHOUT audit rows precisely so that this
    // decision could be taken deliberately rather than smuggled into migration 9's fingerprint.
    //
    // THIS IS MIGRATION 8'S REBUILD, REUSED — the same table, the same reasoning, the same order:
    //
    //   audit_events is a LEAF table. Nothing references it, so DROP TABLE costs no dependent rows
    //   and no deferred constraint — which is what made migration 7's rebuild expensive and makes
    //   this one cheap.
    //
    //   DROP TABLE does not fire a BEFORE DELETE trigger, so the append-only trigger does not block
    //   it. The copy is one INSERT ... SELECT * in seq order, with no expression anywhere in it:
    //   every historical row keeps its id, its seq, its actor, its timestamps, its changed_json and
    //   its app_version and schema_version EXACTLY. Nothing is normalised on the way through.
    //
    //   The triggers are recreated AFTER the copy, so audit_events_seq_monotonic does not fire once
    //   per copied row and refuse the whole migration.
    // ════════════════════════════════════════════════════════════════════════════════════════════
    sql: `
CREATE TABLE audit_events_v10 (
  id             TEXT    PRIMARY KEY,
  seq            INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  event_type     TEXT    NOT NULL CHECK (event_type IN
                   ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED',
                    'PRODUCT_DEACTIVATED', 'CATALOG_IMPORTED',
                    'OPERATOR_CREATED', 'OPERATOR_RENAMED', 'OPERATOR_PIN_RESET',
                    'OPERATOR_ACTIVATED', 'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED',
                    'CATEGORY_CREATED', 'CATEGORY_RENAMED', 'CATEGORY_ACTIVATED',
                    'CATEGORY_DEACTIVATED', 'CATEGORY_DELETED',
                    'PRODUCT_IMAGE_SET', 'PRODUCT_IMAGE_REPLACED', 'PRODUCT_IMAGE_REMOVED')),
  entity_type    TEXT    NOT NULL CHECK (entity_type IN
                   ('product', 'catalog', 'operator', 'category', 'product_image')),
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
  -- The pairing, extended with two branches. A category event may only describe a category and a
  -- photo event only a product's photo. The same pairing is enforced in src/domain/audit.ts; this
  -- is the backstop no code path can talk past.
  --
  -- Note which entity a PRODUCT_IMAGE_* event names: the PRODUCT, not the image row. What an owner
  -- asks months later is "what happened to this product's photo", and an image id that has since
  -- been replaced is not something anyone can look up. The image ids travel inside changed_json.
  CHECK (
    (entity_type = 'product' AND event_type IN
       ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED'))
    OR (entity_type = 'catalog' AND event_type = 'CATALOG_IMPORTED')
    OR (entity_type = 'operator' AND event_type IN
       ('OPERATOR_CREATED', 'OPERATOR_RENAMED', 'OPERATOR_PIN_RESET',
        'OPERATOR_ACTIVATED', 'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED'))
    OR (entity_type = 'category' AND event_type IN
       ('CATEGORY_CREATED', 'CATEGORY_RENAMED', 'CATEGORY_ACTIVATED',
        'CATEGORY_DEACTIVATED', 'CATEGORY_DELETED'))
    OR (entity_type = 'product_image' AND event_type IN
       ('PRODUCT_IMAGE_SET', 'PRODUCT_IMAGE_REPLACED', 'PRODUCT_IMAGE_REMOVED'))
  )
) STRICT;

-- Byte for byte, in seq order. No expression, nothing invented, nothing dropped.
INSERT INTO audit_events_v10 SELECT * FROM audit_events ORDER BY seq;

DROP TABLE audit_events;
ALTER TABLE audit_events_v10 RENAME TO audit_events;

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
  {
    version: 11,
    name: "operator_product_create_capability",
    // ════════════════════════════════════════════════════════════════════════════════════════════
    // Migration 11 — one cashier may be allowed to create products, durably.
    //
    // 🔴 WHY A COLUMN AND NOT A CHECK IN CODE. The requirement is that ONE named employee may add
    // new products while every other cashier may not. Nothing in the schema could express that:
    // `operators` carries id, name, role and credentials, and authorization read `role` alone. The
    // three ways to get there without a migration were each measured and each refused:
    //
    //   by display name   — `renameOperator` exists, so the permission would survive until someone
    //                       corrected a spelling. A capability that a typo can revoke is not one.
    //   by operator id    — `cashier-02` is a literal seeded by migration 8, but every operator
    //                       created since gets a `randomUUID`. Hard-coding it would grant the
    //                       capability to whoever happens to hold that row in any install, and
    //                       silently deny it to the real second cashier hired next month.
    //   by a new role     — `role` carries a CHECK constraint, so adding a value is a table
    //                       rebuild. That is this migration either way, and it would make the
    //                       capability a RANK rather than a permission: every future narrow grant
    //                       would need another role, and the role would imply authority nobody
    //                       asked to give.
    //
    // So it is a per-operator boolean, defaulting to 0. An existing cashier gains nothing by
    // upgrading — the default is the refusal, and the grant is an act an owner performs on the
    // record, not a side effect of installing a build.
    //
    // 🔴 THE OWNER DOES NOT USE THIS COLUMN. An owner's authority comes from `role = 'owner'` and
    // is unchanged by anything here; the flag is read only when deciding whether a NON-owner may
    // create. Storing it for the owner too (rather than a separate table keyed to cashiers) keeps
    // one row per person and no join, and an owner row's value is simply never consulted.
    //
    // 🔴 AND THE AUDIT LEARNS THE ACT. A permission grant is exactly the kind of thing an owner
    // needs to be able to ask about months later — "who allowed him to add products, and when" —
    // and `audit_events.event_type` is a CHECK, so the vocabulary has to be extended for the event
    // to be recordable at all. Reusing OPERATOR_ROLE_CHANGED was rejected: the role did not
    // change, and an audit row that misnames what happened is worse than no row, because it will
    // be believed. Two events, because granting and revoking are different acts and a reader
    // should not have to open the payload to tell them apart.
    //
    // The rebuild follows migration 10's own pattern exactly: new table, INSERT ... SELECT * in
    // seq order with no expression anywhere, drop, rename, then the indexes and triggers AFTER the
    // copy so `audit_events_seq_monotonic` does not fire once per historical row and refuse the
    // whole migration.
    // ════════════════════════════════════════════════════════════════════════════════════════════
    sql: `
-- A capability, per operator, defaulting to REFUSED. Constant default, so SQLite rewrites no row.
ALTER TABLE operators ADD COLUMN may_create_products INTEGER NOT NULL DEFAULT 0
  CHECK (may_create_products IN (0, 1));

CREATE TABLE audit_events_v11 (
  id             TEXT    PRIMARY KEY,
  seq            INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  event_type     TEXT    NOT NULL CHECK (event_type IN
                   ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED',
                    'PRODUCT_DEACTIVATED', 'CATALOG_IMPORTED',
                    'OPERATOR_CREATED', 'OPERATOR_RENAMED', 'OPERATOR_PIN_RESET',
                    'OPERATOR_ACTIVATED', 'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED',
                    'OPERATOR_PRODUCT_CREATE_GRANTED', 'OPERATOR_PRODUCT_CREATE_REVOKED',
                    'CATEGORY_CREATED', 'CATEGORY_RENAMED', 'CATEGORY_ACTIVATED',
                    'CATEGORY_DEACTIVATED', 'CATEGORY_DELETED',
                    'PRODUCT_IMAGE_SET', 'PRODUCT_IMAGE_REPLACED', 'PRODUCT_IMAGE_REMOVED')),
  entity_type    TEXT    NOT NULL CHECK (entity_type IN
                   ('product', 'catalog', 'operator', 'category', 'product_image')),
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
  -- The pairing, with the two new events landing on 'operator' where they belong: the thing that
  -- changed is the PERSON's standing permission, not a product.
  CHECK (
    (entity_type = 'product' AND event_type IN
       ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED'))
    OR (entity_type = 'catalog' AND event_type = 'CATALOG_IMPORTED')
    OR (entity_type = 'operator' AND event_type IN
       ('OPERATOR_CREATED', 'OPERATOR_RENAMED', 'OPERATOR_PIN_RESET',
        'OPERATOR_ACTIVATED', 'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED',
        'OPERATOR_PRODUCT_CREATE_GRANTED', 'OPERATOR_PRODUCT_CREATE_REVOKED'))
    OR (entity_type = 'category' AND event_type IN
       ('CATEGORY_CREATED', 'CATEGORY_RENAMED', 'CATEGORY_ACTIVATED',
        'CATEGORY_DEACTIVATED', 'CATEGORY_DELETED'))
    OR (entity_type = 'product_image' AND event_type IN
       ('PRODUCT_IMAGE_SET', 'PRODUCT_IMAGE_REPLACED', 'PRODUCT_IMAGE_REMOVED'))
  )
) STRICT;

-- Byte for byte, in seq order. No expression, nothing invented, nothing dropped.
INSERT INTO audit_events_v11 SELECT * FROM audit_events ORDER BY seq;

DROP TABLE audit_events;
ALTER TABLE audit_events_v11 RENAME TO audit_events;

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
  {
    version: 12,
    name: "party_identity",
    // ════════════════════════════════════════════════════════════════════════════════════════════
    // Migration 12 — WHO the shop owes and who owes the shop. Identity only.
    //
    // Purely ADDITIVE: two new tables, their indexes and their triggers. Migrations 1-11 are not
    // touched, no existing table is rebuilt, no existing column changes, and NOTHING is
    // synthesized — a migrated ledger has zero parties and zero contact history, which is the
    // honest state of a shop that has not named a customer yet.
    //
    // 🔴 IDENTITY, AND DELIBERATELY NOT ACCOUNTING. There is no balance column, no currency, no
    // opening figure and no total anywhere below, and that is the point rather than an omission. A
    // stored balance is a second source of truth that drifts away from the rows it summarizes; the
    // approved design derives every balance from auditable postings, and those postings
    // (obligations, settlements, adjustments) are a LATER slice with their own authorization. A
    // directory that quietly grew a `balance_minor` column would have pre-decided that design.
    //
    // 🔴 TWO KINDS IN ONE TABLE, AND A MERCHANT MAY BE BOTH — AS TWO ROWS. `kind` is on the row,
    // not on a flag, so a hardware shop that both buys from and sells to the same trader holds two
    // parties with two ids. Receivables and payables therefore cannot be mixed by accident: a
    // future obligation names one party id, and that id already carries its side of the ledger.
    // One row with two roles would have made "what does he owe me" ambiguous forever.
    //
    // 🔴 THE NAME IS NOT UNIQUE, AND THIS DIVERGES FROM `catalog_categories` ON PURPOSE. Category
    // names are unique because two categories called "دهان" are a data-entry mistake. Two
    // CUSTOMERS called "محمد علي" are two real people, and a UNIQUE index would refuse the second
    // one — forcing the operator to invent "محمد علي 2" or, worse, to reuse the first person's
    // account and mix two strangers' debts. So the index below is a plain lookup index, and the
    // service SURFACES an existing same-name account as information. Nothing merges, ever, and
    // nothing is refused for sharing a name.
    //
    // 🔴 DELETION IS FORBIDDEN BY TRIGGER, archiving is `is_active`. Once a later slice links an
    // obligation to a party, deleting the party would orphan a financial record; and even before
    // that, an operator who typed a real person's name created a record of a real relationship.
    // `catalog_categories` permits deletion while unused and that is right for a label; a party is
    // not a label. Archive hides it from pickers and keeps it resolvable.
    //
    // 🔴 WHY `party_contact_history` AND NOT `audit_events`. Correcting a phone number must not
    // rewrite history, so the change needs a durable record. `audit_events` is the natural home —
    // and it cannot take one: its `event_type` and `entity_type` are CLOSED CHECK lists
    // (migration 11), so admitting a party event means REBUILDING the audit table. That is a
    // table rebuild of the audit trail, far outside an identity slice, so it is NOT done here.
    // This table is a purpose-built, append-only history for the four editable fields, and wiring
    // party events into `audit_events` stays an explicit follow-up with its own authorization.
    // Recorded rather than quietly worked around.
    //
    // WHAT IS DELIBERATELY ABSENT: balances, currency, credit limits, obligations, settlements,
    // opening balances, supplier bills, invoice links, captured images, tax identifiers,
    // account merging, and any notion of a payment. Each is a later approved slice or an
    // unapproved one, and each would need its own tables rather than a column here.
    sql: `
-- ── Parties: customers and suppliers, by durable id ───────────────────────────────────────────
CREATE TABLE parties (
  id            TEXT    PRIMARY KEY,
  -- 'customer' owes the shop; 'supplier' is owed by the shop. One row is one side.
  kind          TEXT    NOT NULL CHECK (kind IN ('customer', 'supplier')),
  -- The only required field. A party with no name cannot be found again, so it is not a party.
  display_name  TEXT    NOT NULL CHECK (length(trim(display_name)) > 0),
  -- Optional, and NULL means "not given" rather than empty. A blank string is refused so the two
  -- cannot both mean absent — the same rule 'catalog_categories.name_en' already follows.
  phone         TEXT             CHECK (phone IS NULL OR length(trim(phone)) > 0),
  address       TEXT             CHECK (address IS NULL OR length(trim(address)) > 0),
  note          TEXT             CHECK (note IS NULL OR length(trim(note)) > 0),
  -- Archived, never deleted. The DELETE trigger below enforces that.
  is_active     INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  -- Attribution without the audit table: who first named this party.
  created_by    TEXT    NOT NULL REFERENCES operators(id),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

-- 🔴 A LOOKUP INDEX, NOT A UNIQUE ONE. See the note above: two customers may share a name.
-- Case- and whitespace-insensitive so a search for " Ahmad " finds "ahmad".
CREATE INDEX parties_kind_name ON parties (kind, lower(trim(display_name)));
-- Finding an account by the number the merchant remembers. Also not unique: a household may share
-- one phone, and two of its members are still two accounts.
CREATE INDEX parties_kind_phone ON parties (kind, phone) WHERE phone IS NOT NULL;
-- The picker's own order: one kind, active first.
CREATE INDEX parties_kind_active ON parties (kind, is_active, id);

CREATE TRIGGER parties_no_delete BEFORE DELETE ON parties
BEGIN SELECT RAISE(ABORT, 'parties: an account is archived, never deleted'); END;

-- 🔴 A PARTY'S KIND IS FIXED FOR LIFE. Flipping a customer into a supplier would silently move
-- every obligation a later slice attached to it onto the wrong side of the ledger. A trader who
-- becomes both gets a second row.
CREATE TRIGGER parties_kind_immutable BEFORE UPDATE OF kind ON parties
WHEN NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT, 'parties: kind cannot change; create the other account'); END;

-- ── Contact history: an edit is a ROW, not an overwrite ───────────────────────────────────────
CREATE TABLE party_contact_history (
  id          TEXT    PRIMARY KEY,
  party_id    TEXT    NOT NULL REFERENCES parties(id),
  field       TEXT    NOT NULL CHECK (field IN ('display_name', 'phone', 'address', 'note')),
  -- Either may be NULL: NULL -> value is filling a blank, value -> NULL is clearing one.
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT    NOT NULL REFERENCES operators(id),
  changed_at  TEXT    NOT NULL,
  -- A write that changed nothing is not history. 'IS NOT' so the NULL cases are compared too.
  CHECK (old_value IS NOT new_value)
) STRICT;

CREATE INDEX party_contact_history_party ON party_contact_history (party_id, changed_at);

CREATE TRIGGER party_contact_history_immutable_update BEFORE UPDATE ON party_contact_history
BEGIN SELECT RAISE(ABORT, 'parties: contact history is append-only'); END;
CREATE TRIGGER party_contact_history_immutable_delete BEFORE DELETE ON party_contact_history
BEGIN SELECT RAISE(ABORT, 'parties: contact history cannot be deleted'); END;
`,
  },
  {
    version: 13,
    name: "obligations_and_settlements",
    // ════════════════════════════════════════════════════════════════════════════════════════════
    // Migration 13 — WHAT is owed, and WHAT has actually been paid against it.
    //
    // Purely ADDITIVE: two new tables, one unique index on an existing table, their own indexes and
    // their triggers. Migrations 1-12 are not touched, no existing table is rebuilt, no existing
    // column changes, and nothing in `sales`, `sale_lines`, `invoices` or `voids` is read, written
    // or re-interpreted by anything here.
    //
    // 🔴 THIS IS THE SCHEMA MIGRATION 7 PROMISED. Its own comment said: "no accounts receivable,
    // no credit note. `sales` stays immutable by trigger, so a balance recorded here can never be
    // 'collected' later by an UPDATE — collecting payment is a future feature with its own schema,
    // not a side effect of this one." This is that schema. `sales.paid_minor` and
    // `sales.balance_due_minor` remain exactly what migration 7 called them: truthful fields ON
    // THE DOCUMENT describing the moment of sale. Nothing here updates them, ever.
    //
    // ── THE DOUBLE-POSTING QUESTION, ANSWERED STRUCTURALLY ──────────────────────────────────────
    //
    // A finalized invoice and its sale must never produce two obligations for the same money. They
    // cannot, and not because a service remembers to check:
    //
    //   1. `sales.invoice_id` has been UNIQUE since migration 7, so an invoice has AT MOST ONE
    //      sale. A second sale for one invoice is already impossible at the database level.
    //   2. An obligation names its source as (source_kind, source_ref), and that pair is UNIQUE
    //      here. For a sale-sourced obligation `source_ref` IS the sale id, enforced by CHECK.
    //
    // So the chain invoice -> sale -> obligation is 1:1:1 the whole way down. The obligation is
    // keyed to the SALE and never to the invoice, which is also why a DRAFT invoice cannot create
    // a debt: a draft has no sale, so it has nothing to be keyed to. Selecting a customer at the
    // till creates no row here either — there is no sale yet, and S1B writes nothing financial.
    //
    // ── CURRENCY: SEPARATED, NEVER CONVERTED ────────────────────────────────────────────────────
    //
    // `src/domain/money.ts` has refused to add or subtract across currencies since migration 1
    // (`MIXED_CURRENCY`), and no exchange rate exists anywhere in this product. That refusal is
    // carried into the ledger STRUCTURALLY rather than restated in a service: `obligations` is
    // UNIQUE (id, currency) and `settlements` names a composite foreign key (obligation_id,
    // currency) against it. A settlement in a different currency from its obligation cannot be
    // inserted at all. A balance is therefore always a balance IN ONE CURRENCY, and a party who
    // owes both USD and LBP has two obligations and two balances — never one blended number.
    // Nothing here decides an exchange-rate policy, because nothing here needs one.
    //
    // ── THE BALANCE IS CALCULATED, NOT STORED ───────────────────────────────────────────────────
    //
    // There is deliberately NO `balance_minor`, no `paid_minor` and no `status` column on
    // `obligations`. The outstanding amount is `amount_minor - sum(settlements.amount_minor)` and
    // is computed on read. A stored balance is a second authoritative copy of the truth, and the
    // first time it disagreed with the settlement rows nobody could say which was right. The cost
    // is a SUM over a small, indexed set; the benefit is that the arithmetic cannot drift.
    //
    // ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────────────────────
    //
    // No reversals, no adjustments, no credit notes, no write-offs, no opening balances, no credit
    // limits, no ageing buckets, no interest, no `whish` payment method, and no link from a live
    // POS checkout. Each is a real decision with its own authorization, and a column added "while
    // we are here" would pre-decide it. `settlements.method` reuses migration 1's four values
    // unchanged — `cash`, `card`, `external`, `other` — so no historical payment value is
    // reinterpreted and no new tender is smuggled in.
    sql: `
-- ── the composite key the ledger hangs on ─────────────────────────────────────────────────────
-- parties.id is already the PRIMARY KEY, so this index adds no new uniqueness; what it adds is a
-- PARENT KEY that a composite foreign key can name. It is what makes "a payable always points at
-- a supplier" a database guarantee instead of a service convention. Additive: an index on an
-- existing table changes no row and no column.
CREATE UNIQUE INDEX parties_id_kind ON parties (id, kind);

-- ── obligations ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE obligations (
  id            TEXT    PRIMARY KEY,
  party_id      TEXT    NOT NULL,
  -- Denormalised ONLY so the composite foreign key below can exist. It is not a second source of
  -- truth: the FK makes it impossible for this to disagree with parties.kind.
  party_kind    TEXT    NOT NULL CHECK (party_kind IN ('customer', 'supplier')),
  -- Which way the money flows. 'receivable' = the customer owes the shop; 'payable' = the shop
  -- owes the supplier. Never inferred from the sign of an amount: every amount here is positive.
  direction     TEXT    NOT NULL CHECK (direction IN ('receivable', 'payable')),
  -- WHERE the debt came from. 'sale' is a completed sale in this ledger and carries a real foreign
  -- key. 'manual' is a debt the owner entered from a document that lives outside this app (a
  -- supplier's paper bill), and its source_ref is that document's own reference.
  source_kind   TEXT    NOT NULL CHECK (source_kind IN ('sale', 'manual')),
  source_ref    TEXT    NOT NULL CHECK (length(trim(source_ref)) > 0),
  sale_id       TEXT    REFERENCES sales (id),
  currency      TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- STRICTLY POSITIVE. A zero obligation is not a debt and a negative one is a reversal, which is
  -- a separate, unbuilt feature. The upper bound is migration 4's MAX_MINOR, unchanged.
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
  posted_by     TEXT    NOT NULL REFERENCES operators (id),
  posted_at     TEXT    NOT NULL CHECK (posted_at GLOB
                  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  business_date TEXT    NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- 🔴 A PAYABLE CAN NEVER POINT AT A CUSTOMER, AND A RECEIVABLE CAN NEVER POINT AT A SUPPLIER.
  FOREIGN KEY (party_id, party_kind) REFERENCES parties (id, kind),
  CHECK ((direction = 'receivable' AND party_kind = 'customer')
      OR (direction = 'payable'    AND party_kind = 'supplier')),
  -- 🔴 NO DOUBLE POSTING. One source, one obligation, forever.
  UNIQUE (source_kind, source_ref),
  -- The sale link exists exactly when the source is a sale, in both directions, and the source
  -- reference IS the sale id rather than a copy that could drift from it.
  CHECK ((source_kind = 'sale'   AND sale_id IS NOT NULL AND source_ref = sale_id)
      OR (source_kind = 'manual' AND sale_id IS NULL)),
  -- The parent key for settlements.currency. See the currency note above.
  UNIQUE (id, currency)
) STRICT;

CREATE INDEX obligations_party     ON obligations (party_id, posted_at);
CREATE INDEX obligations_direction ON obligations (direction, currency, posted_at);

CREATE TRIGGER obligations_immutable_update BEFORE UPDATE ON obligations
BEGIN SELECT RAISE(ABORT, 'ledger: a posted obligation is immutable'); END;
CREATE TRIGGER obligations_immutable_delete BEFORE DELETE ON obligations
BEGIN SELECT RAISE(ABORT, 'ledger: a posted obligation cannot be deleted'); END;

-- ── settlements ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE settlements (
  id                  TEXT    PRIMARY KEY,
  obligation_id       TEXT    NOT NULL,
  -- Carried so the composite foreign key can pin it to the obligation's own currency.
  currency            TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- 🔴 RETRY SAFETY, the same two-part shape migration 7 uses for sales. The key makes a repeat
  -- submission recognisable BEFORE it is attempted; the fingerprint makes a key reused for
  -- DIFFERENT money a loud refusal instead of a silent second payment.
  idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_fingerprint TEXT    NOT NULL CHECK (length(request_fingerprint) > 0),
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
  -- Migration 1's four values, unchanged. No 'whish', no 'credit' — 'credit' is a STATE, never a
  -- method, exactly as migration 7 wrote it.
  method              TEXT    NOT NULL CHECK (method IN ('cash', 'card', 'external', 'other')),
  settled_by          TEXT    NOT NULL REFERENCES operators (id),
  settled_at          TEXT    NOT NULL CHECK (settled_at GLOB
                        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  business_date       TEXT    NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- 🔴 ONE CURRENCY, STRUCTURALLY. A settlement in another currency cannot be inserted.
  FOREIGN KEY (obligation_id, currency) REFERENCES obligations (id, currency)
) STRICT;

CREATE INDEX settlements_obligation ON settlements (obligation_id, settled_at);

-- 🔴 OVERPAYMENT IS REFUSED BY THE DATABASE, not only by the service. A SUM cannot live in a CHECK
-- constraint, so this is the one rule that has to be a trigger. It fires on the row being inserted,
-- inside the same transaction, so a concurrent second payment cannot slip past a service-side read.
CREATE TRIGGER settlements_no_overpayment BEFORE INSERT ON settlements
WHEN NEW.amount_minor
     + coalesce((SELECT sum(amount_minor) FROM settlements WHERE obligation_id = NEW.obligation_id), 0)
     > (SELECT amount_minor FROM obligations WHERE id = NEW.obligation_id)
BEGIN SELECT RAISE(ABORT, 'ledger: a settlement cannot exceed what is owed'); END;

CREATE TRIGGER settlements_immutable_update BEFORE UPDATE ON settlements
BEGIN SELECT RAISE(ABORT, 'ledger: a recorded settlement is immutable'); END;
CREATE TRIGGER settlements_immutable_delete BEFORE DELETE ON settlements
BEGIN SELECT RAISE(ABORT, 'ledger: a recorded settlement cannot be deleted'); END;
`,
  },
  {
    version: 14,
    name: "credit_sale_identity_and_unpaid_state",
    // ════════════════════════════════════════════════════════════════════════════════════════════
    // Migration 14 — make a future, fully unpaid POS sale representable without recording a tender.
    //
    // This is schema-only. It creates no obligations and adds no checkout or payment path.
    //
    // SALES HAS FOUR LIVE CHILD-REFERENCE PATHS. `sale_lines.sale_id`, `voids.sale_id`, and
    // `obligations.sale_id` all reference `sales`; settlements then reference obligations. Migration
    // 7's three-table rebuild is not copied here. This migration was exercised on populated child
    // rows with the real runner, foreign_keys=ON, SQLite 3.53.4, and `BEGIN IMMEDIATE`.
    //
    // The swap relies on the exact same-name order below: defer FK checks for this transaction;
    // remove only the three sale-line triggers that read `sales`; copy sales to a staging table;
    // drop `sales`; create the replacement directly under the original name; copy its rows back;
    // drop staging; then restore indexes and all affected triggers. Never rename the old parent or
    // rename staging over `sales`: SQLite can rewrite surviving child FK targets during renames.
    //
    // `parties_id_kind` was created by migration 13 and is the actual UNIQUE parent key for the
    // generated child key below. The generated constant is not a CHECK pretending to validate
    // party kind: the composite FK enforces it. New credit rows additionally require an active
    // customer and a name snapshot equal to that party's current name.
    //
    // A v13-legal POS row with `payment_status='unpaid'` and a non-NULL method is contradictory,
    // but historical. Preserve it unchanged during the copy. The replacement CHECK continues to
    // accept it; a prospective INSERT trigger refuses creating another such row. The only new
    // `payment_method IS NULL` POS representation is a fully unpaid sale with a durable customer.
    sql: `
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER sale_lines_closed_sale;
DROP TRIGGER sale_lines_pos_shape;
DROP TRIGGER sale_lines_invoice_shape;

CREATE TABLE sales_m14 (
  id                  TEXT    PRIMARY KEY,
  receipt_number      INTEGER NOT NULL UNIQUE CHECK (receipt_number > 0),
  idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_fingerprint TEXT    NOT NULL,
  source_type         TEXT    NOT NULL CHECK (source_type IN ('pos', 'invoice')),
  invoice_id          TEXT    UNIQUE REFERENCES invoices (id),
  cashier_id          TEXT    NOT NULL,
  cashier_name        TEXT    NOT NULL,
  currency            TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  subtotal_minor      INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor           INTEGER NOT NULL CHECK (tax_minor >= 0),
  total_minor         INTEGER NOT NULL CHECK (total_minor >= 0),
  paid_minor          INTEGER NOT NULL CHECK (paid_minor >= 0),
  balance_due_minor   INTEGER NOT NULL CHECK (balance_due_minor >= 0),
  payment_status      TEXT    NOT NULL CHECK (payment_status IN ('paid', 'partial', 'unpaid')),
  payment_method      TEXT    CHECK (payment_method IS NULL
                                     OR payment_method IN ('cash', 'card', 'external', 'other')),
  line_count          INTEGER NOT NULL CHECK (line_count > 0),
  business_date       TEXT    NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  completed_at        TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  customer_id         TEXT,
  customer_name_snapshot TEXT
      CHECK (customer_name_snapshot IS NULL OR length(trim(customer_name_snapshot)) > 0),
  customer_kind       TEXT    GENERATED ALWAYS AS ('customer') STORED,
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (paid_minor + balance_due_minor = total_minor),
  CHECK (
    (payment_status = 'paid'    AND balance_due_minor = 0)
    OR (payment_status = 'unpaid'  AND paid_minor = 0 AND balance_due_minor > 0)
    OR (payment_status = 'partial' AND paid_minor > 0 AND balance_due_minor > 0)
  ),
  CHECK (source_type = 'invoice' OR payment_method IS NOT NULL
      OR (payment_status = 'unpaid' AND paid_minor = 0
          AND balance_due_minor = total_minor AND customer_id IS NOT NULL
          AND customer_name_snapshot IS NOT NULL)),
  CHECK ((source_type = 'invoice' AND invoice_id IS NOT NULL)
      OR (source_type = 'pos' AND invoice_id IS NULL)),
  CHECK ((customer_id IS NULL AND customer_name_snapshot IS NULL)
      OR (source_type = 'pos' AND customer_id IS NOT NULL
          AND customer_name_snapshot IS NOT NULL)),
  FOREIGN KEY (customer_id, customer_kind) REFERENCES parties (id, kind)
) STRICT;

INSERT INTO sales_m14 (
  id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
  cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor,
  balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at,
  created_at, customer_id, customer_name_snapshot
)
SELECT
  id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
  cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor,
  balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at,
  created_at, NULL, NULL
FROM sales;

DROP TABLE sales;

CREATE TABLE sales (
  id                  TEXT    PRIMARY KEY,
  receipt_number      INTEGER NOT NULL UNIQUE CHECK (receipt_number > 0),
  idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_fingerprint TEXT    NOT NULL,
  source_type         TEXT    NOT NULL CHECK (source_type IN ('pos', 'invoice')),
  invoice_id          TEXT    UNIQUE REFERENCES invoices (id),
  cashier_id          TEXT    NOT NULL,
  cashier_name        TEXT    NOT NULL,
  currency            TEXT    NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  subtotal_minor      INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor           INTEGER NOT NULL CHECK (tax_minor >= 0),
  total_minor         INTEGER NOT NULL CHECK (total_minor >= 0),
  paid_minor          INTEGER NOT NULL CHECK (paid_minor >= 0),
  balance_due_minor   INTEGER NOT NULL CHECK (balance_due_minor >= 0),
  payment_status      TEXT    NOT NULL CHECK (payment_status IN ('paid', 'partial', 'unpaid')),
  payment_method      TEXT    CHECK (payment_method IS NULL
                                     OR payment_method IN ('cash', 'card', 'external', 'other')),
  line_count          INTEGER NOT NULL CHECK (line_count > 0),
  business_date       TEXT    NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  completed_at        TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  customer_id         TEXT,
  customer_name_snapshot TEXT
      CHECK (customer_name_snapshot IS NULL OR length(trim(customer_name_snapshot)) > 0),
  customer_kind       TEXT    GENERATED ALWAYS AS ('customer') STORED,
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (paid_minor + balance_due_minor = total_minor),
  CHECK (
    (payment_status = 'paid'    AND balance_due_minor = 0)
    OR (payment_status = 'unpaid'  AND paid_minor = 0 AND balance_due_minor > 0)
    OR (payment_status = 'partial' AND paid_minor > 0 AND balance_due_minor > 0)
  ),
  CHECK (source_type = 'invoice' OR payment_method IS NOT NULL
      OR (payment_status = 'unpaid' AND paid_minor = 0
          AND balance_due_minor = total_minor AND customer_id IS NOT NULL
          AND customer_name_snapshot IS NOT NULL)),
  CHECK ((source_type = 'invoice' AND invoice_id IS NOT NULL)
      OR (source_type = 'pos' AND invoice_id IS NULL)),
  CHECK ((customer_id IS NULL AND customer_name_snapshot IS NULL)
      OR (source_type = 'pos' AND customer_id IS NOT NULL
          AND customer_name_snapshot IS NOT NULL)),
  FOREIGN KEY (customer_id, customer_kind) REFERENCES parties (id, kind)
) STRICT;

INSERT INTO sales (
  id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
  cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor,
  balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at,
  created_at, customer_id, customer_name_snapshot
)
SELECT
  id, receipt_number, idempotency_key, request_fingerprint, source_type, invoice_id,
  cashier_id, cashier_name, currency, subtotal_minor, tax_minor, total_minor, paid_minor,
  balance_due_minor, payment_status, payment_method, line_count, business_date, completed_at,
  created_at, customer_id, customer_name_snapshot
FROM sales_m14;

DROP TABLE sales_m14;

CREATE INDEX sales_business_date ON sales (business_date);
CREATE INDEX sales_source_type ON sales (source_type, completed_at DESC);

CREATE TRIGGER sales_immutable_update BEFORE UPDATE ON sales
BEGIN SELECT RAISE(ABORT, 'ledger: completed sales are immutable'); END;
CREATE TRIGGER sales_immutable_delete BEFORE DELETE ON sales
BEGIN SELECT RAISE(ABORT, 'ledger: completed sales cannot be deleted'); END;

CREATE TRIGGER sale_lines_closed_sale BEFORE INSERT ON sale_lines
WHEN (SELECT count(*) FROM sale_lines WHERE sale_id = NEW.sale_id)
     >= (SELECT line_count FROM sales WHERE id = NEW.sale_id)
BEGIN SELECT RAISE(ABORT, 'ledger: sale already holds all of its lines'); END;

CREATE TRIGGER sale_lines_pos_shape BEFORE INSERT ON sale_lines
WHEN (SELECT source_type FROM sales WHERE id = NEW.sale_id) = 'pos'
 AND (NEW.product_id IS NULL
      OR NEW.sku IS NULL
      OR NEW.sale_unit IS NULL
      OR NEW.invoice_line_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ledger: a POS sale line requires its product, sku and unit'); END;

CREATE TRIGGER sale_lines_invoice_shape BEFORE INSERT ON sale_lines
WHEN (SELECT source_type FROM sales WHERE id = NEW.sale_id) = 'invoice'
 AND (NEW.invoice_line_id IS NULL OR length(trim(NEW.product_name)) = 0)
BEGIN SELECT RAISE(ABORT, 'ledger: an invoice-origin sale line must name its invoice line and description'); END;

CREATE TRIGGER sales_pos_unpaid_requires_no_tender BEFORE INSERT ON sales
WHEN NEW.source_type = 'pos' AND NEW.payment_status = 'unpaid'
 AND NEW.payment_method IS NOT NULL AND NEW.paid_minor = 0
 AND NEW.balance_due_minor = NEW.total_minor
 AND NEW.total_minor = NEW.subtotal_minor + NEW.tax_minor
BEGIN SELECT RAISE(ABORT, 'ledger: an unpaid POS sale cannot record a tender'); END;

CREATE TRIGGER sales_credit_requires_active_customer BEFORE INSERT ON sales
WHEN NEW.source_type = 'pos' AND NEW.payment_status = 'unpaid'
 AND NEW.payment_method IS NULL AND NEW.paid_minor = 0
 AND NEW.balance_due_minor = NEW.total_minor
 AND NEW.total_minor = NEW.subtotal_minor + NEW.tax_minor
 AND NOT EXISTS (
   SELECT 1 FROM parties
   WHERE id = NEW.customer_id AND kind = 'customer' AND is_active = 1
     AND display_name = NEW.customer_name_snapshot
 )
BEGIN SELECT RAISE(ABORT, 'ledger: a credit sale requires its active customer snapshot'); END;

CREATE TRIGGER obligations_sale_customer_match BEFORE INSERT ON obligations
WHEN NEW.source_kind = 'sale'
 AND EXISTS (
   SELECT 1 FROM sales AS s
   WHERE s.id = NEW.sale_id AND s.source_type = 'pos' AND s.customer_id IS NOT NULL
     AND (s.customer_id <> NEW.party_id OR s.currency <> NEW.currency
          OR s.balance_due_minor <> NEW.amount_minor
          OR NEW.direction <> 'receivable' OR NEW.party_kind <> 'customer')
 )
BEGIN SELECT RAISE(ABORT, 'ledger: sale obligation does not match sale identity or balance'); END;
`,
  },
  {
    version: 15,
    name: "invoice_line_batch_identity",
    // ════════════════════════════════════════════════════════════════════════════════════════════
    // Migration 15 — a durable identity for one batch of invoice-draft lines.
    //
    // `addInvoiceLines` used to have none. A batch that COMMITTED and then lost its response left a
    // sheet that still held its rows as unsaved, and sending them again inserted them twice. The
    // service cannot tell a repeat from a new batch by CONTENT — two identical lines are a
    // legitimate invoice — so the caller now names the batch and the ledger remembers the name.
    //
    // One row per batch, written in the SAME transaction as the lines it covers, so a batch marker
    // never exists without its lines and lines never exist without their marker. It records WHO/WHAT
    // the batch was (key + sha256 fingerprint of the invoice id and the exact ordered payload) and
    // how many lines it wrote; it does NOT reference individual lines. That is deliberate: a line
    // may later be edited or removed, and a replay must report the batch as already recorded, never
    // recreate what the operator deleted.
    //
    // Additive only. No existing table, trigger or row is touched, so every finalized invoice,
    // number, total and historical line is unchanged. The marker survives finalization (it is
    // history) and is removed only with its draft, by InvoiceRepository.deleteDraft.
    sql: `
CREATE TABLE invoice_line_batches (
  id                  TEXT    PRIMARY KEY,
  invoice_id          TEXT    NOT NULL REFERENCES invoices (id),
  idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_fingerprint TEXT    NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  line_count          INTEGER NOT NULL CHECK (line_count > 0),
  created_at          TEXT    NOT NULL
);

CREATE INDEX invoice_line_batches_invoice_id ON invoice_line_batches (invoice_id);

CREATE TRIGGER invoice_line_batches_immutable BEFORE UPDATE ON invoice_line_batches
BEGIN SELECT RAISE(ABORT, 'invoice: a line batch record is immutable'); END;

CREATE TRIGGER invoice_line_batches_draft_only BEFORE INSERT ON invoice_line_batches
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice: a line batch can only be recorded on a draft'); END;
`,
  },
];
