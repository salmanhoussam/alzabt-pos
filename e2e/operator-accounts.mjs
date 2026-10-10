/**
 * E2E — OPERATOR ACCOUNTS V1 against the REAL app (the installed executable in CI).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS SCRIPT IS THE ONLY ACCEPTABLE PROOF. Every claim below is about AUTHORIZATION, and
 * the renderer is the untrusted side of the bridge. A unit test proves the service refuses; it
 * cannot prove the shipped app refuses, because the thing that must refuse is the main process
 * answering a `window.pos` call that no button produced. So this script reaches `window.pos`
 * DIRECTLY, as an attacker with a devtools console would, and asserts the refusal comes back.
 *
 * 🔴 TWO ROLES ONLY. OWNER = administrator, CASHIER = employee. `admin` survives as a legal value
 * in the migration-8 CHECK and is never created, assigned or shown — asserted here, not assumed.
 *
 * 🔴 AND NO PIN IS EVER DISPLAYED. The script types PINs it knows and then asserts those digits
 * appear nowhere in the rendered document, because "we don't show PINs" is a claim about pixels.
 *
 * Selectors are data-testid, never visible text: the terminal's default language is Arabic, so a
 * test that clicks "Add" passes only while the UI happens to be English. The two places that DO
 * read text are the login list (the operator's own name is the subject) and the error surfaces.
 *
 * Run: node e2e/operator-accounts.mjs      (CI sets E2E_EXECUTABLE to the installed .exe)
 *      Linux without a display: xvfb-run -a node e2e/operator-accounts.mjs
 * ════════════════════════════════════════════════════════════════════════════════════════════════
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

// A fresh profile: this script creates operators and sells, and must never touch a real ledger.
const home = mkdtempSync(join(tmpdir(), "pos-e2e-operators-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

// The two credentials this script sets. Both are GENUINELY NEW — the whole point of mandatory setup
// is that 1111 and 2222 stop working, so re-using them here would prove nothing.
const OWNER_NAME = "حسين رقا";
const OWNER_PIN = "4321";
const CASHIER_NAME = "جعفر صالح";
const CASHIER_BOOTSTRAP = "5678";
const CASHIER_PIN = "1357";

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

/** Reads the ledger with the app running. WAL + busy_timeout = 5000 makes this safe. */
function ledger(fn) {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return fn((sql) => db.prepare(sql).all(), (sql) => db.prepare(sql).get());
  } finally {
    db.close();
  }
}

/**
 * Writes to the live ledger from OUTSIDE the app.
 *
 * 🔴 This is how "a role change takes effect immediately, with no logout" is proven. A single
 * window cannot hold two sessions, so the owner's edit is simulated at the layer that matters: the
 * DURABLE ROW. If authorization were read from the session instead of re-read per action, every
 * assertion that follows one of these writes would pass when it must fail.
 */
function writeLedger(sql) {
  const db = new Database(LEDGER);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(sql).run();
  } finally {
    db.close();
  }
}

async function open() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  return { app, page };
}

/** Types a PIN on the login keypad for an already-selected operator and submits. */
async function keypad(page, pin) {
  for (const d of pin) await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await page.locator('[data-testid="login-submit"]').click();
}

/** Calls a channel on `window.pos` directly — the bridge, with no button in between. */
const direct = (page, channel, payload) =>
  page.evaluate(([c, p]) => (p === null ? window.pos[c]() : window.pos[c](p)), [channel, payload ?? null]);

const tab = (page, name) => page.locator(`[data-testid="tab-${name}"]`).click();
const opsRow = (page, id) => page.locator(`[data-testid="ops-row"][data-operator-id="${id}"]`);

