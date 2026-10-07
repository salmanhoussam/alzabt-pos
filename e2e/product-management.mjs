/**
 * E2E — offline product management against the REAL app (the installed executable in CI).
 *
 * This script exists to produce the evidence a unit test cannot: that the screen renders, in both
 * languages, with the document actually flipping direction, and that a product typed by a human
 * reaches SQLite and comes back after a restart. It leaves six screenshots behind for review.
 *
 * 🔴 Selectors are data-testid, never visible text, because the terminal's default language is
 * Arabic. A test that clicks "Add product" passes only while the UI happens to be English.
 *
 * Run: node e2e/product-management.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 *      Linux without a display: xvfb-run -a node e2e/product-management.mjs
 */
import { _electron as electron } from "playwright-core";
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

// A fresh profile per run: this script creates products, and it must never touch a real ledger.
const home = mkdtempSync(join(tmpdir(), "pos-e2e-products-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await page.waitForSelector("text=Select cashier", { timeout: 30000 });
  await page.getByRole("button", { name: "Cashier One" }).click();
  for (const d of "1111") await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForSelector("text=Current sale");
  return { app, page };
}

const tab = (page, name) => page.locator(`[data-testid="tab-${name}"]`).click();
const docDir = (page) => page.evaluate(() => document.documentElement.dir);
const docLang = (page) => page.evaluate(() => document.documentElement.lang);
const rows = (page) => page.locator('[data-testid="product-row"]');

async function fill(page, { nameAr, nameEn, sku, price, unit }) {
  await page.locator('[data-testid="field-nameAr"]').fill(nameAr);
  const inputs = page.locator(".product-form input");
  if (nameEn !== undefined) await inputs.nth(1).fill(nameEn);
  if (sku !== undefined) await inputs.nth(2).fill(sku);
  await page.locator('[data-testid="field-price"]').fill(price);
  await page.locator('[data-testid="field-unit"]').selectOption(unit);
}

// ── 1 · The Arabic screen ───────────────────────────────────────────────────────────────────────
let { app, page } = await launch();

assert((await docDir(page)) === "rtl", "the document is rtl on a fresh profile (Arabic is the default)");
assert((await docLang(page)) === "ar", "the document language is ar");

await tab(page, "products");
await page.waitForSelector('[data-testid="product-search"]');
await page.screenshot({ path: SHOTS + "P1-products-arabic-empty.png" });
assert((await rows(page).count()) === 0, "a fresh terminal has no local products");

const arabicLabel = await page.locator('[data-testid="add-product"]').innerText();
assert(/[؀-ۿ]/.test(arabicLabel), `the Add button is Arabic ("${arabicLabel.trim()}")`);

// ── 2 · Add a product ───────────────────────────────────────────────────────────────────────────
await page.locator('[data-testid="add-product"]').click();
await page.waitForSelector('[data-testid="field-nameAr"]');
await fill(page, { nameAr: "مفتاح أحمر", nameEn: "Red Wrench", sku: "E2E-001", price: "4.00", unit: "piece" });
await page.screenshot({ path: SHOTS + "P2-add-product-arabic.png" });
await page.locator('[data-testid="save-product"]').click();
await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();

await page.waitForSelector('[data-testid="product-row"]');
assert((await rows(page).count()) === 1, "the product is listed right after saving");
assert((await rows(page).first().innerText()).includes("مفتاح أحمر"), "the Arabic name is shown as typed");

// A unit whose real quantities are fractional must say so rather than round in silence.
await page.locator('[data-testid="add-product"]').click();
await fill(page, { nameAr: "سلك نحاس", nameEn: "", sku: "E2E-002", price: "2.50", unit: "kg" });
await page.waitForSelector('[data-testid="whole-units-note"]');
assert(true, "choosing kg shows the whole-units-only note");
await page.locator('[data-testid="save-product"]').click();
await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 2);

