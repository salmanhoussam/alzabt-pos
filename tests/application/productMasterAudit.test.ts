/**
 * Migration 10's audit rows, and the ATOMICITY that makes them trustworthy.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT "AUDITED" HAS TO MEAN, OR IT MEANS NOTHING.
 *
 * It is not "the service also writes an audit row". It is: **no successful category or photo
 * mutation can exist without its audit row, and no audit row can exist for a mutation that did not
 * happen.** Both halves are properties of a TRANSACTION, not of a code path that calls two methods
 * in order — and the only way to prove the first half is to make the audit write fail on purpose
 * and check that the business row went back.
 *
 * So the fault-injection tests below are the point of this file. They follow the pattern
 * `operatorAccounts.test.ts` already established for the setup ceremony, applied to the two
 * mutation families migration 10 gave a vocabulary to.
 *
 * 🔴 AND A FAILURE MUST FAIL FOR THE RIGHT REASON. An injected audit fault that threw before the
 * mutation was attempted would make these tests pass while proving nothing, so each one asserts
 * the injected message by name — never merely that something threw.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Synthetic throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PosService } from "../../src/application/posService";
import { OperatorService } from "../../src/application/operatorService";
import { loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { CategoryRepository } from "../../src/persistence/categoryRepository";
import { ProductImageRepository } from "../../src/persistence/productImageRepository";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { type TempDir, tempDir } from "../helpers/harness";

const NOW = new Date("2026-10-14T09:00:00.000Z");
const PNG = Buffer.from("89504e470d0a1a0a" + "55".repeat(40), "hex");
const OTHER_PNG = Buffer.from("89504e470d0a1a0a" + "66".repeat(40), "hex");

let t: TempDir;
let db: Db;
let trail: AuditRepository;
let categories: CategoryRepository;
let images: ProductImageRepository;
let ids = 0;

/**
 * A terminal built by hand rather than through `makeHarness`, because these tests must be able to
 * swap in a FAILING audit repository — which is the whole subject of the file.
 */
function build(auditStore: AuditRepository): PosService {
  const operatorStore = new OperatorRepository(db);
  for (const fixture of FIXTURE_CASHIERS) {
    if (operatorStore.findById(fixture.id)) {
      operatorStore.setPin(fixture.id, fixture.pinSaltHex, fixture.pinHashHex, NOW.toISOString(), {
        mustResetPin: false,
      });
    }
  }
  operatorStore.claimTerminal("cashier-01", NOW.toISOString());
  const service = new PosService({
    repository: new SaleRepository(db),
    pinStates: new PinStateRepository(db),
    catalog: loadCatalog(FIXTURE_CATALOG),
    catalogStore: new CatalogRepository(db),
    categories,
    productImages: images,
    auditStore,
    transact: (fn) => db.transaction(fn).immediate(),
    cashiers: FIXTURE_CASHIERS,
    operators: new OperatorService({
      operators: operatorStore,
      audit: trail,
      transact: (fn) => db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: () => NOW,
    }),
    terminal: FIXTURE_TERMINAL,
    now: () => NOW,
    newId: () => `id-${(ids += 1).toString().padStart(4, "0")}`,
  });
  service.login("cashier-01", "1111");
  return service;
}

/** An audit repository that throws on the Nth append and otherwise behaves exactly as the real one. */
function failingAt(n: number): AuditRepository {
  let calls = 0;
  return {
    append: (draft: Parameters<AuditRepository["append"]>[0], id: string) => {
      calls += 1;
      if (calls === n) throw new Error("injected audit failure");
      return trail.append(draft, id);
    },
  } as unknown as AuditRepository;
}

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
  trail = new AuditRepository(db, { appVersion: "test", schemaVersion: MIGRATIONS.length });
  categories = new CategoryRepository(db);
  images = new ProductImageRepository(db);
  ids = 0;
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const events = () =>
  db.prepare("SELECT event_type, entity_type, entity_id, changed_json, metadata_json FROM audit_events ORDER BY seq").all() as Array<{
    event_type: string;
    entity_type: string;
    entity_id: string;
    changed_json: string;
    metadata_json: string | null;
  }>;

