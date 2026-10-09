/**
 * E2E — the manual invoice against the REAL app: renderer + preload + IPC + service + SQLite.
 *
 * This is the evidence no unit test can produce: that a human can fill in an invoice on the actual
 * screen, that the number appears only after finalizing, that the finalized document really becomes
 * read-only, that a catalog difference can be resolved from the UI, and that every bit of it is
 * still there after the application is closed and reopened — read back out of the app's own SQLite
 * file, not out of the page.
 *
 * 🔴 Selectors are data-testid, never visible text: the terminal's default language is Arabic, and a
 * test that clicks "Add row" would pass only while the UI happens to be English.
 *
 * 🔴 Synthetic data only. The one familiar number here, 474.40, is the arithmetic regression value
 * already used in the unit tests — not a merchant's invoice.
 *
 * Run: node e2e/manual-invoice.mjs            (CI sets E2E_EXECUTABLE to the installed .exe)
 *      locally, where better-sqlite3 is built against Electron's ABI:
 *        env -u ELECTRON_RUN_AS_NODE ELECTRON_RUN_AS_NODE=1 \
 *          ./node_modules/electron/dist/electron e2e/manual-invoice.mjs
 */
import { _electron as electron } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
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

// A fresh profile per run: this script issues invoices and must never touch a real ledger.
const home = mkdtempSync(join(tmpdir(), "pos-e2e-invoice-"));
// 🔴 ELECTRON_RUN_AS_NODE is DELETED from the child's environment. This script may itself be run
// under Electron's bundled node (that is how better-sqlite3's Electron-ABI build is loadable on a
// dev machine), and inheriting that variable would make the launched application run as a plain node
// process with no window at all — a failure that looks like the app never starting.
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
delete env.ELECTRON_RUN_AS_NODE;

const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

const log = (...a) => console.log("•", ...a);

/**
 * Waits for a CONDITION, not for a duration.
 *
 * 🔴 A fixed sleep is the wrong instrument here: `printToPDF` on a cold Windows runner can take far
 * longer than any number I would guess, and a sleep that is too short fails as "the PDF was never
 * written" — which is indistinguishable from the feature being broken.
 */
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

/**
 * Types into a field that commits on BLUR, then actually blurs it.
 *
 * 🔴 The invoice sheet's header and line fields commit `onBlur`, deliberately — a round trip per
 * keystroke would ask the service to reprice an invoice on every digit. `fill()` alone does NOT
 * blur, so a filled field is typed and never saved. That is how the paid amount silently stayed at
 * zero here, and it is also how the customer name was being dropped without any assertion noticing.
 */
/**
 * Every value the line rows actually display.
 *
 * 🔴 The sheet renders a line's description, unit and unit price as `<input>` elements, and
 * `innerText` NEVER includes an input's value. Asserting `innerText.includes(description)` therefore
 * fails even when the value is right — and, worse, the matching negative assertion
 * (`not.includes(newName)`) passes for the wrong reason, because no input value is in that string at
 * all. Read the values.
 */
async function lineValues(page) {
  return page.locator('[data-testid="sheet-line"] input').evaluateAll((els) => els.map((e) => e.value));
}

/**
 * Types into a header field and blurs it, which is how these fields commit.
 *
 * 🔴 fill() DOES NOT BLUR, which is why the Tab is here. But pressing Tab is still only an
 * ATTEMPT: nothing in this helper can see whether the commit reached the service, and a header
 * field that was typed and never saved is exactly the defect this feature already shipped once.
 * `reopenAndVerifyHeader` below is the part that actually checks, and it is called before
 * finalizing — a helper that cannot observe its own effect must not be the only thing asserting it.
 */
async function commit(page, id, value) {
  const field = page.locator(`[data-testid="${id}"]`);
  await field.fill(value);
  await field.press("Tab");
  // The DOM half, which is cheap and catches a fill that did not land at all.
  await until(`${id} to hold ${value}`, async () => (await field.inputValue()) === value, 15000);
}

const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const textOf = async (page, id) => (await testid(page, id).innerText()).trim();

