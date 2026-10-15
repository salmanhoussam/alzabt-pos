/**
 * Slice G1 — the Online Catalog contract: who gets exported, what the website is told, and what it
 * is never told.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE CENTRAL CLAIM IS THAT ORIGIN DOES NOT MATTER, and it is tested through the three REAL
 * call paths rather than by writing three rows with different `source` values.
 *
 * Two of those paths land on the same `source`, by design: `createProduct` mints
 * `manual:NNNNNN` whether the caller is the Products screen or invoice reconciliation — the two
 * differ in audit PROVENANCE, not in the row. That is worth stating rather than discovering,
 * because a reader could otherwise think cases A and C are the same test twice. They are not: they
 * are the same guarantee reached through two different callers, and the point is that neither
 * caller can produce a product the export treats differently.
 *
 * 🔴 AND THE PRIVACY TEST IS A REAL SEARCH, NOT A TYPE ASSERTION. Unique canary strings are
 * written into operators, sales, invoices, audit rows and settings, and then the entire serialized
 * output is searched for every one of them. A TypeScript interface proves what the compiler was
 * told; it proves nothing about what a future join, a spread, or a `JSON.stringify` of the wrong
 * object would put in the file a merchant uploads to the public internet.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { formatDecimal, money } from "../../src/domain/money";
import {
  ONLINE_CATALOG_SCHEMA_VERSION,
  isEligibleForOnlineCatalog,
  onlineCatalogImageFile,
  serializeOnlineCatalog,
} from "../../src/domain/onlineCatalog";
import { normalizeProductPhoto } from "../../src/main/photoNormalize";
import { fakeCodec } from "../helpers/fakeCodec";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";

const FIXTURES = join(__dirname, "..", "fixtures", "photos");

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type H = ReturnType<typeof makeHarness>;

const DRAFT = (over: Record<string, unknown> = {}) => ({
  nameAr: "صنف",
  nameEn: "Item",
  price: "4.00",
  baseUnit: "piece" as const,
  ...over,
});

/** Marks a product online-visible through the real update path. */
function publish(h: H, id: string, extra: Record<string, unknown> = {}): void {
  const row = h.service.listProducts().find((p) => p.id === id)!;
  // 🔴 THE PRICE IS CARRIED FORWARD, NOT RE-STATED. An earlier version of this helper passed a
  // literal "4.00", which silently overwrote the price of every product it published — including
  // the one in the price test, which then measured the helper rather than the exporter.
  h.service.updateProduct(
    id,
    {
      nameAr: row.name_ar,
      nameEn: row.name_en ?? undefined,
      sku: row.sku ?? undefined,
      price: formatDecimal(money(BigInt(row.selling_price_minor), row.currency)),
      baseUnit: row.base_unit,
      master: { isOnlineVisible: true, ...extra },
    } as never,
    true,
  );
}

/** A real CSV import, so case B goes through the importer rather than a hand-written row. */
function importOne(h: H, sourceId: string, nameAr: string): void {
  const csv = `source_id,name_ar,name_en,price,currency,base_unit,price_needs_review\n${sourceId},${nameAr},Imported,7.50,USD,piece,0\n`;
  const result = h.service.importCatalogCsv("catalog.csv", new TextEncoder().encode(csv));
  if (result.status !== "imported") throw new Error(`import failed: ${JSON.stringify(result)}`);
}

