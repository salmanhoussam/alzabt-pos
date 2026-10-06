// Upgrade-preservation E2E: an existing installation with real data, then a NEW build installed over
// it. Runs against the REAL per-user profile the packaged app uses — no ALZABT_POS_USER_DATA
// override — because that is where a shop's ledger lives (%APPDATA%\Alzabt POS on Windows).
//
// The CI workflow installs builds in sequence and calls one phase per installed build:
//
//   Scenario A — the build verified at the shop (Gate 2.1, schema v2, demo catalog) → 0.1.1:
//     node e2e/upgrade.mjs seed-v2          (old build installed)
//     node e2e/upgrade.mjs verify-from-v2   (0.1.1 installed over it)
//   Scenario B — the field-pilot build (schema v3, imported catalog) → 0.1.1:
//     node e2e/upgrade.mjs seed-v3
//     node e2e/upgrade.mjs verify-from-v3
//
// E2E_EXECUTABLE is the installed exe. The script asserts the profile path it actually used and
// prints it, and reads the ledger file directly (app closed) for schema/backup evidence.
// Synthetic Arabic data and fake prices only.
import { _electron as electron } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PHASE = process.argv[2];
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_ARGS = PACKAGED ? [] : [process.env.E2E_APP_DIR ?? APP];
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const Database = createRequire(import.meta.url)("better-sqlite3");

// The REAL default profile. No override is passed to the app; this is only where we expect it.
const DEFAULT_PROFILE =
  process.platform === "win32"
    ? join(process.env.APPDATA ?? "", "Alzabt POS")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Alzabt POS");
const LEDGER = join(DEFAULT_PROFILE, "alzabt-pos-ledger.sqlite");
const env = { ...process.env };
delete env.ALZABT_POS_USER_DATA;

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await page.waitForSelector("text=Select cashier", { timeout: 30000 });
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  log("profile used by the app:", userData);
  assert(userData === DEFAULT_PROFILE, `the app uses the real default profile (${DEFAULT_PROFILE})`);
  await page.getByRole("button", { name: "Cashier One" }).click();
  for (const d of "1111") await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForSelector("text=Current sale");
  return { app, page };
}

const product = (page, name) => page.locator("button.product", { hasText: name });
// 🔴 Tabs by data-testid, not by visible text: the default terminal language is Arabic, so an E2E
// that clicks "Sell" or "History" would pass only while the UI happens to be English.
const TAB_IDS = { "Sell": "sell", "Today's Sales": "today", History: "history", Tools: "tools", Products: "products" };
const tab = (page, name) => page.locator(`[data-testid="tab-${TAB_IDS[name]}"]`).click();
const stub = (app, kind, path) =>
  app.evaluate(
    ({ dialog }, [k, p]) => {
      if (k === "open") dialog.showOpenDialogSync = () => [p];
      else dialog.showSaveDialogSync = () => p;
    },
    [kind, path],
  );

async function sell(page, items, method, expectReceipt) {
  for (const name of items) await product(page, name).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("button", { name: method }).click();
  await page.waitForSelector(`text=Receipt #${expectReceipt}`);
  await page.getByRole("button", { name: "New sale" }).click();
}

async function voidCardSale(page) {
  await tab(page, "History");
  await page.waitForSelector(".history-table");
  await page.locator("tr", { hasText: "card" }).getByRole("button", { name: "Void" }).click();
  await page.getByPlaceholder("e.g. wrong item rung up").fill("wrong item rung up");
  await page.getByRole("button", { name: "Confirm void" }).click();
  await page.waitForSelector("tr.voided");
}

async function stats(page) {
  await tab(page, "Today's Sales");
  await page.waitForSelector(".stats");
  const dts = await page.locator(".stats dt").allInnerTexts();
  const dds = await page.locator(".stats dd").allInnerTexts();
  return Object.fromEntries(dts.map((k, i) => [k.trim(), dds[i].trim()]));
}

async function historyRows(page) {
  await tab(page, "History");
  await page.waitForSelector(".history-table");
  return { rows: await page.locator(".history-table tbody tr").count(), voided: await page.locator("tr.voided").count() };
}

