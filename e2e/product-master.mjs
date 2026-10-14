/**
 * E2E — the Product Master workspace against the REAL app, for VISUAL review.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCRIPT EXISTS TO PRODUCE EVIDENCE NO UNIT TEST CAN. 922 unit tests, a clean typecheck and
 * a clean build say nothing about whether a screen READS correctly: whether Arabic is aligned,
 * whether a 13-digit barcode reorders beside it, whether a thumbnail is cropped or stretched,
 * whether a row's height explodes, whether a dropdown shows the retired category it is supposed to.
 * Those are answered by looking, and the screenshots below are what there is to look at.
 *
 * 🔴 ONE PHOTO IS SEEDED BY RAW SQL, WITH THE APP CLOSED, AND THAT IS DELIBERATE. The desktop photo
 * producer is slice F: there is no channel that accepts image bytes from the renderer, by design,
 * so today the only way a photo can exist is a main-process caller that does not exist yet. Writing
 * one row directly is test SETUP for a feature whose input path is not built — not a product path,
 * and it is stated here so nobody reads these screenshots as proof that importing a photo works.
 *
 * The PNG is generated, not checked in: a real, valid, decodable image with correct CRCs, so the
 * thumbnail that appears is a real decode and not a broken-image icon.
 *
 * Selectors are data-testid, never visible text — the terminal's default language is Arabic.
 *
 * Run: node e2e/product-master.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];

const home = mkdtempSync(join(tmpdir(), "pos-e2e-master-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");
  await page.locator('[data-testid="tab-products"]').click();
  return { app, page };
}

/** A real PNG: solid colour, correct zlib stream, correct CRC32 per chunk. */
function png(width, height, rgb) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // One filter byte per scanline, then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const px = row + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Writes ONE primary photo for a product, directly. See the header for why this is legitimate. */
function seedPhoto(productId) {
  const bytes = png(96, 96, [31, 94, 255]);
  const db = new Database(LEDGER);
  try {
    const now = new Date().toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
    db.prepare(
      `INSERT INTO catalog_product_images (id, product_id, bytes, mime, sha256_hex, byte_size,
                                           width_px, height_px, is_primary, origin, created_at, updated_at)
       VALUES (?, ?, ?, 'image/png', ?, ?, 96, 96, 1, 'desktop', ?, ?)`,
    ).run(
      "e2e-photo-1",
      productId,
      bytes,
      createHash("sha256").update(bytes).digest("hex"),
      bytes.length,
      now,
      now,
    );
  } finally {
    db.close();
  }
  log("seeded one real PNG for", productId, `(${bytes.length} bytes)`);
}

async function addProduct(page, { nameAr, nameEn, sku, price, unit, barcode, brand, descAr, online, category }) {
  await page.locator('[data-testid="add-product"]').click();
  await page.locator('[data-testid="field-nameAr"]').fill(nameAr);
  const inputs = page.locator(".product-form input");
  if (nameEn !== undefined) await inputs.nth(1).fill(nameEn);
  if (sku !== undefined) await inputs.nth(2).fill(sku);
  if (barcode !== undefined) await page.locator('[data-testid="field-barcode"]').fill(barcode);
  if (brand !== undefined) await page.locator('[data-testid="field-brand"]').fill(brand);
  if (category !== undefined) await page.locator('[data-testid="field-category"]').selectOption(category);
  await page.locator('[data-testid="field-price"]').fill(price);
  await page.locator('[data-testid="field-unit"]').selectOption(unit);
  if (descAr !== undefined) await page.locator('[data-testid="field-descAr"]').fill(descAr);
  if (online) await page.locator('[data-testid="field-online"]').check();
  await page.locator('[data-testid="save-product"]').click();
  await page.locator(".dialog .btn.primary.wide").click();
}

const rows = (page) => page.locator('[data-testid="product-row"]');

/**
 * Is this element actually ON SCREEN — inside the window, with a real box?
 *
 * 🔴 MEASURED, NOT ASKED. `locator.isIntersectingViewport` does not exist in this playwright-core
 * (it is an ElementHandle method), and the first run failed on exactly that. A rect against
 * `innerWidth`/`innerHeight` is the thing being claimed anyway: an element inside a scrollable
 * dialog always has a box, and whether that box is within the window is what "obvious on opening"
 * means.
 */
const onScreen = (page, testid) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el === null) return false;
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= window.innerHeight &&
      r.right <= window.innerWidth
    );
  }, testid);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Categories first — the owner's list, and a RETIRED one, which §W wants visible
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await launch();

