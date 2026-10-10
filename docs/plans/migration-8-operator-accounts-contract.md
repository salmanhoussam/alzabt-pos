# Migration 8 — Operator accounts + role-based authorization · CONTRACT

> **STATUS: CONTRACT FOR REVIEW. MIGRATION 8 IS NOT WRITTEN.**
> Prepared 2026-10-10 against `b18b5b4`, after Salman approved the business decisions. Every schema
> claim is measured against the real `src/persistence/migrations.ts`; the SQL below is a **proposal**
> and exists nowhere in the codebase.
>
> Reserved scope: **operator accounts and role-based authorization only.** No Payment Settlement, no
> Category, no Product Photo, no Incoming Invoice. `admin` stays reserved and unused.

---

## 0 · The measurement that sets this migration's cost

Two facts decide most of what follows.

**🔴 `audit_events` must be REBUILT, not altered.** Three of its CHECK constraints name
`event_type` or `entity_type`, and SQLite cannot alter a CHECK in place:

```sql
event_type  TEXT NOT NULL CHECK (event_type IN ('PRODUCT_CREATED', …, 'CATALOG_IMPORTED'))  -- :260
entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'catalog'))                     -- :263
CHECK ((entity_type = 'product' AND event_type IN (…)) OR (entity_type = 'catalog' AND …))   -- :284
```

**But the rebuild is the CHEAP kind.** `grep "REFERENCES audit_events"` returns **zero** — it is a
**leaf table**, like `sale_lines` in migration 4 and unlike `sales` in migration 7. So migration 7's
most expensive lesson does not apply here: there is no child table whose rows make `DROP TABLE`
count deferred foreign-key violations. This is a plain create-copy-drop-rename.

Its three triggers and four indexes must be recreated, and `DROP TABLE` does not fire a
`BEFORE DELETE` trigger — the same fact migrations 4 and 7 both relied on, so the append-only rule
does not block its own table's replacement.

**🔴 The ledger does not reference operators at all.** `sales.cashier_id`, `sales.cashier_name`,
`voids.cashier_id`, `voids.cashier_name` are plain `TEXT NOT NULL` with **no `REFERENCES`**
(`:602-603`, `:63-64`). Every sale carries its own cashier **snapshot**. Therefore:

- no backfill of any ledger row,
- no foreign key added to any ledger table,
- old `cashier-01` / `cashier-02` references stay meaningful **because the id is preserved**, not
  because anything points at a row.

---

## 1 · `operators` table shape

```sql
CREATE TABLE operators (
  id             TEXT    PRIMARY KEY,
  -- The operator's own name. Starts as the fixture's English name and is replaced during the
  -- mandatory first-run setup.
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  role           TEXT    NOT NULL CHECK (role IN ('owner', 'admin', 'cashier')),
  -- scrypt, per-operator salt. Hex, exactly as the fixture already stores them, so the two
  -- migrated accounts need no re-hashing and no plaintext ever exists.
  pin_salt_hex   TEXT    NOT NULL CHECK (length(pin_salt_hex) BETWEEN 16 AND 64),
  pin_hash_hex   TEXT    NOT NULL CHECK (length(pin_hash_hex) = 64),
  -- 🔴 1 means the stored PIN is a LEGACY BOOTSTRAP credential: it authenticates ONLY into the
  -- mandatory setup flow and is replaced there. It is not a "please change your password" nag.
  must_reset_pin INTEGER NOT NULL CHECK (must_reset_pin IN (0, 1)),
  is_active      INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;

-- Two operators must not share a display name: an audit row naming "أحمد" has to identify one
-- person. Case/१space-insensitivity is NOT attempted in SQL — `trim` is as far as a CHECK can
-- honestly go, and the service normalises before it writes.
CREATE UNIQUE INDEX operators_name ON operators (name);
CREATE INDEX operators_active ON operators (is_active, role);
```

**`role` admits `admin` although v1 never writes it.** Deliberate, and it costs nothing: a CHECK
cannot be extended later without rebuilding this table, so admitting the reserved value now is the
difference between a future config change and a future migration. `actor_tier` already made exactly
this choice and is the reason the audit half is nearly free.

**No `deleted_at`.** Operators are never deleted; `is_active = 0` is the whole lifecycle, for the
same reason products deactivate — a past sale names this person and that name must stay resolvable.

**Decisions deliberately NOT encoded in SQL**, because a CHECK sees only its own row and cannot see
the table:

- "the last active owner cannot be deactivated or demoted"
- "an operator cannot change their own role"