function ledgerFacts() {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    const n = (sql) => Number(db.prepare(sql).get().n);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    return {
      schema: n("SELECT max(version) AS n FROM schema_migrations"),
      sales: n("SELECT count(*) AS n FROM sales"),
      voids: n("SELECT count(*) AS n FROM voids"),
      receipts: db.prepare("SELECT receipt_number AS r FROM sales ORDER BY receipt_number").all().map((r) => Number(r.r)),
      catalog: tables.includes("catalog_products") ? n("SELECT count(*) AS n FROM catalog_products WHERE is_active = 1") : null,
      integrity: db.pragma("integrity_check", { simple: true }),
    };
  } finally {
    db.close();
  }
}

function backupFiles() {
  const dir = join(DEFAULT_PROFILE, "backups");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

const HEADER = "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review";
function writeCatalog() {
  const dir = mkdtempSync(join(tmpdir(), "pos-upgrade-"));
  const file = join(dir, "catalog.csv");
  writeFileSync(
    file,
    "﻿" +
      [HEADER, "1,بيبسي 330 مل,,1.00,USD,piece,0", "2,مياه,,0.50,USD,piece,0", '3,"علبة بسكويت 2""",,12.00,USD,box,0', "4,شيبس,,0.01,USD,piece,1"].join("\r\n") +
      "\r\n",
    "utf8",
  );
  return { dir, file };
}

function expectedBuild() {
  return JSON.parse(readFileSync(join(APP, "dist", "build-info.json"), "utf8"));
}

async function assertBuildLine(page) {
  const expected = expectedBuild();
  const line = (await page.getByTestId("build-line").innerText()).trim();
  log("build line:", line);
  assert(line === `Alzabt POS ${expected.version} · Build ${expected.build}`, "the upgraded app shows the new version and build");
}

// ── Phases ────────────────────────────────────────────────────────────────────────────────────

if (PHASE === "seed-v2") {
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  await sell(page, ["Espresso", "Espresso"], "Cash", 1);
  await sell(page, ["Water 500ml"], "Card", 2);
  await voidCardSale(page);
  await page.screenshot({ path: SHOTS + "upgrade-a1-old-v2.png" });
  await app.close();
  const f = ledgerFacts();
  log("ledger after seeding with the OLD build:", JSON.stringify(f));
  assert(f.schema === 2 && f.sales === 2 && f.voids === 1, "old build wrote schema v2 with 2 sales and 1 void");
} else if (PHASE === "verify-from-v2") {
  let { app, page } = await launch();
  await assertBuildLine(page);
  const h = await historyRows(page);
  assert(h.rows === 2 && h.voided === 1, "history after upgrade: both old sales, the void preserved");
  const s = await stats(page);
  assert(s["Completed sales"] === "2" && s["Voided sales"] === "1" && s["Net sales"] === "5.00 USD", "today's totals unchanged by the upgrade (net 5.00)");
  await tab(page, "Sell");
  await sell(page, ["Espresso"], "Cash", 3);
  await app.close();

  const f = ledgerFacts();
  log("ledger after upgrade + new sale:", JSON.stringify(f));
  assert(f.schema === 3 && f.integrity === "ok", "migrated to schema v3, integrity ok");
  assert(JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1, "receipts 1,2 kept and 3 continues the sequence");
  const backups = backupFiles();
  log("backups:", JSON.stringify(backups));
  const pre = backups.find((b) => /^pre-migration-v2-to-v3-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, "a pre-migration backup was taken before v2→v3");
  const copy = new Database(join(DEFAULT_PROFILE, "backups", pre), { readonly: true });
  const preSchema = Number(copy.prepare("SELECT max(version) AS n FROM schema_migrations").get().n);
  const preSales = Number(copy.prepare("SELECT count(*) AS n FROM sales").get().n);
  copy.close();
  assert(preSchema === 2 && preSales === 2, "the pre-migration backup holds the OLD v2 ledger (2 sales)");
  assert(backups.some((b) => /^daily-/.test(b)), "a daily backup exists");
  const logText = readFileSync(join(DEFAULT_PROFILE, "logs", "alzabt-pos.log"), "utf8");
  assert(logText.includes('"event":"migration-start"') && logText.includes('"event":"backup-pre-migration"'), "the log records the migration and its backup");
  assert(existsSync(join(DEFAULT_PROFILE, "ledger.json")), "the existing ledger was adopted (marker written)");

  // Restart, then the field-pilot catalog flow on the upgraded ledger.
  ({ app, page } = await launch());
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await tab(page, "Tools");
  await page.getByRole("button", { name: "Import catalog" }).click();
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: "OK" }).click();
  await page.waitForSelector("button.product");
  await sell(page, ["مياه", "بيبسي"], "Cash", 4);
  await app.close();

  ({ app, page } = await launch());
  const h2 = await historyRows(page);
  assert(h2.rows === 4 && h2.voided === 1, "after restart: all 4 sales and the void are there");
  await tab(page, "Sell");
  await page.waitForSelector("button.product");
  assert((await page.locator("button.product").count()) === 4 && (await product(page, "Espresso").count()) === 0, "the imported catalog is the live catalog after restart");
  const exportFile = join(cat.dir, "exported.csv");
  await stub(app, "save", exportFile);
  await tab(page, "Tools");
  await page.getByRole("button", { name: "Export catalog" }).click();
  await page.waitForSelector("text=Catalog exported");
  await page.getByRole("button", { name: "OK" }).click();
  await page.screenshot({ path: SHOTS + "upgrade-a2-after-0.1.1.png" });
  await app.close();
  assert(readFileSync(exportFile, "utf8").includes("2,مياه,,0.50,USD,piece,0"), "catalog export works on the upgraded installation");
  const f2 = ledgerFacts();
  assert(f2.sales === 4 && f2.catalog === 4 && f2.integrity === "ok", "final ledger: 4 sales, 4 products, integrity ok");
} else if (PHASE === "seed-v3") {
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await page.getByRole("button", { name: "Import catalog" }).click(); // the field-pilot build's header button
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: "OK" }).click();
  await page.waitForSelector("button.product");
  await sell(page, ["مياه", "مياه"], "Cash", 1);
  await sell(page, ["بيبسي"], "Card", 2);
  await voidCardSale(page);
  await page.screenshot({ path: SHOTS + "upgrade-b1-old-v3.png" });
  await app.close();
  const f = ledgerFacts();
  log("ledger after seeding with the FIELD-PILOT build:", JSON.stringify(f));
  assert(f.schema === 3 && f.sales === 2 && f.voids === 1 && f.catalog === 4, "field-pilot build wrote v3: 2 sales, 1 void, 4 products");
} else if (PHASE === "verify-from-v3") {
  let { app, page } = await launch();
  await assertBuildLine(page);
  await page.waitForSelector("button.product");
  assert((await page.locator("button.product").count()) === 4, "the imported catalog survived the upgrade");
  assert((await product(page, "Espresso").count()) === 0, "the demo fixture did not come back");
  const h = await historyRows(page);
  assert(h.rows === 2 && h.voided === 1, "history after upgrade: both sales, the void preserved");
  await tab(page, "Sell");
  await sell(page, ["بسكويت"], "Cash", 3);
  await app.close();
  assert(!backupFiles().some((b) => b.startsWith("pre-migration-")), "no migration was needed (v3→v3), so no pre-migration backup");

  ({ app, page } = await launch());
  const h2 = await historyRows(page);
  assert(h2.rows === 3 && h2.voided === 1, "after restart: old and new sales are all there");
  const dir = mkdtempSync(join(tmpdir(), "pos-upgrade-"));
  const exportFile = join(dir, "exported.csv");
  await stub(app, "save", exportFile);
  await tab(page, "Tools");
  await page.getByRole("button", { name: "Export catalog" }).click();
  await page.waitForSelector("text=Catalog exported");
  await page.getByRole("button", { name: "OK" }).click();
  await stub(app, "open", exportFile);
  await page.getByRole("button", { name: "Import catalog" }).click();
  await page.waitForSelector("text=Catalog imported");
  assert(/0 new, 0 updated, 4 unchanged/.test(await page.locator(".import-report").innerText()), "export → re-import changes nothing");
  await page.getByRole("button", { name: "OK" }).click();
  await page.screenshot({ path: SHOTS + "upgrade-b2-after-0.1.1.png" });
  await app.close();
  const f = ledgerFacts();
  log("final ledger:", JSON.stringify(f));
  assert(f.schema === 3 && JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1 && f.catalog === 4 && f.integrity === "ok", "final ledger intact");
} else {
  console.error("usage: node e2e/upgrade.mjs seed-v2|verify-from-v2|seed-v3|verify-from-v3");
  process.exit(2);
}
log(`UPGRADE PHASE ${PHASE} PASSED — profile ${DEFAULT_PROFILE}`);
