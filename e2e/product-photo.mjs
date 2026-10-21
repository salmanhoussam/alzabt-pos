/**
 * E2E — slice F: a real file on this PC becomes a real product photo, in the INSTALLED app.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE ONLY PLACE THE WHOLE CHAIN RUNS FOR REAL.
 *
 * The unit tests prove the policy against a model codec, because `nativeImage` does not exist
 * under ELECTRON_RUN_AS_NODE. Here the real executable runs the real native picker path, Chromium
 * really decodes the real fixture, the real service writes real bytes into real SQLite, and the
 * real renderer draws what came back. Every link, once, in the thing the shop installs.
 *
 * 🔴 WHAT IS STUBBED, AND WHY THAT IS NOT THE PART THAT MATTERS. One function is replaced:
 * `dialog.showOpenDialogSync`, so the script can choose a file without a human clicking in a
 * native window. `main.ts` looks that up on `dialog` at call time precisely so a test can do this,
 * the same way `pickCatalogFile` has been tested since migration 3. Everything after the dialog —
 * the stat, the read, the sniff, the decode, the resize, the rotation, the encode, the service,
 * the transaction, the audit row, the renderer's data: URL — is the shipped code.
 *
 * 🔴 AND THE RAW-SQL PHOTO SEED IS GONE. `product-master.mjs` had to write one row directly
 * because no producer existed; its header said so, so nobody would read those screenshots as proof
 * that importing a photo worked. It is now proof, and it is here.
 *
 * Selectors are data-testid, never visible text — the terminal's default language is Arabic.
 *
 * Run: node e2e/product-photo.mjs      (CI sets E2E_EXECUTABLE to the installed .exe)
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(APP, "tests", "fixtures", "photos");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];

const home = mkdtempSync(join(tmpdir(), "pos-e2e-photo-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

const log = (...a) => console.log("•", ...a);
let step = 0;
let failures = 0;
const check = (cond, msg) => {
  step += 1;
  if (cond) console.log(`  ✓ ${step} ${msg}`);
  else {
    failures += 1;
    console.log(`  ✗ ${step} ${msg}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
};

// ── the ledger, read directly, with the app closed ─────────────────────────────────────────────

function ledger(fn) {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every stored image row for a product, newest first. Bytes included — this is the proof. */
function photoRows(productId) {
  return ledger((db) =>
    db
      .prepare(
        `SELECT id, mime, sha256_hex, byte_size, width_px, height_px, is_primary, origin, bytes
           FROM catalog_product_images WHERE product_id = ? ORDER BY updated_at DESC, id DESC`,
      )
      .all(productId),
  );
}

function auditEvents(entityId) {
  return ledger((db) =>
    db
      .prepare(`SELECT event_type, entity_type, changed_json FROM audit_events WHERE entity_id = ? ORDER BY seq`)
      .all(entityId),
  );
}

/**
 * The product this script created, found by its SKU.
 *
 * 🔴 NOT `ORDER BY id LIMIT 1`, AND NOT `nth(0)` IN THE UI — both of which were wrong here, for
 * two different reasons. A fresh profile's `catalog_products` is EMPTY: `startupCatalog` serves the
 * fixture catalog from MEMORY when there is no local source and never writes a row, so the first
 * version of this script asserted against `undefined`. And the admin list orders by
 * `(source, CAST(source_key AS INTEGER), source_key)`, not by id, so even with rows present the
 * DB's "first" and the screen's "first" are two different claims that happen to agree.
 *
 * So the script creates its own product and addresses it by SKU, in both places.
 */
const SKU = "PHOTO-001";

function productBySku() {
  return ledger((db) => db.prepare(`SELECT id, name_ar, sku FROM catalog_products WHERE sku = ?`).get(SKU));
}

// ── the app ────────────────────────────────────────────────────────────────────────────────────

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");
  await page.locator('[data-testid="tab-products"]').click();
  return { app, page };
}

/**
 * Points the native picker at one file — or at cancellation.
 *
 * 🔴 `null` IS THE CANCELLATION SHAPE Electron really uses: `showOpenDialogSync` returns
 * `undefined` when the operator dismisses the dialog. Returning `[]` would be a kinder fake, and a
 * kinder fake here would hide whether the product handles a real cancel.
 */
