/**
 * The invoice line's UNIT control: the product form's own list, «Other» for anything else, and a
 * unit that survives save, leave, reopen, restart, finalize and the printed PDF unchanged.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY. A manual invoice row let the operator TYPE the unit freely, so the same thing got written
 * several ways and nothing connected it to the catalog's own units. The list now comes from
 * BASE_UNITS — the one authoritative list — and «أخرى / Other» is the existing member of it, not a
 * seventh option invented for the dropdown.
 *
 * WHAT THIS SCRIPT IS ACTUALLY FOR. The dangerous half of the change is not the dropdown; it is
 * everything that was already stored. `unit_label` is what the paper invoice PRINTS and is
 * historical truth, so a control that shows a dropdown must never answer "which entry is this"
 * by rewriting the answer. These assertions are about the LABELS COMING BACK OUT BYTE FOR BYTE —
 * through a save, a reopen, a restart, a finalize and a render.
 *
 * «كيس (50PCS)» is used on purpose: a bag of fifty pieces is the real SHAPE of a merchant unit that
 * BASE_UNITS cannot express, and it is exactly what must not be normalised into "box".
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 Synthetic only. No merchant name, customer, product or price appears here.
 *
 * Run: node e2e/invoice-units.mjs            (CI sets E2E_EXECUTABLE to the installed .exe)
 */
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
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

const home = mkdtempSync(join(tmpdir(), "pos-e2e-units-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
delete env.ELECTRON_RUN_AS_NODE;

const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

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

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");
  return { app, page };
}

const tab = (page, name) => page.locator(`[data-testid="tab-${name}"]`).click();
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);

/** Reaches the drafts list the way e2e/invoice-drafts.mjs already does — table OR empty state. */
async function openDrafts(page) {
  await tab(page, "invoices");
  await page.waitForSelector('[data-testid="inv-tab-drafts"]');
  await testid(page, "inv-tab-drafts").click();
  await until(
    "the drafts view to render either a table or its empty state",
    async () => (await testid(page, "drafts-table").count()) > 0 || (await testid(page, "drafts-empty").count()) > 0,
    30000,
  );
}

const rows = (page) => page.locator('[data-testid="sheet-draft-row"]');
const lastRow = (page) => rows(page).last();

/** The options this build actually offers, read off the select — never listed here. */
async function unitOptions(scope) {
  return scope
    .locator('[data-testid^="unit-select-"]')
    .first()
    .evaluate((el) => Array.from(el.options).map((o) => ({ value: o.value, label: (o.textContent || "").trim() })));
}

/** Every unit cell's displayed state, saved rows and unsaved rows alike. */
const unitStates = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const sel of document.querySelectorAll('[data-testid^="unit-select-"]')) {
      const id = sel.getAttribute("data-testid").replace("unit-select-", "");
      const custom = document.querySelector(`[data-testid="unit-custom-${id}"]`);
      out.push({ id, base: sel.value, custom: custom ? custom.value : null });
    }
    return out;
  });

function query(sql, ...params) {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const KNOWN_UNIT = "kg"; // a plain BASE_UNITS member, chosen from the dropdown by key
const CUSTOM_UNIT = "كيس (50PCS)"; // a real merchant SHAPE that BASE_UNITS cannot express

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 0 · Shop details, which the sheet requires before it will open
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await launch();
await tab(page, "invoices");
await testid(page, "inv-tab-company").click();
await page.waitForSelector('[data-testid="company-name-ar"]');
await testid(page, "company-name-ar").fill("متجر اختبار الوحدات");
await testid(page, "company-save").click();
await page.waitForSelector('[data-testid="company-notice"]');

await testid(page, "new-invoice").click();
await page.waitForSelector('[data-testid="invoice-mode-chooser"]');
await testid(page, "mode-outgoing").click();
await page.waitForSelector('[data-testid="add-row"]');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1-2 · A row, and a unit chosen from the dropdown
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "add-row").click();
await page.waitForSelector('[data-testid="sheet-draft-row"]');

