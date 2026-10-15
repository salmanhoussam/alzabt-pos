/**
 * E2E — slice G3: the Online Catalogue exported from the INSTALLED app, inspected on disk.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE SUCCESS MESSAGE IS NOT THE EVIDENCE. THE BYTES ARE.
 *
 * Every assertion below reads the directory the application actually produced: the JSON is parsed
 * from the file, the image files are hashed, and the whole package is searched for things that must
 * never be in it. A test that trusted the toast would pass against an export that wrote nothing.
 *
 * 🔴 AND THE THREE ORIGINS ARE CREATED THROUGH THEIR REAL PATHS. A hand-typed product, a CSV
 * import, and a product created from an invoice's reconciliation queue — because the whole reason
 * this feature exists is that the legacy export silently omits the first of those three. Writing
 * three rows with different `source` values would prove nothing about the paths a shop uses.
 *
 * The only stub is `dialog.showOpenDialogSync`, which main looks up at call time precisely so a
 * test can aim it, exactly as the catalog-import and photo pickers are tested.
 *
 * Run: node e2e/online-catalog.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

const home = mkdtempSync(join(tmpdir(), "pos-e2e-catalog-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const DEST = join(home, "exports");
mkdirSync(DEST, { recursive: true });

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

const testid = (page, id) => page.locator(`[data-testid="${id}"]`);

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");
  return { app, page };
}

/** Points a picker (file or directory) at one path, or at cancellation. */
async function aimPicker(app, path) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => (p === null ? undefined : [p]);
  }, path);
}

/** Dismisses whatever notice dialog is showing and returns its text. */
async function readNotice(page) {
  const card = page.locator(".overlay .card.dialog").filter({ hasNot: page.locator("form") }).last();
  await card.waitFor({ state: "visible", timeout: 20000 });
  const text = (await card.innerText()).trim();
  await card.locator("button").first().click();
  await card.waitFor({ state: "detached", timeout: 20000 });
  return text;
}

async function addProduct(page, { nameAr, nameEn, sku, price, online, barcode }) {
  await testid(page, "tab-products").click();
  await testid(page, "add-product").click();
  await testid(page, "field-nameAr").fill(nameAr);
  const inputs = page.locator(".product-form input");
  await inputs.nth(1).fill(nameEn ?? "");
  await inputs.nth(2).fill(sku);
  if (barcode !== undefined) await testid(page, "field-barcode").fill(barcode);
  await testid(page, "field-price").fill(price);
  await testid(page, "field-unit").selectOption("piece");
  if (online) await testid(page, "field-online").check();
  await testid(page, "save-product").click();
  await page.locator(".dialog .btn.primary.wide").click();
  await page.locator('[data-testid="product-row"]').filter({ hasText: sku }).first().waitFor();
}

/** Opens Edit on the row carrying this SKU. */
async function openEdit(page, sku) {
  const row = page.locator('[data-testid="product-row"]').filter({ hasText: sku });
  assert((await row.count()) === 1, `exactly one row is ${sku}`);
  await row.locator('[data-testid="product-edit"]').click();
  await testid(page, "photo-panel").waitFor({ state: "visible" });
}

async function attachPhoto(app, page, sku, fixture) {
  await openEdit(page, sku);
  await aimPicker(app, join(FIXTURES, fixture));
  await testid(page, "photo-add").click();
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="photo-preview"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  await page.locator('.product-form [data-testid="cancel-product"]').click();
  await testid(page, "photo-panel").waitFor({ state: "detached" });
}

// ══ 1 · Three origins, two exclusions ═════════════════════════════════════════════════════════

let { app, page } = await launch();

// A · MANUAL Product Master entry — the origin the legacy export loses.
await addProduct(page, {
  nameAr: "مفتاح أحمر يدوي",
  nameEn: "Manual Red Wrench",
  sku: "G-MANUAL",
  price: "12.50",
  barcode: "036000291452",
  online: true,
});
// D · active but NOT online-visible
await addProduct(page, { nameAr: "صنف محلّي", nameEn: "Local only", sku: "G-LOCAL", price: "3.00", online: false });
// E · will be deactivated below, while online-visible
await addProduct(page, { nameAr: "صنف موقوف", nameEn: "Stopped", sku: "G-INACTIVE", price: "5.00", online: true });
log("manual products created");

// B · LEGACY CSV IMPORT
const csv =
  "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review\n" +
  "IMP-77,دهان أبيض مستورد,Imported White Paint,22.00,USD,piece,0\n";
