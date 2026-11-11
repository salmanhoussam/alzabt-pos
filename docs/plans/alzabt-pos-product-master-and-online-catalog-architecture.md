> 🔴 **CROSS-REPOSITORY NOTE — read this first.**
> This plan is **Alzabt POS** work, not SalmanSaaS. The product is an offline-first Windows Electron
> POS whose repository is `salmanhoussam/alzabt-pos` (working copy
> `/home/musicmaster/Downloads/POS/alzabt-pos-git`). It is filed here because Salman's standing
> instruction is that **every** plan lives in `.claudedocs/plans`, whichever product it is about.
> Nothing in it touches `app/`, `frontend/`, `prisma/` or any tenant.
>
> Measured 2026-10-11 against POS `feat/operator-accounts-v1` @ **`0e1e8d1`** (branch point
> `b18b5b4`). A copy sits at `docs/plans/alzabt-pos-product-master-and-online-catalog-architecture.md` inside
> the POS repository — if the two ever disagree, the POS copy is the one next to the code.

# Product Master → Online Catalog — architecture study

> **Status: STUDY ONLY. Nothing implemented, nothing approved, no migration written.**
> The Operator Accounts V1 branch was read but **not modified**: no file under `src/` changed, no
> commit was added to `feat/operator-accounts-v1`, migration 8 was not touched.

This report supersedes nothing. It **builds on** `alzabt-pos-product-master-category-and-photo-feasibility.md`
(category + photo, measured against `ce4dd28`) and **revises two of its recommendations** — each
revision is named explicitly in §L and §P with the measurement that caused it, rather than quietly
replacing the earlier text.

---

## A · Current repository state relevant to Product Master

| Fact | Measured value |
| :--- | :--- |
| Branch / HEAD | `feat/operator-accounts-v1` @ `0e1e8d1`, 0 unpushed, gate never run |
| `main` | `b18b5b4` — the shop build; nothing from operator accounts is in it |
| Schema version shipped | **7** on every installed build; **8** exists only on the unmerged branch |
| Runtime dependencies | **exactly one**: `better-sqlite3 ^13.0.3` |
| Electron | `^44.5.1` |
| HTTP server anywhere in `src/` | **zero** — `grep createServer\|node:http` returns nothing |
| Image library | **none** |
| QR library | **none** |
| Product form | `src/renderer/screens/ProductsScreen.tsx`, 331 lines, **6 controls**: `field-nameAr`, name_en, sku, `field-price`, `field-unit`, active |
| i18n | `src/shared/i18n.ts`, ~700 keys, parallel `AR`/`EN` blocks, brand is a constant not a key |
| Authorization | every new channel **must** be classified in `src/main/channelPolicy.ts` or it fails closed (compile error + runtime throw) |

The product definition doc already places this work late on purpose: `docs/ALZABT_STORE_POS_V1_PRODUCT_DEFINITION.md`
item **10 / I**, *"Barcode / categories / search enhancements"*, Barcode marked **LATER** pending a
scanner survey that has never been run.

**One dependency is the headline constraint of this whole study.** Three of the things asked for —
automatic image resizing, a QR code, an `.xlsx` file — are not "a bit of code"; each is a decision
about whether this product gains a second runtime dependency. §L, §N and §P each state which.

---

## B · Current product schema

`catalog_products`, created in **migration 3** and **never altered since** (zero `ALTER TABLE
catalog_products`, zero `catalog_products_v*` rebuild):

```
id · source · source_key · sku · name_ar · name_en · selling_price_minor · currency
base_unit · price_needs_review · is_active · created_at · updated_at
UNIQUE (source, source_key)  ·  UNIQUE INDEX on sku WHERE sku IS NOT NULL  ·  STRICT
```

Searching the whole migration file for `categor|brand|image|photo|descript|spec` returns **zero
matches**. There is no column to grow into — every field in this study is genuinely new.

Three existing properties the design must respect, because they are load-bearing:

1. **`base_unit` is validated in code**, not in the schema (`CHECK (length(base_unit) > 0)` only), so
   `BASE_UNITS` in `src/domain/catalog.ts` can grow with **no migration**. That precedent is why
   units were free and categories are not.
2. **`invoice_lines.product_id` is deliberately NOT a foreign key.** A finalized invoice must survive
   anything that later happens to the catalog row. Nothing in this study may add that FK.
3. **The catalog is mutable master data; the ledger is immutable.** `sale_lines` and `invoice_lines`
   carry their own name/price/unit snapshots. Enriching a product therefore **cannot** alter history,
   by construction rather than by discipline.

---

## C · Proposed Product Master data model

One product stays **one row in `catalog_products`**, plus **one child table for images**. Everything
else is additive columns.

```sql
-- PROPOSAL. Not written, not approved. Split across migrations per §V.

-- 1 · Category (from the earlier feasibility doc, unchanged)
CREATE TABLE catalog_categories (
  id TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL CHECK (length(trim(name_ar)) > 0),
  name_en TEXT CHECK (name_en IS NULL OR length(trim(name_en)) > 0),
  is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX catalog_categories_name_ar ON catalog_categories (name_ar);
ALTER TABLE catalog_products ADD COLUMN category_id TEXT REFERENCES catalog_categories (id);
CREATE INDEX catalog_products_category ON catalog_products (category_id);

-- 2 · Online catalog content
ALTER TABLE catalog_products ADD COLUMN brand             TEXT;     -- free text, §I
ALTER TABLE catalog_products ADD COLUMN description_ar    TEXT;     -- ONE per language, §G
ALTER TABLE catalog_products ADD COLUMN description_en    TEXT;
ALTER TABLE catalog_products ADD COLUMN is_online_visible INTEGER NOT NULL DEFAULT 0
                                        CHECK (is_online_visible IN (0,1));

-- 3 · Images — a CHILD TABLE, not columns. §L explains why this revises the earlier doc.
CREATE TABLE catalog_product_images (
  id           TEXT    PRIMARY KEY,
  product_id   TEXT    NOT NULL REFERENCES catalog_products (id),
  sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
  bytes        BLOB    NOT NULL,
  mime         TEXT    NOT NULL CHECK (mime IN ('image/png','image/jpeg')),
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 524288),
  width        INTEGER NOT NULL CHECK (width  > 0),
  height       INTEGER NOT NULL CHECK (height > 0),
  sha256       TEXT    NOT NULL CHECK (length(sha256) = 64),
  created_at   TEXT    NOT NULL,
  UNIQUE (product_id, sort_order)
) STRICT;
CREATE INDEX catalog_product_images_product ON catalog_product_images (product_id, sort_order);

-- 4 · Specifications — only if approved, and on its own. §J.
ALTER TABLE catalog_products ADD COLUMN specs_json TEXT
  CHECK (specs_json IS NULL OR (json_valid(specs_json) AND json_type(specs_json) = 'array'));
```

