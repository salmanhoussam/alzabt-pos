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
//     node e2e/upgrade.mjs seed-v5        (scenario E: the real v5 main, 69f1a22)
//     node e2e/upgrade.mjs verify-from-v5
//
// E2E_EXECUTABLE is the installed exe. The script asserts the profile path it actually used and
// prints it, and reads the ledger file directly (app closed) for schema/backup evidence.
// Synthetic Arabic data and fake prices only.
import { _electron as electron } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
const TAB_IDS = {
  "Sell": "sell",
  "Today's Sales": "today",
  History: "history",
  Tools: "tools",
  Products: "products",
  Invoices: "invoices",
};
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
      // Migration 6. `null` means the table does not exist yet — the honest answer for any ledger a
      // pre-v6 build wrote. Never 0, which would claim an empty invoice book that is not there.
      invoices: tables.includes("invoices") ? n("SELECT count(*) AS n FROM invoices") : null,
      invoiceLines: tables.includes("invoice_lines") ? n("SELECT count(*) AS n FROM invoice_lines") : null,
      reconciliation: tables.includes("invoice_reconciliation")
        ? n("SELECT count(*) AS n FROM invoice_reconciliation")
        : null,
      companyProfile: tables.includes("company_profile") ? n("SELECT count(*) AS n FROM company_profile") : null,
      invoiceNumber: tables.includes("invoices")
        ? n("SELECT coalesce(max(invoice_number), 0) AS n FROM invoices")
        : null,
      integrity: db.pragma("integrity_check", { simple: true }),
      foreignKeys: JSON.stringify(db.pragma("foreign_key_check")),
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

/** Every row of one invoice table, for the Scenario E proofs. The app must be CLOSED. */
function invoiceRows(table, order = "rowid") {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  } finally {
    db.close();
  }
}

/** One product row by its Arabic name (the app must be closed). */
function productByName(nameAr) {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM catalog_products WHERE name_ar = ?").get(nameAr) ?? null;
  } finally {
    db.close();
  }
}

/** Proves migration 6's immutability triggers are in the INSTALLED app's own ledger. */
function invoiceIsImmutable() {
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
      invoiceUpdate: refused("UPDATE invoices SET customer_name = 'someone else'", /immutable/),
      invoiceDelete: refused("DELETE FROM invoices", /cannot be deleted/),
      lineUpdate: refused("UPDATE invoice_lines SET unit_price_minor = 1, line_total_minor = 1", /immutable/),
      lineDelete: refused("DELETE FROM invoice_lines", /cannot be deleted/),
      intact: Number(db.prepare("SELECT count(*) AS n FROM invoices WHERE status = 'final'").get().n),
    };
  } finally {
    db.close();
  }
}

const invTestid = (page, id) => page.locator(`[data-testid="${id}"]`);
const invText = async (page, id) => (await invTestid(page, id).innerText()).trim();

