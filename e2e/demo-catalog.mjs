// REALISTIC DEMO CATALOG (owner request 2026-11-09) — the 40-product demo catalog loaded through the SAME
// paths a merchant uses, then the whole selling cycle exercised on it, against the real app, on a
// throw-away isolated profile. Never a real shop's ledger: ALZABT_POS_USER_DATA is always a new temp folder.
//
//   node e2e/demo-catalog.mjs          (fixture: tests/fixtures/demo-catalog; DEMO_CATALOG_DIR overrides)
//   DEMO_SHOWCASE_DIR=<folder>   optional: where to keep a CLEAN copy of the loaded profile (no sales)
//
// A · load: CSV import from the Tools screen (dialog aimed at the file) → categories → product master
//     fields (SKU, barcode, category, brand, descriptions, active) through updateProduct → one photo per
//     product through setProductImage (the photo button's own channel) → verified in the ledger →
//     relaunch → screenshots; a clean copy is kept as the showcase profile.
// B · sell on it: barcode scan, kg item, cash; Whish with reference; on account; part-paid; split;
//     statement + collection; owner void; paid invoice with its method + PDF; cart kept across tabs.
// C · negatives: inactive product, duplicate barcode, corrupt photo, bad CSV — each refused, nothing changed.
// D · full backup → restore into a NEW profile → every product and photo is there and shows.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? require("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
// The fixture lives in the repo (tests/fixtures/demo-catalog, see its README); DEMO_CATALOG_DIR overrides it.
const CAT = process.env.DEMO_CATALOG_DIR ?? join(APP, "tests", "fixtures", "demo-catalog");
const CSV = join(CAT, "alzabt-demo-catalog-import.csv");
const IMAGES = join(CAT, "images");
const DEF = JSON.parse(readFileSync(join(CAT, "catalog.json"), "utf8"));
const P0 = Object.fromEntries(DEF.products.map((p) => [p.sku, p]));
const home = mkdtempSync(join(tmpdir(), "pos-e2e-democat-"));
const USERDATA = join(home, "userData");
const LEDGER = join(USERDATA, "alzabt-pos-ledger.sqlite");
const Database = require("better-sqlite3");
const engine = require(join(APP, "dist", "main", "persistence", "restoreEngine.js"));

let passed = 0;
// PRODUCT FINDINGS: real defects found on the realistic catalogue that need an owner decision before any
// fix. Recorded as FAIL (never hidden), they do not stop the run, and the process exits 3 if any exist.
const findings = [];
const finding = (cond, msg) => {
  if (cond) {
    passed++;
    log("PASS", msg);
  } else {
    findings.push(msg);
    log("FINDING (FAIL)", msg);
  }
};
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
const read = (file, fn) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const n = (sql, ...p) => read(LEDGER, (db) => Number(db.prepare(sql).get(...p).n));
const okOf = (r, what) => {
  if (!r || !r.ok) throw new Error(`${what}: ${JSON.stringify(r && r.error)}`);
  return r.data;
};

async function launch(userData) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env: { ...process.env, ALZABT_POS_USER_DATA: userData } });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 60000 });
  return { app, page };
}
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const direct = (page, method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const aimOpen = (app, path) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialogSync = () => (p === null ? undefined : [p]); }, path);
const aimSave = (app, path) => app.evaluate(({ dialog }, p) => { dialog.showSaveDialogSync = () => p; }, path);
// TILL-NAMES (DEC-35h §3): a card shows the name for the UI language first and the OTHER stored name
// smaller beneath it, so a card's text holds both names and either finds it. (First run, 2026-11-09:
// the till showed the English name in the Arabic UI — finding F2, fixed by TILL-NAMES.)
const shown = (p) => p.name_en ?? p.name_ar;
const card = (page, name) => page.locator("button.product", { hasText: name });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A · LOAD THE CATALOG THROUGH THE MERCHANT'S PATHS
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await launch(USERDATA);
assert((await app.evaluate(({ app }) => app.getPath("userData"))) === USERDATA, "an isolated, throw-away profile — never a real ledger");
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
assert((await page.locator("button.product").count()) === 0, "a fresh profile starts with NO products (no demo injection — DEMO-FALLBACK respected)");
okOf(
  await direct(page, "saveCompanyProfile", {
    nameAr: "متجر عالضبط — نسخة تجريبية (DEMO)", nameEn: "Alzabt Demo Store (DEMO)", legalName: null, tagline: "بيانات تجريبية — ليست مبيعات حقيقية",
    address: "بيروت — عنوان تجريبي", phone1: null, phone2: null, email: null, logoPath: null, taxpayerNumber: null, commercialRegister: null,
    vatNumber: null, taxEnabled: false, taxRatePercent: null, taxLabel: null,
  }),
  "saveCompanyProfile",
);