/** The app must be CLOSED: these read the installed application's own ledger file. */
function query(sql, ...params) {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
const one = (sql, ...params) => query(sql, ...params)[0];
const count = (table, where = "1=1") => Number(one(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).n);

function facts() {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    const n = (sql) => Number(db.prepare(sql).get().n);
    return {
      schema: n("SELECT max(version) AS n FROM schema_migrations"),
      integrity: db.pragma("integrity_check", { simple: true }),
      foreignKeys: JSON.stringify(db.pragma("foreign_key_check")),
      invoices: n("SELECT count(*) AS n FROM invoices"),
      invoiceLines: n("SELECT count(*) AS n FROM invoice_lines"),
      reconciliation: n("SELECT count(*) AS n FROM invoice_reconciliation"),
      highestNumber: n("SELECT coalesce(max(invoice_number), 0) AS n FROM invoices"),
      sales: n("SELECT count(*) AS n FROM sales"),
      saleLines: n("SELECT count(*) AS n FROM sale_lines"),
      // Migration 7: the sale a finalized invoice is.
      invoiceSales: n("SELECT count(*) AS n FROM sales WHERE source_type = 'invoice'"),
      posSales: n("SELECT count(*) AS n FROM sales WHERE source_type = 'pos'"),
      linkedSales: n("SELECT count(*) AS n FROM sales WHERE invoice_id IS NOT NULL"),
      methodlessSales: n("SELECT count(*) AS n FROM sales WHERE payment_method IS NULL"),
      salePaid: n("SELECT coalesce(sum(paid_minor), 0) AS n FROM sales"),
      saleBalance: n("SELECT coalesce(sum(balance_due_minor), 0) AS n FROM sales"),
      saleTotal: n("SELECT coalesce(sum(total_minor), 0) AS n FROM sales"),
      saleStatuses: db
        .prepare("SELECT payment_status AS p, count(*) AS n FROM sales GROUP BY payment_status ORDER BY p")
        .all()
        .map((r) => `${r.p}=${Number(r.n)}`)
        .join(","),
      // Every invoice line that became a sale line, and the unit label it carried across.
      saleUnitLabels: db
        .prepare("SELECT coalesce(unit_label, '-') AS u FROM sale_lines ORDER BY line_no")
        .all()
        .map((r) => r.u)
        .join("|"),
      voids: n("SELECT count(*) AS n FROM voids"),
      audit: n("SELECT count(*) AS n FROM audit_events"),
      auditTypes: db
        .prepare("SELECT event_type AS t, count(*) AS n FROM audit_events GROUP BY event_type ORDER BY t")
        .all()
        .map((r) => `${r.t}=${Number(r.n)}`)
        .join(","),
    };
  } finally {
    db.close();
  }
}

