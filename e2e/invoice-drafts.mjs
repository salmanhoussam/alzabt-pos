/**
 * E2E — SAFE DRAFT EXIT against the REAL app: renderer + preload + IPC + service + SQLite.
 *
 * 🔴 WHY THIS SCRIPT EXISTS, stated plainly. The stability pass added three controls — Save draft,
 * Save and leave, and the mode badge — and shipped them with NO behavioural coverage of any kind.
 * `leave-draft` was covered only by a `toContain()` on the component's SOURCE TEXT, which proves
 * the file contains certain characters and says nothing about whether the button works. That very
 * assertion had already failed once for exactly that reason. So "safe draft exit" was green by
 * absence of evidence. This script is the evidence.
 *
 * It also retires a real claim: `manual-invoice.mjs` documented that there was NO non-destructive
 * way to leave an open draft and come back to it, because `onClosed` was reachable only from
 * `discard()`. That was true when it was written. The whole point of this script is that it is no
 * longer true, and that the difference is measured rather than asserted about the source.
 *
 * 🔴 Selectors are data-testid, never visible text: the terminal's default language is Arabic, and a
 * test that clicked "Save draft" would pass only while the UI happened to be English. The two
 * fields without a testid (address, notes) are reached positionally inside `.inv-customer`.
 *
 * 🔴 Synthetic data only. No real shop, customer or product value appears here.
 *
 * Run: node e2e/invoice-drafts.mjs            (CI sets E2E_EXECUTABLE to the installed .exe)
 *      locally, where better-sqlite3 is built against Electron's ABI:
 *        env -u ELECTRON_RUN_AS_NODE ELECTRON_RUN_AS_NODE=1 \
 *          ./node_modules/electron/dist/electron e2e/invoice-drafts.mjs
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

// A fresh profile per run: this script writes drafts and must never touch a real ledger.
const home = mkdtempSync(join(tmpdir(), "pos-e2e-drafts-"));
// 🔴 ELECTRON_RUN_AS_NODE is DELETED from the child's environment — inheriting it would make the
// launched application run as a plain node process with no window, a failure that looks exactly
// like the app never starting.
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
delete env.ELECTRON_RUN_AS_NODE;

const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

const log = (...a) => console.log("•", ...a);

/** Waits for a CONDITION, not for a duration — a cold Windows runner is slower than any guess. */
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

/** The header fields commit on BLUR; fill() alone does not blur, so the Tab is load-bearing. */
async function commitTestid(page, id, value) {
  const field = testid(page, id);
  await field.fill(value);
  await field.press("Tab");
  await until(`${id} to hold ${value}`, async () => (await field.inputValue()) === value, 15000);
}

/** Address, phone and notes carry no testid, so they are reached by position inside .inv-customer. */
const CUSTOMER_FIELD = { name: 0, address: 1, phone: 2, notes: 3 };
async function commitCustomer(page, which, value) {
  const field = page.locator(".inv-customer input").nth(CUSTOMER_FIELD[which]);
  await field.fill(value);
  await field.press("Tab");
  await until(`customer ${which} to hold ${value}`, async () => (await field.inputValue()) === value, 15000);
}
const customerValue = (page, which) => page.locator(".inv-customer input").nth(CUSTOMER_FIELD[which]).inputValue();

/** Adds one line through the sheet exactly as an operator would. */

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

async function addRow(page, { description, quantity, unit, price }) {
  await testid(page, "add-row").click();
  await testid(page, "new-line-description").fill(description);
  await testid(page, "new-line-quantity").fill(quantity);
  await chooseUnit(page.locator('[data-testid="sheet-draft-row"]').last(), unit);
  await testid(page, "new-line-price").fill(price);
  await testid(page, "save-draft").click();
  await page.waitForSelector('[data-testid="sheet-draft-row"]', { state: "detached" });
}

/** Every value the line rows display — innerText NEVER includes an <input>'s value. */
const lineValues = (page) =>
  page.locator('[data-testid="sheet-line"] input').evaluateAll((els) => els.map((e) => e.value));

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
const num = (sql) => Number(one(sql).n);

