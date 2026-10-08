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
];
