// End-to-end: local catalog import through the REAL app (dialog → main → SQLite → IPC → renderer),
// an Arabic product sold through the UI, then a restart that must come back on the local catalog.
//
//   xvfb-run -a node e2e/catalog-import.mjs            (dev build, Linux)
//   E2E_EXECUTABLE="...\Alzabt POS.exe" node e2e/catalog-import.mjs   (installed app, Windows)
//
// Synthetic Arabic data and fake prices only — never merchant data. The native file dialog is
// stubbed inside the main process (the test cannot click an OS dialog); everything after the file
// is picked is the production path.
import { _electron as electron } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-catalog-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1" };
// 🔴 Tabs are selected by data-testid, NOT by their visible text. The terminal's default language
// is Arabic, so "Sell" / "History" / "Today's Sales" / "Tools" are no longer the rendered labels —
// an E2E that clicks by English name passes only while the UI happens to be English, which is
// exactly the kind of test that goes green for the wrong reason. The test id is language-neutral.
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

const HEADER = "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review";
const GOOD = join(home, "catalog.csv");
writeFileSync(
  GOOD,
  "﻿" +
    [HEADER, "1,بيبسي 330 مل,,1.00,USD,piece,0", "2,مياه,,0.50,USD,piece,0", '3,"علبة بسكويت 2""",,12.00,USD,box,0', "4,شيبس,,0.01,USD,piece,1"].join("\r\n") +
    "\r\n",
  "utf8",
);
const BAD = join(home, "bad.csv");
writeFileSync(BAD, [HEADER, "1,مياه,,$1.00,USD,piece,0"].join("\n") + "\n", "utf8");

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

const pickFile = (app, path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => [p];
  }, path);
const saveTo = (app, path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, path);
const tools = (page) => page.locator('[data-testid="tab-tools"]').click();
const EXPECTED = JSON.parse(readFileSync(join(APP, "dist", "build-info.json"), "utf8"));
const Database = createRequire(import.meta.url)("better-sqlite3");
const product = (page, name) => page.locator("button.product", { hasText: name });

// ── Run 1: import ───────────────────────────────────────────────────────────────────────────────
let { app, page } = await launch();
await product(page, "Espresso").waitFor({ state: "visible", timeout: 10000 });
assert(true, "fresh profile starts on the demo fixture");

const buildLine = (await page.getByTestId("build-line").innerText()).trim();
log("build line:", buildLine);
assert(buildLine === `Alzabt POS ${EXPECTED.version} · Build ${EXPECTED.build}`, "version and build are visible in the app");

await pickFile(app, BAD);
await tools(page);
await page.locator('[data-testid="import-catalog"]').click();
await page.waitForSelector("text=Catalog NOT imported");
assert(await page.locator(".import-report").getByText("Line 2").isVisible(), "a malformed price is rejected with its line number");
await page.getByRole("button", { name: "OK" }).click();
await page.locator('[data-testid="tab-sell"]').click();
await product(page, "Espresso").waitFor({ state: "visible", timeout: 10000 });
assert((await page.locator("button.product").count()) === 8, "rejected import changed nothing (8 demo products)");

await pickFile(app, GOOD);
await tools(page);
await page.locator('[data-testid="import-catalog"]').click();
await page.waitForSelector("text=Catalog imported");
const report = await page.locator(".import-report").innerText();
log("import report:", report.replace(/\s+/g, " "));
assert(/4 products in the file: 4 new/.test(report), "4 products imported");
assert(/1 products have a placeholder price/.test(report), "placeholder price flagged");
await page.getByRole("button", { name: "OK" }).click();
await page.waitForSelector("button.product");
assert((await product(page, "Espresso").count()) === 0, "demo fixture replaced by the local catalog");
assert((await page.locator("button.product").count()) === 4, "grid shows exactly the 4 imported products");

const names = await page.locator("button.product .product-name").allInnerTexts();
log("rendered names:", JSON.stringify(names));
assert(JSON.stringify(names) === JSON.stringify(["بيبسي 330 مل", "مياه", 'علبة بسكويت 2"', "شيبس"]), "Arabic names render exactly (SQLite → IPC → renderer)");
assert(
  (await product(page, "شيبس").locator('[data-testid="price-review"]').count()) === 1,
  "placeholder price is marked on the button",
);
// 🔴 EITHER LANGUAGE. The card's unit word is translated now — an Arabic terminal shows «علبة» —
// so pinning "box" would assert the translation rather than the fact the unit is shown at all.
const boxCard = (await product(page, "بسكويت").innerText()).replace(/\s+/g, " ");
assert(/\/\s*(box|علبة)/.test(boxCard), `box unit is shown ("${boxCard}")`);
await page.screenshot({ path: SHOTS + "catalog-01-imported.png" });