Both are **service** invariants with their own tests. A trigger could express the first
(`audit_events_seq_monotonic` is the precedent for a cross-row rule) and is deliberately **not**
proposed: it would have to fire on UPDATE of a mutable table, and a shop locked out of its own
terminal by a trigger it cannot see is a worse failure than a refused service call.

### `cashier_pin_state` — left exactly as it is

Keyed by `cashier_id TEXT PRIMARY KEY`, no foreign key. **No change, and no FK added.** Reasons,
both real: the lockout row for an operator who is later deactivated should survive (deleting it
would reset their failure count as a side effect), and adding an FK to a mutable operational table
buys nothing the service does not already guarantee. The existing lockout mechanism is preserved
untouched — `PIN_LOCKOUT_POLICY` (5 failures, 5 minutes) applies to every operator, new ones
included, with no code change.

---

## 2 · Migration SQL — proposal

```sql
-- ── Migration 8 · operator_accounts (PROPOSAL — NOT WRITTEN, NOT APPROVED) ─────────────────────

-- 1 · Operators.
CREATE TABLE operators ( …as §1… ) STRICT;
CREATE UNIQUE INDEX operators_name ON operators (name);
CREATE INDEX operators_active ON operators (is_active, role);

-- 2 · The two fixture accounts become real rows, KEEPING THEIR IDS.
--
-- 🔴 The hashes are carried across as LEGACY BOOTSTRAP credentials with must_reset_pin = 1. They
-- are not copied because they are good — they are 1111 and 2222 and are published in this
-- repository — but because an upgrade must not lock a shop out of its own terminal. They
-- authenticate into the setup flow and nothing else, and stop working the moment it completes.
--
-- The literal hashes are written here rather than read from the fixture: a migration's SQL must
-- mean the same thing for ever, and a TypeScript constant can be edited.
INSERT INTO operators (id, name, role, pin_salt_hex, pin_hash_hex, must_reset_pin, is_active,
                       created_at, updated_at)
VALUES
  ('cashier-01', 'Cashier One', 'owner',
   'a1f3c9e27b4d6058', 'a8f8c45b97712daec733a8b4d198ac96376c05697b5935a7b30f965e27478bce',
   1, 1, :now, :now),
  ('cashier-02', 'Cashier Two', 'cashier',
   '5c8e01d7f9a3b264', '0ca57b50d33e8f2f395a2a636e8babd96c096120e439cc069d17a6586fb90537',
   1, 1, :now, :now);

-- 3 · audit_events: REBUILT, because three CHECKs name event_type/entity_type and SQLite cannot
--     alter a CHECK. It is a LEAF table (zero REFERENCES), so this is migration 4's simple
--     pattern, not migration 7's. Indexes and triggers are recreated AFTER the copy, so the
--     monotonic-seq trigger does not fire once per historical row.
CREATE TABLE audit_events_v8 (
  …every column exactly as migration 6 wrote it…,
  event_type  TEXT NOT NULL CHECK (event_type IN
                ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
                 'CATALOG_IMPORTED',
                 -- added by migration 8
                 'OPERATOR_CREATED', 'OPERATOR_RENAMED', 'OPERATOR_PIN_RESET',
                 'OPERATOR_ACTIVATED', 'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'catalog', 'operator')),
  …,
  CHECK (
    (entity_type = 'product'  AND event_type IN ('PRODUCT_CREATED', 'PRODUCT_UPDATED',
                                                 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED'))
    OR (entity_type = 'catalog'  AND event_type = 'CATALOG_IMPORTED')
    OR (entity_type = 'operator' AND event_type IN ('OPERATOR_CREATED', 'OPERATOR_RENAMED',
                                                    'OPERATOR_PIN_RESET', 'OPERATOR_ACTIVATED',
                                                    'OPERATOR_DEACTIVATED', 'OPERATOR_ROLE_CHANGED'))
  )
) STRICT;

INSERT INTO audit_events_v8 SELECT * FROM audit_events ORDER BY seq;   -- nothing transformed
DROP TABLE audit_events;                                              -- no BEFORE DELETE fires
ALTER TABLE audit_events_v8 RENAME TO audit_events;

CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, seq DESC);
CREATE INDEX audit_events_type   ON audit_events (event_type, seq DESC);
CREATE INDEX audit_events_actor  ON audit_events (actor_id, seq DESC);
CREATE INDEX audit_events_date   ON audit_events (business_date, seq DESC);
CREATE TRIGGER audit_events_immutable_update … ;   -- all three, verbatim from migration 6
CREATE TRIGGER audit_events_immutable_delete … ;
CREATE TRIGGER audit_events_seq_monotonic   … ;
```