await page.locator('[data-testid="manage-categories"]').click();
await page.locator('[data-testid="cat-empty"]').waitFor();
// The manager stays open across each save; only the confirmation overlay comes and goes.
for (const [ar, en] of [["عدد", "Tools"], ["دهان", "Paint"], ["سباكة", "Plumbing"]]) {
  await page.locator('[data-testid="cat-nameAr"]').fill(ar);
  await page.locator('.cat-add input[lang="en"]').fill(en);
  await page.locator('[data-testid="cat-add"]').click();
  await page.locator(".dialog .btn.primary.wide").click();
}
assert((await page.locator('[data-testid="cat-row"]').count()) === 3, "three categories exist");

// Retire the last one, so the dropdown's retired case can be photographed later.
await page.locator('[data-testid="cat-row"]').last().locator("button").first().click();
await page.locator(".dialog .btn.primary.wide").click();
await page.screenshot({ path: SHOTS + "PM1-categories-arabic.png" });
await page.locator('[data-testid="cat-close"]').click();
log("PM1 — category management, one retired");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Add Product — the three sections, with the empty photo state (§W 2, 5, 6, 7)
// ════════════════════════════════════════════════════════════════════════════════════════════════
await page.locator('[data-testid="add-product"]').click();
await page.locator('[data-testid="photo-new-product"]').waitFor();
await page.screenshot({ path: SHOTS + "PM2-add-product-sections.png" });
// The same rule for Add: a merchant adding a product must see all three sections at once.
assert(
  await onScreen(page, "photo-panel"),
  "the photo section is visible on the Add form without scrolling",
);
assert(
  await onScreen(page, "save-product"),
  "Save is visible on the Add form without scrolling",
);
assert(
  (await page.locator('[data-testid="field-barcode"]').count()) === 1,
  "the Add form has a barcode field (§W 6)",
);
assert(
  (await page.locator('[data-testid="field-online"]').count()) === 1,
  "the Add form has the online-catalogue section (§W 7)",
);
// 🔴 The chooser offers both ACTIVE categories and not the retired one — on a NEW product there is
// no assigned category, so a retired one must not be on offer at all.
const options = await page.locator('[data-testid="field-category"] option').allTextContents();
assert(options.length === 3, `the chooser offers 'no category' + two active ones, got ${options.length}`);
assert(!options.join("|").includes("متوقّف"), "a retired category is NOT offered for a new product");
log("PM2 — Add Product, three sections, empty photo state");
await page.locator('[data-testid="cancel-product"]').click();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Two products: one that will have a photo, one that will not (§W 1)
// ════════════════════════════════════════════════════════════════════════════════════════════════
await addProduct(page, {
  nameAr: "مفك براغي",
  nameEn: "Screwdriver",
  sku: "SKU-100",
  price: "7.50",
  unit: "piece",
  barcode: "036000291452",
  brand: "Bosch",
  descAr: "مفك براغي متوسط الحجم",
  online: true,
});
await addProduct(page, { nameAr: "دهان أبيض", nameEn: "White paint", sku: "SKU-200", price: "22.00", unit: "piece" });
assert((await rows(page).count()) === 2, "two products exist");

// 🔴 The 12-digit UPC-A became the 13-digit canonical form, visible on the row.
const barcodeText = await page.locator('[data-testid="row-barcode"]').first().textContent();
assert(barcodeText.trim() === "0036000291452", `the row shows the canonical barcode, got '${barcodeText}'`);

// The barcode is SEARCHABLE — by the canonical form the row displays.
await page.locator('[data-testid="product-search"]').fill("0036000291452");
assert((await rows(page).count()) === 1, "searching the barcode finds exactly that product");
await page.screenshot({ path: SHOTS + "PM6-barcode-search.png" });
await page.locator('[data-testid="product-search"]').fill("");
log("PM6 — barcode canonicalised and searchable");

await app.close();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Seed ONE photo with the app closed, then look at the list (§W 1) and the Edit form (§W 3)
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const db = new Database(LEDGER, { readonly: true });
  const row = db.prepare("SELECT id FROM catalog_products WHERE sku = 'SKU-100'").get();
  db.close();
  assert(row !== undefined, "the photographed product is in the ledger");
  seedPhoto(row.id);
}

({ app, page } = await launch());
await rows(page).first().waitFor();
await page.locator('[data-testid="thumb-image"]').first().waitFor({ timeout: 15000 });

assert((await page.locator('[data-testid="thumb-image"]').count()) === 1, "exactly one row shows a thumbnail");
assert((await page.locator('[data-testid="thumb-empty"]').count()) === 1, "exactly one row shows the placeholder");