`specs_json`'s CHECK is copied from a pattern this schema already uses twice —
`issuer_snapshot_json` and `tax_snapshot_json` in migration 6 — not invented here.

`is_online_visible` is the one new column with a `DEFAULT`, and a **constant** default, which is
legal in `ADD COLUMN`; the earlier feasibility doc measured that a *non-constant* default
(`DEFAULT (datetime())`) is refused. Every other new column is nullable and every existing product
gets `NULL`, which is the truthful state: nobody ever entered this data.

---

## D · Exact fields — now vs later

| Field | When | Why |
| :--- | :--- | :--- |
| `category_id` | **Now (M9)** | Daily need, and the form's layout depends on it existing (§W) |
| `brand` | **Now (M10)** | One text input; costs nothing; invoices already surface brand-ish text |
| `description_ar` / `description_en` | **Now (M10)** | The online catalog cannot exist without them |
| `is_online_visible` | **Now (M10)** | Without it, the first export has no way to exclude internal rows |
| primary image | **Now (M11)** | The single highest-value online field after the name |
| image gallery | **Later, no migration** | The table already permits it; v1 writes only `sort_order = 0` |
| `specs_json` | **Later (M13)** | Least decided; nothing breaks by waiting |
| barcode | **Later** | Blocked on a scanner survey that has never been run — unchanged |
| short *and* full descriptions | **Never, as two fields** | §G |
| `catalog_readiness` | **Never stored** | Derived; §E |
| inventory / stock | **Out of scope entirely** | Not asked for, and not implied by any of this |

---

## E · Required vs optional

Three tiers, and the tiers must not leak into each other:

| Tier | Fields | Enforcement point |
| :--- | :--- | :--- |
| **A · POS-required** | `name_ar`, `price > 0`, `base_unit` | `src/domain/productDraft.ts` — already exactly these three, already enforced, already tested |
| **B · Catalog enrichment** | `name_en`, `sku`, `category_id`, `brand`, descriptions, photo, specs | **Nothing refuses a save.** Null is legal and means "not entered" |
| **C · Online publication** | `name_ar` + price + **a photo** + `description_ar` + a category | Checked **at export time**, never at save time |

A product with no photo, no English name, no category and no description must stay fully sellable.
That is the current behaviour and this study does not change it.

**Catalog readiness: recommend YES, as a derived indicator, stored nowhere.**

```
اكتمال الكاتالوج  ✓ الاسم  ✓ السعر  ✓ التصنيف  ✗ صورة  ✗ وصف
Catalog readiness ✓ name   ✓ price  ✓ category ✗ photo ✗ description
```

Rendered in the product form and as one quiet column on the products list, so the merchant can see
*what is left* without anything blocking the till. No points, no badges, no streaks, no percentage
leaderboard — the request already said no gamification and the indicator does not need one to be
useful. Deriving it rather than storing it also means it can never go stale, which a stored
completeness column measurably would the first time the export rules change.

🔴 And per the standing rule: if Salman later wants a field *required*, that is a **form-level**
setting. It must never add or drop a database column, and the column must stay nullable so the rows
that predate the rule remain legal.

---

## F · Add/Edit Product — UI proposal

One modal workspace, Arabic-first, **four sections, two of them collapsed by default.** The target
is a hardware shop entering a product in under fifteen seconds, which the current 6-field form
already achieves and which a 40-field wall would destroy.

