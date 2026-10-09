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
await page.waitForSelector('[data-testid="fractional-note"]');
// Migration 4 inverted this note: kg USED to say "whole units only" and now says fractions are
// allowed. The testid changed with the meaning rather than keeping a name that lies.
assert(true, "choosing kg shows the fractional-quantity note");
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
// Payment methods live behind "Complete sale" — the cart does not take a method directly.
await page.getByRole("button", { name: "Complete sale" }).click();
await page.getByRole("button", { name: "Cash" }).click();
await page.waitForSelector("text=Sale completed");
const receipt = await page.locator(".receipt").innerText();
assert(receipt.includes("4.00"), "the sale was rung at 4.00");
await page.getByRole("button", { name: /^(حسناً|OK|Close|New sale)$/ }).first().click().catch(() => {});

// ── 4b · A FRACTIONAL sale of the kg product, on a fresh install ────────────────────────────────
// سلك نحاس is priced 2.50 per kg, so 2.5 kg is exactly 6.25 — no rounding involved.
await page.waitForSelector(".products-pane");
await page.locator("button.product", { hasText: "E2E-002" }).click();
const qtyBox = page.locator('[data-testid^="qty-"]').first();
await qtyBox.fill("2.5");
await qtyBox.press("Enter");
await page.waitForFunction(() => document.querySelector(".total strong")?.textContent?.includes("6.25"));
assert(true, "2.5 kg at 2.50 totals 6.25 — a fraction priced exactly");
await page.getByRole("button", { name: "Complete sale" }).click();
await page.getByRole("button", { name: "Cash" }).click();
await page.waitForSelector("text=Sale completed");
const fractionalReceipt = await page.locator(".receipt").innerText();
const receiptFlat = fractionalReceipt.replace(/\s+/g, " ").trim();
// 🔴 The ORDER, not just the presence: on an RTL terminal this line used to render as
// "2.5 USD 2.50 × kg". The quantity, its unit, the ×, the price and the currency must read in that
// sequence, which is what the bdi isolation in components/LineMath.tsx pins.
assert(
  receiptFlat.includes("2.5 kg × 2.50 USD"),
  `the receipt reads quantity -> unit -> × -> price -> currency ("${receiptFlat.slice(0, 140)}")`,
);
assert(fractionalReceipt.includes("6.25"), "the receipt total is 6.25");
await page.screenshot({ path: SHOTS + "P7-fractional-sale.png" });
await page.getByRole("button", { name: /^(حسناً|OK|Close|New sale)$/ }).first().click().catch(() => {});

// A fraction of a WHOLE-ONLY product is refused rather than rounded.
await page.waitForSelector(".products-pane");
await page.locator("button.product", { hasText: "E2E-001" }).click();
const wholeBox = page.locator('[data-testid^="qty-"]').first();
await wholeBox.fill("1.5");
await wholeBox.press("Enter");
await page.waitForSelector(".cart .error");
const refusal = (await page.locator(".cart .error").innerText()).trim();
// 🔴 This is the assertion that caught a real defect: errorText() only unwrapped an ApiError, so a
// DomainError raised in the renderer read "Unexpected error" and told the operator nothing.
assert(refusal !== "Unexpected error", `the refusal explains itself rather than saying "Unexpected error" (got "${refusal}")`);
assert(/whole units/.test(refusal), `a fraction against a piece product is refused in words: "${refusal}"`);
await page.locator('[data-testid="tab-today"]').click();
await tab(page, "sell");
await page.waitForSelector(".products-pane");

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
// count() does not wait, and SellScreen renders "Loading catalog…" with no product buttons until
// its own fetch resolves — so counting straight after the tab click read the loading frame and saw
// 0 of 2. The pane only exists after the catalog is in hand, which is the same guard the Products
// screen already gave the assertions above.
await page.waitForSelector(".products-pane");
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