const changesOf = (index: number) => JSON.parse(events()[index]!.changed_json) as Record<string, { before: unknown; after: unknown }>;
const categoryCount = () => Number((db.prepare("SELECT count(*) AS n FROM catalog_categories").get() as { n: bigint }).n);
const imageCount = () => Number((db.prepare("SELECT count(*) AS n FROM catalog_product_images").get() as { n: bigint }).n);

const product = (service: PosService) =>
  service.createProduct({ nameAr: "مفك", nameEn: null, sku: null, price: "5.00", baseUnit: "piece" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// What the rows SAY
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("category events — minimal and truthful", () => {
  it("CATEGORY_CREATED records the whole state, every `before` null", () => {
    const service = build(trail);
    const cat = service.createCategory("عدد", "Tools");
    const row = events().at(-1)!;
    expect(row).toMatchObject({ event_type: "CATEGORY_CREATED", entity_type: "category", entity_id: cat.id });
    expect(JSON.parse(row.changed_json)).toEqual({
      is_active: { before: null, after: true },
      name_ar: { before: null, after: "عدد" },
      name_en: { before: null, after: "Tools" },
    });
    // 🔴 No metadata: the event type and the diff are the whole fact.
    expect(row.metadata_json).toBeNull();
  });

  it("🔴 CATEGORY_RENAMED records the OLD name and the new one — nothing else moved", () => {
    const service = build(trail);
    const cat = service.createCategory("عدد", "Tools");
    service.renameCategory(cat.id, "عدد يدوية", "Hand tools");
    const row = events().at(-1)!;
    expect(row.event_type).toBe("CATEGORY_RENAMED");
    expect(JSON.parse(row.changed_json)).toEqual({
      name_ar: { before: "عدد", after: "عدد يدوية" },
      name_en: { before: "Tools", after: "Hand tools" },
    });
    // `is_active` did not change, so it is ABSENT rather than present-and-equal. A diff that
    // restated every field would make "what actually changed" unreadable.
    expect(Object.keys(JSON.parse(row.changed_json) as object).sort()).toEqual(["name_ar", "name_en"]);
  });

  it("CATEGORY_ACTIVATED / DEACTIVATED record only the flag, and each is its own event type", () => {
    const service = build(trail);
    const cat = service.createCategory("عدد", null);
    service.setCategoryActive(cat.id, false);
    expect(events().at(-1)!.event_type).toBe("CATEGORY_DEACTIVATED");
    expect(changesOf(events().length - 1)).toEqual({ is_active: { before: true, after: false } });
    service.setCategoryActive(cat.id, true);
    expect(events().at(-1)!.event_type).toBe("CATEGORY_ACTIVATED");
    expect(changesOf(events().length - 1)).toEqual({ is_active: { before: false, after: true } });
  });

  it("🔴 CATEGORY_DELETED carries the name AS IT WAS — captured before the row was destroyed", () => {
    const service = build(trail);
    const cat = service.createCategory("سباكة", "Plumbing");
    service.deleteCategoryIfUnused(cat.id);
    expect(categoryCount()).toBe(0);
    const row = events().at(-1)!;
    expect(row).toMatchObject({ event_type: "CATEGORY_DELETED", entity_id: cat.id });
    // After the DELETE there is nothing left to read. If the facts were not captured inside the
    // transaction, "what was this category called" would be permanently unanswerable — which is
    // exactly the question a deletion makes someone ask later.
    expect(JSON.parse(row.changed_json)).toEqual({
      is_active: { before: true, after: null },
      name_ar: { before: "سباكة", after: null },
      name_en: { before: "Plumbing", after: null },
    });
  });

  it("🔴 a REFUSED delete emits NO event — an attempt is not a fact about the shop", () => {
    const service = build(trail);
    const cat = service.createCategory("عدد", null);
    const p = product(service);
    service.updateProduct(p.id, { nameAr: "مفك", nameEn: null, sku: null, price: "5.00", baseUnit: "piece", master: { categoryId: cat.id } }, true);
    const before = events().length;
    expect(() => service.deleteCategoryIfUnused(cat.id)).toThrow(/is used by/);
    expect(events()).toHaveLength(before);
    expect(events().some((e) => e.event_type === "CATEGORY_DELETED")).toBe(false);
    expect(categoryCount()).toBe(1);
  });

  it("a no-op rename and a no-op toggle write nothing — nothing is not an event", () => {
    const service = build(trail);
    const cat = service.createCategory("عدد", "Tools");
    const after = events().length;
    service.renameCategory(cat.id, "عدد", "Tools");
    service.setCategoryActive(cat.id, true);
    expect(events()).toHaveLength(after);
  });

  it("🔴 the actor is the real owner, by id and name and tier", () => {
    const service = build(trail);
    service.createCategory("عدد", null);
    const row = db.prepare("SELECT actor_id, actor_name, actor_tier FROM audit_events ORDER BY seq DESC LIMIT 1").get();
    expect(row).toEqual({ actor_id: "cashier-01", actor_name: "Cashier One", actor_tier: "owner" });
  });
});

describe("photo events — metadata only, and never the bytes", () => {
  const setPhoto = (service: PosService, productId: string, bytes = PNG) =>
    service.setProductPrimaryImage({ productId, bytes, mime: "image/png", widthPx: 10, heightPx: 10, origin: "desktop" });

  it("PRODUCT_IMAGE_SET names the PRODUCT and records the photo's identity", () => {
    const service = build(trail);
    const p = product(service);
    const meta = setPhoto(service, p.id);
    const row = events().at(-1)!;
    // 🔴 The entity is the product, not the image row: an image id that has since been replaced is
    // not something anyone can look up, and "what happened to this product's photo" is the question.
    expect(row).toMatchObject({ event_type: "PRODUCT_IMAGE_SET", entity_type: "product_image", entity_id: p.id });
    expect(JSON.parse(row.changed_json)).toEqual({
      byte_size: { before: null, after: PNG.length },
      height_px: { before: null, after: 10 },
      image_id: { before: null, after: meta.id },
      mime: { before: null, after: "image/png" },
      sha256_hex: { before: null, after: createHash("sha256").update(PNG).digest("hex") },
      width_px: { before: null, after: 10 },
    });
    expect(JSON.parse(row.metadata_json!)).toEqual({ photo_origin: "desktop" });
  });

  it("🔴 a second photo is REPLACED, not SET — and it names the photo it destroyed", () => {
    const service = build(trail);
    const p = product(service);
    const first = setPhoto(service, p.id);
    const second = setPhoto(service, p.id, OTHER_PNG);
    const row = events().at(-1)!;
    expect(row.event_type).toBe("PRODUCT_IMAGE_REPLACED");
    const changes = JSON.parse(row.changed_json) as Record<string, { before: unknown; after: unknown }>;
    expect(changes.image_id).toEqual({ before: first.id, after: second.id });
    expect(changes.sha256_hex).toEqual({
      before: createHash("sha256").update(PNG).digest("hex"),
      after: createHash("sha256").update(OTHER_PNG).digest("hex"),
    });
    // The dimensions and MIME did not change, so they are absent from the diff.
    expect(Object.keys(changes).sort()).toEqual(["image_id", "sha256_hex"]);
  });

  it("PRODUCT_IMAGE_REMOVED records what was lost; removing nothing records nothing", () => {
    const service = build(trail);
    const p = product(service);
    const meta = setPhoto(service, p.id);
    service.removeProductPrimaryImage(p.id);
    const row = events().at(-1)!;
    expect(row.event_type).toBe("PRODUCT_IMAGE_REMOVED");
    expect((JSON.parse(row.changed_json) as Record<string, unknown>).image_id).toEqual({ before: meta.id, after: null });

    // Idempotent and silent: a double click is not a fact.
    const after = events().length;
    expect(service.removeProductPrimaryImage(p.id)).toEqual({ removed: false });
    expect(events()).toHaveLength(after);
  });

  it("🔴 NO EVENT CARRIES IMAGE DATA — not a blob, not base64, not a path", () => {
    const service = build(trail);
    const p = product(service);
    setPhoto(service, p.id);
    setPhoto(service, p.id, OTHER_PNG);
    service.removeProductPrimaryImage(p.id);
    const all = events();
    const text = JSON.stringify(all);
    // The bytes themselves, in the two encodings they could leak as.
    expect(text).not.toContain(PNG.toString("base64"));
    expect(text).not.toContain(PNG.toString("hex"));
    expect(text).not.toContain("89504e47"); // the PNG magic number
    expect(text).not.toMatch(/data:image/);
    // And no field that even looks like a file.
    for (const row of all) {
      const keys = Object.keys(JSON.parse(row.changed_json) as object);
      expect(keys.filter((k) => /bytes|blob|base64|data|path|file/i.test(k))).toEqual([]);
    }
    // 🔴 CONTROL: the rows are not empty, so the four assertions above are about their content.
    expect(all.filter((e) => e.entity_type === "product_image")).toHaveLength(3);
  });

  it("🔴 the checksum field is named sha256_hex, because /hash/i is REFUSED outright", () => {
    // `SECRET_KEY` in src/domain/audit.ts rejects any key matching /hash/i, so a field called
    // `image_hash` would throw and roll back the photo write. The naming is load-bearing, not a
    // style choice — asserted here so a future rename fails in milliseconds.
    const service = build(trail);
    const p = product(service);
    setPhoto(service, p.id);
    expect(Object.keys(changesOf(events().length - 1))).toContain("sha256_hex");
    expect(Object.keys(changesOf(events().length - 1)).filter((k) => /hash/i.test(k))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §L — FAULT INJECTION. The whole point of the file.
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("🔴 atomicity — an audit failure ROLLS BACK the mutation", () => {
  it("CATEGORY CREATE: the category does not exist afterwards", () => {
    const service = build(failingAt(1));
    expect(() => service.createCategory("عدد", "Tools")).toThrow(/injected audit failure/);
    expect(categoryCount()).toBe(0);
    expect(events()).toHaveLength(0);
  });

  it("CATEGORY RENAME: the old name is still there, byte for byte", () => {
    const real = build(trail);
    const cat = real.createCategory("عدد", "Tools");
    const before = db.prepare("SELECT * FROM catalog_categories WHERE id = ?").get(cat.id);
    const auditBefore = events().length;

    const failing = build(failingAt(1));
    expect(() => failing.renameCategory(cat.id, "محذوف", "Gone")).toThrow(/injected audit failure/);

    expect(db.prepare("SELECT * FROM catalog_categories WHERE id = ?").get(cat.id)).toEqual(before);
    expect(events()).toHaveLength(auditBefore);
  });

  it("CATEGORY DEACTIVATE: the category is still active", () => {
    const real = build(trail);
    const cat = real.createCategory("عدد", null);
    const failing = build(failingAt(1));
    expect(() => failing.setCategoryActive(cat.id, false)).toThrow(/injected audit failure/);
    expect(categories.findById(cat.id)!.is_active).toBe(1);
  });

  it("🔴 CATEGORY DELETE: the category is still there — a destroyed row cannot be put back later", () => {
    const real = build(trail);
    const cat = real.createCategory("سباكة", "Plumbing");
    const before = db.prepare("SELECT * FROM catalog_categories WHERE id = ?").get(cat.id);

    const failing = build(failingAt(1));
    expect(() => failing.deleteCategoryIfUnused(cat.id)).toThrow(/injected audit failure/);

    // This is the case atomicity matters most for: the DELETE ran before the append, so without a
    // transaction the row would be gone AND unrecorded.
    expect(categoryCount()).toBe(1);
    expect(db.prepare("SELECT * FROM catalog_categories WHERE id = ?").get(cat.id)).toEqual(before);
  });

  it("IMAGE SET: no image row survives the failed append", () => {
    const real = build(trail);
    const p = product(real);
    const failing = build(failingAt(1));
    expect(() =>
      failing.setProductPrimaryImage({ productId: p.id, bytes: PNG, mime: "image/png", widthPx: 10, heightPx: 10, origin: "desktop" }),
    ).toThrow(/injected audit failure/);
    expect(imageCount()).toBe(0);
  });

  it("🔴 IMAGE REPLACE: the ORIGINAL photo is still the primary one, unchanged", () => {
    const real = build(trail);
    const p = product(real);
    const first = real.setProductPrimaryImage({ productId: p.id, bytes: PNG, mime: "image/png", widthPx: 10, heightPx: 10, origin: "desktop" });

    const failing = build(failingAt(1));
    expect(() =>
      failing.setProductPrimaryImage({ productId: p.id, bytes: OTHER_PNG, mime: "image/png", widthPx: 20, heightPx: 20, origin: "phone" }),
    ).toThrow(/injected audit failure/);

    // 🔴 `putPrimary` DELETES the old row before inserting the new one — the partial unique index
    // leaves it no choice. So a non-atomic replace whose audit fails would destroy the shop's only
    // copy of the photo and store nothing in its place.
    expect(imageCount()).toBe(1);
    const still = images.findPrimaryMeta(p.id)!;
    expect(still.id).toBe(first.id);
    expect(still.sha256_hex).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(Buffer.from(images.readBytes(still.id)!).equals(PNG)).toBe(true);
  });

  it("🔴 IMAGE REMOVE: the photo is still there, bytes and all", () => {
    const real = build(trail);
    const p = product(real);
    const meta = real.setProductPrimaryImage({ productId: p.id, bytes: PNG, mime: "image/png", widthPx: 10, heightPx: 10, origin: "desktop" });

    const failing = build(failingAt(1));
    expect(() => failing.removeProductPrimaryImage(p.id)).toThrow(/injected audit failure/);

    expect(imageCount()).toBe(1);
    expect(images.findPrimaryMeta(p.id)!.id).toBe(meta.id);
    expect(Buffer.from(images.readBytes(meta.id)!).equals(PNG)).toBe(true);
  });

  it("🔴 CONTROL — the SAME calls succeed with a working trail, so none of the above passed by accident", () => {
    // Every test in this block asserts the injected message by name, so an unrelated validation
    // failure could not masquerade as a rollback. This closes the other direction: the operations
    // themselves are valid, and it is the injected fault that stops them.
    const service = build(trail);
    const cat = service.createCategory("عدد", "Tools");
    expect(categoryCount()).toBe(1);
    service.renameCategory(cat.id, "محذوف", "Gone");
    service.setCategoryActive(cat.id, false);
    service.deleteCategoryIfUnused(cat.id);
    expect(categoryCount()).toBe(0);

    const p = product(service);
    service.setProductPrimaryImage({ productId: p.id, bytes: PNG, mime: "image/png", widthPx: 10, heightPx: 10, origin: "desktop" });
    service.setProductPrimaryImage({ productId: p.id, bytes: OTHER_PNG, mime: "image/png", widthPx: 20, heightPx: 20, origin: "phone" });
    expect(imageCount()).toBe(1);
    service.removeProductPrimaryImage(p.id);
    expect(imageCount()).toBe(0);

    // In the order they really happened — the four category acts, then the product this test
    // creates to hang a photo on, then the three photo acts.
    expect(events().map((e) => e.event_type)).toEqual([
      "CATEGORY_CREATED",
      "CATEGORY_RENAMED",
      "CATEGORY_DEACTIVATED",
      "CATEGORY_DELETED",
      "PRODUCT_CREATED",
      "PRODUCT_IMAGE_SET",
      "PRODUCT_IMAGE_REPLACED",
      "PRODUCT_IMAGE_REMOVED",
    ]);
  });

  it("🔴 a terminal with NO audit trail REFUSES these mutations rather than doing them unrecorded", () => {
    const operatorStore = new OperatorRepository(db);
    for (const fixture of FIXTURE_CASHIERS) {
      if (operatorStore.findById(fixture.id)) {
        operatorStore.setPin(fixture.id, fixture.pinSaltHex, fixture.pinHashHex, NOW.toISOString(), { mustResetPin: false });
      }
    }
    operatorStore.claimTerminal("cashier-01", NOW.toISOString());
    const unaudited = new PosService({
      repository: new SaleRepository(db),
      pinStates: new PinStateRepository(db),
      catalog: loadCatalog(FIXTURE_CATALOG),
      catalogStore: new CatalogRepository(db),
      categories,
      productImages: images,
      // No auditStore at all — the shape a terminal had before this wiring existed.
      transact: (fn) => db.transaction(fn).immediate(),
      cashiers: FIXTURE_CASHIERS,
      operators: new OperatorService({
        operators: operatorStore,
        audit: trail,
        transact: (fn) => db.transaction(fn).immediate(),
        terminal: FIXTURE_TERMINAL,
        now: () => NOW,
      }),
      terminal: FIXTURE_TERMINAL,
      now: () => NOW,
      newId: () => `id-${(ids += 1).toString().padStart(4, "0")}`,
    });
    unaudited.login("cashier-01", "1111");
    expect(() => unaudited.createCategory("عدد", null)).toThrow(/audit trail is not wired/);
    expect(categoryCount()).toBe(0);
  });
});