```
┌─ إضافة صنف / تعديل صنف ─────────────────────────────────────────────┐
│                                                                     │
│  ① الأساسيات                       [ ●  صورة الصنف ]                │
│  الاسم العربي *      [________]    ┌───────────────┐                │
│  الاسم الإنجليزي     [________]    │               │                │
│  السعر *             [____] ل.ل    │   لا صورة     │                │
│  الوحدة *            [ حبة  ▾]     │               │                │
│  التصنيف             [ ــ    ▾]    └───────────────┘                │
│  رمز الصنف (SKU)     [________]    [ من الحاسوب ] [ من الهاتف ]     │
│  الماركة             [________]                                     │
│  ☑ مُتاح للبيع                                                      │
│                                                                     │
│  اكتمال الكاتالوج: ✓ الاسم ✓ السعر ✓ التصنيف ✗ صورة ✗ وصف          │
│  ───────────────────────────────────────────────────────────────    │
│  ▸ ② محتوى الكاتالوج الإلكتروني            (مطويّ)                  │
│  ▸ ③ المواصفات                             (مطويّ · لاحقاً)         │
│  ───────────────────────────────────────────────────────────────    │
│  ④ ☐ يظهر في الكاتالوج الإلكتروني                                  │
│                                                                     │
│                          [ حفظ ]  [ إلغاء ]                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Above the fold:** the three POS-required fields, the photo, and the save button. Nothing a cashier
needs is ever behind a disclosure triangle. The photo sits top-right (top-left in English) because
it is the field a merchant *looks for* and the one that most changes how finished the product feels.

**Section 2, collapsed** — `description_ar`, `description_en`, both plain `<textarea>`, no rich-text
editor (an editor means a dependency, an HTML sanitiser, and an XSS surface in the future website for
formatting a hardware shop will not use). Expands automatically when the product already has a
description, so editing never hides existing content.

**Section 3, collapsed and absent until §J is approved** — repeating `[label_ar] [label_en] [value]`
rows with add/remove, no fixed vocabulary offered beyond a suggestion list built from what this shop
has already typed.

**Keyboard flow** — `Tab` follows the visual order of section 1 exactly; `Enter` in any single-line
field saves (matching `SellScreen`'s existing commit-on-Enter); `Esc` cancels with a confirm only if
something changed. A collapsed section is skipped by `Tab` until opened, which is the whole point of
collapsing it.

**Save behaviour** — one `حفظ`, no draft state, no autosave. The product either validates (tier A)
and saves, or it does not and the first offending field is focused with the service's own message.
A photo chosen but not yet saved is held in renderer state and written in the same service call, so
there is no "the photo saved but the product did not" window.

**Validation messages come from the service, not the form.** `productDraft.ts` is already the single
authority and already produces the exact strings; the form must not grow a second copy of the rules.

---

## G · Descriptions model — ONE per language, not short + full

**Recommendation: `description_ar` and `description_en` only.** Reject short+full for v1.

Reasons, in order of weight:

1. **A hardware shop will struggle to write one description, let alone two.** Two fields per language
   is four text areas on a form whose entire design goal is fifteen-second entry. The realistic
   outcome is four fields of which two are always empty, which is worse than one honest field.
2. **A card summary is derivable; a full description is not.** A website card can truncate a single
   description on a word boundary. The reverse — generating a full description from a short one — is
   impossible. So the cheap direction is the one that keeps one field.
3. **The duplicate-content trap is real:** when both exist, merchants paste the same text into both,
   and the export then carries the same sentence twice under two keys that a future website template
   will render twice.

Cap at **2000 characters** per language, trimmed, `NULL` when empty — the same `optional()` treatment
`productDraft.ts` already gives `name_en` and `sku`, so "" never reaches storage.

Revisit only when a real website template is in hand and demonstrably needs a separate teaser. The
migration to add `description_ar_short` later is additive and cheap; splitting a field the merchant
already filled is not. That asymmetry is the argument.

---

## H · Category model

**Unchanged from the earlier feasibility doc**, and re-checked against online filtering as asked:
flat normalized table, `UNIQUE` on `name_ar`, nullable `category_id` on the product, no `parent_id`,
no tree, deactivate ≠ delete, delete refused by the FK while any product points at it, existing
products get `NULL` rendered as «بلا تصنيف» rather than a stored "Uncategorised" row.

Online filtering **strengthens** the normalization argument rather than changing it: a website facet
built from free text shows every typo as a separate filter, and `«مشروبات»` vs `«مشروبات »` would be
two visible categories on the shop's own storefront. The id-based model exports a stable
`category: {id, name_ar, name_en}` that the website can key on across renames.

One addition for the export: `sort_order` already exists in the proposed table, so the website's
category order is the merchant's order, not alphabetical by accident.

**Import rule stays: match an existing category by trimmed `name_ar`, never auto-create**, and report
unmatched values in the import summary — the same "report it, don't invent it" posture as
`price_needs_review`.

---

## I · Brand — free text with suggestions, for now

**Recommendation: B — `brand TEXT` free text, with a datalist of what this shop has already typed.**
This deliberately differs from Category, and the asymmetry is the point.

| Argument | Category | Brand |
| :--- | :--- | :--- |
| Is it the website's primary navigation axis? | **Yes** | No — browsing by brand comes later, if ever |
| How many distinct values in a hardware shop? | ~10–30 | **hundreds**, arriving as supplier spellings |
| Does a wrong value need a merge tool? | Rename fixes it | Normalizing demands a **merge** UI nobody has |
| Cost of a typo today | A broken filter | A slightly inconsistent label |

Normalizing brands means building category management *twice* plus a merge/alias tool, to fix a
problem the first online shop will not have. That is normalizing for elegance, which the brief
explicitly refused.

**The condition that flips this — stated now so it is not re-argued later:** the moment brand becomes
a website filter facet, or the shop wants brand logos, normalize it. The promotion is a purely
additive migration plus a backfill by exact trimmed match, with the unmatched remainder shown to the
merchant — the same shape as the category import rule. Nothing in the free-text choice blocks it.

---

## J · Specifications — flexible attributes, deferred

**Recommendation: A small fixed set is wrong, and 20 nullable columns is wrong.** Use a JSON array,
and ship it **last**, in its own migration.

```json
[
  { "label_ar": "القياس", "label_en": "Size",  "value": "10 mm" },
  { "label_ar": "اللون",  "label_en": "Color", "value": "أسود"  }
]
```

Why JSON and not columns: the brief's own example list (size, weight, colour, material, voltage,
pack quantity, manufacturer reference…) is not a schema, it is a sample of an open set. A drill has
voltage; a bag of screws has pack quantity; neither has the other's field. Twenty nullable columns
would be ~18 nulls per row and a migration every time the shop meets a new product type.

Why not a normalized `attribute`/`attribute_value` pair of tables: that is the correct shape for
*filtering inside the database*, and nothing in stages 1–3 filters inside the database — the website
filters the exported JSON. Two extra tables plus a definitions UI, to serve a query nobody runs.

Scored against the four uses the brief named:

| Use | JSON array | Fixed columns | Normalized tables |
| :--- | :--- | :--- | :--- |
| Local editing | Simple repeating rows | Simple but fixed | Needs a definitions screen first |
| Online display | Direct — it is already a list | Needs a hand-written label map | Needs a join + flatten |
| JSON export | **Verbatim** | Must be assembled | Must be assembled |
| CSV/Excel | Awkward either way — one `specs` cell, quoted | One column each | Awkward |
| Future filtering | Website-side; SQLite `json_each` if ever needed | Easy in SQL | Easiest in SQL |

JSON wins three of five and loses only on in-database filtering, which is not a requirement.

🔴 **The one rule if it ships:** `specs_json` is *catalog* data, so it is validated on write
(array, each entry `{label_ar, value}` required, `label_en` optional, caps on count and length) —
never trusted at read time, and never rendered into the invoice document, which has its own frozen
contract.

---

## K · Online visibility — one boolean plus an export gate

**Recommendation: `is_online_visible INTEGER NOT NULL DEFAULT 0`, and no state machine.**

A three-state model (`local` → `ready` → `published`) was considered and rejected on a measured
ground, not a taste: **stage 1 has no publisher.** The export writes a folder; nothing confirms the
website ingested it. A `published` state would therefore be a claim the database cannot verify — the
exact failure mode this project already paid for when `invite_sent: true` was computed from the
presence of a phone number rather than a successful send.

So the honest split is:

- **`is_online_visible`** — the merchant's *intent*: "I want this online." Default `0`, so nothing
  ever reaches a website by accident. This is the checkbox.
- **readiness** — *derived*, §E. Can this be published at all?
- **the export** — the gate. A product is exported when `is_online_visible = 1` **AND** readiness is
  complete. One that is marked visible but incomplete is **listed in the export report and excluded**,
  never silently dropped and never silently published half-formed.

That third rule is the whole requirement "prevent incomplete products from automatically appearing
online" — and it lives in the exporter, where it can explain itself, not in a status column.

If stage 3 (automatic sync) ever arrives, `published_at` / `last_synced_at` are additive columns on
a row that already has a stable id. No remodelling.

---

## L · Desktop photo architecture — and a revision to the earlier doc

The earlier feasibility doc recommended **bytes in the database** over a managed file, because
backups are `VACUUM INTO` and therefore contain the database and **nothing else** — measured again
today: `backup.ts:103` is the only backup mechanism, `exportBackup` writes one `.sqlite`, and a
50,000-byte BLOB was measured surviving `VACUUM INTO` at exactly 50,000 bytes.

**That recommendation stands. Bytes in the database.** Nothing measured today argues otherwise.

### 🔴 Revision: a child table, not three columns on `catalog_products`

The earlier doc proposed `image_blob`, `image_mime`, `image_sha256` **on `catalog_products`**. I am
revising that to the `catalog_product_images` table in §C, for two measured reasons:

1. **`SELECT *` on the products list would drag every blob.** The products screen loads the whole
   catalog (`listProducts`, then filters in the renderer). With blobs inline, every list refresh
   reads ~10MB it never displays, unless every query in the repository is rewritten to enumerate
   columns and stay that way forever. A child table makes the cheap path the default one.
2. **The gallery question stops needing a decision today.** With the table, v1 writes only
   `sort_order = 0` and the UI offers exactly one photo; a gallery later is a UI change with **no
   migration and no blob move**. With columns, adding a gallery later means a new table *plus*
   copying every existing blob into it *plus* dropping columns SQLite cannot drop without a rebuild.

So the answer to "A one photo, or B primary + gallery" is: **A in the UI, B in the schema, same cost
today.** That is the smallest thing that genuinely supports the first online shop without buying the
gallery architecture the brief warned against.

### Validation, measured

- **Accept PNG / JPG / JPEG in v1.** `image/webp` is left out deliberately — see the resize finding.
- **Validate magic bytes, not the extension.** `\x89PNG\r\n\x1a\n` and `\xFF\xD8\xFF`. An extension
  is a claim; the bytes are the fact, and the file arrives from a file picker the operator drove.
- **Ceiling 512KB** stored, as the earlier doc argued (the logo picker's own ceiling is 4MB at
  `main.ts:168`; a catalog of 125 products needs far less headroom per row).
- **SHA-256** stored for cheap "same image?" checks and corruption detection, not for addressing —
  a product photo is mutable, so content-addressing it would accumulate every image the shop ever
  tried and collect none.
- **Dimensions** stored because the export's JSON should carry them and because a 6000×4000 photo
  that is under 512KB is still a bad render target.
- **Never store a user path.** Not the Desktop path, not any absolute path — the same refusal
  `logoPathFor()` already implements by accepting only a bare filename inside one directory. Under
  the blob model this is satisfied by construction: once the bytes are in the row, the source file
  can be deleted, moved or renamed and nothing notices. That was a stated requirement and it falls
  out for free.
- **Missing or corrupt** renders as **nothing** — the name-only row — never a broken-image
  placeholder on a screen someone is selling from. Same posture as `freezeLogo`'s `return null`.

### 🔴 Automatic resize/compress IS feasible with zero new dependencies

Measured in `node_modules/electron/electron.d.ts`:

```
nativeImage.createFromBuffer(buffer, options)   :9978
            .resize(options)                    :10098
            .toJPEG(quality)                    :10114
            .toPNG(options)                     :10118