async function aimPicker(app, fixtureName) {
  const path = fixtureName === null ? null : join(FIXTURES, fixtureName);
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => (p === null ? undefined : [p]);
  }, path);
}

/** Aims the native "save as" dialog, for the backup export. */
const saveTo = (app, path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, path);

/** Opens Edit on OUR product's row, found by the SKU the row renders. */
async function openEdit(page) {
  const row = page.locator('[data-testid="product-row"]').filter({ hasText: SKU });
  assert((await row.count()) === 1, `exactly one row is ${SKU}`);
  await row.locator('[data-testid="product-edit"]').click();
  await page.locator('[data-testid="photo-panel"]').waitFor({ state: "visible" });
}

/** Creates the one product this script works on, through the real Add Product form. */
async function createProduct(page) {
  await page.locator('[data-testid="add-product"]').click();
  await page.locator('[data-testid="field-nameAr"]').fill("صنف للصورة");
  const inputs = page.locator(".product-form input");
  await inputs.nth(1).fill("Photo Subject");
  await inputs.nth(2).fill(SKU);
  await page.locator('[data-testid="field-price"]').fill("5.00");
  await page.locator('[data-testid="field-unit"]').selectOption("piece");
  await page.locator('[data-testid="save-product"]').click();
  await page.locator(".dialog .btn.primary.wide").click();
  await page.locator('[data-testid="product-row"]').filter({ hasText: SKU }).first().waitFor();
}

async function closeForm(page) {
  await page.locator('.product-form [data-testid="cancel-product"]').click();
  await page.locator('[data-testid="photo-panel"]').waitFor({ state: "detached" });
}

/** Waits for a real decode, not just an attached <img>. */
async function waitForDecodedPreview(page) {
  await page.locator('[data-testid="photo-preview"]').waitFor({ state: "visible" });
  // 🔴 `naturalWidth` IS 0 UNTIL THE DECODE FINISHES, and waitFor resolves at attach — so reading
  // the dimensions straight after it reports "0x0", which looks like a verdict about the file when
  // it means "not yet". This cost a wrong conclusion once already.
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="photo-preview"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  return page.locator('[data-testid="photo-preview"]').evaluate((img) => ({
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    src: img.src.slice(0, 32),
  }));
}

async function shot(page, name) {
  await page.screenshot({ path: SHOTS + name + ".png" });
  log("screenshot", name);
}

/**
 * The text of the app's ERROR dialog, dismissed afterwards.
 *
 * 🔴 THE FIRST VERSION OF THIS HELPER MEASURED THE WRONG ELEMENT, AND PASSED. It waited for
 * `.overlay .card.dialog` — which the PRODUCT FORM also matches, since the form is
 * `<form class="card dialog product-form">` inside its own overlay. So `.last()` resolved to the
 * form and `waitFor({visible})` succeeded instantly, before the error dialog had rendered at all.
 * The assertions then read the FORM's text: "تعديل صنف · المعلومات الأساسيّة · الاسم بالعربية
 * (مطلوب) …". Both refusal checks passed on it — non-empty, and containing no path — while proving
 * nothing whatsoever about what the owner is shown. It also clicked the form's first button.
 *
 * The error paragraph carries `class="error"`, and nothing else in the app does. Waiting for THAT
 * cannot be satisfied by the form, so the wait is now the assertion.
 */
async function readError(page) {
  const paragraph = page.locator(".overlay .card.dialog p.error");
  await paragraph.waitFor({ state: "visible", timeout: 15000 });
  const text = (await paragraph.innerText()).trim();
  // Dismiss via the card that actually holds the error, not whichever dialog happens to be last.
  await page.locator(".overlay .card.dialog", { has: page.locator("p.error") }).locator("button").first().click();
  await paragraph.waitFor({ state: "detached", timeout: 15000 });
  return text;
}

/** The text of a NOTICE dialog (no error class), dismissed afterwards. */
async function readNotice(page) {
  const card = page.locator(".overlay .card.dialog").filter({ hasNot: page.locator("form") }).last();
  await card.waitFor({ state: "visible", timeout: 15000 });
  const text = (await card.innerText()).trim();
  await card.locator("button").first().click();
  return text;
}

