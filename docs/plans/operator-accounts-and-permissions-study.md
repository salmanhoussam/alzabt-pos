# Cashier / Owner access control — the current contract, measured

> **Status: STUDY ONLY. Nothing implemented, nothing approved.**
> Written 2026-10-10 against `b18b5b4`. Every claim below is a real read of this repository, with
> the file and line that proves it. Where a migration is needed it is named and **not written**.

---

## 1 · Current operator / PIN schema

**There is no operator table. The cashiers are compiled into the build.**

`src/fixtures/cashiers.ts` is a frozen TypeScript array, and it is the entire account store:

```ts
export const FIXTURE_CASHIERS: ReadonlyArray<CashierFixture> = [
  { id: "cashier-01", name: "Cashier One", pinSaltHex: "a1f3…", pinHashHex: "a8f8…" },
  { id: "cashier-02", name: "Cashier Two", pinSaltHex: "5c8e…", pinHashHex: "0ca5…" },
];
```

Its own header says what it is: *"Bundled TEST cashiers for Gate 1. NOT real accounts."*

The **only** account-related table in the database is lockout state, and it holds no name and no
PIN (`migrations.ts:96`, migration 2):

```sql
CREATE TABLE cashier_pin_state (
  cashier_id      TEXT    PRIMARY KEY,
  failed_attempts INTEGER NOT NULL CHECK (failed_attempts >= 0),
  locked_until    TEXT,
  updated_at      TEXT    NOT NULL
) STRICT;
```

Its `cashier_id` is a bare primary key with **no foreign key** — it references an id that exists
only in source code.

**A seam that matters for cost.** `PosService` receives the cashiers as an injected dependency
(`posService.ts:62`, `readonly cashiers: ReadonlyArray<CashierFixture>`) and uses them in exactly
two places — `listCashiers()` (`:197`) and `login()` (`:206`). So replacing the fixture with a
repository is a **dependency swap**, not a login rewrite: the lockout policy, the constant-time
compare and the error messages are untouched.

**And the ledger does not depend on it either.** `sales.cashier_id` / `sales.cashier_name` and
`voids.cashier_id` / `voids.cashier_name` are plain `TEXT NOT NULL` with **no `REFERENCES`**
(`migrations.ts:602-603`, `:63-64`). Every past sale carries its own cashier *snapshot*, so
introducing real accounts needs **no backfill and no foreign key on any ledger table** — the same
snapshot discipline that already protects a past sale from a renamed product.

---

## 2 · Current PIN storage security — already correct

This is the one part that needs no change.

| Property | Evidence |
| :--- | :--- |
| Hashed, never plaintext | `cashierAuth.ts:18` — `scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 })` |
| Per-cashier salt | `pinSaltHex` differs per fixture |
| Constant-time compare | `cashierAuth.ts:19` — `timingSafeEqual(actual, expected)` |
| Never logged — actively redacted | `logger.ts:20` — `const SECRET_KEY = /pin\|password\|passwd\|token\|secret\|credential\|^key$\|apikey\|api_key/i` |
| Payloads not logged on success | `ipcHandlers.ts:217-228` — `wrap` logs only on an internal error, and logs `{channel, error}`, never the payload |
| Bounded at the boundary | `ipcHandlers.ts:252` — `str(o.pin, "pin", 16)` |
| Brute force | `pinLockout.ts` policy, enforced inside the same transaction as the attempt (`posService.ts:211`) |

🔴 **One real gap, and it becomes load-bearing the moment operators can set their own PIN.** The
**4–8 digit rule does not exist in the service.** It lives only in the renderer
(`LoginScreen.tsx:10-11`, `PIN_MAX = 8` / `PIN_MIN = 4`); the IPC boundary accepts up to **16**
characters of anything. Today that is harmless, because no PIN can be set at runtime. If an owner
can set a PIN, a rule enforced only by the keypad that typed it is not a rule — it has to move into
the domain, where a reset path, a seed script and a future API all meet it.

---

## 3 · Are operator names / PINs configurable today?

**No. Changing either requires editing source, rebuilding, and reinstalling.**

- Zero management channels: `grep -ciE "createCashier|updateCashier|setPin|resetPin|deactivateCashier"`
  over `src/shared/ipcContract.ts` returns **0**.
- `listCashiers` is read-only (`ipcHandlers.ts:246`).
- `ToolsScreen.tsx` has no operator UI at all — it is catalog import/export, backup, and build
  identity.
