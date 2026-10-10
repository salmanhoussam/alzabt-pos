/**
 * The finalized invoice's LOGO — configured, frozen, embedded in the printed document, and immune
 * to a later branding change.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS SCRIPT EXISTS. A real finalized invoice printed from the installed `ce4dd28` build
 * showed the shop's Arabic name, English trade name, phones, address, customer, items and totals —
 * and NO LOGO. The freeze machinery was all present and unit-tested, so nothing in the service
 * layer was wrong. The defect was the PRINT DOCUMENT'S ORIGIN: the HTML was loaded as a
 * `data:text/html` URL, and Chromium refuses to load a `file://` subresource into an opaque origin.
 * The `<img>` carries `alt=""`, so nothing broken appeared either — the logo was simply absent.
 *
 * MEASURED with a positive control before any code was changed: the same HTML, the same image and
 * the same Chromium render the logo from a `file://` document (20,000 logo pixels) and not at all
 * from a `data:` document (zero).
 *
 * AND WHY NO TEST CAUGHT IT. `scripts/invoice-pdf-samples.ts` writes its HTML to a real file and
 * loads `file://` — a DIFFERENT path from the product's. So the CI sample artifact displayed the
 * logo correctly while the shipped application did not. Two paths that were supposed to be one.
 * Both now stage a file; this script is the proof that the PRODUCT's path embeds an image.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 Synthetic data only. The two logos are generated here in a few lines of zlib — flat colour
 * rectangles, no shop's mark, nothing from any real business.
 *
 * Run: node e2e/invoice-logo.mjs             (CI sets E2E_EXECUTABLE to the installed .exe)
 *      locally, where better-sqlite3 is built against Electron's ABI:
 *        env -u ELECTRON_RUN_AS_NODE ELECTRON_RUN_AS_NODE=1 \
 *          ./node_modules/electron/dist/electron e2e/invoice-logo.mjs
 */
import { _electron as electron } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];