/** Opens the Invoices tab and the Drafts view. */
async function openDrafts(page) {
  await tab(page, "invoices");
  await page.waitForSelector('[data-testid="inv-tab-drafts"]');
  await testid(page, "inv-tab-drafts").click();
  await until(
    "the drafts view to render either a table or its empty state",
    async () =>
      (await testid(page, "drafts-table").count()) > 0 || (await testid(page, "drafts-empty").count()) > 0,
    30000,
  );
}

const CUSTOMER = "مؤسسة المسودّة للتجارة";
const ADDRESS = "شارع الاختبار، بناية رقم ٧";
const PHONE = "70-123456";
const NOTES = "تُراجع قبل الإصدار";
const DATE = "2026-10-07";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 0 · The application launches and the shop details exist, which the sheet requires
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await launch();
assert(true, "the application launched and a cashier signed in");

await tab(page, "invoices");
await page.waitForSelector('[data-testid="inv-tab-company"]');
assert(await testid(page, "company-required").isVisible(), "a terminal with no shop details says so first");
// 🔴 WAIT FOR THE FIELD, NOT FOR THE TAB. The screen opens on "history" and switches itself to
// "company" only once the profile load has resolved and come back null. The tab button exists from
// the first paint, so waiting on it would let the fill race the view switch — a flake that would
// read as "the company form is broken".
await page.waitForSelector('[data-testid="company-name-ar"]');
await testid(page, "company-name-ar").fill("متجر مسودّات اختباري");
await testid(page, "company-taxpayer").fill("TP-DRAFT-1");
await testid(page, "company-register").fill("CR-DRAFT-2");
await testid(page, "company-save").click();
await page.waitForSelector('[data-testid="company-notice"]');
assert(true, "the shop details saved, so an invoice can be opened");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-C · A draft is created in OUTGOING mode, its header filled, and two rows added
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "inv-tab-drafts").click();
await until("the empty drafts state", async () => (await testid(page, "drafts-empty").count()) > 0, 30000);
assert(true, "a fresh terminal has no drafts");

await testid(page, "new-invoice").click();
await page.waitForSelector('[data-testid="invoice-mode-chooser"]');
await testid(page, "mode-outgoing").click();
await page.waitForSelector('[data-testid="invoice-mode-chooser"]', { state: "detached" });
await page.waitForSelector('[data-testid="add-row"]');

// 🔴 THE MODE IS ON THE DOCUMENT, not only in the chooser that is already gone. An outgoing sales
// invoice and an incoming intake document look alike; only this label distinguishes them, so it is
// read here and read AGAIN after the draft is reopened.
const modeWhenCreated = await textOf(page, "sheet-mode");
assert(modeWhenCreated.length > 0, `the sheet names its mode on screen (${modeWhenCreated})`);
assert((await textOf(page, "sheet-number")).startsWith("—"), "a draft shows no invoice number");

await commitTestid(page, "sheet-customer", CUSTOMER);
await commitCustomer(page, "address", ADDRESS);
await commitCustomer(page, "phone", PHONE);
await commitCustomer(page, "notes", NOTES);
await commitTestid(page, "sheet-date", DATE);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C-bis · 🔴 THE FIELD DEFECT (2026-10-10, real installed `ce4dd28`): a second row could not be
//         started until the first was saved. "+ Add Row" was disabled while a row was open and told
//         the operator to save first, so a multi-item invoice meant one round-trip per item.
//
//         This block is deliberately NOT written with the `addRow` helper: the helper saves, and
//         what is being proven here is precisely that NO save is needed in between.
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "add-row").click();
await page.waitForSelector('[data-testid="sheet-draft-row"]');
await testid(page, "new-line-description").fill("صنف المسودّة الأول");
await testid(page, "new-line-quantity").fill("3");
await chooseUnit(page.locator('[data-testid="sheet-draft-row"]').last(), "حبة");
await testid(page, "new-line-price").fill("2.50");

// The button must be LIVE while row 1 sits there unsaved. This one assertion is the whole defect.
assert(await testid(page, "add-row").isEnabled(), "🔴 + Add Row is available while a row is unsaved");
await testid(page, "add-row").click();
await until("a second unsaved row to appear", async () => (await testid(page, "sheet-draft-row").count()) >= 1, 30000);

