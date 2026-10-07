# Durable local audit — Migration 5 investigation and design contract

Status: **IMPLEMENTED under the final contract.** Branch `feat/durable-local-audit`, based on
`68fdf039a7ab29b0c44a76c6bfce6aca42cb58fc` (main, migrations 1–4, CI 37621869277 green).

Sections 1–15 are the INVESTIGATION, kept as written so the reasoning stays auditable. **Section 16
is the final contract as decided and built**, and it OVERRIDES the investigation wherever the two
differ — three places, each marked below and each listed in §16.

Every fact here was measured on this branch, never carried over from a report.

---

## 1 · What already exists, and why it is not durable

🔴 **An audit hook, an event registry and a diff format are already in the code** — found, not
invented here:

```
src/application/posService.ts     AuditAction (7 names) · AuditEvent · PosService.record()
src/main/main.ts:279              audit: (event) => log.info("audit", { ...event })
```

So the sink is `src/main/logger.ts` — a rotating JSON file:

```
LOG_MAX_BYTES = 1024*1024      LOG_MAX_FILES = 5
rotate(): rmSync(alzabt-pos.4.log) then shift 3->4, 2->3, 1->2, 0->1
```

**The audit is therefore deleted by design** once ~5 MiB of operational log has been written: the
same file carries every lifecycle, IPC-error and backup line, so the audit competes for space with
diagnostics. It is also not queryable from the app and not protected by anything. That is the whole
justification for Migration 5 — the record exists, its storage does not.

The file log is **not** the durable mechanism and must not become it.

---

## 2 · The real mutation map, measured end to end

| operation | renderer | IPC channel | validation | service | repository | transaction boundary today |
|---|---|---|---|---|---|---|
| product create | `ProductsScreen.tsx` | `pos:createProduct` | `ipcHandlers.productDraft()` → `validateProductDraft` | `PosService.createProduct` | `CatalogRepository.createManual` | ✅ `db.transaction(…).immediate()` **inside** `createManual` |
| product edit | `ProductsScreen.tsx` | `pos:updateProduct` | same | `PosService.updateProduct` | `CatalogRepository.updateProduct` | ✅ `db.transaction(…).immediate()` inside |
| price change | — | `pos:updateProduct` | same | `PosService.updateProduct` | `CatalogRepository.updateProduct` | same as edit (not a separate path) |
| base-unit change | — | `pos:updateProduct` | same | `PosService.updateProduct` | `CatalogRepository.updateProduct` | same as edit (not a separate path) |
| activate / deactivate | `ProductsScreen.tsx` | `pos:setProductActive` | `bool()` | `PosService.setProductActive` | `CatalogRepository.setActive` | 🔴 **NONE** — read, `UPDATE`, read, bare |
| CSV catalog import | `ToolsScreen.tsx` → native file dialog | `pos:importCatalog` | `validateImport` (domain, all-or-nothing) | `PosService.importCatalogCsv` | `CatalogRepository.applyImport` | ✅ one `db.transaction(…).immediate()` covering upserts + deactivations + the `catalog_imports` summary row |

**Three structural facts that decide the design:**

1. 🔴 **`setActive` is the one mutation with no transaction at all.** Everything else is already
   transactional. It must be wrapped before it can carry an atomic audit.
2. 🔴 **Every `record()` call happens AFTER the repository transaction has committed** — which is
   exactly what the hard atomicity rule forbids. `refreshCatalogFromStore()` even runs *between*
   the commit and `record()`, so an exception there loses the audit while keeping the write.
3. **Price and unit are not separate paths.** They are fields of `updateProduct`. The two extra
   audit actions are a reporting choice made in the service, not a second mutation path.

---

## 3 · Measured platform facts the design rests on

Run under the app's own runtime (Electron's Node, better-sqlite3, **SQLite 3.53.4**):

```
json_valid() / json_extract()                    available
nested db.transaction(...).immediate()           accepted — becomes a SAVEPOINT
a throw in the OUTER transaction                 rolls back the inner savepoint's writes too
BEFORE UPDATE / BEFORE DELETE RAISE(ABORT)       reject UPDATE and DELETE
CHECK (json_valid(x) AND json_type(x)='object')  rejects "not json" AND rejects "[1,2]"
cross-column CHECK on event_type/entity_type     rejects PRODUCT_UPDATED/catalog
BEFORE INSERT monotonic-seq trigger              rejects a back-dated seq
partial index WHERE json_extract(...) IS NOT NULL   created, AND the planner uses it:
    SEARCH audit_events USING INDEX ae_price (entity_id=?)
```

The savepoint result is the load-bearing one: it means `PosService` can open an outer transaction
around a repository call that already opens its own, without changing the repository's internals.