- So the shop currently runs on two accounts named **"Cashier One"** and **"Cashier Two"**, in
  English, with PINs `1111` and `2222` **documented in the repository** because they were only ever
  meant to be test fixtures.

That last point is the actual field problem, stated plainly: the shop has no private PIN today, and
the PINs it does have are public.

---

## 4 · Do roles or permissions exist today?

**In code: none.** And the codebase says so itself rather than leaving it to be discovered —
`src/domain/audit.ts:59`:

> *"This build has NO role or permission model: `Cashier` is `{ id, name }`, the cashiers are a
> TypeScript fixture, and nothing anywhere distinguishes an owner from a till operator."*

**In the schema: the column already exists.** `audit_events` (`migrations.ts:267-268`) carries:

```sql
actor_tier TEXT NOT NULL CHECK (actor_tier IN ('owner', 'admin', 'cashier', 'system', 'unspecified'))
```

and every row written today is `unspecified` (`CURRENT_ACTOR_TIER`, `audit.ts:67`) — deliberately,
for a reason the permission work must preserve:

> *"Writing 'cashier' would assert a fact the application cannot know, and because the trail is
> append-only that wrong assertion would be permanent… Real tiers start being written
> prospectively, by the permission work, and these rows are never rewritten."*

**So the audit's actor-tier half needs no migration and no new vocabulary.** It was left waiting on
purpose, which is the single biggest cost saving in this study.

---

## 5 · Smallest correct role model

**Two roles. `owner` and `cashier`.** Both already exist in the `actor_tier` CHECK, so adopting
them adds no schema vocabulary. `admin` also exists there and should stay **unused in v1** — a
third tier with no distinct job is a permission nobody can explain, and adding it later costs
nothing precisely because the CHECK already admits it.

Proposed matrix over the twelve operations named in the brief:

| Operation | owner | cashier | Notes |
| :--- | :---: | :---: | :--- |
| Sell / POS | ✅ | ✅ | the cashier's whole job |
| View Today's sales | ✅ | ✅ | they need their own till to reconcile |
| View Sales History | ✅ | ✅ | **read-only**; needed to find a sale before voiding |
| **Void sale** | ✅ | ⚠️ override | the money-reversing action — see §6 |
| Products view | ✅ | ✅ | needed to sell |
| Add / Edit / Deactivate product | ✅ | ❌ | editing a price is an owner act |
| Catalog import / export | ✅ | ❌ | replaces the whole price list |
| Outgoing invoices | ✅ | ❌ | a commercial document in the shop's name |
| Reconciliation | ✅ | ❌ | writes the catalog |
| Company profile / settings | ✅ | ❌ | the shop's legal identity |
| Backup / export | ✅ | ❌ | the export is the whole ledger, i.e. the whole business |
| Operator management | ✅ | ❌ | an owner must not be demotable by an employee |

Two deliberate "no"s worth arguing before they are accepted: **History is readable by a cashier**
(hiding it does not protect anything and the cashier needs it to find the sale they mis-rang), and
**Backup is owner-only** (the exported `.sqlite` is every sale the shop ever made — this is a data
exfiltration surface, not a convenience).

---

## 6 · Can an Owner PIN override be added cleanly?

**The mechanism: yes, cleanly and with no migration.** `pinMatches(cashier, pin)`
(`cashierAuth.ts:16`) is a pure function over an account record; it does not touch the session.
`PosService.login` is the only thing that assigns `this.cashier` (`posService.ts:235`). So a
`verifyOwnerAuthorization(ownerId, pin)` is strictly additive and **cannot** change who is logged
in, which is the property the brief actually asks for.

It must reuse the **same lockout state** (`cashier_pin_state`), or the override becomes an
unlimited oracle for guessing the owner's PIN. That table is keyed by `cashier_id` and already
shared, so this needs no new storage.

**Recording who authorized: NO, this needs a migration**, and that is the honest answer:

- `voids` (`migrations.ts:60-68`) has exactly one actor — `cashier_id`, `cashier_name`. There is
  **nowhere** to put the authorizing owner, and `voids` is protected by immutability triggers
  (`:84-86`), so this cannot be slipped in later against existing rows.
- `audit_events.event_type` is a **closed CHECK** of five values (`migrations.ts:260-262`):
  `PRODUCT_CREATED, PRODUCT_UPDATED, PRODUCT_ACTIVATED, PRODUCT_DEACTIVATED, CATALOG_IMPORTED`. A
  `VOID_AUTHORIZED` row cannot be written without extending it.
