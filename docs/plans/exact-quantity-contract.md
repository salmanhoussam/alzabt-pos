# Contract — exact and fractional quantities

| Field | Value |
|---|---|
| Status | ✅ **APPROVED by Salman, 2026-10-07. NOT implemented** — implementation waits on the Product PR's CI evidence. |
| Migration number | **4** — `DECISION — SALMAN 2026-10-07`, order locked: 4 = quantity, 5 = durable audit. |
| Written | 2026-10-07 |
| Direction | Scaled integers. **No float, anywhere, at any layer.** |
| Shape | **ONE long-term `sale_lines` table**, rebuilt once — Salman's preference, and §12 is the measured case for it |

## 1. The stored field

```
name   quantity_milli
type   INTEGER NOT NULL CHECK (quantity_milli > 0)
means  thousandths of one base unit
```

The name says the scale, so no reader has to remember it. `quantity` is **not** reused: a column
whose name no longer means what it says is the failure this project has paid for before. A reader
who sees `quantity_milli = 34000` cannot mistake it for 34000 pieces.

## 2. The scale, and whether 1000 is enough

**Scale = 1000.** Measured against every unit V1 sells in:

| Unit | Smallest real-world step | Needs | 1000 enough? |
|---|---|---|---|
| `piece` | 1 piece | whole only | ✅ trivially |
| `box` | 1 box | whole only | ✅ |
| `pack` | 1 pack | whole only | ✅ |
| `other` | 1 | whole only | ✅ |
| `kg` | 1 gram = 0.001 kg | 3 decimals | ✅ exactly |
| `meter` | 1 mm = 0.001 m | 3 decimals | ✅ exactly |

🔴 **Where 1000 would NOT be enough, stated so the boundary is known:** a unit sold in
ten-thousandths or finer — precious metal by the milligram, a chemical by the microlitre. A hardware
and building-materials shop has none, and `litre` (millilitres) would also fit 1000 if it is ever
added. **The scale is effectively one-way once sales exist**, which is why it is a decision and not
a default.

Headroom: `MAX_QUANTITY` stays 9999 base units ⇒ `quantity_milli` ≤ 9,999,000. The check's
multiplication peaks at ~10¹⁵ against an int64 ceiling of 9.22 × 10¹⁸ — **9,224× headroom**, measured.

## 3. Validation, per unit

Two classes, one list, decided by the product's `base_unit`:

```
WHOLE-ONLY   piece · box · pack · other    quantity_milli % 1000 == 0   and ≥ 1000
             `other` stays whole-only until a future explicit unit contract says otherwise
FRACTIONAL   kg · meter                    quantity_milli ≥ 1           (0.001 is the smallest sale)
```

- Enforced in `assertQuantity`, the one place quantity is validated today, which already runs in
  **both** the renderer (for the running total) and the main process (for the amount recorded), so
  there is one rule and not two.
- A whole-only product with `quantity_milli = 2500` is **refused**, not rounded: selling 2.5 boxes
  is a data-entry mistake, and silently charging for 2 or 3 is worse than a refusal.
- `FRACTIONAL_IN_REALITY` already exists in `src/domain/catalog.ts` and becomes the list that drives
  this — no new vocabulary.
- A unit this build does not know (a legacy row from an older build) is treated as **whole-only**:
  the conservative direction, because the fractional path is the one that can surprise a merchant.

## 4. The exact line total

```
line_total_minor = (quantity_milli × unit_price_minor + 500) / 1000     — integer division
```

Round-half-up, in pure integer arithmetic. And the **database enforces the same rule**, as an exact
equality rather than a tolerance:

```sql
CHECK (line_total_minor = (quantity_milli * unit_price_minor + 500) / 1000)
```

**Measured** against `sqlite3 3.45.1` — `/` on two integers is integer division (`typeof` returns
`integer`), and the constraint admits **exactly one** total in every case, the exact tie included:

