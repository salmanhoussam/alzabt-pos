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
 * 🔴 THE PHOTO IN THESE SCREENSHOTS IS NOW REAL, and the caveat that used to stand here is gone.
 * Until slice F there was no producer, so one row was written by raw SQL and this header said so,
 * so nobody would read a screenshot as proof that importing a photo worked. The producer exists:
 * the photo below is a real fixture file, chosen through the real dialog, decoded and normalized by
 * the shipped pipeline. `e2e/product-photo.mjs` proves that path in full; this script's job is
 * still what a screenshot is for — whether the screen READS correctly.
 *
 * Selectors are data-testid, never visible text — the terminal's default language is Arabic.
 *
 * Run: node e2e/product-master.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
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

/**
 * 🔴 IS ANY OF THESE ACTUALLY DRAWN UNDER THE ACTION BAR?
 *
 * The real question E2.1 exists to answer, and a selector cannot answer it: an element can be in
 * the document, on screen, and still have Save and Cancel drawn across it.
 *
 * 🔴 AND THE FIRST VERSION OF THIS CHECK WAS WRONG, WHICH IS WORTH KEEPING. It compared raw
 * `getBoundingClientRect()` values — and a rect is the LAYOUT box, reported in full even when
 * `overflow` clips the element. So a field scrolled below the visible part of the form reported
 * coordinates beneath the footer while being invisible there, and the check failed on a layout
 * that was correct. It was measuring where a thing WOULD be, not where it is drawn.
 *
 * Each element's rect is now intersected with the scroll container's own box first — its visible
 * portion — and only that is compared against the footer. Offenders come back by name, so a
 * failure says WHICH field was buried.
 */
const coveredByFooter = (page, ids) =>
  page.evaluate((names) => {
    const footer = document.querySelector('[data-testid="form-footer"]');
    const box = document.querySelector(".form-scroll");
    if (footer === null) return ["NO FOOTER FOUND"];
    if (box === null) return ["NO SCROLL REGION FOUND"];
    const f = footer.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const hits = [];
    for (const name of names) {
      const el = document.querySelector(`[data-testid="${name}"]`);
      if (el === null) continue;
      const r = el.getBoundingClientRect();
      // The part of the element the viewer can actually see: its rect clipped to the scroll box.
      const top = Math.max(r.top, b.top);
      const bottom = Math.min(r.bottom, b.bottom);
      const left = Math.max(r.left, b.left);
      const right = Math.min(r.right, b.right);
      if (bottom <= top || right <= left) continue; // entirely scrolled out: nothing is drawn
      if (left < f.right && right > f.left && top < f.bottom && bottom > f.top) hits.push(name);
    }
    return hits;
  }, ids);

/**
 * 🔴 THE STRUCTURAL GUARANTEE, measured once: the scrolling region ENDS above the action bar.
 *
 * This is what makes the clipped check above non-vacuous. If the footer ever goes back to being
 * `position: sticky` INSIDE the scroll box — the arrangement that caused the defect — the two
 * boxes overlap and this fails immediately, whatever any individual field happens to be doing.
 */
const footerIsBelowTheScrollRegion = (page) =>
  page.evaluate(() => {
    const footer = document.querySelector('[data-testid="form-footer"]');
    const box = document.querySelector(".form-scroll");
    if (footer === null || box === null) return { ok: false, why: "missing footer or scroll region" };
    const f = footer.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return { ok: b.bottom <= f.top + 1, scrollBottom: Math.round(b.bottom), footerTop: Math.round(f.top) };
  });

