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
//   Scenario D — the canonical current main build (68fdf03, schema v4, exact quantity) → this build:
//     node e2e/upgrade.mjs seed-v4
//     node e2e/upgrade.mjs verify-from-v4
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
// 🔴 Tabs by data-testid in THIS build, not by visible text: the terminal's default language is
// Arabic, so an E2E that clicks "Sell" or "History" would pass only while the UI happens to be
// English. But this script is the one E2E that also drives PREVIOUS RELEASES, to seed the ledger
// it then upgrades — and those builds shipped before the attribute existed, so they can only be
// driven by their visible text, which in them is always English. Hence both, chosen by what the
// running build actually has rather than by which phase we think we are in.
const TAB_IDS = { "Sell": "sell", "Today's Sales": "today", History: "history", Tools: "tools", Products: "products" };
const tab = async (page, name) => {
  await page.waitForSelector(".tabs button"); // the header is rendered in every build, old and new
  const byId = page.locator(`[data-testid="tab-${TAB_IDS[name]}"]`);
  if (await byId.count()) return byId.click();
  return page.getByRole("button", { name, exact: true }).click();
};
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

const totalText = async (page) => (await page.locator(".total strong").innerText()).trim();

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

/** sale_lines is `quantity` before migration 4 and `quantity_milli` after it. */
function lineColumns(db) {
  return db.prepare("PRAGMA table_info(sale_lines)").all().map((c) => c.name);
}
function lineQtyColumn(db) {
  return lineColumns(db).includes("quantity_milli") ? "l.quantity_milli" : "l.quantity";
}
function lineHasSaleUnit(db) {
  return lineColumns(db).includes("sale_unit");
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
      // Migration 4: the exact quantity, and how many lines honestly admit they do not know the
      // unit they were sold in (every line written before the migration).
      quantities: db
        .prepare(
          `SELECT ${lineQtyColumn(db)} AS q FROM sale_lines l JOIN sales s ON s.id = l.sale_id
            ORDER BY s.receipt_number, l.line_no`,
        )
        .all()
        .map((r) => Number(r.q)),
      unknownUnits: lineHasSaleUnit(db) ? n("SELECT count(*) AS n FROM sale_lines WHERE sale_unit IS NULL") : null,
      // Migration 5. `null` means the table does not exist yet, which is the honest answer for any
      // ledger a pre-v5 build wrote — never 0, which would claim an empty trail that is not there.
      audit: tables.includes("audit_events") ? n("SELECT count(*) AS n FROM audit_events") : null,
      auditTypes: tables.includes("audit_events")
        ? db
            .prepare("SELECT event_type AS t, count(*) AS n FROM audit_events GROUP BY event_type ORDER BY t")
            .all()
            .map((r) => `${r.t}=${Number(r.n)}`)
            .join(",")
        : null,
      integrity: db.pragma("integrity_check", { simple: true }),
    };
  } finally {
    db.close();
  }
}

/** Every audit row, oldest first. The app must be CLOSED. */
function auditRows() {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
  } finally {
    db.close();
  }
}

/** Proves the append-only triggers really are in the installed app's own ledger. */
function auditIsAppendOnly() {
  const db = new Database(LEDGER, { fileMustExist: true });
  try {
    const refused = (sql, pattern) => {
      try {
        db.prepare(sql).run();
        return false;
      } catch (err) {
        return pattern.test(String(err.message));
      }
    };
    return {
      update: refused("UPDATE audit_events SET actor_name = 'Someone Else'", /append-only/),
      delete: refused("DELETE FROM audit_events", /cannot be deleted/),
      intact: Number(db.prepare("SELECT count(*) AS n FROM audit_events").get().n),
    };
  } finally {
    db.close();
  }
}