```

Electron ships Chromium's image decoders, so the main process can decode, downscale to a max edge
(≈1200px) and re-encode to JPEG at a chosen quality **without adding a package**. That changes the
answer to "should Alzabt resize automatically": **yes, recommend it** — because the alternative is
refusing the merchant's 4MB phone photo with an error they cannot act on, and a phone photo is the
single most likely source of a product image.

🔴 **The honest unknown:** `nativeImage` exposes `toPNG` and `toJPEG` and **no `toWEBP`**, and
`grep -i webp` finds nothing in its API surface. Whether `createFromBuffer` *decodes* WEBP on the
Windows build is **unmeasured and must be measured on the real installed app before WEBP is
accepted anywhere** — in the picker filter, in the stored `mime` CHECK, or in the export. Until then
v1 is PNG/JPEG, stored re-encoded as JPEG except where transparency matters.

---

## M · Phone photo architecture

The UX asked for is right, and it is the correct feature: a merchant standing at a shelf with the
product in one hand and a phone in the other should not have to WhatsApp a photo to themselves.

Flow, as studied:

```
PC: Product Master for a product that is ALREADY SAVED
      → [ إضافة صورة من الهاتف ]
      → main process starts a one-shot LAN listener, mints a token, shows a QR + the URL
Phone (same Wi-Fi): scan → http://<lan-ip>:<port>/u/<token>
      → a single page: the product's ARABIC NAME and two buttons
      → <input type="file" accept="image/*" capture="environment">
      → POST the bytes