// A1 · CSV import from the Tools screen — the merchant's button, the dialog aimed at the file.
await aimOpen(app, CSV);
await tid(page, "tab-tools").click();
await tid(page, "import-catalog").click();
await page.locator(".import-report").waitFor({ timeout: 30000 });
const report = (await page.locator(".import-report").innerText()).replace(/\s+/g, " ");
log("import report:", report);
await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
assert(n("SELECT count(*) AS n FROM catalog_products") === DEF.products.length, `the CSV imported all ${DEF.products.length} products`);
assert(n("SELECT count(*) AS n FROM catalog_products WHERE price_needs_review = 1") === 1, "exactly one placeholder price (GRC-COFF-250), as the CSV says");

// A2 · categories, then the product-master fields through updateProduct (the product screen's save).
const catIds = {};
for (const [key, ar, en] of DEF.categories) catIds[key] = okOf(await direct(page, "createCategory", { nameAr: ar, nameEn: en }), "createCategory").id;
const listed = okOf(await direct(page, "listProducts", undefined), "listProducts");
const bySource = Object.fromEntries(listed.map((p) => [p.sourceKey, p]));
const idOf = {};
for (const p of DEF.products) {
  const row = bySource[p.source_id];
  idOf[p.sku] = row.id;
  okOf(
    await direct(page, "updateProduct", {
      id: row.id,
      draft: {
        nameAr: p.name_ar, nameEn: p.name_en, sku: p.sku, price: p.price, baseUnit: p.unit,
        master: { categoryId: catIds[p.category], barcode: p.barcode, brand: p.brand, descriptionAr: p.desc_ar, descriptionEn: p.desc_en },
      },
      isActive: p.active,
    }),
    `updateProduct ${p.sku}`,
  );
}
assert(n("SELECT count(*) AS n FROM catalog_products WHERE sku IS NOT NULL AND barcode IS NOT NULL AND category_id IS NOT NULL") === DEF.products.length, "every product has its SKU, barcode and category");
assert(n("SELECT count(*) AS n FROM catalog_products WHERE is_active = 0") === 1, "exactly one inactive product (FRT-STRW-KG, seasonal)");

// A3 · one photo per product through setProductImage — the photo button's channel, dialog aimed at the file.
const withPhoto = DEF.products.filter((p) => existsSync(join(IMAGES, `${p.sku}.jpg`)));
for (const p of withPhoto) {
  await aimOpen(app, join(IMAGES, `${p.sku}.jpg`));
  okOf(await direct(page, "setProductImage", { productId: idOf[p.sku] }), `setProductImage ${p.sku}`);
}
const imaged = n("SELECT count(DISTINCT product_id) AS n FROM catalog_product_images");
assert(imaged === withPhoto.length, `${withPhoto.length} products carry their photo inside the ledger (got ${imaged})`);
await app.close();

