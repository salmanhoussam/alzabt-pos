/**
 * TRY DEMO — the demo ledger's CONTENT plan, run through injected ports (contract J0-CODEX-1 §B,
 * BINDING-REQUESTS.md sha256 73cae0f9…; C1 of the joint plan V1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS MODULE HAS NO AUTHORITY. It imports no Electron, no `fs`, no dialog and no IPC. It cannot
 * open a ledger, pick a profile, read a path, show a dialog or create a session. Every write goes
 * through a port that MAIN implements with the product's own services (the real owner-setup ceremony,
 * the catalog import, the category and product services, the photo pipeline). Main alone decides
 * whether seeding may happen at all (a trusted demo process, a ledger THIS launch created) and main
 * alone may later issue a demo session — this module only returns the seeded IDs and counts.
 *
 * 🔴 IT FAILS CLOSED. A port error, an unknown or duplicate SKU, an image name outside the fixture
 * manifest, or counts other than 22 products / 22 photos / 8 categories throw `DemoSeedError`; main
 * must then refuse the demo session (N7).
 *
 * The old POC's handler-map + "dialog aim" shim (542af2f) is deliberately gone: no renderer picker is
 * ever pointed at a file on the seed's behalf.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

/** `resources/demo/demo-profile.json` — read by MAIN only; never served to the renderer (BR-C-02). */
export interface DemoDefinition {
  readonly shop: { readonly nameAr: string; readonly nameEn: string; readonly tagline: string; readonly address: string; readonly phone1: string };
  readonly owner: { readonly name: string; readonly pin: string };
  readonly cashier: { readonly name: string; readonly pin: string };
  readonly skus: ReadonlyArray<string>;
}

/** One product of the shipped synthetic fixture (`tests/fixtures/demo-catalog/catalog.json`). */
export interface FixtureProduct {
  readonly source_id: string;
  readonly sku: string;
  readonly barcode: string;
  readonly name_ar: string;
  readonly name_en: string | null;
  readonly price: string;
  readonly unit: string;
  readonly category: string;
  readonly brand: string | null;
  readonly desc_ar: string | null;
  readonly desc_en: string | null;
  readonly active: boolean;
}

export interface FixtureCatalog {
  readonly currency: string;
  /** [key, Arabic name, English name] */
  readonly categories: ReadonlyArray<readonly [string, string, string]>;
  readonly products: ReadonlyArray<FixtureProduct>;
}

/** The shop identity main maps onto the company-profile service. Synthetic values only. */
export interface CompanyProfileInput {
  readonly nameAr: string;
  readonly nameEn: string;
  readonly tagline: string;
  readonly address: string;
  readonly phone1: string;
}

/** What the product screen's own save would write for one product. */
export interface FixtureProductDetails {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sku: string;
  readonly price: string;
  readonly baseUnit: string;
  readonly categoryId: string;
  readonly barcode: string;
  readonly brand: string | null;
  readonly descriptionAr: string | null;
  readonly descriptionEn: string | null;
}

/**
 * Implemented by MAIN (binding request BR-C-02). Main-internal; never a preload / renderer channel.
 *
 * Semantics (BR-C-05, G1-BINDING-ADDENDUM-BR-C-05-V1.md, agreed by both agents):
 *   - `importCatalogCsv` returns exactly one product ID per CSV data row, IN THE CSV's ROW ORDER. The
 *     Candidate's import returns counts, not IDs, so main's adapter derives each expected ID from the
 *     row's validated `source_id` (`productIdFor(CSV_SOURCE, source_id)`), looks it up and verifies its
 *     stored source / key / active state — it never relies on repository list order. Any mismatch,
 *     absence, duplicate or rejected row fails the port. This module still re-checks count and
 *     uniqueness (fail closed).
 *   - `setProductImageFromFixture` receives only a validated image NAME; main checks it against the
 *     trusted credits manifest (licence), file existence and decode, then runs the existing photo
 *     pipeline, and throws on any failure.
 *   - `saveCompanyProfile(…, "fixture")`: main supplies the reviewed resources/demo/demo-logo.png bytes.
 */
export interface DemoSeedPorts {
  completeOwnerSetup(name: string, pin: string): Promise<{ operatorId: string }>;
  completeCashierSetup(name: string, pin: string): Promise<{ operatorId: string }>;
  saveCompanyProfile(profile: CompanyProfileInput, logo: "fixture"): Promise<void>;
  importCatalogCsv(csv: Uint8Array): Promise<{ productIds: ReadonlyArray<string> }>;
  ensureCategory(nameAr: string, nameEn: string): Promise<{ categoryId: string }>;
  updateProductDetails(productId: string, details: FixtureProductDetails): Promise<void>;
  setProductImageFromFixture(productId: string, imageName: string): Promise<void>;
}