// Row 1 survived being left alone — it is now a real line, and its values are the typed ones.
await until("row 1 to have become a real line", async () => (await testid(page, "sheet-line").count()) === 1, 30000);
const row1 = await lineValues(page);
assert(JSON.stringify(row1).includes("صنف المسودّة الأول"), `row 1 kept its description (got ${JSON.stringify(row1)})`);

// Row 2 is typed into the row that Add Row opened, with row 1 untouched beside it.
await testid(page, "new-line-description").last().fill("صنف المسودّة الثاني");
await testid(page, "new-line-quantity").last().fill("2");
await chooseUnit(page.locator('[data-testid="sheet-draft-row"]').last(), "علبة");
await testid(page, "new-line-price").last().fill("4.00");
assert((await testid(page, "sheet-unsaved-rows").count()) === 1, "the sheet says how many rows are unsaved");
await page.screenshot({ path: SHOTS + "D0-two-rows-one-unsaved.png" });

// A completely BLANK trailing row is ignored — never saved, never counted, never a validation error.
await testid(page, "add-row").click();
await until("the blank trailing row to be present", async () => (await testid(page, "sheet-draft-row").count()) >= 1, 30000);

await testid(page, "save-draft").click();
await until("every typed row to be persisted", async () => (await testid(page, "sheet-line").count()) === 2, 30000);
assert((await testid(page, "sheet-line").count()) === 2, "two rows are on the sheet");
assert(
  (await testid(page, "sheet-unsaved-rows").count()) === 0,
  "and nothing is left unsaved — the blank trailing row was ignored, not stored",
);
// The blank row is still ON SCREEN, which is correct — it is where the operator types next. It is
// removed here only so the rest of this script's `addRow` helper starts from an empty sheet.
await testid(page, "sheet-draft-row-remove").last().click();
await page.waitForSelector('[data-testid="sheet-draft-row"]', { state: "detached" });

