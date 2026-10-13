/**
 * Slice D — Product Master's AUTHORIZATION, IPC and preload surface, through the real handlers.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE TESTS CALL `syncHandlers(createIpcHandlers(...))` AND NOT THE SERVICE.
 *
 * The service's own behaviour is covered in tests/persistence/productMaster.test.ts. What is new in
 * slice D is the BOUNDARY: who may call each channel, and whether a payload survives the trip with
 * its meaning intact. Both are properties of the handler, not of the service — and the renderer is
 * the untrusted side of that bridge, so a cashier reaching an owner channel is tested by actually
 * calling it the way `page.evaluate` on `window.pos` would.
 *
 * 🔴 AND THE HARNESS IS THE REAL WIRING. `makeHarness` now builds a real `CategoryRepository` and a
 * real `ProductImageRepository` on the same connection main.ts uses, so a passing test here means a
 * real row in a real table — never that a method was called on a fake that agreed with it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNELS, PRODUCT_MASTER_PATCH_KEYS } from "../../src/shared/ipcContract";
import { CHANNEL_POLICY } from "../../src/main/channelPolicy";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { makeHarness, tempDir } from "../helpers/harness";

type Res = { ok: boolean; error?: { code: string; message: string }; data?: unknown };
const code = (r: unknown) => (r as Res).error?.code;
const data = <T>(r: unknown): T => {
  const res = r as Res;
  if (!res.ok) throw new Error(`expected ok, got ${res.error?.code}: ${res.error?.message}`);
  return res.data as T;
};

const DRAFT = { nameAr: "مفتاح أحمر", nameEn: "Red Wrench", sku: "SKU-001", price: "4.00", baseUnit: "piece" };

/** A 1×1-ish PNG header plus filler. Not a decodable image, and nothing here claims it is. */
const PNG = Buffer.from("89504e470d0a1a0a" + "11".repeat(40), "hex");

interface Ctx {
  readonly h: ReturnType<typeof makeHarness>;
  readonly ipc: ReturnType<typeof syncHandlers>;
}

/**
 * A terminal with the real handlers, signed in as the given operator.
 *
 * `pickPhoto` stands in for slice F's `nativeImage` pipeline. It proves the CHANNEL is wired —
 * never that a file was decoded; nothing in this environment can decode one, and the production
 * code says so in src/domain/productImage.ts.
 */
function withApp(
  as: "owner" | "cashier" | "none",
  fn: (ctx: Ctx) => void,
  opts: { pickPhoto?: (productId: string) => { bytes: Buffer; mime: "image/png"; widthPx: number; heightPx: number; origin: "desktop" } | null } = {},
): void {
  const t = tempDir();
  const h = makeHarness(t.dbPath, { login: false });
  try {
    const ipc = syncHandlers(
      createIpcHandlers(h.service, opts.pickPhoto ? { pickProductPhoto: opts.pickPhoto } : {}),
    );
    if (as === "owner") expect((ipc.login({ cashierId: "cashier-01", pin: "1111" }) as Res).ok).toBe(true);
    if (as === "cashier") expect((ipc.login({ cashierId: "cashier-02", pin: "2222" }) as Res).ok).toBe(true);
    fn({ h, ipc });
  } finally {
    h.db.close();
    t.cleanup();
  }
}

const newCategory = (ipc: Ctx["ipc"], nameAr: string, nameEn: string | null = null) =>
  data<{ id: string; nameAr: string; isActive: boolean }>(ipc.createCategory({ nameAr, nameEn }));

const newProduct = (ipc: Ctx["ipc"], over: Record<string, unknown> = {}) =>
  data<{ id: string; categoryId: string | null; barcode: string | null; brand: string | null }>(
    ipc.createProduct({ draft: { ...DRAFT, ...over } }),
  );