describe("eligibility — two conditions, and origin is not one of them", () => {
  it("🔴 includes a product from ALL THREE origins when active and online-visible", () => {
    const h = makeHarness(t.dbPath);

    // A · manual Product Master entry
    const manual = h.service.createProduct(DRAFT({ nameAr: "يدوي", sku: "M-1" }) as never);
    // B · legacy CSV import
    importOne(h, "IMP-1", "مستورد");
    const imported = h.service.listProducts().find((p) => p.source !== "manual")!;
    // C · invoice reconciliation "create as new product" — the SAME service method, with the
    //     provenance a reconciliation passes. It mints a `manual:` id too; that is the point.
    const reconciled = h.service.createProduct(DRAFT({ nameAr: "تسوية", sku: "R-1" }) as never, {
      origin: "invoice_reconciliation",
      invoiceId: "inv-1",
    });

    for (const id of [manual.id, imported.id, reconciled.id]) publish(h, id);

    const ids = h.service.onlineCatalogSnapshot().document.products.map((p) => p.id);
    expect(ids).toContain(manual.id);
    expect(ids).toContain(imported.id);
    expect(ids).toContain(reconciled.id);
    expect(ids).toHaveLength(3);
    h.db.close();
  });

  it("🔴 the legacy CSV export MISSES the manual ones — the gap G exists to close", () => {
    // The control that makes the test above mean something. If the legacy export already covered
    // manual products, none of this would be needed; it does not, and this proves it on real rows.
    const h = makeHarness(t.dbPath);
    const manual = h.service.createProduct(DRAFT({ nameAr: "يدوي", sku: "M-1" }) as never);
    importOne(h, "IMP-1", "مستورد");
    publish(h, manual.id);
    for (const p of h.service.listProducts()) if (p.source !== "manual") publish(h, p.id);

    const legacy = h.service.exportCatalogCsv().csv;
    expect(legacy).not.toContain("يدوي");
    expect(legacy).toContain("مستورد");

    const online = serializeOnlineCatalog(h.service.onlineCatalogSnapshot().document);
    expect(online).toContain("يدوي");
    expect(online).toContain("مستورد");
    h.db.close();
  });

  it("excludes an online-visible product that is INACTIVE", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, p.id);
    expect(h.service.onlineCatalogSnapshot().document.products).toHaveLength(1);
    h.service.setProductActive(p.id, false);
    expect(h.service.onlineCatalogSnapshot().document.products).toHaveLength(0);
    h.db.close();
  });

  it("excludes an ACTIVE product that is not online-visible", () => {
    const h = makeHarness(t.dbPath);
    h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    expect(h.service.onlineCatalogSnapshot().document.products).toHaveLength(0);
    h.db.close();
  });

  it("the predicate itself needs BOTH, proven on all four combinations", () => {
    for (const a of [0, 1]) {
      for (const o of [0, 1]) {
        expect(isEligibleForOnlineCatalog({ is_active: a, is_online_visible: o })).toBe(a === 1 && o === 1);
      }
    }
  });
});

describe("incomplete enrichment is exported truthfully, never dropped", () => {
  it("🔴 a product with no category, brand, English name, description or photo still exports", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct({ nameAr: "بلا تفاصيل", price: "4.00", baseUnit: "piece" } as never);
    publish(h, p.id);
    const [only] = h.service.onlineCatalogSnapshot().document.products;
    expect(only).toBeDefined();
    expect(only!.name_ar).toBe("بلا تفاصيل");
    expect(only!.name_en).toBeNull();
    expect(only!.category).toBeNull();
    expect(only!.brand).toBeNull();
    expect(only!.description_ar).toBeNull();
    expect(only!.description_en).toBeNull();
    expect(only!.image).toBeNull();
    expect(only!.sku).toBeNull();
    expect(only!.barcode).toBeNull();
    h.db.close();
  });
});

describe("category semantics", () => {
  it("🔴 a RETIRED category is still exported — the product genuinely carries it", () => {
    const h = makeHarness(t.dbPath);
    const cat = h.service.createCategory("عدد", "Tools");
    const p = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, p.id, { categoryId: cat.id });
    h.service.setCategoryActive(cat.id, false);

    const [only] = h.service.onlineCatalogSnapshot().document.products;
    expect(only!.category).toEqual({ id: cat.id, name_ar: "عدد", name_en: "Tools" });
    h.db.close();
  });

  it("does NOT export the category's activity state — the website cannot act on it", () => {
    const h = makeHarness(t.dbPath);
    const cat = h.service.createCategory("عدد", "Tools");
    const p = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, p.id, { categoryId: cat.id });
    const json = serializeOnlineCatalog(h.service.onlineCatalogSnapshot().document);
    expect(json).not.toContain("is_active");
    expect(json).not.toContain("sort_order");
    h.db.close();
  });
});

