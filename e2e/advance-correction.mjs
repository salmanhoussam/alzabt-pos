// G2 — the OWNER CORRECTION screen (migration 20, DEC-35s) — against the real app. Synthetic data only.
//   A · Whish advance on the WRONG customer → «تصحيح» → right customer: a CORRECTION document ADV-000002,
//       no new money (day nets to 0), the reference registered ONCE, the old advance's balance 0
//   B · a cash advance whose money never came → «لم يُقبض» with the explicit declaration: balance 0,
//       no refund, no REF document
//   C · the correction button is not offered on a corrected advance; a cashier sees no statement at all
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = process.env.E2E_EXECUTABLE ?? createRequire(import.meta.url)("electron");
const APP_ARGS = process.env.E2E_EXECUTABLE ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const Database = createRequire(import.meta.url)("better-sqlite3");
const home = mkdtempSync(join(tmpdir(), "pos-e2e-advcorr-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1", ALZABT_POS_DEMO_CATALOG: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let passed = 0;
const assert = (c, m) => {
  if (!c) throw new Error("ASSERTION FAILED: " + m);
  passed += 1;
  console.log("• PASS", m);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const q = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return db.prepare(sql).all(...p);
  } finally {
    db.close();
  }
};
const n = (sql, ...p) => Number(Object.values(q(sql, ...p)[0])[0]);
const openCustomer = async (page, name) => {
  await testid(page, "tab-customers").click();
  await testid(page, "customers-search").fill(name);
  await page.waitForFunction((x) => [...document.querySelectorAll('[data-testid="customers-row"]')].some((r) => r.textContent.includes(x)), name, { timeout: 30000 });
  await testid(page, "customers-row").filter({ hasText: name }).first().click();
  await testid(page, "customers-detail").waitFor({ timeout: 30000 });
};

let app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111"); // owner
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid(page, "lang-toggle").click();
  const ids = await page.evaluate(async () => {
    const mk = async (displayName) => (await window.pos.createCustomer({ displayName, phone: null, address: null, note: null })).data.customer.id;
    const wrong = await mk("زبون التصحيح الخطأ");
    const right = await mk("زبون التصحيح الصحيح");
    const w = await window.pos.recordAdvance({ customerId: wrong, amountMinor: "5000", channel: "whish", reference: "WH-CORR-E2E-1", fundsConfirmed: true, idempotencyKey: "e2e-corr-adv-0001" });
    await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-corr-adv-0001" });
    const c = await window.pos.recordAdvance({ customerId: wrong, amountMinor: "2000", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "e2e-corr-adv-0002" });
    await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-corr-adv-0002" });
    return { wrong, right, whish: w.data.advance.number, cash: c.data.advance.number };
  });
  assert(ids.whish === "ADV-000001" && ids.cash === "ADV-000002", "two advances recorded on the wrong customer");
  const refsBefore = n("SELECT count(*) FROM external_references WHERE legacy = 0");

  // ── A · re-link the Whish advance to the right customer ─────────────────────────────────────────
  await openCustomer(page, "زبون التصحيح الخطأ");
  await testid(page, "adv-statement").waitFor({ timeout: 15000 });
  assert((await testid(page, "adv-stmt-correct").count()) === 2, "«تصحيح» is offered on both unused advances");
  await page.locator('[data-testid="adv-stmt-line"][data-number="ADV-000001"] [data-testid="adv-stmt-correct"]').click();
  await testid(page, "adv-correct-sheet").waitFor({ timeout: 15000 });
  await testid(page, "adv-correct-kind-replaced").check();
  await testid(page, "adv-correct-customer-search").fill("الصحيح");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="adv-correct-customer"] option')].some((o) => o.textContent.includes("الصحيح")), undefined, { timeout: 15000 });
  await testid(page, "adv-correct-customer").selectOption(ids.right);
  assert(await testid(page, "adv-correct-confirm").isDisabled(), "a correction cannot be confirmed without a reason");
  await testid(page, "adv-correct-reason").fill("سُجّلت على الزبون الخطأ");
  await page.screenshot({ path: SHOTS + "ADVCORR-A-form-arabic.png" });
  await testid(page, "adv-correct-confirm").click();
  await testid(page, "adv-correct-done").waitFor({ timeout: 15000 });
  assert((await testid(page, "adv-correct-successor").innerText()).includes("ADV-000003"), "the correction document is ADV-000003 on the right customer");
  const succ = q("SELECT customer_id AS c, origin, corrects_advance_id AS k, amount_minor AS a, received_by AS by FROM customer_advances WHERE doc_no = 3")[0];
  const orig = q("SELECT id, received_by AS by FROM customer_advances WHERE doc_no = 1")[0];
  assert(succ.c === ids.right && succ.origin === "correction" && succ.k === orig.id && Number(succ.a) === 5000 && succ.by === orig.by, "ledger: a CORRECTION successor, same amount, original receiver kept");
  assert(n("SELECT count(*) FROM external_references WHERE legacy = 0") === refsBefore, "🔴 the Whish reference is NOT registered a second time");
  assert(n("SELECT count(*) FROM advance_refunds") === 0, "no refund");
  const day = q("SELECT business_date AS d FROM advance_corrections")[0].d;
  const net = n(`SELECT coalesce(sum(s.amount_minor),0) - coalesce(sum(o.amount_minor),0) FROM advance_corrections c JOIN customer_advances o ON o.id = c.advance_id LEFT JOIN customer_advances s ON s.id = c.successor_advance_id WHERE c.business_date = ?`, day);
  assert(net === 0, "🔴 the correction day nets to 0 — no new money");
  await testid(page, "adv-correct-close").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="adv-stmt-line"][data-number="ADV-000001"] [data-testid="adv-stmt-correct"]').length === 0, undefined, { timeout: 15000 });
  assert((await page.locator('[data-testid="adv-stmt-line"][data-number="ADV-000001"]').getAttribute("data-unused")) === "0", "the corrected advance's balance is 0 and «تصحيح» is gone");

  // ── B · the cash advance was never received ───────────────────────────────────────────────────────
  await page.locator('[data-testid="adv-stmt-line"][data-number="ADV-000002"] [data-testid="adv-stmt-correct"]').click();
  await testid(page, "adv-correct-sheet").waitFor({ timeout: 15000 });
  await testid(page, "adv-correct-reason").fill("لم يدفع الزبون");
  await testid(page, "adv-correct-confirm").click();
  await testid(page, "adv-correct-error").waitFor({ timeout: 15000 });
  assert(n("SELECT count(*) FROM advance_corrections") === 1, "🔴 without the explicit declaration nothing is written");
  await testid(page, "adv-correct-declare").check();
  await testid(page, "adv-correct-confirm").click();
  await testid(page, "adv-correct-done").waitFor({ timeout: 15000 });
  assert(n("SELECT count(*) FROM advance_corrections WHERE kind = 'not_received' AND funds_not_received = 1") === 1, "not received: one declared correction");
  assert(n("SELECT count(*) FROM advance_refunds") + n("SELECT last_no FROM document_numbers WHERE kind = 'advance_refund'") === 0, "🔴 no refund, no REF number");
  await page.screenshot({ path: SHOTS + "ADVCORR-B-done-arabic.png" });
  await testid(page, "adv-correct-close").click();
} finally {
  await app.close();
}

// ── C · a cashier sees no statement and cannot correct ─────────────────────────────────────────────
app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  await signIn(page, "Cashier Two", "2222");
  await openCustomer(page, "زبون التصحيح الصحيح");
  assert((await testid(page, "adv-statement").count()) === 0 && (await testid(page, "adv-stmt-correct").count()) === 0, "a cashier sees no statement and no «تصحيح»");
} finally {
  await app.close();
}
assert(q("PRAGMA integrity_check")[0].integrity_check === "ok", "integrity_check ok");
console.log(`ADVANCE CORRECTION E2E PASSED — ${passed} checks`);