PC: validates → resizes → stores on that product → closes the listener → the photo appears
```

### 🔴 The one technical fact that shapes the phone page

**Use `<input type="file" capture>`, never `getUserMedia`.** `getUserMedia` requires a *secure
context*; a plain-HTTP LAN origin is not one, so a live camera preview would fail on iOS Safari and
Chrome regardless of how the server is written. A file input with `capture="environment"` opens the
native camera or picker on both platforms over plain HTTP. This single constraint removes any reason
to attempt TLS with a self-signed certificate, which would in turn have produced a browser warning
the merchant must click through — a worse experience and a worse habit.

### Security model — upload-only, one product, one use

| Property | How |
| :--- | :--- |
| Bind address | the **one chosen LAN interface**, never `0.0.0.0`, never a public interface |
| Port | ephemeral, chosen at start, never fixed |
| Token | 32 random bytes from `node:crypto`, hex, in the path; compared with `timingSafeEqual` |
| Scope | the token encodes **one product id**; a second product needs a second token |
| Lifetime | **5 minutes**, and **single use** — consumed on the first successful upload |
| Shutdown | listener closes on success, on cancel, on timeout, on leaving the product screen, on app quit |
| Routes | exactly two: `GET /u/<token>` (one HTML page) and `POST /u/<token>` (one upload). Everything else 404 |
| Body | `Content-Length` capped before reading; stream aborted past the cap |
| Content | magic-byte validated, same as the desktop path; the filename from the phone is **discarded** |
| Filesystem | **none** — no static directory, no path joining from any request value, so directory traversal has nothing to traverse |
| Database | **no read path of any kind**. The page is served the product name the main process already holds; nothing is queried from a request |
| Replay | the token is gone after use → a second scan gets a plain "this link has expired" page |
| Double scan before use | both tabs show the page; the first POST wins, the second gets expired. The product can never receive two photos from one token |
| Logging | the token is **never** logged — same rule as PINs |
| Audit | the resulting photo change is an ordinary `PRODUCT_UPDATED` event on the existing authoritative path |
| Authorization | the channel that starts the listener is classified **`owner`** in `channelPolicy.ts`, like every other master-data write |

### Measured feasibility and the real unknowns

| Question | State |
| :--- | :--- |
| Can Electron 44 run an HTTP listener? | **Yes** — `node:http` is built in; no dependency |
| Does a QR need a dependency? | **Yes** (§N) |
| Windows Firewall on first inbound bind | 🔴 **UNKNOWN, and the biggest operational risk.** Windows prompts on first listen, and the prompt needs administrator consent. If the merchant clicks "Cancel", the feature is silently dead. Must be measured on the real installed build; an installer-time firewall rule is the alternative and is itself a decision |
| Which interface's IP goes in the QR? | 🔴 Multiple interfaces are normal (Wi-Fi + Ethernet + virtual adapters). Needs an explicit choice, shown to the merchant, not guessed |
| Router with no internet | **Fine** — this is pure LAN; no internet is required at any point |
| Guest / AP-isolation Wi-Fi | 🔴 Blocks phone→PC entirely. Undetectable in advance; the UX must time out gracefully and say what to check |
| Phone camera/picker over HTTP | **Works** via `capture` (above) |

### If LAN proves unreliable

Alternatives considered: a cloud relay (**rejected** — breaks offline-first, sends shop data off
site), Bluetooth (no API path in Electron), USB/MTP browsing (that *is* "manually moving files"),
and a desktop companion app (a second product). **None is better.** So the recommendation is:
**the desktop picker is the guaranteed path and always remains visible; the phone QR is an
enhancement that may fail and must fail politely.** Shipping the phone path *first* would be
betting the feature on an unmeasured firewall prompt.

---

## N · Recommended QR / LAN MVP

**The MVP is the listener in §M plus a QR, and the QR is a dependency decision.**

There is no QR encoder in this repository and no library that could produce one. Three options:

| Option | Cost | Verdict |
| :--- | :--- | :--- |
| Add `qrcode` (pure JS, no native build) | **+1 runtime dependency** — the second ever, after `better-sqlite3`. No `npmRebuild` impact, so the Windows build and `asarUnpack` are unaffected | **Recommended, if the phone feature is approved** |
| Hand-roll a QR encoder | ~300–400 lines of bit-level Reed–Solomon with its own test burden, to avoid one audited dependency | Rejected — this is not where the project's effort belongs |
| No QR: show the URL + a 6-digit code | Zero cost | Rejected as the *primary* UX — typing `http://192.168.1.23:51734/u/…` on a phone is the friction the feature exists to remove. **Keep it as the fallback line under the QR**, for a phone that cannot scan |

**Sequencing recommendation:** build and ship the listener + upload path with the typed-URL fallback
only, prove the firewall and interface behaviour on the real installed build, and add the QR
dependency once the transport is known to work. That way the dependency is added to something
proven, not to a hypothesis.

---

## O · Catalog JSON schema proposal

```
Alzabt-Shop-Export-2026-10-11/
  catalog.json
  catalog.csv            ← §P (not the import file)
  images/
    <product-id>.jpg
  manifest.json          ← file list + SHA-256 of every file
```

```json
{
  "catalog_version": 1,
  "generated_at": "2026-10-11T09:14:03.221Z",
  "shop": { "name_ar": "…", "name_en": "…" },
  "currency": "LBP",
  "categories": [
    { "id": "cat_7x…", "name_ar": "براغي", "name_en": "Screws", "sort_order": 1 }
  ],
  "products": [
    {
      "id": "merchant-csv:A-1042",
      "sku": "A-1042",
      "barcode": null,
      "name_ar": "برغي 10 مم",
      "name_en": "Screw 10mm",
      "category_id": "cat_7x…",
      "brand": "Bosch",
      "price": "3.50",
      "currency": "LBP",
      "unit": "piece",
      "description_ar": "…",
      "description_en": null,
      "specs": [ { "label_ar": "القياس", "label_en": "Size", "value": "10 mm" } ],
      "images": [
        { "file": "images/merchant-csv_A-1042.jpg", "mime": "image/jpeg",
          "sha256": "…", "width": 1200, "height": 900, "bytes": 184233 }
      ],
      "updated_at": "2026-10-09T11:02:55.100Z"
    }
  ]
}
```

Notes that are decisions, not formatting:

- **`id` is the stable key, and it is `catalog_products.id`.** Not the SKU. SKU is **nullable** and
  **editable** — the schema's own `UNIQUE INDEX … WHERE sku IS NOT NULL` says so — so a website
  keyed on SKU breaks the first time a merchant fixes a typo or sells something unlabelled. The
  brief's instinct here was right and the schema confirms it.
- 🔴 **One wart to decide now, cheaply:** imported ids look like `merchant-csv:A-1042` — the import
  *source scheme* leaks into the website's public identifiers. Options: export the id verbatim
  (ugly, perfectly stable), or export a `slug`/hash derived from it once and stored. Recommend
  **verbatim now**, since a stored public id is an additive column available any time, and inventing
  one today means maintaining a second identity before any website exists.
- **`price` is decimal text**, produced from integer minor units — never a float, anywhere, the same
  rule `toImportCsv` already follows.
- **`barcode: null`** appears from version 1 so the website contract does not change shape when
  barcode lands.
- **`catalog_version`** is the contract version, bumped only on a breaking change. `generated_at`
  and per-product `updated_at` are what a future incremental sync needs; shipping them in stage 1
  is what keeps stage 3 from being a redesign.

**Explicitly excluded, and this is an allow-list not a deny-list** — the exporter builds the payload
field by field from a projection, so a column added to `catalog_products` tomorrow does **not** appear
in the export by accident. That inversion is the only way the exclusion list stays true: `operators`,
PIN salts/hashes, lockout state, `audit_events`, `sales`, `sale_lines`, `voids`, `invoices`,
`invoice_lines`, `invoice_reconciliation`, `catalog_imports`, `company_profile` beyond the shop's
public name, backups, internal settings, logs, every absolute filesystem path, and
`price_needs_review` / `is_active` / `source` / `source_key` (internal operational state).

