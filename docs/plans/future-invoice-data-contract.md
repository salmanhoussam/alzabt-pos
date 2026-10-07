# FUTURE INVOICE DATA CONTRACT — findings only, nothing fixed here

Written 2026-10-07 while tracing `sale_lines` for migration 4. **Investigation only.** Nothing in
this document is implemented, and nothing here is a decision. Every claim is read from
`src/persistence/migrations.ts`, `src/domain/catalog.ts` and `src/domain/cart.ts` at
`6699f97` — not recalled.

The merchant's real invoices are prepared by hand today. They are **not produced by this POS**, they
are **not evidence that the POS can produce one**, and no merchant invoice, name, number, product
description, price, customer or supplier appears in this repository. The invoices inform *what kinds
of information* a hardware store expects; that is their whole role here.

## What a sale line preserves today

```sql
sale_lines (id, sale_id, line_no, product_id, sku, product_name,
            quantity, unit_price_minor, line_total_minor)
```

### A · Is there enough to reprint an old line? — Mostly yes

`product_name` and `sku` are snapshotted at sale time, and so are `unit_price_minor` and
`line_total_minor`. A line can be reprinted with a name, a code, a price and a total without
consulting the catalog at all. There is **no** longer description field; the name is all there is.

### B · Is the unit preserved? — 🔴 No

There is no unit column. A quantity is a bare number, and the unit it counted is not in the ledger.
This is the finding migration 4 closes, with `sale_unit` (see
`exact-quantity-contract.md` §18–21) — and it is closed there only because quantity itself requires
it: `2.5` is not interpretable, and the whole-vs-fractional rule has nothing to key off without it.

### C · Are the Arabic and English names kept separately? — 🔴 No, and English wins

One column, `product_name`, filled from `displayName(nameAr, nameEn)`, which is `nameEn ?? nameAr`
(`src/domain/catalog.ts:65`). So:

```
a product with an Arabic name only   →  the ledger keeps the Arabic name
a product with BOTH names            →  the ledger keeps the ENGLISH name, and the Arabic
                                        name is not recoverable from the sale
```

An Arabic invoice reprinted from such a line would therefore show an English item name. This is the
same root as the receipt-language finding raised the same day, seen from the ledger's side: it is
not a display bug that a later screen can correct, because the Arabic name was never written down.

**Not fixed here.** Fixing it means a second snapshot column and a decision about which name an
invoice shows — the `receipt_language` contract's business, not quantity's.

### D · If the catalog product changes after the sale, is the sale still reproducible?

| | |
|---|---|
| name, SKU, unit price, line total | ✅ snapshotted — **proven on Windows**, run 37602643503: a line rung at 4.00 still read 4.00 after the product's price was edited to 9.00 |
| the unit | ❌ absent (B) — and from migration 4 onward, present |
| the other language's name | ❌ never written (C) |
| the product still existing | not required — `sale_lines.product_id` has **no** foreign key to `catalog_products`, deliberately, and a fixture product is not in that table at all |

## FUTURE SUPPLIER INVOICE / GOODS INTAKE — TODO, not a design

A photographed or PDF supplier invoice may one day be an INPUT to catalog/stock intake:

```
invoice → extract lines → match existing products → show the matches to the operator
        → name what is unknown → operator confirms → optionally create the missing products
        → later, purchase/restock movements
```

Two rules stated now so they are never quietly lost:

- **Nothing is created silently.** An unknown item waits for a human.
- **A purchase cost never overwrites a selling price.** They are different numbers with different
  meanings, and the catalog holds only the selling price today
  (`catalog_products.selling_price_minor`).

The minimum a future matcher would need from a product — all of which exists today except the last
two:

```
id                   stable identity                              ✅ exists
name_ar              what the invoice most likely says            ✅ exists
name_en              optional second string to match on           ✅ exists (nullable)
sku                  optional exact key                           ✅ exists (tenant-unique)
base_unit            to interpret the invoice's quantity          ✅ exists
barcode              a far stronger key than any name             ❌ does not exist — later
purchase cost        kept apart from the selling price            ❌ does not exist — later
```

**Nothing above is built in migration 4**: no OCR, no vision, no ingestion, no supplier model, no
purchases, no automatic product creation, no stock intake, and no new Product field.