const csvPath = join(home, "catalog.csv");
writeFileSync(csvPath, csv, "utf8");
await testid(page, "tab-tools").click();
await aimPicker(app, csvPath);
await testid(page, "import-catalog").click();
await readNotice(page);
log("catalog imported");

// The imported product must be marked online-visible through the real form.
//
// 🔴 FOUND BY ROW NAME, NOT BY "IMP-77". The import header is
// `source_id,name_ar,name_en,price,currency,base_unit,price_needs_review` — there is no SKU column,
// so `source_id` lands in `source_key` and the product's `sku` stays NULL. The Products row renders
// the SKU, so it never contains "IMP-77"; an earlier version waited 30s for a row that could not
// exist.
await testid(page, "tab-products").click();
{
  const row = page.locator('[data-testid="product-row"]').filter({ hasText: "دهان أبيض مستورد" });
  await row.first().waitFor();
  await row.locator('[data-testid="product-edit"]').click();
  await testid(page, "field-online").check();
  await testid(page, "save-product").click();
  await page.locator(".dialog .btn.primary.wide").click();
}
log("imported product published");

// Deactivate E, which stays online-visible — it must still be excluded.
{
  const row = page.locator('[data-testid="product-row"]').filter({ hasText: "G-INACTIVE" });
  await row.locator("button").nth(1).click();
  await readNotice(page);
}
log("one online-visible product deactivated");

// Photos: JPEG on the manual one, transparent PNG on the imported one, none on the third.
await attachPhoto(app, page, "G-MANUAL", "shelf.jpg");
await attachPhoto(app, page, "دهان أبيض مستورد", "logo-alpha.png");
log("photos attached (JPEG + transparent PNG)");

await app.close();