// A4 · relaunch: everything persisted; the till shows the active products with their photos.
({ app, page } = await launch(USERDATA));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
await page.locator("button.product").first().waitFor({ timeout: 30000 });
const active = DEF.products.filter((p) => p.active).length;
assert((await page.locator("button.product").count()) === active, `after a relaunch the till lists the ${active} active products`);
await page.waitForFunction((min) => document.querySelectorAll('[data-testid="sell-thumb-image"]').length >= min, withPhoto.length - 1, { timeout: 30000 });
const broken = await page.evaluate(() => [...document.querySelectorAll('[data-testid="sell-thumb-image"]')].filter((i) => !i.complete || i.naturalWidth === 0).length);
assert(broken === 0, "no broken photo on the till");
await page.screenshot({ path: SHOTS + "DEMO1-till-products.png" });
await card(page, "Red Lentils").first().scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + "DEMO1b-till-scrolled.png" });
// Search by name and by barcode (the scan path is the search field + Enter).
const t0 = Date.now();
await tid(page, "product-search").fill("Lentils");
await page.waitForFunction(() => document.querySelectorAll("button.product").length === 1, null, { timeout: 5000 });
log("search by name took", Date.now() - t0, "ms");
assert((await card(page, "Red Lentils").count()) === 1, "search by the displayed name «Lentils» finds exactly that product");
await tid(page, "product-search").fill("GRC-LENT");
await page.waitForFunction(() => document.querySelectorAll("button.product").length === 1, null, { timeout: 5000 });
assert(true, "search by SKU finds the product");
// TILL-SEARCH-AR (DEC-35h §2). First run, 2026-11-09: «عدس» found 0 — finding F1 — because the till
// filtered on the DISPLAYED name only. It is a hard assertion now, never a SKIP: the till must find a
// product by its Arabic name, its English name, its SKU and its barcode, through domain/arabic.ts.
const hits = async (q, expected) => {
  await tid(page, "product-search").fill(q);
  await page.waitForFunction((n) => document.querySelectorAll("button.product").length === n, expected, { timeout: 5000 }).catch(() => {});
  return page.locator("button.product").count();
};
let h = await hits("عدس", 1);
assert(h === 1 && (await card(page, "Red Lentils").count()) === 1, `searching the ARABIC name «عدس» finds exactly the lentils (found ${h}; F1 was 0)`);
await page.screenshot({ path: SHOTS + "DEMO1c-arabic-search.png" });
h = await hits("ارز", 2);
assert(h === 2, `«ارز» typed WITHOUT hamza finds both «أرز» sizes (normalisation; found ${h})`);
h = await hits("ارز 5", 1);
assert(h === 1 && (await card(page, "5 kg").count()) === 1, `«ارز 5» narrows to the 5 kg pack — terms ANDed (found ${h})`);
h = await hits("ملح", 1);
assert(h === 1, `the Arabic-ONLY product «ملح» is found (found ${h})`);
h = await hits("long grain", 2);
assert(h === 2, `the English name, any case, still finds products (found ${h})`);
h = await hits(P0["GRC-LENT-1KG"].barcode, 1);
assert(h === 1, `typing a barcode (without Enter) narrows the grid to its product (found ${h})`);
h = await hits("لا يوجد منتج بهذا الاسم", 0);
assert(h === 0, "a name that matches nothing shows nothing");
// TILL-NAMES: the Arabic UI shows the Arabic name first, the English one smaller.
await hits("عدس", 1);
assert((await tid(page, "product-name").first().innerText()).trim() === P0["GRC-LENT-1KG"].name_ar, "Arabic UI: the card's main name is the ARABIC name");
assert((await tid(page, "product-name-alt").first().innerText()).trim() === P0["GRC-LENT-1KG"].name_en, "Arabic UI: the English name is the smaller second line");
await tid(page, "lang-toggle").click();
await page.waitForFunction(() => document.documentElement.lang === "en" || document.documentElement.dir === "ltr", null, { timeout: 5000 }).catch(() => {});
assert((await tid(page, "product-name").first().innerText()).trim() === P0["GRC-LENT-1KG"].name_en, "English UI: the card's main name is the ENGLISH name");
h = await hits("عدس", 1);
assert(h === 1, "English UI: the Arabic name still finds the product");
await hits("ملح", 1);
assert((await tid(page, "product-name").first().innerText()).trim() === P0["GRC-SALT-1KG"].name_ar, "English UI: an Arabic-only product shows its Arabic name (no invented translation)");
assert((await tid(page, "product-name-alt").count()) === 0, "…and no second line");
await page.screenshot({ path: SHOTS + "DEMO1d-english-ui.png" });
await tid(page, "lang-toggle").click();
await tid(page, "product-search").fill("");
await app.close();