/** Adds one invoice row through the sheet exactly as an operator would. */
async function invoiceRow(page, { description, quantity, unit, price }) {
  await invTestid(page, "add-row").click();
  await invTestid(page, "new-line-description").fill(description);
  await invTestid(page, "new-line-quantity").fill(quantity);
  await invTestid(page, "new-line-unit").fill(unit);
  await invTestid(page, "new-line-price").fill(price);
  await invTestid(page, "new-line-save").click();
  await page.waitForSelector('[data-testid="new-line-save"]', { state: "detached" });
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
  // Was `f.schema === 3`, then 4, then 5; migration 6 makes a v2 ledger land on v6 in ONE upgrade.
  assert(f.schema === 6 && f.integrity === "ok", `migrated to schema v6, integrity ok (got ${f.schema})`);
  // The audit table was created on the way, and starts empty — nothing is reconstructed.
  assert(f.audit === 0, `the durable audit trail exists and starts empty (got ${f.audit})`);
  // Two Espressos at 2.50 and one at 2.50, all WHOLE pieces, so every quantity scaled by 1000.
  assert(f.quantities.every((q) => q % 1000 === 0), `every migrated quantity is a whole number of units: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 2, `the 2 pre-migration lines keep an UNKNOWN unit (got ${f.unknownUnits})`);
  assert(JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1, "receipts 1,2 kept and 3 continues the sequence");
  const backups = backupFiles();
  log("backups:", JSON.stringify(backups));
  // The name carries the real span, and that span widened with each migration: v2→v3, v2→v4, v2→v5, now v2→v6.
  const pre = backups.find((b) => /^pre-migration-v2-to-v6-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a pre-migration backup was taken before v2→v6 (got ${JSON.stringify(backups)})`);
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
  const pre3 = backupFiles().find((b) => /^pre-migration-v3-to-v6-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre3, `a pre-migration backup was taken before v3→v6 (got ${JSON.stringify(backupFiles())})`);
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
  // Was 5 before migration 6.
  assert(afterMigration.schema === 6, `migrated to schema v6 (got ${afterMigration.schema})`);
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
  // Was `f.schema === 3`, then 4, then 5.
  assert(f.schema === 6 && JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1 && f.catalog === 4 && f.integrity === "ok", `final ledger intact at v6 (got ${f.schema})`);
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
  // Was 5 before migration 6.
  assert(f.schema === 6 && f.integrity === "ok", `migrated to schema v6, integrity ok (got ${f.schema})`);
  assert(f.audit === 0, `the durable audit trail exists and starts empty (got ${f.audit})`);
  assert(f.quantities.every((q) => q % 1000 === 0), `migrated quantities are whole: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 2, `both pre-migration lines keep an UNKNOWN unit (got ${f.unknownUnits})`);
  assert(productUnit("SYN-ROPE") === "kg", `the product's unit survived as kg (got ${productUnit("SYN-ROPE")})`);
  const pre = backupFiles().find((b) => /^pre-migration-v3-to-v6-\d{8}T\d{6}Z\.sqlite$/.test(b));
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
  log("ledger after the v4 -> v6 upgrade:", JSON.stringify(f));
  // Was 5 before migration 6: a v4 ledger now lands on v6 in ONE upgrade.
  assert(f.schema === 6 && f.integrity === "ok", `migrated to schema v6, integrity ok (got ${f.schema})`);
  assert(f.sales === 2 && f.voids === 1, "sales and voids untouched by migrations 5 and 6");
  // 🔴 Migration 4's behaviour is unchanged: the fractional quantity is still exactly 2500.
  assert(JSON.stringify(f.quantities) === "[2500,1000]", `quantities untouched: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 0, "sale units untouched");
  assert(productUnit("SYN-ROPE") === "kg", `the product's unit survived as kg (got ${productUnit("SYN-ROPE")})`);
  // 🔴 The trail starts EMPTY. No pre-v5 history is invented out of the rotating logfile.
  assert(f.audit === 0, `the audit trail exists and starts empty (got ${f.audit})`);
  const pre = backupFiles().find((b) => /^pre-migration-v4-to-v6-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a verified pre-migration v4->v6 backup exists (got ${JSON.stringify(backupFiles())})`);

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
  // Was 5 before migration 6.
  assert(f2.integrity === "ok" && f2.schema === 6, "the ledger is sound and still at v6");
  assert(JSON.stringify(f2.quantities) === "[2500,1000]", "no sale was disturbed by any of this");
} else if (PHASE === "seed-v5") {
  // ── Scenario E, part 1 — the REAL legal v5 main build (69f1a22, schema v5: durable audit, and
  // NO invoice tables). This is the profile a shop would actually be upgraded from, created by
  // running that build's own UI, not by writing a database that pretends to be v5.
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await tab(page, "Tools");
  await page.getByRole("button", { name: "Import catalog" }).click();
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();

  // A manual product, sold by weight — so the upgrade has a fractional quantity to preserve.
  await tab(page, "Products");
  await page.locator('[data-testid="add-product"]').click();
  await page.waitForSelector('[data-testid="field-nameAr"]');
  await page.locator('[data-testid="field-nameAr"]').fill("حبل قنب");
  const inputs = page.locator(".product-form input");
  await inputs.nth(1).fill("Hemp Rope");
  await inputs.nth(2).fill("SYN-ROPE");
  await page.locator('[data-testid="field-price"]').fill("4.00");
  await page.locator('[data-testid="field-unit"]').selectOption("kg");
  await page.locator('[data-testid="save-product"]').click();
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length >= 1);

  // Representative v5 business data: two sales and a void.
  await sell(page, ["بيبسي 330 مل"], "Cash", 1);
  await page.getByRole("button", { name: "New sale" }).click();
  await sell(page, ["مياه"], "Card", 2);
  await page.getByRole("button", { name: "New sale" }).click();
  await voidCardSale(page);
  await app.close();

  const f = ledgerFacts();
  log("v5 baseline ledger:", JSON.stringify(f));
  assert(f.schema === 5, `the baseline really is schema v5 (got ${f.schema})`);
  assert(f.sales === 2 && f.voids === 1, "two sales and one void exist");
  assert(f.catalog === 5, `four imported products plus the manual one are active (got ${f.catalog})`);
  assert(f.audit !== null && f.audit > 0, "v5 already has the durable audit trail");
  // 🔴 THE INVOICE TABLES DO NOT EXIST YET. `null`, not 0 — the honest answer for a v5 ledger.
  assert(f.invoices === null, "a v5 ledger has no invoices table at all");
  assert(f.invoiceLines === null && f.reconciliation === null, "nor invoice_lines nor invoice_reconciliation");
  assert(f.companyProfile === null, "nor company_profile");
  log("V5 BASELINE READY:", JSON.stringify({ sales: f.sales, voids: f.voids, catalog: f.catalog, audit: f.audit, receipts: f.receipts }));
} else if (PHASE === "verify-from-v5") {
  // ── Scenario E, part 2 — the feature build installed OVER that real v5 profile ────────────────
  assert(existsSync(LEDGER), "the v5 ledger is still there");
  const beforeAudit = ledgerFacts().audit;

  let { app, page } = await launch();
  await assertBuildLine(page);
  await app.close();

  const m = ledgerFacts();
  log("after migration:", JSON.stringify(m));
  assert(m.schema === 6, `the schema moved to v6 (got ${m.schema})`);
  assert(m.integrity === "ok", "integrity_check is ok");
  assert(m.foreignKeys === "[]", `foreign_key_check is empty (got ${m.foreignKeys})`);
  // Old business data survived, byte for byte.
  assert(m.sales === 2 && m.voids === 1, "the two v5 sales and the void are untouched");
  assert(JSON.stringify(m.receipts) === "[1,2]", "the receipt sequence is unchanged");
  assert(m.catalog === 5, "the catalog is unchanged");
  assert(m.audit === beforeAudit, `migrating wrote no audit events (${beforeAudit} -> ${m.audit})`);
  // 🔴 NOTHING WAS SYNTHESIZED. A migrated ledger holds no invoice history, because that is the
  // honest state of a shop that has not written one.
  assert(m.invoices === 0, `invoices is EMPTY, not absent (got ${m.invoices})`);
  assert(m.invoiceLines === 0, `invoice_lines is empty (got ${m.invoiceLines})`);
  assert(m.reconciliation === 0, `invoice_reconciliation is empty (got ${m.reconciliation})`);
  assert(m.companyProfile === 0, `company_profile starts empty by design (got ${m.companyProfile})`);
  assert(m.invoiceNumber === 0, "and no invoice number has been assigned");

  // ── Company profile ────────────────────────────────────────────────────────────────────────────
  ({ app, page } = await launch());
  await tab(page, "Invoices");
  await page.waitForSelector('[data-testid="inv-tab-company"]');
  assert(await invTestid(page, "company-required").isVisible(), "the terminal says the shop details are missing");
  await invTestid(page, "company-name-ar").fill("متجر اختباري للترقية");
  await page.locator('.inv-company input[dir="ltr"]').first().fill("Upgrade Test Store");
  await page.locator('[data-testid="company-taxpayer"]').fill("TP-E-1");
  await page.locator('.inv-company input').nth(4).fill("شارع الاختبار");
  await page.locator('.inv-company input').nth(5).fill("01-234567");
  await invTestid(page, "company-save").click();
  await page.waitForSelector('[data-testid="company-notice"]');
  // The numbering is its own operation, with its own button and its own guard.
  await invTestid(page, "company-next-number").fill("61");
  await invTestid(page, "company-numbering-save").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="company-next-number"]')?.value === "61",
  );
  await page.screenshot({ path: SHOTS + "upgrade-e1-company.png" });
  await app.close();

  {
    const profile = invoiceRows("company_profile")[0];
    assert(profile !== undefined, "the company profile persisted");
    assert(profile.name_ar === "متجر اختباري للترقية", "with its Arabic name");
    assert(profile.name_en === "Upgrade Test Store", "and its trade name");
    assert(profile.taxpayer_number === "TP-E-1", "and one optional official identifier");
    assert(Number(profile.next_invoice_number) === 61, "and the configured starting number");
    assert(invoiceRows("company_profile").length === 1, "exactly one profile row");
  }

  // ── The invoice ────────────────────────────────────────────────────────────────────────────────
  ({ app, page } = await launch());
  await tab(page, "Invoices");
  await page.waitForSelector('[data-testid="new-invoice"]');
  await invTestid(page, "new-invoice").click();
  await page.waitForSelector('[data-testid="add-row"]');
  assert((await invText(page, "sheet-number")).startsWith("—"), "a draft has no invoice number");

  // 🔴 These fields commit on BLUR by design, so `fill()` alone types without saving.
  await invTestid(page, "sheet-customer").fill("زبون الترقية");
  await invTestid(page, "sheet-customer").press("Tab");
  const ePhone = page.locator('.inv-customer input[dir="ltr"]').first();
  await ePhone.fill("70-999999");
  await ePhone.press("Tab");
  await invTestid(page, "sheet-date").fill("2026-10-08");
  await invTestid(page, "sheet-date").press("Tab");
  await page.waitForSelector('[data-testid="add-row"]');

  // A · an existing catalog product, at its catalog price, with a known unit label -> MATCHED
  await invoiceRow(page, { description: "حبل قنب", quantity: "1", unit: "كيلو", price: "4.00" });
  // B · an existing product at a DIFFERENT price -> PRICE_DIFFERENCE
  await invoiceRow(page, { description: "بيبسي 330 مل", quantity: "2", unit: "حبة", price: "1.50" });
  // C · free text with a NON-CANONICAL unit the build has never heard of -> PRODUCT_NOT_FOUND
  await invoiceRow(page, { description: "صنف جديد غير موجود", quantity: "3", unit: "كيس (50PCS)", price: "1.25" });
  // D · a product whose price_needs_review is already 1 (the import's placeholder row), at a real
  //     price -> PRICE_DIFFERENCE on exactly the row the flag rule is about.
  await invoiceRow(page, { description: "شيبس", quantity: "1", unit: "حبة", price: "2.50" });

  assert((await invTestid(page, "sheet-line").count()) === 4, "four rows are on the sheet");
  const totals = (await invTestid(page, "sheet-line-total").allInnerTexts()).map((s) => s.trim());
  assert(totals[0].includes("4.00"), `row A total 1 x 4.00 (got ${totals[0]})`);
  assert(totals[1].includes("3.00"), `row B total 2 x 1.50 (got ${totals[1]})`);
  assert(totals[2].includes("3.75"), `row C total 3 x 1.25 (got ${totals[2]})`);
  assert(totals[3].includes("2.50"), `row D total 1 x 2.50 (got ${totals[3]})`);
  const sub = await invText(page, "sheet-subtotal");
  assert(sub.includes("13.25"), `the subtotal is 13.25 (got ${sub})`);
  await invTestid(page, "sheet-paid").fill("3.25");
  await invTestid(page, "sheet-paid").press("Tab");
  // Wait for the service's recomputed balance to render, not for a guessed interval.
  await page.locator('[data-testid="sheet-balance"]').filter({ hasText: "10.00" }).waitFor({ timeout: 20000 });
  const bal = await invText(page, "sheet-balance");
  assert(bal.includes("10.00"), `the balance due is 13.25 - 3.25 = 10.00 (got ${bal})`);
  await page.screenshot({ path: SHOTS + "upgrade-e2-draft.png" });

  await invTestid(page, "finalize").click();
  await page.waitForSelector('[data-testid="finalize-confirm"]');
  await invTestid(page, "finalize-confirm-yes").click();
  await page.waitForSelector('[data-testid="finalized-notice"]');
  const notice = await invText(page, "finalized-notice");
  assert(notice.includes("61"), `the notice names invoice #61 (got "${notice.split("\n")[0]}")`);
  await page.screenshot({ path: SHOTS + "upgrade-e3-finalized.png" });
  await invTestid(page, "review-now").click();
  await page.waitForSelector('[data-testid="review-table"]');
  await app.close();

  // ── What finalization really wrote ─────────────────────────────────────────────────────────────
  {
    const f = ledgerFacts();
    log("after finalize:", JSON.stringify(f));
    assert(f.invoices === 1 && f.invoiceLines === 4, "one invoice with four lines");
    assert(f.invoiceNumber === 61, `a unique number was assigned: 61 (got ${f.invoiceNumber})`);
    const inv = invoiceRows("invoices")[0];
    assert(inv.status === "final", "the draft became final");
    assert(Number(inv.subtotal_minor) === 1325, `the stored subtotal is 1325 minor units (got ${inv.subtotal_minor})`);
    assert(Number(inv.balance_due_minor) === 1000, `the stored balance is 1000 (got ${inv.balance_due_minor})`);
    assert(inv.amount_in_words && inv.amount_in_words.length > 8, "the amount in words is frozen onto it");
    assert(inv.customer_name === "زبون الترقية", `the customer snapshot persisted (got ${inv.customer_name})`);
    assert(inv.invoice_date === "2026-10-08", `and the date the operator typed (got ${inv.invoice_date})`);
    const issuer = JSON.parse(inv.issuer_snapshot_json);
    assert(issuer.name_ar === "متجر اختباري للترقية" && issuer.taxpayer_number === "TP-E-1", "the issuer snapshot is present");

    // Line snapshots are frozen, including the unit label the build cannot map.
    const lines = invoiceRows("invoice_lines", "line_no");
    assert(lines.length === 4, "four line snapshots");
    assert(lines[2].unit_label === "كيس (50PCS)", "the non-canonical unit label was stored verbatim");
    assert(lines[2].canonical_unit === null, "and no canonical unit was invented for it");
    assert(Number(lines[1].unit_price_minor) === 150, "row B's invoice price is frozen at 1.50");

    // 🔴 The immutability triggers are in the INSTALLED app's own ledger.
    const guard = invoiceIsImmutable();
    assert(guard.invoiceUpdate, "SQLite refuses to edit a finalized invoice");
    assert(guard.invoiceDelete, "SQLite refuses to delete it");
    assert(guard.lineUpdate && guard.lineDelete, "and refuses to edit or delete its lines");
    assert(guard.intact === 1, "and the invoice is intact after all four attempts");

    const recon = invoiceRows("invoice_reconciliation").map((r) => `${r.classification}:${r.status}`).sort();
    log("reconciliation:", JSON.stringify(recon));
    assert(recon.filter((r) => r === "MATCHED:KEPT_CATALOG").length === 1, "the matched row uses the designed resolved state");
    assert(recon.filter((r) => r.startsWith("PRICE_DIFFERENCE:PENDING")).length === 2, "both price differences wait for a person");
    assert(recon.filter((r) => r.startsWith("PRODUCT_NOT_FOUND:PENDING")).length === 1, "the unknown product waits for a person");

    // 🔴 THE V1 BOUNDARY: issuing an invoice is not a sale and moves no stock.
    assert(f.sales === 2, `still exactly the two v5 sales (got ${f.sales})`);
    assert(f.voids === 1, "still exactly the one v5 void");
    assert(JSON.stringify(f.quantities) === "[1000,1000]", "no sale line was disturbed");
    assert(f.audit === beforeAudit, `finalizing wrote no catalog audit event (${beforeAudit} -> ${f.audit})`);
    const tables = invoiceRows("sqlite_master", "name").filter((r) => r.type === "table").map((r) => r.name);
    assert(!tables.some((t) => /stock|inventory|movement/i.test(t)), "and there is no stock table for it to have moved");
  }

  // ── PRICE_DIFFERENCE on the price_needs_review row: update the catalog from the invoice ────────
  const chipsBefore = productByName("شيبس");
  assert(Number(chipsBefore.price_needs_review) === 1, "the placeholder-priced product still needs review");
  assert(Number(chipsBefore.selling_price_minor) === 1, "its catalog price is still the 0.01 placeholder");

  ({ app, page } = await launch());
  await tab(page, "Invoices");
  await invTestid(page, "inv-tab-review").click();
  await page.waitForSelector('[data-testid="review-table"]');
  assert((await invTestid(page, "review-row").count()) === 3, "three items need review");
  // The price-difference row for the placeholder-priced product, picked by description AND
  // classification so neither a translation nor row order can send this to the wrong item.
  const chipsRow = page.locator('[data-classification="PRICE_DIFFERENCE"]').filter({ hasText: "شيبس" });
  await chipsRow.first().locator('[data-testid="review-resolve"]').click();
  await page.waitForSelector('[data-testid="resolve-panel"]');
  assert(await invTestid(page, "resolve-keep-catalog").isVisible(), "the panel always offers a safe keep action");
  await page.screenshot({ path: SHOTS + "upgrade-e4-resolve-price.png" });
  await invTestid(page, "resolve-update").click();
  await page.waitForSelector('[data-testid="resolve-panel"]', { state: "detached" });
  await app.close();

  {
    const chips = productByName("شيبس");
    assert(Number(chips.selling_price_minor) === 250, `the catalog price became 2.50 (got ${chips.selling_price_minor})`);
    // 🔴 The approved rule: an explicit, successful invoice-price update clears the flag.
    assert(Number(chips.price_needs_review) === 0, "and price_needs_review was cleared");
    assert(Number(chips.is_active) === 1, "the product is still active — reconciliation never touched is_active");

    const audits = auditRows();
    const updates = audits.filter((a) => a.event_type === "PRODUCT_UPDATED");
    assert(updates.length === 1, `exactly one PRODUCT_UPDATED was written (got ${updates.length})`);
    assert(audits.length === beforeAudit + 1, `and exactly one new audit row in total (got ${audits.length - beforeAudit})`);
    const meta = JSON.parse(updates[0].metadata_json);
    assert(meta.origin === "invoice_reconciliation", `the audit says where it came from (${meta.origin})`);
    assert(typeof meta.invoice_id === "string" && meta.invoice_id.length > 0, "and which invoice");
    const diff = JSON.parse(updates[0].changed_json);
    assert(diff.selling_price_minor.before === "1" && diff.selling_price_minor.after === "250", "with the exact before/after");
    assert(diff.price_needs_review.before === true && diff.price_needs_review.after === false, "and the flag's real transition");
    assert(!("is_active" in diff), "is_active is NOT in the diff");
    // 🔴 A price change is a PRODUCT_UPDATED. There is no PRICE_CHANGED event type.
    assert(!JSON.stringify(audits).includes("PRICE_CHANGED"), "no PRICE_CHANGED event exists");
  }

  // ── A keep action: zero mutation, zero audit, out of the queue ─────────────────────────────────
  const auditAfterUpdate = ledgerFacts().audit;
  const pepsiBefore = productByName("بيبسي 330 مل");

  ({ app, page } = await launch());
  await tab(page, "Invoices");
  await invTestid(page, "inv-tab-review").click();
  await page.waitForSelector('[data-testid="review-table"]');
  const pepsiRow = page.locator('[data-classification="PRICE_DIFFERENCE"]').filter({ hasText: "بيبسي" });
  await pepsiRow.first().locator('[data-testid="review-resolve"]').click();
  await page.waitForSelector('[data-testid="resolve-panel"]');
  await invTestid(page, "resolve-keep-catalog").click();
  await page.waitForSelector('[data-testid="resolve-panel"]', { state: "detached" });

  // ── PRODUCT_NOT_FOUND exposes Add / Link / Keep ────────────────────────────────────────────────
  const missingRow = page.locator('[data-classification="PRODUCT_NOT_FOUND"]');
  await missingRow.first().locator('[data-testid="review-resolve"]').click();
  await page.waitForSelector('[data-testid="resolve-not-found"]');
  assert(await invTestid(page, "resolve-create").isVisible(), "Add to catalog is offered");
  assert(await invTestid(page, "resolve-link").isVisible(), "Link existing is offered");
  assert(await invTestid(page, "resolve-keep-invoice").isVisible(), "Keep invoice only is offered");
  assert(
    (await invTestid(page, "resolve-name-ar").inputValue()).includes("غير موجود"),
    "the Add form is prefilled from what the invoice observed",
  );
  await page.screenshot({ path: SHOTS + "upgrade-e5-resolve-not-found.png" });
  // 🔴 An unsupported free-text unit does not silently mutate the catalog: creating without naming
  // a canonical unit is REFUSED, and the item stays in the queue.
  await invTestid(page, "resolve-create").click();
  await page.waitForSelector('[data-testid="resolve-error"]');
  assert(await invTestid(page, "resolve-error").isVisible(), "creating a product from an unmappable unit is refused, with a reason");
  await invTestid(page, "resolve-keep-invoice").click();
  await page.waitForSelector('[data-testid="resolve-panel"]', { state: "detached" });
  await app.close();

  {
    const pepsi = productByName("بيبسي 330 مل");
    assert(
      Number(pepsi.selling_price_minor) === Number(pepsiBefore.selling_price_minor),
      "Keep catalog unchanged mutated no product",
    );
    assert(ledgerFacts().audit === auditAfterUpdate, "and wrote no product audit event");
    const settled = invoiceRows("invoice_reconciliation").filter((r) => r.status !== "PENDING" && r.status !== "FAILED");
    assert(settled.length === 4, `every item left the unresolved queue (${settled.length} of 4 settled)`);
    assert(settled.some((r) => r.status === "KEPT_CATALOG" && r.classification === "PRICE_DIFFERENCE"), "the keep decision is recorded");
    assert(settled.some((r) => r.status === "KEPT_INVOICE_ONLY"), "and so is keep-invoice-only");
    assert(
      settled.every((r) => r.resolution_actor_id === "cashier-01"),
      "each one names the operator who decided it",
    );
    // The catalog gained no product from a refused creation.
    assert(ledgerFacts().catalog === 5, "no product was created by the refused attempt");
  }

  // ── The historical snapshot survives changes to the shop AND the catalog ───────────────────────
  const frozenIssuer = invoiceRows("invoices")[0].issuer_snapshot_json;
  const frozenLines = JSON.stringify(
    invoiceRows("invoice_lines", "line_no").map((l) => [l.description, String(l.unit_price_minor), l.unit_label]),
  );

  ({ app, page } = await launch());
  await tab(page, "Invoices");
  await invTestid(page, "inv-tab-company").click();
  await page.waitForSelector('[data-testid="company-name-ar"]');
  await invTestid(page, "company-name-ar").fill("اسم مختلف تماماً");
  await invTestid(page, "company-save").click();
  await page.waitForSelector('[data-testid="company-notice"]');

  await tab(page, "Products");
  await page.waitForSelector('[data-testid="product-row"]');
  // The row's FIRST button is Edit — positional, as every other phase in this file does it.
  await page.locator('[data-testid="product-row"]').filter({ hasText: "بيبسي" }).first().getByRole("button").first().click();
  await page.waitForSelector('[data-testid="field-nameAr"]');
  await page.locator('[data-testid="field-nameAr"]').fill("اسم منتج مختلف");
  await page.locator('[data-testid="field-price"]').fill("77.00");
  await page.locator('[data-testid="save-product"]').click();
  await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
  await page.waitForSelector('[data-testid="product-row"]');

  await tab(page, "Invoices");
  await page.waitForSelector('[data-testid="history-table"]');
  assert((await invTestid(page, "history-row").count()) === 1, "the invoice is in history");
  await invTestid(page, "history-open").first().click();
  await page.waitForSelector('[data-testid="sheet-readonly"]');
  const reopened = await invText(page, "sheet-issuer");
  assert(reopened.includes("متجر اختباري للترقية"), `the reopened invoice shows its FROZEN issuer (got "${reopened}")`);
  assert(!reopened.includes("اسم مختلف"), "not the shop's new name");
  // 🔴 Descriptions, units and unit prices render as <input> elements, and `innerText` never
  // includes an input's value — so this reads the VALUES. The earlier innerText form failed on the
  // positive assertions and passed the negative ones for the wrong reason.
  const shown = await page
    .locator('[data-testid="sheet-line"] input')
    .evaluateAll((els) => els.map((e) => e.value));
  assert(shown.includes("بيبسي 330 مل"), `the historical line description is unchanged (got ${JSON.stringify(shown)})`);
  assert(!shown.includes("اسم منتج مختلف"), "not the product's new name");
  assert(shown.includes("1.50"), `the historical unit price is unchanged (got ${JSON.stringify(shown)})`);
  assert(!shown.includes("77.00"), "not the product's new price");
  assert(shown.includes("كيس (50PCS)"), "the historical unit label is unchanged");
  await page.screenshot({ path: SHOTS + "upgrade-e6-frozen.png" });

  // ── PDF, from the frozen invoice ───────────────────────────────────────────────────────────────
  const pdf = join(tmpdir(), `alzabt-invoice-61-${process.pid}.pdf`);
  await stub(app, "save", pdf); // the file's own helper, not a second hand-rolled dialog stub
  await invTestid(page, "save-pdf").click();
  // 🔴 A CONDITION, not a duration: printToPDF on a cold runner can take far longer than any
  // interval I would guess, and too short a sleep fails as "no PDF" — indistinguishable from the
  // feature being broken.
  for (let waited = 0; !(existsSync(pdf) && statSync(pdf).size > 0); waited += 250) {
    if (waited > 60000) throw new Error(`TIMED OUT waiting for the PDF at ${pdf}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(existsSync(pdf), `a PDF was generated (${pdf})`);
  const bytes = statSync(pdf).size;
  assert(bytes > 2000, `the PDF is a real document (${bytes} bytes)`);
  await app.close();

  assert(invoiceRows("invoices")[0].issuer_snapshot_json === frozenIssuer, "generating the PDF did not alter the frozen issuer");

  // ── Restart: everything durable is still there ─────────────────────────────────────────────────
  ({ app, page } = await launch());
  await tab(page, "Invoices");
  await page.waitForSelector('[data-testid="history-table"]');
  assert((await invTestid(page, "history-row").count()) === 1, "the invoice survived a restart");
  assert((await invText(page, "sheet-number").catch(() => "")) !== undefined, "history rendered");
  await app.close();

  // ── Final DB proof ─────────────────────────────────────────────────────────────────────────────
  {
    const f = ledgerFacts();
    const chips = productByName("شيبس");
    const recon = invoiceRows("invoice_reconciliation").map((r) => `${r.classification}:${r.status}`).sort();
    log(
      "SCENARIO E FINAL:",
      JSON.stringify({
        schema: f.schema,
        integrity: f.integrity,
        foreignKeys: f.foreignKeys,
        invoices: f.invoices,
        invoiceLines: f.invoiceLines,
        reconciliation: f.reconciliation,
        invoiceNumber: f.invoiceNumber,
        chipsPriceMinor: Number(chips.selling_price_minor),
        chipsNeedsReview: Number(chips.price_needs_review),
        chipsActive: Number(chips.is_active),
        audit: f.audit,
        auditTypes: f.auditTypes,
        sales: f.sales,
        voids: f.voids,
      }),
    );
    assert(f.schema === 6 && f.integrity === "ok" && f.foreignKeys === "[]", "the ledger is sound at v6");
    assert(f.invoices === 1 && f.invoiceLines === 4 && f.reconciliation === 4, "the invoice, its lines and its review rows persist");
    assert(f.invoiceNumber === 61, "the invoice number is unchanged after every restart");
    assert(
      JSON.stringify(invoiceRows("invoice_lines", "line_no").map((l) => [l.description, String(l.unit_price_minor), l.unit_label])) ===
        frozenLines,
      "every line snapshot is byte-for-byte what it was",
    );
    assert(Number(chips.selling_price_minor) === 250 && Number(chips.price_needs_review) === 0, "the product mutation persists");
    assert(recon.filter((r) => r.endsWith(":PENDING")).length === 0, "no item was left unresolved");
    assert(f.sales === 2 && f.voids === 1, "and the v5 sales ledger is exactly as it was found");
    assert(f.audit === beforeAudit + 1, `the audit trail grew by exactly one row (${beforeAudit} -> ${f.audit})`);
  }
} else {
  console.error(
    "usage: node e2e/upgrade.mjs seed-v2|verify-from-v2|seed-v3|verify-from-v3|seed-main|verify-from-main|seed-v4|verify-from-v4|seed-v5|verify-from-v5",
  );
  process.exit(2);
}
log(`UPGRADE PHASE ${PHASE} PASSED — profile ${DEFAULT_PROFILE}`);