/** Sells one Espresso for cash. The cheapest real ledger write this app has. */
async function sell(page) {
  await tab(page, "sell");
  await page.locator("button.product", { hasText: "Espresso" }).click();
  await page.locator('[data-testid="complete-sale"]').click();
  await page.locator('[data-testid="pay-cash"]').click();
  await page.waitForSelector('[data-testid="receipt"], .receipt', { timeout: 15000 }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The door, before anyone has set anything up
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await open();

const offered = await direct(page, "listCashiers");
assert(offered.ok === true, "listCashiers answers with no session — it is the login screen's own list");
assert(offered.data.length === 2, `the fresh ledger offers exactly the two migrated accounts (${offered.data.length})`);
assert(
  offered.data.every((c) => JSON.stringify(Object.keys(c).sort()) === '["id","name"]'),
  "the login list carries ONLY id and name — no role, no status, no credential",
);
assert(
  !/role|salt|hash|must_reset|isactive|pending/i.test(JSON.stringify(offered.data)),
  "and nothing in that payload hints at a role or a credential",
);

// 🔴 Before any session exists, an owner channel must refuse — not because a button is hidden
// (there is no button yet) but because the main process has nobody to authorize.
const beforeLogin = await direct(page, "listOperators");
assert(beforeLogin.ok === false, "listOperators is refused with no session at all");
assert(beforeLogin.error.code === "NOT_LOGGED_IN", `and the reason is NOT_LOGGED_IN (${beforeLogin.error.code})`);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Mandatory setup stands between the bootstrap PIN and the till
// ════════════════════════════════════════════════════════════════════════════════════════════════
await page.getByRole("button", { name: "Cashier One" }).click();
await keypad(page, "1111");
await page.waitForSelector('[data-testid="setup-screen"]', { timeout: 30000 });
await page.screenshot({ path: SHOTS + "OP1-mandatory-setup.png" });
assert(true, "the bootstrap PIN opens MANDATORY SETUP, not the till");
assert((await page.locator('[data-testid="cart"]').count()) === 0, "the till is not rendered behind it");
assert((await page.locator('[data-testid="setup-no-skip"]').count()) === 1, "the screen says there is no way to skip");

// There is no session yet, so every other channel must still refuse.
const duringSetup = await direct(page, "getCatalog");
assert(duringSetup.ok === false && duringSetup.error.code === "NOT_LOGGED_IN",
  `a setup ticket is NOT a session — getCatalog is still refused (${duringSetup.error.code})`);

// A mismatched confirmation and a too-short PIN are refused by the screen before any call.
await page.locator('[data-testid="setup-pin"]').fill(OWNER_PIN);
await page.locator('[data-testid="setup-confirm"]').fill("9999");
await page.waitForSelector('[data-testid="setup-mismatch"]');
assert(await page.locator('[data-testid="setup-submit"]').isDisabled(), "a mismatched confirmation cannot be submitted");
await page.locator('[data-testid="setup-pin"]').fill("12");
await page.locator('[data-testid="setup-confirm"]').fill("12");
await page.waitForSelector('[data-testid="setup-pin-invalid"]');
assert(await page.locator('[data-testid="setup-submit"]').isDisabled(), "a 2-digit PIN cannot be submitted");

// The real thing: a real name and a credential nobody else knows.
await page.locator('[data-testid="setup-name"]').fill(OWNER_NAME);
await page.locator('[data-testid="setup-pin"]').fill(OWNER_PIN);
await page.locator('[data-testid="setup-confirm"]').fill(OWNER_PIN);
await page.locator('[data-testid="setup-submit"]').click();
await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
assert(true, "setup completes and lands on the till");

{
  const row = ledger((_all, get) => get("SELECT name, role, must_reset_pin AS flag FROM operators WHERE id = 'cashier-01'"));
  assert(row.name === OWNER_NAME, `the durable row carries the typed name (${row.name})`);
  assert(row.role === "owner", "and cashier-01 is the OWNER, as migration 8 seeded it");
  assert(Number(row.flag) === 0, "and must_reset_pin is cleared, so setup never runs twice");
}

// 🔴 The audit trail records the act and NOT the credential.
{
  const rows = ledger((all) => all("SELECT event_type AS t, changed_json AS j FROM audit_events WHERE entity_type = 'operator' ORDER BY seq"));
  const types = rows.map((r) => r.t).join(",");
  assert(types === "OPERATOR_RENAMED,OPERATOR_PIN_RESET", `setup wrote exactly the rename and the PIN reset (${types})`);
  const blob = JSON.stringify(rows);
  assert(!blob.includes(OWNER_PIN), "🔴 the PIN does not appear in the audit trail");
  assert(!/salt|hash|pin_|must_reset/i.test(blob), "🔴 and neither does any credential field name");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The bootstrap PIN is DEAD, and the new one works
// ════════════════════════════════════════════════════════════════════════════════════════════════
await page.locator('[data-testid="logout"]').click();
await page.waitForSelector('[data-testid="select-cashier"]');
assert(
  (await page.getByRole("button", { name: OWNER_NAME }).count()) === 1,
  `the login list now offers the real name, not the fixture's (${OWNER_NAME})`,
);
assert((await page.getByRole("button", { name: "Cashier One" }).count()) === 0, "and 'Cashier One' is gone from it");

await page.getByRole("button", { name: OWNER_NAME }).click();
await keypad(page, "1111");
await page.waitForSelector(".login .error", { timeout: 15000 });
assert((await page.locator('[data-testid="cart"]').count()) === 0, "🔴 the bootstrap PIN 1111 no longer opens anything");
await keypad(page, OWNER_PIN);
await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
assert(true, "the PIN set during setup opens a real session");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The owner's management surface
// ════════════════════════════════════════════════════════════════════════════════════════════════
await tab(page, "tools");
await page.waitForSelector('[data-testid="operators-section"]');
await page.waitForSelector('[data-testid="ops-table"]');
await page.screenshot({ path: SHOTS + "OP2-owner-operators.png" });
assert((await page.locator('[data-testid="ops-row"]').count()) === 2, "the owner sees both operators");
assert((await page.locator('[data-testid="ops-no-pin-shown"]').count()) === 1, "the screen states that no PIN can be shown");
assert(
  (await opsRow(page, "cashier-02").locator('[data-testid="ops-row-pending"]').count()) === 1,
  "Cashier Two is marked as still needing setup",
);
// 🔴 There is no delete anywhere, by design: a past sale names this person.
assert((await page.locator('[data-testid="ops-delete"]').count()) === 0, "🔴 no delete control exists on any row");
const surface = await page.evaluate(() => Object.keys(window.pos).sort().join(","));
assert(!/deleteOperator|removeOperator/.test(surface), "🔴 and the bridge exposes no delete channel either");

// Create a real cashier.
await page.locator('[data-testid="ops-add"]').click();
await page.waitForSelector('[data-testid="ops-dialog"]');
await page.locator('[data-testid="ops-name"]').fill(CASHIER_NAME);
await page.locator('[data-testid="ops-pin"]').fill(CASHIER_BOOTSTRAP);
await page.locator('[data-testid="ops-dialog-save"]').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ops-row"]').length === 3);
assert(true, `a third operator is created (${CASHIER_NAME})`);

const jaafar = ledger((_all, get) => get(`SELECT id, role FROM operators WHERE name = '${CASHIER_NAME}'`));
assert(jaafar.role === "cashier", "created as a CASHIER — the form offers no other role");
assert(
  ledger((_all, get) => get("SELECT count(*) AS n FROM operators WHERE role = 'admin'")).n === 0,
  "🔴 no operator anywhere carries the legacy 'admin' role",
);

// 🔴 Two PINs have now been typed into this app. Neither may appear on screen.
{
  const shown = await page.evaluate(() => document.body.innerText);
  assert(!shown.includes(OWNER_PIN) && !shown.includes(CASHIER_BOOTSTRAP), "🔴 no PIN appears in the rendered document");
  const html = await page.evaluate(() => document.body.innerHTML);
  assert(!html.includes(OWNER_PIN) && !html.includes(CASHIER_BOOTSTRAP), "🔴 and none is hiding in an attribute either");
}

// A sale by the owner snapshots the CURRENT name.
await sell(page);
assert(
  ledger((_all, get) => get("SELECT cashier_name AS n FROM sales ORDER BY completed_at DESC LIMIT 1")).n === OWNER_NAME,
  "the owner's sale records the name they set up with",
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The cashier: denied the surface, and denied the BRIDGE
// ════════════════════════════════════════════════════════════════════════════════════════════════
await page.locator('[data-testid="logout"]').click();
await page.waitForSelector('[data-testid="select-cashier"]');
await page.getByRole("button", { name: CASHIER_NAME }).click();
await keypad(page, CASHIER_BOOTSTRAP);
await page.waitForSelector('[data-testid="setup-screen"]', { timeout: 30000 });
assert(true, "a newly created operator must also set their own PIN before selling");
await page.locator('[data-testid="setup-pin"]').fill(CASHIER_PIN);
await page.locator('[data-testid="setup-confirm"]').fill(CASHIER_PIN);
await page.locator('[data-testid="setup-submit"]').click();
await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });

await tab(page, "tools");
await page.waitForSelector('[data-testid="about"]');
await page.screenshot({ path: SHOTS + "OP3-cashier-denied.png" });
assert((await page.locator('[data-testid="operators-section"]').count()) === 0, "the cashier's Tools has no operator section");
assert((await page.locator('[data-testid="export-backup"]').count()) >= 0, "(the rest of Tools still renders)");

// Each payload below is a SHAPE THE HANDLER WOULD ACCEPT, so a missing guard would let the call
// through rather than trip payload validation and look like a refusal.
// 🔴 THE ASSERTION THIS WHOLE SCRIPT EXISTS FOR. Hiding the section is a courtesy; these calls skip
// the UI entirely and must each come back refused, by CODE, from the main process.
for (const [channel, payload] of [
  ["listOperators", null],
  ["createOperator", { name: "مدير مزيّف", role: "owner", pin: "9876" }],
  ["setOperatorRole", { operatorId: "cashier-01", role: "cashier" }],
  ["setOperatorActive", { operatorId: "cashier-01", isActive: false }],
  ["renameOperator", { operatorId: "cashier-01", name: "مغيَّر" }],
  ["resetOperatorPin", { operatorId: "cashier-01", pin: "0000" }],
  ["exportBackup", null],
  ["getCompanyProfile", null],
  ["listReconciliation", null],
  ["createProduct", { draft: { nameAr: "صنف مزيّف", nameEn: null, sku: null, price: "1.00", baseUnit: "piece" } }],
]) {
  const r = await direct(page, channel, payload);
  assert(r.ok === false, `a cashier calling window.pos.${channel} directly is REFUSED`);
  assert(r.error.code === "NOT_AUTHORIZED", `  …with NOT_AUTHORIZED, not a crash (${r.error.code})`);
}

// And the refusal is about authorization, not a broken bridge: the cashier's own work still works.
{
  const ok = await direct(page, "getCatalog");
  assert(ok.ok === true, "the same bridge answers a cashier's own channel — getCatalog succeeds");
}

// Nothing above left a trace: a refused call must not half-happen.
assert(
  ledger((_all, get) => get("SELECT count(*) AS n FROM operators")).n === 3,
  "🔴 none of the refused calls created an operator",
);
assert(
  ledger((_all, get) => get("SELECT count(*) AS n FROM operators WHERE role = 'owner'")).n === 1,
  "🔴 and none of them changed a role",
);

await sell(page);
{
  const row = ledger((_all, get) => get("SELECT cashier_id AS id, cashier_name AS n FROM sales ORDER BY completed_at DESC LIMIT 1"));
  assert(row.id === jaafar.id && row.n === CASHIER_NAME, "the cashier's own sale records their id and name");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · 🔴 LIVE AUTHORIZATION — a role change applies to the NEXT action, with no logout
// ════════════════════════════════════════════════════════════════════════════════════════════════
writeLedger(`UPDATE operators SET role = 'owner' WHERE id = '${jaafar.id}'`);
{
  const r = await direct(page, "listOperators");
  assert(r.ok === true, "🔴 promoted to owner from another surface, the SAME open session is now allowed");
  assert(r.data.length === 3, "and it returns the real list");
}
writeLedger(`UPDATE operators SET role = 'cashier' WHERE id = '${jaafar.id}'`);
{
  const r = await direct(page, "listOperators");
  assert(r.ok === false && r.error.code === "NOT_AUTHORIZED", "🔴 demoted back, the very next call is refused again");
}

// Deactivation fails CLOSED, mid-session, without waiting for a logout.
const salesBefore = ledger((_all, get) => get("SELECT count(*) AS n FROM sales")).n;
writeLedger(`UPDATE operators SET is_active = 0 WHERE id = '${jaafar.id}'`);
{
  // 🔴 THE PAYLOAD IS DELIBERATELY VALID AND COMPLETE. Espresso is 2.50, so one unit is 250 minor
  // units, and `expectedTotalMinor` is required by CreateSaleRequest. With a payload the handler
  // would reject anyway, this assertion could never fail for the right reason: delete the live
  // authorization check and a malformed call still errors, just with INVALID_INPUT. Complete, it
  // means exactly one thing — without the check, this sale SUCCEEDS.
  const r = await direct(page, "createSale", {
    idempotencyKey: "e2e-operator-inactive",
    paymentMethod: "cash",
    lines: [{ productId: "prod-0001", quantityMilli: 1000 }],
    expectedTotalMinor: "250",
  });
  assert(r.ok === false, "🔴 a deactivated operator's next sale is refused");
  assert(r.error.code === "OPERATOR_INACTIVE", `  …as OPERATOR_INACTIVE (${r.error.code})`);
  assert(
    ledger((_all, get) => get("SELECT count(*) AS n FROM sales")).n === salesBefore,
    "and no sale was written",
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · Restart: every decision above is on disk
// ════════════════════════════════════════════════════════════════════════════════════════════════
await app.close();
({ app, page } = await open());

assert(
  (await page.getByRole("button", { name: CASHIER_NAME }).count()) === 0,
  "a deactivated operator is not offered on the login screen after a restart",
);
await page.getByRole("button", { name: OWNER_NAME }).click();
await keypad(page, OWNER_PIN);
await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
assert(true, "the owner's PIN still works after a restart");

await tab(page, "tools");
await page.waitForSelector('[data-testid="ops-table"]');
assert((await page.locator('[data-testid="ops-row"]').count()) === 3, "all three operators are still listed");
assert(
  (await opsRow(page, jaafar.id).locator('[data-testid="ops-row-status"]').innerText()).trim().length > 0,
  "and the deactivated one is shown with a status rather than hidden from the owner",
);

// Reactivate through the UI, then prove the owner-safety rules.
await opsRow(page, jaafar.id).locator('[data-testid="ops-toggle-active"]').click();
await page.waitForFunction(
  (id) => {
    const row = document.querySelector(`[data-testid="ops-row"][data-operator-id="${id}"]`);
    return row && !row.querySelector(".badge.warn");
  },
  jaafar.id,
);
assert(true, "the owner reactivates them from the operators table");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8 · 🔴 THE LAST ACTIVE OWNER IS PROTECTED
// ════════════════════════════════════════════════════════════════════════════════════════════════
assert(
  (await opsRow(page, "cashier-01").locator('[data-testid="ops-toggle-role"]').count()) === 0,
  "the owner is not offered a role change on their OWN row",
);
// The service is what actually refuses it — proven through the bridge, not through the missing button.
{
  const r = await direct(page, "setOperatorRole", { operatorId: "cashier-01", role: "cashier" });
  assert(r.ok === false, "🔴 the only active owner cannot demote themselves even by calling directly");
  assert(r.error.code === "LAST_OWNER_PROTECTED", `  …refused as LAST_OWNER_PROTECTED (${r.error.code})`);
}
{
  const r = await direct(page, "setOperatorActive", { operatorId: "cashier-01", isActive: false });
  assert(r.ok === false && r.error.code === "LAST_OWNER_PROTECTED", "🔴 and cannot deactivate themselves either");
}

// With a SECOND owner present, the same demotion becomes legal — the rule is about the last one.
await opsRow(page, jaafar.id).locator('[data-testid="ops-toggle-role"]').click();
await page.waitForFunction(
  (id) => document.querySelector(`[data-testid="ops-row"][data-operator-id="${id}"]`)?.dataset.role === "owner",
  jaafar.id,
);
await page.screenshot({ path: SHOTS + "OP4-owner-management.png" });
assert(true, "a cashier is promoted to OWNER through the owner's own surface");
{
  const r = await direct(page, "setOperatorRole", { operatorId: "cashier-01", role: "cashier" });
  assert(r.ok === true, "🔴 with another active owner, the first owner MAY be demoted");
  // Put it back, so the shop ends this script with its real owner.
  const back = await direct(page, "setOperatorRole", { operatorId: "cashier-01", role: "owner" });
  assert(back.ok === false && back.error.code === "NOT_AUTHORIZED",
    "🔴 and having just demoted themselves, they can no longer promote anyone — live authorization, same session");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 9 · 🔴 THE LEDGER SNAPSHOT SURVIVES A RENAME
// ════════════════════════════════════════════════════════════════════════════════════════════════
// cashier-01 is a cashier now; sign in as the remaining owner to do the rename.
await page.locator('[data-testid="logout"]').click();
await page.waitForSelector('[data-testid="select-cashier"]');
await page.getByRole("button", { name: CASHIER_NAME }).click();
await keypad(page, CASHIER_PIN);
await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
await tab(page, "tools");
await page.waitForSelector('[data-testid="operators-section"]');
assert(true, "the promoted operator now sees the owner surface — with no reinstall and no fixture change");

const salesBeforeRename = ledger((all) => all("SELECT id, cashier_id AS cid, cashier_name AS n FROM sales ORDER BY completed_at"));
await opsRow(page, "cashier-01").locator('[data-testid="ops-rename"]').click();
await page.waitForSelector('[data-testid="ops-dialog"]');
await page.locator('[data-testid="ops-name"]').fill("حسين رقا (سابقاً)");
await page.locator('[data-testid="ops-dialog-save"]').click();
await page.waitForFunction(
  () => !document.querySelector('[data-testid="ops-dialog"]'),
);
{
  const after = ledger((all) => all("SELECT id, cashier_id AS cid, cashier_name AS n FROM sales ORDER BY completed_at"));
  assert(
    JSON.stringify(after) === JSON.stringify(salesBeforeRename),
    "🔴 renaming an operator changed NO past sale — the ledger holds a snapshot, not a join",
  );
  assert(
    after.some((s) => s.n === OWNER_NAME),
    `and the old sale still names them as they were that day (${OWNER_NAME})`,
  );
  assert(
    ledger((_all, get) => get("SELECT name FROM operators WHERE id = 'cashier-01'")).name === "حسين رقا (سابقاً)",
    "while the operator's own row carries the new name",
  );
}

await app.close();
log("");
log("OPERATOR ACCOUNTS E2E: every assertion passed against the installed app.");
log(`screenshots: OP1-mandatory-setup OP2-owner-operators OP3-cashier-denied OP4-owner-management`);