| Case | q × p | round-half-up | the CHECK accepts |
|---|---|---|---|
| 3 pieces × $4.00 | 1,200,000 | 1200 | **only 1200** |
| 34 kg × $2.60 | 8,840,000 | 8840 | **only 8840** |
| 2.5 m × $3.10 | 775,000 | 775 | **only 775** |
| 0.333 kg × $3.17 | 105,561 | 106 | **only 106** |
| 0.500 kg × $2.01 — **an exact tie** | 100,500 | 101 | **only 101** |

This replaces an earlier draft's `abs(…) <= 500` tolerance, which was correct but **looser**: on an
exact tie it admitted both 100 and 101 and left the choice to the application. The exact form pins
the rule in the schema, so the application and the database cannot disagree about rounding.

**Two consequences, named rather than discovered later:**

1. **Whole-unit lines keep migration 1's invariant exactly.** With `quantity_milli = q × 1000` the
   formula collapses to `line_total_minor = q × unit_price_minor` — the old check, unchanged, for
   every historical row and every future whole-unit sale.
2. **A line total of zero becomes possible**, for a tiny quantity at a tiny price (0.001 kg at
   $0.01 rounds to 0). That is arithmetically right, and the real guards are elsewhere:
   `quantity_milli > 0` and a catalog price that is `> 0` by migration 3. Worth a decision:
   **refuse a zero-total line in the service**, or let it stand? See §14, Q-Q3.

## 5. Display formatting

| Unit class | Shown as | Examples |
|---|---|---|
| Whole-only | the integer, no decimal point | `3` · `12` |
| Fractional | up to 3 decimals, trailing zeros trimmed | `34` · `2.5` · `0.333` |

- **Digits stay 0-9** in both languages — the approved rule, and the reason Arabic-Indic digits are
  normalised on input and never produced on output.
- The decimal separator is `.`; the operator may **type** `٣٤٫٥` and the input normaliser reads it.
- `font-variant-numeric: tabular-nums` is already on the money columns, so a column of mixed `34`
  and `2.5` still lines up.

## 6. Invoice formatting

The reference document's line table is `no · description · quantity · UNIT · unit price · total`.
So the invoice prints §5's quantity next to the unit's **Arabic label** (`كيلو`, `حبة`) exactly as
the reference does. The unit is part of the line's meaning, not decoration: `34` and `34 كيلو` are
different claims.

Nothing about formatting lives in the product table — it is derived at render time from
`quantity_milli` + `base_unit`.

## 7. Compatibility with every old integer sale

```sql
INSERT INTO sale_lines_new (…, quantity_milli, …)
  SELECT …, quantity * 1000, … FROM sale_lines;
```

**Proven, not asserted** (the experiment in `docs/evidence/`): a SHA-256 fingerprint over every
non-quantity column of every historical row is **identical** before and after; `PRAGMA
foreign_key_check` is clean; `integrity_check` returns `ok`; and `1 → 1000`, `2 → 2000`,
`34 → 34000` with the stored totals untouched.

Every past sale therefore reads back with the same receipt number, names, SKUs, unit prices and
totals — through SQL **and** through the IPC layer, which §13 makes its own test.

## 8. Migration rollback

**Proven:** the whole rebuild runs inside the migration runner's single `BEGIN IMMEDIATE`
transaction (`src/persistence/db.ts` wraps each migration with `db.transaction(…).immediate()`), and
a `ROLLBACK` restored the columns, **all three triggers**, the index, the row count and the data
fingerprint exactly. SQLite DDL is transactional, so **a crash mid-migration is a complete
rollback** — the merchant reopens on the old schema with every sale intact.

Plus the two protections that already exist: a verified `VACUUM INTO` backup is taken **before** any
migration runs, and a database whose schema is newer than the build is refused rather than opened.

## 9. Trigger recreation — and the order, corrected

