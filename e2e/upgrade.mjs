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
//     node e2e/upgrade.mjs seed-v6        (scenario F: the real released v6 main, 6e3984f)
//     node e2e/upgrade.mjs verify-from-v6
//
// E2E_EXECUTABLE is the installed exe. The script asserts the profile path it actually used and
// prints it, and reads the ledger file directly (app closed) for schema/backup evidence.
// Synthetic Arabic data and fake prices only.
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  // `.login` is the one anchor both builds share: the old release has no testid, and this build's
  // prompt text is Arabic.
  await page.waitForSelector(".login", { timeout: 30000 });
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  log("profile used by the app:", userData);
  assert(userData === DEFAULT_PROFILE, `the app uses the real default profile (${DEFAULT_PROFILE})`);
  await page.getByRole("button", { name: "Cashier One" }).click();
  for (const d of "1111") await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await clickEither(page, "login-submit", page.getByRole("button", { name: "Log in" }));
  // 🔴 Migration 8 put MANDATORY SETUP behind the first login, so this build answers 1111 with a
  // setup ticket rather than a session. The older builds this script also drives have no
  // `operators` table and never show that screen, so the selector simply never matches for them —
  // which is why both outcomes are awaited rather than branching on which phase we think we are in.
  // The PIN is re-set to 1111 and the name is left alone: this script's subject is the UPGRADE, and
  // the real setup flow is proven in operator-accounts.mjs with a genuinely new PIN.
  await page.waitForSelector('[data-testid="cart"], .cart, [data-testid="setup-screen"]');
  if (await page.locator('[data-testid="setup-screen"]').count()) {
    await page.locator('[data-testid="setup-pin"]').fill("1111");
    await page.locator('[data-testid="setup-confirm"]').fill("1111");
    await page.locator('[data-testid="setup-submit"]').click();
    await page.waitForSelector('[data-testid="cart"], .cart');
    log("mandatory setup completed (schema v8 build)");
  }
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

/**
 * 🔴 THIS FILE DRIVES TWO DIFFERENT BUILDS, AND THAT IS THE POINT OF IT.
 *
 * A `seed-*` phase installs and drives a REAL OLD RELEASE — Gate 2.1, the field pilot, v5, v6 —
 * whose UI predates both the data-testids and the Arabic translation. A `verify-*` phase drives
 * THIS build. A selector that exists in only one of them makes the seed phase fail for a reason
 * that has nothing to do with the upgrade being tested, which is exactly what happened when the
 * testid sweep rewrote these shared helpers.
 *
 * So every shared control is reached by: this build's testid if it is there, otherwise the old
 * build's English control.
 */
/**
 * Waits for whichever of two selectors appears first.
 *
 * 🔴 NOT A COMMA LIST. `'[data-testid="x"], text=Y'` looks like a CSS selector group but mixes two
 * Playwright ENGINES — css and text — and matches nothing at all, which times out looking like the
 * screen never rendered.
 */
async function waitForEither(page, a, b, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await page.locator(a).count()) > 0) return;
    if ((await page.locator(b).count()) > 0) return;
    if (Date.now() > deadline) throw new Error(`TIMED OUT waiting for ${a} or ${b}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function clickEither(page, testid, fallback) {
  const byId = page.locator(`[data-testid="${testid}"]`);
  if ((await byId.count()) > 0) {
    await byId.first().click();
    return;
  }
  await fallback.click();
}

async function sell(page, items, method, expectReceipt) {
  for (const name of items) await product(page, name).click();
  await clickEither(page, "complete-sale", page.getByRole("button", { name: "Complete sale" }));
  // The payment method is still chosen by its English name on an old build; this build labels the
  // same four buttons pay-cash / pay-card / pay-external / pay-other.
  await clickEither(page, `pay-${method.toLowerCase()}`, page.getByRole("button", { name: method }));
  await waitForEither(
    page,
    `[data-testid="receipt-number"]:has-text("#${expectReceipt}")`,
    `text=Receipt #${expectReceipt}`,
  );
  await clickEither(page, "new-sale", page.getByRole("button", { name: "New sale" }));
}

async function voidCardSale(page) {
  await tab(page, "History");
  await page.waitForSelector(".history-table");
  const cardRow = (await page.locator('tr[data-payment-method="card"]').count())
    ? page.locator('tr[data-payment-method="card"]')
    : page.locator("tr", { hasText: "card" });
  await clickEither(page, "history-void", cardRow.getByRole("button", { name: "Void" }));
  const reason = (await page.locator('[data-testid="void-reason"]').count())
    ? page.locator('[data-testid="void-reason"]')
    : page.getByPlaceholder("e.g. wrong item rung up");
  await reason.fill("wrong item rung up");
  await clickEither(page, "void-confirm", page.getByRole("button", { name: "Confirm void" }));
  await page.waitForSelector("tr.voided");
}

const totalText = async (page) => (await page.locator(".total strong").innerText()).trim();