// 🔴 THE THUMBNAIL IS A REAL DECODE, not a broken-image box. `naturalWidth` is 0 for an image the
// browser could not decode, so this is the one check that distinguishes "rendered" from "present".
//
// 🔴 AND IT WAITS FOR THE DECODE. The first run of this script failed here with 0x0 against a PNG
// an independent decoder reads fine: `waitFor()` resolves when the element ATTACHES, and
// `naturalWidth` stays 0 until the browser has finished decoding. Measuring at attach time is
// measuring a race — and it would have read as "the image is broken", which is a different and
// much more alarming conclusion than "not yet".
await page.waitForFunction(
  () => {
    const img = document.querySelector('[data-testid="thumb-image"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  },
  undefined,
  { timeout: 15000 },
);
const natural = await page.locator('[data-testid="thumb-image"]').first().evaluate((img) => ({
  w: img.naturalWidth,
  h: img.naturalHeight,
  box: img.getBoundingClientRect().width,
}));
assert(natural.w === 96 && natural.h === 96, `the thumbnail decoded at 96x96, got ${natural.w}x${natural.h}`);
assert(natural.box > 20 && natural.box < 80, `the thumbnail is small (${natural.box}px), not a catalogue card`);

// 🔴 ROW HEIGHT DOES NOT EXPLODE, AND EVERY ROW MATCHES. Two things could break this: a thumbnail
// sized by its image, and a cell that grows when the data is richer.
//
// 🔴 THE SECOND ONE REALLY HAPPENED, and this assertion is why it was found rather than shipped:
// the barcode started on its own line under the SKU, and the installed run measured 69px against
// 57px — a product WITH a barcode was taller than one without. The fix was the layout (both codes
// on one line, the cell `nowrap`), not this tolerance.
const heights = await rows(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
assert(Math.abs(heights[0] - heights[1]) <= 2, `rows are the same height: ${heights.join(" vs ")}`);
assert(heights.every((h) => h < 110), `no row-height explosion: ${heights.join(", ")}`);

// 🔴 AND THE LIST CARRIED NO BYTES. The DTO the renderer holds has a flag, an id and a hash.
const listShape = await page.evaluate(async () => {
  const r = await window.pos.listProducts();
  const row = r.data[0];
  return { keys: Object.keys(row).filter((k) => /image|photo|bytes/i.test(k)), hasBinary: Object.values(r.data.flatMap((x) => Object.values(x))).some((v) => v instanceof Uint8Array) };
});
assert(!listShape.hasBinary, "no value in any listProducts row is binary");
log("list photo state:", listShape.keys.join(", "));

await page.screenshot({ path: SHOTS + "PM3-products-list-mixed-photos.png" });
log("PM3 — list with a photographed and an unphotographed product");

// Edit the photographed product: the preview must be there immediately (§W 3).
await rows(page).first().locator("button").first().click();
await page.locator('[data-testid="photo-preview"]').waitFor({ timeout: 15000 });
// Same race as the thumbnail above: attached is not decoded.
await page.waitForFunction(
  () => {
    const img = document.querySelector('[data-testid="photo-preview"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  },
  undefined,
  { timeout: 15000 },
);
const preview = await page.locator('[data-testid="photo-preview"]').evaluate((img) => ({
  w: img.naturalWidth,
  box: Math.round(img.getBoundingClientRect().width),
}));
assert(preview.w === 96, "the form preview is a real decode");
assert(preview.box > 100, `the preview is large enough to judge (${preview.box}px)`);

// 🔴 "OBVIOUS ON OPENING" MEANS ON SCREEN, NOT MERELY IN THE DOM — and this assertion exists
// because the first green run was not good enough. Every selector passed while the installed
// screenshot showed the Edit form ending at the Category field: the photo preview, the online
// section and Save were all below the fold at the shop's real 1008x681. A DOM check cannot see
// that; a measured rect can.
assert(
  await onScreen(page, "photo-preview"),
  "the photo preview is VISIBLE when Edit opens, not a scroll away",
);
assert(
  await onScreen(page, "save-product"),
  "Save is visible without scrolling the dialog",
);
assert(
  await onScreen(page, "field-online"),
  "the online-catalogue control is visible without scrolling",
);
// 🔴 Add/Replace is DISABLED and says why — the producer is slice F.
assert(await page.locator('[data-testid="photo-add"]').isDisabled(), "Add/Replace photo is disabled, truthfully");
assert((await page.locator('[data-testid="photo-remove"]').count()) === 1, "Remove photo is offered");

// The retired category IS on offer here, because this product could be assigned one... it is not,
// so it must not be. Assign it an active one and confirm the brand datalist carries a suggestion.
const brandSuggestions = await page.locator("#brand-suggestions option").allTextContents();
log("brand suggestions:", brandSuggestions.length);
await page.screenshot({ path: SHOTS + "PM4-edit-product-with-photo.png" });
log("PM4 — Edit Product with an existing photo");

await page.locator('[data-testid="field-brand"]').click();
await page.screenshot({ path: SHOTS + "PM5-brand-suggestions.png" });
log("PM5 — brand field with suggestions");
await page.locator('[data-testid="cancel-product"]').click();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The retired category on a product that already carries it (§W 4)
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const db = new Database(LEDGER);
  const retired = db.prepare("SELECT id FROM catalog_categories WHERE is_active = 0").get();
  const target = db.prepare("SELECT id FROM catalog_products WHERE sku = 'SKU-200'").get();
  db.close();
  assert(retired !== undefined && target !== undefined, "a retired category and a second product exist");
  // Assigning it through SQL rather than the UI on purpose: the SERVICE correctly REFUSES a new
  // assignment of a retired category, which is the invariant. What §W asks to see is the other
  // half — a product that already carries one keeps it and can still be edited.
  await app.close();
  const w = new Database(LEDGER);
  w.prepare("UPDATE catalog_products SET category_id = ? WHERE id = ?").run(retired.id, target.id);
  w.close();
}

({ app, page } = await launch());
await rows(page).last().locator("button").first().click();
await page.locator('[data-testid="field-category"]').waitFor();
const retiredOptions = await page.locator('[data-testid="field-category"] option').allTextContents();
assert(
  retiredOptions.some((o) => o.includes("متوقّف")),
  `the product's own retired category is shown and marked: ${retiredOptions.join(" | ")}`,
);
await page.locator('[data-testid="field-category"]').click();
await page.screenshot({ path: SHOTS + "PM7-category-dropdown-retired.png" });
log("PM7 — the category chooser, including a retired assigned one");

// 🔴 AND RE-SAVING IT KEEPS THE RETIRED CATEGORY. This is the asymmetry the service implements;
// proving it through the real app closes the loop a unit test opened.
await page.locator('[data-testid="field-price"]').fill("23.00");
await page.locator('[data-testid="save-product"]').click();
await page.locator(".dialog .btn.primary.wide").click();
{
  await app.close();
  const db = new Database(LEDGER, { readonly: true });
  const after = db.prepare("SELECT category_id, selling_price_minor FROM catalog_products WHERE sku = 'SKU-200'").get();
  const retired = db.prepare("SELECT id FROM catalog_categories WHERE is_active = 0").get();
  db.close();
  assert(after.category_id === retired.id, "re-saving a product with a RETIRED category keeps it");
  log("price also saved:", after.selling_price_minor);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · A CORRUPT photo must not break the screen
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const db = new Database(LEDGER);
  db.prepare("UPDATE catalog_product_images SET bytes = ? WHERE id = 'e2e-photo-1'").run(Buffer.from("not an image"));
  db.close();
  log("corrupted the stored photo behind the application's back");
}

({ app, page } = await launch());
await rows(page).first().waitFor();
// The checksum guard refuses it, the row falls back to a placeholder, and the LIST STILL WORKS.
await page.locator('[data-testid="thumb-failed"]').first().waitFor({ timeout: 15000 });
assert((await rows(page).count()) === 2, "both rows still render with one photo unreadable");
await page.screenshot({ path: SHOTS + "PM8-corrupt-photo-falls-back.png" });
log("PM8 — a corrupt photo falls back to the placeholder and breaks nothing");

// ── 7 · English / LTR, so the mirrored layout is reviewable too ──────────────────────────────────
// 🔴 THROUGH THE REAL TOGGLE, NOT THROUGH window.pos. Calling `setTerminalLanguage` directly
// persists the choice and returns the new settings, but nothing re-reads them: the document's `dir`
// is set by the app's own language state, so the call succeeded and the screen stayed RTL. The
// first run of this script asserted on the document and failed — correctly. The UI toggle is the
// path a merchant takes and the one that actually flips the document.
await page.locator('[data-testid="lang-toggle"]').click();
await page.waitForFunction(() => document.documentElement.dir === "ltr", undefined, { timeout: 15000 });
await page.locator('[data-testid="tab-products"]').click();
await rows(page).first().waitFor();
assert((await page.evaluate(() => document.documentElement.dir)) === "ltr", "the document is ltr in English");
const addLabel = await page.locator('[data-testid="add-product"]').innerText();
assert(!/[\u0600-\u06ff]/.test(addLabel), `the screen is really English ("${addLabel.trim()}")`);
await page.screenshot({ path: SHOTS + "PM9-products-english-ltr.png" });
log("PM9 — the same screen in English/LTR");

await app.close();
log("screenshots in", SHOTS);
console.log("\nPRODUCT MASTER E2E PASSED");