// A5 · the CLEAN showcase copy (catalogue + photos, no sale yet).
if (process.env.DEMO_SHOWCASE_DIR) {
  cpSync(USERDATA, process.env.DEMO_SHOWCASE_DIR, { recursive: true });
  // SHOWCASE MARKER: written by THIS tooling into the copy it prepared — never by the app, never into
  // the test profile itself, which therefore stays an ordinary (merchant-mode) profile.
  writeFileSync(join(process.env.DEMO_SHOWCASE_DIR, "alzabt-showcase-profile.json"), JSON.stringify({ kind: "alzabt-pos-showcase-profile", version: 1 }) + "\n", "utf8");
  assert(existsSync(join(process.env.DEMO_SHOWCASE_DIR, "alzabt-pos-ledger.sqlite")), "a clean showcase profile was kept (catalogue + photos, no sales)");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// B · SELL ON THE REAL CATALOGUE
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch(USERDATA));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
await page.locator("button.product").first().waitFor({ timeout: 30000 });
const P = Object.fromEntries(DEF.products.map((p) => [p.sku, p]));
const lastSale = () => read(LEDGER, (db) => db.prepare("SELECT id, total_minor AS t, paid_minor AS p, payment_status AS st, payment_method AS m, tender_count AS tc FROM sales ORDER BY rowid DESC LIMIT 1").get());
const scan = async (code) => {
  await tid(page, "product-search").fill(code);
  await tid(page, "product-search").press("Enter");
};

// B1 · barcode scan + a by-weight item + cash.
await scan(P["GRC-LENT-1KG"].barcode);
await card(page, "Tomatoes").first().click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="cart"] [data-testid="line-inc"]').length >= 2, null, { timeout: 10000 }).catch(() => {});
await page.screenshot({ path: SHOTS + "DEMO2-cart.png" });
await tid(page, "complete-sale").click();
await page.screenshot({ path: SHOTS + "DEMO3-payment.png" });
await tid(page, "pay-cash").click();
await tid(page, "receipt").waitFor();
await page.screenshot({ path: SHOTS + "DEMO4-receipt.png" });
let s = lastSale();
assert(s.st === "paid" && s.m === "cash" && Number(s.t) === 230 + 140, `cash sale: scanned lentils 2.30 + 1 kg tomatoes 1.40 = 3.70 (${JSON.stringify({ t: Number(s.t), m: s.m })})`);
await tid(page, "new-sale").click();

// B2 · Whish with its reference.
await card(page, "Extra Virgin Olive Oil").first().click();
await tid(page, "complete-sale").click();
await tid(page, "pay-whish").click();
await tid(page, "whish-reference").fill("WH-DEMO-0001");
await tid(page, "whish-confirm").check();
await tid(page, "whish-submit").click();
await tid(page, "receipt").waitFor();
s = lastSale();
assert(s.m === "external" && Number(s.t) === 875, "Whish sale: olive oil 8.75 with its reference");
await tid(page, "new-sale").click();

// B3–B5 · a customer: on account, part-paid, split.
const CUST = "زبون تجريبي — أبو علي";
const cust = okOf(await direct(page, "createCustomer", { displayName: CUST, phone: null, address: null, note: null }), "createCustomer").customer;
const pick = async () => {
  await tid(page, "sell-choose-customer").click();
  await tid(page, "customer-finder").waitFor();
  await tid(page, "customer-search").fill(CUST);
  await page.locator('[data-testid="customer-row"]').filter({ hasText: CUST }).first().click();
  await tid(page, "customer-finder").waitFor({ state: "detached" });
};
await card(page, "Long Grain Rice 5 kg").first().click();
await pick();
await tid(page, "complete-sale").click();
await tid(page, "pay-on-account").click();
await tid(page, "receipt").waitFor();
s = lastSale();
assert(s.st === "unpaid" && Number(s.t) === 1050, "on account: rice 5 kg 10.50, all owed");
await tid(page, "new-sale").click();

await card(page, "Fresh Eggs").first().click();
await card(page, "Labneh").first().click();
await pick();
await tid(page, "complete-sale").click();
await tid(page, "pay-partial-amount").fill("3");
await tid(page, "pay-partial-cash").click();
await tid(page, "receipt").waitFor();
s = lastSale();
assert(s.st === "partial" && Number(s.p) === 300 && Number(s.t) === 595, "part-paid: eggs 3.20 + labneh 2.75 = 5.95, 3.00 cash now, 2.95 owed");
await tid(page, "new-sale").click();