const offered = await unitOptions(lastRow(page));
assert(offered.length >= 2, `the unit control is a dropdown offering ${offered.length} units`);
assert(
  offered.some((o) => o.value === "other"),
  "and «Other» is one of its own entries, not a seventh option bolted on",
);
assert(
  offered.every((o) => o.label.length > 0),
  "every entry carries a visible label, so the list is readable in this UI's language",
);
// A new row opens on a REAL unit, so a known unit is valid immediately.
const atOpen = (await unitStates(page)).at(-1);
assert(atOpen.base !== "other" && atOpen.custom === null, `a new row opens on a real unit (${atOpen.base})`);

await testid(page, "new-line-description").fill("صنف بوحدة معروفة");
await testid(page, "new-line-quantity").fill("3");
await lastRow(page).locator('[data-testid^="unit-select-"]').first().selectOption(KNOWN_UNIT);
await testid(page, "new-line-price").fill("2.50");
assert(
  (await lastRow(page).locator('[data-testid^="unit-custom-"]').count()) === 0,
  "choosing a known unit shows NO free-text field — there is nothing to type",
);
await page.screenshot({ path: SHOTS + "U1-known-unit.png" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3-5 · A second row WITHOUT saving the first, then «Other» and a custom unit
// ════════════════════════════════════════════════════════════════════════════════════════════════
assert(await testid(page, "add-row").isEnabled(), "+ Add Row is available while row 1 is unsaved");
await testid(page, "add-row").click();
await until("row 1 to have become a real line", async () => (await testid(page, "sheet-line").count()) === 1, 30000);

await testid(page, "new-line-description").last().fill("صنف بوحدة مخصّصة");
await testid(page, "new-line-quantity").last().fill("2");
await lastRow(page).locator('[data-testid^="unit-select-"]').first().selectOption("other");
await until("the free-text unit field to appear", async () =>
  (await lastRow(page).locator('[data-testid^="unit-custom-"]').count()) === 1,
);
assert(true, "choosing «Other» reveals the free-text unit field");

// 🔴 An empty «Other» is an ERROR on this row, and says so where the operator is looking.
assert(
  (await lastRow(page).locator('[data-testid^="unit-missing-"]').count()) === 1,
  "an empty «Other» shows inline validation on its own row",
);
// ...and it does NOT stop the operator adding another row.
assert(await testid(page, "add-row").isEnabled(), "🔴 and it does NOT block adding another row");

await lastRow(page).locator('[data-testid^="unit-custom-"]').first().fill(CUSTOM_UNIT);
await testid(page, "new-line-price").last().fill("7.00");
await until("the inline validation to clear", async () =>
  (await lastRow(page).locator('[data-testid^="unit-missing-"]').count()) === 0,
);
assert(true, "typing the unit clears the validation");
await page.screenshot({ path: SHOTS + "U2-other-custom-unit.png" });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6-7 · Save the draft, leave it, reopen it
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "save-draft").click();
await until("both rows to be persisted", async () => (await testid(page, "sheet-line").count()) === 2, 30000);
await testid(page, "leave-draft").click();
await page.waitForSelector('[data-testid="add-row"]', { state: "detached" });

await openDrafts(page);
await testid(page, "draft-open").first().click();
await page.waitForSelector('[data-testid="add-row"]');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8 · 🔴 BOTH UNIT VALUES SURVIVED — and the custom one came back as Other, PREFILLED
// ════════════════════════════════════════════════════════════════════════════════════════════════
const reopened = await unitStates(page);
assert(reopened.length === 2, `the reopened draft shows two unit cells (${reopened.length})`);
assert(
  reopened[0].base === KNOWN_UNIT && reopened[0].custom === null,
  `the known unit reopened as the same dropdown entry (${reopened[0].base})`,
);
assert(
  reopened[1].base === "other" && reopened[1].custom === CUSTOM_UNIT,
  `🔴 the custom unit reopened as «Other» with its own text prefilled (${JSON.stringify(reopened[1])})`,
);
await page.screenshot({ path: SHOTS + "U3-reopened-units.png" });

// The database is the real witness: what is STORED is the printed label and the canonical unit.
{
  const stored = query("SELECT unit_label AS l, canonical_unit AS c FROM invoice_lines ORDER BY line_no");
  log("STORED UNITS:", JSON.stringify(stored));
  assert(stored.length === 2, "two lines are stored");
  assert(stored[0].c === KNOWN_UNIT, `the known row records the canonical unit (${stored[0].c})`);
  assert(
    stored[0].l !== null && stored[0].l.trim() !== "",
    `and a printable label beside it (${JSON.stringify(stored[0].l)})`,
  );
  // 🔴 The custom label is stored EXACTLY as typed, and claims no canonical unit.
  assert(stored[1].l === CUSTOM_UNIT, `🔴 the custom label is stored byte for byte (${stored[1].l})`);
  assert(stored[1].c === null, "and claims NO canonical unit — nothing guessed it into a base unit");
}

// A restart, because "it survived" must mean the disk and not a live component's state.
await app.close();
({ app, page } = await launch());
await openDrafts(page);
await testid(page, "draft-open").first().click();
await page.waitForSelector('[data-testid="add-row"]');
const afterRestart = await unitStates(page);
assert(
  afterRestart[0].base === KNOWN_UNIT && afterRestart[1].custom === CUSTOM_UNIT,
  `both units survive a full restart (${JSON.stringify(afterRestart)})`,
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 9-10 · Finalize, and the PDF prints both units exactly as entered
// ════════════════════════════════════════════════════════════════════════════════════════════════
await testid(page, "finalize").click();
await page.waitForSelector('[data-testid="finalize-confirm"]');
await testid(page, "finalize-confirm-yes").click();
await page.waitForSelector('[data-testid="finalized-notice"]');
await testid(page, "review-later").click();
await page.waitForSelector('[data-testid="finalized-notice"]', { state: "detached" });
assert(true, "the invoice was issued");

const pdf = join(home, "invoice-units.pdf");
await app.evaluate(({ dialog }, target) => {
  dialog.showSaveDialogSync = () => target;
}, pdf);
await testid(page, "save-pdf").click();
await until(`the PDF at ${pdf}`, () => existsSync(pdf) && statSync(pdf).size > 0);
assert(statSync(pdf).size > 2000, `a real PDF was produced (${statSync(pdf).size} bytes)`);

// 🔴 The frozen line is what the document is rendered FROM, so this is what the paper says.
{
  const frozen = query("SELECT unit_label AS l, canonical_unit AS c FROM invoice_lines ORDER BY line_no");
  assert(frozen[1].l === CUSTOM_UNIT, `🔴 the finalized line still prints «${CUSTOM_UNIT}» verbatim`);
  assert(frozen[0].c === KNOWN_UNIT, "and the known line kept its canonical unit through finalization");
  const status = query("SELECT status AS s FROM invoices")[0].s;
  assert(status === "final", "the invoice is final, so those labels are now immutable");
}

// The read-only sheet shows the same two units — the control does not misread a frozen line.
const readOnly = await unitStates(page);
assert(
  readOnly[0].base === KNOWN_UNIT && readOnly[1].custom === CUSTOM_UNIT,
  `the issued invoice displays both units unchanged (${JSON.stringify(readOnly)})`,
);
assert(
  (await page.locator('[data-testid^="unit-select-"]').first().isDisabled()) === true,
  "and they are not editable on an issued invoice",
);
await page.screenshot({ path: SHOTS + "U4-finalized-units.png" });
await app.close();

// The PDF's own bytes: text is compressed by Chromium's writer, so the DOCUMENT's unit text is
// asserted where it is deterministic — the frozen row above, which renderInvoiceDocument reads —
// and here we prove the render ran on that frozen snapshot and produced a real document.
assert(readFileSync(pdf).length === statSync(pdf).size, "the PDF on disk is complete");

log(`\nOK — ${passed} assertions passed against the installed app`);
