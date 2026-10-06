# Proposal — migration 4: `audit_events`

| Field | Value |
|---|---|
| Status | **PROPOSAL — NOT APPLIED.** Salman asked to be shown the exact schema before it is created. |
| Written | 2026-10-07 |
| Migration number | **4** — the next free number. Migrations 1–3 are shipped, checksummed and untouched. |
| Depends on | Nothing. It is purely additive: one new table, two triggers, two indexes. |

## Why a table, when the audit already works

The offline product-management PR wires an audit **hook** (`PosServiceDeps.audit`) and points it at
the application log, so "who changed this item's price" is answerable **today**, from
`%APPDATA%\Alzabt POS\logs\`, with no schema change. Every call site already exists.

What the log cannot do, stated plainly:

| | Log file (today) | `audit_events` (this proposal) |
|---|---|---|
| Append-only | by convention | **enforced by triggers** |
| Queryable from the app | no | yes |
| Retained | until the log is rotated or the profile is cleaned | with the ledger, backed up by `VACUUM INTO` |
| Survives a reinstall | only if someone copied the folder | yes — it is in the ledger file |
| Inside the verified backup | no | **yes**, once added to `COUNTED_TABLES` |

So the hook is the right shape and the sink is the weak part. This migration replaces the sink.

## The exact schema

```sql
-- migration 4, name: "audit_events"
--
-- Administrative actions by an operator. This is NOT the sales ledger and NOT the future inventory
-- movement ledger: it records who changed MASTER DATA. Append-only, enforced by the database in
-- exactly the way migration 1 enforces it for sales.
--
-- `changes` is JSON TEXT and holds CHANGED FIELDS ONLY, as {"field":{"before":…,"after":…}} —
-- never a whole row, and never a PIN, a PIN hash, a token or any secret. STRICT keeps the column
-- types honest; SQLite has no JSON type, so the shape is the application's contract and the
-- `json_valid` check is the database's half of it.
CREATE TABLE audit_events (
  id          TEXT    PRIMARY KEY,
  at          TEXT    NOT NULL,
  actor_id    TEXT    NOT NULL CHECK (length(actor_id) > 0),
  actor_name  TEXT    NOT NULL CHECK (length(actor_name) > 0),
  action      TEXT    NOT NULL CHECK (action IN (
                        'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DEACTIVATED',
                        'PRODUCT_ACTIVATED', 'PRICE_CHANGED', 'UNIT_CHANGED', 'BARCODE_CHANGED',
                        'CATALOG_IMPORTED', 'STOCK_ADJUSTED', 'CASHIER_CHANGED', 'VOID_AUTHORIZED')),
  entity_type TEXT    NOT NULL CHECK (entity_type IN ('product', 'catalog', 'stock', 'cashier', 'sale')),
  entity_id   TEXT    NOT NULL CHECK (length(entity_id) > 0),
  source      TEXT    NOT NULL,
  changes     TEXT    CHECK (changes IS NULL OR json_valid(changes)),
  reason      TEXT    CHECK (reason IS NULL OR length(trim(reason)) > 0)
) STRICT;

CREATE INDEX audit_events_at ON audit_events (at);
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, at);

-- Append-only, the same way the ledger is: the DATABASE refuses, not the code.
CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: events are immutable'); END;
CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit: events cannot be deleted'); END;
```

Three deliberate choices worth challenging if you disagree:

1. **Future actions are already in the CHECK list** (`BARCODE_CHANGED`, `STOCK_ADJUSTED`,
   `CASHIER_CHANGED`, `VOID_AUTHORIZED`). A shipped CHECK cannot be edited, so leaving them out
   would force a migration 5 that only widens a list. They are inert until something writes them.
2. **No foreign key to a cashier**, because a real cashier table does not exist yet (that is a later
   PR). `actor_id` plus `actor_name` is snapshotted exactly as `sales` already does, so a renamed or
   removed cashier cannot rewrite history.
3. **No `before_row` / `after_row`.** A full-row copy would eventually carry a column nobody meant
   to audit. Changed fields only.

## Append-only protection, and how it is proven

| Protection | Proven by |
|---|---|
| `UPDATE` refused | a test asserting `/immutable/` is thrown — the same assertion style as `tests/persistence/schema.test.ts:101` |
| `DELETE` refused | a test asserting `/cannot be deleted/` |
| A malformed `changes` refused | `json_valid` — a test inserting `'{oops'` |
| An unknown action refused | the CHECK list — a test inserting `'PRODUCT_RENAMED'` |
| An empty actor refused | `length(actor_id) > 0` |
| 🔴 **No secret can be stored** | a test that walks every emitted event and asserts the serialised JSON contains no `pin`, `hash`, `token` or the fixture PIN — this test **already exists and passes** in `tests/application/productManagement.test.ts` |

## Tests the migration ships with

1. Migration 4 applies to a v3 ledger and leaves `sales`, `sale_lines`, `voids` and
   `catalog_products` byte-identical (fingerprint before/after).
2. The five refusals above, each asserted against the **database**, not the service.
3. A product create/edit/deactivate writes exactly the expected events, in order.
4. `audit_events` is added to `backup.ts`'s `COUNTED_TABLES`, and a backup's verification counts it —
   otherwise a backup would be "verified" without looking at the new table, which is the silent hole
   this kind of change creates.
5. The v3 → v4 upgrade is added to the Windows CI upgrade matrix, like the two paths already there.

## What this proposal does NOT do

It does not change any product-management behaviour. The hook, its call sites and its payload stay
exactly as they are in the offline product-management PR; only the sink changes from the log file to
the table, in one place.

## Decision required

```
[ ] Approve migration 4 exactly as written above
[ ] Approve with changes (say which)
[ ] Defer — keep the log-file sink for now
```