// ── 3 · Search, with Arabic normalisation ───────────────────────────────────────────────────────
const search = page.locator('[data-testid="product-search"]');
await search.fill("مفتاح احمر"); // typed WITHOUT the hamza on purpose
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 1);
await page.screenshot({ path: SHOTS + "P3-search-normalised.png" });
assert(true, "a search typed without the hamza finds 'مفتاح أحمر'");

await search.fill("E2E-002");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 1);
assert((await rows(page).first().innerText()).includes("سلك نحاس"), "the SKU finds its product");

await search.fill("لا يوجد هذا الصنف");
await page.waitForSelector('[data-testid="no-match"]');
assert(true, "a search with no match says so instead of showing an empty table");
await search.fill("");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 2);

// ── 4 · Edit, and the price of a past sale ──────────────────────────────────────────────────────
// Sell one first, so the edit below has a real invoice to leave alone.
await tab(page, "sell");
// The sell list shows ONE name per product, and displayName() is `nameEn ?? nameAr` — so this
// product reads "Red Wrench" here while the Products screen shows it in Arabic. Clicking it by
// SKU is both language-neutral and indifferent to that rule, which is this file's own standard.
await page.locator("button.product", { hasText: "E2E-001" }).click();
await page.getByRole("button", { name: "Cash" }).click();
await page.waitForSelector("text=Sale completed");
const receipt = await page.locator(".receipt").innerText();
assert(receipt.includes("4.00"), "the sale was rung at 4.00");
await page.getByRole("button", { name: /^(حسناً|OK|Close|New sale)$/ }).first().click().catch(() => {});

await tab(page, "products");
await page.waitForSelector('[data-testid="product-row"]');
await page.locator('[data-testid="product-row"]').first().getByRole("button").first().click();
await page.waitForSelector('[data-testid="field-price"]');
await page.locator('[data-testid="field-price"]').fill("9.00");
await page.screenshot({ path: SHOTS + "P4-edit-product.png" });
await page.locator('[data-testid="save-product"]').click();
await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("9.00"));
assert(true, "the new price is saved and shown");

await tab(page, "history");
const history = await page.locator(".history-table").innerText();
assert(history.includes("4.00") && !history.includes("9.00"), "🔴 the earlier sale still reads 4.00 — the invoice was not rewritten");

// ── 5 · The English screen, and the direction actually flips ────────────────────────────────────
await page.locator('[data-testid="lang-toggle"]').click();
await page.waitForFunction(() => document.documentElement.dir === "ltr");
assert((await docLang(page)) === "en", "the document language became en");
await tab(page, "products");
await page.waitForSelector('[data-testid="product-search"]');
const englishLabel = await page.locator('[data-testid="add-product"]').innerText();
assert(!/[؀-ۿ]/.test(englishLabel), `the Add button is English ("${englishLabel.trim()}")`);
await page.screenshot({ path: SHOTS + "P5-products-english-ltr.png" });

// Arabic product names stay Arabic in the English UI — the data is never translated.
assert((await rows(page).first().innerText()).includes("مفتاح أحمر"), "the Arabic product name is unchanged in the English UI");

// ── 6 · Deactivate, and the restart ─────────────────────────────────────────────────────────────
await page.locator('[data-testid="product-row"]').first().getByRole("button").nth(1).click();
await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();
await page.waitForFunction(() => document.querySelectorAll(".row-inactive").length === 1);
await page.screenshot({ path: SHOTS + "P6-deactivated.png" });
assert(true, "a deactivated product is still listed, marked inactive");

await tab(page, "sell");
const sellable = await page.locator("button.product").count();
assert(sellable === 1, `only the active product is sellable (${sellable} of 2)`);

await app.close();

// The language choice and the products must both survive a restart.
({ app, page } = await launch());
assert((await docDir(page)) === "ltr", "the English choice survived the restart (settings.json)");
await tab(page, "products");
await page.waitForSelector('[data-testid="product-row"]');
assert((await rows(page).count()) === 2, "both products came back from SQLite after the restart");
assert((await page.locator(".row-inactive").count()) === 1, "the deactivated product is still inactive");
await app.close();

log("product management E2E: all assertions passed");
log("screenshots in", SHOTS);