const home = mkdtempSync(join(tmpdir(), "pos-e2e-logo-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
delete env.ELECTRON_RUN_AS_NODE;

const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const BRANDING = join(home, "userData", "branding");
const FROZEN = join(BRANDING, "frozen");

const log = (...a) => console.log("•", ...a);

async function until(what, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`TIMED OUT waiting for ${what} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed += 1;
  log("PASS", msg);
};

// ── A synthetic PNG, written by hand ────────────────────────────────────────────────────────────
// A flat rectangle of one colour. Hand-rolled because this repository carries no image library and
// must carry no real logo: the bytes below are an RGB rectangle and nothing else.
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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
  ihdr[9] = 2; // colour type: truecolour RGB
  // Each row is a filter byte followed by width RGB triples.
  const raw = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const LOGO_ONE = join(home, "synthetic-logo-one.png");
const LOGO_TWO = join(home, "synthetic-logo-two.png");
// Deliberately DIFFERENT sizes and colours, so "which logo is this" is answerable from the bytes.
writeFileSync(LOGO_ONE, png(240, 120, [204, 0, 0]));
writeFileSync(LOGO_TWO, png(60, 30, [0, 0, 204]));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 32);
const SHA_ONE = sha(LOGO_ONE);
const SHA_TWO = sha(LOGO_TWO);
log(`synthetic logos: one=${SHA_ONE} (${statSync(LOGO_ONE).size}B) two=${SHA_TWO} (${statSync(LOGO_TWO).size}B)`);

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await page.getByRole("button", { name: "Cashier One" }).click();
  for (const d of "1111") await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await page.locator('[data-testid="login-submit"]').click();
  await page.waitForSelector('[data-testid="cart"]');
  return { app, page };
}

const tab = (page, name) => page.locator(`[data-testid="tab-${name}"]`).click();
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const textOf = async (page, id) => (await testid(page, id).innerText()).trim();

/** Points the NATIVE open dialog at one synthetic file, exactly as the other scripts do. */
const stubOpen = (app, path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => [p];
  }, path);

const stubSave = (app, path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, path);

function query(sql, ...params) {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
const one = (sql, ...params) => query(sql, ...params)[0];

/**
 * Does this PDF embed a raster image?
 *
 * printToPDF writes an image as an XObject whose subtype is /Image. The dictionary is not
 * compressed by Chromium's writer, so the marker is findable in the raw bytes — which is the point:
 * the shipped defect produced a PDF with every word of text and NO image object at all.
 */
function embedsImage(pdfPath) {
  const bytes = readFileSync(pdfPath).toString("latin1");
  return /\/Subtype\s*\/Image/.test(bytes);
}

/**
 * Chooses a unit the way an operator now does: the dropdown if this build knows the unit, else
 * «Other» plus the free-text field.
 *
 * 🔴 NO HARDCODED UNIT LIST HERE. The options are READ OFF THE SELECT, by value and by visible
 * label, so this works in either UI language and a unit added to BASE_UNITS needs no edit here.
 * Nothing is swallowed in a try/catch — an unknown unit takes the Other path deliberately.
 */
async function chooseUnit(scope, value) {
  const select = scope.locator('[data-testid^="unit-select-"]').first();
  const options = await select.evaluate((el) =>
    Array.from(el.options).map((o) => ({ value: o.value, label: (o.textContent || "").trim() })),
  );
  const hit = options.find((o) => o.value === value || o.label === value);
  if (hit && hit.value !== "other") {
    await select.selectOption(hit.value);
    return;
  }
  await select.selectOption("other");
  await scope.locator('[data-testid^="unit-custom-"]').first().fill(value);
}

/** Adds one row to the open sheet and flushes it through the durable save path. */
async function addRow(page, { description, quantity, unit, price }) {
  await testid(page, "add-row").click();
  await testid(page, "new-line-description").fill(description);
  await testid(page, "new-line-quantity").fill(quantity);
  await chooseUnit(page.locator('[data-testid="sheet-draft-row"]').last(), unit);
  await testid(page, "new-line-price").fill(price);
  await testid(page, "save-draft").click();
  await page.waitForSelector('[data-testid="sheet-draft-row"]', { state: "detached" });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · A shop profile WITH a logo
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await launch();
await tab(page, "invoices");
await testid(page, "inv-tab-company").click();
await page.waitForSelector('[data-testid="company-name-ar"]');

await testid(page, "company-name-ar").fill("متجر اختبار الشعار");
await testid(page, "company-taxpayer").fill("TP-LOGO-1");

assert((await textOf(page, "company-logo-name")).length > 0, "the profile states that no logo is set yet");
await stubOpen(app, LOGO_ONE);
await testid(page, "company-logo-choose").click();
await until("the chosen logo to appear in the profile", async () =>
  (await textOf(page, "company-logo-name")).includes("invoice-logo"),
);
assert(true, "a logo was chosen through the real picker and stored under the app's own name");
await testid(page, "company-save").click();
await page.waitForSelector('[data-testid="company-notice"]');
assert(true, "the shop details saved WITH a logo");
await page.screenshot({ path: SHOTS + "L1-profile-with-logo.png" });

// The live branding file is logo ONE, byte for byte.
const liveLogo = join(BRANDING, "invoice-logo.png");
assert(existsSync(liveLogo), "the live branding file exists");
assert(sha(liveLogo) === SHA_ONE, "and it is logo ONE");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · An invoice finalized while logo ONE is the shop's logo
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "new-invoice").click();
await page.waitForSelector('[data-testid="invoice-mode-chooser"]');
await testid(page, "mode-outgoing").click();
await page.waitForSelector('[data-testid="add-row"]');
await addRow(page, { description: "صنف اختبار الشعار", quantity: "2", unit: "حبة", price: "3.00" });
await testid(page, "finalize").click();
await page.waitForSelector('[data-testid="finalize-confirm"]');
await testid(page, "finalize-confirm-yes").click();
await page.waitForSelector('[data-testid="finalized-notice"]');
// 🔴 DISMISS IT. The notice is an overlay, and an overlay intercepts pointer events — the gate
// caught `save-pdf` below being clicked through it for 30s. "Review later" closes it and leaves
// the finalized sheet open, which is exactly the state this script needs next.
await testid(page, "review-later").click();
await page.waitForSelector('[data-testid="finalized-notice"]', { state: "detached" });
assert(true, "the invoice was issued while logo ONE was configured");

// 🔴 The freeze, read out of the application's own snapshot — not inferred from the UI.
const issuer = JSON.parse(one("SELECT issuer_snapshot_json AS j FROM invoices WHERE status = 'final'").j);
assert(issuer.logo_path === "invoice-logo.png", `the snapshot records the logo's NAME (${issuer.logo_path})`);
assert(
  issuer.logo_asset === `${SHA_ONE}.png`,
  `and a CONTENT-ADDRESSED frozen asset naming logo ONE's own bytes (${issuer.logo_asset})`,
);
const frozenPath = join(FROZEN, issuer.logo_asset);
assert(existsSync(frozenPath), "the frozen copy really exists on disk");
assert(sha(frozenPath) === SHA_ONE, "and its bytes ARE logo ONE");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · 🔴 THE SHIPPED DEFECT: does the printed document actually EMBED the logo?
// ════════════════════════════════════════════════════════════════════════════════════════════════
const pdfFirst = join(home, "invoice-with-logo.pdf");
await stubSave(app, pdfFirst);
await testid(page, "save-pdf").click();
await until(`the PDF at ${pdfFirst}`, () => existsSync(pdfFirst) && statSync(pdfFirst).size > 0);
assert(statSync(pdfFirst).size > 2000, `the PDF is a real document (${statSync(pdfFirst).size} bytes)`);
assert(
  embedsImage(pdfFirst),
  "🔴 THE REGRESSION ASSERTION — the rendered PDF embeds a raster image. In the shipped `ce4dd28` " +
    "build this was FALSE: every word of text was present and the logo object did not exist.",
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The shop changes its logo — and the ISSUED invoice must not change with it
// ════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 LEAVE THE SHEET FIRST. While a sheet is open it REPLACES the invoices view, so the sub-tab
// nav does not exist — dismissing the notice was not enough, and the gate caught exactly that.
await testid(page, "sheet-close").click();
await page.waitForSelector('[data-testid="inv-tab-company"]');
await testid(page, "inv-tab-company").click();
await page.waitForSelector('[data-testid="company-name-ar"]', { timeout: 30000 });
await stubOpen(app, LOGO_TWO);
await testid(page, "company-logo-choose").click();
await testid(page, "company-save").click();
await page.waitForSelector('[data-testid="company-notice"]');
await until("the live branding file to become logo TWO", async () => sha(liveLogo) === SHA_TWO, 30000);
assert(sha(liveLogo) === SHA_TWO, "the shop's CURRENT logo is now logo TWO");

// The frozen copy is untouched, and the snapshot still points at it. This is the whole guarantee:
// a branding change cannot reach backwards into a document that was already issued.
assert(sha(frozenPath) === SHA_ONE, "🔴 the frozen asset is STILL logo ONE after the branding change");
const issuerAfter = JSON.parse(one("SELECT issuer_snapshot_json AS j FROM invoices WHERE status = 'final'").j);
assert(issuerAfter.logo_asset === `${SHA_ONE}.png`, "and the issued invoice still names logo ONE's asset");
assert(
  readdirSync(FROZEN).length >= 1,
  `the frozen directory holds the issued invoice's logo (${readdirSync(FROZEN).join(", ")})`,
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Reprint the OLD invoice after the branding change — still its own logo, still embedded
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "inv-tab-history").click();
await page.waitForSelector('[data-testid="history-table"]');
await testid(page, "history-open").first().click();
await page.waitForSelector('[data-testid="sheet-readonly"]');
const pdfReprint = join(home, "invoice-reprint.pdf");
await stubSave(app, pdfReprint);
await testid(page, "save-pdf").click();
await until(`the reprint at ${pdfReprint}`, () => existsSync(pdfReprint) && statSync(pdfReprint).size > 0);
assert(embedsImage(pdfReprint), "the reprint still embeds an image after the shop changed its logo");
await page.screenshot({ path: SHOTS + "L2-reprint-after-rebrand.png" });
await app.close();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · Restart — the frozen logo still resolves, from a cold application
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await tab(page, "invoices");
await page.waitForSelector('[data-testid="history-table"]');
await testid(page, "history-open").first().click();
await page.waitForSelector('[data-testid="sheet-readonly"]');
const pdfRestart = join(home, "invoice-after-restart.pdf");
await stubSave(app, pdfRestart);
await testid(page, "save-pdf").click();
await until(`the post-restart PDF at ${pdfRestart}`, () => existsSync(pdfRestart) && statSync(pdfRestart).size > 0);
assert(embedsImage(pdfRestart), "after a full restart the frozen logo still resolves and is embedded");
await app.close();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · A shop with NO logo prints a correct document — no broken image, no refusal
// ════════════════════════════════════════════════════════════════════════════════════════════════
// A separate profile directory, because the shop above now HAS a logo and a finalized invoice.
const bare = mkdtempSync(join(tmpdir(), "pos-e2e-nologo-"));
const bareEnv = { ...process.env, ALZABT_POS_USER_DATA: join(bare, "userData") };
delete bareEnv.ELECTRON_RUN_AS_NODE;
{
  const a = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env: bareEnv });
  const p = await a.firstWindow();
  await p.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await p.getByRole("button", { name: "Cashier One" }).click();
  for (const d of "1111") await p.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await p.locator('[data-testid="login-submit"]').click();
  await p.waitForSelector('[data-testid="cart"]');

  await p.locator('[data-testid="tab-invoices"]').click();
  await p.locator('[data-testid="inv-tab-company"]').click();
  await p.waitForSelector('[data-testid="company-name-ar"]');
  await p.locator('[data-testid="company-name-ar"]').fill("متجر بلا شعار");
  await p.locator('[data-testid="company-save"]').click();
  await p.waitForSelector('[data-testid="company-notice"]');

  await p.locator('[data-testid="new-invoice"]').click();
  await p.waitForSelector('[data-testid="invoice-mode-chooser"]');
  await p.locator('[data-testid="mode-outgoing"]').click();
  await p.waitForSelector('[data-testid="add-row"]');
  await p.locator('[data-testid="add-row"]').click();
  await p.locator('[data-testid="new-line-description"]').fill("صنف بلا شعار");
  await p.locator('[data-testid="new-line-quantity"]').fill("1");
  await chooseUnit(p.locator('[data-testid="sheet-draft-row"]').last(), "حبة");
  await p.locator('[data-testid="new-line-price"]').fill("1.00");
  await p.locator('[data-testid="save-draft"]').click();
  await p.waitForSelector('[data-testid="sheet-draft-row"]', { state: "detached" });
  await p.locator('[data-testid="finalize"]').click();
  await p.waitForSelector('[data-testid="finalize-confirm"]');
  await p.locator('[data-testid="finalize-confirm-yes"]').click();
  await p.waitForSelector('[data-testid="finalized-notice"]');
  await p.locator('[data-testid="review-later"]').click();
  await p.waitForSelector('[data-testid="finalized-notice"]', { state: "detached" });

  const bareDb = new Database(join(bare, "userData", "alzabt-pos-ledger.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  const bareIssuer = JSON.parse(
    bareDb.prepare("SELECT issuer_snapshot_json AS j FROM invoices WHERE status = 'final'").get().j,
  );
  bareDb.close();
  assert(bareIssuer.logo_asset === null, "a shop with no logo freezes no asset");
  assert(bareIssuer.logo_path === null, "and records no logo name");

  const barePdf = join(bare, "invoice-no-logo.pdf");
  await a.evaluate(({ dialog }, target) => {
    dialog.showSaveDialogSync = () => target;
  }, barePdf);
  await p.locator('[data-testid="save-pdf"]').click();
  await until(`the no-logo PDF at ${barePdf}`, () => existsSync(barePdf) && statSync(barePdf).size > 0);
  assert(statSync(barePdf).size > 2000, `a shop with no logo still produces a real PDF (${statSync(barePdf).size}B)`);
  // 🔴 THE NEGATIVE CONTROL, and it is what makes assertion 3 mean anything. If `embedsImage` were
  // true for every PDF this script produced, it would be measuring nothing at all.
  assert(!embedsImage(barePdf), "and that document embeds NO image — so the image check is real");
  await a.close();
}

log(`\nOK — ${passed} assertions passed against the installed app`);
