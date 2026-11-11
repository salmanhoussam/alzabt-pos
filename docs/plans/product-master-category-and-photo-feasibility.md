# Category and Product Photo — feasibility, measured

> **Status: STUDY ONLY. Nothing here is implemented, and nothing here is approved.**
> Written 2026-10-10 at Salman's request, against `ce4dd28`. Both features need a migration, so
> both stop at a proposal. Neither belongs to the field-fix PR (#12).

Every claim below is a real read of this repository or a real SQLite execution. Where something was
executed, the result is quoted.

---

## 0 · What the schema has today

`catalog_products`, created in migration 3, **never altered since** (`grep "ALTER TABLE
catalog_products"` → zero; no `catalog_products_v*` rebuild):

```
id · source · source_key · sku · name_ar · name_en · selling_price_minor · currency
base_unit · price_needs_review · is_active · created_at · updated_at
UNIQUE (source, source_key) · UNIQUE INDEX on sku WHERE sku IS NOT NULL · STRICT
```

A repo-wide search of `src/persistence/migrations.ts` for `categor|image|photo|picture|thumbnail`
returns **zero matches**. There is no category concept and no image concept anywhere in the schema,
not even an unused column.

So the answer to both "does this need a migration" questions is **yes**, and that is not a judgement
call — there is nothing to build on.

`docs/ALZABT_STORE_POS_V1_PRODUCT_DEFINITION.md` already places this work late on purpose:
roadmap item **10 / I**, *"Barcode / categories / search enhancements"*, with Barcode marked
**LATER** because it needs a scanner survey that has never been run.

---

## 1 · Eight things measured by execution, not assumed

Run against a STRICT table shaped like the real one, with `PRAGMA foreign_keys = ON`:

| # | Checked | Result |
|---|---|---|
| 1 | `ADD COLUMN category_id TEXT REFERENCES catalog_categories(id)` on a **STRICT** table | **OK** |
| 2 | An existing product row keeps `NULL` | **OK** |
| 3 | The foreign key is **enforced** on the added column (a ghost id is refused) | **OK** |
| 4 | `ADD COLUMN … DEFAULT (datetime())` — a non-constant default | **refused**, as expected |
| 5 | `ADD COLUMN image_asset TEXT` | **OK** |
| 6 | Deleting a category a product still uses | **refused** by the FK |
| 7 | Renaming a category does **not** touch products (the id is the link) | **OK** |
| 8 | A 50,000-byte `BLOB` survives `VACUUM INTO` into a snapshot | **OK** — read back at exactly 50,000 |

№4 matters: a migration cannot backfill a computed value through a column default, so any backfill
has to be an explicit `UPDATE` — the same thing migration 7 already says about itself.

№8 is the decisive one for photos. See §3.

---

## 2 · CATEGORY

### Migration required

**Yes.** One additive migration: a new table plus one nullable column. No table rebuild — `sales`
needed one in migration 7 only because it is referenced by `voids` and `sale_lines`;
`catalog_products` is referenced by nothing, so `ALTER TABLE … ADD COLUMN` is sufficient and was
measured working on the STRICT table (№1).

### Normalized flat table, not free text

Free text was considered and is rejected on measured grounds, not taste:

- **Rename.** With free text, renaming a category means rewriting every product row that carries the
  old string, and any row missed becomes a second category that looks identical. With an id, rename
  is one `UPDATE` on one row and products are untouched (№7).
- **Typos split a category silently.** «مشروبات» and «مشروبات » (trailing space) are two categories
  in free text and one impossible bug to see on screen. The existing schema already takes this
  seriously everywhere else: `CHECK (length(trim(name_ar)) > 0)` on products, Arabic normalisation
  in `domain/arabic.ts` for search.
- **A filter needs a stable list.** A category dropdown built from `SELECT DISTINCT category` shows
  every typo as a choice.

Proposed shape — the smallest durable model, deliberately flatter than what was floated:

```sql
CREATE TABLE catalog_categories (
  id         TEXT    PRIMARY KEY,
  name_ar    TEXT    NOT NULL CHECK (length(trim(name_ar)) > 0),
  name_en    TEXT    CHECK (name_en IS NULL OR length(trim(name_en)) > 0),
  is_active  INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX catalog_categories_name_ar ON catalog_categories (name_ar);

ALTER TABLE catalog_products ADD COLUMN category_id TEXT REFERENCES catalog_categories (id);
CREATE INDEX catalog_products_category ON catalog_products (category_id);
```

- `name_en` is included because every other catalog name in this product is bilingual, and the UI is
  bilingual. It stays nullable and is **never inferred** from the Arabic — the same rule
  `resolveCreateProduct` already follows.
- `UNIQUE` on `name_ar` is what actually prevents two categories that read identically.
- **No parent_id. No tree.** Asked for and deliberately absent.
- **No inventory semantics** anywhere near this table.

### Delete and deactivate behaviour

The FK refuses a delete while any product points at the category (№6), which is the correct default:
a delete must never silently orphan products or blank their category.

So the operator gets **two** distinct actions, and they must be named differently on screen:

| Action | Effect |
|---|---|
| **Deactivate** (`is_active = 0`) | The category stops being offered for new/edited products. Products keep it, and keep showing it. This is the everyday action. |
| **Delete** | Allowed **only** when no product references it. Otherwise the app says how many products use it and offers to deactivate instead — never a silent cascade. |

`ON DELETE SET NULL` was considered and **rejected**: it would quietly erase a classification the
operator entered, and "where did my categories go" is exactly the class of bug this project keeps
paying for. If a real need for bulk reassignment appears, that is an explicit "move N products to
category X" operation with its own audit, not a cascade.

### Existing products

All of them get `NULL` (№2), which is the honest state: they were never categorised. Nothing is
invented, no "Uncategorised" row is created. The UI renders `NULL` as «بلا تصنيف» / "No category" —
a rendering, not a stored value, so the count of real categories stays truthful.

### Excel import / export — 🔴 the real constraint

`src/domain/catalogImport.ts:129` matches the header **exactly**:

```js
if (!header || header.join(",") !== IMPORT_HEADER.join(",")) { ...reject... }
```

with `IMPORT_HEADER = ["source_id","name_ar","name_en","price","currency","base_unit","price_needs_review"]`.

**Appending a column to `IMPORT_HEADER` would reject every file the merchant already has.** That is
a breaking change to a contract real shop data is shaped to, so the import must accept both headers:
the current seven, and the seven plus `category` — nothing else. The export writes the longer form.

One property worth keeping deliberately: the import's `UPDATE` statement
(`catalogRepository.ts:240-243`) sets only `name_ar, name_en, selling_price_minor, currency,
base_unit, price_needs_review, is_active, updated_at`. It does **not** touch `category_id`, so a
re-import **preserves** a category the operator set in the app. That falls out of the existing code
and should be asserted by a test rather than left to luck.

A `category` value in a CSV is a NAME, not an id. Matching it needs one stated rule, and the honest
one is: match an existing category by trimmed `name_ar`; **do not auto-create** categories from an
import. Unmatched values are reported in the import summary and leave the product `NULL` — the same
"report it, don't invent it" posture as `price_needs_review`.

### Search and filter

`matchesSearch([p.nameAr, p.nameEn, p.sku], query)` in `domain/arabic.ts` is the one search path
(used by both the products screen and the reconciliation panel). Category is a **filter**, not a
search term: a dropdown beside the search box, intersected with the text match. Adding the category
name into the searched fields would make «مشروبات» return 40 products and look broken.

### Optional by default, and later requirable

Optional by default — the column is nullable and nothing refuses a product without a category. A
future shop setting could make it **required at the form level** (the Add/Edit product form refuses
to save without one) while the column stays nullable, so historical rows remain legal. That is the
only shape that works: making the column `NOT NULL` would require inventing a category for every
existing product.

🔴 And per the standing rule: a visibility/requiredness setting **must never add or drop a database
column**.

---

## 3 · PRODUCT PHOTO

### Migration required

**Yes**, for any durable reference. Measured: `ADD COLUMN image_asset TEXT` works on the STRICT
table (№5).

### 🔴 The finding that decides the whole design: backups do not contain files

`src/persistence/backup.ts` makes **every** backup with `VACUUM INTO` (pre-migration, daily, and the
operator's own `exportBackup`), and `exportBackup` in `main.ts:371-385` writes **one `.sqlite`
file**. There is no archive, no folder copy, no asset sweep.

So a product photo stored as a managed file beside the database is **not in any backup**. Restore a
backup onto a new machine and every product row points at an image that does not exist.

**This is already true of the invoice logo.** `userData/branding/` and `userData/branding/frozen/`
are outside every backup, so a restored ledger reprints historical invoices **without their frozen
logos** — the freeze guarantee holds inside one installation and silently does not survive a
restore. That is a real pre-existing gap, found while measuring this, and it is a **side finding**:
it is not the photo question and it should not be fixed inside a photo feature.

### Recommended DB reference shape — the choice this forces

Two honest options, and they differ on backup, not on elegance:

| | **A — bytes in the database** | **B — managed file + reference** |
|---|---|---|
| Column(s) | `image_blob BLOB`, `image_mime TEXT`, `image_sha256 TEXT` | `image_asset TEXT` (a bare filename) |
| In every existing backup? | **Yes**, measured (№8) | **No** — needs backup to change too |
| Restore on a new machine | Works | Images missing |
| DB growth | ~40–150KB per product × product count | DB unchanged |
| Rendering | `data:` URI from the blob | `file://` or a `data:` URI read at render time |

**Recommendation: A, bytes in the database**, for one reason — it is the only option that is already
covered by the backup mechanism this product actually has. 125 live products × ~80KB ≈ 10MB, which
`VACUUM INTO` handles without ceremony. B is cheaper on paper and quietly ships a feature whose data
is not backed up.

If B is ever preferred, it is only honest **after** backup/export becomes an archive that includes
the asset directory — and that change should then also cover the frozen invoice logos, closing the
side finding above rather than adding a second instance of it.

🔴 Either way: **never store an absolute user path.** A path to the merchant's Desktop breaks when
they move or delete the file, and it is also an arbitrary-file-read into a rendered document — the
exact threat `logoPathFor()` already refuses by accepting only a bare filename inside one directory.

### Managed asset lifecycle

Under option A the lifecycle is simply the row: choose an image → validate type and size → read the
bytes → store them with their mime and SHA-256 → the product owns its photo. Deleting the source
file afterwards changes nothing, which is the stated requirement, and it is satisfied by
construction rather than by a copy step.

`image_sha256` is kept not for addressing but for cheap "is this the same image" checks and for
noticing corruption.

### Replacement and removal semantics

Unlike the invoice logo, a product photo is **mutable catalog data**: replacing it is an ordinary
edit, and it SHOULD change everywhere the product is shown, because there is no document frozen
around it. Removal sets the columns back to `NULL`. Both go through the existing authoritative
`PosService` product-update path and produce the existing `PRODUCT_UPDATED` audit event — measured
present in the gate's own final ledger line: `"auditTypes":"PRODUCT_CREATED=2,PRODUCT_UPDATED=2"`.

### Do NOT reuse the invoice-logo freezing mechanism

Compared on requirements, as instructed, and they are opposites:

| | Invoice logo | Product photo |
|---|---|---|
| Lifecycle | **Immutable snapshot.** Frozen at finalization so a later rebrand cannot alter an issued document | **Mutable catalog data.** An edit SHOULD change every view |
| Identity | Content-addressed, because two different images must never collide on one name across years of documents | The product's own row; a replacement supersedes |
| On change | The old asset must survive forever | The old image is garbage |
| Copies | One per distinct logo ever used | One current image per product |

They may share primitives — type/size validation, the refusal to accept a path, `data:` embedding at
render time. They must **not** share the freeze: content-addressing a product photo would accumulate
every image a shop ever tried and never collect one, and freezing is pointless where there is no
document to protect.

### Size and type limits

Follow the limit the logo picker already enforces (`main.ts:168`): PNG / JPG / JPEG / WEBP, and a
**ceiling well below** the logo's 4MB — for a catalog, **512KB** per image is generous for a display
photo and keeps 125 products under ~64MB worst case. Anything larger is refused with a clear
message, not silently downscaled: this repository has no image library, and adding one to resize a
file the operator chose is a dependency decision of its own.

### Thumbnails — unnecessary

**Not useful yet, and measurably so.** The products screen shows one page of rows; at 512KB max and
~125 products a list is tens of megabytes of decode only if every row renders at once, which it does
not. A thumbnail column would be a second representation to keep in sync, invalidate on replace, and
back up — all to solve a problem no measurement has shown. Revisit only if a real products screen is
measured slow with real photos.

### Excel import / export

**Do not put images in the CSV.** Base64 in a cell makes the file enormous, unopenable in Excel in
practice, and the import header is exact-matched (§2) so it is a breaking change for zero operator
benefit. Photos are set in the app. The export may carry a `has_image` column (0/1) for information;
the import ignores it. If bulk photo loading is ever genuinely needed it is a folder of files named
by SKU, matched on import — a separate feature with its own decision.

### Optional by default

Yes — `NULL` for every existing and new product; nothing refuses a product without a photo. A future
requiredness setting behaves exactly as Category's does: **form-level** only, column stays nullable.

### Missing or corrupt image

Must fail to **nothing**, never to a broken-image placeholder on a screen the operator is selling
from. Under option A a `NULL` blob renders the existing name-only row. A blob that fails to decode
renders the same way, and logs — the same posture `freezeLogo` already takes (`return null`, print no
logo) and the same one `e2e/invoice-logo.mjs` now asserts for a shop with no logo.

---

## 4 · If approved — the exact minimal additive migration

**One migration 8, or two separate ones, but NOT bundled with payment events.** Payment-after-
finalization is a different decision with a different blocker (frozen rows), and migration 7 is this
project's own warning about what a commit carrying five unrelated things costs.

```sql
-- Migration 8 (PROPOSAL — not written, not approved)
CREATE TABLE catalog_categories ( ...as §2... ) STRICT;
CREATE UNIQUE INDEX catalog_categories_name_ar ON catalog_categories (name_ar);
ALTER TABLE catalog_products ADD COLUMN category_id TEXT REFERENCES catalog_categories (id);
CREATE INDEX catalog_products_category ON catalog_products (category_id);
ALTER TABLE catalog_products ADD COLUMN image_blob   BLOB;
ALTER TABLE catalog_products ADD COLUMN image_mime   TEXT;
ALTER TABLE catalog_products ADD COLUMN image_sha256 TEXT;
```

Additive only. No rebuild, no backfill, no row rewritten, no released migration edited. Every
existing product keeps `NULL` in all four new columns. The pre-migration backup the runner already
takes is the rollback.

**Rollback honesty:** SQLite cannot drop a column in this project's pinned version path without a
table rebuild, so rolling back means restoring the automatic pre-migration snapshot — which is
exactly what it is for, and what `f090ad9` → `ce4dd28` relied on.

---

## 5 · Open questions that are Salman's, not mine

1. Category and Photo **together** in one migration, or Category first alone? Category is smaller,
   has no backup implication, and answers a daily need.
2. Option **A (bytes in the DB)** confirmed, or option B plus a real decision to make backups an
   archive? B without that decision ships unbacked-up data.
3. The pre-existing **frozen-logo backup gap** — fix it on its own, or let it ride until backups
   become an archive for photos too? It is already live today.