---

## 4 · Proposed schema (additive — no existing table is altered)

```sql
CREATE TABLE audit_events (
  id             TEXT    PRIMARY KEY,
  seq            INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  event_type     TEXT    NOT NULL CHECK (event_type IN
                   ('PRODUCT_CREATED','PRODUCT_UPDATED','PRODUCT_ACTIVATED',
                    'PRODUCT_DEACTIVATED','CATALOG_IMPORTED')),
  entity_type    TEXT    NOT NULL CHECK (entity_type IN ('product','catalog')),
  entity_id      TEXT    NOT NULL CHECK (length(entity_id) > 0),
  actor_id       TEXT    NOT NULL CHECK (length(actor_id) > 0),
  actor_name     TEXT    NOT NULL CHECK (length(trim(actor_name)) > 0),
  actor_tier     TEXT    NOT NULL CHECK (actor_tier IN
                   ('owner','admin','cashier','system','unspecified')),
  occurred_at    TEXT    NOT NULL CHECK (occurred_at GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  business_date  TEXT    NOT NULL CHECK (business_date GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_json   TEXT    NOT NULL CHECK (json_valid(changed_json)
                                         AND json_type(changed_json) = 'object'),
  metadata_json  TEXT             CHECK (metadata_json IS NULL
                                         OR (json_valid(metadata_json)
                                             AND json_type(metadata_json) = 'object')),
  app_version    TEXT    NOT NULL CHECK (length(app_version) > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  CHECK (
    (entity_type = 'product' AND event_type IN
       ('PRODUCT_CREATED','PRODUCT_UPDATED','PRODUCT_ACTIVATED','PRODUCT_DEACTIVATED'))
    OR (entity_type = 'catalog' AND event_type = 'CATALOG_IMPORTED')
  )
) STRICT;
```

### Why each decision, not just what

**`seq`, and why `occurred_at` cannot be the ordering key.** `PosService` takes its clock from an
injectable `now()`, frozen to a constant in tests, and one user action can emit several events. Two
rows can therefore legitimately share `occurred_at` to the millisecond. Ordering must not depend on
the clock, so `seq` is the single ordering authority — allocated inside the same `BEGIN IMMEDIATE`
as `coalesce(max(seq),0)+1`, the pattern `SaleRepository.nextReceiptNumber()` already uses.

**`id` is a UUID from the existing injectable `newId()`**, not an AUTOINCREMENT rowid: there is no
autoincrement anywhere in this schema, and an id must stay stable across a backup and restore.

**Timestamps are TEXT ISO-8601 UTC with `Z`**, matching `sales.completed_at`, `voids.created_at` and
`catalog_products.updated_at`. No epoch integers — consistency beats cleverness, and `GLOB` can
then shape-check them as it already does for `business_date` elsewhere.

**`business_date` is stored, not derived.** Every owner question is "what changed on Tuesday", and
`businessDateOf(instant, terminal.timeZone)` already exists. Ten bytes removes a timezone
computation from every query and from every future report.

**`app_version` / `schema_version`** let a later reader tell which build wrote a row. Cheap, and the
only way to interpret an old row's conventions after a format change. Droppable if Salman prefers a
narrower table.

**No `before_json` / `after_json`** — see §6.

### Append-only enforcement

```sql
CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: the audit trail is append-only'); END;

CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: audit events cannot be deleted'); END;

CREATE TRIGGER audit_events_seq_monotonic BEFORE INSERT ON audit_events
WHEN NEW.seq <= coalesce((SELECT max(seq) FROM audit_events), 0)
BEGIN SELECT RAISE(ABORT, 'audit: seq must be monotonic'); END;
```

Same shape as migration 1's `sales_immutable_update` / `voids_immutable_delete`, deliberately.

**Does INSERT need validation beyond CHECKs? Exactly one thing.** A CHECK sees only its own row, so
it cannot know the current `max(seq)`; back-dating a row to slot it between two existing events is
the one forgery a CHECK cannot prevent. Hence the third trigger. Everything else — enumerated event
types, the event/entity pairing, JSON validity and shape, timestamp form — is a row-local condition
and belongs in a CHECK, which is cheaper and visible in the schema.

