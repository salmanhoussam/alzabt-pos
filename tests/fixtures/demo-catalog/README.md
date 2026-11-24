# Demo catalog — test and demonstration fixture

40 products in 8 categories, 38 photos. Used by `e2e/demo-catalog.mjs` and checked by
`tests/fixtures/demoCatalogFixture.test.ts`.

> **Never import this into a real shop's ledger.** Use an isolated profile only
> (`ALZABT_POS_USER_DATA=<new empty folder>`). The app never loads this catalogue by itself:
> it is not packaged into the installer (`package.json` → `build.files`), and no code path reads
> this folder. A real shop that imports similar products is still a real shop.

## Files

| File | What it is |
|---|---|
| `catalog_def.py` | **The one source.** Every product, category and test note is defined here. |
| `build_files.py` | Rebuilds every file below from `catalog_def.py` and `image-credits.json` (`python build_files.py`, needs `openpyxl`). |
| `catalog.json` | The same definition as JSON, read by the Node tests. |
| `alzabt-demo-catalog-import.csv` | The **only** file the app imports. CSV UTF-8 with BOM, exactly 7 columns: `source_id,name_ar,name_en,price,currency,base_unit,price_needs_review`. |
| `alzabt-demo-product-catalog.xlsx` | Master workbook. Sheets: README, Products, Import CSV, Categories, Image credits. Editable; reusable as a template for a new shop. |
| `images/<SKU>.jpg` | 38 photos, 640×640 JPEG, 23–137 KB each. |
| `image-credits.json` | For every SKU: the Commons file, source page, licence and author, or why there is no photo. |
| `image-licence-check.json` | The licence metadata as Commons reported it on 2026-11-09 (licence, copyrighted flag, restrictions, attribution required). |

> **Line endings.** `build_files.py` writes the CSV with CRLF (what Excel produces). Git stores it
> with LF, by this repo's `.gitattributes` rule (`* text=auto eol=lf`). The importer reads both, and
> `demoCatalogFixture.test.ts` passes on either form.

## What the app supports (measured in the code, not assumed)

- **Imported by the CSV:** Arabic name, English name, price, currency, unit, "price needs review".
- **Set afterwards in the product screen:** SKU, barcode, category, brand, descriptions, active
  status, photo.
- **Photos:** one per product, from the product's photo button (or the phone). They are stored
  inside the ledger, so a full backup carries them. There is **no bulk photo import**.
- **Not in the app at all, so not in this catalogue:** cost price, stock quantity, per-product
  tax. XLSX import is not supported either.

## Load it by hand (what a merchant does)

1. Open the app on an isolated profile and sign in as the owner. **Tools → Import catalog →**
   choose `alzabt-demo-catalog-import.csv`. Expect: 40 new, 1 placeholder price.
2. **Products:** create the 8 categories (sheet *Categories*). Then, for each product, fill SKU,
   barcode, category and descriptions from sheet *Products*. Untick *active* for the strawberries.
3. For each product, use the **photo button** to choose `images/<SKU>.jpg`.

## Load it automatically (the same channels, for testing)

```
npm run build
node e2e/demo-catalog.mjs          # DEMO_CATALOG_DIR defaults to this folder
DEMO_SHOWCASE_DIR=<new empty folder> node e2e/demo-catalog.mjs   # also keep a clean showcase copy
E2E_EXECUTABLE=<installed Alzabt POS.exe> node e2e/demo-catalog.mjs  # against an installed build
```

From a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first, or Electron starts as plain Node.

## Deliberate test cases

| SKU | Case |
|---|---|
| COF-ESP, COF-LAT, WTR-500, CRS-BTR, MAN-ZTR, JUC-ORG | The 8 bundled café TEST products keep their SKUs and prices, so existing coverage still applies. |
| TEA-MNT, CKE-CHO | Same, with prices ending .99 and .33 (decimal edge cases). |
| GRC-RICE-1KG, GRC-RICE-5KG | Same name, two sizes; they share one photo. |
| GRC-COFF-250 | `price_needs_review = 1` (placeholder price). |
| GRC-SALT-1KG | No English name. One is never invented; every screen shows the Arabic name. |
| VEG-*-KG, FRT-*-KG | Sold by weight (kg). |
| FRT-STRW-KG | INACTIVE (seasonal). Must not be sellable, and its barcode must add nothing. |
| VEG-PRSL-BN | No photo, on purpose: the no-photo card must stay tidy. |
| CLN-DISH-750 | No photo: no unbranded CC0 / public-domain image was found in 3 rounds, so it was left empty rather than mislabelled. |

## Data rules

- **Prices** are demonstration values in USD, internally consistent. They are **not** market prices.
- **Barcodes** are EAN-13 with valid check digits in the GS1 prefix `200` (restricted, in-store
  circulation), so they can never match a real manufacturer's product.
- **SKUs and source ids are unique.** `demoCatalogFixture.test.ts` checks this, the check digits,
  the prices, the CSV against `catalog.json`, and every photo file against its credit.
- **No personal data and no secrets.** The shop name the E2E sets is "DEMO". The only names in
  this folder are photographers' names, kept as attribution.

## Photos and licences

Every photo comes from Wikimedia Commons and was chosen by eye, from contact sheets of 6
candidates per product, over 3 rounds. The first automatic "first free result" pass was rejected:
it had picked, for example, a museum for "water" and a chemistry diagram for "sugar". Rejected
along the way: logos, branded packaging, and a portrait of a person.

- **CC0:** 26 photos. **Public domain:** 11 photos (Commons: `Copyrighted = False`).
  That is 37 unique photos for 38 files, because the two rice sizes share one.
- Commons reported **no restrictions** (trademark, personality rights) and **attribution not
  required** for any of them (`image-licence-check.json`). Authors are still credited in
  `image-credits.json` and in the workbook's *Image credits* sheet.
- If a photo's licence is ever in doubt, delete its file and set its `image-credits.json` entry to
  `{"file": null, "reason": "…"}`, then rerun `build_files.py`. The product then simply has no
  photo, which is a supported state.