/** A catalog product's stored base_unit, read from the ledger (the app must be closed). */
function productUnit(sku) {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT base_unit AS u FROM catalog_products WHERE sku = ?").get(sku);
    return row ? row.u : null;
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
  // Was `f.schema === 3`, then 4; migration 5 makes a v2 ledger land on v5 in ONE upgrade.
  assert(f.schema === 5 && f.integrity === "ok", `migrated to schema v5, integrity ok (got ${f.schema})`);
  // The audit table was created on the way, and starts empty — nothing is reconstructed.
  assert(f.audit === 0, `the durable audit trail exists and starts empty (got ${f.audit})`);
  // Two Espressos at 2.50 and one at 2.50, all WHOLE pieces, so every quantity scaled by 1000.
  assert(f.quantities.every((q) => q % 1000 === 0), `every migrated quantity is a whole number of units: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 2, `the 2 pre-migration lines keep an UNKNOWN unit (got ${f.unknownUnits})`);
  assert(JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1, "receipts 1,2 kept and 3 continues the sequence");
  const backups = backupFiles();
  log("backups:", JSON.stringify(backups));
  // The name carries the real span, and that span widened with each migration: v2→v3, v2→v4, now v2→v5.
  const pre = backups.find((b) => /^pre-migration-v2-to-v5-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a pre-migration backup was taken before v2→v5 (got ${JSON.stringify(backups)})`);
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
  // 🔴 INVERTED by migration 4. This used to assert that NO pre-migration backup existed, because
  // v3→v3 migrated nothing. v3→v4 is a real migration, so the backup is now mandatory — and it must
  // hold the OLD schema, which is the only thing that makes the migration recoverable.
  const pre3 = backupFiles().find((b) => /^pre-migration-v3-to-v5-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre3, `a pre-migration backup was taken before v3→v5 (got ${JSON.stringify(backupFiles())})`);
  const copy3 = new Database(join(DEFAULT_PROFILE, "backups", pre3), { readonly: true });
  const preCols = copy3.prepare("PRAGMA table_info(sale_lines)").all().map((c) => c.name);
  const preSchema3 = Number(copy3.prepare("SELECT max(version) AS n FROM schema_migrations").get().n);
  const preSales3 = Number(copy3.prepare("SELECT count(*) AS n FROM sales").get().n);
  copy3.close();
  assert(preSchema3 === 3 && preSales3 === 2, "the backup holds the OLD v3 ledger (2 sales)");
  assert(preCols.includes("quantity") && !preCols.includes("quantity_milli"), "the backup is recoverable at the PRE-migration-4 schema");

  // Migration 5 ran on the way, and left the trail EMPTY — measured HERE, before this phase does
  // anything that would legitimately write to it. The sale rung up above wrote nothing: migration 5
  // audits master data, not the sales ledger.
  const afterMigration = ledgerFacts();
  assert(afterMigration.schema === 5, `migrated to schema v5 (got ${afterMigration.schema})`);
  assert(afterMigration.audit === 0, `the durable audit trail exists and starts empty (got ${afterMigration.audit})`);

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
  // Was `f.schema === 3`, then 4.
  assert(f.schema === 5 && JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1 && f.catalog === 4 && f.integrity === "ok", `final ledger intact at v5 (got ${f.schema})`);
  // 🔴 And the export → re-import above is now AUDITED: exactly one CATALOG_IMPORTED summary and
  // ZERO product events, because the re-imported file is byte-identical and changed nothing. That
  // is the low-noise property the import audit model was chosen for, measured on the installed app.
  assert(f.audit === 1, `the re-import wrote exactly one audit row (got ${f.audit})`);
  assert(
    f.auditTypes === "CATALOG_IMPORTED=1",
    `and it is the summary alone, with no per-product events (got "${f.auditTypes}")`,
  );
  // TWO, not three: seed-v3's first sale is ONE line holding 2 x مياه (hence quantity_milli 2000),
  // and its second is one line. The third line is the sale this phase itself rang up, which does
  // carry its unit.
  assert(f.unknownUnits === 2, `the 2 pre-migration lines keep an UNKNOWN unit (got ${f.unknownUnits})`);
  assert(JSON.stringify(f.quantities) === "[2000,1000,1000]", `quantities: 2 x مياه scaled to 2000, the rest 1000 (got ${JSON.stringify(f.quantities)})`);
} else if (PHASE === "seed-main") {
  // Scenario C — the PRODUCT MANAGEMENT build (main, schema v3, manual products, Arabic default).
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await tab(page, "Tools");
  await page.getByRole("button", { name: "Import catalog" }).click();
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();

  // A product typed by hand on that build — the thing this scenario exists to preserve.
  await tab(page, "Products");
  await page.locator('[data-testid="add-product"]').click();
  await page.waitForSelector('[data-testid="field-nameAr"]');
  await page.locator('[data-testid="field-nameAr"]').fill("حبل قنب");
  const formInputs = page.locator(".product-form input");
  await formInputs.nth(1).fill("Hemp Rope");
  await formInputs.nth(2).fill("SYN-ROPE");
  await page.locator('[data-testid="field-price"]').fill("4.00");
  await page.locator('[data-testid="field-unit"]').selectOption("kg");
  await page.locator('[data-testid="save-product"]').click();
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length >= 1);

  await tab(page, "Sell");
  await page.waitForSelector("button.product");
  await sell(page, ["SYN-ROPE"], "Cash", 1); // the manual product, sold in WHOLE kg on the old build
  await sell(page, ["مياه"], "Card", 2);
  await voidCardSale(page);
  await page.screenshot({ path: SHOTS + "upgrade-c1-old-main.png" });
  await app.close();

  const f = ledgerFacts();
  log("ledger after seeding with the PRODUCT MANAGEMENT build:", JSON.stringify(f));
  assert(f.schema === 3, `the product-management build wrote schema v3 (got ${f.schema})`);
  assert(f.sales === 2 && f.voids === 1, "2 sales and 1 void");
  assert(f.unknownUnits === null, "that build's sale_lines has no sale_unit column at all");
} else if (PHASE === "verify-from-main") {
  let { app, page } = await launch();
  await assertBuildLine(page);

  // The manual product survived, with its unit and its price.
  await tab(page, "Products");
  await page.waitForSelector('[data-testid="product-row"]');
  const rows = await page.locator('[data-testid="product-row"]').allInnerTexts();
  const rope = rows.find((r) => r.includes("حبل قنب"));
  assert(rope, `the manually added product survived the upgrade (rows: ${rows.length})`);
  assert(rope.includes("SYN-ROPE") && rope.includes("4.00"), `its SKU and price survived: ${rope.replace(/\s+/g, " ")}`);
  // The unit LABEL is translated ("kg" renders as كيلو on an Arabic terminal), so the unit itself is
  // asserted from the ledger below, with the app closed.

  const h = await historyRows(page);
  assert(h.rows === 2 && h.voided === 1, "history after upgrade: both sales, the void preserved");
  await app.close(); // the ledger is read with the app CLOSED, as every other phase here does

  const f = ledgerFacts();
  log("ledger after the upgrade:", JSON.stringify(f));
  assert(f.schema === 5 && f.integrity === "ok", `migrated to schema v5, integrity ok (got ${f.schema})`);
  assert(f.audit === 0, `the durable audit trail exists and starts empty (got ${f.audit})`);
  assert(f.quantities.every((q) => q % 1000 === 0), `migrated quantities are whole: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 2, `both pre-migration lines keep an UNKNOWN unit (got ${f.unknownUnits})`);
  assert(productUnit("SYN-ROPE") === "kg", `the product's unit survived as kg (got ${productUnit("SYN-ROPE")})`);
  const pre = backupFiles().find((b) => /^pre-migration-v3-to-v5-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a pre-migration backup exists (got ${JSON.stringify(backupFiles())})`);

  // 🔴 And the point of the whole migration: a FRACTIONAL sale of that same product now works.
  ({ app, page } = await launch());
  await tab(page, "Sell");
  await page.waitForSelector("button.product");
  await product(page, "SYN-ROPE").click();
  const qty = page.locator('[data-testid^="qty-"]').first();
  await qty.fill("2.5");
  await qty.press("Enter");
  await page.waitForFunction(() => document.querySelector(".total strong")?.textContent?.includes("10.00"));
  assert((await totalText(page)).startsWith("10.00"), `2.5 kg at 4.00 totals 10.00 (got ${await totalText(page)})`);
  await page.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("button", { name: "Cash" }).click();
  await page.waitForSelector("text=Receipt #3");
  await page.screenshot({ path: SHOTS + "upgrade-c2-fractional.png" });
  await page.getByRole("button", { name: "New sale" }).click();
  await app.close();

  // It survives a restart, exactly as 2500 thousandths, with its unit recorded.
  ({ app, page } = await launch());
  const h2 = await historyRows(page);
  assert(h2.rows === 3 && h2.voided === 1, "after restart: the fractional sale joined the history");
  await app.close();
  const f2 = ledgerFacts();
  log("final ledger:", JSON.stringify(f2));
  assert(JSON.stringify(f2.quantities) === "[1000,1000,2500]", `the fractional quantity is stored exactly: ${JSON.stringify(f2.quantities)}`);
  assert(f2.unknownUnits === 2, "the new line records its unit; only the two legacy lines are unknown");
  assert(JSON.stringify(f2.receipts) === "[1,2,3]" && f2.integrity === "ok", "receipt sequence continued and the ledger is sound");
  // 🔴 A SALE writes no audit event. Migration 5 audits master data, not the sales ledger, which has
  // its own immutable semantics — so three sales and a void leave the trail exactly as it was.
  assert(f2.audit === 0, `selling does not write audit events (got ${f2.audit})`);
} else if (PHASE === "seed-v4") {
  // Scenario D — the canonical CURRENT MAIN build (68fdf03, schema v4: exact quantity + sale_unit,
  // and NO durable audit). This is the profile a shop would really be upgraded from.
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await tab(page, "Tools");
  await page.getByRole("button", { name: "Import catalog" }).click();
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();

  await tab(page, "Products");
  await page.locator('[data-testid="add-product"]').click();
  await page.waitForSelector('[data-testid="field-nameAr"]');
  await page.locator('[data-testid="field-nameAr"]').fill("حبل قنب");
  const formInputs = page.locator(".product-form input");
  await formInputs.nth(1).fill("Hemp Rope");
  await formInputs.nth(2).fill("SYN-ROPE");
  await page.locator('[data-testid="field-price"]').fill("4.00");
  await page.locator('[data-testid="field-unit"]').selectOption("kg");
  await page.locator('[data-testid="save-product"]').click();
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length >= 1);

  // A FRACTIONAL sale, which only this build onward can make — it must survive to v5 untouched.
  await tab(page, "Sell");
  await page.waitForSelector("button.product");
  await product(page, "SYN-ROPE").click();
  const qty = page.locator('[data-testid^="qty-"]').first();
  await qty.fill("2.5");
  await qty.press("Enter");
  await page.waitForFunction(() => document.querySelector(".total strong")?.textContent?.includes("10.00"));
  await page.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("button", { name: "Cash" }).click();
  await page.waitForSelector("text=Receipt #1");
  await page.getByRole("button", { name: "New sale" }).click();
  await sell(page, ["مياه"], "Card", 2);
  await voidCardSale(page);
  await page.screenshot({ path: SHOTS + "upgrade-d1-old-v4.png" });
  await app.close();

  const f = ledgerFacts();
  log("ledger after seeding with the CURRENT MAIN build:", JSON.stringify(f));
  assert(f.schema === 4, `the current main build wrote schema v4 (got ${f.schema})`);
  assert(f.sales === 2 && f.voids === 1, "2 sales and 1 void");
  assert(JSON.stringify(f.quantities) === "[2500,1000]", `the fractional quantity was stored exactly: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 0, "every line of a v4-written ledger records its sale unit");
  // 🔴 And the thing migration 5 adds: this build has no audit table at all.
  assert(f.audit === null, "the v4 build has no audit_events table — nothing to backfill from");
} else if (PHASE === "verify-from-v4") {
  let { app, page } = await launch();
  await assertBuildLine(page);

  // Everything the old build wrote is still there.
  await tab(page, "Products");
  await page.waitForSelector('[data-testid="product-row"]');
  const rows = await page.locator('[data-testid="product-row"]').allInnerTexts();
  const rope = rows.find((r) => r.includes("حبل قنب"));
  assert(rope, `the manually added product survived the upgrade (rows: ${rows.length})`);
  assert(rope.includes("SYN-ROPE") && rope.includes("4.00"), `its SKU and price survived: ${rope.replace(/\s+/g, " ")}`);
  const h = await historyRows(page);
  assert(h.rows === 2 && h.voided === 1, "history after upgrade: both sales, the void preserved");
  await app.close();

  const f = ledgerFacts();
  log("ledger after the v4 -> v5 upgrade:", JSON.stringify(f));
  assert(f.schema === 5 && f.integrity === "ok", `migrated to schema v5, integrity ok (got ${f.schema})`);
  assert(f.sales === 2 && f.voids === 1, "sales and voids untouched by migration 5");
  // 🔴 Migration 4's behaviour is unchanged: the fractional quantity is still exactly 2500.
  assert(JSON.stringify(f.quantities) === "[2500,1000]", `quantities untouched: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 0, "sale units untouched");
  assert(productUnit("SYN-ROPE") === "kg", `the product's unit survived as kg (got ${productUnit("SYN-ROPE")})`);
  // 🔴 The trail starts EMPTY. No pre-v5 history is invented out of the rotating logfile.
  assert(f.audit === 0, `the audit trail exists and starts empty (got ${f.audit})`);
  const pre = backupFiles().find((b) => /^pre-migration-v4-to-v5-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a verified pre-migration v4->v5 backup exists (got ${JSON.stringify(backupFiles())})`);

  // ── A real product mutation on the new build must leave a durable audit row ────────────────────
  ({ app, page } = await launch());
  await tab(page, "Products");
  await page.waitForSelector('[data-testid="product-row"]');
  const ropeRow = page.locator('[data-testid="product-row"]', { hasText: "SYN-ROPE" }).first();
  await ropeRow.getByRole("button").first().click();
  await page.waitForSelector('[data-testid="field-price"]');
  await page.locator('[data-testid="field-price"]').fill("6.00");
  await page.locator('[data-testid="save-product"]').click();
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();
  await page.waitForFunction(() => document.body.innerText.includes("6.00"));
  await page.screenshot({ path: SHOTS + "upgrade-d2-audited-edit.png" });
  await app.close();

  let audit = auditRows();
  assert(audit.length === 1, `the edit left exactly one audit row (got ${audit.length})`);
  assert(audit[0].event_type === "PRODUCT_UPDATED", `and it is a PRODUCT_UPDATED (got ${audit[0].event_type})`);
  assert(Number(audit[0].seq) === 1, "its seq starts at 1 on a freshly migrated ledger");
  assert(audit[0].actor_id === "cashier-01" && audit[0].actor_name === "Cashier One", "it names the operator");
  assert(audit[0].actor_tier === "unspecified", "and records the tier as unknown rather than guessing");
  const diff = JSON.parse(audit[0].changed_json);
  assert(
    diff.selling_price_minor?.before === "400" && diff.selling_price_minor?.after === "600",
    `it recorded 4.00 -> 6.00 exactly (${JSON.stringify(diff.selling_price_minor)})`,
  );
  assert(!JSON.stringify(audit).includes("PRICE_CHANGED"), "one user action is one row — no duplicate PRICE_CHANGED");

  // ── It survives a restart ──────────────────────────────────────────────────────────────────────
  ({ app, page } = await launch());
  await tab(page, "Products");
  await page.waitForSelector('[data-testid="product-row"]');
  await app.close();
  const afterRestart = auditRows();
  assert(afterRestart.length === 1 && afterRestart[0].id === audit[0].id, "the audit row survived a restart");

  // ── Append-only, in the installed app's real ledger ───────────────────────────────────────────
  const guard = auditIsAppendOnly();
  assert(guard.update, "UPDATE on audit_events is rejected by SQLite itself");
  assert(guard.delete, "DELETE on audit_events is rejected by SQLite itself");
  assert(guard.intact === 1, "and the trail is intact after both attempts");

  // ── A new catalog import produces the expected summary and entity rows ────────────────────────
  ({ app, page } = await launch());
  const cat2 = writeCatalog();
  await stub(app, "open", cat2.file);
  await tab(page, "Tools");
  await page.getByRole("button", { name: "Import catalog" }).click();
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();
  await app.close();

  audit = auditRows();
  const imported = audit.filter((r) => r.event_type === "CATALOG_IMPORTED");
  assert(imported.length === 1, `the re-import wrote exactly one CATALOG_IMPORTED summary (got ${imported.length})`);
  const meta = JSON.parse(imported[0].metadata_json);
  assert(meta.origin === "catalog_import" && /^[0-9a-f]{64}$/.test(meta.file_sha256), "its metadata names the file by digest");
  assert(typeof meta.row_count === "number" && meta.row_count > 0, `and the bounded counts (${JSON.stringify(meta)})`);
  // The identical file was imported again, so every catalogued row is unchanged: summary only.
  const sinceImport = audit.filter((r) => Number(r.seq) > 1);
  assert(
    sinceImport.length === 1 && sinceImport[0].event_type === "CATALOG_IMPORTED",
    `an identical re-import writes the summary and no product events (got ${sinceImport.map((r) => r.event_type).join(",")})`,
  );
  const f2 = ledgerFacts();
  log("final ledger:", JSON.stringify(f2));
  assert(f2.integrity === "ok" && f2.schema === 5, "the ledger is sound and still at v5");
  assert(JSON.stringify(f2.quantities) === "[2500,1000]", "no sale was disturbed by any of this");
} else {
  console.error(
    "usage: node e2e/upgrade.mjs seed-v2|verify-from-v2|seed-v3|verify-from-v3|seed-main|verify-from-main|seed-v4|verify-from-v4",
  );
  process.exit(2);
}
log(`UPGRADE PHASE ${PHASE} PASSED — profile ${DEFAULT_PROFILE}`);
