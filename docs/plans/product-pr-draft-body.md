# Draft PR body — offline product management

Ready to paste. Title and body only; **open it as a DRAFT and do not merge.**

---

**Title**

```
Offline product management: a shop keeps its own products, on the till, in Arabic
```

---

**Body**

```markdown
Draft — opened for Windows CI evidence. **Not for merge.**

The merchant's product list stops being an Excel file on another machine. Products are added,
edited, searched and taken out of service on the till itself, and the screen is bilingual on its
first commit rather than English with a translation promised later.

## No migration

`MIGRATIONS.length` is still 3 and `src/persistence/migrations.ts` is untouched. Migration 3's
`catalog_products` already carried every column a product editor writes, so this is UI + IPC only.

The claim is asserted, not stated — `tests/persistence/productAdmin.test.ts` pins the three
migrations by name, pins the table's exact column list, and names `barcode`, `category_id`,
`description`, `unit_needs_review`, `stock_qty` and `image_url` as still **absent**.

Four units (`pack`, `kg`, `meter`, `other`) were likewise free, because `base_unit` is validated in
code rather than in the schema.

## What a past sale is protected from

Nothing here can reach one: `sale_lines` holds its own name, SKU and unit-price snapshot and no sale
references a catalog row. A price corrected today leaves yesterday's invoice exactly as it was —
asserted against a real committed sale, not inferred from the schema.

## The i18n / RTL foundation arrives with it

A bilingual screen needs one: two languages kept separate (terminal and receipt), a translation
registry whose test fails when either language is missing a key, `dir`/`lang` on the document,
logical CSS direction throughout, and the approved Arabic search normalisation — tashkeel, tatweel,
alef forms, ى, Arabic-Indic digits — with **ة → ه deliberately NOT folded**, asserted as its own
case so a later tidy-up cannot quietly add it.

## Two defects this branch would otherwise have carried into CI

1. **22 E2E selectors clicked tabs by their English names** (`Sell` ×6, `Today's Sales` ×7,
   `History` ×5, `Tools` ×4) — and the default terminal language is now Arabic, so every Windows
   E2E job would have failed at the first tab click. They now select by `data-testid`, which is
   language-neutral.
2. `tests/main/ipcHandlers.test.ts` pins the exact channel list, and six channels were added. The
   assertion is updated **and names the old count (13 → 19)**.

## Deliberately absent, each for a measured reason

| Item | Reason |
|---|---|
| Barcode, categories, notes | No columns exist. SKU is **not** overloaded as a barcode. |
| `unit_needs_review` | No column; and no row in the database has an unknown unit (`base_unit` is NOT NULL). |
| The durable audit **table** | Migration 5, a separate PR. The audit **hook** is wired to the application log, so "who changed this price" is already answerable. |
| Roles | A later PR. Every administrative action requires a logged-in operator and nothing finer — stated, not hidden. |
| Fractional quantities | Migration 4. `kg` and `meter` sell in **whole units only**, and the screen says so in both languages rather than rounding in silence. |

## Evidence so far

```
213 / 213 tests passing, 23 / 23 files — including every SQLite test
  (run under Electron's bundled Node 24: better-sqlite3@13 needs Node >= 22)
typecheck clean in all three projects
npm run build  exit 0
+84 tests over origin/main (129 -> 213)
```

**Not yet verified, which is why this is a draft:** Windows CI, the installed-app E2E, and the six
screenshots from `e2e/product-management.mjs` — which is wired into this workflow and leaves them
for the existing `Upload E2E screenshots` step.
```