// ══ 1. ADD ════════════════════════════════════════════════════════════════════════════════════

let { app, page } = await launch();
await createProduct(page);
const product = productBySku();
assert(product, `the product ${SKU} was created and is in the ledger`);
log("product under test:", product.id, product.name_ar, product.sku);

check(photoRows(product.id).length === 0, "the product starts with no stored photo");

await openEdit(page);
check(
  (await page.locator('[data-testid="photo-empty"]').count()) === 1,
  "a product with no photo shows the deliberate empty state",
);
check(
  (await page.locator('[data-testid="photo-add"]').isEnabled()) === true,
  "🔴 Add photo is ENABLED — it was disabled for the whole of slice E",
);
await shot(page, "F-A-add-no-image");

await aimPicker(app, "shelf.jpg");
await page.locator('[data-testid="photo-add"]').click();
const added = await waitForDecodedPreview(page);
check(added.naturalWidth > 0 && added.naturalHeight > 0, `the preview really decoded (${added.naturalWidth}x${added.naturalHeight})`);
check(added.src.startsWith("data:image/jpeg"), `the preview is a data: URL of a JPEG (${added.src})`);
await shot(page, "F-B-after-real-photo-added");

// The source is 2400x1800; the policy reduces the long edge to 1600 and stores a JPEG.
check(added.naturalWidth === 1600 && added.naturalHeight === 1200, `normalized to 1600x1200 (got ${added.naturalWidth}x${added.naturalHeight})`);

await closeForm(page);
await page.locator('[data-testid="thumb-image"]').first().waitFor({ state: "visible" });
await shot(page, "F-C-products-list-real-thumbnail");

// ══ R3. THE SAME PHOTO, WHERE THE CASHIER ACTUALLY SELLS ═════════════════════════════════════
//
// 🔴 MEASURED, NOT ASSERTED FROM THE DOM ALONE. "A thumbnail exists" is cheap and nearly
// meaningless: the questions are whether the picture beside a product is THAT product's, whether
// touching it sells something by accident, and whether a cashier who may view it is thereby able
// to change it. Each is asked here as the shop would ask it.
{
  await page.locator('[data-testid="tab-sell"]').click();
  await page.locator('[data-testid="sell-thumb"], [data-testid="sell-thumb-empty"]').first().waitFor();

  // A · BOTH STATES ON ONE SCREEN. The photographed product carries an image; the others carry the
  // placeholder — which is what makes the thumbnail informative rather than decorative.
  const withPhoto = await page.locator('[data-testid="sell-thumb"]').count();
  const without = await page.locator('[data-testid="sell-thumb-empty"]').count();
  check(withPhoto === 1, `exactly one Sell card shows a real photo (got ${withPhoto})`);
  check(without >= 1, `and at least one shows the placeholder (got ${without})`);

  // 🔴 THE RIGHT PRODUCT. The thumbnail carries the product id it belongs to, and the one showing
  // a photo must be the product that was photographed — not whichever card sorted first.
  const owner = await page.locator('[data-testid="sell-thumb"]').first().getAttribute("data-product");
  check(owner === product.id, `the photo sits on the product that owns it (${owner} vs ${product.id})`);
  await shot(page, "R3-A-sell-thumbnails");

  // 🔴 AND IT STAYS WITH IT THROUGH A SEARCH. A cache keyed by position rather than identity shows
  // product B's picture on product A the moment the list is filtered; this is that question.
  await page.locator('[data-testid="product-search"]').fill(SKU);
  await page.waitForFunction(() => document.querySelectorAll("button.product").length === 1);
  const filtered = await page.locator('[data-testid="sell-thumb"]').first().getAttribute("data-product");
  check(filtered === product.id, `after filtering, the photo still belongs to ${product.id} (got ${filtered})`);
  await page.locator('[data-testid="product-search"]').fill("");
  await page.waitForFunction(() => document.querySelectorAll("button.product").length > 1);

  // B · THE PREVIEW OPENS, AND THE CART DOES NOT MOVE. Both halves of the contract in one act.
  const cartBefore = await page.locator('[data-testid="cart"] .line').count();
  await page.locator('[data-testid="sell-thumb"]').first().click();
  await page.locator('[data-testid="sell-photo-preview"]').waitFor({ state: "visible" });
  const previewed = await page.locator('[data-testid="sell-preview-image"]').evaluate((img) => ({
    w: img.naturalWidth,
    h: img.naturalHeight,
    onScreen: img.getBoundingClientRect().width > 100,
  }));
  check(previewed.w === 1600 && previewed.h === 1200, `the preview shows the real stored photo (${previewed.w}x${previewed.h})`);
  check(previewed.onScreen, "and it is drawn large enough to judge the product by");
  const cartAfter = await page.locator('[data-testid="cart"] .line').count();
  check(cartAfter === cartBefore, `🔴 opening the photo added NOTHING to the cart (${cartBefore} -> ${cartAfter})`);
  await shot(page, "R3-B-sell-photo-preview");

  // It closes, by its own button and by Escape, and selling carries on.
  await page.locator('[data-testid="sell-photo-close"]').click();
  await page.locator('[data-testid="sell-photo-preview"]').waitFor({ state: "detached" });
  await page.locator('[data-testid="sell-thumb"]').first().click();
  await page.locator('[data-testid="sell-photo-preview"]').waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="sell-photo-preview"]').waitFor({ state: "detached" });

  // 🔴 THE ORDINARY ACT STILL WORKS. A photo that broke adding to the cart would be a worse screen
  // than one with no photos at all.
  await page.locator("button.product").first().click();
  const sold = await page.locator('[data-testid="cart"] .line').count();
  check(sold === cartBefore + 1, `the card itself still adds to the cart (${cartBefore} -> ${sold})`);
  await page.locator('[data-testid="clear-cart"]').click();
  await page.locator('[data-testid="clear-confirm"], .dialog .btn.primary.wide').first().click();
  await page.locator('[data-testid="tab-products"]').click();
  await page.locator('[data-testid="product-row"]').first().waitFor();
}