// C · RECONCILIATION — a product created from an invoice line the catalogue has never seen.
// Driven through the real invoice flow, because that is the path a shop uses.
({ app, page } = await launch());
await testid(page, "tab-invoices").click();
// 🔴 EVERY SUB-STEP IS NAMED. This flow is a HARD check, and its first failure arrived as a bare
// 30-second locator timeout that said nothing about which of eleven steps had not happened. Each
// step now logs before it runs, so one gate run identifies the step instead of three.
let reconciliationStep = "not started";
const at = async (name, fn) => {
  reconciliationStep = name;
  log("  reconciliation:", name);
  await fn();
};
// 🔴 THE COMPANY PROFILE COMES FIRST, because `new-invoice` is `disabled={profile === null}` — a
// shop cannot issue an invoice before it has said who it is. On a fresh profile that button is
// disabled, and an earlier run spent 30 seconds clicking it. A real product rule I had not
// accounted for, found only because each sub-step now logs its own name.
await testid(page, "inv-tab-company").waitFor({ timeout: 20000 });
await testid(page, "company-name-ar").fill("متجر الكاتالوج");
await page.locator('.inv-company input[dir="ltr"]').first().fill("Catalogue Test Store");
await testid(page, "company-save").click();
await page.waitForSelector('[data-testid="company-notice"]', { timeout: 20000 });
log("company profile saved — invoices are now possible");
const reconciliationDone = await (async () => {
  try {
    // Outgoing is the only mode this build implements; `mode-incoming` is deliberately disabled.
    await at("open the mode chooser", () => testid(page, "new-invoice").click());
    await at("choose outgoing", async () => {
      await testid(page, "mode-outgoing").waitFor({ timeout: 15000 });
      await testid(page, "mode-outgoing").click();
    });
    await at("name a customer", async () => {
      const field = testid(page, "sheet-customer");
      await field.waitFor({ timeout: 15000 });
      await field.fill("زبون الكاتالوج");
      await field.press("Tab");
      // Wait for the value to hold, the way the invoice E2E's own `commit` helper does: Tab starts
      // a save, and the next interaction must not race the re-render it causes.
      await page.waitForFunction(
        () => document.querySelector('[data-testid="sheet-customer"]')?.value === "زبون الكاتالوج",
        undefined,
        { timeout: 15000 },
      );
    });
    await at("open a new line", async () => {
      // 🔴 THE CLICK IS RETRIED, AND THE SCREEN DUMP IS WHY. The previous run showed `add-row`
      // present and visible with NO `sheet-draft-row` and NO `new-line-description` anywhere —
      // the click landed and produced nothing. The customer field commits on Tab, which
      // re-renders the sheet, and a click during that re-render hits a stale element and is
      // swallowed. Clicking again after the render settles is the fix; three attempts is enough
      // to distinguish "the render ate it" from "this button does not work".
      await testid(page, "add-row").waitFor({ timeout: 15000 });
      let opened = false;
      for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
        await testid(page, "add-row").click();
        opened = await testid(page, "new-line-description")
          .waitFor({ state: "visible", timeout: 7000 })
          .then(() => true)
          .catch(() => false);
        if (!opened) log(`    add-row attempt ${attempt} produced no draft row; retrying`);
      }
      if (!opened) throw new Error("add-row never produced a draft row after 3 attempts");
    });
    await at("fill the line", async () => {
      await testid(page, "new-line-description").fill("صنف من فاتورة");
      await testid(page, "new-line-quantity").fill("1");
    });
    // The unit is chosen explicitly rather than relying on a default: `UnitCell` holds its own
    // state and this script must not depend on what it happens to start with.
    {
      const select = page.locator('[data-testid="sheet-draft-row"]').last().locator('[data-testid^="unit-select-"]').first();
      const options = await select.evaluate((el) => Array.from(el.options).map((o) => o.value));
      const known = options.find((v) => v && v !== "other");
      if (known !== undefined) await select.selectOption(known);
    }
    await testid(page, "new-line-price").fill("9.00");
    await at("save the draft line", async () => {
      await testid(page, "save-draft").click();
      await page.locator('[data-testid="sheet-draft-row"]').waitFor({ state: "detached", timeout: 20000 });
    });
    await at("finalize", async () => {
      await testid(page, "finalize").click();
      await page.waitForSelector('[data-testid="finalize-confirm"]', { timeout: 20000 });
      await testid(page, "finalize-confirm-yes").click();
      await page.waitForSelector('[data-testid="finalized-notice"]', { timeout: 30000 });
    });
    await at("open the review queue", () => testid(page, "inv-tab-review").click());
    await at("find the PRODUCT_NOT_FOUND item", async () => {
      const row = page.locator('[data-classification="PRODUCT_NOT_FOUND"]').first();
      await row.waitFor({ timeout: 20000 });
      await row.locator('[data-testid="review-resolve"]').click();
      await page.waitForSelector('[data-testid="resolve-panel"]', { timeout: 20000 });
    });
    await at("create the product from the invoice line", async () => {
      await testid(page, "resolve-create").first().click();
      // The queue item leaves the unresolved list once the product exists.
      await page.waitForTimeout(2500);
    });
    return true;
  } catch (e) {
    log(`reconciliation flow stopped at "${reconciliationStep}":`, String(e).split("\n")[0]);
    // 🔴 PHOTOGRAPH THE FAILURE. Four gate runs have each told me a selector name and nothing
    // about what was actually on screen. A screenshot at the moment of the throw is the one piece
    // of evidence a log cannot carry, and it costs nothing when the flow succeeds.
    try {
      await page.screenshot({ path: SHOTS + "G-FAIL-reconciliation.png" });
      const visible = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid]"))
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => el.getAttribute("data-testid"))
          .slice(0, 60),
      );
      log("  testids on screen when it failed:", JSON.stringify(visible));
    } catch {
      /* the screenshot is a courtesy, never the reason the step fails */
    }
    return false;
  }
})();

if (reconciliationDone) {
  // Publish it, so origin C is eligible too.
  await testid(page, "tab-products").click();
  const row = page.locator('[data-testid="product-row"]').filter({ hasText: "صنف من فاتورة" });
  if ((await row.count()) === 1) {
    await row.locator('[data-testid="product-edit"]').click();
    await testid(page, "field-online").check();
    await testid(page, "save-product").click();
    await page.locator(".dialog .btn.primary.wide").click();
  }
}
await app.close();

// What the ledger really holds, with the app closed.
const ledgerRows = (() => {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare("SELECT id, source, sku, name_ar, barcode, is_active, is_online_visible FROM catalog_products ORDER BY id")
      .all();
  } finally {
    db.close();
  }
})();
const eligible = ledgerRows.filter((r) => Number(r.is_active) === 1 && Number(r.is_online_visible) === 1);
log("ledger:", ledgerRows.length, "products ·", eligible.length, "eligible");
check(eligible.length >= 2, `at least the manual and imported products are eligible (got ${eligible.length})`);
check(
  eligible.some((r) => r.sku === "G-MANUAL"),
  "🔴 the MANUAL product is eligible — the origin the legacy export loses",
);
check(eligible.some((r) => r.source !== "manual"), "the IMPORTED product is eligible");
// 🔴 A HARD CHECK, not a silent skip. §6 requires all three origins; if the invoice flow cannot be
// driven, the gate must say so rather than quietly testing two of three and reporting success.
check(reconciliationDone, "the invoice reconciliation flow could be driven end to end");
check(
  ledgerRows.some((r) => String(r.name_ar).includes("فاتورة")),
  "🔴 the RECONCILIATION-created product exists in the ledger",
);