🔴 **The honest limit, stated rather than implied.** `DROP TABLE audit_events` does **not** fire
`BEFORE DELETE` (measured during Migration 4's rebuild), and anyone with the file can open it with
the `sqlite3` CLI. These triggers defend the trail against a bug in this application, not against a
person with file access. A tamper-evident chain (each row hashing its predecessor) would raise that
bar and is **not proposed here** — it is a separate decision with its own cost.

### Indexes — four, each with a named query

```sql
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, seq DESC);
CREATE INDEX audit_events_type   ON audit_events (event_type, seq DESC);
CREATE INDEX audit_events_actor  ON audit_events (actor_id, seq DESC);
CREATE INDEX audit_events_date   ON audit_events (business_date, seq DESC);
```

- `_entity` — "the whole history of this product" (the only query the Products screen will need).
- `_type` — "every import", "every deactivation".
- `_actor` — "everything this operator changed".
- `_date` — "what changed on 2026-10-07", and a date-range report.

"Newest events" needs **no** index: `seq INTEGER NOT NULL UNIQUE` already carries one, so
`ORDER BY seq DESC LIMIT n` is an index scan. No index on `id` either (PRIMARY KEY).

One conditional fifth — **🔴 DECIDED AGAINST, see §16.3. It is NOT in migration 5.** It is kept
here only as the measurement that proved it would work if a real audit query ever asks for it:

```sql
CREATE INDEX audit_events_price_changes ON audit_events (entity_id, seq DESC)
  WHERE json_extract(changed_json, '$.selling_price_minor') IS NOT NULL;
```

Measured: it is created, and the planner uses it. But there is no audit query UI yet and no
measured query to tune, so coupling the schema to one JSON field now would be premature — a later
migration can add it on real evidence. A price change stays discoverable inside `changed_json`.

---

## 5 · Event registry — bounded, and one recommendation

The code already names seven. Measured today, **one product edit emits three rows**:
`PRICE_CHANGED`, `UNIT_CHANGED`, then `PRODUCT_UPDATED` whose diff already contains both fields.

**Recommendation: five event types, one row per user action.**

```
PRODUCT_CREATED          PRODUCT_UPDATED        (carries the full changed-field diff)
PRODUCT_ACTIVATED        PRODUCT_DEACTIVATED    CATALOG_IMPORTED
```

`PRICE_CHANGED` and `UNIT_CHANGED` are **dropped as event types**, because:

- in a durable table they become 2 of every 3 rows for a single edit, restating what the third row
  already carries, and they double-count in any "how many changes today" question;
- the stated reason they exist — answering "who changed this price" without reading every diff — is
  satisfied exactly by the partial index above, which the planner was measured to use;
- a price change is not a different *act*; it is a field of the edit the operator performed. One
  act, one row is the property that makes the trail countable.

The CHECK enumerates the five, so a sixth needs a migration. **No free-form event strings.**

🔴 **One overlap I am not hiding:** `updateProduct` with `isActive` flipped produces
`PRODUCT_UPDATED` with `is_active` in its diff, while the list's toggle produces
`PRODUCT_ACTIVATED`. Same business fact, two event types. I recommend keeping both, because they
are genuinely different operator intents through two different IPC channels, and the diff
distinguishes them — but it is a judgement call and it is Salman's.

---

## 6 · Before / after / diff — recommendation B

**Recommended: structured changed-fields JSON**, which is the shape `PosService` already builds:

```json
{"name_ar":{"before":"…","after":"…"},"selling_price_minor":{"before":"1250","after":"1395"}}
```

Rejected: `before_json` + `after_json` full rows. `catalog_products` has 13 columns; a price edit
would store 26 values to express one change, every unchanged field would be duplicated in every
row, and "what changed?" would have to be recomputed by every reader rather than recorded once.

A creation has no before, and uses the **same** shape with `before: null` — one format, not two.
That is already what `createProduct` emits.

**Determinism rules, so tests can assert exact strings:**

```
keys sorted ascending by field name
bigint      -> base-10 string  ("1395")        never a JSON number, never a float
boolean     -> JSON true/false
absent      -> null
no floats, anywhere, ever
unchanged fields are OMITTED, not recorded as equal
```

All five questions are answerable: *what changed* (the keys), *old value* / *new value* (the pair),
*who* (`actor_*`), *when* (`occurred_at`, `business_date`, ordered by `seq`), *what entity*
(`entity_type` + `entity_id`). No prose anywhere in the primary record.

---

## 7 · Actor contract

**What identity actually exists today, measured:**

```
src/application/cashierAuth.ts   export interface Cashier { id: string; name: string }
src/fixtures/cashiers.ts         cashier-01 "Cashier One" · cashier-02 "Cashier Two"
grep for tier|role across fixtures, cashierAuth, ipcContract   -> ZERO hits
```

There is **no tier, role or permission concept anywhere in the application**, and no cashiers
*table* — the cashiers are a TypeScript fixture.

**Three consequences:**

1. **A foreign key is not merely unwise, it is impossible** — there is no row to point at. The
   required property ("historical audit cannot be invalidated by editing an actor") therefore holds
   structurally, not by discipline. `actor_id` / `actor_name` / `actor_tier` are plain snapshot
   columns, as `sale_lines.product_name` already is.
2. **Migration-time and system events** use `actor_id='system'`, `actor_name='System'`,
   `actor_tier='system'`. Nothing today produces one, but the enum must admit it before something
   does.
3. 🔴 **`actor_tier` for V1 needs Salman's decision, and the honest option is not `'cashier'`.**
   Writing `'cashier'` asserts a tier the application has no way to know; when permissions land and
   price edits become owner-only, history will read "a cashier changed the price" for acts that were
   really the owner's — and the append-only triggers make that unfixable by design. Following
   Migration 4's own rule that unknown data stays unknown, I recommend **`'unspecified'`** for every
   V1 row. `owner` / `admin` / `cashier` enter the data only when a real session can distinguish
   them.

Cashier permission hardening stays out of Migration 5, as instructed.

---

## 8 · Safe payload — explicit allowlist

`catalog_products` columns, measured from migration 3:

```
id · source · source_key · sku · name_ar · name_en · selling_price_minor · currency
base_unit · price_needs_review · is_active · created_at · updated_at
```

**Allowlist — the only field names `changed_json` may contain:**

```
name_ar   name_en   sku   selling_price_minor   currency   base_unit
price_needs_review   is_active
```

**Deliberately excluded:** `id`, `source`, `source_key` (identity — already in `entity_id` and
`metadata_json`, and never editable); `created_at`, `updated_at` (derivable bookkeeping, pure
noise in a diff).

**What crosses the mutation boundary today, and the one dangerous object:**

- `ProductDraft` — product fields only. Safe.
- `Cashier { id, name }` — what the audit sees. Safe.
- 🔴 `CashierFixture { id, name, pinSaltHex, pinHashHex }` — carries the PIN hash and salt. It is
  read **only** inside `pinMatches()` and `PosService.login()`, and `Cashier` is the narrowed type
  that leaves the auth layer. The audit never touches `CashierFixture`. That is a real measured
  safety property of the current layering, and the one thing Migration 5 must not break.

**Enforcement, three layers:**

1. one allowlist constant in `src/domain/audit.ts`, applied by one serializer;
2. a runtime filter that drops any key not on the list rather than storing it;
3. a test that reads **every row of the table back** and asserts no value or key matches
   `/pin|hash|password|passwd|token|secret|credential|apikey/i` at any depth — the same family the
   logger's `SECRET_KEY` already guards, applied to the durable table.

Import payloads carry counts, the file name (already capped at 200 chars) and the `catalog_imports`
id — **never row contents**, never the file itself.

No PIN. No PIN hash. No password. No token. No secret. No arbitrary request body.

---

## 9 · CSV import — recommendation, and what is already durable

🔴 **Half of option A already exists.** `catalog_imports` (migration 3) has stored a durable
per-import summary row in SQLite since the field pilot:

```
id · source · file_name · file_sha256 · row_count · inserted · updated · unchanged
deactivated · cashier_id · imported_at
```

So the question is only what the *audit* adds. Measured import semantics: an import inserts, updates
in place, leaves unchanged, and deactivates rows of its own source that the new file no longer
lists. It is all-or-nothing in one transaction.

**🔴 SUPERSEDED BY §16.2 — the decision went further than this recommendation.** What was
recommended here (and what was built instead) differ in one row type; the reasoning below is kept
because §16.2 is a deliberate answer to it.

**Recommended at investigation time — one summary plus the two effects a summary cannot express:**

```
1 ×  CATALOG_IMPORTED      metadata_json references catalog_imports.id; diff carries the counts
N ×  PRODUCT_UPDATED       one per row whose stored values actually CHANGED
M ×  PRODUCT_DEACTIVATED   one per row the new file no longer lists
0 ×  for inserted rows      summarized only
0 ×  for unchanged rows     summarized only
```

Why that split, and not per-product for everything:

- **Inserted rows need no event** *(this is the part §16.2 overrules)*. "This product first
  appeared in that import" is recoverable from `catalog_products.created_at` + `source` +
  `source_key`, which already exist. A 400-row first import would then write **1** audit row.
- **Updated rows do need events.** The counts say "5 updated" and nothing more; the old price is
  then gone from the database forever, because the import overwrites it in place. This is the one
  genuinely irrecoverable loss in the whole import path, and it is exactly what an owner comes
  asking about.
- **Deactivations need events.** "7 deactivated" does not say *which* 7, and a product silently
  vanishing from the till is the import effect an owner notices.

**Measured growth bounds:**

```
first 400-row import                1 row
idempotent re-import, nothing changed   1 row, all counts zero
re-import with 5 price edits        6 rows
pathological worst case (400 rows, every one changed)   401 rows ≈ 100 KB, one transaction
```

401 inserts inside the existing transaction is unremarkable for SQLite: `synchronous = FULL` costs
one fsync at COMMIT, not one per row.

---

## 10 · Retention and storage

Measured: one realistic `PRODUCT_UPDATED` row is **357 bytes** of payload (`changed_json` alone 206).
Allow ~450 bytes with index overhead.

```
realistic pilot   ~20 product mutations/day + 1 import with ~5 changes  ≈ 26 rows/day
                  ≈ 12 KB/day  ≈ 4.3 MB/year  ≈ 21 MB over five years
worst case named  a daily 400-row import where everything changed       ≈ 180 KB/day ≈ 65 MB/year
```

The sales ledger grows faster than this on any real trading day. **Indefinite local retention is
safe. No pruning, no cleanup, no TTL** — and none will be added without explicit approval.

---

## 11 · Migration and backup contract — unchanged, with one addition

Already satisfied, nothing weakened:

- `openDatabase(..., { beforeMigrations })` fires for a v4 ledger before any v5 SQL runs, and
  `createPreMigrationBackup` writes `pre-migration-v4-to-v5-<stamp>.sqlite` via `VACUUM INTO`,
  verified by `integrity_check` plus row-count equality, never pruned.
- each migration runs in its own `db.transaction(...).immediate()`, so a mid-migration failure is a
  complete rollback.
- migrations 1–4 are untouched; Migration 5 is a new array entry, so their checksums cannot change.

🔴 **One code change the backup needs.** `src/persistence/backup.ts`:

```ts
const COUNTED_TABLES = ["sales","sale_lines","voids","catalog_products","schema_migrations"];
```

`audit_events` is absent, and `tableCounts()` silently skips a table it does not list. Without
adding it, every v5 backup would verify five tables and **ignore the audit trail entirely** — a
backup that looks verified while proving nothing about the new table. The function already skips
tables that are not present, so adding it stays safe for v1–v4 snapshots.

**v5 → v4 rollback: not supported, and already enforced.** `verifyAppliedMigrations` throws
`SchemaNewerThanAppError` when the database holds more migrations than the build, and it runs
**before** `journal_mode = WAL`, so a refused ledger is left byte-for-byte as it was. An older build
pointed at a v5 ledger refuses to open and writes nothing. The recovery path is the pre-migration
backup, which is why that backup is never pruned. This needs no new work; it needs a test.

---

## 12 · Transaction integration — and the refactor this requires

The atomic unit is exactly two steps:

```
BEGIN IMMEDIATE
    business mutation          (the existing repository method, unchanged internally)
    audit INSERT               (seq allocated here, inside the same transaction)
COMMIT
```

`refreshCatalogFromStore()` stays **outside and after** the transaction. It is an in-memory cache,
not a record; putting it inside would mean a rolled-back transaction leaves `this.catalog` holding
state that was never committed.

**How to get there — the smallest seam.** The diff is computed in `PosService` (it holds `before`
and `after`); the write lives in `CatalogRepository`. Measured: a nested
`db.transaction(...).immediate()` becomes a SAVEPOINT and a throw in the outer transaction rolls the
inner one back. So `PosService` can wrap the existing repository call in an outer transaction
without touching the repository's internals — **but `PosService` has no database handle today**, only
repositories. It needs one new injected seam (a `transact(fn)` runner). That is the refactor, and it
is small.

### 🔴 Two things that genuinely cannot be made atomic without a larger change

1. **`setProductActive`.** `CatalogRepository.setActive` has no transaction at all — a bare read,
   `UPDATE`, read. It must be wrapped before it can carry an atomic audit. Small, but it is a change
   to shipped, merged product-management code, not a purely additive migration.

2. **`importCatalogCsv`, and this is the real one.** The per-row diffs the recommended import model
   needs exist **only inside `applyImport`'s loop**, where `existing` is compared to the new row.
   `applyImport` returns counts and nothing else. So per-row import audit **cannot** be produced
   from outside the transaction at any price — `applyImport` must either return the diffs or accept
   an audit writer. That is a signature change to the repository's most load-bearing method, with
   its own tests to re-green. Flagging it explicitly as the brief asks: **this one is not a
   wrapper, it is a refactor.**

   If Salman prefers to avoid it in Migration 5, the fallback is a **summary-only** import audit
   (one `CATALOG_IMPORTED` row, no per-row events) — which keeps the change additive, and accepts
   that an import's overwritten prices stay unrecoverable. That is a product decision, not a
   technical one, and it is his.

Out of scope by instruction and left alone: `createSale`, `voidSale` and the sales ledger (already
immutable with their own triggers).

---

## 13 · Files expected to change

```
NEW   src/domain/audit.ts                   event registry · field allowlist · deterministic serializer
NEW   src/persistence/auditRepository.ts    seq allocation + the one INSERT
EDIT  src/persistence/migrations.ts         APPEND migration 5 only — 1–4 byte-identical
EDIT  src/application/posService.ts         record() moves inside the transaction; AuditEvent moves to domain
EDIT  src/persistence/catalogRepository.ts  wrap setActive; the applyImport seam (see §12.2)
EDIT  src/persistence/backup.ts             COUNTED_TABLES gains audit_events
EDIT  src/main/main.ts                      audit sink becomes the table; the file log stays as secondary triage
NEW   tests/persistence/migration5.test.ts
NEW   tests/persistence/auditAppendOnly.test.ts
NEW   tests/persistence/auditAtomicity.test.ts
NEW   tests/domain/auditPayload.test.ts
EDIT  tests/persistence/productAdmin.test.ts · tests/application/productManagement.test.ts
EDIT  e2e/product-management.mjs            assert audit rows against the INSTALLED app
EDIT  e2e/upgrade.mjs                       scenario D: v4 -> v5
EDIT  .github/workflows/windows-delivery.yml  one new upgrade step; previous-release list gains 68fdf03
NEW   docs/plans/durable-audit-contract.md  (this file)
```

Nothing in `src/domain/quantity.ts`, `src/persistence/saleRepository.ts` or migrations 1–4.

---

## 14 · Test plan

**Migration (`tests/persistence/migration5.test.ts`)**

- a v4 ledger with real sales, voids and products migrates to v5; `schema_migrations` holds exactly
  1–4 unchanged plus 5;
- migrations 1–4 checksums byte-identical before and after (recomputed, not asserted from memory);
- `audit_events` exists with every column, type and CHECK; all four indexes present; all three
  triggers present (read from `sqlite_master`);
- `PRAGMA integrity_check` = ok and `PRAGMA foreign_key_check` empty, after;
- a fault injected mid-migration leaves the database at v4 with zero `audit_events`;
- a v5 ledger opened by a build that knows only 4 migrations throws `SchemaNewerThanAppError` and
  **writes nothing** (file bytes compared before and after);
- idempotency: opening an already-v5 ledger applies nothing and changes no checksum;
- a fresh install reaches v5 directly with an empty audit table.

**Append-only (`auditAppendOnly.test.ts`)**

- INSERT of a well-formed event succeeds;
- `UPDATE audit_events` is rejected with the trigger's message;
- `DELETE FROM audit_events` is rejected;
- a back-dated `seq` is rejected by the monotonic trigger;
- invalid JSON, a JSON array, an unknown `event_type`, a mismatched event/entity pair and a
  malformed `occurred_at` are each rejected by their CHECK.

**Atomicity (`auditAtomicity.test.ts`)** — with a negative control, as `atomicity.test.ts` already does

- business mutation + audit row commit together: 1 product change, exactly 1 audit row;
- 🔴 **forced audit-insert failure rolls back the business mutation** — the product is unchanged and
  there is no audit row;
- 🔴 **forced business failure leaves no audit row**;
- **negative control:** the same forced audit failure with the transaction removed *does* leave a
  changed product with no audit row — proving the test can detect what it claims to prevent;
- `seq` is strictly increasing across every event of a multi-event operation even when `now()` is
  frozen to one instant.

**Products**

- create → `PRODUCT_CREATED`, diff `before: null`, allowlisted fields only;
- edit name only → one `PRODUCT_UPDATED` whose diff contains `name_ar` and nothing else;
- price change → `selling_price_minor` in the diff as a base-10 string, and the partial price index
  finds it;
- unit change → `base_unit` in the diff;
- activate / deactivate through the toggle → `PRODUCT_ACTIVATED` / `PRODUCT_DEACTIVATED`;
- an edit that changes nothing writes **no** audit row (an empty diff is not an event);
- a rejected edit (duplicate SKU, invalid draft) writes neither a product change nor an audit row.

**Import**

- a successful import writes one `CATALOG_IMPORTED` referencing the `catalog_imports` id, plus one
  event per changed row and per deactivated row, and none for inserted or unchanged rows;
- a rejected file leaves zero product writes **and** zero audit rows;
- an idempotent re-import of the identical file writes one all-zero summary and no per-row events;
- a 400-row synthetic import writes exactly 1 audit row, measured (the noise bound, asserted).

**Actor**

- the actor snapshot is persisted with the event;
- changing the cashier fixture's name afterwards does **not** change any historical row (read back
  and compared) — and the append-only triggers make the rewrite impossible, which is itself asserted;