export interface DemoSeedInputs {
  readonly definition: DemoDefinition;
  readonly fixture: FixtureCatalog;
  /** The fixture's import CSV, as shipped (header + all rows). */
  readonly catalogCsv: Uint8Array;
}

/** Private to main. IDs and counts only — no session, credential or authority. */
export interface DemoSeedReport {
  readonly ownerOperatorId: string;
  readonly cashierOperatorId: string;
  readonly productIds: ReadonlyArray<string>;
  readonly photosSet: number;
  readonly categories: number;
}

/** The demo the owner approved (D-2 / V1 §1): exactly these counts, or no demo. */
export const DEMO_EXPECTED = { products: 22, photos: 22, categories: 8 } as const;

/** The only image names that may cross the port (J0-CODEX-1 §B). */
export const DEMO_IMAGE_NAME = /^[A-Z0-9-]+\.jpg$/;

/**
 * C1-R3 (Codex cross-review): every failure is a fixed STAGE CODE with a neutral message. No port
 * exception text, no rejected input value (SKU, name, path) and no PIN ever appears in the message,
 * the stage or any other property — the raw cause is deliberately NOT kept (no `cause`).
 */
export type DemoSeedStage =
  | "definition-sku-duplicate"
  | "definition-sku-unknown"
  | "definition-sku-inactive"
  | "definition-count"
  | "definition-pin"
  | "definition-pin-shared"
  | "category-unknown"
  | "category-count"
  | "image-name"
  | "image-manifest"
  | "csv-rows"
  | "csv-row-unexpected"
  | "owner-setup"
  | "cashier-setup"
  | "operators-distinct"
  | "company-profile"
  | "catalog-import"
  | "import-ids"
  | "category"
  | "product-details"
  | "product-photo"
  | "photo-count";

export class DemoSeedError extends Error {
  readonly code = "DEMO_SEED_FAILED";
  constructor(readonly stage: DemoSeedStage) {
    super(`Demo seed failed (${stage}).`);
    this.name = "DemoSeedError";
  }
}

/**
 * Validates the definition against the fixture and returns the selected products in definition order.
 * Refuses a duplicate, an unknown SKU, an inactive product, a malformed PIN and a count other than 22.
 */
export function selectDemoProducts(def: DemoDefinition, fixture: FixtureCatalog): FixtureProduct[] {
  const bySku = new Map(fixture.products.map((p) => [p.sku, p]));
  const seen = new Set<string>();
  const out: FixtureProduct[] = [];
  for (const sku of def.skus) {
    if (seen.has(sku)) throw new DemoSeedError("definition-sku-duplicate");
    seen.add(sku);
    const p = bySku.get(sku);
    if (!p) throw new DemoSeedError("definition-sku-unknown");
    if (!p.active) throw new DemoSeedError("definition-sku-inactive");
    out.push(p);
  }
  if (out.length !== DEMO_EXPECTED.products) {
    throw new DemoSeedError("definition-count");
  }
  for (const pin of [def.owner.pin, def.cashier.pin]) {
    if (!/^[0-9]{6,8}$/.test(pin)) throw new DemoSeedError("definition-pin");
  }
  if (def.owner.pin === def.cashier.pin) throw new DemoSeedError("definition-pin-shared");
  return out;
}

/** The fixture categories the selection actually uses, in fixture order. */
export function usedCategories(fixture: FixtureCatalog, selected: ReadonlyArray<FixtureProduct>): Array<readonly [string, string, string]> {
  const used = fixture.categories.filter(([key]) => selected.some((p) => p.category === key));
  for (const p of selected) {
    if (!used.some(([key]) => key === p.category)) throw new DemoSeedError("category-unknown");
  }
  return used;
}

/**
 * The image name for a product: `<SKU>.jpg`, which must match the pattern AND be in `manifest`
 * (the fixture's credited image files). Anything else is refused — no path ever crosses the port.
 */
export function demoImageName(sku: string, manifest: ReadonlySet<string>): string {
  const name = `${sku}.jpg`;
  if (!DEMO_IMAGE_NAME.test(name)) throw new DemoSeedError("image-name");
  if (!manifest.has(name)) throw new DemoSeedError("image-manifest");
  return name;
}

/**
 * The import CSV cut to the selected rows: the header line plus each line whose first field (source_id)
 * is selected, in the CSV's own order. A leading BOM on the header is kept as shipped.
 */
