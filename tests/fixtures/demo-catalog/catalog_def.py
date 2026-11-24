"""
Alzabt POS — realistic DEMO product catalog (owner request 2026-11-09). The ONE definition every other
script reads: the Excel master, the import CSV, the image fetch and the E2E loader.

Only fields the app really has (catalog_products + migration additions). The import CSV carries 7 of them
(source_id, name_ar, name_en, price, currency, base_unit, price_needs_review); SKU, barcode, category,
brand, descriptions, active status and the photo are set afterwards through the product screen's own
channels (updateProduct / setProductImage) — exactly what a merchant does by hand. There is NO cost price,
NO stock quantity and NO per-product tax in this app, so none is invented here.

Prices are demonstration values in USD, internally consistent, NOT current market prices.
Barcodes are EAN-13 in the GS1 in-store prefix 200 (restricted circulation): valid check digits, and they
can never collide with a real manufacturer's product.
"""

CURRENCY = "USD"

# (key, name_ar, name_en) — created through createCategory.
CATEGORIES = [
    ("cafe", "مقهى", "Café"),
    ("groceries", "مواد غذائية", "Groceries"),
    ("canned", "معلّبات", "Canned Goods"),
    ("dairy", "ألبان وأجبان", "Dairy & Cheese"),
    ("bakery", "مخبوزات", "Bakery"),
    ("produce", "خضار وفواكه", "Fruits & Vegetables"),
    ("beverages", "مشروبات", "Beverages"),
    ("cleaning", "منظّفات", "Cleaning"),
]


def ean13(body12: str) -> str:
    digits = [int(c) for c in body12]
    s = sum(d * (3 if i % 2 else 1) for i, d in enumerate(digits))
    return body12 + str((10 - s % 10) % 10)


def bc(n: int) -> str:
    return ean13(f"200{n:09d}")


# source_id, sku, name_ar, name_en, price, unit, category, brand, desc_ar, desc_en, active, needs_review,
# image_query (Wikimedia Commons search; None = deliberately no photo), notes (why this row exists for tests)
P = []


def add(source_id, sku, name_ar, name_en, price, unit, cat, desc_ar, desc_en, query, active=True, review=False, brand=None, note=""):
    P.append(dict(source_id=source_id, sku=sku, name_ar=name_ar, name_en=name_en, price=price, unit=unit, category=cat,
                  brand=brand, desc_ar=desc_ar, desc_en=desc_en, active=active, needs_review=review, query=query,
                  barcode=bc(len(P) + 1), note=note))


# ── Café: the 8 bundled TEST products, same SKUs and prices — their coverage is kept (decimal prices
#    such as 1.99 / 3.33, Arabic + English names) and they gain real photos and Arabic names.
add("CAFE-001", "COF-ESP", "إسبريسو", "Espresso", "2.50", "piece", "cafe", "فنجان إسبريسو مزدوج", "Double shot espresso", "espresso cup coffee", note="bundled test SKU kept")
add("CAFE-002", "COF-LAT", "كافيه لاتيه", "Caffè Latte", "3.75", "piece", "cafe", "قهوة بالحليب المبخّر", "Espresso with steamed milk", "caffe latte cup", note="bundled test SKU kept")
add("CAFE-003", "TEA-MNT", "شاي بالنعناع", "Mint Tea", "1.99", "piece", "cafe", "شاي أخضر مع نعناع طازج", "Green tea with fresh mint", "mint tea glass", note="bundled test SKU; price .99")
add("CAFE-004", "WTR-500", "مياه 500 مل", "Water 500ml", "0.75", "piece", "beverages", "مياه شرب معبّأة", "Bottled drinking water", "plastic water bottle", note="bundled test SKU kept")
add("CAFE-005", "CRS-BTR", "كرواسان بالزبدة", "Butter Croissant", "2.25", "piece", "bakery", "كرواسان فرنسي بالزبدة", "French butter croissant", "croissant", note="bundled test SKU kept")
add("CAFE-006", "MAN-ZTR", "منقوشة زعتر", "Zaatar Manousheh", "1.50", "piece", "bakery", "منقوشة زعتر وزيت زيتون", "Zaatar and olive oil flatbread", "manakish zaatar", note="bundled test SKU kept")
add("CAFE-007", "JUC-ORG", "عصير برتقال طازج", "Fresh Orange Juice", "4.10", "piece", "beverages", "عصير برتقال معصور طازجاً", "Freshly squeezed orange juice", "glass of orange juice", note="bundled test SKU kept")
add("CAFE-008", "CKE-CHO", "قطعة كيك شوكولا", "Chocolate Cake Slice", "3.33", "piece", "cafe", "قطعة كيك بالشوكولا", "Slice of chocolate cake", "chocolate cake slice", note="bundled test SKU; price .33")