- a `system` actor row is accepted by the enum.

**Security (`auditPayload.test.ts`)**

- every row of a fully exercised table, read back and walked at any depth, contains no key or value
  matching `/pin|hash|password|passwd|token|secret|credential|apikey/i`;
- a serializer handed an object containing `pinHashHex` drops it rather than storing it;
- a field not on the allowlist is dropped, not stored.

**Persistence**

- a product change, then close the database, then reopen: the audit row is still there with the same
  `seq`, diff and actor;
- WAL: the audit row survives a backup taken with `VACUUM INTO` and is counted by
  `COUNTED_TABLES`.

**Regression — must stay green with no edits to their assertions**

- `productAdmin.test.ts`, `productManagement.test.ts`, `productIpc.test.ts` (product management);
- `quantity.test.ts`, `migration4.test.ts`, `cart.test.ts` (exact/fractional quantity);
- `atomicity.test.ts`, `schema.test.ts`, `crash.test.ts`, `posService.test.ts` (sales and voids
  unchanged — no sale, line or void path is touched).

**Windows installed-app gate**

- `e2e/product-management.mjs`: a real product create/edit/deactivate against the INSTALLED app, then
  the audit rows read back from the real `%APPDATA%` ledger — including after a restart;
- `e2e/upgrade.mjs` **scenario D**: install the build at `68fdf03` (current main, v4), make real
  sales and products, upgrade to this build, then assert v5, the sales and products survive, a NEW
  product mutation writes a durable audit row, and it is still there after a restart;