await app.close();

// ── the stored row, read with the app closed ──────────────────────────────────────────────────
let rows = photoRows(product.id);
check(rows.length === 1, `exactly one image row after ADD (got ${rows.length})`);
const first = rows[0];
check(first.mime === "image/jpeg", `stored as image/jpeg (got ${first.mime})`);
check(first.width_px === 1600 && first.height_px === 1200, `stored dimensions 1600x1200 (got ${first.width_px}x${first.height_px})`);
check(Number(first.is_primary) === 1, "stored as the primary photo");
check(first.origin === "desktop", `origin recorded as desktop (got ${first.origin})`);
check(
  createHash("sha256").update(first.bytes).digest("hex") === first.sha256_hex,
  "the stored checksum is the checksum of the stored bytes",
);
check(Number(first.byte_size) === first.bytes.length, "byte_size matches the real BLOB length");

const sourceBytes = readFileSync(join(FIXTURES, "shelf.jpg"));
check(
  !Buffer.from(first.bytes).equals(sourceBytes),
  "🔴 the stored bytes are NOT the source file — the photo was normalized, not copied through",
);
check(
  first.bytes.length < sourceBytes.length,
  `normalized smaller than the source (${first.bytes.length} < ${sourceBytes.length})`,
);
check(first.bytes[0] === 0xff && first.bytes[1] === 0xd8, "the stored bytes really begin with a JPEG marker");

// ── the audit, and what must NOT be in it ─────────────────────────────────────────────────────
let events = auditEvents(product.id).filter((e) => e.entity_type === "product_image");
check(events.length === 1 && events[0].event_type === "PRODUCT_IMAGE_SET", `one PRODUCT_IMAGE_SET (got ${JSON.stringify(events.map((e) => e.event_type))})`);
const auditText = JSON.stringify(auditEvents(product.id));
check(!/[A-Za-z]:\\\\|\/home\/|Users|Pictures|shelf\.jpg|\.jpg/i.test(auditText), "🔴 no filesystem path and no source file name anywhere in the audit");
check(!/base64|bytes"\s*:\s*"/i.test(auditText), "🔴 no image bytes and no base64 in the audit");

// ══ 2. RESTART — does it survive? ═════════════════════════════════════════════════════════════