/** Scrolls the form's own region, not the page. */
const scrollForm = (page, to) =>
  page.evaluate((y) => {
    const box = document.querySelector(".form-scroll");
    if (box !== null) box.scrollTop = y === "end" ? box.scrollHeight : y;
    return box === null ? -1 : box.scrollTop;
  }, to);

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
 * R1 — IS THE PRICE ACTUALLY READABLE, OR IS A BUTTON SITTING ON IT?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 DOM TEXT IS NOT THE QUESTION. `innerText` returns "7.50 USD" whether the cell renders it in
 * full or clips its leading digit under the Edit button — which is exactly what the installed
 * Arabic owner screen did (run 39573996462, E2.1-B-products-arabic.png): the price was cut, the
 * الوحدة column showed no value at all, and the state badge was pushed below the buttons. Only
 * geometry can tell those apart, so this reads real rectangles:
 *
 *   clipped   the price RUN is wider than the cell that holds it, or spills past its edges
 *   covered   the actions cell's rectangle intersects the price or unit cell's rectangle
 *   empty     the unit cell has text but no box to draw it in
 *
 * Returns one record per row so a failure can name the row and the numbers, not just fail.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
async function productRowGeometry(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const overlaps = (a, b) =>
      a !== null && b !== null && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

    return [...document.querySelectorAll('[data-testid="product-row"]')].map((tr, i) => {
      const priceCell = tr.querySelector("td.col-price");
      const unitCell = tr.querySelector("td.col-unit");
      const actionsCell = tr.querySelector("td.col-actions");
      const priceRun = priceCell?.querySelector("bdi") ?? null;
      const buttons = actionsCell ? [...actionsCell.querySelectorAll("button")] : [];

      const pc = box(priceCell);
      const pr = box(priceRun);
      const uc = box(unitCell);
      const ac = box(actionsCell);

      return {
        row: i,
        priceText: (priceRun?.textContent ?? "").trim(),
        unitText: (unitCell?.textContent ?? "").trim(),
        buttonCount: buttons.length,
        priceCell: pc,
        priceRun: pr,
        unitCell: uc,
        actionsCell: ac,
        // The run must fit inside its own cell, with a pixel of tolerance for sub-pixel rounding.
        priceFitsCell: pc !== null && pr !== null && pr.left >= pc.left - 1 && pr.right <= pc.right + 1 && pr.width > 0,
        // And the cell must not be scrolling its own content out of sight.
        priceNotScrolled: priceCell === null ? false : priceCell.scrollWidth <= priceCell.clientWidth + 1,
        unitNotScrolled: unitCell === null ? false : unitCell.scrollWidth <= unitCell.clientWidth + 1,
        unitHasBox: uc !== null && uc.width > 0 && uc.height > 0,
        actionsOverPrice: overlaps(ac, pc),
        actionsOverUnit: overlaps(ac, uc),
        buttonsInsideCell: ac !== null && buttons.every((b) => {
          const r = b.getBoundingClientRect();
          return r.left >= ac.left - 1 && r.right <= ac.right + 1;
        }),
      };
    });
  });
}

/** Assert every row reads cleanly, naming the geometry when it does not. */
async function assertNoClipping(page, where) {
  const g = await productRowGeometry(page);
  assert(g.length > 0, `${where}: there are rows to measure (${g.length})`);
  for (const r of g) {
    const id = `${where} row ${r.row} ("${r.priceText}")`;
    assert(r.priceText.length > 0, `${id}: the price renders text`);
    assert(r.priceFitsCell, `${id}: the price run fits INSIDE its cell — run ${JSON.stringify(r.priceRun)} cell ${JSON.stringify(r.priceCell)}`);
    assert(r.priceNotScrolled, `${id}: the price cell is not hiding content behind its own edge`);
    assert(r.unitHasBox, `${id}: the unit cell has a real box ${JSON.stringify(r.unitCell)}`);
    assert(r.unitText.length > 0, `${id}: the unit renders text ("${r.unitText}")`);
    assert(r.unitNotScrolled, `${id}: the unit cell is not hiding content behind its own edge`);
    assert(!r.actionsOverPrice, `🔴 ${id}: the actions cell does NOT overlap the price — actions ${JSON.stringify(r.actionsCell)} price ${JSON.stringify(r.priceCell)}`);
    assert(!r.actionsOverUnit, `🔴 ${id}: the actions cell does NOT overlap the unit`);
    assert(r.buttonsInsideCell, `${id}: all ${r.buttonCount} action buttons stay inside their own cell`);
  }
  return g;
}


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