- the pre-migration backup `pre-migration-v4-to-v5-*.sqlite` exists and verifies;
- upgrades A, B and C stay green unchanged.

---

## 15 · Risks and contradictions found

1. 🔴 **`setActive` is untransactional today.** Fixing it is required, and it touches merged
   product-management code.
2. 🔴 **Per-row import audit forces a signature change to `applyImport`** — the only part of this
   that is a refactor rather than an addition. Fallback: summary-only import audit. §12.2.
3. 🔴 **`actor_tier` cannot be known in V1.** Recommending `'unspecified'` over `'cashier'`, because
   append-only means a wrong tier is permanent. Salman's decision.
4. 🔴 **Three audit rows per edit today.** Recommending one, with a partial JSON index replacing
   `PRICE_CHANGED` / `UNIT_CHANGED`. Salman's decision.
5. `occurred_at` is not a valid ordering key (injectable, frozen clock, multi-event operations).
   Resolved by `seq`; worth stating because it is easy to get wrong later.
6. `activate` overlaps with an edit that flips `is_active` — two event types for one business fact,
   through two real IPC channels. Keeping both, flagged.
7. The existing file-log audit sink: keep it as secondary support triage (it never throws, so it
   cannot endanger the transaction), but the **table becomes the record of truth**. Double-writing
   is deliberate, not an oversight.
