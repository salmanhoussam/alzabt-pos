/**
 * The Product Master repositories and the one authoritative draft contract.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE INVARIANT THIS FILE PROTECTS ABOVE ALL OTHERS: a product with no category, no barcode, no
 * brand, no description, no photo and no online visibility is a COMPLETE, SELLABLE product. The
 * shop traded for months before any of these columns existed, and migration 9 must not have
 * quietly made enrichment a precondition for trade.
 *
 * The second one: ABSENT IS NOT NULL. Three callers write products and only the Product Master form
 * knows about enrichment, so a re-import or an invoice reconciliation must not erase a description
 * the owner typed. Absent means unchanged; null means clear.
 *
 * Synthetic data throughout.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { CategoryRepository } from "../../src/persistence/categoryRepository";
import { ProductImageRepository } from "../../src/persistence/productImageRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { validateProductDraft, validateProductMaster } from "../../src/domain/productDraft";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
let products: CatalogRepository;
let categories: CategoryRepository;
let images: ProductImageRepository;

const AT = new Date("2026-10-11T09:00:00.000Z");
const ISO = AT.toISOString();

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
  products = new CatalogRepository(db);
  categories = new CategoryRepository(db);
  images = new ProductImageRepository(db);
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const make = (nameAr: string, over: Record<string, unknown> = {}) =>
  products.createManual(
    { nameAr, nameEn: null, sku: null, priceMinor: 1000n, currency: "USD", baseUnit: "piece", ...over },
    AT,
  );

const cat = (nameAr: string, nameEn: string | null = null) =>
  categories.insert({ id: `c-${nameAr}`, nameAr, nameEn, sortOrder: categories.nextSortOrder(), now: ISO });

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("a minimal product is a complete product", () => {
  it("🔴 creates and reads back with every Product Master field empty, and is ACTIVE", () => {
    const p = make("إسمنت");
    expect(p.category_id).toBeNull();
    expect(p.barcode).toBeNull();
    expect(p.brand).toBeNull();
    expect(p.description_ar).toBeNull();
    expect(p.description_en).toBeNull();
    // 🔴 OFF the website by default. A migration or a create must never publish a shop's catalog.
    expect(Number(p.is_online_visible)).toBe(0);
    expect(Number(p.is_active)).toBe(1);
    // And it is readable through every route, carrying the same empties.
    expect(products.findById(p.id)!.brand).toBeNull();
    expect(products.listAll()).toHaveLength(1);
  });

  it("the draft contract accepts a product with no master group at all", () => {
    const valid = validateProductDraft(
      { nameAr: "رمل", nameEn: null, sku: null, price: "12.50", baseUnit: "kg" },
      "USD",
    );
    // 🔴 ABSENT, not an empty object: a caller that does not deal in enrichment says nothing, and
    // the repository then carries every field forward rather than clearing it.
    expect(valid.master).toBeUndefined();
    expect(valid.price.minor).toBe(1250n);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("ABSENT vs NULL on update — the trap that would erase an owner's typing", () => {
  it("🔴 an update that mentions NOTHING carries every enrichment field forward", () => {
    const c = cat("عدد");
    const p = make("مفك", {
      master: { categoryId: c.id, barcode: "5901234123457", brand: "Bosch", descriptionAr: "مفك براغي", descriptionEn: "Screwdriver", isOnlineVisible: true },
    });
    // This is exactly the shape invoice reconciliation and the import path send: names, price,
    // unit, active — and no `master` key.
    const after = products.updateProduct(
      p.id,
      { nameAr: "مفك براغي", nameEn: null, sku: null, priceMinor: 2000n, baseUnit: "piece", isActive: true },
      AT,
    );
    expect(after.name_ar).toBe("مفك براغي");   // the field it DID mention changed
    expect(after.category_id).toBe(c.id);       // and none of these were touched
    expect(after.barcode).toBe("5901234123457");
    expect(after.brand).toBe("Bosch");
    expect(after.description_ar).toBe("مفك براغي");
    expect(after.description_en).toBe("Screwdriver");
    expect(Number(after.is_online_visible)).toBe(1);
  });

  it("🔴 but an explicit NULL really does clear — removing a category is a real action", () => {
    const c = cat("دهان");
    const p = make("دهان أبيض", { master: { categoryId: c.id, brand: "Tinol", barcode: "96385074" } });
    const after = products.updateProduct(
      p.id,
      {
        nameAr: "دهان أبيض",
        nameEn: null,
        sku: null,
        priceMinor: 1000n,
        baseUnit: "piece",
        isActive: true,
        master: { categoryId: null, barcode: null },
      },
      AT,
    );
    expect(after.category_id).toBeNull();
    expect(after.barcode).toBeNull();
    // Untouched by this update, because it was absent rather than null.
    expect(after.brand).toBe("Tinol");
  });

  it("a partial master group touches only the fields it names", () => {
    const p = make("بلاط", { master: { brand: "RAK", descriptionAr: "بلاط أرضي", isOnlineVisible: true } });
    const after = products.updateProduct(
      p.id,
      { nameAr: "بلاط", nameEn: null, sku: null, priceMinor: 1000n, baseUnit: "piece", isActive: true, master: { isOnlineVisible: false } },
      AT,
    );
    expect(Number(after.is_online_visible)).toBe(0);
    expect(after.brand).toBe("RAK");
    expect(after.description_ar).toBe("بلاط أرضي");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("categories", () => {
  it("create, and the duplicate check asks the SAME question as the index", () => {
    const c = cat("عدد", "Tools");
    expect(c.is_active).toBe(1);
    expect(c.sort_order).toBe(0);
    // 🔴 The repository's findByNameAr mirrors `lower(trim(name_ar))`. If it did not, the service
    // would report "that name is free" and the INSERT would then fail — so this asserts the two
    // agree rather than that either works alone.
    expect(categories.findByNameAr(" عدد ")!.id).toBe(c.id);
    expect(categories.findByNameAr("عدد")!.id).toBe(c.id);
    expect(categories.findByNameAr("دهان")).toBeNull();
    // And the index itself refuses the duplicate the check predicted.
    expect(() => cat(" عدد ")).toThrow();
  });

  it("are ordered by the OWNER's order, not alphabetically", () => {
    cat("عدد");
    cat("دهان");
    cat("سباكة");
    // A hardware shop thinks "عدد" first. An Arabic alphabetical sort would not produce this.
    expect(categories.listAll().map((c) => c.name_ar)).toEqual(["عدد", "دهان", "سباكة"]);
  });

  it("🔴 RENAME preserves the product link — the id is the identity, never the name", () => {
    const c = cat("عدد");
    const p = make("مفك", { master: { categoryId: c.id } });
    categories.rename(c.id, "عدد يدوية", "Hand tools", ISO);
    expect(products.findById(p.id)!.category_id).toBe(c.id);
    expect(categories.findById(c.id)!.name_ar).toBe("عدد يدوية");
  });

  it("🔴 DEACTIVATE preserves the product link, and drops it from the chooser only", () => {
    const c = cat("عدد");
    const p = make("مفك", { master: { categoryId: c.id } });
    categories.setActive(c.id, false, ISO);
    expect(products.findById(p.id)!.category_id).toBe(c.id);
    expect(categories.listActive().map((x) => x.id)).not.toContain(c.id);
    // Still listed for the OWNER, who must be able to see and reactivate it.
    expect(categories.listAll().map((x) => x.id)).toContain(c.id);
    categories.setActive(c.id, true, ISO);
    expect(categories.listActive().map((x) => x.id)).toContain(c.id);
  });

  it("delete is allowed when unused", () => {
    const c = cat("مؤقت");
    expect(categories.countProductsUsing(c.id)).toBe(0);
    categories.delete(c.id);
    expect(categories.findById(c.id)).toBeNull();
  });

  it("🔴 the usage count includes INACTIVE products — the case nobody is looking at", () => {
    const c = cat("عدد");
    const p = make("مفك", { master: { categoryId: c.id } });
    products.setActive(p.id, false, AT);
    // A deactivated product still carries its category. Counting only active ones would make
    // `delete` destructive exactly where it is least visible.
    expect(categories.countProductsUsing(c.id)).toBe(1);
  });

  it("a product with no category is valid, and stays valid", () => {
    const p = make("رمل");
    expect(p.category_id).toBeNull();
    expect(categories.listAll()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("barcode through the repository", () => {
  it("🔴 findByBarcode finds the CANONICAL form, which is what makes uniqueness mean anything", () => {
    // The merchant types the number off the box; the canonical form is what is stored.
    const typed = validateProductMaster({ barcode: "036000291452" });
    expect(typed.barcode).toBe("0036000291452");
    const p = make("براغي", { master: { barcode: typed.barcode } });
    expect(products.findByBarcode("0036000291452")!.id).toBe(p.id);
    // 🔴 And the raw 12-digit form finds NOTHING on its own — which is why the service must
    // normalize before it queries, and why this is asserted rather than assumed.
    expect(products.findByBarcode("036000291452")).toBeNull();
  });

  it("refuses a second product with the same barcode, and allows many without one", () => {
    make("أ", { master: { barcode: "5901234123457" } });
    expect(() => make("ب", { master: { barcode: "5901234123457" } })).toThrow();
    // Two unbarcoded products are not duplicates.
    make("ج");
    make("د");
    expect(products.listAll().filter((p) => p.barcode === null)).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the image child table — bytes never travel with a list", () => {
  const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(40), "hex");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const put = (productId: string, bytes = png, over: Record<string, unknown> = {}) =>
    images.putPrimary({
      id: `img-${productId}`,
      productId,
      bytes,
      mime: "image/png",
      sha256Hex: sha(bytes),
      widthPx: 10,
      heightPx: 10,
      origin: "desktop",
      now: ISO,
      ...over,
    });

  it("🔴 NO list read returns image bytes — proven on the real rows, not by reading the SQL", () => {
    const p = make("مفك");
    put(p.id);

    // The products list: every row, and not one byte of image data anywhere in them.
    const list = products.listAll();
    expect(list).toHaveLength(1);
    for (const row of list) {
      expect(Object.keys(row)).not.toContain("bytes");
      // Nothing in the row is a Buffer at all — a stricter check than naming the column, because
      // it would also catch bytes arriving under some other name.
      expect(Object.values(row).some((v) => Buffer.isBuffer(v))).toBe(false);
    }

    // And the image metadata read is equally byte-free.
    const meta = images.findPrimaryMeta(p.id)!;
    expect(Object.keys(meta)).not.toContain("bytes");
    expect(Object.values(meta).some((v) => Buffer.isBuffer(v))).toBe(false);
    expect(meta.byte_size).toBe(png.length);
    expect(meta.sha256_hex).toBe(sha(png));

    // Bytes come only from the one method that names an image, and they round-trip exactly.
    expect(images.readBytes(meta.id)!.equals(png)).toBe(true);
  });

  it("which products have a photo is ONE small query, not one blob per row", () => {
    const a = make("أ");
    const b = make("ب");
    make("ج");
    put(a.id);
    put(b.id);
    const withPhoto = images.productIdsWithPrimary();
    expect(withPhoto.has(a.id)).toBe(true);
    expect(withPhoto.has(b.id)).toBe(true);
    expect(withPhoto.size).toBe(2);
  });

  it("🔴 ONE primary image per product: replace swaps it, and never leaves two", () => {
    const p = make("مفك");
    const first = put(p.id);
    const other = Buffer.from("89504e470d0a1a0a" + "ff".repeat(40), "hex");
    const second = images.putPrimary({
      id: "img-second",
      productId: p.id,
      bytes: other,
      mime: "image/png",
      sha256Hex: sha(other),
      widthPx: 20,
      heightPx: 20,
      origin: "phone",
      now: ISO,
    });
    expect(second.id).toBe("img-second");
    expect(second.origin).toBe("phone");
    expect(images.listMetaForProduct(p.id)).toHaveLength(1);
    // 🔴 The replaced image is GONE, not orphaned — an export must never write a stale photo.
    expect(images.readBytes(first.id)).toBeNull();
    expect(images.readBytes(second.id)!.equals(other)).toBe(true);
  });

  it("remove reports whether there was anything to remove", () => {
    const p = make("مفك");
    expect(images.removePrimary(p.id)).toBe(false);
    put(p.id);
    expect(images.removePrimary(p.id)).toBe(true);
    expect(images.findPrimaryMeta(p.id)).toBeNull();
    expect(images.productIdsWithPrimary().size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the draft contract canonicalizes and refuses truthfully", () => {
  it("keeps absent fields absent, so nothing is accidentally cleared", () => {
    const m = validateProductMaster({ isOnlineVisible: true });
    expect(m.isOnlineVisible).toBe(true);
    // 🔴 The other five keys must be ABSENT, not null. Present-and-null would reach the repository
    // as "clear it" and erase fields this caller never mentioned.
    expect("categoryId" in m).toBe(false);
    expect("barcode" in m).toBe(false);
    expect("brand" in m).toBe(false);
    expect("descriptionAr" in m).toBe(false);
    expect("descriptionEn" in m).toBe(false);
  });

  it("🔴 a description keeps its line breaks — it is prose, not a name", () => {
    // The name helper collapses whitespace, which is right for a name and would destroy the
    // paragraphs a merchant typed for the website.
    const m = validateProductMaster({ descriptionAr: "  سطر أول\n\nسطر ثانٍ  " });
    expect(m.descriptionAr).toBe("سطر أول\n\nسطر ثانٍ");
    // A name, by contrast, is collapsed — asserted here so the difference is deliberate.
    const d = validateProductDraft({ nameAr: "مفك   براغي", nameEn: null, sku: null, price: "1", baseUnit: "piece" }, "USD");
    expect(d.nameAr).toBe("مفك براغي");
  });

  it("empty text is 'not given', never an empty string in storage", () => {
    const m = validateProductMaster({ brand: "   ", descriptionAr: "", descriptionEn: null });
    expect(m.brand).toBeNull();
    expect(m.descriptionAr).toBeNull();
    expect(m.descriptionEn).toBeNull();
  });

  it("refuses what cannot be stored", () => {
    expect(() => validateProductMaster({ brand: "x".repeat(121) })).toThrow(/at most/);
    expect(() => validateProductMaster({ descriptionAr: "x".repeat(2001) })).toThrow(/at most/);
    expect(() => validateProductMaster({ descriptionAr: "bad\u0000text" })).toThrow(/control characters/);
    expect(() => validateProductMaster({ isOnlineVisible: "yes" as unknown as boolean })).toThrow(/true or false/);
    expect(() => validateProductMaster({ categoryId: "   " })).toThrow(/category/);
    // A wrong check digit is refused by the one barcode contract, through this entry point too.
    expect(() => validateProductMaster({ barcode: "5901234123458" })).toThrow(/check digit/);
  });
});

/**
 * 🔴 THE LIST PATH MUST NOT READ THE BLOB — not merely avoid returning it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS TEST EXISTS, AND IT IS NOT A HYPOTHETICAL. Every other check in this file asserts on
 * what comes OUT of the repository, and the type system guarantees that much: `ProductImageMeta`
 * has no `bytes` field, so a blob cannot reach a DTO. A mutation run against
 * `primaryMetaByProduct` proved that insufficient — adding `, bytes` to its SELECT **broke nothing
 * at all**, because `normalise()` builds its result key by key and silently ignores the extra
 * column. Every photo in the catalog would be read out of SQLite into memory on every open of the
 * products screen, and all 874 tests would still pass.
 *
 * That is the exact defect the child table was chosen to prevent, invisible to every output-shaped
 * assertion. So this asserts on the SQL the repository really prepares, by recording it through a
 * proxy — not on a copy of the SQL, which would pass while the code did something else.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("🔴 the metadata reads never touch the bytes column", () => {
  let t: TempDir;
  let db: Db;

  beforeEach(() => {
    t = tempDir();
    db = openDatabase(t.dbPath);
  });
  afterEach(() => {
    db.close();
    t.cleanup();
  });

  /** A db that records every SQL string prepared through it, and otherwise behaves exactly as it is. */
  function recording(real: Db): { db: Db; sql: string[] } {
    const sql: string[] = [];
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (text: string) => {
            sql.push(text);
            return target.prepare(text);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { db: proxy as Db, sql };
  }

  const mentionsBytes = (statements: readonly string[]) => statements.filter((s) => /\bbytes\b/i.test(s));

  it("primaryMetaByProduct — the products list's one read — prepares no statement naming `bytes`", () => {
    const { db: spy, sql } = recording(db);
    const images = new ProductImageRepository(spy);
    images.primaryMetaByProduct();
    expect(sql).toHaveLength(1);
    expect(mentionsBytes(sql)).toEqual([]);
  });

  it("neither do findPrimaryMeta, findMetaById or listMetaForProduct", () => {
    const { db: spy, sql } = recording(db);
    const images = new ProductImageRepository(spy);
    images.findPrimaryMeta("p1");
    images.findMetaById("img-1");
    images.listMetaForProduct("p1");
    images.productIdsWithPrimary();
    expect(sql.length).toBeGreaterThanOrEqual(4);
    expect(mentionsBytes(sql)).toEqual([]);
  });

  it("🔴 CONTROL — readBytes DOES name it, so the assertion above discriminates", () => {
    // Without this, a repository that never read bytes at all — or a `mentionsBytes` that never
    // matched anything — would satisfy the two tests above while proving nothing.
    const { db: spy, sql } = recording(db);
    new ProductImageRepository(spy).readBytes("img-1");
    expect(mentionsBytes(sql)).toHaveLength(1);
  });

  it("🔴 and putPrimary names it too — the one write path, which is supposed to", () => {
    const { db: spy, sql } = recording(db);
    const catalog = new CatalogRepository(spy);
    const product = catalog.createManual(
      { nameAr: "مفك", nameEn: null, sku: null, priceMinor: 500n, currency: "USD", baseUnit: "piece" },
      new Date("2026-10-13T09:00:00.000Z"),
    );
    sql.length = 0;
    const png = Buffer.from("89504e470d0a1a0a" + "44".repeat(40), "hex");
    new ProductImageRepository(spy).putPrimary({
      id: "img-1",
      productId: product.id,
      bytes: png,
      mime: "image/png",
      sha256Hex: createHash("sha256").update(png).digest("hex"),
      widthPx: 10,
      heightPx: 10,
      origin: "desktop",
      now: "2026-10-13T09:00:00.000Z",
    });
    // The INSERT names it; the DELETE and the metadata read-back that follow do not.
    expect(mentionsBytes(sql)).toHaveLength(1);
  });
});