await page.locator("input.search").fill("مياه");
assert((await page.locator("button.product").count()) === 1, "Arabic search finds the product");
await product(page, "مياه").click();
await product(page, "مياه").click();
await page.locator("input.search").fill("");
await product(page, "بيبسي").click();
await product(page, "بسكويت").click();
const total = (await page.locator(".total strong").innerText()).trim();
assert(total === "14.00 USD", "cart: 2×0.50 + 1.00 + 12.00 = 14.00 USD");
await page.locator('[data-testid="complete-sale"]').click();
await page.locator('[data-testid="pay-cash"]').click();
await page.waitForSelector('[data-testid="receipt-number"]:has-text("#1")');
const receipt = await page.locator(".receipt-table").innerText();
assert(receipt.includes("مياه") && receipt.includes("بيبسي 330 مل") && receipt.includes('علبة بسكويت 2"'), "receipt shows the Arabic names");
await page.screenshot({ path: SHOTS + "catalog-02-receipt.png" });
await page.locator('[data-testid="new-sale"]').click();
await app.close();

// ── Run 2: restart ──────────────────────────────────────────────────────────────────────────────
({ app, page } = await launch());
assert((await page.locator("button.product").count()) === 4, "after restart the local catalog is still there");
assert((await product(page, "Espresso").count()) === 0, "after restart the fixture does not come back");
await page.locator('[data-testid="tab-history"]').click();
await page.waitForSelector(".history-table");
assert((await page.locator(".history-table tbody tr").count()) === 1, "after restart the sale is in history");
await page.locator('[data-testid="tab-today"]').click();
await page.waitForSelector('[data-testid="today-net"]');
const stats = await page.locator(".card.today").innerText();
assert(stats.includes("14.00 USD"), "today's sales show 14.00 USD after restart");

// ── Export catalog → re-import: nothing changes ────────────────────────────────────────────────
const EXPORT = join(home, "exported-catalog.csv");
await saveTo(app, EXPORT);
await tools(page);
await page.locator('[data-testid="export-catalog"]').click();
await page.waitForSelector("text=Catalog exported");
await page.getByRole("button", { name: "OK" }).click();
const exported = readFileSync(EXPORT, "utf8");
assert(exported.startsWith("\uFEFF") && exported.includes("بيبسي 330 مل") && exported.includes("4,شيبس,,0.01,USD,piece,1"), "exported CSV has a BOM and the Arabic names exactly");
await pickFile(app, EXPORT);
await page.locator('[data-testid="import-catalog"]').click();
await page.waitForSelector("text=Catalog imported");
const reimport = await page.locator(".import-report").innerText();
assert(/0 new, 0 updated, 4 unchanged/.test(reimport), "re-importing the exported file changes nothing");
await page.getByRole("button", { name: "OK" }).click();

// ── Export backup: a verified, consistent copy of the live ledger ──────────────────────────────
const BACKUP = join(home, "exported-backup.sqlite");
await saveTo(app, BACKUP);
await tools(page);
await page.locator('[data-testid="export-backup"]').click();
await page.waitForSelector("text=Backup exported");
await page.getByRole("button", { name: "OK" }).click();
await app.close();

const copy = new Database(BACKUP, { readonly: true });
const copySales = copy.prepare("SELECT count(*) AS n FROM sales").get().n;
const copyIntegrity = copy.pragma("integrity_check", { simple: true });
copy.close();
assert(copySales === 1 && copyIntegrity === "ok", "exported backup opens, passes integrity_check and holds the sale");

const profile = env.ALZABT_POS_USER_DATA;
const backups = readdirSync(join(profile, "backups"));
log("backups:", JSON.stringify(backups));
assert(backups.some((f) => /^daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)), "a daily backup was made automatically");
assert(!backups.some((f) => f.startsWith("pre-migration-")), "no pre-migration backup on a fresh ledger");
const logText = readFileSync(join(profile, "logs", "alzabt-pos.log"), "utf8");
assert(logText.includes('"event":"app-start"') && logText.includes(`"build":"${EXPECTED.build}"`), "the field log records start-up with the build");
assert(existsSync(join(profile, "ledger.json")), "the ledger marker was recorded");
assert(!/"pin":"\d/.test(logText), "no PIN in the log");
log("ALL CATALOG IMPORT E2E CHECKS PASSED");