- `changed_json` is free-form JSON and *could* carry an authorizer, but putting the second actor
  inside a JSON blob on an event type that does not mean "authorization" is exactly the kind of
  silent overloading this repository keeps paying for.

🔴 **So: the override flow is free; the durable two-actor record is not.** Shipping the override
without the record would produce a void whose authorization is invisible — worse than no override,
because it looks accountable and is not.

---

## 7 · Migration required?

| Piece | Migration? |
| :--- | :--- |
| `actor_tier` vocabulary (`owner`/`cashier`) | **No** — the CHECK already admits both |
| Real operator accounts (name, PIN hash, role, active) | **YES** — a new table; nothing stores these |
| New audit event types (operator created/renamed/deactivated/PIN reset) | **YES** — extend a closed CHECK |
| Durable record of an override's authorizing owner | **YES** — a column or table that does not exist |
| Backfilling history, or FKs on ledger tables | **No** — sales/voids carry cashier snapshots, no `REFERENCES` |

So **one additive migration 8**, and nothing in it rewrites a row. The proposal is **not written**.

---

## 8 · Recommended UI under Tools / Settings

An **Operators** section in Tools, visible only to an owner:

- a list — name, role, active/inactive, last used; **never a PIN, in any state**
- **Add operator** — name, role, PIN entered twice
- **Rename**
- **Deactivate** / reactivate — never delete, because past sales name this person and the account's
  identity has to stay resolvable (the same reason products deactivate rather than delete)
- **Reset PIN** — set a new one, entered twice. There is no "show PIN", because with a scrypt hash
  there is nothing to show; the UI should say that rather than imply the old PIN was retrievable
- the owner's own PIN change sits in the same place, and must require the **current** PIN

Two guards the UI must enforce *and* the service must refuse independently: **the last active owner
cannot be deactivated or demoted**, and **an operator cannot change their own role**.

---

## 9 · Audit implications

1. **Existing rows are never rewritten.** They stay `unspecified`, exactly as `audit.ts` promised.
   Real tiers begin **prospectively**. History will therefore contain a boundary, and that is the
   truthful outcome — not a defect to tidy.
2. `CURRENT_ACTOR_TIER` is deleted at that point: once the app knows the tier, a constant asserting
   that it does not know is itself the lie.
3. Operator management is an **audited act**. Creating, renaming, deactivating and resetting a PIN
   all need event types, and the PIN itself never enters `changed_json` — the logger redacts a
   `pin` key, but an audit row is not a log and would keep it for ever.
4. A failed login is **not** currently audited. Whether it should be is a real question: it is the
   single most useful security signal, and `cashier_pin_state` already counts failures without
   recording them.

---

## 10 · Exact scope for a safe first version

**In scope**

1. Migration 8, additive: an `operators` table (`id, name, role, pin_salt, pin_hash, is_active,
   created_at, updated_at`), extended `audit_events.event_type`, and the two-actor record for an
   authorized void.
2. The PIN rule (4–8 digits) moved into the **domain**, where every path meets it.
3. `PosService`'s `cashiers` dependency swapped from the fixture array to a repository reader —
   login logic unchanged.
4. A first-run **bootstrap**: an installation with no operators asks for the owner's name and PIN
   before anything else. Without this, an upgrade either locks the shop out or silently keeps the
   public test PINs.
5. Permission checks in the **service**, not the renderer. Hidden buttons are a courtesy; the
   service refusing is the control. Each of the twelve operations gets one.
6. The Operators UI of §8.
7. Owner PIN override for Void only, sharing the existing lockout, recording both actors.
8. `actor_tier` written for real from then on.

**Out of scope, explicitly**

- The `admin` third tier.
- Per-operator permission editing. Two fixed roles first; a permission matrix is a product in its
  own right.
- Any cloud or multi-terminal identity.
- Rewriting historical audit rows or ledger actors.
- Overrides for anything other than Void until Void's has been used in the field.

**The one thing that must be decided before any of this is built**

What happens to `cashier-01` / `cashier-02` on an existing installation. Three options, and this is
a business decision, not a technical one:

1. **Migrate them** into the new table as `cashier` role, keeping their ids so `cashier_pin_state`
   and every historical sale stay consistent — then force a PIN reset on first owner login.
2. **Deactivate them** on migration and require the bootstrap owner immediately.
3. **Leave them active** until the owner removes them.

Option 1 keeps every id resolvable and is the least surprising; option 2 is the most secure and
will lock out a shop that installs the update and expects `1111` to work. Nothing here chooses.