# ── Groceries
add("GRC-001", "GRC-RICE-1KG", "أرز طويل الحبة 1 كغ", "Long Grain Rice 1 kg", "2.40", "pack", "groceries", "أرز أبيض طويل الحبة", "White long-grain rice", "white rice grains bowl", note="same name, two sizes (with GRC-002)")
add("GRC-002", "GRC-RICE-5KG", "أرز طويل الحبة 5 كغ", "Long Grain Rice 5 kg", "10.50", "pack", "groceries", "أرز أبيض طويل الحبة، عبوة عائلية", "White long-grain rice, family pack", "rice sack", note="same name, two sizes (with GRC-001)")
add("GRC-003", "GRC-SUGR-1KG", "سكر أبيض 1 كغ", "White Sugar 1 kg", "1.30", "pack", "groceries", "سكر أبيض ناعم", "Fine white sugar", "white sugar")
add("GRC-004", "GRC-FLOR-1KG", "طحين متعدد الاستخدام 1 كغ", "All-Purpose Flour 1 kg", "1.10", "pack", "groceries", "طحين قمح أبيض", "White wheat flour", "wheat flour")
add("GRC-005", "GRC-LENT-1KG", "عدس أحمر 1 كغ", "Red Lentils 1 kg", "2.30", "pack", "groceries", "عدس أحمر مجروش", "Split red lentils", "red lentils")
add("GRC-006", "GRC-PAST-500", "معكرونة بيني 500 غ", "Penne Pasta 500 g", "0.95", "pack", "groceries", "معكرونة قمح قاسي", "Durum wheat pasta", "penne pasta")
add("GRC-007", "GRC-OIL-1L", "زيت نباتي 1 ل", "Vegetable Oil 1 L", "3.90", "piece", "groceries", "زيت نباتي للطبخ", "Cooking vegetable oil", "cooking oil bottle")
add("GRC-008", "GRC-OLIV-1L", "زيت زيتون بكر 1 ل", "Extra Virgin Olive Oil 1 L", "8.75", "piece", "groceries", "زيت زيتون بكر ممتاز", "Extra virgin olive oil", "olive oil bottle")
add("GRC-009", "GRC-TEA-100", "شاي أسود 100 كيس", "Black Tea 100 bags", "2.80", "box", "groceries", "أكياس شاي أسود", "Black tea bags", "black tea bags")
add("GRC-010", "GRC-COFF-250", "قهوة مطحونة بالهيل 250 غ", "Ground Coffee with Cardamom 250 g", "4.50", "pack", "groceries", "قهوة عربية مطحونة مع هيل", "Arabic ground coffee with cardamom", "ground coffee", review=True, note="price_needs_review = 1 (placeholder price)")
add("GRC-011", "GRC-SALT-1KG", "ملح طعام 1 كغ", None, "0.60", "pack", "groceries", "ملح طعام ناعم", None, "table salt", note="no English name (never invented)")

# ── Canned
add("CAN-001", "CAN-CHKP-400", "حمّص حب معلّب 400 غ", "Canned Chickpeas 400 g", "1.20", "piece", "canned", "حمّص مسلوق جاهز", "Ready cooked chickpeas", "chickpeas")
add("CAN-002", "CAN-TOMP-400", "معجون طماطم 400 غ", "Tomato Paste 400 g", "1.10", "piece", "canned", "معجون طماطم مركّز", "Concentrated tomato paste", "tomato paste")
add("CAN-003", "CAN-TUNA-160", "تونة معلّبة 160 غ", "Canned Tuna 160 g", "1.85", "piece", "canned", "تونة قطع بالزيت", "Tuna chunks in oil", "canned tuna")