8. `catalog_imports.cashier_id` has no `cashier_name`, so an import summary cannot name the operator
   from that table alone. The audit row's `actor_name` snapshot fixes it. Minor.
9. Triggers do not survive a determined human with the file (`DROP TABLE`, the `sqlite3` CLI). A
   hash chain would raise that bar and is not proposed. §4.

---

## 16 · FINAL CONTRACT — as decided and as built

Approved 2026-10-07. Where this section differs from §1–15 it wins, and the three real differences
are named here rather than quietly edited into the investigation.

### 16.1 · Fail closed on an unexpected field — CHANGED

The investigation said an unknown field would be **dropped** and the mutation would continue. It
does not. An unknown field, a credential-shaped key, a non-scalar value or a float now **THROWS**
(`AuditContractError`), inside the business transaction, so the mutation is rolled back.

Dropping was the wrong behaviour for exactly the reason the trail exists: the write would have
succeeded while its account of itself was quietly incomplete. `src/domain/audit.ts` is the single
place that decides, and the negative tests are in `tests/domain/auditPayload.test.ts`.

A credential-shaped key is checked **before** the allowlist, so the error names it as a credential
rather than merely as unknown. Every value must be a bounded scalar — no object, no array — which is
what makes it structurally impossible to nest a secret inside a payload.