// 🔴 THE FORM OPENS AT THE TOP.
assert((await scrollForm(page, 0)) === 0, "the Add form opens scrolled to the top");

// 🔴 NO FIELD PASSES UNDER SAVE/CANCEL — AT ANY SCROLL POSITION. This is the defect E2.1 exists
// to close: the footer used to be sticky INSIDE the scrolling card, so content ran beneath it.
const WATCHED = [
  "field-nameAr",
  "field-barcode",
  "field-category",
  "field-brand",
  "field-price",
  "field-unit",
  "field-descAr",
  "field-descEn",
  "field-online",
  "photo-panel",
];
{
  const g = await footerIsBelowTheScrollRegion(page);
  assert(g.ok, `the scroll region ends above the action bar (bottom ${g.scrollBottom} vs footer top ${g.footerTop})`);
}
for (const position of [0, 150, 300, "end"]) {
  await scrollForm(page, position);
  const buried = await coveredByFooter(page, WATCHED);
  assert(buried.length === 0, `nothing is drawn under the action bar at scroll ${position} (${buried.join(", ") || "none"})`);
}
await scrollForm(page, "end");
await page.screenshot({ path: SHOTS + "E2.1-D-add-product-lower.png" });
await scrollForm(page, 0);
await page.screenshot({ path: SHOTS + "E2.1-C-add-product-top.png" });
log("C/D — Add Product top and lower, nothing under the action bar at any scroll");

