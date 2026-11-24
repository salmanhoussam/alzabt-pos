"""
Builds the deliverables from catalog_def.py (the one source):
  alzabt-demo-product-catalog.xlsx   master workbook (editable, reusable for a new shop)
  alzabt-demo-catalog-import.csv     the EXACT import file the app accepts (UTF-8 + BOM, CRLF)
  catalog.json                       the same definition as JSON (read by e2e/demo-catalog.mjs and
                                     tests/fixtures/demoCatalogFixture.test.ts)
Run from this folder:  python build_files.py   (needs openpyxl). README.md is hand-written.
"""
import json, os
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
import catalog_def as c

HERE = os.path.dirname(os.path.abspath(__file__))
credits = json.load(open(os.path.join(HERE, "image-credits.json"), encoding="utf-8"))
cat = {k: (ar, en) for k, ar, en in c.CATEGORIES}

IMPORT_HEADER = ["source_id", "name_ar", "name_en", "price", "currency", "base_unit", "price_needs_review"]


def csv_cell(v):
    v = "" if v is None else str(v)
    return f'"{v.replace(chr(34), chr(34) * 2)}"' if any(ch in v for ch in ',"\r\n') or v != v.strip() else v


# ── catalog.json — the definition, for the Node-side tests ─────────────────────────────────────
with open(os.path.join(HERE, "catalog.json"), "w", encoding="utf-8", newline=chr(10)) as f:
    json.dump(dict(currency=c.CURRENCY, categories=[list(x) for x in c.CATEGORIES], products=c.PRODUCTS), f, ensure_ascii=False, indent=1)
    f.write(chr(10))

# ── CSV, exactly the app's format ───────────────────────────────────────────────────────────────
rows = [IMPORT_HEADER] + [[p["source_id"], p["name_ar"], p["name_en"] or "", p["price"], c.CURRENCY, p["unit"], "1" if p["needs_review"] else "0"] for p in c.PRODUCTS]
with open(os.path.join(HERE, "alzabt-demo-catalog-import.csv"), "w", encoding="utf-8-sig", newline="") as f:
    f.write("\r\n".join(",".join(csv_cell(v) for v in r) for r in rows) + "\r\n")

# ── Workbook ────────────────────────────────────────────────────────────────────────────────────
wb = Workbook()
HEAD = PatternFill("solid", fgColor="1F3A5F")
IMPORTED = PatternFill("solid", fgColor="DCEBFA")
SCREEN = PatternFill("solid", fgColor="E8F5E9")
NOTE = PatternFill("solid", fgColor="FFF4E5")
thin = Side(style="thin", color="C8CED6")
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)


def style_header(ws, ncols, fills=None):
    for i in range(1, ncols + 1):
        cell = ws.cell(row=1, column=i)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = HEAD if not fills else fills[i - 1]
        if fills:
            cell.font = Font(bold=True, color="1F3A5F")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BOX
    ws.row_dimensions[1].height = 34
    ws.freeze_panes = "A2"


def widths(ws, w):
    for i, x in enumerate(w, 1):
        ws.column_dimensions[get_column_letter(i)].width = x


# Sheet 1 — README
ws = wb.active
ws.title = "README"
lines = [
    ("Alzabt POS — Demo Product Catalog (realistic, offline)", True),
    ("Built 2026-11-09 for testing and showcasing on an ISOLATED profile. Never import into a real shop's ledger.", False),
    ("", False),
    ("WHAT THE APP ACTUALLY SUPPORTS (measured in the code, not assumed)", True),
    ("• Import file: CSV UTF-8 only, exactly 7 columns — sheet 'Import CSV' (blue columns on 'Products'). XLSX is NOT importable.", False),
    ("• Set afterwards in the product screen (green columns): SKU, barcode, category, brand, Arabic/English description, active status, photo.", False),
    ("• Photos: one per product, added from the product screen (or the phone); stored INSIDE the ledger, so backups carry them. No bulk image import exists.", False),
    ("• NOT in this app at all (so not in this file): cost price, stock quantity, per-product tax (tax is set per invoice).", False),
    ("", False),
    ("DATA RULES USED", True),
    ("• Prices: demonstration values in USD, internally consistent — NOT current market prices.", False),
    ("• Barcodes: EAN-13 with valid check digits in the GS1 in-store prefix 200 (restricted circulation) — they can never match a real manufacturer's product.", False),
    ("• SKUs and source_ids are unique. The 8 original café TEST products keep their SKUs and prices, so existing test coverage is preserved.", False),
    ("• Photos: Wikimedia Commons, CC0 / public domain only, each chosen by eye; source and licence in sheet 'Image credits'. No brand-packaging photos.", False),
    ("", False),
    ("DELIBERATE TEST CASES", True),
]
for p in c.PRODUCTS:
    if p["note"]:
        lines.append((f"• {p['sku']} — {p['note']}", False))