**🔴 `actor_tier` is NOT touched and NOT backfilled.** Every historical row stays `unspecified`,
for ever, exactly as `src/domain/audit.ts:57-67` promised when it chose that value. Real tiers begin
**prospectively**. History will contain a visible boundary and that is the truthful outcome.

**Nothing is invented for historical rows.** `INSERT … SELECT *` with no transformation, which is
also why the new CHECKs cannot fail the upgrade: every existing row is `product`/`catalog`, and
those branches are unchanged.

---

## 3 · Bootstrap / first-run behaviour

```
login(cashier-01, "1111")
  → PIN matches, and must_reset_pin = 1
  → NO POS session is opened. this.cashier stays null.
  → a one-time SETUP TICKET is returned instead: { operatorId, role }
  → the renderer shows mandatory setup, not the till:
        real name   (required, non-empty, unique)
        new PIN     (4–8 digits, entered twice, equal)
  → completeOperatorSetup(ticket, name, newPin):
        writes name, new salt + scrypt hash, must_reset_pin = 0, updated_at
        clears cashier_pin_state for that operator
        writes OPERATOR_RENAMED + OPERATOR_PIN_RESET  (actor = the operator, tier = their role)
        THEN opens the normal session
  → login(cashier-01, "1111") now FAILS. The legacy credential is gone, not deprecated.
```

Properties this shape guarantees, each of which is a stated requirement:

- The owner **cannot** reach any normal action before resetting: no session exists until setup
  completes, so `requireCashier()` refuses everything — not a UI redirect that a reload defeats.
- The legacy PIN is **overwritten**, so "never authenticates again" is a consequence of the data,
  not a flag that something must remember to check.
- `1111` / `2222` are never ordinary live credentials: they exist only as the one-time door into
  setup.
- **Lockout still applies to the legacy credential**, so the bootstrap window is not an unlimited
  guessing oracle.

Two refusals worth stating: there is **no skip**, and there is **no "remind me later"**. And the
setup flow never displays the old PIN, because with a scrypt hash there is nothing to display.

---

## 4 · Audit event CHECK changes — the measured minimum

| Needed | In the CHECK today? |
| :--- | :--- |
| `OPERATOR_CREATED` `OPERATOR_RENAMED` `OPERATOR_PIN_RESET` `OPERATOR_ACTIVATED` `OPERATOR_DEACTIVATED` `OPERATOR_ROLE_CHANGED` | ❌ all six — `event_type` is a closed list of five |
| `entity_type = 'operator'` | ❌ — closed list of `product`, `catalog` |
| the entity/event pairing branch for operators | ❌ |
| `actor_tier IN ('owner','cashier')` | ✅ **already admitted** — no change |

So **three CHECKs change, in one rebuild**, and the actor-tier vocabulary needs nothing. All six
event types are required by the approved lifecycle; none is speculative.

**PIN material never enters an audit row.** `OPERATOR_PIN_RESET` records *that* a reset happened,
by whom, to whom, and when. `changed_json` for it carries `{}`-equivalent field names only — never
a salt, never a hash, never a PIN. The logger's redaction (`logger.ts:20`) does not protect an audit
row, because an audit row is not a log and is kept for ever.

---

## 5 · Service authorization matrix

Mapped onto the **46 real IPC channels**, because that is the authoritative path. UI hiding is
convenience; this table is the control.

| Channel(s) | owner | cashier | no session |
| :--- | :---: | :---: | :---: |
| `listCashiers` `login` `logout` `currentCashier` | ✅ | ✅ | ✅ |
| `getAppInfo` `getSettings` `setTerminalLanguage` | ✅ | ✅ | ✅ |
| `getCatalog` `createSale` | ✅ | ✅ | ❌ |
| `getTodaySales` `getSaleHistory` | ✅ | ✅ | ❌ |
| `listProducts` | ✅ | ✅ | ❌ |
| **`voidSale`** | ✅ | ❌ | ❌ |
| **`createProduct` `updateProduct` `setProductActive`** | ✅ | ❌ | ❌ |
| **`importCatalog` `exportCatalog`** | ✅ | ❌ | ❌ |
| **`exportBackup`** | ✅ | ❌ | ❌ |
| **`getCompanyProfile` `saveCompanyProfile` `setNextInvoiceNumber` `pickInvoiceLogo`** | ✅ | ❌ | ❌ |
| **`resolveCreateProduct` `resolveUpdateCatalog`** | ✅ | ❌ | ❌ |
| `resolveKeepCatalog` `resolveKeepInvoiceOnly` `resolveLinkProduct` `listReconciliation` `listReconciliationQueue` | ✅ | ❌ | ❌ |
| Invoice workflow — `createInvoiceDraft` `getInvoice` `updateInvoiceHeader` `setInvoiceTax` `addInvoiceLine` `addInvoiceLines` `updateInvoiceLine` `removeInvoiceLine` `discardInvoiceDraft` `finalizeInvoice` `listInvoices` `listInvoiceDrafts` `findInvoiceByNumber` `searchInvoices` `printInvoice` `saveInvoicePdf` | ✅ | ✅ | ❌ |
| **Operator management** (new channels) | ✅ | ❌ | ❌ |