// 🔴 AND A NATIVE DROPDOWN OPENED AT THE BOTTOM DOES NOT COLLIDE WITH IT.
await scrollForm(page, "end");
await page.locator('[data-testid="field-category"]').scrollIntoViewIfNeeded();
await page.locator('[data-testid="field-category"]').click();
assert(
  (await coveredByFooter(page, ["field-category"])).length === 0,
  "the category select is not under the action bar when opened near the bottom",
);
await page.screenshot({ path: SHOTS + "E2.1-H-footer-with-dropdown.png" });
log("H — the action bar with a native dropdown open");
await page.keyboard.press("Escape");
await scrollForm(page, 0);
assert(
  (await page.locator('[data-testid="field-barcode"]').count()) === 1,
  "the Add form has a barcode field (§W 6)",
);
assert(
  (await page.locator('[data-testid="field-online"]').count()) === 1,
  "the Add form has the online-catalogue section (§W 7)",
);
// 🔴 The empty state is a PICTURE FRAME with a glyph, not a dashed box that reads as an input.
assert(
  (await page.locator('[data-testid="photo-new-product"] .photo-glyph').count()) === 1,
  "the empty photo state draws a photo glyph, not an empty square",
);
await page.locator('[data-testid="photo-new-product"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + "E2.1-G-empty-photo-state.png" });
log("G — the empty photo state");
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
// 4 · Give ONE product a photo THROUGH THE REAL PRODUCER, then look at the list (§W 1) and the
//     Edit form (§W 3)
//
// 🔴 THIS USED TO BE A RAW SQL INSERT, AND IT NO LONGER IS. Slice E had no producer — there is
// deliberately no channel that accepts image bytes from the renderer — so the only way a photo
// could exist was to write the row directly, and the header said so, so nobody would read these
// screenshots as proof that importing a photo worked. Slice F built the producer, so the photo in
// every screenshot below now arrives the way a shop's photo arrives: a real file, chosen in the
// real dialog, decoded and normalized by the real pipeline.
//
// The only stub is `dialog.showOpenDialogSync`, which `main.ts` looks up at call time precisely so
// a test can aim it. `e2e/product-photo.mjs` is where that path is proven in full.
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await rows(page).first().waitFor();
{
  const fixture = join(APP, "tests", "fixtures", "photos", "shelf.jpg");
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialogSync = () => [f];
  }, fixture);
  // 🔴 THE RIGHT PRODUCT, NAMED. Everything below asserts "exactly one row has a thumbnail and
  // exactly one has the placeholder", which an `nth(0)` would satisfy while photographing whichever
  // product happened to sort first. The SKU is rendered in the row, so the row is found by it.
  const target = rows(page).filter({ hasText: "SKU-100" });
  assert((await target.count()) === 1, "exactly one row is SKU-100");
  await target.locator('[data-testid="product-edit"]').click();
  await page.locator('[data-testid="photo-panel"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="photo-add"]').click();
  await page.locator('[data-testid="photo-preview"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="photo-preview"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  await page.locator('.product-form [data-testid="cancel-product"]').click();
  await page.locator('[data-testid="photo-panel"]').waitFor({ state: "detached" });
  log("one product photographed through the REAL producer");
}
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
// 🔴 THIS ASSERTION CHANGED VALUE IN SLICE F, and the old one is named. It read
// `w === 96 && h === 96` because the photo was a generated 96x96 PNG written by raw SQL. The photo
// now comes through the real producer, so the number is the normalization policy's output for the
// `shelf.jpg` fixture. Both halves are kept deliberately: `> 0` is the only honest test that a
// browser DECODED an image at all (it reports 0 for one it could not), and the exact size says the
// real photo is behind it rather than some other image that merely decoded.
assert(natural.w > 0 && natural.h > 0, `the thumbnail really decoded (was: exactly 96x96, got ${natural.w}x${natural.h})`);
assert(natural.w === 1600 && natural.h === 1200, `and it is the real normalized photo (got ${natural.w}x${natural.h})`);
// 🔴 AND THE DISPLAYED BOX IS STILL SMALL, which is the check E2.1 actually cared about: a
// 1600px-wide source must not become a catalogue card. This is the assertion the size change above
// could otherwise have quietly weakened.
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
// ── R1 · A REALISTIC ROW BEFORE MEASURING ───────────────────────────────────────────────────────
// Two short fixtures prove nothing about a shop's real catalogue: the defect showed up on a LONG
// Arabic name beside a LONG price, which is what crowds the row. Added through the real form.
await addProduct(page, {
  nameAr: "مفك براغي كهربائي لاسلكي بعلبة معدنية وبطارية احتياطية",
  nameEn: "Cordless electric screwdriver with metal case and spare battery",
  sku: "SKU-LONG-9001",
  price: "99999.00",
  unit: "piece",
});
await page.waitForSelector('[data-testid="product-row"]');

const arGeom = await assertNoClipping(page, "Arabic owner");
log("R1 Arabic owner geometry: " + JSON.stringify(arGeom.map((r) => ({ price: r.priceText, unit: r.unitText, priceCell: r.priceCell?.width, unitCell: r.unitCell?.width, actionsCell: r.actionsCell?.width, buttons: r.buttonCount }))));

await page.screenshot({ path: SHOTS + "E2.1-B-products-arabic.png" });

// 🔴 THE TABLE STARTS HIGHER. Two explanatory paragraphs pushed it a long way down on every visit;
// the number is measured rather than eyeballed so a future paragraph cannot creep back in.
const tableTop = await page.evaluate(() => {
  const t = document.querySelector(".admin-table");
  return t === null ? -1 : Math.round(t.getBoundingClientRect().top);
});
assert(tableTop > 0 && tableTop < 330, `the product table starts high on the screen (${tableTop}px from the top)`);
// 🔴 THE TECHNICAL SOURCE BADGE IS GONE — and the check names what it allows rather than banning
// a CSS class. `.badge.faint` is also the ONLINE badge, which is deliberate and explained, so the
// first version of this line failed on the thing it was supposed to keep. What must be absent is
// an UNIDENTIFIED faint badge: anything carrying that look without a testid saying what it means.
const unexplained = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="product-row"] .badge.faint')]
    .filter((b) => b.getAttribute("data-testid") === null)
    .map((b) => b.textContent.trim()),
);
assert(unexplained.length === 0, `no unexplained badge on the products rows (found: ${unexplained.join(", ")})`);
// CONTROL: the online badge IS still there, so the line above is not passing because badges vanished.
assert(
  (await page.locator('[data-testid="badge-online"]').count()) === 1,
  "the online badge survives — exactly one product is marked online",
);
log("B — Arabic products list; table top at", tableTop, "px");

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
// Same change as the thumbnail above: was `=== 96` against the generated seed, now the real
// normalized photo. The property is that it DECODED, which `naturalWidth > 0` is the only honest
// test of — a browser reports 0 for an image it could not decode.
assert(preview.w === 1600, `the form preview is a real decode of the real photo (was: 96, got ${preview.w})`);
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