```
DROP TRIGGER  sale_lines_immutable_update
DROP TRIGGER  sale_lines_immutable_delete
CREATE TABLE  sale_lines_new (…)
CREATE TRIGGER sale_lines_closed_sale  ON sale_lines_new   ← BEFORE the copy, deliberately
INSERT INTO   sale_lines_new SELECT … FROM sale_lines
DROP TABLE    sale_lines
ALTER TABLE   sale_lines_new RENAME TO sale_lines
CREATE INDEX  sale_lines_sale_id
CREATE TRIGGER sale_lines_immutable_update
CREATE TRIGGER sale_lines_immutable_delete
```

🔴 **A correction to an earlier draft.** It claimed the `closed_sale` trigger **must** be created
after the copy "or the migration cannot run at all". That was **false** — it came from a test with
one line per sale, too weak to exercise a trigger that fires only on a line *beyond* the declared
`line_count`. Re-run with two lines on one sale, the copy succeeds in **either** order.

The corrected test reversed the recommendation: create it **before** the copy, so a ledger that
somehow holds more lines than a sale declares **aborts the migration** instead of being copied
forward silently. The trigger becomes a corruption detector for free.

Also measured: `DROP TABLE` does **not** fire a `BEFORE DELETE` trigger, so the immutability trigger
cannot block the rebuild; and `PRAGMA foreign_keys = OFF` is **silently ignored inside a
transaction** — which does not matter here, because `sale_lines` is a **leaf** (zero
`REFERENCES sale_lines` in the schema) and the rebuild ran clean with enforcement on throughout.

## 10. Backup interaction

- `backup.ts`'s `COUNTED_TABLES` lists `sale_lines` **by name**, and the rebuild preserves the name
  ⇒ **no change needed**, and backup verification keeps counting the table. 🔴 The rejected
  second-table option would have needed that list extended, and forgetting it would have left every
  backup "verified" without counting the new lines — a silent hole.
- The automatic pre-migration snapshot already covers this migration, with its own row-count
  verification.
- Daily snapshots and the operator's `Export backup` are unaffected.

## 11. The E2E upgrade test

The Windows CI already proves two upgrade paths on a real `%APPDATA%` profile. This adds a third,
and it is the one the shop will actually perform:

1. Build the **current released** version (0.1.1), install it, ring real sales — whole-unit lines,
   a void, Arabic product names — through the real UI.
2. Install the new build **over** it.
3. Assert: the build line shows the new version · the old sales and the void are **still present and
   unchanged** · `quantity_milli = old quantity × 1000` for every historical line · a
   pre-migration backup exists in `backups\` and its counts match · a new fractional sale
   (`2.5 kg`) rings, prints and reads back · and the old receipts still show their original totals.
4. A crash-during-migration variant in `crash-recovery.mjs`, which already kills the installed app:
   kill it **during** the migration and assert the ledger reopens on the old schema, intact.

## 12. Why one table, and not two

| | Second table + VIEW | **Rebuild (recommended)** |
|---|---|---|
| Long-term model | two line tables, permanently | **one** |
| Historical rows | never touched | copied, proven byte-identical outside the quantity column |
| Crash behaviour | nothing to roll back | full rollback, **proven** |
| DB-enforced total | old table keeps its own; new table needs another | **one exact check**, which collapses to the old one for whole units |
| `COUNTED_TABLES` | must be extended, or backups silently under-verify | **unchanged** |
| `saleRepository` | insert, join and read paths must handle both, plus a VIEW to maintain | 3 call sites changed once |
| Existing tests | keep passing | `tests/persistence/schema.test.ts` names `quantity` and must be updated — a visible one-time cost |
| Complexity | low once, **permanent** | moderate once, **then gone** |

## 13. Tests the migration ships with

Beyond §11's E2E:

- **Upgrade:** fingerprint before/after; the mapping for every historical row; all three triggers and
  the index present again; `foreign_key_check` clean; `integrity_check` ok; migrations 1–3's recorded
  checksums **unchanged**.
- **Read-back through IPC**, not only SQL: a sale written before the migration must reach the
  renderer identically. A schema change invisible in a table dump but different at the boundary is
  exactly the bug that gets found in the field.
- **Negative, per rule:** `quantity_milli = 0` · a whole-only product at `2500` · a total one minor
  unit off in either direction · a total off on the exact tie · `UPDATE`/`DELETE` on a line · a line
  beyond `line_count` · an unknown `sale_id`.
- **Arithmetic, pure:** round-half-up at the boundary from both sides, and the whole-unit collapse.
- **No float:** a test asserting every quantity and money value crossing IPC is a string or a
  `bigint`, never a `number`.

## 14. Decisions required

| # | Question |
|---|---|
All six are now **answered**. `DECISION — SALMAN 2026-10-07`:

| # | Question | Decision |
|---|---|---|
| Q-Q1 | Field name and scale | ✅ `quantity_milli`, scale **1000**, with §2's boundary |
| Q-Q2 | Exact CHECK or a tolerance | ✅ the **exact** integer rule — "the authoritative V1 round-half-up boundary for positive sale amounts" |
| Q-Q3 | A line whose total rounds to zero | ✅ **REJECTED.** See §15 |
| Q-Q4 | `MAX_QUANTITY` | ✅ stays **9999** base units ⇒ `quantity_milli ≤ 9,999,000` |
| Q-Q5 | Whole-only units and a fractional entry | ✅ **reject, never round** |
| Q-Q6 | Migration order | ✅ **4 = quantity, 5 = audit** |

### 15. A line whose total rounds to zero is refused

`DECISION — SALMAN 2026-10-07`, and it closes the consequence §4 named:

> A completed sale line whose rounded `line_total_minor` is 0 **must be rejected**. Do not silently
> create zero-value sale lines. Free or promotional items, if ever needed, are an explicit business
> feature of their own.

So the arithmetic stays right and the *sale* refuses the result:

```
code     ZERO_VALUE_LINE            a new DomainErrorCode
where    priceCart(), beside the existing quantity and currency guards — the ONE place a line
         is priced, so the renderer's running total and the recorded amount refuse identically