describe("barcode, price, currency and unit come from the authoritative row", () => {
  it("🔴 exports the CANONICAL stored barcode — a UPC-A stays its EAN-13 form", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, p.id, { barcode: "036000291452" });
    const [only] = h.service.onlineCatalogSnapshot().document.products;
    // The exporter does not re-normalize: whatever canonical form the service stored is what ships.
    const stored = h.db.prepare("SELECT barcode FROM catalog_products WHERE id = ?").get(p.id) as {
      barcode: string;
    };
    expect(only!.barcode).toBe(stored.barcode);
    expect(only!.barcode).toBe("0036000291452");
    expect(only!.barcode).not.toBe(only!.sku);
    h.db.close();
  });

  it("exports price as an EXACT decimal string and the row's own currency and unit", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ sku: "S-1", price: "12.50", baseUnit: "kg" }) as never);
    publish(h, p.id);
    const [only] = h.service.onlineCatalogSnapshot().document.products;
    expect(only!.price).toBe("12.50");
    expect(typeof only!.price).toBe("string");
    const row = h.db.prepare("SELECT currency, base_unit FROM catalog_products WHERE id = ?").get(p.id) as {
      currency: string;
      base_unit: string;
    };
    expect(only!.currency).toBe(row.currency);
    expect(only!.unit).toBe(row.base_unit);
    h.db.close();
  });
});

describe("image file names are stable, Windows-safe and collision-proof", () => {
  it("🔴 strips the COLON out of a real product id — NTFS would read it as a data stream", () => {
    const file = onlineCatalogImageFile("manual:000001", "image/jpeg");
    expect(file).not.toContain(":");
    expect(file).toMatch(/^images\/product-manual_000001-[0-9a-f]{12}\.jpg$/);
  });

  it("🔴 two ids that SANITIZE the same still get different names", () => {
    // `merchant-csv:a:b` and `merchant-csv:a_b` both sanitize to `merchant-csv_a_b`. `source_key`
    // comes from the import file, so this is user-controlled text, not a theoretical case.
    const a = onlineCatalogImageFile("merchant-csv:a:b", "image/jpeg");
    const b = onlineCatalogImageFile("merchant-csv:a_b", "image/jpeg");
    expect(a).not.toBe(b);
  });

  it("refuses path traversal, reserved device names and Arabic in the path", () => {
    for (const id of ["../../etc/passwd", "..\\..\\windows", "CON", "nul", "صنف", "   ", "."]) {
      const file = onlineCatalogImageFile(id, "image/png");
      expect(file.startsWith("images/product-"), `${id} -> ${file}`).toBe(true);
      expect(file).not.toContain("..");
      expect(file).not.toContain("/etc");
      expect(file.split("/")).toHaveLength(2);
      expect(file).toMatch(/^images\/[A-Za-z0-9._-]+\.png$/);
    }
  });

  it("is stable: the same id and mime always produce the same name", () => {
    expect(onlineCatalogImageFile("manual:7", "image/png")).toBe(onlineCatalogImageFile("manual:7", "image/png"));
  });

  it("uses the extension of the STORED mime, not a guess", () => {
    expect(onlineCatalogImageFile("manual:7", "image/jpeg").endsWith(".jpg")).toBe(true);
    expect(onlineCatalogImageFile("manual:7", "image/png").endsWith(".png")).toBe(true);
  });
});

describe("the image reference describes the stored photo", () => {
  it("carries the stored sha, mime and dimensions, and never bytes", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, p.id);
    const photo = normalizeProductPhoto(readFileSync(join(FIXTURES, "shelf.jpg")), fakeCodec());
    const stored = h.service.setProductPrimaryImage({
      productId: p.id,
      bytes: photo.bytes,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      origin: "desktop",
    });

    const snap = h.service.onlineCatalogSnapshot();
    const [only] = snap.document.products;
    expect(only!.image).toEqual({
      file: onlineCatalogImageFile(p.id, photo.mime),
      mime: photo.mime,
      sha256: stored.sha256_hex,
      width: photo.widthPx,
      height: photo.heightPx,
    });
    // The writer's plumbing knows the internal id; the document does not.
    expect(snap.images).toEqual([
      { file: only!.image!.file, imageId: stored.id, sha256: stored.sha256_hex },
    ]);
    expect(serializeOnlineCatalog(snap.document)).not.toContain(stored.id);
    h.db.close();
  });
});