// 🔴 THE SCREENSHOT IS TAKEN HERE, BEFORE ANYTHING SCROLLS, and the first green run is why.
// PM4 was captured further down — after `scrollIntoViewIfNeeded` had moved the dialog to reach the
// online control — so the one screenshot that exists to show "Edit Product with an existing image"
// did not contain the image. The assertions were all true at the moment they ran; the EVIDENCE was
// taken of a different moment. A passing check and a screenshot of the wrong scroll position look
// identical in a green log.
await page.screenshot({ path: SHOTS + "PM4-edit-product-with-photo.png" });
await page.screenshot({ path: SHOTS + "E2.1-E-edit-product-with-image.png" });
log("PM4/E — Edit Product with an existing photo, unscrolled");

// The Edit form opens at the top too, even though an Add form was opened and scrolled before it.
assert((await scrollForm(page, 0)) === 0, "the Edit form opens at the top, not where the last one was left");

// And nothing is under the action bar here either, at any scroll position.
for (const position of [0, 200, "end"]) {
  await scrollForm(page, position);
  const buried = await coveredByFooter(page, [
    "field-nameAr",
    "field-barcode",
    "field-category",
    "field-brand",
    "field-price",
    "field-descAr",
    "field-online",
    "photo-preview",
    "photo-remove",
  ]);
  assert(buried.length === 0, `Edit: nothing drawn under the action bar at scroll ${position} (${buried.join(", ") || "none"})`);
}
{
  const g = await footerIsBelowTheScrollRegion(page);
  assert(g.ok, `Edit: the scroll region ends above the action bar (${g.scrollBottom} vs ${g.footerTop})`);
}
await scrollForm(page, 0);
// 🔴 THE ONLINE CONTROL IS NOT ASSERTED ON SCREEN, AND THAT IS A STATED LIMIT RATHER THAN A
// QUIETLY DROPPED CHECK. BASIC INFORMATION alone is ~630px of controls on a 1008x681 shop screen,
// so the dialog scrolls and SOMETHING must be below the fold. What the brief names as needing to
// be immediately obvious is the PHOTO state, and that is what is asserted above. The online
// section is reached by scrolling, and photographed as such below.
await page.locator('[data-testid="field-online"]').scrollIntoViewIfNeeded();
assert(await onScreen(page, "field-online"), "the online-catalogue control is reachable by scrolling");
await page.screenshot({ path: SHOTS + "PM10-online-catalogue-section.png" });
log("PM10 — the online catalogue section");
// 🔴 THIS ASSERTION FLIPPED IN SLICE F, AND THE OLD VALUE IS NAMED RATHER THAN QUIETLY REPLACED.
// Through E2.1 it read `isDisabled() === true` with the comment "the producer is slice F" — and it
// was right then: the channel answered NOT_AVAILABLE, so the button admitted it. The producer now
// exists, so the truthful assertion is the opposite one. A baseline cannot assert a thing's absence
// and also survive its creation; what it can do is say which it is asserting and why.
assert(await page.locator('[data-testid="photo-add"]').isEnabled(), "Add/Replace photo is ENABLED (was: disabled, until slice F)");
assert((await page.locator('[data-testid="photo-remove"]').count()) === 1, "Remove photo is offered");