// ════════════════════════════════════════════════════════════════════════════════════════════════
// listBrands
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("listBrands — free text with suggestions, and nothing more", () => {
  it("an empty catalog answers with an empty list, not a refusal", () => {
    withApp("owner", ({ ipc }) => {
      expect(data<string[]>(ipc.listBrands(undefined))).toEqual([]);
    });
  });

  it("🔴 returns DISTINCT values, sorted, and ignores NULL brands", () => {
    withApp("owner", ({ ipc }) => {
      newProduct(ipc, { sku: "A", master: { brand: "Bosch" } });
      newProduct(ipc, { sku: "B", master: { brand: "Makita" } });
      newProduct(ipc, { sku: "C", master: { brand: "Bosch" } }); // the same brand again
      newProduct(ipc, { sku: "D" }); // no master at all -> brand stays NULL
      newProduct(ipc, { sku: "E", master: { brand: null } }); // explicitly no brand
      expect(data<string[]>(ipc.listBrands(undefined))).toEqual(["Bosch", "Makita"]);
    });
  });

  it("🔴 ignores a BLANK brand — and the row is written past validation to prove it", () => {
    withApp("owner", ({ h, ipc }) => {
      const p = newProduct(ipc, { sku: "A", master: { brand: "Bosch" } });
      const q = newProduct(ipc, { sku: "B" });
      // 🔴 RAW SQL ON PURPOSE. `validateProductMaster` turns "   " into null, so this row cannot be
      // created through the product channels at all — which is exactly why the query needs its own
      // `trim(brand) <> ''` guard rather than trusting the writer. This is the hand-edited database
      // the guard exists for, and without the guard this test returns ["   ", "Bosch"].
      h.db.prepare("UPDATE catalog_products SET brand = '   ' WHERE id = ?").run(q.id);
      expect(h.db.prepare("SELECT brand FROM catalog_products WHERE id = ?").get(q.id)).toEqual({ brand: "   " });
      expect(data<string[]>(ipc.listBrands(undefined))).toEqual(["Bosch"]);
      expect(p.id).not.toBe(q.id);
    });
  });

  it("🔴 leaks nothing but the strings — no ids, no counts, no row objects", () => {
    withApp("owner", ({ ipc }) => {
      newProduct(ipc, { master: { brand: "Bosch" } });
      const brands = data<unknown[]>(ipc.listBrands(undefined));
      expect(brands).toEqual(["Bosch"]);
      // Every element is a primitive string. An object here would mean a row shape escaped, and a
      // number would mean a count the contract does not promise.
      expect(brands.every((b) => typeof b === "string")).toBe(true);
    });
  });

  it("a CASHIER may read it — this is product-form support, not administration", () => {
    withApp("cashier", ({ ipc }) => {
      expect((ipc.listBrands(undefined) as Res).ok).toBe(true);
      expect((ipc.listCategories(undefined) as Res).ok).toBe(true);
    });
  });

  it("🔴 with NO session, neither read is answered", () => {
    withApp("none", ({ ipc }) => {
      expect(code(ipc.listBrands(undefined))).toBe("NOT_LOGGED_IN");
      expect(code(ipc.listCategories(undefined))).toBe("NOT_LOGGED_IN");
    });
  });

  it("🔴 reading brands MUTATES NOTHING", () => {
    withApp("owner", ({ h, ipc }) => {
      newProduct(ipc, { master: { brand: "Bosch" } });
      const snapshot = () => ({
        products: h.db.prepare("SELECT count(*) AS n FROM catalog_products").get(),
        categories: h.db.prepare("SELECT count(*) AS n FROM catalog_categories").get(),
        audit: h.db.prepare("SELECT count(*) AS n FROM audit_events").get(),
      });
      const before = snapshot();
      ipc.listBrands(undefined);
      ipc.listBrands(undefined);
      ipc.listCategories(undefined);
      expect(snapshot()).toEqual(before);
    });
  });

  it("takes no payload", () => {
    withApp("owner", ({ ipc }) => {
      expect(code(ipc.listBrands({ limit: 5 }))).toBe("INVALID_INPUT");
      expect(code(ipc.listCategories({ activeOnly: true }))).toBe("INVALID_INPUT");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Categories
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("categories — the owner's list, through the real channels", () => {
  it("creates, renames, deactivates, reactivates and deletes an unused one", () => {
    withApp("owner", ({ ipc }) => {
      const made = newCategory(ipc, "عدد", "Tools");
      expect(made.isActive).toBe(true);

      const renamed = data<{ id: string; nameAr: string; nameEn: string | null }>(
        ipc.renameCategory({ categoryId: made.id, nameAr: "عدد يدوية", nameEn: "Hand tools" }),
      );
      expect(renamed.id).toBe(made.id); // the id is the identity; a rename is not a new category
      expect(renamed.nameAr).toBe("عدد يدوية");

      expect(data<{ isActive: boolean }>(ipc.setCategoryActive({ categoryId: made.id, isActive: false })).isActive).toBe(false);
      expect(data<{ isActive: boolean }>(ipc.setCategoryActive({ categoryId: made.id, isActive: true })).isActive).toBe(true);

      expect(data<{ deletedId: string }>(ipc.deleteCategory({ categoryId: made.id }))).toEqual({ deletedId: made.id });
      expect(data<unknown[]>(ipc.listCategories(undefined))).toEqual([]);
    });
  });

  it("🔴 listCategories returns INACTIVE rows too — the form must still display a retired label", () => {
    withApp("owner", ({ ipc }) => {
      const live = newCategory(ipc, "دهان");
      const dead = newCategory(ipc, "سباكة");
      ipc.setCategoryActive({ categoryId: dead.id, isActive: false });
      const rows = data<Array<{ id: string; isActive: boolean }>>(ipc.listCategories(undefined));
      expect(rows.map((r) => r.id).sort()).toEqual([dead.id, live.id].sort());
      expect(rows.find((r) => r.id === dead.id)!.isActive).toBe(false);
    });
  });

  it("🔴 refuses a duplicate name the way the UNIQUE INDEX compares them — trimmed, case-folded", () => {
    withApp("owner", ({ ipc }) => {
      newCategory(ipc, "Tools");
      expect(code(ipc.createCategory({ nameAr: "  tools  ", nameEn: null }))).toBe("DUPLICATE_CATEGORY");
      // Renaming a category to the name it already holds is not a clash with itself.
      const other = newCategory(ipc, "Paint");
      expect(data<{ nameAr: string }>(ipc.renameCategory({ categoryId: other.id, nameAr: "Paint", nameEn: null })).nameAr).toBe("Paint");
      expect(code(ipc.renameCategory({ categoryId: other.id, nameAr: "TOOLS", nameEn: null }))).toBe("DUPLICATE_CATEGORY");
    });
  });

  it("🔴 a REFERENCED category cannot be deleted — including by an INACTIVE product", () => {
    withApp("owner", ({ h, ipc }) => {
      const cat = newCategory(ipc, "عدد");
      const product = newProduct(ipc, { master: { categoryId: cat.id } });
      expect(code(ipc.deleteCategory({ categoryId: cat.id }))).toBe("CATEGORY_IN_USE");

      // 🔴 THE CASE NOBODY IS LOOKING AT. Deactivate the product; it still carries the category, so
      // the delete must still be refused. A count of ACTIVE products only would pass here and then
      // silently blank the category on a product the owner can still reactivate.
      ipc.setProductActive({ id: product.id, isActive: false });
      expect(code(ipc.deleteCategory({ categoryId: cat.id }))).toBe("CATEGORY_IN_USE");
      expect(h.db.prepare("SELECT count(*) AS n FROM catalog_categories").get()).toEqual({ n: 1n });

      // And the product's link is intact after both refusals.
      expect(h.db.prepare("SELECT category_id FROM catalog_products WHERE id = ?").get(product.id)).toEqual({
        category_id: cat.id,
      });
    });
  });

  it("🔴 CONTROL — the refusal above is not vacuous: freeing the category makes the delete succeed", () => {
    withApp("owner", ({ ipc }) => {
      const cat = newCategory(ipc, "عدد");
      const product = newProduct(ipc, { master: { categoryId: cat.id } });
      expect(code(ipc.deleteCategory({ categoryId: cat.id }))).toBe("CATEGORY_IN_USE");
      // An explicit null CLEARS the link — the one thing absence must never do.
      ipc.updateProduct({ id: product.id, draft: { ...DRAFT, master: { categoryId: null } }, isActive: true });
      expect(data<{ deletedId: string }>(ipc.deleteCategory({ categoryId: cat.id })).deletedId).toBe(cat.id);
    });
  });

  it("🔴 DEACTIVATING changes no product, and the retired category cannot be NEWLY assigned", () => {
    withApp("owner", ({ h, ipc }) => {
      const cat = newCategory(ipc, "عدد");
      const assigned = newProduct(ipc, { sku: "A", master: { categoryId: cat.id } });
      const fresh = newProduct(ipc, { sku: "B" });

      ipc.setCategoryActive({ categoryId: cat.id, isActive: false });

      // The existing link survives, in the database.
      expect(h.db.prepare("SELECT category_id FROM catalog_products WHERE id = ?").get(assigned.id)).toEqual({
        category_id: cat.id,
      });
      // ...and a new assignment is refused.
      expect(
        code(ipc.updateProduct({ id: fresh.id, draft: { ...DRAFT, sku: "B", master: { categoryId: cat.id } }, isActive: true })),
      ).toBe("CATEGORY_INACTIVE");
      expect(code(ipc.createProduct({ draft: { ...DRAFT, sku: "C", master: { categoryId: cat.id } } }))).toBe(
        "CATEGORY_INACTIVE",
      );
    });
  });

  it("🔴 re-saving a product that ALREADY carries a retired category keeps working", () => {
    withApp("owner", ({ ipc }) => {
      const cat = newCategory(ipc, "عدد");
      const product = newProduct(ipc, { master: { categoryId: cat.id } });
      ipc.setCategoryActive({ categoryId: cat.id, isActive: false });

      // 🔴 THE FORM SENDS BACK WHAT IT IS SHOWING. Refusing here would make the product UNEDITABLE:
      // the owner could not correct its price without first reactivating a category they
      // deliberately retired. "Cannot be NEWLY assigned" means newly — this is the same value.
      const saved = data<{ categoryId: string | null; priceDecimal: string }>(
        ipc.updateProduct({
          id: product.id,
          draft: { ...DRAFT, price: "9.00", master: { categoryId: cat.id } },
          isActive: true,
        }),
      );
      expect(saved.categoryId).toBe(cat.id);
      expect(saved.priceDecimal).toBe("9.00");
    });
  });

  it("🔴 a DELETED category is still refused, retired or not — existence is required always", () => {
    withApp("owner", ({ ipc }) => {
      const cat = newCategory(ipc, "عدد");
      ipc.deleteCategory({ categoryId: cat.id });
      expect(code(ipc.createProduct({ draft: { ...DRAFT, master: { categoryId: cat.id } } }))).toBe("CATEGORY_NOT_FOUND");
      expect(code(ipc.renameCategory({ categoryId: cat.id, nameAr: "x", nameEn: null }))).toBe("CATEGORY_NOT_FOUND");
      expect(code(ipc.setCategoryActive({ categoryId: cat.id, isActive: false }))).toBe("CATEGORY_NOT_FOUND");
      expect(code(ipc.deleteCategory({ categoryId: cat.id }))).toBe("CATEGORY_NOT_FOUND");
    });
  });

  it("refuses a blank name, an over-long one and an unexpected field", () => {
    withApp("owner", ({ ipc }) => {
      expect(code(ipc.createCategory({ nameAr: "   ", nameEn: null }))).toBe("INVALID_INPUT");
      expect(code(ipc.createCategory({ nameAr: "x".repeat(81), nameEn: null }))).toBe("INVALID_INPUT");
      expect(code(ipc.createCategory({ nameAr: "عدد", nameEn: null, sortOrder: 3 }))).toBe("INVALID_INPUT");
      expect(code(ipc.createCategory({ nameAr: "عدد" }))).toBe("INVALID_INPUT"); // nameEn is required-but-nullable
    });
  });

  it("🔴 a CASHIER is refused every category MUTATION, through the real bridge, and writes nothing", () => {
    withApp("owner", ({ h, ipc }) => {
      const cat = newCategory(ipc, "عدد");
      ipc.logout(undefined);
      expect((ipc.login({ cashierId: "cashier-02", pin: "2222" }) as Res).ok).toBe(true);

      const before = h.db.prepare("SELECT id, name_ar, is_active FROM catalog_categories").all();
      for (const [channel, payload] of [
        ["createCategory", { nameAr: "دهان", nameEn: null }],
        ["renameCategory", { categoryId: cat.id, nameAr: "x", nameEn: null }],
        ["setCategoryActive", { categoryId: cat.id, isActive: false }],
        ["deleteCategory", { categoryId: cat.id }],
      ] as const) {
        const r = ipc[channel](payload) as Res;
        expect(r.ok, `${channel} answered a cashier`).toBe(false);
        expect(r.error?.code, channel).toBe("NOT_AUTHORIZED");
      }
      // 🔴 Not "no error was shown" — the table is byte-identical.
      expect(h.db.prepare("SELECT id, name_ar, is_active FROM catalog_categories").all()).toEqual(before);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Product Master enrichment across the bridge
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("product enrichment — absent is not null, all the way across IPC", () => {
  it("an owner sets every enrichment field and reads it back on the list", () => {
    withApp("owner", ({ ipc }) => {
      const cat = newCategory(ipc, "عدد");
      const created = data<Record<string, unknown>>(
        ipc.createProduct({
          draft: {
            ...DRAFT,
            master: {
              categoryId: cat.id,
              barcode: "036000291452",
              brand: "Bosch",
              descriptionAr: "مفتاح جيد",
              descriptionEn: "A good wrench",
              isOnlineVisible: true,
            },
          },
        }),
      );
      expect(created).toMatchObject({
        categoryId: cat.id,
        barcode: "0036000291452",
        brand: "Bosch",
        descriptionAr: "مفتاح جيد",
        descriptionEn: "A good wrench",
        isOnlineVisible: true,
        hasImage: false,
      });
      const listed = data<Array<Record<string, unknown>>>(ipc.listProducts(undefined));
      expect(listed[0]).toMatchObject({ barcode: "0036000291452", brand: "Bosch", isOnlineVisible: true });
    });
  });

  it("🔴 an update with NO master key carries every enrichment field forward", () => {
    withApp("owner", ({ ipc }) => {
      const cat = newCategory(ipc, "عدد");
      const created = newProduct(ipc, {
        master: { categoryId: cat.id, barcode: "036000291452", brand: "Bosch", descriptionAr: "وصف", isOnlineVisible: true },
      });
      // A caller that does not deal in enrichment: the import path and invoice reconciliation both
      // send exactly this. It must not erase what the owner typed.
      const after = data<Record<string, unknown>>(
        ipc.updateProduct({ id: created.id, draft: { ...DRAFT, price: "7.50" }, isActive: true }),
      );
      expect(after).toMatchObject({
        priceDecimal: "7.50",
        categoryId: cat.id,
        barcode: "0036000291452",
        brand: "Bosch",
        descriptionAr: "وصف",
        isOnlineVisible: true,
      });
    });
  });

  it("🔴 an EMPTY master object also carries everything forward — absence is per-key", () => {
    withApp("owner", ({ ipc }) => {
      const created = newProduct(ipc, { master: { brand: "Bosch", descriptionEn: "keep me" } });
      const after = data<Record<string, unknown>>(
        ipc.updateProduct({ id: created.id, draft: { ...DRAFT, master: {} }, isActive: true }),
      );
      expect(after).toMatchObject({ brand: "Bosch", descriptionEn: "keep me" });
    });
  });

  it("🔴 a key present holding UNDEFINED is treated as ABSENT, not as a clear", () => {
    withApp("owner", ({ ipc }) => {
      const created = newProduct(ipc, { master: { brand: "Bosch" } });
      // 🔴 THIS IS WHAT A RENDERER REALLY SENDS. A form built from optional React state produces
      // `{ brand: undefined }`, and Electron's structured clone preserves the key. An `in` test
      // alone would read it as "clear the brand" and silently erase it.
      const after = data<Record<string, unknown>>(
        ipc.updateProduct({ id: created.id, draft: { ...DRAFT, master: { brand: undefined } }, isActive: true }),
      );
      expect(after.brand).toBe("Bosch");
    });
  });

  it("🔴 CONTROL — an explicit NULL really does clear, so the three tests above are not vacuous", () => {
    withApp("owner", ({ ipc }) => {
      const cat = newCategory(ipc, "عدد");
      const created = newProduct(ipc, { master: { categoryId: cat.id, brand: "Bosch", descriptionEn: "bye" } });
      const after = data<Record<string, unknown>>(
        ipc.updateProduct({
          id: created.id,
          draft: { ...DRAFT, master: { categoryId: null, brand: null, descriptionEn: null } },
          isActive: true,
        }),
      );
      expect(after).toMatchObject({ categoryId: null, brand: null, descriptionEn: null });
    });
  });

  it("refuses an unknown enrichment key rather than ignoring it", () => {
    withApp("owner", ({ ipc }) => {
      // A typo must not silently do nothing — that is how a field appears to save and does not.
      expect(code(ipc.createProduct({ draft: { ...DRAFT, master: { brandName: "Bosch" } } }))).toBe("INVALID_INPUT");
      expect(code(ipc.createProduct({ draft: { ...DRAFT, master: { isOnlineVisible: "yes" } } }))).toBe("INVALID_INPUT");
      expect(code(ipc.createProduct({ draft: { ...DRAFT, master: null } }))).toBe("INVALID_INPUT");
    });
  });

  it("🔴 a CASHIER cannot mutate Product Master, and the stored enrichment is untouched", () => {
    withApp("owner", ({ h, ipc }) => {
      const created = newProduct(ipc, { master: { brand: "Bosch", isOnlineVisible: true } });
      ipc.logout(undefined);
      ipc.login({ cashierId: "cashier-02", pin: "2222" });

      expect(code(ipc.updateProduct({ id: created.id, draft: { ...DRAFT, master: { brand: "Hacked" } }, isActive: true }))).toBe(
        "NOT_AUTHORIZED",
      );
      expect(code(ipc.createProduct({ draft: { ...DRAFT, sku: "X", master: { brand: "Hacked" } } }))).toBe("NOT_AUTHORIZED");
      expect(h.db.prepare("SELECT brand, is_online_visible FROM catalog_products WHERE id = ?").get(created.id)).toEqual({
        brand: "Bosch",
        is_online_visible: 1n,
      });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Barcode across the bridge
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("barcode — one canonical form, across IPC", () => {
  it("🔴 a 12-digit UPC-A arrives as its 13-digit EAN-13 form, and both strings find the product", () => {
    withApp("owner", ({ ipc }) => {
      const created = newProduct(ipc, { master: { barcode: "  036000291452 " } });
      expect(created.barcode).toBe("0036000291452");
      // 🔴 THE EQUIVALENCE IS WHY THIS MATTERS. The same symbol typed off a box (12 digits) and
      // returned by a decoder (13 digits) must be ONE product. Saving the 13-digit form onto the
      // same product is therefore not a duplicate...
      const same = data<{ barcode: string | null }>(
        ipc.updateProduct({ id: created.id, draft: { ...DRAFT, master: { barcode: "0036000291452" } }, isActive: true }),
      );
      expect(same.barcode).toBe("0036000291452");
      // ...and on a DIFFERENT product it is refused, by either spelling.
      expect(code(ipc.createProduct({ draft: { ...DRAFT, sku: "B", master: { barcode: "0036000291452" } } }))).toBe(
        "DUPLICATE_BARCODE",
      );
      expect(code(ipc.createProduct({ draft: { ...DRAFT, sku: "C", master: { barcode: "036000291452" } } }))).toBe(
        "DUPLICATE_BARCODE",
      );
    });
  });

  it("null and blank both mean NO barcode, and many products may have none", () => {
    withApp("owner", ({ ipc }) => {
      expect(newProduct(ipc, { sku: "A", master: { barcode: null } }).barcode).toBeNull();
      expect(newProduct(ipc, { sku: "B", master: { barcode: "   " } }).barcode).toBeNull();
      expect(newProduct(ipc, { sku: "C" }).barcode).toBeNull();
    });
  });

  it("🔴 a non-retail CODE 128 payload keeps its case — two spellings are two codes", () => {
    withApp("owner", ({ ipc }) => {
      expect(newProduct(ipc, { sku: "A", master: { barcode: "ABC-xyz_123" } }).barcode).toBe("ABC-xyz_123");
      // Case-folding would make these one barcode and refuse the second. They are different symbols.
      expect(newProduct(ipc, { sku: "B", master: { barcode: "abc-XYZ_123" } }).barcode).toBe("abc-XYZ_123");
    });
  });

  it("🔴 clearing a barcode frees it for another product", () => {
    withApp("owner", ({ ipc }) => {
      const first = newProduct(ipc, { sku: "A", master: { barcode: "036000291452" } });
      expect(code(ipc.createProduct({ draft: { ...DRAFT, sku: "B", master: { barcode: "036000291452" } } }))).toBe(
        "DUPLICATE_BARCODE",
      );
      ipc.updateProduct({ id: first.id, draft: { ...DRAFT, sku: "A", master: { barcode: null } }, isActive: true });
      expect(newProduct(ipc, { sku: "B", master: { barcode: "036000291452" } }).barcode).toBe("0036000291452");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The image boundary
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("product photos — the boundary, with no producer yet", () => {
  /** Stores a photo the way slice F's picker and slice H's LAN listener will: from MAIN. */
  const store = (h: Ctx["h"], productId: string, bytes = PNG) =>
    h.service.setProductPrimaryImage({
      productId,
      bytes,
      mime: "image/png",
      widthPx: 10,
      heightPx: 10,
      origin: "desktop",
    });

  it("🔴 listProducts carries a hasImage FLAG and not one byte of any photo", () => {
    withApp("owner", ({ h, ipc }) => {
      const withPhoto = newProduct(ipc, { sku: "A" });
      const without = newProduct(ipc, { sku: "B" });
      const stored = store(h, withPhoto.id);

      const rows = data<Array<Record<string, unknown>>>(ipc.listProducts(undefined));
      const shot = rows.find((r) => r.id === withPhoto.id)!;
      const bare = rows.find((r) => r.id === without.id)!;

      // 🔴 ENOUGH TO DRAW A THUMBNAIL AND ASK FOR THE RIGHT PHOTO — and no more than that.
      expect(shot).toMatchObject({
        hasImage: true,
        imageMime: "image/png",
        imageVersion: createHash("sha256").update(PNG).digest("hex"),
      });
      expect(shot.primaryImageId).toBe(stored.id);
      // 🔴 `imageVersion` IS THE CONTENT HASH, which is what makes a renderer cache exact rather
      // than a guess: replacing the photo changes this string, and nothing else has to.
      expect(shot.imageVersion).toBe(stored.sha256_hex);
      expect(bare).toMatchObject({ hasImage: false, primaryImageId: null, imageMime: null, imageVersion: null });

      // 🔴 NO VALUE IN ANY ROW IS BINARY. Stricter than checking for a column called `bytes`,
      // because a future mapper could leak a blob under any name at all.
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          expect(Buffer.isBuffer(value), `${key} is a Buffer`).toBe(false);
          expect(value instanceof Uint8Array, `${key} is a Uint8Array`).toBe(false);
        }
      }
      // And the payload is small — a serialized photo would blow this out by orders of magnitude.
      expect(JSON.stringify(rows).length).toBeLessThan(2000);
    });
  });

  it("🔴 the metadata channel returns the checksum and the size, never the bytes", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      const meta = store(h, product.id);
      const dto = data<Record<string, unknown>>(ipc.getProductImageMeta({ productId: product.id }));
      expect(dto).toMatchObject({
        productId: product.id,
        mime: "image/png",
        sha256Hex: createHash("sha256").update(PNG).digest("hex"),
        byteSize: PNG.length,
        widthPx: 10,
        heightPx: 10,
        origin: "desktop",
      });
      expect(dto.id).toBe(meta.id);
      expect("bytes" in dto).toBe(false);
      for (const value of Object.values(dto)) expect(value instanceof Uint8Array).toBe(false);
    });
  });

  it("a product with no photo answers null, and an unknown product is refused", () => {
    withApp("owner", ({ ipc }) => {
      const product = newProduct(ipc);
      expect(data<unknown>(ipc.getProductImageMeta({ productId: product.id }))).toBeNull();
      expect(code(ipc.getProductImageMeta({ productId: "manual:999999" }))).toBe("PRODUCT_NOT_FOUND");
    });
  });

  it("🔴 the bytes come back ONLY when asked for by image id, and they verify", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      const meta = store(h, product.id);
      const got = data<{ meta: { sha256Hex: string }; bytes: Uint8Array }>(ipc.getProductImageBytes({ imageId: meta.id }));
      expect(Buffer.from(got.bytes).equals(PNG)).toBe(true);
      expect(createHash("sha256").update(got.bytes).digest("hex")).toBe(got.meta.sha256Hex);
      expect(code(ipc.getProductImageBytes({ imageId: "no-such-image" }))).toBe("IMAGE_NOT_FOUND");
    });
  });

  it("🔴 CONTROL — bit-rot is REFUSED, not served: the checksum check really runs", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      const meta = store(h, product.id);
      // Corrupt the stored blob behind the application's back, the way a bad copy of a SQLite file
      // would. Without the re-hash in `productImageBytes` this returns a broken picture silently —
      // and the online catalog export would publish it.
      h.db.prepare("UPDATE catalog_product_images SET bytes = ? WHERE id = ?").run(Buffer.from("not an image"), meta.id);
      expect(code(ipc.getProductImageBytes({ imageId: meta.id }))).toBe("LEDGER_INTEGRITY");
    });
  });

  it("🔴 ONE primary photo: storing a second REPLACES the first, leaving no orphan", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      const first = store(h, product.id);
      const other = Buffer.from("89504e470d0a1a0a" + "22".repeat(40), "hex");
      const second = store(h, product.id, other);
      expect(second.id).not.toBe(first.id);
      expect(h.db.prepare("SELECT count(*) AS n FROM catalog_product_images WHERE product_id = ?").get(product.id)).toEqual({
        n: 1n,
      });
      // The replaced image is GONE, not orphaned — an export must never write a stale photo.
      expect(code(ipc.getProductImageBytes({ imageId: first.id }))).toBe("IMAGE_NOT_FOUND");
    });
  });

  it("🔴 hasImage and primaryImageId can never disagree — both derive from ONE metadata row", () => {
    withApp("owner", ({ h, ipc }) => {
      const a = newProduct(ipc, { sku: "A" });
      newProduct(ipc, { sku: "B" });
      store(h, a.id);
      // A list told "there is a photo" with no id to ask for would show a row that never settles.
      for (const row of data<Array<Record<string, unknown>>>(ipc.listProducts(undefined))) {
        expect(row.hasImage, `${row.id as string}`).toBe(row.primaryImageId !== null);
        expect(row.hasImage).toBe(row.imageVersion !== null);
        expect(row.hasImage).toBe(row.imageMime !== null);
      }
    });
  });

  it("🔴 REPLACING a photo changes imageVersion on the list — that is the cache invalidation", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      store(h, product.id);
      const first = data<Array<Record<string, unknown>>>(ipc.listProducts(undefined))[0]!;

      store(h, product.id, Buffer.from("89504e470d0a1a0a" + "33".repeat(40), "hex"));
      const second = data<Array<Record<string, unknown>>>(ipc.listProducts(undefined))[0]!;

      expect(second.imageVersion).not.toBe(first.imageVersion);
      expect(second.primaryImageId).not.toBe(first.primaryImageId);
      expect(second.hasImage).toBe(true);
    });
  });

  it("🔴 REMOVING a photo clears all four fields on the list — no stale thumbnail state", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      store(h, product.id);
      expect(data<Array<Record<string, unknown>>>(ipc.listProducts(undefined))[0]!.hasImage).toBe(true);
      ipc.removeProductImage({ productId: product.id });
      expect(data<Array<Record<string, unknown>>>(ipc.listProducts(undefined))[0]).toMatchObject({
        hasImage: false,
        primaryImageId: null,
        imageMime: null,
        imageVersion: null,
      });
    });
  });

  it("remove is idempotent and reports whether there was anything to remove", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      store(h, product.id);
      expect(data<{ removed: boolean }>(ipc.removeProductImage({ productId: product.id }))).toEqual({ removed: true });
      expect(data<{ removed: boolean }>(ipc.removeProductImage({ productId: product.id }))).toEqual({ removed: false });
      expect(data<unknown>(ipc.getProductImageMeta({ productId: product.id }))).toBeNull();
      expect(data<Array<Record<string, unknown>>>(ipc.listProducts(undefined))[0]!.hasImage).toBe(false);
    });
  });

  it("🔴 setProductImage takes a product id and NOTHING else — no path, no bytes", () => {
    withApp(
      "owner",
      ({ ipc }) => {
        const product = newProduct(ipc);
        const meta = data<{ productId: string; byteSize: number }>(ipc.setProductImage({ productId: product.id }));
        expect(meta).toMatchObject({ productId: product.id, byteSize: PNG.length });
        // A payload carrying bytes or a path is refused outright by shape.
        expect(code(ipc.setProductImage({ productId: product.id, bytes: PNG }))).toBe("INVALID_INPUT");
        expect(code(ipc.setProductImage({ productId: product.id, path: "/etc/passwd" }))).toBe("INVALID_INPUT");
      },
      { pickPhoto: () => ({ bytes: PNG, mime: "image/png", widthPx: 10, heightPx: 10, origin: "desktop" }) },
    );
  });

  it("a cancelled picker writes nothing and is not an error", () => {
    withApp(
      "owner",
      ({ h, ipc }) => {
        const product = newProduct(ipc);
        expect(data<unknown>(ipc.setProductImage({ productId: product.id }))).toBeNull();
        expect(h.db.prepare("SELECT count(*) AS n FROM catalog_product_images").get()).toEqual({ n: 0n });
      },
      { pickPhoto: () => null },
    );
  });

  it("🔴 with NO producer wired, setProductImage fails CLOSED — it does not half-work", () => {
    withApp("owner", ({ ipc }) => {
      const product = newProduct(ipc);
      // Slice D wires the authorization, the channel and the service. The `nativeImage` pipeline
      // that can actually prove a file is an image is slice F; until then this refuses.
      expect(code(ipc.setProductImage({ productId: product.id }))).toBe("NOT_AVAILABLE");
    });
  });

  it("🔴 a CASHIER may READ a photo and may not CHANGE one — and the old value was 'neither'", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      const meta = store(h, product.id);
      ipc.logout(undefined);
      ipc.login({ cashierId: "cashier-02", pin: "2222" });

      // 🔴 TRANSITION. Both reads were `owner`, justified as "the only V1 surface that reads a
      // photo is the owner's Add/Edit form". Requiring thumbnails on the products LIST — which a
      // cashier reads — made that false, so they are session now. The reason is written in
      // channelPolicy.ts beside the entries, not inferred from here.
      expect((ipc.getProductImageMeta({ productId: product.id }) as Res).ok).toBe(true);
      const got = data<{ bytes: Uint8Array }>(ipc.getProductImageBytes({ imageId: meta.id }));
      expect(Buffer.from(got.bytes).equals(PNG)).toBe(true);

      // The MUTATIONS are still refused — changing a photo is a master-data act.
      for (const [channel, payload] of [
        ["setProductImage", { productId: product.id }],
        ["removeProductImage", { productId: product.id }],
      ] as const) {
        expect(code(ipc[channel](payload)), channel).toBe("NOT_AUTHORIZED");
      }
      // The photo is untouched after both attempts.
      expect(h.db.prepare("SELECT count(*) AS n FROM catalog_product_images").get()).toEqual({ n: 1n });
    });
  });

  it("🔴 the service refuses an oversized or empty photo before it reaches SQLite", () => {
    withApp("owner", ({ h, ipc }) => {
      const product = newProduct(ipc);
      const call = (over: Record<string, unknown>) => {
        try {
          h.service.setProductPrimaryImage({
            productId: product.id,
            bytes: PNG,
            mime: "image/png",
            widthPx: 10,
            heightPx: 10,
            origin: "desktop",
            ...over,
          } as never);
          return null;
        } catch (err) {
          return (err as { code?: string }).code ?? "THROWN";
        }
      };
      expect(call({ bytes: Buffer.alloc(0) })).toBe("INVALID_INPUT");
      expect(call({ bytes: Buffer.alloc(2 * 1024 * 1024 + 1) })).toBe("INVALID_INPUT");
      expect(call({ mime: "image/webp" })).toBe("INVALID_INPUT");
      expect(call({ origin: "cloud" })).toBe("INVALID_INPUT");
      expect(call({ widthPx: 0 })).toBe("INVALID_INPUT");
      expect(call({ heightPx: 10.5 })).toBe("INVALID_INPUT");
      expect(call({ productId: "manual:999999" })).toBe("PRODUCT_NOT_FOUND");
      // CONTROL: the unmodified call succeeds, so the seven refusals above are about the change.
      expect(call({})).toBeNull();
      expect(h.db.prepare("SELECT count(*) AS n FROM catalog_product_images").get()).toEqual({ n: 1n });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The policy and the bridge
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("the new channels are classified, and the bridge forwards them", () => {
  const PRODUCT_MASTER_CHANNELS = [
    "listCategories",
    "listBrands",
    "createCategory",
    "renameCategory",
    "setCategoryActive",
    "deleteCategory",
    "getProductImageMeta",
    "getProductImageBytes",
    "setProductImage",
    "removeProductImage",
  ] as const;

  it("🔴 all ten exist, and NONE of them is public", () => {
    for (const name of PRODUCT_MASTER_CHANNELS) {
      expect(CHANNELS[name]).toBe(`pos:${name}`);
      expect(CHANNEL_POLICY[name], `${name} must not be public`).not.toBe("public");
    }
  });

  it("🔴 the four READS are session; every MUTATION is owner", () => {
    const byAccess = (level: string) => PRODUCT_MASTER_CHANNELS.filter((n) => CHANNEL_POLICY[n] === level).sort();
    // 🔴 TRANSITION — the two photo READS moved from owner to session when the products list had
    // to show thumbnails. Was: session = [listBrands, listCategories] and the other eight owner.
    expect(byAccess("session")).toEqual([
      "getProductImageBytes",
      "getProductImageMeta",
      "listBrands",
      "listCategories",
    ]);
    expect(byAccess("owner")).toEqual([
      "createCategory",
      "deleteCategory",
      "removeProductImage",
      "renameCategory",
      "setCategoryActive",
      "setProductImage",
    ]);
    expect(byAccess("public")).toEqual([]);
  });

  it("🔴 the preload bridge's patch-key literals match the contract exactly", () => {
    // The preload may import a TYPE from the contract but never a VALUE — a sandboxed preload
    // cannot require a project file, and doing so once made the PACKAGED app render nothing at all.
    // So the keys are duplicated there, and this is what makes the duplication safe.
    const preload = readFileSync(join(__dirname, "..", "..", "src", "preload", "preload.ts"), "utf8");
    const block = /const MASTER_PATCH_KEYS = \[([\s\S]*?)\] as const/.exec(preload);
    expect(block).not.toBeNull();
    const keys = [...block![1]!.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!);
    expect(keys).toEqual([...PRODUCT_MASTER_PATCH_KEYS]);
  });

  it("🔴 no channel name suggests a path, a blob or a generic write", () => {
    const names = Object.keys(CHANNELS);
    // 🔴 THE FIRST VERSION OF THIS LINE WAS WRONG, and recording it is cheaper than rediscovering
    // it: a case-insensitive /file/ matches `getCompanyProfile` — "proFILE" — so the assertion
    // failed on a channel that has nothing to do with the filesystem. A pattern loose enough to
    // match a substring of an unrelated word is not evidence about naming; these are anchored to
    // the camelCase tokens a real offender would actually use.
    const forbidden = /(^|[a-z])(Path|File|Blob|Upload|Sql|Query|Exec|Write)([A-Z]|$)|^(path|file|blob|upload|sql|query|exec|write)/;
    expect(names.filter((n) => forbidden.test(n))).toEqual([]);
    // `getProductImageBytes` is the one channel with "Bytes" in its name, and it READS one named
    // image. Nothing writes bytes from the renderer at all.
    expect(names.filter((n) => /bytes/i.test(n))).toEqual(["getProductImageBytes"]);
  });
});