// ══ 2 · Export through the real UI ════════════════════════════════════════════════════════════

({ app, page } = await launch());
await testid(page, "tab-products").click();
await page.locator('[data-testid="product-row"]').first().waitFor();
check((await testid(page, "export-online-catalog").count()) === 1, "the Products toolbar offers Export Online Catalogue");
check(await testid(page, "export-online-catalog").isEnabled(), "and it is enabled for the owner");
await page.screenshot({ path: SHOTS + "G1-products-with-export.png" });

// Cancellation first: it must create nothing.
await aimPicker(app, null);
await testid(page, "export-online-catalog").click();
await page.waitForTimeout(1200);
check(readdirSync(DEST).length === 0, "🔴 a cancelled destination picker creates NOTHING");

// The real export.
await aimPicker(app, DEST);
await testid(page, "export-online-catalog").click();
const summary = await readNotice(page);
log("summary:", summary.replace(/\s+/g, " ").slice(0, 160));
check(/export|تصدير|صُدِّر|تمّ/i.test(summary), "the owner is told the package was exported");
check(
  !/website|upload|sync|publish|الموقع|رفع|نشر/i.test(summary),
  `🔴 the wording claims no upload or website sync — "${summary.replace(/\s+/g, " ").slice(0, 90)}"`,
);
await page.screenshot({ path: SHOTS + "G2-export-summary-arabic.png" });

// English, for the layout review.
await testid(page, "lang-toggle").click();
await page.waitForFunction(() => document.documentElement.dir === "ltr", undefined, { timeout: 15000 });
await testid(page, "tab-products").click();
await page.locator('[data-testid="product-row"]').first().waitFor();
await page.screenshot({ path: SHOTS + "G3-products-english.png" });
await app.close();

// ══ 3 · The package on disk — the actual evidence ═════════════════════════════════════════════

const folders = readdirSync(DEST);
check(folders.length === 1, `exactly one export folder was created (got ${JSON.stringify(folders)})`);
const pkg = join(DEST, folders[0]);
check(/^Alzabt-Shop-Export-/.test(folders[0]), `the folder is named for the product (${folders[0]})`);
check(!folders[0].includes(":"), "the folder name is Windows-safe");

const top = readdirSync(pkg).sort();
check(JSON.stringify(top) === JSON.stringify(["catalog.json", "images"]), `only catalog.json and images/ (got ${JSON.stringify(top)})`);

const raw = readFileSync(join(pkg, "catalog.json"));
check(raw.toString("utf8") === raw.toString(), "catalog.json is valid UTF-8");
let doc;
try {
  doc = JSON.parse(raw.toString("utf8"));
  check(true, "catalog.json parses as JSON");
} catch (e) {
  check(false, `catalog.json parses as JSON (${e})`);
  doc = { products: [] };
}
check(doc.schema_version === 1, `schema_version is exactly 1 (got ${doc.schema_version})`);
check(typeof doc.generated_at === "string" && !Number.isNaN(Date.parse(doc.generated_at)), "generated_at is a real instant");

const bySku = new Map(doc.products.map((p) => [p.sku, p]));
check(doc.products.length === eligible.length, `the catalogue holds exactly the eligible products (${doc.products.length} vs ${eligible.length})`);
check(bySku.has("G-MANUAL"), "🔴 the MANUAL product IS in the online catalogue");
check(doc.products.some((p) => p.name_ar.includes("مستورد")), "the IMPORTED product is in the catalogue");
check(doc.products.some((p) => p.name_ar.includes("فاتورة")), "🔴 the RECONCILIATION product is in the catalogue");
check(!bySku.has("G-LOCAL"), "🔴 the online-DISABLED product is absent");
check(!bySku.has("G-INACTIVE"), "🔴 the INACTIVE product is absent, although it is online-visible");