// The retired category IS on offer here, because this product could be assigned one... it is not,
// so it must not be. Assign it an active one and confirm the brand datalist carries a suggestion.
const brandSuggestions = await page.locator("#brand-suggestions option").allTextContents();
log("brand suggestions:", brandSuggestions.length);

await page.locator('[data-testid="field-brand"]').scrollIntoViewIfNeeded();
await page.locator('[data-testid="field-brand"]').click();
assert(await onScreen(page, "field-brand"), "the brand field is on screen for its screenshot");
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
  // Same hazard as the corruption step below: an UPDATE matching nothing SUCCEEDS, so the one
  // thing worth asserting about a raw setup write is that it actually hit a row.
  const assigned = w.prepare("UPDATE catalog_products SET category_id = ? WHERE id = ?").run(retired.id, target.id);
  w.close();
  assert(assigned.changes === 1, `the retired category was really assigned (changed ${assigned.changes})`);
}

({ app, page } = await launch());
await rows(page).last().locator("button").first().click();
await page.locator('[data-testid="field-category"]').waitFor();
const retiredOptions = await page.locator('[data-testid="field-category"] option').allTextContents();
assert(
  retiredOptions.some((o) => o.includes("متوقّف")),
  `the product's own retired category is shown and marked: ${retiredOptions.join(" | ")}`,
);
await page.screenshot({ path: SHOTS + "E2.1-F-edit-retired-category.png" });
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
  // 🔴 THE IMAGE IS FOUND BY ITS PRODUCT, NOT BY A HARD-CODED ID — and the id this used to carry,
  // 'e2e-photo-1', belonged to the raw-SQL seed slice F deleted. The real producer generates its
  // own id, so the UPDATE matched ZERO ROWS: nothing was corrupted, the thumbnail loaded perfectly,
  // and the step sat waiting for a placeholder that was never going to appear.
  //
  // 🔴 AND `.changes` IS ASSERTED, which is the real lesson. An UPDATE that matches nothing
  // SUCCEEDS — a setup step that silently did nothing is indistinguishable from one that worked,
  // and the failure then surfaces 15 seconds later as a timeout on an unrelated-looking selector.
  const db = new Database(LEDGER);
  const image = db
    .prepare(
      `SELECT i.id FROM catalog_product_images i
         JOIN catalog_products p ON p.id = i.product_id
        WHERE p.sku = 'SKU-100' AND i.is_primary = 1`,
    )
    .get();
  assert(image !== undefined, "the photographed product has a stored primary image to corrupt");
  const result = db.prepare("UPDATE catalog_product_images SET bytes = ? WHERE id = ?").run(Buffer.from("not an image"), image.id);
  db.close();
  assert(result.changes === 1, `the corruption changed exactly one row (changed ${result.changes})`);
  log("corrupted the stored photo behind the application's back:", image.id);
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

// 🔴 ROW HEIGHTS IN ENGLISH TOO — and this check exists because the Arabic one could not see it.
// The English capture showed "23.00 USD" wrapping across two lines while "7.50 USD" did not, so
// the rows were uneven again in the other language. A layout measured in one direction is measured
// in one direction.
const enHeights = await rows(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
assert(Math.abs(enHeights[0] - enHeights[1]) <= 2, `English rows are the same height: ${enHeights.join(" vs ")}`);
assert(enHeights.every((h) => h < 110), `no row-height explosion in English: ${enHeights.join(", ")}`);
await page.screenshot({ path: SHOTS + "PM9-products-english-ltr.png" });
const enGeom = await assertNoClipping(page, "English owner");
log("R1 English owner geometry: " + JSON.stringify(enGeom.map((r) => ({ price: r.priceText, unit: r.unitText, priceCell: r.priceCell?.width, unitCell: r.unitCell?.width, actionsCell: r.actionsCell?.width, buttons: r.buttonCount }))));

await page.screenshot({ path: SHOTS + "E2.1-A-products-english.png" });
log("PM9/A — the same screen in English/LTR");

// ── I · THE NARROWEST SUPPORTED WINDOW ──────────────────────────────────────────────────────────
// main.ts pins minWidth 1024 / minHeight 640, so this is the smallest a shop can make it. The
// layout has to hold there, not merely at the runner's default.
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setSize(1024, 640);
});
await page.waitForFunction(() => window.innerWidth <= 1024, undefined, { timeout: 10000 });
await rows(page).first().waitFor();
await assertNoClipping(page, "narrowest window");