await card(page, "Whole Milk").first().click();
await card(page, "White Cheese").first().click();
await tid(page, "complete-sale").click();
await tid(page, "pay-split").click();
await tid(page, "split-cash").fill("2.00");
await tid(page, "split-whish").fill("2.70");
await tid(page, "split-whish-reference").fill("WH-DEMO-0002");
await tid(page, "split-whish-confirm").check();
await tid(page, "split-submit").click();
await tid(page, "receipt").waitFor();
s = lastSale();
assert(s.st === "paid" && Number(s.tc) === 2 && Number(s.t) === 470, "split: milk 1.20 + cheese 3.50 = 4.70 as 2.00 cash + 2.70 Whish");
await tid(page, "new-sale").click();

// B6 · statement + collection.
const st = okOf(await direct(page, "getCustomerStatement", { customerId: cust.id }), "statement");
assert(st.balances.some((b) => b.minor === "1345"), `the customer owes 10.50 + 2.95 = 13.45 (${JSON.stringify(st.balances)})`);
const debt = st.obligations.find((o) => o.amount.minor === "295");
okOf(await direct(page, "recordCustomerPayment", { customerId: cust.id, obligationId: debt.id, idempotencyKey: "demo-collect-0001", amountMinor: "295", method: "cash" }), "collect");
const st2 = okOf(await direct(page, "getCustomerStatement", { customerId: cust.id }), "statement");
assert(st2.balances.some((b) => b.minor === "1050"), "after collecting 2.95 in cash, 10.50 is still owed");

// B7 · cart kept across tabs, then an owner void of a cash sale.
await card(page, "Bananas").first().click();
await tid(page, "tab-history").click();
await tid(page, "tab-sell").click();
assert((await tid(page, "cart-total").innerText()).includes("1.50"), "the cart (bananas 1.50) is kept across tabs");
await tid(page, "complete-sale").click();
await tid(page, "pay-cash").click();
await tid(page, "receipt").waitFor();
const toVoid = lastSale();
await tid(page, "new-sale").click();
okOf(await direct(page, "voidSale", { saleId: toVoid.id, reason: "تجربة إلغاء في النسخة التجريبية" }), "voidSale");
assert(n("SELECT count(*) AS n FROM voids WHERE sale_id = ?", toVoid.id) === 1, "the owner voided the bananas sale (reason kept)");