({ app, page } = await launch());
await page.locator('[data-testid="thumb-image"]').first().waitFor({ state: "visible" });
check(true, "🔴 after closing and reopening the app, the thumbnail is still in the Products list");
await openEdit(page);
const afterRestart = await waitForDecodedPreview(page);
check(
  afterRestart.naturalWidth === 1600 && afterRestart.naturalHeight === 1200,
  `the photo survived a restart intact (${afterRestart.naturalWidth}x${afterRestart.naturalHeight})`,
);
await shot(page, "F-D-edit-with-real-photo-after-restart");

// ══ 3. CANCEL must preserve the existing photo ════════════════════════════════════════════════

await aimPicker(app, null);
await page.locator('[data-testid="photo-add"]').click();
// Nothing should change, and no dialog should appear. Give the app a moment to do the wrong thing.
await page.waitForTimeout(400);
check((await page.locator('[data-testid="photo-preview"]').count()) === 1, "a cancelled picker leaves the preview in place");
const cancelled = photoRows(product.id);
check(cancelled.length === 1 && cancelled[0].sha256_hex === first.sha256_hex, "a cancelled picker changed no stored bytes");
check(
  auditEvents(product.id).filter((e) => e.entity_type === "product_image").length === 1,
  "🔴 a cancelled picker emitted NO audit event",
);

// ══ 4. REFUSALS ═══════════════════════════════════════════════════════════════════════════════

// 🔴 EACH REFUSAL IS CHECKED AGAINST ITS OWN EXPECTED SENTENCE, not one loose regex. My first
// attempt asserted /JPEG|PNG|HEIC/ for both — which the WEBP message satisfies and the corrupt-file
// message ("That file is not a readable image") does not. A single pattern covering two different
// refusals is either too narrow for one of them or too loose to mean anything.
for (const [fixture, what, expected] of [
  ["sample.webp", "a real WEBP (nativeImage cannot decode one)", /Choose a JPEG or PNG image.*HEIC/i],
  ["corrupt.jpg", "a file with a JPEG magic that is not an image", /not a readable image/i],
]) {
  await aimPicker(app, fixture);
  await page.locator('[data-testid="photo-add"]').click();
  const text = await readError(page);
  check(text.length > 0, `${what}: the owner is told something — "${text.replace(/\s+/g, " ").slice(0, 90)}"`);
  // 🔴 THE MESSAGE MUST BE THIS REFUSAL, not whatever dialog was on screen. The form's own text
  // cannot satisfy this, which is exactly what the first version of these checks failed to require.
  check(expected.test(text), `${what}: and it is THIS refusal, by its own words`);
  check(
    !/ENOENT|Error:|nativeImage|undefined|[A-Za-z]:\\\\|الاسم بالعربية/.test(text),
    `${what}: no stack, no path, no internal name — and not the form's own labels`,
  );
  const unchanged = photoRows(product.id);
  check(
    unchanged.length === 1 && unchanged[0].sha256_hex === first.sha256_hex,
    `${what}: nothing was written to the ledger`,
  );
  check(
    auditEvents(product.id).filter((e) => e.entity_type === "product_image").length === 1,
    `${what}: no audit event was emitted`,
  );
}
// The form is still usable after a refusal, and still shows the old photo.
await page.locator('[data-testid="photo-panel"]').waitFor({ state: "visible" });
check((await page.locator('[data-testid="photo-preview"]').count()) === 1, "after two refusals the existing photo is still shown");

// ══ 5. REPLACE — with the portrait phone photo, which must come out UPRIGHT ════════════════════