// ── 7 · 🔴 The DURABLE audit trail, read out of the real ledger ─────────────────────────────────
//
// Everything above went through the installed app's real IPC and real SQLite. This section is the
// evidence a unit test cannot give: that the operator's own clicks left an append-only, durable
// account of themselves in the real %APPDATA% ledger, and that it is still there after a restart.
// The app is CLOSED before this read — every other ledger read in this suite waits for that too.
{
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    const n = (sql) => Number(db.prepare(sql).get().n);
    // Was 5 before migration 6 (manual invoices). The version this build migrates a ledger TO is a
    // transition, not an invariant, so the old value is named here the way upgrade.mjs names its own.
    assert(n("SELECT max(version) AS n FROM schema_migrations") === 7, "the installed app's ledger is at schema v7");

    const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
    const types = rows.map((r) => r.event_type);
    // Two creations, one edit, one deactivation — exactly what was done on screen above.
    assert(
      types.filter((t) => t === "PRODUCT_CREATED").length === 2,
      `both typed products left a PRODUCT_CREATED row (${types.filter((t) => t === "PRODUCT_CREATED").length})`,
    );
    assert(types.includes("PRODUCT_UPDATED"), "the price edit left a PRODUCT_UPDATED row");
    assert(types.includes("PRODUCT_DEACTIVATED"), "the deactivation left a PRODUCT_DEACTIVATED row");
    // 🔴 ONE row per user action: the price edit did NOT also write PRICE_CHANGED / UNIT_CHANGED.
    assert(
      !types.includes("PRICE_CHANGED") && !types.includes("UNIT_CHANGED"),
      "no duplicate PRICE_CHANGED / UNIT_CHANGED rows — the price lives inside the diff",
    );

    assert(
      rows.every((r, i) => Number(r.seq) === i + 1),
      "seq is a gapless increasing sequence, which is the only ordering authority",
    );
    assert(
      rows.every((r) => r.actor_id === "cashier-01" && r.actor_name === "Cashier One"),
      "every row names the operator who did it",
    );
    assert(
      rows.every((r) => r.actor_tier === "unspecified"),
      "the actor tier is recorded as unknown rather than guessed (this build has no role model)",
    );

    // The real price edit, with its real old value — 4.00 became 9.00 on screen.
    const edit = rows.find((r) => r.event_type === "PRODUCT_UPDATED");
    const diff = JSON.parse(edit.changed_json);
    assert(
      diff.selling_price_minor?.before === "400" && diff.selling_price_minor?.after === "900",
      `the edit recorded 4.00 -> 9.00 as exact minor units (${JSON.stringify(diff.selling_price_minor)})`,
    );

    // No PIN, no hash, no token anywhere in the stored trail.
    const raw = JSON.stringify(rows);
    for (const needle of ["pin", "Pin", "PIN", "hash", "token", "secret", "1111"]) {
      assert(!raw.includes(needle), `the stored audit trail contains no '${needle}'`);
    }
  } finally {
    db.close();
  }
}

// ── 8 · 🔴 Append-only, enforced by SQLite in the installed app's own ledger ─────────────────────
{
  const db = new Database(LEDGER, { fileMustExist: true });
  try {
    let updateRejected = false;
    let deleteRejected = false;
    try {
      db.prepare("UPDATE audit_events SET actor_name = 'Someone Else'").run();
    } catch (err) {
      updateRejected = /append-only/.test(String(err.message));
    }
    try {
      db.prepare("DELETE FROM audit_events").run();
    } catch (err) {
      deleteRejected = /cannot be deleted/.test(String(err.message));
    }
    assert(updateRejected, "UPDATE on audit_events is rejected by the database itself");
    assert(deleteRejected, "DELETE on audit_events is rejected by the database itself");
    assert(
      db.prepare("SELECT count(*) AS n FROM audit_events").get().n > 0,
      "and the trail is still intact after both attempts",
    );
  } finally {
    db.close();
  }
}

log("product management E2E: all assertions passed");
log("screenshots in", SHOTS);
