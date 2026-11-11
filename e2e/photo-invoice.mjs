// PHOTO-INVOICE-TO-ITEMS — the full workflow in the real app: Photo → OFFLINE OCR → Review → Confirm →
// catalog write, then the SAME photo again cannot duplicate the product.
//   PHOTO_INVOICE=<image>   default: the SYNTHETIC invoice of the OCR spike (outside this repository).
//   E2E_SHOTS=<dir>         where screenshots go (a REAL supplier photo must never land in the repo).
// 🔴 No real supplier image or text is part of this repository: the photo is a path given at run time.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = process.env.E2E_EXECUTABLE ?? createRequire(import.meta.url)("electron");
const APP_ARGS = process.env.E2E_EXECUTABLE ? [] : [APP];
const PHOTO = process.env.PHOTO_INVOICE ?? "C:/dev/alzabt-pos-ocr/spikes/ocr/invoices/A-clean.png";
const SHOTS = (process.env.E2E_SHOTS ?? join(APP, "e2e-output")) + "/";
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(PHOTO)) throw new Error(`photo not found: ${PHOTO}`);
const Database = createRequire(import.meta.url)("better-sqlite3");
const home = mkdtempSync(join(tmpdir(), "pos-e2e-photo-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1" };
delete env.ELECTRON_RUN_AS_NODE;

let passed = 0;
const assert = (c, m) => {
  if (!c) throw new Error("ASSERTION FAILED: " + m);
  passed += 1;
  console.log("• PASS", m);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const q = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return db.prepare(sql).all(...p);
  } finally {
    db.close();
  }
};
const SALE = "9.75";

async function readAndReview(page, app) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => [p];
  }, PHOTO);
  await testid(page, "tab-products").click();
  await testid(page, "photo-invoice").click();
  await testid(page, "photo-flow").waitFor({ timeout: 15000 });
  const t0 = Date.now();
  await testid(page, "photo-flow-pick").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="photo-review"]') || document.querySelector('[data-testid="photo-flow"]')?.textContent?.includes("لم يُقرأ"), undefined, { timeout: 120000 });
  return Date.now() - t0;
}

const productsBefore = () => q("SELECT count(*) AS n FROM catalog_products")[0].n;
const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");

  // ── FAILURE FIRST: a file that is not an image → an on-screen refusal, NO main-process error box,
  //    the POS stays alive, retry and manual entry are offered, nothing is written ──────────────────
  const notImage = join(home, "not-an-image.jpg");
  writeFileSync(notImage, "this is not an image");
  const productsAtStart = Number(productsBefore());
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => [p];
  }, notImage);
  await testid(page, "tab-products").click();
  await testid(page, "photo-invoice").click();
  await testid(page, "photo-flow-pick").click();
  await testid(page, "photo-flow-error").waitFor({ timeout: 30000 });
  const failText = (await testid(page, "photo-flow-error").innerText()).trim();
  assert(failText.includes("ليس صورة"), `🔴 a non-image is refused ON SCREEN in Arabic («${failText}»)`);
  assert((await testid(page, "photo-flow-pick").innerText()).includes("إعادة المحاولة"), "retry is offered");
  assert(await page.evaluate(() => typeof window.pos.getSettings === "function"), "the POS is still alive (renderer + bridge)");
  assert(Number(productsBefore()) === productsAtStart, "nothing was written");
  await page.screenshot({ path: SHOTS + "PHOTO-failure.png" });
  await testid(page, "photo-flow-manual").click();
  await testid(page, "save-product").waitFor({ timeout: 10000 });
  assert((await testid(page, "photo-flow").count()) === 0, "«إدخال يدوي» closes the reader and opens the manual add form");
  await testid(page, "cancel-product").click();
  await testid(page, "save-product").waitFor({ state: "detached", timeout: 10000 });

  const ms = await readAndReview(page, app);
  const rows = await testid(page, "photo-review-row").count();
  console.log(`• read in ${ms} ms · ${rows} candidate rows`);
  assert(rows > 0, `the photo produced candidate rows (${rows})`);
  assert((await page.locator('[data-testid="photo-review-row"][data-decision="pending"]').count()) === rows, "🔴 every row starts PENDING");
  assert(await testid(page, "photo-review-finish").isDisabled(), "🔴 finishing is impossible while a row is pending");
  await page.screenshot({ path: SHOTS + "PHOTO-review.png", fullPage: true });
  const before = Number(productsBefore());

  // first row → NEW with a typed sale price; every other row → skip
  const first = testid(page, "photo-review-row").first();
  const name = (await first.locator('[data-testid="photo-review-name"]').inputValue()).trim();
  await first.locator('[data-testid="photo-review-name"]').fill(name + " (اختبار)");
  await first.locator('[data-testid="photo-review-decision"]').selectOption("new");
  assert((await first.locator('[data-testid="photo-review-sale-price"]').inputValue()) === "", "🔴 a NEW product's sale price starts EMPTY — never the supplier price");
  await first.locator('[data-testid="photo-review-sale-price"]').fill(SALE);
  for (let i = 1; i < rows; i++) await testid(page, "photo-review-row").nth(i).locator('[data-testid="photo-review-decision"]').selectOption("skip");
  assert(Number(productsBefore()) === before, "🔴 nothing written during the review");
  await testid(page, "photo-review-finish").click();
  await testid(page, "photo-flow-confirm").waitFor({ timeout: 15000 });
  assert(Number(productsBefore()) === before, "🔴 nothing written at the confirmation step");
  await page.screenshot({ path: SHOTS + "PHOTO-confirm.png" });
  await testid(page, "photo-flow-write").click();
  await testid(page, "photo-flow-done").waitFor({ timeout: 15000 });
  const made = q("SELECT id, name_ar, sku, barcode, selling_price_minor AS p FROM catalog_products WHERE name_ar = ?", name + " (اختبار)");
  assert(made.length === 1, "exactly one product created");
  assert(made[0].sku === null && made[0].barcode === null, "🔴 no SKU and no barcode invented");
  assert(Number(made[0].p) === 975, `🔴 the price is the SALE price typed (${made[0].p} minor), not the supplier cost`);
  assert(q("SELECT count(*) AS n FROM audit_events WHERE event_type = 'PRODUCT_CREATED' AND entity_id = ?", made[0].id)[0].n >= 1, "the creation is in the durable audit trail");
  await page.getByText("إغلاق").last().click();

  // the SAME photo again: the created name cannot be created twice
  await readAndReview(page, app);
  const again = testid(page, "photo-review-row").first();
  await again.locator('[data-testid="photo-review-name"]').fill(name + " (اختبار)");
  await again.locator('[data-testid="photo-review-decision"]').selectOption("new");
  await again.locator('[data-testid="photo-review-sale-price"]').fill(SALE);
  assert((await again.locator('[data-issue="DUPLICATE_PRODUCT_NAME"]').count()) === 1, "🔴 re-processing: the existing name is flagged — link it instead");
  for (let i = 1; i < rows; i++) await testid(page, "photo-review-row").nth(i).locator('[data-testid="photo-review-decision"]').selectOption("skip");
  assert(await testid(page, "photo-review-finish").isDisabled(), "🔴 and the review cannot finish while it would duplicate");
  await page.screenshot({ path: SHOTS + "PHOTO-duplicate-blocked.png", fullPage: true });
  assert(q("SELECT count(*) AS n FROM catalog_products WHERE name_ar = ?", name + " (اختبار)")[0].n === 1, "still exactly one product");
} finally {
  await app.close();
}
console.log(`PHOTO INVOICE E2E PASSED — ${passed} checks`);