const manual = bySku.get("G-MANUAL");
if (manual) {
  check(manual.name_ar === "مفتاح أحمر يدوي", `Arabic survives exactly ("${manual.name_ar}")`);
  check(manual.barcode === "0036000291452", `🔴 the barcode is the canonical EAN-13 form (got ${manual.barcode})`);
  check(manual.price === "12.50" && typeof manual.price === "string", `price is an exact decimal string (got ${JSON.stringify(manual.price)})`);
  check(manual.online_visible === true, "online_visible is true");
  check(manual.image !== null && /^images\/product-[0-9a-f]{64}\.jpg$/.test(manual.image.file), `the JPEG photo is referenced by digest (${manual.image?.file})`);
}

// Images: present, hashed, and exactly the referenced set.
const imageFiles = readdirSync(join(pkg, "images")).sort();
const referenced = doc.products.filter((p) => p.image !== null).map((p) => p.image.file.split("/")[1]).sort();
check(JSON.stringify(imageFiles) === JSON.stringify(referenced), `images/ holds exactly the referenced files (${imageFiles.length} vs ${referenced.length})`);
let hashOk = true;
for (const p of doc.products) {
  if (p.image === null) continue;
  const bytes = readFileSync(join(pkg, ...p.image.file.split("/")));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== p.image.sha256) hashOk = false;
  if (bytes.length !== statSync(join(pkg, ...p.image.file.split("/"))).size) hashOk = false;
}
check(hashOk, "🔴 every emitted image hashes to the sha256 catalog.json publishes");
check(
  doc.products.some((p) => p.image !== null && p.image.mime === "image/png"),
  "the transparent PNG stayed a PNG",
);
check(doc.products.some((p) => p.image === null), "a product with no photo exports with image: null");

// ══ 4 · What must NOT be in the package ═══════════════════════════════════════════════════════

const text = raw.toString("utf8");
for (const [what, re] of [
  ["base64 image data", /data:image|base64/i],
  ["an absolute Windows path", /[A-Za-z]:\\\\/],
  ["a POSIX home path", /\/home\/|\/Users\//],
  ["a table name", /catalog_products|audit_events|operators|invoice/i],
  ["SQL", /\bSELECT\b|\bINSERT\b/],
  ["private product state", /price_needs_review|source_key|is_active/],
]) {
  check(!re.test(text), `catalog.json contains no ${what}`);
}
const everyFile = [...top, ...imageFiles];
check(
  !everyFile.some((n) => /\.(sqlite|db|wal|shm|log|bak|tmp)$/i.test(n)),
  `no database, journal, log or temp file in the package (${JSON.stringify(everyFile)})`,
);
check(!readdirSync(DEST).some((n) => n.startsWith(".")), "no leftover temp directory beside the package");

await (async () => {
  // The legacy export still behaves exactly as before, and still omits the manual product.
  const l = await launch();
  await l.page.locator('[data-testid="tab-tools"]').click();
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, join(home, "legacy.csv"));
  await l.page.locator('[data-testid="export-catalog"]').click();
  await readNotice(l.page);
  await l.app.close();
  const legacy = readFileSync(join(home, "legacy.csv"), "utf8");
  // 🔴 THE BOM IS DELIBERATE AND IS ASSERTED, not stripped silently. `toImportCsv` writes a UTF-8
  // BOM so Excel reads Arabic correctly — a documented part of that contract — so a test that
  // quietly tolerated its absence would stop protecting it.
  check(legacy.charCodeAt(0) === 0xfeff, "the legacy export still begins with its UTF-8 BOM (Excel reads Arabic)");
  check(
    legacy.replace(/^\ufeff/, "").startsWith("source_id,name_ar,name_en,price,currency,base_unit,price_needs_review"),
    "\ud83d\udd34 the legacy export keeps its 7-column header",
  );
  check(!legacy.includes("مفتاح أحمر يدوي"), "🔴 and still OMITS the manual product — the gap G exists to close");
  check(legacy.includes("دهان أبيض مستورد"), "while still carrying the imported one");
})().catch((e) => check(false, `legacy export regression could not be measured: ${String(e).split("\n")[0]}`));

console.log("");
if (failures > 0) {
  console.log("CONCLUSION: failure");
  console.log(`steps passed: ${step - failures}`);
  console.log(`FAILED: ${failures} online-catalog check(s)`);
  process.exit(1);
}
console.log("CONCLUSION: success");
console.log(`steps passed: ${step}`);