### 16.2 · CSV import writes a COMPLETE entity audit — CHANGED

The investigation recommended summarising inserted rows. The decision is that provenance must be
**recorded, not inferred later** from `created_at`/`source`/`source_key`. So a successful import
writes:

```
1 × CATALOG_IMPORTED       entity_type 'catalog', entity_id = catalog_imports.id,
                           changed_json {}, bounded summary in metadata_json
N × PRODUCT_CREATED        one per newly inserted product, whole audited state, before = null
N × PRODUCT_UPDATED        one per product whose audited fields changed, with the OLD values
N × PRODUCT_DEACTIVATED    one per product the import dropped
0 ×                        for unchanged products
```

An initial 400-item import therefore writes **401** rows, and that is accepted: measured at ~450
bytes a row it is ~180 KB once, inside one transaction, which `synchronous = FULL` commits with a
single fsync. Asserted in `tests/application/auditImport.test.ts`.

**Correlation.** Every per-product import event carries
`metadata_json = {origin: "catalog_import", catalog_import_id, source}`, so the whole effect of one
import is one query. The summary carries `file_name`, `file_sha256`, `row_count`, `inserted`,
`updated`, `unchanged`, `deactivated` and `origin` — **never a CSV row and never the file**.

**The repository returns a change-set; it does not take a callback.** `applyImport` now returns
`{ counts, changes }`. A callback would have put arbitrary caller code inside the repository's
transaction and made the repository's behaviour depend on what it was handed.