**Three judgement calls, flagged rather than buried:**

1. **Invoices are cashier-allowed**, per *"use normal daily invoice creation if current workflow
   requires it"* — and it does: `e2e/manual-invoice.mjs` drives the whole flow as a cashier today.
   But note the consequence honestly: a finalized invoice **is a sale** since migration 7, and
   `setNextInvoiceNumber` / `saveCompanyProfile` are owner-only, so a cashier can issue documents
   under the shop's identity but cannot change that identity or the numbering.
2. **`getCompanyProfile` is owner-only**, which is stricter than "settings are owner-only" strictly
   requires. It carries the taxpayer, commercial-register and VAT numbers. If the invoice sheet
   needs the issuer name for a cashier-created draft, that must come through the invoice DTO (which
   already carries `issuer`), **not** by loosening this.
3. **Reconciliation is entirely owner-only**, including the read-only `listReconciliation`. The
   approved rule restricts "reconciliation actions that create/change catalog products"; restricting
   the queue too is my recommendation because a cashier who can see the queue but resolve nothing is
   a dead end. **Decision required** if you want the queue visible to a cashier.

**Enforcement point.** One guard in `ipcHandlers.ts`'s existing `wrap`/`wrapAsync`, declared as a
per-channel table so the matrix is **data, not scattered `if`s** — the same shape as
`CHANNEL_NAMES`, and the reason the smoke test's hand-written surface list keeps catching real
mistakes. A channel added without a matrix entry must **fail closed** (refused) and a unit test
asserts the table covers every channel in `CHANNELS`.

---

## 6 · Whether existing service APIs must change

| Item | Change |
| :--- | :--- |
| `PosServiceDeps.cashiers: ReadonlyArray<CashierFixture>` | **→ a repository reader.** Used in exactly two places (`posService.ts:197`, `:206`), so this is a dependency swap; the lockout logic, constant-time compare and error messages are untouched. |
| `login(cashierId, pin): Cashier` | **Return type changes** — it may now answer "setup required" instead of a session. The one genuinely breaking signature. |
| `CashierDto { id, name }` | **+ `role`**, so the UI can hide what the service will refuse anyway. Additive. |
| `listCashiers()` | Must return **active** operators only. Behaviour change: an inactive operator disappears from the login screen. |
| `requireCashier()` | Unchanged. Gains a sibling `requireOwner()`. |
| `cashierAuth.pinMatches` | Unchanged — it already takes a record with salt+hash, which an `operators` row satisfies. |
| `CURRENT_ACTOR_TIER` | **Deleted.** Once the app knows the tier, a constant asserting it does not know is the lie. |
| `FIXTURE_CASHIERS` | Kept for **tests only**, and must stop being wired into `main.ts:525`. |
| `cashier_pin_state` / `PIN_LOCKOUT_POLICY` | Unchanged. |
| New channels | `listOperators` `createOperator` `renameOperator` `resetOperatorPin` `setOperatorActive` `setOperatorRole` `completeOperatorSetup` — **7 new**, so `CHANNEL_NAMES` goes 46 → 53 and the smoke suite's hand-written `window.pos` list must name each one. |

**The 4–8 digit rule moves into the domain.** Today it exists only in `LoginScreen.tsx:10-11`; the
IPC boundary accepts 16 characters of anything (`ipcHandlers.ts:252`). A new `domain/pinRule.ts`
owns it — **digits only, 4–8** — enforced on every write path (setup, reset, create). The renderer
keeps its own copy as UX, which is now a *convenience* rather than the only rule.

🔴 **One consequence to accept consciously:** the two legacy PINs are 4 digits and pass the new
rule, so the rule does not reject them. What stops them being live credentials is
`must_reset_pin`, not their shape.

---

## 7 · Upgrade and rollback implications