export function cutCatalogCsv(csv: Uint8Array, sourceIds: ReadonlySet<string>): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(csv);
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? "";
  const rows = lines.slice(1).filter((l) => l.trim() !== "" && sourceIds.has(l.split(",")[0] ?? ""));
  if (rows.length !== sourceIds.size) {
    throw new DemoSeedError("csv-rows");
  }
  return new TextEncoder().encode([header, ...rows].join("\n") + "\n");
}

/** The selected products in the order their rows appear in the cut CSV (= the import's row order). */
export function csvRowOrder(csv: Uint8Array, selected: ReadonlyArray<FixtureProduct>): FixtureProduct[] {
  const bySource = new Map(selected.map((p) => [p.source_id, p]));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(csv);
  return text
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const p = bySource.get(l.split(",")[0] ?? "");
      if (!p) throw new DemoSeedError("csv-row-unexpected");
      return p;
    });
}

/** Runs one port call; ANY failure becomes the stage's neutral error. The port's own text is dropped. */
async function step<T>(stage: DemoSeedStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DemoSeedError) throw err;
    throw new DemoSeedError(stage);
  }
}

/**
 * The image-name manifest: one `<SKU>.jpg` per fixture product. The fixture IS the manifest of names;
 * whether each file exists, is credited and decodes is checked by main's port at write time (and by
 * tests/main/demoContent.test.ts on the shipped fixture) — never assumed here.
 */
export function fixtureImageManifest(fixture: FixtureCatalog): Set<string> {
  return new Set(fixture.products.map((p) => `${p.sku}.jpg`));
}

/** Builds the demo content through `ports` (signature as signed in J0-CODEX-1 §B). */
export async function seedDemoLedger(ports: DemoSeedPorts, inputs: DemoSeedInputs): Promise<DemoSeedReport> {
  const { definition: def, fixture } = inputs;
  const imageManifest = fixtureImageManifest(fixture);
  const selected = selectDemoProducts(def, fixture);
  const categories = usedCategories(fixture, selected);
  if (categories.length !== DEMO_EXPECTED.categories) {
    throw new DemoSeedError("category-count");
  }
  // Every image name is validated BEFORE any write, so a bad manifest writes nothing.
  const imageFor = new Map(selected.map((p) => [p.sku, demoImageName(p.sku, imageManifest)]));

  const owner = await step("owner-setup", () => ports.completeOwnerSetup(def.owner.name, def.owner.pin));
  const cashier = await step("cashier-setup", () => ports.completeCashierSetup(def.cashier.name, def.cashier.pin));
  if (!owner.operatorId || !cashier.operatorId || owner.operatorId === cashier.operatorId) {
    throw new DemoSeedError("operators-distinct");
  }

  await step("company-profile", () =>
    ports.saveCompanyProfile(
      { nameAr: def.shop.nameAr, nameEn: def.shop.nameEn, tagline: def.shop.tagline, address: def.shop.address, phone1: def.shop.phone1 },
      "fixture",
    ),
  );

  const csv = cutCatalogCsv(inputs.catalogCsv, new Set(selected.map((p) => p.source_id)));
  const order = csvRowOrder(csv, selected);
  const imported = await step("catalog-import", () => ports.importCatalogCsv(csv));
  if (imported.productIds.length !== order.length || new Set(imported.productIds).size !== order.length) {
    throw new DemoSeedError("import-ids");
  }

  const categoryId = new Map<string, string>();
  for (const [key, ar, en] of categories) {
    const c = await step("category", () => ports.ensureCategory(ar, en));
    categoryId.set(key, c.categoryId);
  }

  let photosSet = 0;
  const productIds: string[] = [];
  for (let i = 0; i < order.length; i++) {
    const p = order[i]!;
    const id = imported.productIds[i]!;
    productIds.push(id);
    await step("product-details", () =>
      ports.updateProductDetails(id, {
        nameAr: p.name_ar,
        nameEn: p.name_en,
        sku: p.sku,
        price: p.price,
        baseUnit: p.unit,
        categoryId: categoryId.get(p.category)!,
        barcode: p.barcode,
        brand: p.brand,
        descriptionAr: p.desc_ar,
        descriptionEn: p.desc_en,
      }),
    );
    await step("product-photo", () => ports.setProductImageFromFixture(id, imageFor.get(p.sku)!));
    photosSet++;
  }

  if (photosSet !== DEMO_EXPECTED.photos) {
    throw new DemoSeedError("photo-count");
  }
  return {
    ownerOperatorId: owner.operatorId,
    cashierOperatorId: cashier.operatorId,
    productIds,
    photosSet,
    categories: categories.length,
  };
}