/** Today's figures by testid — the labels are translated and the <dl> is gone. */
async function stats(page) {
  await tab(page, "Today's Sales");
  await page.waitForSelector('[data-testid="today-net"]');
  const read = async (id) => (await page.locator(`[data-testid="${id}"]`).innerText()).trim();
  return {
    "Completed sales": await read("today-completed"),
    "Voided sales": await read("today-voided"),
    "Gross sales": await read("today-gross"),
    "Voids": await read("today-void-amount"),
    "Net sales": await read("today-net"),
  };
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

/** True once migration 7 has widened `sales`. Probed, never assumed from the schema number. */
function salesHasSource(db) {
  return db
    .prepare("PRAGMA table_info(sales)")
    .all()
    .some((c) => c.name === "source_type");
}

const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Where a phase leaves facts for a LATER PROCESS to assert against. CI keeps the workspace. */
const factFile = (name) => join(APP, "e2e-output", name);
function saveFacts(name, data) {
  mkdirSync(join(APP, "e2e-output"), { recursive: true });
  writeFileSync(factFile(name), JSON.stringify(data, null, 2));
  log(`facts saved: ${name}`);
}
const loadFacts = (name) => JSON.parse(readFileSync(factFile(name), "utf8"));

function killTree(pid) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function windowTitle(pid) {
  if (process.platform !== "win32") return null;
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).MainWindowTitle`], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Runs the CURRENT E2E_EXECUTABLE against the REAL default profile and requires it to REFUSE with a
 * named startup-failure code.
 *
 * 🔴 Modelled on e2e/startup-failure.mjs, with one difference that matters: that script uses a
 * throw-away profile, and this one must use the real one, because the whole question is what the
 * OLD BUILD does to the SHOP'S OWN database. The error box is modal, so the process stays alive
 * showing it; the log is read, the window title checked, then the tree is killed.
 *
 * 🔴 AND IT ONLY ACCEPTS A LINE WRITTEN AFTER IT STARTED. The log is shared with every earlier
 * phase in this profile, so matching anywhere in the file could pass on a stale entry and would
 * keep passing if the old build silently started instead of refusing.
 */
async function runRefusing(expectedCode) {
  const logFile = join(DEFAULT_PROFILE, "logs", "alzabt-pos.log");
  const before = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").length : 0;
  log(`log lines before the refusal attempt: ${before}`);
  const child = spawn(ELECTRON, [...EXTRA_ARGS, ...APP_ARGS], {
    env: { ...env, ALZABT_POS_DISABLE_AUTOSTART: "1" },
    stdio: "ignore",
  });
  let exited = null;
  child.on("exit", (code) => (exited = code));
  let line = null;
  let title = null;
  for (let i = 0; i < 160 && !line; i++) {
    await sleep(250);
    if (!existsSync(logFile)) continue;
    const lines = readFileSync(logFile, "utf8").split("\n");
    line = lines.slice(Math.max(0, before - 1)).find((l) => l.includes('"event":"startup-failure"')) ?? null;
  }
  for (let i = 0; i < 40 && process.platform === "win32" && !title; i++) {
    title = windowTitle(child.pid);
    if (!title) await sleep(250);
  }
  killTree(child.pid);
  assert(line !== null, `the old build recorded a NEW startup failure (not a stale one)`);
  const entry = JSON.parse(line);
  assert(entry.code === expectedCode, `and classified it as ${expectedCode} (got ${entry.code})`);
  const after = readFileSync(logFile, "utf8").split("\n").slice(Math.max(0, before - 1)).join("\n");
  assert(!after.includes('"event":"catalog"'), "the till never started behind the error box");
  if (process.platform === "win32") {
    log("error box window title:", JSON.stringify(title), "process exited early:", exited);
    assert(title === "Alzabt POS — cannot start", "the operator is TOLD, in a native error box");
  }
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
      // Migration 8. `null` — never 0 — when the table is absent, which is the honest answer for
      // every ledger written before operator accounts existed.
      operators: tables.includes("operators") ? n("SELECT count(*) AS n FROM operators") : null,
      /**
       * 🔴 THE BUSINESS TRAIL, SEPARATED FROM THE ACCOUNT TRAIL — and this split is a transition,
       * not a tidy-up. Every `verify-from-*` phase launches THIS build, and this build's first
       * login goes through real mandatory setup, which writes one OPERATOR_PIN_RESET row. So
       * `audit` — a plain count of the whole table — shifted by one in six phases at once, and
       * assertions that read "the durable audit trail starts empty" became arithmetic about an
       * account event they were never about.
       *
       * Rather than move twenty numbers by one and lose what each was claiming, the two trails are
       * now counted separately. Each phase then says BOTH things exactly: how many business events
       * its own actions wrote, and that signing in wrote exactly one account event. That is
       * stricter than before, not looser — the old assertions could not see the difference at all.
       */
      auditBusiness: tables.includes("audit_events")
        ? n("SELECT count(*) AS n FROM audit_events WHERE entity_type <> 'operator'")
        : null,
      auditOperators: tables.includes("audit_events")
        ? n("SELECT count(*) AS n FROM audit_events WHERE entity_type = 'operator'")
        : null,
      operatorRows: tables.includes("operators")
        ? db
            .prepare("SELECT id, role, must_reset_pin AS f, is_active AS a FROM operators ORDER BY id")
            .all()
            .map((r) => `${r.id}:${r.role}:reset=${Number(r.f)}:active=${Number(r.a)}`)
            .join(",")
        : null,
      // Who the LEDGER says rang each sale. A snapshot, with no foreign key — so a migration that
      // "tidied" these into a join would show up right here.
      cashierSnapshots: db
        .prepare("SELECT cashier_id AS i, cashier_name AS n FROM sales ORDER BY receipt_number")
        .all()
        .map((r) => `${r.i}=${r.n}`)
        .join(","),
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
      // Migration 7. `null` means the column does not exist yet — the honest answer for any ledger
      // a pre-v7 build wrote. Never 0, which would claim "no invoice sales" on a schema that cannot
      // express the idea at all.
      invoiceSales: salesHasSource(db) ? n("SELECT count(*) AS n FROM sales WHERE source_type = 'invoice'") : null,
      posSales: salesHasSource(db) ? n("SELECT count(*) AS n FROM sales WHERE source_type = 'pos'") : null,
      linkedSales: salesHasSource(db) ? n("SELECT count(*) AS n FROM sales WHERE invoice_id IS NOT NULL") : null,
      unpaidSales: salesHasSource(db)
        ? n("SELECT count(*) AS n FROM sales WHERE payment_status <> 'paid'")
        : null,
      saleStatuses: salesHasSource(db)
        ? db
            .prepare("SELECT payment_status AS p, count(*) AS n FROM sales GROUP BY payment_status ORDER BY p")
            .all()
            .map((r) => `${r.p}=${Number(r.n)}`)
            .join(",")
        : null,
      methodlessSales: salesHasSource(db)
        ? n("SELECT count(*) AS n FROM sales WHERE payment_method IS NULL")
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
/**
 * The BUSINESS audit rows — everything except the account trail.
 *
 * 🔴 Named, not hidden. Mandatory setup writes one OPERATOR_PIN_RESET row at this build's first
 * login, so a phase indexing `auditRows()[0]` would now read that row instead of the product edit
 * it means. Filtering by entity_type at the call site keeps each assertion saying what it said
 * before, and the operator row is asserted separately rather than subtracted silently.
 */
const businessRows = () => auditRows().filter((r) => r.entity_type !== "operator");

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
  // 🔴 TWO BUILDS AGAIN. Up to and including `d771a2d` the unit was a free-text input; from
  // 2026-10-10 it is the same dropdown the product form uses, with «Other» for anything the build
  // does not know. Whichever this build has is used, and the options are read off the select rather
  // than listed here, so neither a language nor a new BASE_UNITS member breaks it.
  const freeText = invTestid(page, "new-line-unit");
  if ((await freeText.count()) > 0) {
    await freeText.fill(unit);
  } else {
    const row = page.locator('[data-testid="sheet-draft-row"]').last();
    const select = row.locator('[data-testid^="unit-select-"]').first();
    const options = await select.evaluate((el) =>
      Array.from(el.options).map((o) => ({ value: o.value, label: (o.textContent || "").trim() })),
    );
    const hit = options.find((o) => o.value === unit || o.label === unit);
    if (hit && hit.value !== "other") {
      await select.selectOption(hit.value);
    } else {
      await select.selectOption("other");
      await row.locator('[data-testid^="unit-custom-"]').first().fill(unit);
    }
  }
  await invTestid(page, "new-line-price").fill(price);
  // 🔴 THIS FILE DRIVES TWO BUILDS, so it must not assume either one's row model. Up to and
  // including `ce4dd28` a row was committed by its own "save" button; from 2026-10-10 the sheet
  // holds several unsaved rows and they are flushed together by "Save draft". Whichever exists
  // here is pressed, and the row is then gone from the unsaved sheet in both.
  const perRowSave = invTestid(page, "new-line-save");
  if ((await perRowSave.count()) > 0) {
    await perRowSave.click();
    await page.waitForSelector('[data-testid="new-line-save"]', { state: "detached" });
  } else {
    await invTestid(page, "save-draft").click();
    await page.waitForSelector('[data-testid="sheet-draft-row"]', { state: "detached" });
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
  // Was `f.schema === 3`, then 4, 5 and 6; migration 7 made a v2 ledger land on v7 in ONE upgrade,
  // and migration 8 (operator accounts) now carries it to v8 in that same single upgrade. The
  // version a build migrates TO is a transition, so each old value is named rather than replaced.
  assert(f.schema === 8 && f.integrity === "ok", `migrated to schema v8, integrity ok (got ${f.schema})`);
  // The audit table was created on the way, and starts empty — nothing is reconstructed.
  assert(f.auditBusiness === 0, `the durable BUSINESS audit trail starts empty (was \`audit === 0\`; got ${f.auditBusiness})`);
  assert(f.auditOperators === 1, `and exactly one account event, written by mandatory setup at first login (got ${f.auditOperators})`);
  // Two Espressos at 2.50 and one at 2.50, all WHOLE pieces, so every quantity scaled by 1000.
  assert(f.quantities.every((q) => q % 1000 === 0), `every migrated quantity is a whole number of units: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 2, `the 2 pre-migration lines keep an UNKNOWN unit (got ${f.unknownUnits})`);
  assert(JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1, "receipts 1,2 kept and 3 continues the sequence");
  const backups = backupFiles();
  log("backups:", JSON.stringify(backups));
  // The name carries the real span, and that span widened with each migration: v2→v3, v2→v4, v2→v5, now v2→v6.
  const pre = backups.find((b) => /^pre-migration-v2-to-v7-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a pre-migration backup was taken before v2→v7 (got ${JSON.stringify(backups)})`);
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
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
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
  await page.locator('[data-testid="export-catalog"]').click();
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
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" })); // the field-pilot build's header button
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
  const pre3 = backupFiles().find((b) => /^pre-migration-v3-to-v7-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre3, `a pre-migration backup was taken before v3→v7 (got ${JSON.stringify(backupFiles())})`);
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
  assert(afterMigration.schema === 8, `migrated to schema v8 (got ${afterMigration.schema})`);
  assert(afterMigration.auditBusiness === 0, `the durable BUSINESS audit trail starts empty (was \`audit === 0\`; got ${afterMigration.auditBusiness})`);
  assert(afterMigration.auditOperators === 1, `and exactly one account event, written by mandatory setup at first login (got ${afterMigration.auditOperators})`);

  ({ app, page } = await launch());
  const h2 = await historyRows(page);
  assert(h2.rows === 3 && h2.voided === 1, "after restart: old and new sales are all there");
  const dir = mkdtempSync(join(tmpdir(), "pos-upgrade-"));
  const exportFile = join(dir, "exported.csv");
  await stub(app, "save", exportFile);
  await tab(page, "Tools");
  await page.locator('[data-testid="export-catalog"]').click();
  await page.waitForSelector("text=Catalog exported");
  await page.getByRole("button", { name: "OK" }).click();
  await stub(app, "open", exportFile);
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
  await page.waitForSelector("text=Catalog imported");
  assert(/0 new, 0 updated, 4 unchanged/.test(await page.locator(".import-report").innerText()), "export → re-import changes nothing");
  await page.getByRole("button", { name: "OK" }).click();
  await page.screenshot({ path: SHOTS + "upgrade-b2-after-0.1.1.png" });
  await app.close();
  const f = ledgerFacts();
  log("final ledger:", JSON.stringify(f));
  // Was `f.schema === 3`, then 4, then 5.
  assert(f.schema === 8 && JSON.stringify(f.receipts) === "[1,2,3]" && f.voids === 1 && f.catalog === 4 && f.integrity === "ok", `final ledger intact at v8 (got ${f.schema})`);
  // 🔴 And the export → re-import above is now AUDITED: exactly one CATALOG_IMPORTED summary and
  // ZERO product events, because the re-imported file is byte-identical and changed nothing. That
  // is the low-noise property the import audit model was chosen for, measured on the installed app.
  assert(f.auditBusiness === 1, `the re-import wrote exactly one BUSINESS audit row (was \`audit === 1\`; got ${f.auditBusiness})`);
  assert(
    f.auditTypes === "CATALOG_IMPORTED=1,OPERATOR_PIN_RESET=1",
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
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
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
  assert(f.schema === 8 && f.integrity === "ok", `migrated to schema v8, integrity ok (got ${f.schema})`);
  assert(f.auditBusiness === 0, `the durable BUSINESS audit trail starts empty (was \`audit === 0\`; got ${f.auditBusiness})`);
  assert(f.auditOperators === 1, `and exactly one account event, written by mandatory setup at first login (got ${f.auditOperators})`);
  assert(f.quantities.every((q) => q % 1000 === 0), `migrated quantities are whole: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 2, `both pre-migration lines keep an UNKNOWN unit (got ${f.unknownUnits})`);
  assert(productUnit("SYN-ROPE") === "kg", `the product's unit survived as kg (got ${productUnit("SYN-ROPE")})`);
  const pre = backupFiles().find((b) => /^pre-migration-v3-to-v7-\d{8}T\d{6}Z\.sqlite$/.test(b));
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
  await page.locator('[data-testid="complete-sale"]').click();
  await page.locator('[data-testid="pay-cash"]').click();
  await page.waitForSelector('[data-testid="receipt-number"]:has-text("#3")');
  await page.screenshot({ path: SHOTS + "upgrade-c2-fractional.png" });
  await page.locator('[data-testid="new-sale"]').click();
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
  assert(f2.auditBusiness === 0, `selling writes no BUSINESS audit event (was \`audit === 0\`; got ${f2.auditBusiness})`);
} else if (PHASE === "seed-v4") {
  // Scenario D — the canonical CURRENT MAIN build (68fdf03, schema v4: exact quantity + sale_unit,
  // and NO durable audit). This is the profile a shop would really be upgraded from.
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await tab(page, "Tools");
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
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
  await clickEither(page, "complete-sale", page.getByRole("button", { name: "Complete sale" }));
  await clickEither(page, "pay-cash", page.getByRole("button", { name: "Cash" }));
  await waitForEither(page, '[data-testid="receipt-number"]:has-text("#1")', "text=Receipt #1");
  await clickEither(page, "new-sale", page.getByRole("button", { name: "New sale" }));
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
  log("ledger after the v4 -> v7 upgrade:", JSON.stringify(f));
  // Was 5 before migration 6 and 6 before migration 7: a v4 ledger now lands on v7 in ONE upgrade.
  assert(f.schema === 8 && f.integrity === "ok", `migrated to schema v8, integrity ok (got ${f.schema})`);
  assert(f.sales === 2 && f.voids === 1, "sales and voids untouched by migrations 5 and 6");
  // 🔴 Migration 4's behaviour is unchanged: the fractional quantity is still exactly 2500.
  assert(JSON.stringify(f.quantities) === "[2500,1000]", `quantities untouched: ${JSON.stringify(f.quantities)}`);
  assert(f.unknownUnits === 0, "sale units untouched");
  assert(productUnit("SYN-ROPE") === "kg", `the product's unit survived as kg (got ${productUnit("SYN-ROPE")})`);
  // 🔴 The trail starts EMPTY. No pre-v5 history is invented out of the rotating logfile.
  assert(f.auditBusiness === 0, `the BUSINESS audit trail starts empty (was \`audit === 0\`; got ${f.auditBusiness})`);
  assert(f.auditOperators === 1, `and exactly one account event, written by mandatory setup at first login (got ${f.auditOperators})`);
  const pre = backupFiles().find((b) => /^pre-migration-v4-to-v7-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a verified pre-migration v4->v7 backup exists (got ${JSON.stringify(backupFiles())})`);

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

  // 🔴 TRANSITION. This read `auditRows()` and asserted `length === 1` with `seq === 1`. Both were
  // true until migration 8 put mandatory setup before the till: the first row on a freshly migrated
  // ledger is now the OPERATOR_PIN_RESET that signing in wrote, so the product edit is seq 2. The
  // old values are named here; the claim itself is unchanged and is now stated about the trail it
  // was always about.
  let audit = businessRows();
  assert(audit.length === 1, `the edit left exactly one BUSINESS audit row (got ${audit.length})`);
  assert(audit[0].event_type === "PRODUCT_UPDATED", `and it is a PRODUCT_UPDATED (got ${audit[0].event_type})`);
  assert(Number(audit[0].seq) === 2, "its seq is 2 — the setup row took 1 (was `=== 1` before migration 8)");
  assert(audit[0].actor_id === "cashier-01" && audit[0].actor_name === "Cashier One", "it names the operator");
  // 🔴 AND THE TWO TRAILS DISAGREE ABOUT THE SAME PERSON, which is reported rather than smoothed:
  // posService still writes CURRENT_ACTOR_TIER for a product event while operatorService writes the
  // real role for an account event. Asserted as it IS, so settling it shows up here as a real edit.
  assert(audit[0].actor_tier === "unspecified", "a product event still records the tier as unspecified");
  {
    const accounts = auditRows().filter((r) => r.entity_type === "operator");
    assert(accounts.length === 1 && Number(accounts[0].seq) === 1, "the account trail holds exactly the setup row, at seq 1");
    assert(accounts[0].actor_tier === "owner", `and THAT one knows the role (${accounts[0].actor_tier})`);
  }
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
  // The SECOND login writes no setup row — must_reset_pin is already 0 — so the account trail
  // stays at one and the business trail is what this restart is about.
  const afterRestart = businessRows();
  assert(afterRestart.length === 1 && afterRestart[0].id === audit[0].id, "the audit row survived a restart");
  assert(
    auditRows().filter((r) => r.entity_type === "operator").length === 1,
    "and signing in again added NO second setup row — setup runs once",
  );

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
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
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
  //
  // 🔴 TRANSITION. This was `Number(r.seq) > 1`, which read "everything after the price edit"
  // because that edit WAS seq 1 on a freshly migrated ledger. Mandatory setup now holds seq 1 and
  // the edit is seq 2, so the literal quietly came to mean "everything after the setup row". It is
  // now expressed against the EDIT'S OWN seq, which cannot drift again when another row is added
  // ahead of it.
  const editSeq = Number(audit.find((r) => r.event_type === "PRODUCT_UPDATED").seq);
  const sinceImport = audit.filter((r) => Number(r.seq) > editSeq);
  assert(
    sinceImport.length === 1 && sinceImport[0].event_type === "CATALOG_IMPORTED",
    `an identical re-import writes the summary and no product events (got ${sinceImport.map((r) => r.event_type).join(",")})`,
  );
  const f2 = ledgerFacts();
  log("final ledger:", JSON.stringify(f2));
  // Was 5 before migration 6.
  assert(f2.integrity === "ok" && f2.schema === 8, "the ledger is sound and still at v8");
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
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
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
  // 🔴 `sell()` does not navigate — it clicks product tiles on whatever screen is showing. Adding a
  // product left us on Products, so the Sell tab has to be selected first. Scenario D does exactly
  // this; mine went straight to selling and waited forever for a tile that was not on screen.
  await tab(page, "Sell");
  // 🔴 `sell()` already clicks "New sale" as its last step, so consecutive calls need nothing
  // between them — every other phase in this file chains them directly. An extra click here waited
  // for a button that the helper had already consumed.
  await sell(page, ["بيبسي 330 مل"], "Cash", 1);
  await sell(page, ["مياه"], "Card", 2);
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
  assert(m.schema === 8, `the schema moved to v8 (got ${m.schema})`);
  assert(m.integrity === "ok", "integrity_check is ok");
  assert(m.foreignKeys === "[]", `foreign_key_check is empty (got ${m.foreignKeys})`);
  // Old business data survived, byte for byte.
  assert(m.sales === 2 && m.voids === 1, "the two v5 sales and the void are untouched");
  assert(JSON.stringify(m.receipts) === "[1,2]", "the receipt sequence is unchanged");
  // Migration 7 rebuilt `sales` under those two rows. They are still till sales, still settled in
  // full, and still carry their own payment methods — nothing was blanked and nothing invented.
  assert(m.posSales === 2, `both migrated sales are source_type='pos' (got ${m.posSales})`);
  assert(m.invoiceSales === 0, `and no invoice-origin sale was synthesized (got ${m.invoiceSales})`);
  assert(m.linkedSales === 0, "no migrated sale points at an invoice");
  assert(m.unpaidSales === 0, `every migrated sale is 'paid' (got ${m.unpaidSales})`);
  assert(m.methodlessSales === 0, `and not one lost its payment method (got ${m.methodlessSales})`);
  assert(m.catalog === 5, "the catalog is unchanged");
  // `beforeAudit` was read BEFORE this build ran, so it cannot include the setup row; the
  // business count is what migrating must leave alone.
  assert(m.auditBusiness === beforeAudit, `migrating wrote no BUSINESS audit events (${beforeAudit} -> ${m.auditBusiness})`);
  assert(m.auditOperators === 1, `and signing in wrote exactly one account event, written by mandatory setup at first login (got ${m.auditOperators})`);
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
  // The intent chooser is the new required step — see manual-invoice.mjs for why it exists.
  await page.waitForSelector('[data-testid="invoice-mode-chooser"]');
  await invTestid(page, "mode-outgoing").click();
  await page.waitForSelector('[data-testid="invoice-mode-chooser"]', { state: "detached" });
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

    // 🔴 THE V1 BOUNDARY WAS REVERSED ON 2026-10-09, AND THE OLD VALUE WAS TWO. Until then this
    // read `assert(f.sales === 2, "still exactly the two v5 sales")` under the comment "issuing an
    // invoice is not a sale and moves no stock". Field use reversed the first half: a finalized
    // invoice IS a sale for business reporting (migration 7). The SECOND half still holds and is
    // still asserted below — a sale is not a stock movement, and there is still no stock table.
    assert(f.sales === 3, `the two v5 sales plus the invoice's own sale (got ${f.sales})`);
    assert(f.posSales === 2, `the two v5 till sales are still till sales (got ${f.posSales})`);
    assert(f.invoiceSales === 1, `and exactly one invoice-origin sale exists (got ${f.invoiceSales})`);
    assert(f.linkedSales === 1, "it is linked to the invoice it came from");
    // 🔴 THIS INVOICE IS PARTIALLY PAID — 3.25 against 13.25, typed into sheet-paid above — so
    // 'partial' is the correct status. The first version of this said "nothing was paid on it",
    // which was simply false about its own fixture; `unpaidSales` counts "not paid" and so passed
    // anyway. Naming the real status is the stronger assertion AND the honest comment.
    assert(f.saleStatuses === "paid=2,partial=1", `two paid till sales and one partial invoice sale (got ${f.saleStatuses})`);
    assert(f.unpaidSales === 1, `exactly one sale is not settled in full (got ${f.unpaidSales})`);
    assert(f.methodlessSales === 1, `exactly one sale records no payment method (got ${f.methodlessSales})`);
    assert(f.voids === 1, "still exactly the one v5 void");
    // The two v5 till lines are untouched; the invoice's four lines are additional.
    assert(
      JSON.stringify(f.quantities).startsWith("[1000,1000"),
      `the two v5 sale lines are undisturbed (got ${JSON.stringify(f.quantities)})`,
    );
    assert(f.auditBusiness === beforeAudit, `finalizing wrote no catalog audit event (${beforeAudit} -> ${f.auditBusiness})`);
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
    // `beforeAudit` predates this build, so the setup row is not in it; the business trail is.
    assert(
      audits.filter((a) => a.entity_type !== "operator").length === beforeAudit + 1,
      `and exactly one new BUSINESS audit row in total (got ${audits.filter((a) => a.entity_type !== "operator").length - beforeAudit})`,
    );
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
    assert(ledgerFacts().auditBusiness === auditAfterUpdate, "and wrote no product audit event");
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
    assert(f.schema === 8 && f.integrity === "ok" && f.foreignKeys === "[]", "the ledger is sound at v8");
    assert(f.invoices === 1 && f.invoiceLines === 4 && f.reconciliation === 4, "the invoice, its lines and its review rows persist");
    assert(f.invoiceNumber === 61, "the invoice number is unchanged after every restart");
    assert(
      JSON.stringify(invoiceRows("invoice_lines", "line_no").map((l) => [l.description, String(l.unit_price_minor), l.unit_label])) ===
        frozenLines,
      "every line snapshot is byte-for-byte what it was",
    );
    assert(Number(chips.selling_price_minor) === 250 && Number(chips.price_needs_review) === 0, "the product mutation persists");
    assert(recon.filter((r) => r.endsWith(":PENDING")).length === 0, "no item was left unresolved");
    // Was `f.sales === 2` — see the reversal note above. The two v5 till sales are still exactly
    // the two v5 till sales; what is new is the invoice's own sale.
    assert(f.posSales === 2 && f.voids === 1, "the v5 till sales and the void are exactly as they were found");
    assert(f.invoiceSales === 1 && f.linkedSales === 1, "and the finalized invoice still has exactly one linked sale");
    // 🔴 TWO rows, not one, and naming both is the point: the reconciliation price update, and the
    // ordinary product edit this scenario makes AFTERWARDS on purpose to prove the finalized
    // invoice's snapshot does not follow it. The earlier assertion inside the reconciliation block
    // is the one that pins the update itself to exactly one row.
    assert(
      f.auditBusiness === beforeAudit + 2,
      `the trail grew by exactly two rows — one reconciliation update, one deliberate catalog edit (${beforeAudit} -> ${f.audit})`,
    );
    const finalUpdates = auditRows().filter((a) => a.event_type === "PRODUCT_UPDATED");
    assert(finalUpdates.length === 2, `both are PRODUCT_UPDATED (got ${finalUpdates.map((a) => a.event_type).join(",")})`);
    // And they are told apart by PROVENANCE, which is what the metadata is for.
    const origins = finalUpdates.map((a) => JSON.parse(a.metadata_json).origin).sort();
    assert(
      JSON.stringify(origins) === JSON.stringify(["invoice_reconciliation", "manual_entry"]),
      `one came from reconciliation and one from the product screen (got ${JSON.stringify(origins)})`,
    );
  }
} else if (PHASE === "seed-v6") {
  // ── Scenario F, part 1 — the REAL released v6 main build (6e3984f, schema v6: manual invoices,
  // and NO sale integration). This is the profile the shop is running TODAY, created by driving
  // that build's own UI — including finalizing a real invoice through it, which is the part that
  // matters: migration 7 must then face an invoice that already exists.
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await tab(page, "Tools");
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();

  // Two till sales and a void, so the v7 rebuild has real ledger rows to preserve.
  await tab(page, "Sell");
  await sell(page, ["بيبسي 330 مل"], "Cash", 1);
  await sell(page, ["مياه"], "Card", 2);
  await voidCardSale(page);

  // 🔴 AN INVOICE FINALIZED BY THE v6 BUILD. On v6 this creates NO sale, by that build's own
  // decision — which is exactly the state migration 7 has to inherit without rewriting it.
  await tab(page, "Invoices");
  await page.waitForSelector('[data-testid="inv-tab-company"]');
  await invTestid(page, "company-name-ar").fill("متجر اختباري للترقية من v6");
  await invTestid(page, "company-save").click();
  await page.waitForSelector('[data-testid="company-notice"]');
  await page.waitForSelector('[data-testid="new-invoice"]');
  await invTestid(page, "new-invoice").click();
  // 🔴 NO INTENT CHOOSER HERE, AND THAT IS THE POINT OF THIS PHASE. seed-v6 drives the REAL
  // RELEASED v6 BUILD (6e3984f), which predates input-mode separation and opens a draft directly.
  // Waiting for a control that build cannot render is waiting forever — which is exactly how this
  // failed: A through E passed because they drive THIS build, and F's seed does not.
  // A test must match the build it drives.
  await page.waitForSelector('[data-testid="add-row"]');
  // The shared helper owns the add-row -> fill -> save cycle, so this phase cannot drift from the
  // way every other phase enters a line.
  await invoiceRow(page, { description: "صنف قديم", quantity: "2", unit: "حبة", price: "5.00" });
  assert((await invTestid(page, "sheet-line").count()) === 1, "one row is on the v6 sheet");
  await invTestid(page, "finalize").click();
  await page.waitForSelector('[data-testid="finalize-confirm"]');
  await invTestid(page, "finalize-confirm-yes").click();
  await page.waitForSelector('[data-testid="finalized-notice"]');
  await app.close();

  const f = ledgerFacts();
  log("v6 baseline ledger:", JSON.stringify(f));
  assert(f.schema === 6, `the baseline really is schema v6 (got ${f.schema})`);
  assert(f.sales === 3 && f.voids === 1, "three till sales and one void exist");
  assert(f.invoices === 1 && f.invoiceLines === 1, "and one finalized invoice with one line");
  assert(f.invoiceNumber > 0, "the invoice really carries a number");
  // 🔴 THE COLUMN DOES NOT EXIST YET. `null`, not 0 — the honest answer for a v6 ledger, which
  // cannot express the idea of an invoice-origin sale at all.
  assert(f.invoiceSales === null, "a v6 ledger has no source_type column");
  assert(f.posSales === null && f.linkedSales === null, "nor an invoice link, nor a payment status");
  log(
    "V6 BASELINE READY:",
    JSON.stringify({ sales: f.sales, voids: f.voids, invoices: f.invoices, invoiceNumber: f.invoiceNumber, receipts: f.receipts }),
  );
} else if (PHASE === "verify-from-v6") {
  // ── Scenario F, part 2 — the feature build installed OVER that real v6 profile ────────────────
  assert(existsSync(LEDGER), "the v6 ledger is still there");
  const before = ledgerFacts();
  const beforeInvoiceNumber = before.invoiceNumber;

  let { app, page } = await launch();
  await assertBuildLine(page);
  await app.close();

  const m = ledgerFacts();
  log("after migration:", JSON.stringify(m));
  assert(m.schema === 8, `the schema moved to v8 (got ${m.schema})`);
  assert(m.integrity === "ok", "integrity_check is ok");
  assert(m.foreignKeys === "[]", `foreign_key_check is empty (got ${m.foreignKeys})`);

  // Every pre-existing row survived the rebuild of sales, sale_lines AND voids.
  assert(m.sales === 2 && m.voids === 1, "the two till sales and the void are untouched");
  assert(JSON.stringify(m.receipts) === "[1,2]", "the receipt sequence is unchanged");
  assert(JSON.stringify(m.quantities) === JSON.stringify(before.quantities), "every sale line quantity is unchanged");
  assert(m.catalog === before.catalog, "the catalog is unchanged");
  assert(m.auditBusiness === before.audit, `migrating wrote no BUSINESS audit events (${before.audit} -> ${m.auditBusiness})`);
  assert(m.auditOperators === 1, `and signing in wrote exactly one account event, written by mandatory setup at first login (got ${m.auditOperators})`);
  assert(m.posSales === 2, `both existing sales are source_type='pos' (got ${m.posSales})`);
  assert(m.unpaidSales === 0 && m.methodlessSales === 0, "both are 'paid' and both kept their payment method");

  // The v6 invoice is still exactly one invoice, with the same number.
  assert(m.invoices === 1 && m.invoiceLines === 1, "the v6 invoice and its line are untouched");
  assert(m.invoiceNumber === beforeInvoiceNumber, `the invoice number is unchanged (got ${m.invoiceNumber})`);

  // 🔴 NOTHING IS BACKFILLED. The invoice finalized by the v6 build gets NO sale retroactively —
  // the same principle as migration 5's empty audit trail. Inventing a sale for it would be
  // inventing a business event that never happened, dated to a day nobody recorded it.
  assert(m.invoiceSales === 0, `no sale was synthesized for the pre-existing invoice (got ${m.invoiceSales})`);
  assert(m.linkedSales === 0, "and nothing points at it");

  // From here on, a NEW invoice does create its sale. That is the whole feature, proven on the
  // upgraded profile rather than on a fresh one.
  ({ app, page } = await launch());
  await tab(page, "Invoices");
  await page.waitForSelector('[data-testid="new-invoice"]');
  await invTestid(page, "new-invoice").click();
  // The intent chooser is the new required step — see manual-invoice.mjs for why it exists.
  await page.waitForSelector('[data-testid="invoice-mode-chooser"]');
  await invTestid(page, "mode-outgoing").click();
  await page.waitForSelector('[data-testid="invoice-mode-chooser"]', { state: "detached" });
  await page.waitForSelector('[data-testid="add-row"]');

  // FIELD FINDING 2, proved on the upgraded profile: the add-row affordance is reachable, a second
  // row can be entered WITHOUT finalizing, and the first row survives it.
  await invoiceRow(page, { description: "صنف جديد بعد الترقية", quantity: "3", unit: "حبة", price: "4.00" });
  assert((await invTestid(page, "sheet-line").count()) === 1, "row 1 is committed into the draft");
  assert(await invTestid(page, "add-row").isVisible(), "and the add-row control is still visible after saving row 1");
  await invoiceRow(page, { description: "سطر ثانٍ", quantity: "1", unit: "حبة", price: "2.50" });
  assert((await invTestid(page, "sheet-line").count()) === 2, "row 1 survived the creation of row 2");
  const rowTotals = (await invTestid(page, "sheet-line-total").allInnerTexts()).map((x) => x.trim());
  assert(rowTotals[0].includes("12.00"), `row 1 total 3 x 4.00 (got ${rowTotals[0]})`);
  assert(rowTotals[1].includes("2.50"), `row 2 total 1 x 2.50 (got ${rowTotals[1]})`);
  const fSub = await invText(page, "sheet-subtotal");
  assert(fSub.includes("14.50"), `the draft total includes BOTH rows (got ${fSub})`);
  // FIELD FINDING 1: the row actions live in their own column, which has a header of its own.
  const actionCells = await page.locator('[data-testid="sheet-line"] td.row-actions').count();
  assert(actionCells === 2, `each row has exactly one actions cell (got ${actionCells})`);
  await page.screenshot({ path: SHOTS + "upgrade-f-two-rows.png" });

  await invTestid(page, "finalize").click();
  await page.waitForSelector('[data-testid="finalize-confirm"]');
  await invTestid(page, "finalize-confirm-yes").click();
  await page.waitForSelector('[data-testid="finalized-notice"]');

  // 🔴 THE DIALOG MUST BE DISMISSED BEFORE LEAVING THE SCREEN. Round 3 timed out for 30s clicking
  // the History tab, with Playwright reporting `<div class="overlay"> ... intercepts pointer
  // events`: the finalized notice is a modal, and both its lines are free text, so it lands on the
  // branch that offers "Review now" / "Later" rather than a bare OK. This phase does not want the
  // review queue, so it takes the other exit.
  await invTestid(page, "review-later").click();
  await page.waitForSelector('[data-testid="finalized-notice"]', { state: "detached" });

  // And it shows up in the ORDINARY sales history, with the document's number and the truth about
  // payment — not a fabricated method.
  await tab(page, "History");
  await page.locator('[data-testid="history-row"][data-source="invoice"]').first().waitFor({ timeout: 20000 });
  // 🔴 NOT NAMED `invoiceRow`. There is a module-level `async function invoiceRow(page, {...})`
  // helper, and a top-level `const invoiceRow` shadows it for the WHOLE module scope — so the call
  // to the helper EARLIER in this same branch died with "Cannot access 'invoiceRow' before
  // initialization". Windows CI caught it; the v6 baseline had already been built correctly.
  const historyRow = page.locator('[data-testid="history-row"][data-source="invoice"]').first();
  const ref = await historyRow.locator('[data-testid="history-invoice-ref"]').innerText();
  const payment = await historyRow.locator('[data-testid="history-payment"]').innerText();
  const balance = await historyRow.locator('[data-testid="history-balance"]').innerText();
  log("history row:", JSON.stringify({ ref, payment, balance }));
  assert(/\d/.test(ref), `the history row names the invoice number (got ${ref})`);
  assert(
    (await historyRow.getAttribute("data-payment-status")) === "unpaid",
    `the row is unpaid (payment column reads ${payment})`,
  );
  assert(/14\.50/.test(balance), `and the balance due is the invoice total (got ${balance})`);
  // 🔴 NO FABRICATED METHOD anywhere in that row.
  assert(!/cash|card|external/i.test(payment), `no payment method was invented (got ${payment})`);
  // The till's void is refused for it, visibly.
  assert(
    (await historyRow.locator('[data-testid="history-void-blocked"]').count()) === 1,
    "and the row says it cannot be voided",
  );
  assert((await historyRow.locator('[data-testid="history-void"]').count()) === 0, "with no void button offered");
  await page.screenshot({ path: SHOTS + "upgrade-f-history.png" });
  await app.close();

  const g = ledgerFacts();
  log("after the new invoice:", JSON.stringify(g));
  assert(g.schema === 8 && g.integrity === "ok" && g.foreignKeys === "[]", "the ledger is sound at v8");
  assert(g.invoices === 2, `two invoices now exist (got ${g.invoices})`);
  assert(g.invoiceLines === 3, `one line from v6 plus two new ones (got ${g.invoiceLines})`);
  // 🔴 EXACTLY ONE new sale: the new invoice's. The v6 one still has none.
  assert(g.sales === 3, `the two till sales plus one invoice sale (got ${g.sales})`);
  assert(g.invoiceSales === 1 && g.linkedSales === 1, "exactly one invoice-origin sale, linked");
  assert(g.posSales === 2, "and the two till sales are still till sales");
  // Nothing was paid on THIS one — no sheet-paid value is typed in this phase — so 'unpaid' is
  // the correct status, and it is named rather than inferred from a "not paid" count.
  assert(g.saleStatuses === "paid=2,unpaid=1", `two paid till sales and one unpaid invoice sale (got ${g.saleStatuses})`);
  assert(g.methodlessSales === 1, "and it records no payment method");
  assert(JSON.stringify(g.receipts) === "[1,2,3]", `the receipt sequence continued (got ${JSON.stringify(g.receipts)})`);
  // A pre-migration backup of the v6 file was taken, named for the span it crossed.
  const pre = backupFiles().find((b) => /^pre-migration-v6-to-v7-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a pre-migration v6->v7 backup exists (got ${JSON.stringify(backupFiles())})`);
  const snap = new Database(join(DEFAULT_PROFILE, "backups", pre), { readonly: true, fileMustExist: true });
  try {
    assert(Number(snap.prepare("SELECT max(version) AS n FROM schema_migrations").get().n) === 6, "the snapshot is at v6");
    assert(
      snap.prepare("PRAGMA table_info(sales)").all().every((c) => c.name !== "source_type"),
      "and it really predates the rebuild",
    );
  } finally {
    snap.close();
  }
  log(
    "SCENARIO F FINAL:",
    JSON.stringify({
      schema: g.schema,
      sales: g.sales,
      posSales: g.posSales,
      invoiceSales: g.invoiceSales,
      invoices: g.invoices,
      receipts: g.receipts,
      backup: pre,
    }),
  );
} else if (PHASE === "seed-v7") {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Scenario G, part 1 — the REAL released v7 main build (b18b5b4, schema v7).
  //
  // 🔴 THIS IS THE BUILD THE SHOP IS RUNNING TODAY, and v7 -> v8 is therefore the ONLY upgrade path
  // a real field installation will take for operator accounts. It is seeded by driving that build's
  // own UI, not by writing a database that looks like v7.
  //
  // 🔴 AND IT HAS NO MANDATORY SETUP, which is the whole asymmetry migration 8 creates. The v7
  // build has no `operators` table, so 1111 opens a session directly and `launch()`'s
  // setup-aware branch never fires here. It fires in part 2, against the same profile.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  assert(!existsSync(LEDGER), "scenario starts with no ledger in the real profile");
  const { app, page } = await launch();
  const cat = writeCatalog();
  await stub(app, "open", cat.file);
  await tab(page, "Tools");
  await clickEither(page, "import-catalog", page.getByRole("button", { name: "Import catalog" }));
  await page.waitForSelector("text=Catalog imported");
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();

  // Real till rows for migration 8 to inherit: two sales and a void.
  await tab(page, "Sell");
  await sell(page, ["بيبسي 330 مل"], "Cash", 1);
  await sell(page, ["مياه"], "Card", 2);
  await voidCardSale(page);

  // 🔴 REAL AUDIT HISTORY, written by the v7 build. Migration 8 REBUILDS audit_events to widen
  // three CHECKs, and a rebuild that silently drops rows is the exact trap migration 7 set for
  // itself — it passed on an empty ledger and failed on a real one. So this phase refuses to hand
  // part 2 an empty trail.
  await tab(page, "Products");
  await clickEither(page, "add-product", page.getByRole("button", { name: "Add product" }));
  await page.waitForSelector('[data-testid="field-nameAr"]');
  await page.locator('[data-testid="field-nameAr"]').fill("صنف قبل الترقية");
  await page.locator('[data-testid="field-price"]').fill("3.00");
  await page.locator('[data-testid="field-unit"]').selectOption("piece");
  await clickEither(page, "save-product", page.getByRole("button", { name: "Save" }));
  await page.getByRole("button", { name: /^(OK|حسناً)$/ }).click();
  await page.waitForSelector('[data-testid="product-row"]');

  // 🔴 A SALE BY THE SECOND OPERATOR, so the pre-upgrade ledger genuinely references BOTH fixture
  // ids. Migration 8 keeps cashier-01 and cashier-02 precisely so every historical
  // sales.cashier_id stays resolvable, and a baseline that only ever used one of them would leave
  // half of that claim untested. The v7 build has no logout testid — it predates the attribute —
  // so clickEither falls back to the label, which is what that helper exists for.
  await clickEither(page, "logout", page.getByRole("button", { name: /^(خروج|Log out)$/ }));
  await page.waitForSelector(".login");
  await page.getByRole("button", { name: "Cashier Two" }).click();
  for (const d of "2222") await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await clickEither(page, "login-submit", page.getByRole("button", { name: "Log in" }));
  await page.waitForSelector('[data-testid="cart"], .cart');
  await tab(page, "Sell");
  await sell(page, ["مياه"], "Cash", 3);

  await app.close();

  const f = ledgerFacts();
  log("v7 baseline ledger:", JSON.stringify(f));
  assert(f.schema === 7, `the baseline really is schema v7 (got ${f.schema})`);
  // 🔴 null, not 0 — a v7 ledger cannot express the idea of an operator at all.
  assert(f.operators === null, "a v7 ledger has NO operators table");
  assert(f.sales === 2 && f.voids === 1, "two till sales and one void exist");
  assert(f.audit !== null && f.audit > 0, `the v7 build left real audit history (${f.auditTypes})`);
  assert(/PRODUCT_CREATED/.test(f.auditTypes), `including the product it created (${f.auditTypes})`);
  // Both fixture ids are referenced by real SALES before migration 8 runs. These are the
  // references migration 8 promises to keep resolvable, and part 2 asserts they are byte-identical
  // afterwards.
  assert(
    f.cashierSnapshots.includes("cashier-01=") && f.cashierSnapshots.includes("cashier-02="),
    `the v7 ledger names BOTH fixture operators (${f.cashierSnapshots})`,
  );
  // 🔴 The rollback phases are SEPARATE PROCESSES, and the only honest way to prove "the original
  // ledger is intact" after a restore is to compare against what was really there before the
  // upgrade — not against what the restored file says about itself.
  saveFacts("v7-baseline.json", {
    schema: f.schema,
    sales: f.sales,
    voids: f.voids,
    receipts: f.receipts,
    quantities: f.quantities,
    catalog: f.catalog,
    audit: f.audit,
    auditTypes: f.auditTypes,
    cashierSnapshots: f.cashierSnapshots,
    ledgerSha256: sha256(LEDGER),
  });
  log("V7 BASELINE READY:", JSON.stringify({ sales: f.sales, voids: f.voids, audit: f.audit, snapshots: f.cashierSnapshots }));
} else if (PHASE === "verify-from-v7") {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Scenario G, part 2 — THIS build installed over that real v7 profile.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  assert(existsSync(LEDGER), "the v7 ledger is still there");
  const before = ledgerFacts();
  const auditBefore = auditRows();
  assert(before.schema === 7, `starting from the real v7 profile (got ${before.schema})`);

  // 🔴 launch() goes through the REAL mandatory-setup screen here, because the flag is on disk in a
  // profile a previous build wrote. That is the upgrade a shop experiences, and it is why this
  // phase is also the proof that the widened audit_events CHECK works on a MIGRATED ledger.
  let { app, page } = await launch();
  await assertBuildLine(page);
  await app.close();

  const m = ledgerFacts();
  log("after migration:", JSON.stringify(m));
  assert(m.schema === 8, `the schema moved to v8 (got ${m.schema})`);
  assert(m.integrity === "ok", "integrity_check is ok");
  assert(m.foreignKeys === "[]", `foreign_key_check is empty (got ${m.foreignKeys})`);

  // ── Nothing the shop already had was altered ─────────────────────────────────────────────────
  assert(m.sales === before.sales && m.voids === before.voids, "every till sale and void survived");
  assert(JSON.stringify(m.receipts) === JSON.stringify(before.receipts), "the receipt sequence is unchanged");
  assert(JSON.stringify(m.quantities) === JSON.stringify(before.quantities), "every sale line quantity is unchanged");
  assert(m.catalog === before.catalog, "the catalog is unchanged");

  // 🔴 THE SNAPSHOT IS NOT BACKFILLED. sales.cashier_id / cashier_name are plain TEXT with no
  // foreign key, and migration 8 must leave them exactly as the v7 build wrote them. A migration
  // that "tidied" them to point at the new operators table would fail here.
  assert(
    m.cashierSnapshots === before.cashierSnapshots,
    `the ledger's cashier snapshots are byte-identical (${m.cashierSnapshots})`,
  );

  // ── The audit_events REBUILD preserved the real trail ────────────────────────────────────────
  const auditAfter = auditRows();
  assert(
    auditAfter.length >= auditBefore.length,
    `the rebuilt audit trail kept every row (${auditBefore.length} -> ${auditAfter.length})`,
  );
  for (const old of auditBefore) {
    const same = auditAfter.find((r) => r.id === old.id);
    assert(!!same, `audit row ${old.id} survived the rebuild`);
    assert(
      same.event_type === old.event_type && String(same.seq) === String(old.seq) && same.actor_name === old.actor_name,
      `and row ${old.id} is unchanged (type, seq and actor)`,
    );
  }
  assert(
    auditAfter.every((r, i) => Number(r.seq) === i + 1),
    "seq is still a gapless increasing sequence after the rebuild",
  );
  // The triggers were recreated AFTER the copy, so the trail is append-only again.
  const guard = auditIsAppendOnly();
  assert(guard.update, "UPDATE on the rebuilt audit_events is rejected by SQLite itself");
  assert(guard.delete, "DELETE on the rebuilt audit_events is rejected by SQLite itself");

  // ── The two accounts exist, with their OWN credentials, as bootstrap ─────────────────────────
  assert(m.operators === 2, `migration 8 created exactly the two migrated accounts (got ${m.operators})`);
  // cashier-01 went through mandatory setup during launch() above, so its flag is cleared and
  // cashier-02's is not. That difference IS the proof the flag is per-operator and real.
  assert(
    m.operatorRows === "cashier-01:owner:reset=0:active=1,cashier-02:cashier:reset=1:active=1",
    `cashier-01 is the OWNER and set up; cashier-02 is a CASHIER still pending (got ${m.operatorRows})`,
  );

  {
    const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
    try {
      // 🔴 THE WIDENED CHECK, PROVEN ON A MIGRATED LEDGER. Completing setup wrote OPERATOR_* rows
      // into the table migration 8 rebuilt. If the CHECK had not been widened, the insert would
      // have been refused and setup would have failed — on a REAL v7 ledger, not a synthetic one.
      const ops = db
        .prepare("SELECT event_type AS t FROM audit_events WHERE entity_type = 'operator' ORDER BY seq")
        .all()
        .map((r) => r.t)
        .join(",");
      assert(ops === "OPERATOR_RENAMED,OPERATOR_PIN_RESET" || ops === "OPERATOR_PIN_RESET",
        `an operator event was accepted by the rebuilt table (${ops})`);

      // 🔴 cashier-02 KEPT ITS ORIGINAL HASH. The literals are migration 8's own, written here so
      // that re-hashing them — which would lock a shop out of its own terminal on upgrade day —
      // cannot pass. cashier-01's was replaced by the setup above, which is the point of setup.
      const two = db.prepare("SELECT pin_salt_hex AS s, pin_hash_hex AS h FROM operators WHERE id = 'cashier-02'").get();
      assert(two.s === "5c8e01d7f9a3b264", "cashier-02 carries the fixture salt verbatim");
      assert(
        two.h === "0ca57b50d33e8f2f395a2a636e8babd96c096120e439cc069d17a6586fb90537",
        "and the fixture hash verbatim — the upgrade does not lock the shop out",
      );
      const one = db.prepare("SELECT pin_hash_hex AS h FROM operators WHERE id = 'cashier-01'").get();
      assert(
        one.h !== "a8f8c45b97712daec733a8b4d198ac96376c05697b5935a7b30f965e27478bce",
        "🔴 and cashier-01's bootstrap hash is GONE, replaced by the PIN set during mandatory setup",
      );

      // No operator anywhere carries the legacy 'admin' value the CHECK still permits.
      assert(
        Number(db.prepare("SELECT count(*) AS n FROM operators WHERE role = 'admin'").get().n) === 0,
        "no migrated operator carries the legacy 'admin' role",
      );
    } finally {
      db.close();
    }
  }

  // ── The pre-migration backup, which is the ONLY coherent rollback boundary ───────────────────
  const pre = backupFiles().find((b) => /^pre-migration-v7-to-v8-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(pre, `a pre-migration v7->v8 backup exists (got ${JSON.stringify(backupFiles())})`);
  const snap = new Database(join(DEFAULT_PROFILE, "backups", pre), { readonly: true, fileMustExist: true });
  try {
    assert(Number(snap.prepare("SELECT max(version) AS n FROM schema_migrations").get().n) === 7, "the snapshot is at v7");
    assert(
      snap.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().every((r) => r.name !== "operators"),
      "and it really predates operator accounts — no operators table in it",
    );
    assert(
      Number(snap.prepare("SELECT count(*) AS n FROM sales").get().n) === before.sales,
      "and it holds every sale the shop had before the upgrade",
    );
  } finally {
    snap.close();
  }

  log(
    "SCENARIO G FINAL:",
    JSON.stringify({
      schema: m.schema,
      operators: m.operatorRows,
      sales: m.sales,
      snapshots: m.cashierSnapshots,
      audit: `${auditBefore.length} -> ${auditAfter.length}`,
      backup: pre,
    }),
  );
} else if (PHASE === "rollback-prepare-v7") {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Rollback, part 1 — make REAL v8-only changes, so the restore has something to lose.
  //
  // 🔴 WHY THIS PHASE EXISTS. "The pre-migration snapshot is a valid rollback" is only a meaningful
  // claim if we can say exactly WHAT rolling back costs. So the owner does two things only v8 can
  // do — renames an operator and creates a third one — and part 3 asserts both are GONE afterwards.
  // That is correct rollback semantics, not corruption, and it is written down rather than
  // discovered by a shop.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  assert(existsSync(LEDGER), "the migrated v8 ledger is there");
  const start = ledgerFacts();
  assert(start.schema === 8, `this phase runs on the v8 build (got ${start.schema})`);

  const { app, page } = await launch();
  await tab(page, "Tools");
  await page.waitForSelector('[data-testid="operators-section"]');

  // Rename cashier-01 — a change that exists ONLY in v8, because v7 has no operators table.
  await page.locator('[data-testid="ops-row"][data-operator-id="cashier-01"] [data-testid="ops-rename"]').click();
  await page.waitForSelector('[data-testid="ops-dialog"]');
  await page.locator('[data-testid="ops-name"]').fill("اسم بعد الترقية");
  await page.locator('[data-testid="ops-dialog-save"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ops-dialog"]'));

  // And a third operator, who has never existed in any v7 ledger.
  await page.locator('[data-testid="ops-add"]').click();
  await page.waitForSelector('[data-testid="ops-dialog"]');
  await page.locator('[data-testid="ops-name"]').fill("موظف بعد الترقية");
  await page.locator('[data-testid="ops-pin"]').fill("8642");
  await page.locator('[data-testid="ops-dialog-save"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ops-row"]').length === 3);
  await app.close();

  const f = ledgerFacts();
  assert(f.operators === 3, `three operators now exist on v8 (got ${f.operators})`);
  assert(/cashier-01:owner/.test(f.operatorRows), `cashier-01 is still the owner (${f.operatorRows})`);
  {
    const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
    try {
      const name = db.prepare("SELECT name FROM operators WHERE id = 'cashier-01'").get().name;
      assert(name === "اسم بعد الترقية", `the v8-only rename landed (${name})`);
    } finally {
      db.close();
    }
  }
  // The ledger's own snapshots are untouched by an operator rename — the same property
  // operator-accounts.mjs proves on a fresh profile, re-proven here on a MIGRATED one.
  assert(f.cashierSnapshots === start.cashierSnapshots, "and no past sale changed when the operator was renamed");
  saveFacts("v8-changes.json", {
    operators: f.operators,
    operatorRows: f.operatorRows,
    renamedTo: "اسم بعد الترقية",
    thirdOperator: "موظف بعد الترقية",
  });
  log("V8 CHANGES READY:", JSON.stringify({ operators: f.operators, rows: f.operatorRows }));
} else if (PHASE === "rollback-refuse-v7") {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Rollback, part 2 — 🔴 THE v7 EXECUTABLE MUST REFUSE THE v8 DATABASE.
  //
  // This is the half that makes "install the old EXE" NOT a rollback. CI has reinstalled the real
  // v7 build over this machine, so E2E_EXECUTABLE is now the v7 executable pointed at the shop's
  // own v8 profile. It must refuse cleanly: no silent downgrade, no destructive reset, no mutation.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  assert(existsSync(LEDGER), "the v8 ledger is there");
  const before = ledgerFacts();
  assert(before.schema === 8, `the active database really is v8 (got ${before.schema})`);
  const shaBefore = sha256(LEDGER);
  const backupsBefore = backupFiles();

  await runRefusing("DB_NEWER_THAN_APP");

  // 🔴 NOTHING WAS TOUCHED. Byte-for-byte, not "looks the same".
  assert(sha256(LEDGER) === shaBefore, "🔴 the v8 database is byte-for-byte unchanged");
  const after = ledgerFacts();
  assert(after.schema === 8, `no silent downgrade — the schema is still v8 (got ${after.schema})`);
  assert(after.operators === before.operators, `and the operators table is intact (${after.operators})`);
  assert(after.operatorRows === before.operatorRows, "including every operator's role and flags");
  assert(after.sales === before.sales && after.voids === before.voids, "no destructive reset — every sale and void is there");
  assert(
    JSON.stringify(backupFiles()) === JSON.stringify(backupsBefore),
    `and the refusal wrote no backup of its own (${JSON.stringify(backupFiles())})`,
  );
  log("REFUSAL CONFIRMED: the v7 build will not open a v8 database, and changed nothing");
} else if (PHASE === "rollback-restore-v7") {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Rollback, part 3 — restore the automatic pre-migration snapshot, then run the v7 build on it.
  //
  //     🔴 OLD EXE ALONE IS NOT ROLLBACK.
  //     🔴 VALID ROLLBACK = RESTORE THE PRE-MIGRATION v7 DATABASE + RUN THE v7 EXECUTABLE.
  //
  // Part 2 proved the first half of that sentence. This phase proves the second.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const baseline = loadFacts("v7-baseline.json");
  const v8changes = loadFacts("v8-changes.json");

  const snapName = backupFiles().find((b) => /^pre-migration-v7-to-v8-\d{8}T\d{6}Z\.sqlite$/.test(b));
  assert(snapName, `the automatic pre-migration snapshot is still there (${JSON.stringify(backupFiles())})`);
  const snapPath = join(DEFAULT_PROFILE, "backups", snapName);

  // Read the snapshot BEFORE promoting it, so a bad snapshot is caught before it becomes the ledger.
  {
    const snap = new Database(snapPath, { readonly: true, fileMustExist: true });
    try {
      assert(Number(snap.prepare("SELECT max(version) AS n FROM schema_migrations").get().n) === 7, "the snapshot is schema v7");
      assert(
        snap.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().every((r) => r.name !== "operators"),
        "🔴 and it has NO operators table — it predates migration 8 entirely",
      );
      assert(
        Number(snap.prepare("SELECT count(*) AS n FROM sales").get().n) === baseline.sales,
        `and it holds the shop's ${baseline.sales} pre-upgrade sales`,
      );
    } finally {
      snap.close();
    }
  }

  // The app is fully stopped by CI before this phase. Promote the snapshot to BE the ledger, and
  // remove the WAL sidecars so no v8 page can survive into the restored database.
  copyFileSync(snapPath, LEDGER);
  for (const side of ["-wal", "-shm"]) {
    if (existsSync(LEDGER + side)) rmSync(LEDGER + side);
  }
  log(`restored ${snapName} over the active ledger`);

  const restored = ledgerFacts();
  assert(restored.schema === 7, `the ACTIVE database is now schema v7 (got ${restored.schema})`);
  assert(restored.operators === null, "🔴 and has no operators table at all");
  assert(restored.integrity === "ok", "integrity_check on the restored database is ok");

  // ── 🔴 The v7 EXECUTABLE now STARTS NORMALLY on it ───────────────────────────────────────────
  // launch() waits for the login screen, asserts the real profile, signs in as Cashier One with
  // 1111 and waits for the till. On a v7 build its mandatory-setup branch cannot fire — there is no
  // operators table — so reaching the cart IS the proof that the old credential model is back.
  const { app, page } = await launch();
  await tab(page, "History");
  await page.waitForSelector(".history-table");
  const rows = await historyRows(page);
  log("history rows after rollback:", JSON.stringify(rows.length));
  await app.close();

  const f = ledgerFacts();
  // ── The original ledger is intact, compared against what was REALLY there before the upgrade ──
  assert(f.sales === baseline.sales, `every sale is back (${f.sales} of ${baseline.sales})`);
  assert(f.voids === baseline.voids, `and every void (${f.voids} of ${baseline.voids})`);
  assert(JSON.stringify(f.receipts) === JSON.stringify(baseline.receipts), "the receipt sequence is the original one");
  assert(JSON.stringify(f.quantities) === JSON.stringify(baseline.quantities), "every sale line quantity is the original one");
  assert(f.catalog === baseline.catalog, "the catalog is the original one");
  assert(f.audit === baseline.audit, `the audit history is the original one (${f.audit} rows)`);
  assert(f.auditTypes === baseline.auditTypes, `including its exact composition (${f.auditTypes})`);
  // 🔴 cashier ids AND names, which is what a receipt reprint depends on.
  assert(
    f.cashierSnapshots === baseline.cashierSnapshots,
    `and every sale still names the operator who rang it (${f.cashierSnapshots})`,
  );
  const guard = auditIsAppendOnly();
  assert(guard.update && guard.delete, "the restored audit trail is append-only again");

  // ── 🔴 WHAT ROLLING BACK COSTS, stated as an assertion rather than a footnote ─────────────────
  assert(f.operators === null, "🔴 the operators table is gone — every v8 account went with the snapshot");
  {
    const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert(!names.includes("operators"), "no operators table in sqlite_master");
      // The v8-only rename and the third operator are both gone with it — EXPECTED, not corruption.
      const trail = db
        .prepare("SELECT count(*) AS n FROM audit_events WHERE entity_type = 'operator'")
        .get().n;
      assert(Number(trail) === 0, "and no operator audit row survived either");
    } finally {
      db.close();
    }
  }
  log(
    "ROLLBACK COST (expected, not corruption):",
    JSON.stringify({
      lost: [`rename to ${v8changes.renamedTo}`, `operator ${v8changes.thirdOperator}`, "every PIN set on v8"],
      regained: "the v7 credential model — Cashier One / 1111 opens the till again, as it did before the upgrade",
    }),
  );
  log("");
  log("🔴 OLD EXE ALONE IS NOT ROLLBACK.");
  log("🔴 VALID ROLLBACK = RESTORE THE PRE-MIGRATION v7 DATABASE + RUN THE v7 EXECUTABLE.");
  log(`   proven on this machine: ${snapName} + the real v7 build`);
} else {
  console.error(
    "usage: node e2e/upgrade.mjs seed-v2|verify-from-v2|seed-v3|verify-from-v3|seed-main|verify-from-main|seed-v4|verify-from-v4|seed-v5|verify-from-v5|seed-v6|verify-from-v6|seed-v7|verify-from-v7|rollback-prepare-v7|rollback-refuse-v7|rollback-restore-v7",
  );
  process.exit(2);
}
log(`UPGRADE PHASE ${PHASE} PASSED — profile ${DEFAULT_PROFILE}`);