lines += [("• CLN-DISH-750 — no photo: no CC0/PD unbranded image found in 3 search rounds; left empty rather than mislabelled.", False)]
for i, (t, bold) in enumerate(lines, 1):
    cell = ws.cell(row=i, column=1, value=t)
    cell.font = Font(bold=bold, size=13 if i == 1 else 11, color="1F3A5F" if bold else "222222")
    cell.alignment = Alignment(wrap_text=True, vertical="top")
ws.column_dimensions["A"].width = 150

# Sheet 2 — Products (master)
ws = wb.create_sheet("Products")
cols = [
    ("source_id", "I", 11), ("name_ar", "I", 30), ("name_en", "I", 30), ("price", "I", 9), ("currency", "I", 9),
    ("base_unit", "I", 10), ("price_needs_review", "I", 11),
    ("sku", "S", 16), ("barcode (EAN-13)", "S", 17), ("category_ar", "S", 15), ("category_en", "S", 18),
    ("brand", "S", 9), ("description_ar", "S", 34), ("description_en", "S", 36), ("active", "S", 8),
    ("image_file", "S", 18), ("test_note", "N", 40),
]
ws.append([h for h, _, _ in cols])
fills = [IMPORTED if k == "I" else SCREEN if k == "S" else NOTE for _, k, _ in cols]
for p in c.PRODUCTS:
    car, cen = cat[p["category"]]
    img = credits.get(p["sku"], {}).get("file")
    ws.append([p["source_id"], p["name_ar"], p["name_en"] or "", float(p["price"]), c.CURRENCY, p["unit"],
               1 if p["needs_review"] else 0, p["sku"], p["barcode"], car, cen, p["brand"] or "", p["desc_ar"],
               p["desc_en"] or "", "yes" if p["active"] else "no", img or "(none)", p["note"]])
style_header(ws, len(cols), fills)
widths(ws, [w for _, _, w in cols])
for r in range(2, ws.max_row + 1):
    ws.cell(row=r, column=4).number_format = "0.00"
    ws.cell(row=r, column=9).number_format = "@"
    for col in range(1, len(cols) + 1):
        ws.cell(row=r, column=col).border = BOX
        ws.cell(row=r, column=col).alignment = Alignment(vertical="center", wrap_text=col in (2, 3, 13, 14, 17))
tab = Table(displayName="Products", ref=f"A1:{get_column_letter(len(cols))}{ws.max_row}")
tab.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
ws.add_table(tab)
ws.cell(row=ws.max_row + 2, column=1, value="Blue = imported by the CSV · Green = set in the product screen after import · Orange = test notes only").font = Font(italic=True)

# Sheet 3 — Import CSV (exactly what the importer reads)
ws = wb.create_sheet("Import CSV")
for r in rows:
    ws.append(r)
style_header(ws, len(IMPORT_HEADER))
widths(ws, [11, 30, 30, 9, 9, 10, 11])
for r in range(2, ws.max_row + 1):
    ws.cell(row=r, column=4).number_format = "@"
ws.cell(row=ws.max_row + 2, column=1, value="Do not re-save this sheet as the import file: use alzabt-demo-catalog-import.csv (UTF-8). Prices are text so 2.50 stays 2.50.").font = Font(italic=True)

# Sheet 4 — Categories
ws = wb.create_sheet("Categories")
ws.append(["key", "name_ar", "name_en", "products"])
for k, ar, en in c.CATEGORIES:
    ws.append([k, ar, en, sum(1 for p in c.PRODUCTS if p["category"] == k)])
style_header(ws, 4)
widths(ws, [12, 18, 22, 10])

# Sheet 5 — Image credits
ws = wb.create_sheet("Image credits")
ws.append(["sku", "image_file", "bytes", "licence", "source (Wikimedia Commons)", "author (as recorded)", "note"])
import re
for p in c.PRODUCTS:
    cr = credits.get(p["sku"], {})
    artist = re.sub(r"<[^>]+>", "", cr.get("artist_html", "") or "").strip()
    ws.append([p["sku"], cr.get("file") or "(none)", cr.get("bytes"), cr.get("licence", ""), cr.get("source_page", ""),
               artist, cr.get("reason") or (f"same photo as {cr['shared_with']}" if cr.get("shared_with") else "")])
style_header(ws, 7)
widths(ws, [15, 18, 9, 14, 70, 30, 50])

out = os.path.join(HERE, "alzabt-demo-product-catalog.xlsx")
wb.save(out)
print("xlsx:", out, "| products:", len(c.PRODUCTS), "| csv rows:", len(rows) - 1)