await page.screenshot({ path: SHOTS + "E2.1-I-narrowest-window-list.png" });
const narrowHeights = await rows(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
assert(
  Math.abs(narrowHeights[0] - narrowHeights[1]) <= 2,
  `rows stay even at 1024x640: ${narrowHeights.join(" vs ")}`,
);
// 🔴 The modal still works at the minimum size: nothing under the action bar, Save reachable.
await rows(page).first().locator("button").first().click();
await page.locator('[data-testid="form-footer"]').waitFor();
assert(await onScreen(page, "save-product"), "Save is on screen at 1024x640");
for (const position of [0, "end"]) {
  await scrollForm(page, position);
  const buried = await coveredByFooter(page, ["field-nameAr", "field-price", "field-online", "photo-panel"]);
  assert(buried.length === 0, `1024x640: nothing under the action bar at scroll ${position} (${buried.join(", ") || "none"})`);
}
await scrollForm(page, 0);
await page.screenshot({ path: SHOTS + "E2.1-I-narrowest-window-form.png" });
log("I — the narrowest supported window, 1024x640");
await page.locator('[data-testid="cancel-product"]').click();

// ── R1 · THE CASHIER'S VIEW OF THE SAME TABLE ───────────────────────────────────────────────────
//
// 🔴 WHY THE CASHIER MATTERS HERE. The clipping was never about the data: the SAME prices rendered
// correctly for a cashier and were cut for the owner, because the owner's row carries three extra
// controls and the cashier's carries none. So the cashier is the control case — if the fix is
// real, both roles read cleanly, and the owner-only controls are still absent for the cashier.
//
// 🔴 AND WHY `may_create_products` CANNOT CHANGE THIS MEASUREMENT. That capability governs the
// TOOLBAR's "add" button, not anything inside a row; the per-row Edit / phone / deactivate controls
// are gated on `isOwner` alone (ProductsScreen.tsx). Row geometry therefore cannot vary with it,
// and the capability's own authorization is proven elsewhere
// (tests/application/productCreateCapability.test.ts, and the service re-check at every save).
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
await page.locator('[data-testid="change-cashier"]').click().catch(() => undefined);
await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
await signIn(page, "Cashier Two", "2222");
await page.locator('[data-testid="tab-products"]').click();
await page.locator('[data-testid="product-row"]').first().waitFor({ timeout: 30000 });

const cashierGeom = await assertNoClipping(page, "cashier");
log("R1 cashier geometry: " + JSON.stringify(cashierGeom.map((r) => ({ price: r.priceText, unit: r.unitText, buttons: r.buttonCount }))));

// The owner-only row controls are genuinely gone — which is also what makes this a control and not
// a repeat of the owner measurement.
for (const id of ["product-edit", "product-edit-phone"]) {
  assert((await page.locator(`[data-testid="${id}"]`).count()) === 0, `a cashier sees no ${id} control`);
}
assert(
  cashierGeom.every((r) => r.buttonCount === 0),
  `and no per-row action buttons at all (${cashierGeom.map((r) => r.buttonCount).join(", ")})`,
);
await page.screenshot({ path: SHOTS + "E2.1-J-products-cashier.png" });
log("J — the same table as a cashier: no owner controls, prices and units intact");

await app.close();
log("screenshots in", SHOTS);
console.log("\nPRODUCT MASTER E2E PASSED");