# ── Dairy
add("DRY-001", "DRY-MILK-1L", "حليب كامل الدسم 1 ل", "Whole Milk 1 L", "1.20", "piece", "dairy", "حليب بقر طازج", "Fresh cow's milk", "glass of milk")
add("DRY-002", "DRY-EGGS-12", "بيض طازج 12 حبة", "Fresh Eggs 12 pcs", "3.20", "box", "dairy", "بيض دجاج طازج", "Fresh hen eggs", "eggs carton")
add("DRY-003", "DRY-CHSE-500", "جبنة بيضاء 500 غ", "White Cheese 500 g", "3.50", "pack", "dairy", "جبنة بيضاء طرية", "Soft white cheese", "feta cheese")
add("DRY-004", "DRY-YOGT-500", "لبن زبادي 500 غ", "Yogurt 500 g", "1.45", "piece", "dairy", "لبن زبادي طبيعي", "Plain yogurt", "yogurt bowl")
add("DRY-005", "DRY-LABN-400", "لبنة 400 غ", "Labneh 400 g", "2.75", "piece", "dairy", "لبنة مصفّاة", "Strained yogurt (labneh)", "labneh")

# ── Bakery
add("BKR-001", "BKR-PITA-PCK", "خبز عربي — ربطة", "Pita Bread — pack", "0.80", "pack", "bakery", "ربطة خبز عربي طازج", "Pack of fresh pita bread", "pita bread")

# ── Fruits & vegetables (sold by weight — kg, decimal quantities)
add("PRD-001", "VEG-TOMA-KG", "طماطم", "Tomatoes", "1.40", "kg", "produce", "طماطم حمراء طازجة — بالكيلو", "Fresh red tomatoes — per kg", "tomatoes", note="sold by weight")
add("PRD-002", "VEG-CUCU-KG", "خيار", "Cucumbers", "0.90", "kg", "produce", "خيار بلدي — بالكيلو", "Local cucumbers — per kg", "cucumbers")
add("PRD-003", "VEG-POTA-KG", "بطاطا", "Potatoes", "0.85", "kg", "produce", "بطاطا — بالكيلو", "Potatoes — per kg", "potatoes")
add("PRD-004", "VEG-ONIO-KG", "بصل أحمر", "Red Onions", "0.70", "kg", "produce", "بصل أحمر — بالكيلو", "Red onions — per kg", "red onions")
add("PRD-005", "FRT-BANA-KG", "موز", "Bananas", "1.50", "kg", "produce", "موز — بالكيلو", "Bananas — per kg", "bananas")
add("PRD-006", "FRT-APPL-KG", "تفاح أحمر", "Red Apples", "2.20", "kg", "produce", "تفاح أحمر — بالكيلو", "Red apples — per kg", "red apples")
add("PRD-007", "FRT-ORNG-KG", "برتقال", "Oranges", "1.80", "kg", "produce", "برتقال — بالكيلو", "Oranges — per kg", "oranges fruit")
add("PRD-008", "FRT-LEMN-KG", "حامض", "Lemons", "1.60", "kg", "produce", "حامض — بالكيلو", "Lemons — per kg", "lemons")
add("PRD-009", "FRT-STRW-KG", "فريز", "Strawberries", "4.00", "kg", "produce", "فريز موسمي — بالكيلو", "Seasonal strawberries — per kg", "strawberries", active=False, note="INACTIVE (seasonal) — must not be sellable")
add("PRD-010", "VEG-PRSL-BN", "بقدونس — ربطة", "Parsley — bunch", "0.40", "piece", "produce", "ربطة بقدونس طازج", "Bunch of fresh parsley", None, note="DELIBERATELY NO PHOTO — the no-image card must stay tidy")

# ── Cleaning
add("CLN-001", "CLN-DISH-750", "سائل جلي 750 مل", "Dishwashing Liquid 750 ml", "2.10", "piece", "cleaning", "سائل لغسيل الصحون", "Dishwashing liquid", "dishwashing liquid bottle")
add("CLN-002", "CLN-SPNG-3", "إسفنج جلي 3 قطع", "Kitchen Sponges 3 pcs", "1.25", "pack", "cleaning", "إسفنج مطبخ", "Kitchen scrub sponges", "kitchen sponge")

PRODUCTS = P
