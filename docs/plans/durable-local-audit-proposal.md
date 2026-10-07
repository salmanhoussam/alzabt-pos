# Proposal — a durable local audit ledger

| Field | Value |
|---|---|
| Status | ✅ **PRINCIPLE APPROVED, 2026-10-07. NOT implemented**, and explicitly **not in the same PR as quantity** — it is the PR after it. |
| Migration number | **5** — `DECISION — SALMAN 2026-10-07`: order locked, 4 = quantity, 5 = this. The file name stays unnumbered because the proposal, not the number, is what is retained. |
| Written | 2026-10-07 · reframed on Salman's review the same day |
| Blocks | Field release. Approved as required before one. |
| Does not block | The offline product-management PR, which ships with the hook already wired. |

## 1. What exists today, and why it is not enough

The product-management PR wires `PosServiceDeps.audit` and points it at the application log. Every
call site exists; only the sink is weak.

| | Application log (today) | This table (proposed) |
|---|---|---|
| Append-only | by convention | **enforced by triggers** |
| Queryable from the app | no | yes |
| Retained | until the log rotates or the profile is cleaned | with the ledger |
| Inside the verified backup | **no** | yes, once added to `COUNTED_TABLES` |
| Survives a reinstall | only if someone copied the folder | yes — it lives in the ledger file |
| Lost if the process dies at the wrong moment | **yes — see §9** | no |

## 2. Exact DDL

```sql
-- name: "audit_events"
--
-- Administrative actions by an operator. NOT the sales ledger, and NOT the future inventory
-- movement ledger: this records who changed MASTER DATA. Append-only, enforced by the database in
-- exactly the way migration 1 enforces it for sales.
CREATE TABLE audit_events (
  id          TEXT    PRIMARY KEY,
  at          TEXT    NOT NULL,
  actor_id    TEXT    NOT NULL CHECK (length(actor_id) > 0),
  actor_name  TEXT    NOT NULL CHECK (length(actor_name) > 0),
  actor_tier  TEXT    NOT NULL CHECK (actor_tier IN ('owner', 'admin', 'cashier', 'system')),
  action      TEXT    NOT NULL CHECK (action IN (
                        'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DEACTIVATED',
                        'PRODUCT_ACTIVATED', 'PRICE_CHANGED', 'UNIT_CHANGED', 'BARCODE_CHANGED',
                        'CATEGORY_CHANGED', 'CATALOG_IMPORTED', 'CATALOG_EXPORTED',
                        'STOCK_ADJUSTED', 'STOCK_COUNTED', 'CASHIER_CREATED', 'CASHIER_CHANGED',
                        'CASHIER_DEACTIVATED', 'VOID_AUTHORIZED', 'SETTINGS_CHANGED',
                        'BACKUP_EXPORTED')),
  entity_type TEXT    NOT NULL CHECK (entity_type IN ('product', 'catalog', 'stock', 'cashier', 'sale', 'settings')),
  entity_id   TEXT    NOT NULL CHECK (length(entity_id) > 0),
  source      TEXT    NOT NULL,
  changes     TEXT    CHECK (changes IS NULL OR json_valid(changes)),
  reason      TEXT    CHECK (reason IS NULL OR length(trim(reason)) > 0)
) STRICT;
```

## 3. Indexes

```sql
CREATE INDEX audit_events_at ON audit_events (at);                              -- "what happened yesterday"
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, at);  -- "this product's history"
CREATE INDEX audit_events_actor ON audit_events (actor_id, at);                 -- "what did this person do"
```

Three indexes on an append-only table cost three B-tree writes per event. At a shop's volume —
tens of administrative actions a day, against hundreds of sales — that is free.

## 4. Triggers — append-only, enforced by the database

```sql
CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: events are immutable'); END;
CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: events cannot be deleted'); END;
```

The same two triggers migration 1 puts on `sales`, `sale_lines` and `voids`. **No application code
can bypass them**, including ours.

## 5. Actor representation

`actor_id` + `actor_name` + `actor_tier`, **snapshotted**, with **no foreign key**.

- No FK, because a real cashier table does not exist yet — and even once it does, a renamed or
  removed cashier must not be able to rewrite who did what. `sales` already snapshots
  `cashier_id` + `cashier_name` for exactly this reason.
- `actor_tier` uses the platform's settled vocabulary — **owner** owns the shop, **admin** runs it,
  **cashier** holds a till — plus `system` for an action no human initiated. Today every operator is
  a fixture cashier, so the column would be written `'cashier'` until the permission model lands.
- 🔴 **Never** `pin`, `pin_hash`, a token or a secret. §7 is the rule and §11 is the test.

## 6. Before/after diff policy

`changes` is JSON TEXT holding **changed fields only**:

```json
{"selling_price_minor": {"before": "400", "after": "900"}}
```

- **Changed fields only** — never a whole-row copy, which would eventually carry a column nobody
  meant to audit.
- **Money as a decimal string of minor units**, never a number, so an audit record cannot be the one
  place a float appears.
- **A field absent from `changes` did not change.** No nulls standing for "unknown".
- A create records `{"before": null, "after": …}` for the fields that define the product; a
  deactivation records only `is_active`.
- `json_valid` is the database's half of the contract; the shape is the application's half.

## 7. Redaction rules

| Never stored | Reason |
|---|---|
| PIN, PIN hash, salt | Nothing operational needs them, and an audit table is read by support |
| Any token or key | Same |
| Customer phone or address *inside* `changes` | When the customer model lands, an audit event references a customer **by id**; the personal fields stay in their own table |
| A file's contents | An import records counts and the file's SHA-256, never rows |
| A full product row | §6 |

The rule is enforced by a test that walks every emitted event, not by review.

## 8. Retention policy