describe("determinism", () => {
  it("🔴 the same state and the same instant produce byte-identical JSON", () => {
    const build = () => {
      const dir = tempDir();
      const h = makeHarness(dir.dbPath);
      for (const [sku, name] of [["B", "باء"], ["A", "ألف"], ["C", "جيم"]]) {
        const p = h.service.createProduct(DRAFT({ sku, nameAr: name }) as never);
        publish(h, p.id);
      }
      const json = serializeOnlineCatalog(h.service.onlineCatalogSnapshot().document);
      h.db.close();
      dir.cleanup();
      return json;
    };
    const first = build();
    expect(build()).toBe(first);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(build()).digest("hex"),
    );
  });

  it("🔴 orders by id even when the REPOSITORY's own order disagrees", () => {
    // 🔴 THE FIRST VERSION OF THIS TEST PROVED NOTHING, and a mutation found it: deleting the sort
    // entirely left every test green. `listAll()` already returns
    // `ORDER BY source, CAST(source_key AS INTEGER), source_key`, which for hand-made products
    // coincides with id order — so the explicit sort was never load-bearing in the fixtures.
    //
    // These two source_ids are where the two orders genuinely diverge. The repository casts to
    // INTEGER, so it yields 2 then 10; the ids sort as strings, so "merchant-csv:10" comes FIRST.
    // Now removing the sort changes the output, which is what the test is for.
    const h = makeHarness(t.dbPath);
    const csv =
      "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review\n" +
      "2,اثنان,Two,1.00,USD,piece,0\n" +
      "10,عشرة,Ten,2.00,USD,piece,0\n";
    const result = h.service.importCatalogCsv("catalog.csv", new TextEncoder().encode(csv));
    expect(result.status).toBe("imported");
    for (const p of h.service.listProducts()) publish(h, p.id);

    const ids = h.service.onlineCatalogSnapshot().document.products.map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual([...ids].sort());
    expect(ids[0], "string order puts :10 before :2 — the repository would not").toBe("merchant-csv:10");

    // The control: the repository really does disagree, so the assertion above is not a tautology.
    const repoOrder = h.db
      .prepare("SELECT id FROM catalog_products ORDER BY source, CAST(source_key AS INTEGER), source_key")
      .all() as Array<{ id: string }>;
    expect(repoOrder.map((r) => r.id)).toEqual(["merchant-csv:2", "merchant-csv:10"]);
    h.db.close();
  });

  it("🔴 keeps Arabic as Arabic — no \\u escapes in the shipped file", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ nameAr: "مفتاح أحمر", sku: "S-1" }) as never);
    publish(h, p.id);
    const json = serializeOnlineCatalog(h.service.onlineCatalogSnapshot().document);
    expect(json).toContain("مفتاح أحمر");
    expect(json).not.toContain("\\u0645");
    h.db.close();
  });

  it("carries the frozen schema version and a real generated_at, and ends in one newline", () => {
    const h = makeHarness(t.dbPath);
    const json = serializeOnlineCatalog(h.service.onlineCatalogSnapshot().document);
    const parsed = JSON.parse(json) as { schema_version: number; generated_at: string };
    expect(parsed.schema_version).toBe(ONLINE_CATALOG_SCHEMA_VERSION);
    expect(parsed.schema_version).toBe(1);
    expect(Number.isNaN(Date.parse(parsed.generated_at))).toBe(false);
    expect(json.endsWith("}\n")).toBe(true);
    expect(json.endsWith("}\n\n")).toBe(false);
    h.db.close();
  });

  it("freezes the product key set — a new field is a deliberate contract change", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, p.id);
    const [only] = h.service.onlineCatalogSnapshot().document.products;
    expect(Object.keys(only!)).toEqual([
      "id",
      "sku",
      "barcode",
      "name_ar",
      "name_en",
      "category",
      "brand",
      "price",
      "currency",
      "unit",
      "description_ar",
      "description_en",
      "online_visible",
      "image",
      "updated_at",
    ]);
    h.db.close();
  });
});