const subtotalBefore = await textOf(page, "sheet-subtotal");
const totalBefore = await textOf(page, "sheet-total");
assert(subtotalBefore.includes("15.50"), `3 x 2.50 + 2 x 4.00 = 15.50 (got ${subtotalBefore})`);
await page.screenshot({ path: SHOTS + "D1-draft-filled.png" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D · Save Draft — the sheet STAYS open and says it saved
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "save-draft").click();
await page.waitForSelector('[data-testid="draft-saved"]');
assert(await testid(page, "draft-saved").isVisible(), "Save draft reports that it saved");
assert((await testid(page, "add-row").count()) > 0, "Save draft keeps the sheet OPEN — it is not an exit");
await page.screenshot({ path: SHOTS + "D2-draft-saved.png" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E · Leave the invoice screen WITHOUT discarding
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "leave-draft").click();
await page.waitForSelector('[data-testid="add-row"]', { state: "detached" });
assert(true, "Save and leave closed the sheet");
// 🔴 THE CLAIM UNDER TEST. Leaving must not be a disguised delete, and the tab bar coming back is
// not evidence of that — the row is.
await page.waitForSelector('[data-testid="inv-tab-drafts"]');
assert(true, "the Invoices tab bar is reachable again after leaving");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// F-G · Return to Drafts and reopen the SAME draft
// ════════════════════════════════════════════════════════════════════════════════════════════════
await openDrafts(page);
assert((await testid(page, "draft-row").count()) === 1, "the draft survived leaving and is listed once");
assert((await textOf(page, "drafts-table")).includes(CUSTOMER), "the drafts list shows the customer that was typed");
await page.screenshot({ path: SHOTS + "D3-drafts-list.png" });

await testid(page, "draft-open").first().click();
await page.waitForSelector('[data-testid="add-row"]');
assert(true, "the draft reopened");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// H · Everything persisted — header, both rows, totals, and the mode
// ════════════════════════════════════════════════════════════════════════════════════════════════
assert((await testid(page, "sheet-customer").inputValue()) === CUSTOMER, "the customer name persisted");
assert((await customerValue(page, "address")) === ADDRESS, "the address persisted");
assert((await customerValue(page, "phone")) === PHONE, "the phone persisted");
assert((await customerValue(page, "notes")) === NOTES, "the notes persisted");
assert((await testid(page, "sheet-date").inputValue()) === DATE, "the invoice date persisted");

assert((await testid(page, "sheet-line").count()) === 2, "both rows persisted");
const values = await lineValues(page);
assert(
  values.some((v) => v === "صنف المسودّة الأول") && values.some((v) => v === "صنف المسودّة الثاني"),
  "both row descriptions persisted, read from the inputs rather than innerText",
);
assert(values.some((v) => v === "حبة") && values.some((v) => v === "علبة"), "both unit labels persisted verbatim");

const subtotalAfter = await textOf(page, "sheet-subtotal");
const totalAfter = await textOf(page, "sheet-total");
assert(subtotalAfter === subtotalBefore, `the subtotal recomputed to the same value (${subtotalAfter})`);
assert(totalAfter === totalBefore, `the total recomputed to the same value (${totalAfter})`);
assert((await textOf(page, "sheet-mode")) === modeWhenCreated, "the reopened draft is still in the SAME mode");
assert((await textOf(page, "sheet-number")).startsWith("—"), "and it is still unnumbered, so still a draft");
await page.screenshot({ path: SHOTS + "D4-draft-reopened.png" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E′ · Closing the WHOLE APPLICATION with a draft open does not delete it either
// ════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 The strongest form of "navigation away does not silently delete": not a route change but the
// process ending. A draft that only survives an in-app exit would still lose a shop's work to a
// power cut.
await app.close();
const draftsOnDisk = num("SELECT count(*) AS n FROM invoices WHERE status = 'draft'");
const linesOnDisk = num("SELECT count(*) AS n FROM invoice_lines");
assert(draftsOnDisk === 1, `the ledger holds the draft after the app closed (got ${draftsOnDisk})`);
assert(linesOnDisk === 2, `and both of its lines (got ${linesOnDisk})`);
const stored = one("SELECT customer_name AS c, customer_phone AS p, notes AS n, invoice_date AS d FROM invoices");
assert(stored.c === CUSTOMER, "the stored row carries the customer name");
assert(stored.p === PHONE, "the stored row carries the phone");
assert(stored.n === NOTES, "the stored row carries the notes");
assert(stored.d === DATE, "the stored row carries the invoice date");
assert(num("SELECT count(*) AS n FROM sales") === 0, "and NOTHING was sold — a draft is not a sale");

({ app, page } = await launch());
await openDrafts(page);
assert((await testid(page, "draft-row").count()) === 1, "the draft is still listed after a full restart");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// I-K · Discard, confirm, and verify it is gone
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "draft-open").first().click();
await page.waitForSelector('[data-testid="add-row"]');
await testid(page, "discard").click();
await page.waitForSelector('[data-testid="discard-confirm"]');
assert(await testid(page, "discard-confirm").isVisible(), "discarding asks for an explicit confirmation first");
assert((await testid(page, "add-row").count()) > 0, "and the draft is still open while the question stands");
await page.screenshot({ path: SHOTS + "D5-discard-confirm.png" });

await testid(page, "discard-confirm-yes").click();
await page.waitForSelector('[data-testid="add-row"]', { state: "detached" });
await openDrafts(page);
await until("the drafts list to be empty", async () => (await testid(page, "drafts-empty").count()) > 0, 30000);
assert((await testid(page, "draft-row").count()) === 0, "the discarded draft no longer appears");
await page.screenshot({ path: SHOTS + "D6-drafts-empty.png" });

await app.close();
assert(num("SELECT count(*) AS n FROM invoices") === 0, "the discarded draft is gone from the ledger");
assert(num("SELECT count(*) AS n FROM invoice_lines") === 0, "and so are its lines");
assert(num("SELECT count(*) AS n FROM sales") === 0, "and still nothing was ever sold");

log(`\nOK — ${passed} assertions passed against the installed app`);