🔴 **Never upload the SQLite database.** The export is a built artifact; the database is the shop's
private operational record, and after migration 8 it contains credential material.

---

## P · Excel contract — and a revision to the earlier doc

Measured: `IMPORT_HEADER` is **exact-matched** (`catalogImport.ts:129`) and `toImportCsv` writes
**exactly that header** so an export can be edited and re-imported. That round-trip is a real
contract real merchant files are shaped to.

The earlier doc proposed teaching the import to accept the current seven columns **or** the seven plus
`category`. **I am revising that to: leave the round-trip file alone and add a second, separate
export.**

| File | Job | Header |
| :--- | :--- | :--- |
| `catalog.csv` (existing export) | **Round-trip**: price/name/unit bulk edit, re-importable | the current 7, **unchanged forever** |
| `catalog-review.csv` (new, export-only) | Merchant review of enrichment: category, brand, descriptions, has_image, readiness, online flag | its own wider header, **not importable in v1** |

Why the revision: descriptions and specifications in a CSV cell are quoting-fragile (embedded commas,
newlines, Arabic punctuation) and genuinely unpleasant to edit in Excel, and making the *one*
re-importable file wider puts the merchant's working price-list workflow at risk for a field they
will edit in the app anyway. Two files, two jobs — which is exactly the separation §9 of the brief
asked for, applied one level more strictly.

If bulk enrichment editing is later genuinely needed, *then* teach the import a second accepted
header — additively, with the legacy seven still accepted, and with a test that proves an existing
merchant file still imports. Not before.

Two existing properties to preserve and to **assert in tests** rather than trust:

- The import's `UPDATE` touches only `name_ar, name_en, selling_price_minor, currency, base_unit,
  price_needs_review, is_active, updated_at`. It must **never** touch `category_id`, `brand`,
  descriptions, `is_online_visible` or images — so a re-import **preserves** everything the merchant
  entered in the app. That falls out of the current code; it should be nailed down by a test, because
  the day someone writes `UPDATE … SET *` it would silently erase months of enrichment.
- UTF-8 BOM + CRLF, so Excel reads Arabic correctly. Both new exports keep it.

🔴 **`.xlsx` is a dependency decision.** There is no spreadsheet library. CSV with a BOM opens in
Excel natively and costs nothing. Recommend **CSV for v1**; `.xlsx` only if the merchant hits a real
CSV limitation, and then as an explicit decision with a named package.

---

## Q · Image export contract

- `images/<product-id>.<ext>`, one file per image, **real bytes** — never base64 in JSON, never in a
  spreadsheet cell.
- Filename from the **product id** (sanitised for the filesystem: `:` → `_`), never the SKU (nullable)
  and never the Arabic name (encoding and length traps on Windows and on web servers).
- Every image carries `mime`, `sha256`, `width`, `height`, `bytes` in `catalog.json` — so the website
  can verify what it received, and a future incremental sync can skip unchanged images by hash
  instead of re-uploading everything.
- `manifest.json` lists **every file in the export** with its SHA-256, including `catalog.json`
  itself. Per this project's own lesson about enumerations going blind, the manifest is generated
  from the files actually written and the export verifies the count it expected against the count it
  wrote — a missing image must **fail the export**, not produce a quietly shorter folder.
- A product marked online-visible whose image fails to decode is **excluded and reported**, not
  exported with a dangling `images` entry.

---

## R · Invoice → Product Master enrichment

🔴 **The prefill already exists and already behaves correctly.** Measured at
`invoiceService.ts:1164` (`createProductFromInvoice`):

- `name_ar` ← the invoice line's `description` (overridable by what the operator types)
- `price` ← the line's own `unit_price_minor`, as exact decimal text
- `base_unit` ← `canonical_unit`, else a mapping from `unit_label`, else it **refuses** with
  `RESOLUTION_INCOMPLETE` and asks for the unit. It does not guess.
- `name_en` ← **only if typed.** The code's own comment: *"🔴 Never inferred from the description.
  Absent stays absent."*
- `sku` ← only if typed
- idempotent: a retry after a lost acknowledgement records the existing product instead of creating
  a second one
- the finalized invoice line is **never** modified, and `product_id` is deliberately not a FK

So the enrichment story needs **no new backend contract**, only two additions:

1. **Carry nothing new in.** Category, brand, barcode, descriptions and photo stay `NULL` after
   creation. An invoice knows none of them, and inventing any of them from a supplier's line text is
   exactly what the existing comment refuses.
2. **Offer the next step, don't force it.** After `أضف كصنف جديد` succeeds, the reconciliation panel
   shows the created product with one quiet action — «أكمل بيانات الصنف» / "Complete product
   details" — which opens Product Master prefilled. The operator may ignore it forever; the product
   is already sellable (tier A is satisfied) and the readiness indicator carries the reminder.

Similarity candidates stay **advisory only**, and `Create as new product` stays available even when
a similar name exists — the behaviour merged in PR #12.

One authorization note: `resolveCreateProduct` is classified **`owner`** in `channelPolicy.ts`. So
catalog enrichment from reconciliation is an owner activity today. If Salman wants a cashier to be
able to enrich, that is a deliberate policy change with its own decision, not a side effect of this
work.

---

## S · Invoice PDF archive

**Today there is no archive.** Measured: `saveInvoicePdfFile` (`main.ts:356`) is a manual
save-as — suggested name `invoice-<number>.pdf`, default directory `app.getPath("documents")` — and
nothing writes a PDF anywhere unless the operator asks. `grep archive` in `main.ts` returns nothing.

### 🔴 And reprint re-renders, which is a latent integrity issue worth naming

`renderInvoicePdf` calls `renderInvoiceDocument(view, …)` on the frozen DTO every time
(`main.ts:310`, `:335`, `:358`). The *data* is frozen — number, date, words, issuer snapshot, lines —
so money cannot drift. But the **document template** is code, 362 lines of it, and it changes. So an
invoice issued today and reprinted next year is rendered by **next year's template**. Nobody has
noticed because the template has only ever improved, but it means the shop cannot prove that the
paper it hands a customer now is byte-identical to the paper it handed them in 2026.

**Recommendation: archive the exact finalized PDF, and serve it on reprint.**

```sql
-- PROPOSAL, its own migration (§V, M12)
CREATE TABLE invoice_documents (
  invoice_id   TEXT    PRIMARY KEY REFERENCES invoices (id),
  file_name    TEXT    NOT NULL,          -- bare name inside the archive dir, never a path
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0),
  sha256       TEXT    NOT NULL CHECK (length(sha256) = 64),
  archived_at  TEXT    NOT NULL,
  renderer_build TEXT  NOT NULL           -- which build produced it, for forensics
) STRICT;
```

- **Where the bytes live: a managed directory, not a BLOB.** This is the opposite of the photo
  decision, and deliberately so: invoice PDFs grow without bound (every invoice, forever, ~100–300KB)
  while photos are bounded by the product count. Putting them in SQLite would grow the database the
  daily `VACUUM INTO` must copy, every day, forever. **The consequence is that the backup must become
  an archive** — §U.
- **Reprint serves the archived file when its SHA-256 matches**, and re-renders only when the file is
  missing or fails that check — logging that it did, and never claiming the reprint is the original.
- **Crash safety:** write to a temp name, `fsync`, rename — the same atomic-rename discipline the
  snapshot path already uses. Archiving happens **after** the ledger commit, and a failed archive
  must **never** fail finalization: the ledger is the truth and the PDF is a derivative. The row
  records that it is missing, and a quiet "re-archive missing documents" repair pass can fill gaps.
- **No change to invoice finalization is proposed in this study** beyond that ordering, and nothing
  here is approved.

---

## T · Documents / Invoices folder design

Salman's preferred UX — `Documents/Alzabt POS/Invoices/YYYY/MM/*.pdf` with an **Open Invoice Folder**
button — is right as *the merchant's view*. It is wrong as the *authoritative* store, for three
measured Windows realities:

| Risk | Consequence if Documents is authoritative |
| :--- | :--- |
| **OneDrive redirection** | `app.getPath("documents")` returns the redirected path, so the archive silently lives in a synced folder. With *Files On-Demand*, a file may be a **placeholder** — a read can stall or fail with no bytes locally. An archive that might not be readable is not an archive |
| Merchant renames/deletes/moves the folder | The archive vanishes and the app cannot tell whether it was ever written |
| Per-machine install, multiple Windows users | Each user has a different Documents path; the archive fragments across profiles |

**Recommendation — mirror, not master:**

```
AUTHORITATIVE   %APPDATA%/alzabt-pos/invoices/YYYY/MM/invoice-<number>.pdf
                (inside userData, where the backup can reach it, where nothing syncs it)

MIRROR          Documents/Alzabt POS/Invoices/YYYY/MM/invoice-<number>.pdf
                best-effort copy. A failure is logged, never shown as an error, never blocks anything
```

- **The app creates both on first use, not the installer.** NSIS runs elevated and, in a per-machine
  install, under a different user context — so an installer-created folder can land in the wrong
  profile. The app knows the right path at runtime; the installer does not.
- **`Open Invoice Folder`** opens the mirror if it exists, else recreates it, else opens the
  authoritative archive. The operator never has to make a folder called "Invoices" by hand — that was
  the actual complaint and this answers it.
- **Uninstall:** NSIS must not delete either. Invoices are the merchant's records, not the app's.
- **Restore on a new machine** repopulates the authoritative archive from the backup package (§U) and
  rebuilds the mirror lazily.

---

## U · Backup / restore implications

**This work changes what "backup" means, and the change is not optional.**

| Asset | In today's backup? |
| :--- | :--- |
| Database (all tables) | **Yes** — `VACUUM INTO`, verified, counted against `COUNTED_TABLES` (13 tables, `operators` added for exactly this reason) |
| Product photos **as BLOBs** | **Yes, free** — measured: a 50,000-byte BLOB survives `VACUUM INTO` intact |
| Frozen invoice logos (`userData/branding/frozen/`) | 🔴 **No** — already a live gap, recorded separately |
| Archived invoice PDFs (§S) | 🔴 **No** — and would be a *new* instance of the same gap |

So: **the photo decision keeps backups honest; the PDF-archive decision breaks them.** That is the
dependency that reorders the roadmap (§W).

```
Alzabt-Backup-2026-10-11.zip
├── database.sqlite          VACUUM INTO, consistent, verified
├── invoices/YYYY/MM/*.pdf   the authoritative archive
├── branding/invoice-logo.*  the live logo
├── branding/frozen/*        every frozen logo any issued invoice points at
└── manifest.json            every file, its byte size, its SHA-256, the schema version,
                             the table counts, and the counts it EXPECTED
```

Three rules, each one a lesson this project already paid for:

1. **The manifest enumerates and the restore verifies against it.** An enumeration that verifies goes
   blind when something is missing from it — that is exactly how a snapshot with zero operators would
   have passed. So the restore compares what it found against what the manifest *said*, and a
   shortfall is a **failure**, not a shorter list.
2. 🔴 **The moment any authoritative asset lives outside SQLite, a `.sqlite` file must stop being
   described as a complete backup** — in the UI, in the release notes and in the rollback
   instructions. Today's single-file export can keep existing as "database only", clearly labelled.
3. **Closing the frozen-logo gap belongs to this package, not to a photo feature.** It is already
   live today, it is the same shape, and fixing it inside an unrelated feature is how the second
   instance of a bug gets written.

---

## V · Migration boundaries

**Do not bundle these.** Migration 7 is this project's own receipt for what one commit carrying five
unrelated things costs.

| # | Migration | Contents | Depends on |
| :--- | :--- | :--- | :--- |
| **8** | `operator_accounts` | 🔴 **DO NOT TOUCH.** In flight on `feat/operator-accounts-v1` | — |
| **9** | `catalog_categories` | the table + `category_id` + index | 8 merged |
| **10** | `catalog_online_content` | `brand`, `description_ar/en`, `is_online_visible` | 9 |
| **11** | `catalog_product_images` | the child table | 10 (same form) |
| **12** | `invoice_documents` | PDF archive metadata | independent — **can run in parallel** |
| **13** | `catalog_product_specs` | `specs_json`, only if §J is approved | 10 |

All of 9–11 and 13 are **additive**: no table rebuild, no backfill, no row rewritten, no released
migration edited. `catalog_products` is referenced by nothing, so `ADD COLUMN` suffices — measured on
a STRICT table in the earlier study. 12 creates one new table and touches nothing existing.

**Rollback for each** is the automatic pre-migration snapshot the runner already takes, because SQLite
cannot drop a column without a rebuild on this project's pinned path. And once migration 8 ships,
rollback carries its new meaning — restore the backup **then** install the older EXE — which must be
in every release note from here on.

**Payment settlement is a separate business domain and appears nowhere above.** Nor does inventory,
nor barcode.

---

## W · Implementation order — with three challenges

Salman's stated order, and where measured architecture disagrees:

| | Salman's order | Recommendation |
| :--- | :--- | :--- |
| 1 | Operator Accounts V1 | ✅ **Unchanged.** Finish it, merge it, ship the installer |
| 2 | Product Master foundation | 🔴 **Merge with Category** — see challenge 1 |
| 3 | Category | 🔴 folded into 2 |
| 4 | Descriptions / online fields | ✅ next |
| 5 | Desktop Product Photo | ✅ next |
| 6 | Phone Product Photo | ✅ after desktop, and gated on the firewall measurement |
| 7 | Online Catalog Export | ✅ |
| 8 | Invoice PDF archive | 🔴 **Move earlier / run in parallel** — challenge 2 |
| 9 | Complete Backup Package | 🔴 **Must land WITH the PDF archive, not after** — challenge 3 |
| 10 | Automatic website sync | ✅ last, and §O's `updated_at` + stable ids already prepare it |

**Challenge 1 — Category is not a separate phase from the Product Master form.** The form's whole
redesign is a section layout, and whether a Category control exists changes section 1's contents,
tab order and readiness indicator. Building the form, then rebuilding it two weeks later to insert a
dropdown, is the waste. Ship **M9 + the restructured form** as one unit.

**Challenge 2 — the invoice PDF archive protects documents that already exist.** Everything else on
this list adds capability; this one is the only item that stops an existing risk from growing. Every
day it waits is another day of invoices whose reprint fidelity depends on nobody ever changing a
362-line template. It is also **fully independent** of the product-master chain — different tables,
different screens — so it does not have to queue behind seven items.

**Challenge 3 — the backup package is a dependency of the PDF archive, not a later nicety.**
Shipping an authoritative PDF archive while backups remain a single `.sqlite` file knowingly creates
a second frozen-logo gap, at a larger scale, in the part of the product that is supposed to be the
shop's safety net. They land together or the archive waits.

Recommended sequence:

```
NOW      Operator Accounts V1  → gate → review → merge → shop installer
THEN     M9 Category + Product Master form restructure          ─┐ product-master track
         M10 online content fields (+ readiness, visibility)     │
         M11 + desktop photo (nativeImage resize)                │
         phone photo (firewall measured first; QR dep after)     │
         M12 PDF archive + backup package together              ─┘ independent, can start any time
LAST     Online Catalog Export  (JSON + CSV review + images + manifest)
FUTURE   website uploader → automatic sync
```

The export is deliberately **last** within the catalog track, not first: exporting fields the form
cannot yet fill produces an empty contract that then has to change shape.

---

## X · Open decisions for Salman

1. **Descriptions: one per language, as recommended (§G)** — or do you want short + full from day one?
2. **Brand: free text with suggestions (§I)** — or normalize now? (My recommendation is free text, with
   a named condition that flips it.)
3. **Specifications: approve the JSON-array model and defer to M13 (§J)** — or drop specs from the
   roadmap entirely for now?
4. **Images in a child table rather than three columns on `catalog_products` (§L revision)** — this is
   a change from the earlier feasibility doc and I would rather you ratify it than inherit it.
5. **Automatic resize/compress with Electron's `nativeImage` (§L)** — yes? It is dependency-free, and
   the alternative is rejecting the merchant's phone photo.
6. **WEBP: dropped from v1** until `nativeImage` decode is measured on the real Windows build. Accept?
7. **The phone-photo feature: approved to study further, or to build?** And if build: the
   **firewall-first** sequencing (§N) — prove the transport with a typed URL, add the `qrcode`
   dependency afterwards?
8. **Invoice PDF archive: authoritative inside `userData`, Documents as a best-effort mirror (§T)** —
   or do you want Documents itself authoritative, accepting the OneDrive placeholder risk?
9. **Reprint from the archived PDF rather than re-rendering (§S)** — this changes what a reprint *is*.
10. **The backup package (§U) ships with the PDF archive.** Accept the coupling, or defer both?
11. **Public product id: export `merchant-csv:A-1042` verbatim (§O)** — or mint a stored public id now?
12. **The Excel split (§P revision): the round-trip file never widens; enrichment gets its own
    export-only CSV.** This revises the earlier doc's "accept both headers" proposal.

---

## Confirmed / Side findings / Unknowns

**Confirmed** — every claim above is a real read of `0e1e8d1` or a quoted earlier measurement: the
13-column `catalog_products` never altered since migration 3; zero category/brand/image/description
columns anywhere; one runtime dependency; no HTTP server, no image library, no QR library; the
6-control product form; the exact-matched 7-column import header and the export that mirrors it;
`VACUUM INTO` as the only backup mechanism and `COUNTED_TABLES`' 13 entries; `nativeImage`'s
`createFromBuffer/resize/toJPEG/toPNG` at the cited lines with no `toWEBP`; `createProductFromInvoice`
at `invoiceService.ts:1164` prefilling name/price/unit and refusing to infer `name_en`;
`renderInvoiceDocument` re-rendering on every reprint at `main.ts:310/335/358`.

**Side findings** (noticed while measuring, not the subject):
1. 🔴 **Reprint re-renders through the current template** (§S). The data is frozen; the document is
   not. Not a bug today, and a real integrity limit worth naming.
2. The frozen-logo backup gap is **still open** and would be joined by a PDF-archive gap.
3. `resolveCreateProduct` is **owner-only**, so catalog enrichment from reconciliation is an owner
   activity — a product decision nobody has explicitly made.
4. `exportCatalog` checks `currentCashier()` *inside the handler* as well as via `channelPolicy`.
   Harmless redundancy, not a defect; worth knowing before anyone "simplifies" it.

**Unknowns** — not resolvable in this environment, and not papered over:
1. 🔴 **Windows Firewall behaviour** on the first inbound bind, and whether a declined prompt kills
   the phone-photo feature silently. Needs the real installed build.
2. 🔴 **WEBP decode** via `nativeImage.createFromBuffer` on Windows.
3. Which network interface a real shop PC should advertise, and whether the shop's Wi-Fi uses AP
   isolation.
4. Real photo sizes a merchant's phone produces, and therefore the true DB growth per product.
5. Whether `.xlsx` is ever genuinely needed over BOM-prefixed CSV.