describe("🔴 privacy — the canary test", () => {
  it("no private string from any other domain reaches the exported JSON", () => {
    const h = makeHarness(t.dbPath);

    // Canaries, each unique and each written into a DIFFERENT private domain through raw SQL so
    // the test does not depend on a service path that might refuse them.
    const canaries = {
      operator: "CANARY-OPERATOR-9f12",
      pinHash: "CANARYPINHASH3a7bCANARYPINHASH",
      sale: "CANARY-SALE-55c1",
      invoice: "CANARY-INVOICE-77d2",
      audit: "CANARY-AUDIT-21e3",
      setting: "CANARY-SETTING-88f4",
    };
    // 🔴 SCOPED, AND THE ROW COUNT ASSERTED. `operators.name` is UNIQUE, so an unscoped UPDATE
    // collides; and an UPDATE that matches nothing SUCCEEDS, which would leave this whole test
    // searching for canaries that were never written — passing, and proving nothing.
    const firstOperator = h.db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string };
    const named = h.db.prepare("UPDATE operators SET name = ?, pin_salt_hex = ? WHERE id = ?").run(
      canaries.operator,
      canaries.pinHash,
      firstOperator.id,
    );
    expect(named.changes).toBe(1);

    // 🔴 THE PRODUCT IS CREATED BEFORE THE AUDIT CANARY IS STAMPED, and the assertion below is why
    // that order matters. `audit_events` is EMPTY on a fresh harness, so stamping it first changed
    // zero rows — and the search for that canary would then have passed while testing nothing.
    // The `.changes` check caught it; without the check this test would have looked fine forever.
    const product = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, product.id);
    // 🔴 APPENDED, NOT UPDATED. A trigger enforces that `audit_events` is append-only, so the
    // obvious `UPDATE … SET actor_name` is refused outright — which is itself the contract working.
    // A canary therefore has to arrive the way every audit row arrives: by being written.
    //
    // It is built by CLONING a real row and overriding four fields, rather than by listing columns
    // by hand. Two attempts at the hand-written form each missed a NOT NULL column, and a third
    // would only have missed the next one; cloning is also immune to a future migration adding one.
    const template = h.db.prepare("SELECT * FROM audit_events ORDER BY seq LIMIT 1").get() as Record<
      string,
      unknown
    >;
    expect(template, "there must be a real audit row to clone").toBeDefined();
    const maxSeq = h.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM audit_events").get() as { n: bigint };
    const clone: Record<string, unknown> = {
      ...template,
      id: "a-canary",
      seq: BigInt(Number(maxSeq.n) + 1),
      actor_name: canaries.audit,
      changed_json: JSON.stringify({ name: canaries.operator }),
    };
    const columns = Object.keys(clone);
    const appended = h.db
      .prepare(
        `INSERT INTO audit_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...columns.map((c) => clone[c]));
    expect(appended.changes).toBe(1);

    // A sale, an invoice and a setting, each carrying its own canary.
    //
    // 🔴 THE ROWS ARE CREATED BY THE REAL SERVICES AND THEN CLONED, never hand-written. Two
    // hand-written INSERTs here each failed on a different NOT NULL column I had not thought of,
    // and a third would have failed on the next one. Cloning a row the application itself wrote is
    // both correct today and immune to a future migration adding a column.
    h.service.createSale({
      idempotencyKey: "canary-sale-key-0001",
      paymentMethod: "cash",
      // The product this test just created, not a fixture id: creating any product replaces the
      // live catalog, so a fixture product is no longer guaranteed to be in it.
      lines: [{ productId: product.id, quantityMilli: 1000 }],
      expectedTotalMinor: 400n,
    });
    h.invoices.createDraft();

    const cloneWith = (table: string, overrides: Record<string, unknown>): void => {
      const template = h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1`).get() as Record<
        string,
        unknown
      >;
      expect(template, `${table} must have a real row to clone`).toBeDefined();
      // 🔴 AN OVERRIDE FOR A COLUMN THAT DOES NOT EXIST IS A TEST BUG, not a no-op. Without this
      // the INSERT fails with a confusing "no such column", or worse, a typo'd key silently adds a
      // column name SQLite then rejects — either way the canary never lands where it was meant to.
      for (const key of Object.keys(overrides)) {
        expect(Object.prototype.hasOwnProperty.call(template, key), `${table}.${key} must be a real column`).toBe(true);
      }
      const clone = { ...template, ...overrides };
      const columns = Object.keys(clone);
      const result = h.db
        .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((c) => clone[c]));
      expect(result.changes, `${table} canary row was inserted`).toBe(1);
    };
    // `receipt_number` is UNIQUE too — a clone has to differ in every unique column, not just the key.
    cloneWith("sales", {
      id: "s-canary",
      idempotency_key: "k-canary",
      receipt_number: 999_999,
      cashier_name: canaries.sale,
    });
    cloneWith("invoices", { id: "i-canary", invoice_number: 999_999, customer_name: canaries.invoice });
    // 🔴 WRITTEN THROUGH THE REAL STORE, because `company_profile` is EMPTY on a fresh harness and
    // the obvious `UPDATE … SET name_ar` changed ZERO rows — another canary that would have been
    // searched for and never written. The `.changes` assertion is what caught it, twice now.
    h.companyStore.save(
      {
        nameAr: canaries.setting,
        nameEn: null,
        legalName: null,
        tagline: null,
        address: null,
        phone1: null,
        phone2: null,
        email: null,
        logoPath: null,
        taxRateBp: 0,
        taxLabel: null,
      } as never,
      new Date("2026-01-01T00:00:00.000Z"),
      1,
    );
    const settingRow = h.db.prepare("SELECT name_ar FROM company_profile LIMIT 1").get() as {
      name_ar: string;
    };
    expect(settingRow.name_ar).toBe(canaries.setting);

    const json = serializeOnlineCatalog(h.service.onlineCatalogSnapshot().document);

    for (const [domain, canary] of Object.entries(canaries)) {
      expect(json.includes(canary), `${domain} canary "${canary}" leaked into catalog.json`).toBe(false);
    }

    // 🔴 THE CONTROL. If the canaries were never written, every assertion above would pass on an
    // empty database and prove nothing. These prove the rows really carry them.
    const operatorRow = h.db.prepare("SELECT name FROM operators WHERE id = ?").get(firstOperator.id) as {
      name: string;
    };
    expect(operatorRow.name).toBe(canaries.operator);
    const saleRow = h.db.prepare("SELECT cashier_name FROM sales WHERE id = 's-canary'").get() as {
      cashier_name: string;
    };
    expect(saleRow.cashier_name).toBe(canaries.sale);
    const invoiceRow = h.db.prepare("SELECT customer_name FROM invoices WHERE id = 'i-canary'").get() as {
      customer_name: string;
    };
    expect(invoiceRow.customer_name).toBe(canaries.invoice);

    // And the product itself IS in the file, so the export was not simply empty.
    expect(json).toContain(product.id);
    h.db.close();
  });

  it("no table name, SQL, path or base64 shape appears in the output", () => {
    const h = makeHarness(t.dbPath);
    const p = h.service.createProduct(DRAFT({ sku: "S-1" }) as never);
    publish(h, p.id);
    const photo = normalizeProductPhoto(readFileSync(join(FIXTURES, "logo-alpha.png")), fakeCodec());
    h.service.setProductPrimaryImage({
      productId: p.id,
      bytes: photo.bytes,
      mime: photo.mime,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      origin: "desktop",
    });
    const json = serializeOnlineCatalog(h.service.onlineCatalogSnapshot().document);

    for (const forbidden of [
      "catalog_products",
      "catalog_product_images",
      "audit_events",
      "operators",
      "sqlite",
      "SELECT",
      "source_key",
      "price_needs_review",
      "is_active",
      "data:image",
      "base64",
      "/home/",
      "C:\\",
    ]) {
      expect(json.includes(forbidden), `"${forbidden}" appeared in catalog.json`).toBe(false);
    }
    // The photo is referenced as a FILE, never carried as bytes.
    expect(json).toContain('"file": "images/product-');
    expect(json.length).toBeLessThan(4096);
    h.db.close();
  });
});

describe("authorization", () => {
  it("🔴 a CASHIER cannot take a snapshot, through the service itself", () => {
    const h = makeHarness(t.dbPath, { login: false });
    h.service.login("cashier-02", "2222");
    let code: string | null = null;
    try {
      h.service.onlineCatalogSnapshot();
    } catch (e) {
      code = e instanceof DomainError ? e.code : "not-a-DomainError";
    }
    // The code the service really uses for an owner-only operation, measured rather than assumed.
    expect(code).toBe("NOT_AUTHORIZED");
    h.db.close();
  });

  it("an unauthenticated terminal cannot either", () => {
    const h = makeHarness(t.dbPath, { login: false });
    expect(() => h.service.onlineCatalogSnapshot()).toThrow();
    h.db.close();
  });

  it("CONTROL — the owner succeeds, so the refusals above are not vacuous", () => {
    const h = makeHarness(t.dbPath);
    expect(() => h.service.onlineCatalogSnapshot()).not.toThrow();
    h.db.close();
  });
});