message  names the product, the quantity and the unit price, because "invalid line" tells a
         cashier nothing about which line or why
```

🔴 **Not a database CHECK**, deliberately: migration 1 already stores historical lines, and a
`line_total_minor > 0` constraint added in migration 4 would have to be satisfied by every copied
row. Every existing row satisfies it today — a past line could not have cost nothing — but a
constraint whose truth depends on data nobody has inspected is a migration that fails at the
merchant's, not in CI. The service refuses it on the way in; the schema does not re-litigate history.

### 16. The eight rounding tests Salman asked for

| # | Case | Expected |
|---|---|---|
| 1 | Whole quantity — 3 pieces × $4.00 | 1200, and the old invariant collapses to equality |
| 2 | Fractional quantity — 34 kg × $2.60 | 8840 |
| 3 | **Below half** — 0.333 kg × $3.17 (105,561) | 106 accepted, 105 refused |
| 4 | **Exact half** — 0.500 kg × $2.01 (100,500) | **101 only** — 100 refused |
| 5 | **Above half** — one minor unit over | the correct total only |
| 6 | Old integer-sale compatibility | every historical line fingerprints identically |
| 7 | Very large valid quantity — 9999 units at a real price | accepted; 9999.001 refused |
| 8 | **Overflow margin** | the check's multiplication peaks at ~10¹⁵ against int64's 9.22×10¹⁸ — **9,224×** |

### 17. The thirteen acceptance tests, as given

`A` v3 → v4 upgrade · `B` every historical sale preserved · `C` `quantity_milli = N × 1000` for every
line · `D` totals value-for-value equivalent · `E` receipt numbering continues · `F` void behaviour
unchanged · `G` backup-before-migration still runs and verifies · `H` a failed migration rolls back
completely · `I` `foreign_key_check` clean · `J` `integrity_check` = ok · `K` append-only triggers
still refuse mutation and deletion · `L` **installed-app upgrade E2E on Windows** · `M` a restart
after the migration preserves all data.

🔴 **`L` is a gate, not a line item:** migration 4 is not complete without installed-app upgrade
evidence. The same rule that is currently holding the Product PR.