await aimPicker(app, "portrait-exif.jpg");
await page.locator('[data-testid="photo-add"]').click();
await page.waitForFunction(
  (oldW) => {
    const img = document.querySelector('[data-testid="photo-preview"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 && img.naturalWidth !== oldW;
  },
  1600,
);
const replaced = await waitForDecodedPreview(page);
check(
  replaced.naturalHeight > replaced.naturalWidth,
  `🔴 a portrait phone photo is stored UPRIGHT, not sideways (${replaced.naturalWidth}x${replaced.naturalHeight}) — the fixture's own bytes are landscape with EXIF Orientation=6`,
);
check(replaced.naturalWidth === 1200 && replaced.naturalHeight === 1600, `rotated and normalized to 1200x1600 (got ${replaced.naturalWidth}x${replaced.naturalHeight})`);
await shot(page, "F-E-after-replacement-portrait-upright");

rows = photoRows(product.id);
check(rows.length === 1, `🔴 still exactly one image row after REPLACE — the old one is gone, not accumulated (got ${rows.length})`);
check(rows[0].sha256_hex !== first.sha256_hex, "🔴 imageVersion (the stored SHA-256) CHANGED, so no cached thumbnail can be reused");
check(rows[0].height_px > rows[0].width_px, `the stored row is portrait too (${rows[0].width_px}x${rows[0].height_px})`);
check(
  createHash("sha256").update(rows[0].bytes).digest("hex") === rows[0].sha256_hex,
  "the replacement's checksum is the checksum of its bytes",
);
events = auditEvents(product.id).filter((e) => e.entity_type === "product_image");
check(
  events.length === 2 && events[1].event_type === "PRODUCT_IMAGE_REPLACED",
  `a PRODUCT_IMAGE_REPLACED followed the SET (got ${JSON.stringify(events.map((e) => e.event_type))})`,
);
check(
  /sha256_hex/.test(events[1].changed_json) && !/bytes|base64/.test(events[1].changed_json),
  "the replacement's diff names the checksum and carries no bytes",
);

// ══ 6. a TRANSPARENT PNG stays a PNG ══════════════════════════════════════════════════════════

await aimPicker(app, "logo-alpha.png");
await page.locator('[data-testid="photo-add"]').click();
await page.waitForFunction(() => {
  const img = document.querySelector('[data-testid="photo-preview"]');
  return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 512;
});
rows = photoRows(product.id);
check(rows[0].mime === "image/png", `🔴 an image WITH transparency is stored as a PNG (got ${rows[0].mime})`);
check(rows[0].bytes[0] === 0x89 && rows[0].bytes[1] === 0x50, "its stored bytes really begin with a PNG signature");

// and a graphic WITHOUT transparency does not get the same treatment
await aimPicker(app, "table-noalpha.png");
await page.locator('[data-testid="photo-add"]').click();
await page.waitForFunction(() => {
  const img = document.querySelector('[data-testid="photo-preview"]');
  return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1400;
});
rows = photoRows(product.id);
check(
  rows[0].mime === "image/jpeg",
  `🔴 a PNG WITHOUT transparency is stored as a JPEG, because it is smaller that way (got ${rows[0].mime})`,
);

// ══ 7. an OVERSIZED camera frame is accepted and shrunk, not refused ══════════════════════════

await aimPicker(app, "oversized.jpg");
await page.locator('[data-testid="photo-add"]').click();
await page.waitForFunction(() => {
  const img = document.querySelector('[data-testid="photo-preview"]');
  return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1600 && img.naturalHeight === 1067;
});
rows = photoRows(product.id);
check(rows[0].width_px === 1600 && rows[0].height_px === 1067, `a 9000x6000 source became 1600x1067 (got ${rows[0].width_px}x${rows[0].height_px})`);
check(rows[0].byte_size < 1_200_000, `the normalized result is within the output cap (${rows[0].byte_size} bytes)`);

// ══ 8. BACKUP, then RESTORE — and the RENDERER must display the restored photo ════════════════
//
// 🔴 THE ONE PART OF §18 A UNIT TEST CANNOT REACH. `tests/persistence/productPhotoDurability.test.ts`
// proves the bytes and the checksum survive a snapshot and come back through the service — which is
// the hard half. What it cannot prove is the last link: that a RESTORED ledger produces a photo the
// renderer actually draws. There is no in-app restore (README calls it a support procedure), so the
// restore here is what support really does: the snapshot file becomes the ledger.

const BACKUP = join(home, "exported-backup.sqlite");
const beforeBackup = photoRows(product.id)[0];
await closeForm(page);
await saveTo(app, BACKUP);
await page.locator('[data-testid="tab-tools"]').click();
await page.locator('[data-testid="export-backup"]').click();
await readNotice(page);
await app.close();

{
  const copy = new Database(BACKUP, { readonly: true, fileMustExist: true });
  const row = copy
    .prepare("SELECT sha256_hex, byte_size, width_px, height_px, mime, bytes FROM catalog_product_images WHERE product_id = ?")
    .get(product.id);
  const integrity = copy.pragma("integrity_check", { simple: true });
  copy.close();
  check(integrity === "ok", `the exported backup passes integrity_check (${integrity})`);
  check(row !== undefined, "the exported backup carries the image row");
  check(row.sha256_hex === beforeBackup.sha256_hex, "the backup's checksum is the live one");
  check(
    createHash("sha256").update(row.bytes).digest("hex") === row.sha256_hex,
    "🔴 and the BYTES inside the backup really hash to it — a row count could not have told us this",
  );
}

// The support procedure: the snapshot becomes the ledger. Journals go with it, or a stale WAL page
// could survive into the restored database.
for (const suffix of ["-wal", "-shm"]) rmSync(LEDGER + suffix, { force: true });
copyFileSync(BACKUP, LEDGER);

({ app, page } = await launch());
await page.locator('[data-testid="thumb-image"]').first().waitFor({ state: "visible", timeout: 15000 });
check(true, "the restored ledger's product shows a thumbnail in the list");
await openEdit(page);
const restored = await waitForDecodedPreview(page);
check(
  restored.naturalWidth > 0 && restored.naturalHeight > 0,
  `🔴 THE RENDERER DISPLAYS THE RESTORED PHOTO — a real decode, ${restored.naturalWidth}x${restored.naturalHeight}`,
);
check(
  restored.naturalWidth === beforeBackup.width_px && restored.naturalHeight === beforeBackup.height_px,
  `the restored photo has the dimensions it was stored with (${beforeBackup.width_px}x${beforeBackup.height_px})`,
);
check(
  photoRows(product.id)[0].sha256_hex === beforeBackup.sha256_hex,
  "the restored row's checksum is unchanged end to end",
);
await shot(page, "F-I-restored-from-backup");

// ══ 9. ENGLISH, then back to Arabic ═══════════════════════════════════════════════════════════

await closeForm(page);
// One toggle in the header, not a pair of buttons — and it flips, so the second press returns.
await page.locator('[data-testid="lang-toggle"]').click();
await page.locator('[data-testid="thumb-image"]').first().waitFor({ state: "visible" });
await shot(page, "F-G-products-english");
await openEdit(page);
await waitForDecodedPreview(page);
await shot(page, "F-G2-edit-english");
await closeForm(page);
await page.locator('[data-testid="lang-toggle"]').click();
await openEdit(page);
await waitForDecodedPreview(page);
await shot(page, "F-H-edit-arabic");

// ══ 10. REMOVE, and the placeholder ═══════════════════════════════════════════════════════════

await page.locator('[data-testid="photo-remove"]').click();
await page.locator('[data-testid="photo-empty"]').waitFor({ state: "visible" });
check((await page.locator('[data-testid="photo-preview"]').count()) === 0, "after REMOVE no photo is served");
await shot(page, "F-F-after-removal-placeholder");
await closeForm(page);
await app.close();

check(photoRows(product.id).length === 0, "🔴 REMOVE deleted the row — there is no orphan BLOB left behind");
events = auditEvents(product.id).filter((e) => e.entity_type === "product_image");
check(
  events[events.length - 1].event_type === "PRODUCT_IMAGE_REMOVED",
  `the last image event is PRODUCT_IMAGE_REMOVED (got ${events[events.length - 1].event_type})`,
);

// ══ 11. the removal survives a restart too ═══════════════════════════════════════════════════

({ app, page } = await launch());
await page.locator('[data-testid="product-row"]').first().waitFor({ state: "visible" });
check(
  (await page
    .locator('[data-testid="product-row"]')
    .filter({ hasText: SKU })
    .locator('[data-testid="thumb-image"]')
    .count()) === 0,
  "🔴 after a restart the removed photo is still gone — no stale thumbnail returns",
);
await openEdit(page);
check((await page.locator('[data-testid="photo-empty"]').count()) === 1, "the empty state is what a restarted app shows");
await app.close();

console.log("");
if (failures > 0) {
  console.log("CONCLUSION: failure");
  console.log(`steps passed: ${step - failures}`);
  console.log(`FAILED: ${failures} product-photo check(s)`);
  process.exit(1);
}
console.log("CONCLUSION: success");
console.log(`steps passed: ${step}`);