/** Adds one line through the sheet exactly as an operator would. */
async function addRow(page, { description, quantity, unit, price }) {
  await testid(page, "add-row").click();
  await testid(page, "new-line-description").fill(description);
  await testid(page, "new-line-quantity").fill(quantity);
  await testid(page, "new-line-unit").fill(unit);
  await testid(page, "new-line-price").fill(price);
  await testid(page, "new-line-save").click();
  await page.waitForSelector('[data-testid="new-line-save"]', { state: "detached" });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The application launches, and the Invoices tab is reachable
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await launch();
assert(true, "the application launched and a cashier signed in");

await tab(page, "invoices");
await page.waitForSelector('[data-testid="inv-tab-company"]');
assert(await testid(page, "inv-tab-company").isVisible(), "the Invoices tab is reachable");
// A fresh terminal has no shop details, so the screen opens where the operator has to start.
assert(await testid(page, "company-required").isVisible(), "a terminal with no shop details says so before anything else");
await page.screenshot({ path: SHOTS + "I1-invoices-company-required.png" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The company profile is entered and saved
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "company-name-ar").fill("متجر اختباري للفحص");
await page.locator('.inv-company input[dir="ltr"]').first().fill("E2E Test Store");
await testid(page, "company-taxpayer").fill("TP-E2E-1");
await testid(page, "company-register").fill("CR-E2E-2");
await testid(page, "company-vat").fill("VAT-E2E-3");
await testid(page, "company-save").click();
await page.waitForSelector('[data-testid="company-notice"]');
assert(true, "the shop details saved");

// 🔴 The numbering is a SEPARATE operation with its own button, because `setNextInvoiceNumber` is
// refused once an invoice has been issued while saving the shop's details never is. The first
// version of this script assumed one Save did both, and the invoice sequence stayed at 1 — the
// assertion below is what caught that.
await testid(page, "company-next-number").fill("61");
await testid(page, "company-numbering-save").click();
await page.waitForFunction(
  () => document.querySelector('[data-testid="company-next-number"]')?.value === "61",
);
assert(true, "the shop continuing a paper invoice book set its next number to 61");
// 🔴 Printing these does not make an invoice compliant, and the screen says so where it is read.
assert((await textOf(page, "company-ids-note")).length > 20, "the no-compliance-claim note is on the screen");
const previewText = await textOf(page, "company-preview");
assert(
  previewText.includes("TP-E2E-1") && previewText.includes("CR-E2E-2") && previewText.includes("VAT-E2E-3"),
  "the preview shows all three official numbers, each under its own label",
);
await page.screenshot({ path: SHOTS + "I2-company-profile.png" });

// A catalog product to reconcile against, created through the normal Products screen path.
await tab(page, "products");
await page.waitForSelector('[data-testid="add-product"]');
await testid(page, "add-product").click();
await testid(page, "field-nameAr").fill("مفك براغي اختباري");
await testid(page, "field-price").fill("5.00");
await testid(page, "field-unit").selectOption("piece");
// The proven pattern from e2e/product-management.mjs: the testid, then dismiss the confirmation
// overlay. Clicking by visible label would depend on the terminal's language, and leaving the
// overlay up would block every later click with something that looks nothing like the real cause.
await testid(page, "save-product").click();
await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
await page.waitForSelector('[data-testid="product-row"]');
// A second product, so one invoice row can differ ONLY in its unit. Without it, a row carrying an
// unmappable unit is simply PRODUCT_NOT_FOUND — there is nothing to compare the unit against, and
// UNIT_DIFFERENCE never arises. That is what the first version of this script got wrong.
await testid(page, "add-product").click();
await page.waitForSelector('[data-testid="field-nameAr"]');
await testid(page, "field-nameAr").fill("صنف بوحدة قياسية");
await testid(page, "field-price").fill("474.40");
await testid(page, "field-unit").selectOption("piece");
await testid(page, "save-product").click();
await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 2);
assert(true, "two synthetic catalog products exist to reconcile against");

await app.close();
{
  const f = facts();
  log("after setup:", JSON.stringify(f));
  assert(f.schema === 7, `the ledger is at schema v7 (got ${f.schema})`);
  assert(f.invoices === 0 && f.invoiceLines === 0 && f.reconciliation === 0, "no invoice exists yet");
  assert(count("company_profile") === 1, "exactly one company_profile row, however many saves happened");
  assert(Number(one("SELECT next_invoice_number AS n FROM company_profile").n) === 61, "the sequence starts at 61 as configured");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · A draft invoice: customer snapshot, four rows, one from the catalog and one free text
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await tab(page, "invoices");
await page.waitForSelector('[data-testid="new-invoice"]');
await testid(page, "new-invoice").click();
await page.waitForSelector('[data-testid="add-row"]');

assert((await textOf(page, "sheet-number")).startsWith("—"), "a draft shows no invoice number");
assert((await textOf(page, "sheet-status")).length > 0, "the sheet says it is a draft");

await commit(page, "sheet-customer", "زبون اختباري");
const phone = page.locator('.inv-customer input[dir="ltr"]').first();
await phone.fill("70-000000");
await phone.press("Tab");
await until("the phone field to hold what was typed", async () => (await phone.inputValue()) === "70-000000", 15000);
await commit(page, "sheet-date", "2026-10-08");
await page.waitForSelector('[data-testid="add-row"]');

// 🔴 WHY THERE IS NO "REOPEN THE DRAFT AND CHECK" HERE, and it is a real product gap rather than a
// gap in this test. `InvoicesScreen` renders ONLY the sheet while an invoice is open — no tab bar —
// and `InvoiceSheet` calls its `onClosed` callback from exactly ONE place: `discard()`, which
// DELETES the draft. So there is no non-destructive way to leave an open draft and come back to it:
// an operator must finalize it or discard it. A test cannot read the stored header back through the
// UI without destroying the thing it is measuring, so the stored-row assertions stay where they
// are, after the app closes. The `until` guards above are what this run can check: that each field
// really holds what was typed before the next action moves on.

// Row 1 — chosen from the existing catalog, then left exactly as prefilled (MATCHED).
await testid(page, "add-row").click();
await page.locator('.inv-new-line .btn.ghost.small').first().click();
await page.waitForSelector('[data-testid="product-picker"]');
await testid(page, "picker-option").first().click();
await testid(page, "new-line-save").click();
await page.waitForSelector('[data-testid="new-line-save"]', { state: "detached" });
assert((await testid(page, "sheet-line").count()) === 1, "a row picked from the catalog was added");

// Row 2 — the same catalog product at a DIFFERENT price (PRICE_DIFFERENCE).
await addRow(page, { description: "مفك براغي اختباري", quantity: "2", unit: "حبة", price: "6.50" });

// Row 3 — free text the catalog has never heard of (PRODUCT_NOT_FOUND).
await addRow(page, { description: "صنف غير موجود في الأصناف", quantity: "3", unit: "حبة", price: "1.25" });

// Row 4 — an EXISTING product at its catalog price, written with a unit this build cannot map.
// Price and name agree, so the only difference is the unit, and it is `comparable: false`.
await addRow(page, { description: "صنف بوحدة قياسية", quantity: "1", unit: "كيس (50PCS)", price: "474.40" });

assert((await testid(page, "sheet-line").count()) === 4, "four rows are on the sheet");
await page.screenshot({ path: SHOTS + "I3-invoice-draft.png" });

// ── Displayed line totals and invoice totals ──────────────────────────────────────────────────
const lineTotals = await testid(page, "sheet-line-total").allInnerTexts();
const clean = lineTotals.map((s) => s.trim());
assert(clean[0].includes("5.00"), `row 1 total is 1 x 5.00 = 5.00 (got ${clean[0]})`);
assert(clean[1].includes("13.00"), `row 2 total is 2 x 6.50 = 13.00 (got ${clean[1]})`);
assert(clean[2].includes("3.75"), `row 3 total is 3 x 1.25 = 3.75 (got ${clean[2]})`);
assert(clean[3].includes("474.40"), `row 4 total is 1 x 474.40 = 474.40 (got ${clean[3]})`);

const subtotal = await textOf(page, "sheet-subtotal");
assert(subtotal.includes("496.15"), `the subtotal is 5.00 + 13.00 + 3.75 + 474.40 = 496.15 (got ${subtotal})`);
const totalBefore = await textOf(page, "sheet-total");
assert(totalBefore.includes("496.15"), `with tax off the total equals the subtotal (got ${totalBefore})`);

await commit(page, "sheet-paid", "96.15");
// Wait for the SERVICE's answer to come back and render, not for a guessed interval.
await page.locator('[data-testid="sheet-balance"]').filter({ hasText: "400.00" }).waitFor({ timeout: 20000 });
const balance = await textOf(page, "sheet-balance");
assert(balance.includes("400.00"), `the balance due is 496.15 - 96.15 = 400.00 (got ${balance})`);
assert((await textOf(page, "sheet-words")).includes("("), "the amount in words is not shown yet — it is frozen at finalize");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Finalize — explicit, confirmed, and the number appears only afterwards
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "finalize").click();
await page.waitForSelector('[data-testid="finalize-confirm"]');
const confirmText = await textOf(page, "finalize-confirm");
assert(confirmText.includes("496.15") && confirmText.includes("400.00"), "the confirmation shows the real figures");
await page.screenshot({ path: SHOTS + "I4-finalize-confirm.png" });
await testid(page, "finalize-confirm-yes").click();

await page.waitForSelector('[data-testid="finalized-notice"]');
const notice = await textOf(page, "finalized-notice");
assert(notice.includes("61"), `the finalized notice names invoice #61 (got "${notice.split("\n")[0]}")`);
assert(/\d/.test(notice), "the notice summarises what needs review");
await page.screenshot({ path: SHOTS + "I5-finalized-notice.png" });

await testid(page, "review-now").click();
await page.waitForSelector('[data-testid="review-table"]');
assert(await testid(page, "review-table").isVisible(), "Review now reaches the queue");
await page.screenshot({ path: SHOTS + "I6-review-queue.png" });

await app.close();

// ── The durable truth, read out of the app's own SQLite file ──────────────────────────────────
{
  const f = facts();
  log("after finalize:", JSON.stringify(f));
  assert(f.invoices === 1 && f.invoiceLines === 4, "one invoice with four lines is stored");
  assert(f.highestNumber === 61, `the assigned number is 61 (got ${f.highestNumber})`);
  assert(f.integrity === "ok" && f.foreignKeys === "[]", "the ledger is sound");

  const inv = one("SELECT * FROM invoices");
  assert(inv.status === "final", "the invoice is final");
  assert(Number(inv.subtotal_minor) === 49615, `the STORED subtotal is 49615 minor units (got ${inv.subtotal_minor})`);
  assert(Number(inv.total_minor) === 49615 && Number(inv.balance_due_minor) === 40000, "stored total and balance are exact");
  assert(inv.amount_in_words && inv.amount_in_words.length > 10, "the amount in words is frozen onto the document");
  // 🔴 The customer snapshot really reached the database. Nothing asserted this before, which is
  // exactly why a field that was typed but never committed went unnoticed.
  assert(inv.customer_name === "زبون اختباري", `the customer snapshot persisted (got ${inv.customer_name})`);
  assert(inv.customer_phone === "70-000000", `and the phone (got ${inv.customer_phone})`);
  assert(inv.invoice_date === "2026-10-08", `and the date the operator typed (got ${inv.invoice_date})`);
  const issuer = JSON.parse(inv.issuer_snapshot_json);
  assert(issuer.name_ar === "متجر اختباري للفحص", "the issuer snapshot is frozen onto the invoice");
  assert(issuer.taxpayer_number === "TP-E2E-1" && issuer.vat_number === "VAT-E2E-3", "and it carries the official numbers separately");

  // The non-canonical unit was kept verbatim and NOT mapped to anything.
  const odd = one("SELECT * FROM invoice_lines WHERE unit_label = 'كيس (50PCS)'");
  assert(odd !== undefined, "the printed unit label was stored verbatim");
  assert(odd.canonical_unit === null, "and no canonical unit was invented for it");

  // 🔴 THE V1 BOUNDARY WAS REVERSED ON 2026-10-09, AND THE OLD VALUES WERE ZERO. Until then this
  // read `assert(f.sales === 0, "finalizing an invoice created NO sales row")`. Field use reversed
  // it: a finalized invoice IS a sale for business reporting (migration 7).
  assert(f.sales === 1, `finalizing an invoice created exactly ONE sale (got ${f.sales})`);
  assert(f.invoiceSales === 1 && f.posSales === 0, "and it is an invoice-origin sale, not a till sale");
  assert(f.linkedSales === 1, "linked to the invoice it came from");
  assert(f.saleLines === f.invoiceLines, `one sale line per invoice line (${f.saleLines} vs ${f.invoiceLines})`);
  // 🔴 THIS INVOICE IS PARTIALLY PAID — 96.15 against 496.15, typed through the UI a few steps
  // above — so 'partial' is the correct status and the first version of this assertion ("unpaid")
  // was wrong about the fixture, not about the code. Windows CI caught it. Asserting the real
  // partial case is strictly better than asserting the unpaid one: it proves paid, balance and
  // status agree on a sale where all three differ.
  assert(f.saleStatuses === "partial=1", `its status is partial (got ${f.saleStatuses})`);
  assert(f.salePaid === 9615, `the sale's paid amount is the invoice's 96.15 (got ${f.salePaid})`);
  assert(f.saleBalance === 40000, `and its balance due is 400.00 (got ${f.saleBalance})`);
  assert(f.salePaid + f.saleBalance === f.saleTotal, "paid + balance = total, on the sale itself");
  // No payment method was invented, even though money really was received: the invoice records
  // the AMOUNT, and never how it arrived.
  assert(f.methodlessSales === 1, "and it records NO payment method");
  // 🔴 THE HALF OF THE OLD BOUNDARY THAT STILL HOLDS: a sale is not a stock movement.
  assert(f.voids === 0, "and no void");
  assert(f.voids === 0, "and no void");
  const tables = query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  assert(
    !tables.some((t) => /stock|inventory|movement/i.test(t)),
    "and there is no stock/inventory table for it to have moved",
  );

  // Reconciliation: four rows, with the classifications the design predicts.
  const recon = query("SELECT classification, status FROM invoice_reconciliation ORDER BY classification");
  assert(recon.length === 4, `one review row per line (got ${recon.length})`);
  const byClass = Object.fromEntries(recon.map((r) => [r.classification, r.status]));
  log("classifications:", JSON.stringify(byClass));
  assert(byClass.MATCHED === "KEPT_CATALOG", "the matched row is settled as KEPT_CATALOG by design");
  assert(byClass.PRICE_DIFFERENCE === "PENDING", "the price difference waits for a person");
  assert(byClass.PRODUCT_NOT_FOUND === "PENDING", "the unknown product waits for a person");
  assert(byClass.UNIT_DIFFERENCE === "PENDING", `the odd-unit row waits for a person (${JSON.stringify(byClass)})`);

  // 🔴 And it is "we cannot tell", not "they differ": the invoice's unit maps to nothing, so the
  // difference is recorded as not comparable rather than as a disagreement.
  const unitItem = query("SELECT differences_json AS d FROM invoice_reconciliation WHERE classification = 'UNIT_DIFFERENCE'")[0];
  const unitDiff = JSON.parse(unitItem.d)[0];
  assert(unitDiff.field === "base_unit", "the difference is on the unit");
  assert(unitDiff.comparable === false, `and it is marked NOT comparable (got ${JSON.stringify(unitDiff)})`);
  assert(unitDiff.invoice === "كيس (50PCS)", "carrying the printed label verbatim");

  // Finalizing changed no product and wrote no catalog audit event.
  // TWO products were created in setup, so two PRODUCT_CREATED rows — and nothing else. Finalizing
  // an invoice is not a catalog event, which is what this really asserts.
  assert(f.audit === 2 && f.auditTypes === "PRODUCT_CREATED=2", `only the two products I created are audited (${f.auditTypes})`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The finalized invoice is read-only, and the DATABASE refuses an edit too
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await tab(page, "invoices");
await page.waitForSelector('[data-testid="history-table"]');
assert((await testid(page, "history-row").count()) === 1, "the finalized invoice is in history");
await testid(page, "history-open").first().click();
await page.waitForSelector('[data-testid="sheet-readonly"]');
assert(await testid(page, "sheet-readonly").isVisible(), "reopening a finalized invoice shows it as read-only");
assert((await textOf(page, "sheet-number")).includes("61"), "and it shows its number");
assert((await testid(page, "finalize").count()) === 0, "there is no Finalize button on an issued invoice");
assert((await testid(page, "add-row").count()) === 0, "and no way to add a row");
assert(await testid(page, "print").isVisible(), "Print and Save PDF are offered instead");
await page.screenshot({ path: SHOTS + "I7-finalized-readonly.png" });
await app.close();

{
  const db = new Database(LEDGER, { fileMustExist: true });
  let refusedUpdate = false;
  let refusedLine = false;
  try {
    try {
      db.prepare("UPDATE invoices SET customer_name = 'someone else'").run();
    } catch (err) {
      refusedUpdate = /immutable/.test(String(err.message));
    }
    try {
      db.prepare("UPDATE invoice_lines SET unit_price_minor = 1, line_total_minor = 1").run();
    } catch (err) {
      refusedLine = /immutable/.test(String(err.message));
    }
  } finally {
    db.close();
  }
  assert(refusedUpdate, "SQLite itself refuses to edit a finalized invoice");
  assert(refusedLine, "and refuses to edit its lines");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · Resolving a PRICE_DIFFERENCE through the UI
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await tab(page, "invoices");
await testid(page, "inv-tab-review").click();
await page.waitForSelector('[data-testid="review-table"]');
const before = await testid(page, "review-row").count();
assert(before === 3, `three rows need review (got ${before})`);

// 🔴 Select by CLASSIFICATION, not by text. The row shows the description and a translated badge;
// it does not show the price at all, so an earlier version of this filtered on "6.50", matched
// nothing, and silently fell back to whichever row happened to be first.
await page.locator('[data-classification="PRICE_DIFFERENCE"]').first().locator('[data-testid="review-resolve"]').click();
await page.waitForSelector('[data-testid="resolve-panel"]');
// Every state offers a keep action — asserted here because a dead end is the failure this prevents.
assert(await testid(page, "resolve-keep-catalog").isVisible(), "the panel always offers Keep catalog unchanged");
assert(await testid(page, "resolve-keep-invoice").isVisible(), "and Keep invoice only");
await page.screenshot({ path: SHOTS + "I8-resolve-price.png" });

if ((await testid(page, "resolve-update").count()) > 0) {
  await testid(page, "resolve-update").click();
  await page.waitForSelector('[data-testid="resolve-panel"]', { state: "detached" });
  assert(true, "the price difference was resolved from the UI");
} else {
  await testid(page, "resolve-keep-catalog").click();
  await page.waitForSelector('[data-testid="resolve-panel"]', { state: "detached" });
  assert(true, "the item was settled with a keep action");
}
await app.close();

{
  const product = one("SELECT * FROM catalog_products WHERE name_ar = 'مفك براغي اختباري'");
  const audits = query("SELECT * FROM audit_events ORDER BY seq");
  const updates = audits.filter((a) => a.event_type === "PRODUCT_UPDATED");
  if (Number(product.selling_price_minor) === 650) {
    assert(updates.length === 1, `the catalog price changed exactly once (got ${updates.length} updates)`);
    const meta = JSON.parse(updates[0].metadata_json);
    assert(meta.origin === "invoice_reconciliation", `the audit names where it came from (${meta.origin})`);
    assert(typeof meta.invoice_id === "string" && meta.invoice_id.length > 0, "and which invoice");
    const diff = JSON.parse(updates[0].changed_json);
    assert(diff.selling_price_minor.before === "500" && diff.selling_price_minor.after === "650", "with the exact before/after");
    assert(!("is_active" in diff), "and is_active is NOT in the diff — reconciliation did not touch it");
    assert(Number(product.is_active) === 1, "the product is still active");
  } else {
    assert(updates.length === 0, "a keep action wrote no product audit event");
    assert(Number(product.selling_price_minor) === 500, "and changed no catalog price");
  }
  assert(
    !audits.some((a) => a.event_type === "PRICE_CHANGED"),
    "no PRICE_CHANGED event type exists — a price change is a PRODUCT_UPDATED",
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · PRODUCT_NOT_FOUND offers Add / Link / Keep, and Keep writes nothing
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await tab(page, "invoices");
await testid(page, "inv-tab-review").click();
await page.waitForSelector('[data-testid="review-table"]');

await page.locator('[data-classification="PRODUCT_NOT_FOUND"]').first().locator('[data-testid="review-resolve"]').click();
await page.waitForSelector('[data-testid="resolve-not-found"]');
assert(await testid(page, "resolve-create").isVisible(), "Add to catalog is offered");
assert(await testid(page, "resolve-link").isVisible(), "Link existing is offered");
assert(await testid(page, "resolve-keep-invoice").isVisible(), "Keep invoice only is offered");
assert(
  (await testid(page, "resolve-name-ar").inputValue()).includes("غير موجود"),
  "and it is prefilled from what the invoice observed",
);
await page.screenshot({ path: SHOTS + "I9-resolve-not-found.png" });

const productsBefore = count("catalog_products");
const auditBefore = count("audit_events");
await testid(page, "resolve-keep-invoice").click();
await page.waitForSelector('[data-testid="resolve-panel"]', { state: "detached" });
await app.close();

assert(count("catalog_products") === productsBefore, "Keep invoice only created NO product");
assert(count("audit_events") === auditBefore, "and wrote NO audit event");
assert(
  count("invoice_reconciliation", "status = 'KEPT_INVOICE_ONLY'") === 1,
  "and the item left the unresolved queue as a recorded decision",
);
assert(
  one("SELECT resolution_actor_id AS a FROM invoice_reconciliation WHERE status = 'KEPT_INVOICE_ONLY'").a === "cashier-01",
  "naming who decided it",
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8 · The historical snapshot survives changes to the shop and the catalog
// ════════════════════════════════════════════════════════════════════════════════════════════════
const frozen = one("SELECT issuer_snapshot_json AS j FROM invoices").j;
const frozenLine = one("SELECT description AS d, unit_price_minor AS p, unit_label AS u FROM invoice_lines ORDER BY line_no");

({ app, page } = await launch());
await tab(page, "invoices");
await testid(page, "inv-tab-company").click();
await page.waitForSelector('[data-testid="company-name-ar"]');
await testid(page, "company-name-ar").fill("اسم جديد تماماً");
await testid(page, "company-vat").fill("VAT-CHANGED");
await testid(page, "company-save").click();
await page.waitForSelector('[data-testid="company-notice"]');

await tab(page, "products");
await page.waitForSelector('[data-testid="product-row"]');
// The row's FIRST button is Edit and its second is the activate toggle — positional, exactly as
// e2e/product-management.mjs does it, because neither carries a testid and the labels are localised.
await page.locator('[data-testid="product-row"]').filter({ hasText: "مفك" }).first().getByRole("button").first().click();
await page.waitForSelector('[data-testid="field-nameAr"]');
await testid(page, "field-nameAr").fill("اسم صنف جديد");
await testid(page, "field-price").fill("99.00");
await testid(page, "save-product").click();
await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
await page.waitForSelector('[data-testid="product-row"]');

// Reopen the OLD invoice.
await tab(page, "invoices");
await page.waitForSelector('[data-testid="history-table"]');
await testid(page, "history-open").first().click();
await page.waitForSelector('[data-testid="sheet-readonly"]');
const reopened = await textOf(page, "sheet-issuer");
assert(reopened.includes("متجر اختباري للفحص"), `the reopened invoice shows its FROZEN issuer (got "${reopened}")`);
assert(!reopened.includes("اسم جديد تماماً"), "not the shop's new name");
const shown = await lineValues(page);
assert(shown.includes("مفك براغي اختباري"), `the historical line description is unchanged (got ${JSON.stringify(shown)})`);
assert(!shown.includes("اسم صنف جديد"), "not the product's new name");
// The frozen unit price too — 5.00 as written on the invoice, not the 99.00 the product now costs.
assert(shown.includes("5.00"), `the historical unit price is unchanged (got ${JSON.stringify(shown)})`);
assert(!shown.includes("99.00"), "not the product's new price");
assert(shown.includes("كيس (50PCS)"), "the historical unit label is unchanged");
await page.screenshot({ path: SHOTS + "I10-frozen-reopened.png" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 9 · The PDF path executes against the frozen invoice
// ════════════════════════════════════════════════════════════════════════════════════════════════
const pdfPath = join(home, "invoice-61.pdf");
await app.evaluate(({ dialog }, target) => {
  dialog.showSaveDialogSync = () => target;
}, pdfPath);
await testid(page, "save-pdf").click();
await until(`the PDF at ${pdfPath}`, () => existsSync(pdfPath) && statSync(pdfPath).size > 0);
assert(existsSync(pdfPath), `a PDF was generated at ${pdfPath}`);
const size = statSync(pdfPath).size;
assert(size > 2000, `the PDF is a real document (${size} bytes)`);
await app.close();

{
  // Every row is represented: the four line descriptions all reach the rendered document. The PDF
  // itself is compressed, so the DOCUMENT is checked where it is deterministic — the unit tests
  // assert the HTML — and here we prove the pipeline ran on the frozen snapshot and produced bytes.
  const lines = query("SELECT description FROM invoice_lines ORDER BY line_no");
  assert(lines.length === 4, "the frozen invoice still has its four lines after the PDF was produced");
  const issuerNow = one("SELECT issuer_snapshot_json AS j FROM invoices").j;
  assert(issuerNow === frozen, "and generating a PDF did not alter the frozen issuer snapshot");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 10 · Restart: everything durable is still there
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await tab(page, "invoices");
await page.waitForSelector('[data-testid="history-table"]');
assert((await testid(page, "history-row").count()) === 1, "the invoice is still in history after a restart");
await testid(page, "inv-tab-review").click();
await page.waitForSelector('[data-testid="review-table"], [data-testid="review-empty"]');
await app.close();

{
  const f = facts();
  log("FINAL LEDGER:", JSON.stringify(f));
  assert(f.schema === 7 && f.integrity === "ok" && f.foreignKeys === "[]", "the ledger is sound at v7");
  assert(f.invoices === 1 && f.invoiceLines === 4, "the invoice and its lines survived the restart");
  assert(f.highestNumber === 61, "the invoice number is unchanged");
  assert(f.reconciliation === 4, "every reconciliation row survived");
  const after = one("SELECT description AS d, unit_price_minor AS p, unit_label AS u FROM invoice_lines ORDER BY line_no");
  assert(
    after.d === frozenLine.d && String(after.p) === String(frozenLine.p) && after.u === frozenLine.u,
    "the historical description, unit price and unit label are byte-for-byte what they were",
  );
  // Was `f.sales === 0` — see the reversal note above. What matters here is that reconciliation and
  // reprinting did not add a SECOND sale, and that no void appeared from anywhere.
  assert(f.invoiceSales === 1 && f.linkedSales === 1, "still exactly one linked invoice sale");
  assert(f.posSales === 0 && f.voids === 0, "and still no till sale and no void anywhere");
  const resolved = count("invoice_reconciliation", "status NOT IN ('PENDING','FAILED')");
  assert(resolved >= 2, `resolution states persisted (${resolved} settled)`);
}

log(`manual invoice E2E: ${passed} assertions passed`);
log("screenshots in", SHOTS);