### 16.3 · No specialized JSON index — CHANGED

The partial index on `json_extract(changed_json, '$.selling_price_minor')` is **not** created.
Migration 5 ships exactly the four general indexes. There is no audit query UI yet and no measured
query to tune; a later migration can add it on real evidence.

### 16.4 · Confirmed without change

- **No historical backfill.** The migration inserts nothing; a migrated ledger's trail is **empty**,
  and that is asserted. The rotating logfile is incomplete, is deleted on rotation, and was written
  after the business commit, so it is not trustworthy historical evidence. No pre-v5 history is
  fabricated.
- **The schema** of §4, as written, STRICT, no foreign key to an actor, UUID `id` + monotonic `seq`,
  `seq` as the only ordering authority, timestamp equality allowed.
- **Five event types.** `PRICE_CHANGED` and `UNIT_CHANGED` are **not** durable event types; they are
  fields inside `PRODUCT_UPDATED.changed_json`. One ordinary product edit is one row however many
  fields moved.
- **`updateProduct` vs `setProductActive` stay distinct.** An edit that flips `is_active` is
  `PRODUCT_UPDATED`; the list's dedicated toggle is `PRODUCT_ACTIVATED` / `PRODUCT_DEACTIVATED`.
  Two operator intents through two IPC channels. No IPC or API was redesigned.
- **`actor_tier = 'unspecified'`** for every current human action, because this build has no role
  model and a wrong tier would be permanent. `'system'` exists for future machine actions. Never
  rewritten.
- **Append-only** by `BEFORE UPDATE` / `BEFORE DELETE` triggers plus the monotonic-`seq` trigger. No
  hash chaining. The limit is documented truthfully: this protects the table against the
  application, not the file against its owner.
- **No pruning, no TTL, indefinite retention.**
- **`audit_events` added to the verified backup row-count contract**, with pre-v5 databases still
  working because `tableCounts()` skips a table that is not present.
- **Sales and voids are untouched.** `createSale` and `voidSale` write no audit event.

### 16.5 · The transaction integration, as built

```
PosService.transact(fn)  ->  db.transaction(fn).immediate()      ONE connection, the repositories'
  ├─ read the before state (inside the transaction, where required)
  ├─ the business mutation            (the existing repository method)
  ├─ build the deterministic event    (fails closed)
  └─ AuditRepository.append()         (allocates seq, inserts)
COMMIT
     then, outside:  refreshCatalogFromStore()  ·  the diagnostic logfile mirror
```

- `AuditRepository` has **no transaction of its own and no second connection**. Atomicity is real
  SQLite atomicity, not orchestration.
- `CatalogRepository.setActive` is still transaction-free **on purpose**: the whole
  `setProductActive` operation now runs under the service-owned transaction, which is what closes
  the atomicity hole. A narrower inner transaction would only have added a savepoint.
- `refreshCatalogFromStore()` runs **after** COMMIT. It is a cache, not a record; refreshing before
  would mean a rolled-back write had already replaced the catalog the till sells from.
- The logfile mirror runs after COMMIT and its throw is swallowed. Operational logging may never
  roll back or invalidate a business mutation that is already durable.
- 🔴 **Fail closed at the service boundary too:** a terminal that has `catalogStore` but no
  `auditStore`/`transact` refuses every product mutation (`NOT_AVAILABLE`). Reads still work. An
  unaudited edit is not a degraded mode; it is refused.