// B8 · a paid invoice with its method, saved as PDF.
const draft = okOf(await direct(page, "createInvoiceDraft", undefined), "draft").invoice.id;
okOf(await direct(page, "addInvoiceLine", { invoiceId: draft, line: { description: P["GRC-OLIV-1L"].name_ar, unitLabel: "حبة", canonicalUnit: null, productId: idOf["GRC-OLIV-1L"], quantity: "2", unitPrice: P["GRC-OLIV-1L"].price } }), "addInvoiceLine");
okOf(await direct(page, "updateInvoiceHeader", { invoiceId: draft, patch: { customerName: CUST, paid: "17.50" } }), "header");
okOf(await direct(page, "finalizeInvoice", { invoiceId: draft, payment: { method: "external", whish: { reference: "WH-DEMO-INV-1", fundsConfirmed: true } } }), "finalizeInvoice");
const pdf = join(home, "demo-invoice.pdf");
await aimSave(app, pdf);
const saved = okOf(await direct(page, "saveInvoicePdf", { invoiceId: draft }), "saveInvoicePdf");
assert(saved.status === "saved" && existsSync(pdf) && statSync(pdf).size > 5000, `the paid invoice was saved as a PDF (${existsSync(pdf) ? statSync(pdf).size : 0} bytes)`);
const inv = read(LEDGER, (db) => db.prepare("SELECT s.payment_method AS m FROM sales s WHERE s.invoice_id = ?").get(draft));
assert(inv.m === "external", "the paid invoice records Whish as its method");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C · NEGATIVES — refused, nothing changed
// ════════════════════════════════════════════════════════════════════════════════════════════════
const salesBefore = n("SELECT count(*) AS n FROM sales");
assert((await card(page, "Strawberries").count()) === 0, "the inactive product (strawberries) is not offered at the till");
await scan(P["FRT-STRW-KG"].barcode);
await page.waitForTimeout(400);
assert((await tid(page, "cart-total").innerText()).includes("0.00") || (await page.locator('[data-testid="cart"] [data-testid="line-inc"]').count()) === 0, "scanning the inactive product's barcode adds nothing");
await tid(page, "product-search").fill("");
const dup = await direct(page, "updateProduct", {
  id: idOf["GRC-SALT-1KG"],
  draft: { nameAr: P["GRC-SALT-1KG"].name_ar, nameEn: null, sku: P["GRC-SALT-1KG"].sku, price: P["GRC-SALT-1KG"].price, baseUnit: "pack", master: { barcode: P["GRC-SUGR-1KG"].barcode } },
  isActive: true,
});
assert(!dup.ok, `a duplicate barcode is refused (${JSON.stringify(dup.error)})`);
assert(read(LEDGER, (db) => db.prepare("SELECT barcode FROM catalog_products WHERE id = ?").get(idOf["GRC-SALT-1KG"]).barcode) === P["GRC-SALT-1KG"].barcode, "…and salt kept its own barcode");
const corrupt = join(APP, "tests", "fixtures", "photos", "corrupt.jpg");
const imgBefore = n("SELECT count(*) AS n FROM catalog_product_images");
await aimOpen(app, corrupt);
const bad = await direct(page, "setProductImage", { productId: idOf["COF-ESP"] });
assert(!bad.ok, `a corrupt photo is refused (${JSON.stringify(bad.error)})`);
assert(n("SELECT count(*) AS n FROM catalog_product_images") === imgBefore, "…and no photo row changed");
const badCsv = join(home, "bad.csv");
writeFileSync(badCsv, "﻿source_id,name_ar,name_en,price,currency,base_unit,price_needs_review\r\nX-1,صنف,,-3,USD,piece,0\r\nX-2,صنف,,abc,USD,box,0\r\n", "utf8");
await aimOpen(app, badCsv);
const productsBefore = n("SELECT count(*) AS n FROM catalog_products");
const imp = okOf(await direct(page, "importCatalog", undefined), "importCatalog");
assert(imp.status === "rejected" && imp.rejected.length === 2, `a CSV with a negative and a non-numeric price is rejected line by line (${JSON.stringify(imp.rejected)})`);
assert(n("SELECT count(*) AS n FROM catalog_products") === productsBefore && n("SELECT count(*) AS n FROM sales") === salesBefore, "…and the catalogue is unchanged");
await app.close();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D · FULL BACKUP → RESTORE INTO A NEW PROFILE → every product and photo is there
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch(USERDATA));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
const usb = join(home, "usb");
mkdirSync(usb, { recursive: true });
await aimOpen(app, usb);
const backup = okOf(await direct(page, "exportFullBackup", undefined), "exportFullBackup");
assert(backup.status === "saved" && backup.complete === true, "a complete full backup was written");
await app.close();
const restored = join(home, "restored-userData");
mkdirSync(restored, { recursive: true });
const pkg = join(backup.location, backup.folderName);
const inspected = engine.inspectRestorePackage(pkg);
engine.stageRestore({ userDataDir: restored, packageDir: pkg, consent: { manifestSha256: inspected.manifestSha256, acceptedMissingAssets: [] }, now: new Date() });
({ app, page } = await launch(restored));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
await page.locator("button.product").first().waitFor({ timeout: 30000 });
const RLEDGER = join(restored, "alzabt-pos-ledger.sqlite");
const rProducts = read(RLEDGER, (db) => Number(db.prepare("SELECT count(*) AS n FROM catalog_products").get().n));
const rImages = read(RLEDGER, (db) => Number(db.prepare("SELECT count(DISTINCT product_id) AS n FROM catalog_product_images").get().n));
assert(rProducts === DEF.products.length && rImages === withPhoto.length, `the restored profile has all ${DEF.products.length} products and ${withPhoto.length} photos (${rProducts} / ${rImages})`);
await page.waitForFunction((min) => document.querySelectorAll('[data-testid="sell-thumb-image"]').length >= min, withPhoto.length - 1, { timeout: 30000 });
const rBroken = await page.evaluate(() => [...document.querySelectorAll('[data-testid="sell-thumb-image"]')].filter((i) => !i.complete || i.naturalWidth === 0).length);
assert(rBroken === 0, "after restore every photo shows on the till — none broken");
await page.screenshot({ path: SHOTS + "DEMO5-after-restore.png" });
await app.close();

console.log(`DEMO CATALOG E2E — ${passed} checks passed · products ${DEF.products.length} · photos ${withPhoto.length} · PRODUCT FINDINGS (FAIL): ${findings.length}`);
for (const f of findings) console.log("  FINDING (FAIL):", f);
process.exit(findings.length > 0 ? 3 : 0);