**Keep everything, and say who enforces that** — a policy with no named enforcer is not a policy.

- `audit_events` is **never pruned by the application.** It grows with the shop's administrative
  activity: a hundred events a day is under a megabyte a year, against a ledger measured in the same
  order. There is no trimming code to get wrong.
- It is inside the ledger, so `VACUUM INTO` backups carry it, daily snapshots keep 14 days of
  history, and pre-migration snapshots are never pruned.
- **If a shop ever needs it trimmed**, that is an explicit, separate, authorised operation on a
  dated backup — not a background job. Nothing in this proposal grants one.
- The application log stays as it is: useful, rotating, and **not** the record of account.

## 9. 🔴 Transaction relationship — the honest answer

> **Salman's requirement:** if a product price change succeeds, its audit record must not be
> silently lost. Does the product change and the audit append happen in the SAME SQLite transaction?

**Today: NO.** Measured, in the shipped PR:

```
posService.createProduct()
  └─ store.createManual(...)        ← its OWN transaction, BEGIN IMMEDIATE … COMMIT
  └─ this.record(...)               ← AFTER that commit, writes a log line
```

So if the process dies between the commit and the log write, **the product change survives and its
audit record does not.** The window is microseconds, the loss is silent, and it is real. The log
sink cannot fix it: a file write and a database commit cannot be one atomic operation.

**Proposed: YES, in one transaction**, and that is the main reason to build the table at all.

```
posService.createProduct()
  └─ store.createManual(input, auditEvent)
        BEGIN IMMEDIATE
          INSERT INTO catalog_products …
          INSERT INTO audit_events …        ← same transaction
        COMMIT
```

Consequences, each stated rather than discovered later:

1. **The audit event is built BEFORE the write**, so its `before` values come from the row that was
   read inside the same transaction — no second read, no race.
2. **A failed audit insert fails the whole operation.** A price change that cannot be recorded does
   not happen. That is the correct trade for a money-adjacent action, and it is a deliberate choice:
   the alternative — a change that silently loses its record — is what this section exists to kill.
3. **The repository signature changes** — every administrative method takes its audit event. That is
   a one-time, compile-checked change to three methods and their call sites.
4. **`CATALOG_IMPORTED` already works this way**: `applyImport` is one transaction, so its audit
   insert simply joins it.
5. **An action with no database write of its own** (`CATALOG_EXPORTED`, `BACKUP_EXPORTED`,
   `SETTINGS_CHANGED`) gets its own single-statement transaction. Nothing to be atomic with.

**Behaviour if the audit write fails**, by case:

| Case | Behaviour |
|---|---|
| Inside a mutation's transaction | The transaction rolls back. The operator sees a real error. **No change without its record.** |
| For a no-write action (export, backup) | Logged, never fatal — the backup itself is the valuable thing and it already succeeded. |
| The ledger is read-only or the disk is full | The mutation was already going to fail; the audit insert fails with it, for the same reason. |
| Before the table exists (an older ledger) | Cannot happen: the table arrives in a migration, and a migration that has not run means the build does not know about the table either. |

## 10. The three design choices, restated for challenge

1. **Future actions are already in the CHECK list.** A shipped CHECK cannot be edited, so omitting
   them would force a later migration that only widens a list. They are inert until something writes
   them. *The cost: the list names actions that do not exist yet, which reads oddly.*
2. **No foreign key to a cashier** — §5. *The cost: an `actor_id` can name someone who no longer
   exists, which is the point.*
3. **No `before_row` / `after_row`** — §6. *The cost: reconstructing a full historical row means
   replaying its diffs.*

## 11. Tests the migration ships with

| # | Test |
|---|---|
| 1 | Applying the migration to the current ledger leaves `sales`, `sale_lines`, `voids` and `catalog_products` byte-identical (SHA-256 fingerprint before/after) |
| 2 | `UPDATE` on an event throws `/immutable/` — asserted against the **database** |
| 3 | `DELETE` on an event throws `/cannot be deleted/` |
| 4 | A malformed `changes` is refused (`json_valid`) |
| 5 | An action outside the CHECK list is refused |
| 6 | An empty `actor_id` or `actor_name` is refused |
| 7 | 🔴 **One transaction:** a forced failure of the audit insert leaves **no** product row — proven by counting rows after the error, not by reading the code |
| 8 | 🔴 **No secret, ever:** every emitted event's serialised JSON contains no `pin`, `hash`, `token` or the fixture PIN. **This test already exists and passes** in `tests/application/productManagement.test.ts` |
| 9 | A create/edit/deactivate sequence writes exactly the expected events, in order, with the expected diffs |
| 10 | `audit_events` is in `backup.ts`'s `COUNTED_TABLES`, and a backup's verification counts it — otherwise a backup would be "verified" without looking at the new table |
| 11 | The upgrade path is added to the Windows CI upgrade matrix, beside the two already there |

## 12. Decision required

```
[ ] Approve the DDL above as written
[ ] Approve with changes (say which)
[ ] Defer — keep the log sink, accepting the §9 loss window until a later gate
```

And separately, because it decides this table's number:

✅ **Answered 2026-10-07: quantity first (migration 4), audit second (migration 5).**

My §9 argued for audit first — purely additive, no rollback risk, and it closes the loss window
sooner. Salman's order stands, and the argument against mine is the stronger one: the loss window is
microseconds wide and the rotating log catches everything outside it, while the quantity rebuild is
what the shop's actual invoice needs. **The principle below is what was approved, not the schedule.**

### What was approved, verbatim

> A business mutation and its durable audit event must commit in the SAME SQLite transaction.
> If the audit insert fails, the price change fails. No silent unaudited administrative mutation.
> The rotating application log remains observability only. It is not the durable audit ledger.