**Forward.** v7 → v8 on a real installation: one pre-migration backup (automatic,
`createPreMigrationBackup`), one new table, two inserted rows, one leaf-table rebuild. No ledger row
read or written. The new CHECKs cannot fail the upgrade, because every existing audit row is
`product`/`catalog` and those branches are unchanged — and if one somehow did, the migration
**ABORTS** and the v7 database is untouched, which is the correct outcome.

**🔴 Rollback stops being free, and this is the first time in this product's history.** Every
installer from `f090ad9` to `b18b5b4` is schema **v7**, so rolling back needed no database
downgrade. A v8 database **cannot** be opened by a v7 build (`schemaVersion` guard), so:

> After Migration 8 ships, rolling back to any current installer requires **restoring the
> automatic pre-migration backup**, not merely reinstalling the old EXE.

That must be written into the release note before the installer goes near the shop, because every
rollback so far has been "install the old EXE" and this one is not.

**And `must_reset_pin` makes the rollback window narrow in practice.** If the owner completes setup
on v8 and the shop then rolls back to v7, the v7 build reads its hashes from
`FIXTURE_CASHIERS` — so the old `1111` works again and the new PIN does not. Restoring the
pre-migration backup is therefore the *only* coherent rollback, not just the supported one.

---

## 8 · E2E scenarios — the twelve required proofs

Installed-app, Windows, in `e2e/operator-accounts.mjs` (new) plus one upgrade phase. Numbered as
approved:

| # | Proof | How |
| :--- | :--- | :--- |
| 1 | old `cashier-01`/`cashier-02` ledger references stay valid | seed a v7 ledger with a sale + void by each, upgrade, read `sales.cashier_id`/`voids.cashier_id` with the app closed — byte-identical |
| 2 | both accounts exist after migration | `SELECT id, role FROM operators` |
| 3 | `cashier-01` is OWNER | same read |
| 4 | `cashier-02` is CASHIER | same read |
| 5 | both require reset | `must_reset_pin = 1` on both |
| 6 | the legacy PIN reaches **only** the reset flow | login `1111` → the setup screen renders and `[data-testid="cart"]` never appears |
| 7 | after reset the old PIN fails | complete setup, logout, login `1111` → refused |
| 8 | the new PIN works | login with it → the till opens |
| 9 | **permissions are enforced server-side** | as a cashier, call `voidSale` / `createProduct` / `exportBackup` **through the IPC bridge directly** (`page.evaluate` on `window.pos`), not by clicking — each must return a refusal, and the ledger must show no change |
| 10 | an inactive operator cannot log in | owner deactivates `cashier-02`; it vanishes from `listCashiers` **and** a direct `login` call is refused |
| 11 | the last owner cannot be deactivated or demoted | direct `setOperatorActive` / `setOperatorRole` calls on the sole owner → refused, state unchanged |
| 12 | historical sales/void/audit data unchanged | hash the relevant rows before and after the upgrade and compare; `actor_tier` of every pre-v8 row is still `unspecified` |

**#9 is the one that must not be written lazily.** Clicking a hidden button proves nothing — the
approved rule is explicit that hiding is not protection. The assertion has to go through
`window.pos` so it exercises the authoritative path, which is exactly how the existing smoke suite
already reads that surface.

Plus, from the standing lessons of this branch: a new row's unit control and a changed login screen
both invalidate every surface a test reads, so the **upgrade suite must ask which login flow exists**
rather than assume, since it drives two builds.

---

## 9 · What is NOT in this contract

- **Owner PIN override — DEFERRED.** No two-actor void authorization, no `voids` column, no
  `VOID_AUTHORIZED` event type, and Migration 8 is **not** expanded for it. In v1 a restricted
  action requires an owner session. Recorded as a later feature whose own contract must define
  two-actor audit evidence before any schema changes.
- `admin` as a usable role.
- Per-operator permission editing.
- Payment Settlement, Category, Product Photo, Incoming Invoice.
- Any cloud or multi-terminal identity.
- Historical `actor_tier` backfill.
- Auditing failed logins — noted in the study as the most useful missing security signal, and
  **out of scope here** so it does not quietly widen the audit rebuild.

---

## 10 · Open decisions before Migration 8 is written

1. **Reconciliation queue visibility** (§5, call 3): owner-only including the read, or should a
   cashier see the queue they cannot resolve? My recommendation is owner-only.
2. **`getCompanyProfile` for cashiers** (§5, call 2): confirm that the invoice sheet's issuer comes
   from the invoice DTO, so this stays owner-only.
3. **Release-note wording for the rollback change** (§7) — the first schema bump that makes
   "reinstall the old EXE" insufficient. This needs to be agreed before the installer is built, not
   after.
