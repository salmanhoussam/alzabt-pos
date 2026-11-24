// DEC-35x — APPLY A CUSTOMER ADVANCE TO AN EXISTING DEBT — against the real app. Synthetic data only.
//   A · a customer owes a credit sale (1.99) and holds a cash advance (10.00)
//   B · the OWNER applies it from the advance statement: the debt is paid in full, the advance keeps
//       8.01, the debt statement names ADV-000001 (no cash channel), no new money in the day's report,
//       no Whish reference registered, one settlement + one application in the ledger
//   C · a retry of the same request answers duplicate; a CASHIER is refused by the channel
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-advapply-"));
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
const n = (sql, ...p) => Number(Object.values(q(sql, ...p)[0])[0] ?? 0);
const NAME = "زبون تطبيق الدفعة";

const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111"); // owner
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid(page, "lang-toggle").click();

  // ── A ──────────────────────────────────────────────────────────────────────────────────────────
  const seeded = await page.evaluate(async (NAME) => {
    const must = (r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.data;
    };
    const c = must(await window.pos.createCustomer({ displayName: NAME, phone: null, address: null, note: null })).customer.id;
    must(await window.pos.createCustomerCreditSale({ idempotencyKey: "e2e-apply-sale-0001", customerId: c, lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: "199" }));
    must(await window.pos.recordAdvance({ customerId: c, amountMinor: "1000", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "e2e-apply-adv-0001" }));
    await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-apply-adv-0001" });
    const before = must(await window.pos.getDailyMoney({}));
    return { c, inBefore: before.moneyIn.total.minor };
  }, NAME);
  assert(n("SELECT count(*) FROM obligations") === 1 && n("SELECT count(*) FROM customer_advances") === 1, "a 1.99 credit-sale debt and a 10.00 cash advance on one customer");
  const refsBefore = n("SELECT count(*) FROM external_references");

  // ── B · the owner applies it from the statement ──────────────────────────────────────────────
  await testid(page, "tab-customers").click();
  await testid(page, "customers-search").fill(NAME);
  await page.waitForFunction((x) => [...document.querySelectorAll('[data-testid="customers-row"]')].some((r) => r.textContent.includes(x)), NAME, { timeout: 30000 });
  await testid(page, "customers-row").filter({ hasText: NAME }).first().click();
  await testid(page, "adv-statement").waitFor({ timeout: 30000 });
  await testid(page, "adv-stmt-apply").click();
  await testid(page, "adv-apply-sheet").waitFor({ timeout: 15000 });
  await testid(page, "adv-apply-debt").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="adv-apply-amount"]')?.value === "1.99", undefined, { timeout: 15000 });
  assert((await testid(page, "adv-apply-confirm").isEnabled()) === true, "the amount field is PREFILLED with 1.99 (the smaller balance) — what is shown is what is sent");
  await page.screenshot({ path: SHOTS + "ADVAPPLY-sheet-arabic.png" });
  await testid(page, "adv-apply-confirm").click();
  await testid(page, "adv-apply-done").waitFor({ timeout: 15000 });
  const digits = (s) => s.replace(/[^0-9.]/g, "");
  assert(digits(await testid(page, "adv-apply-unused").innerText()) === "8.01" && digits(await testid(page, "adv-apply-debt-left").innerText()) === "0.00", "read back: the advance keeps 8.01, the debt owes 0.00");
  await page.screenshot({ path: SHOTS + "ADVAPPLY-done-arabic.png" });
  await testid(page, "adv-apply-close").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="statement-settlement-advance"]') !== null, undefined, { timeout: 15000 });
  assert((await testid(page, "statement-settlement-advance").getAttribute("data-advance")) === "ADV-000001" && (await testid(page, "statement-settlement-method").count()) === 0, "the debt statement names ADV-000001 — no cash channel shown");
  await page.waitForFunction(() => document.querySelector('[data-testid="adv-stmt-line"]')?.getAttribute("data-unused") === "801", undefined, { timeout: 15000 });
  assert((await testid(page, "adv-stmt-applied").count()) === 1, "the advance statement lists the application under ADV-000001");

  const st = q("SELECT method, provider, reference, receipt_id AS r, amount_minor AS a FROM settlements");
  assert(st.length === 1 && st[0].method === "cash" && st[0].provider === null && st[0].reference === null && st[0].r === null && Number(st[0].a) === 199, "ledger: one settlement, cash, no reference, 1.99");
  assert(n("SELECT count(*) FROM advance_applications") === 1 && n("SELECT count(*) FROM receipts") === 0, "ledger: one application, no receipt");
  assert(n("SELECT count(*) FROM external_references") === refsBefore, "no reference registered");

  // ── C · not new money; a retry; a cashier ──────────────────────────────────────────────────────
  const after = await page.evaluate(async (c) => {
    const must = (r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.data;
    };
    const day = must(await window.pos.getDailyMoney({}));
    const adv = must(await window.pos.getAdvanceStatement({ customerId: c })).lines[0].advance;
    const stmt = must(await window.pos.getCustomerStatement({ customerId: c }));
    return { inAfter: day.moneyIn.total.minor, applied: day.advanceApplied.total.minor, collections: day.collections.total.minor, advanceId: adv.id, debtId: stmt.obligations[0].id };
  }, seeded.c);
  assert(after.inAfter === seeded.inBefore && after.applied === "199" && after.collections === "0", "🔴 the day's money in is unchanged (10.00); 1.99 shown as applied, 0 collected");
  const keyUsed = q("SELECT idempotency_key AS k FROM advance_applications")[0].k;
  const retry = await page.evaluate(
    async (r) => (await window.pos.applyAdvanceToDebt({ advanceId: r.advanceId, obligationId: r.debtId, amountMinor: "199", idempotencyKey: r.k })).data,
    { ...after, k: keyUsed },
  );
  assert(retry.duplicate === true && n("SELECT count(*) FROM advance_applications") === 1, "🔴 a retry with the same key answers duplicate — nothing twice");

  await testid(page, "logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  const forged = await page.evaluate(
    async (r) => (await window.pos.applyAdvanceToDebt({ advanceId: r.advanceId, obligationId: r.debtId, amountMinor: "100", idempotencyKey: "e2e-apply-forged-01" })).error?.code,
    after,
  );
  assert(forged === "NOT_AUTHORIZED" && n("SELECT count(*) FROM advance_applications") === 1, "🔴 a cashier is refused by the channel; nothing written");
} finally {
  await app.close();
}
assert(q("PRAGMA integrity_check")[0].integrity_check === "ok", "integrity_check ok");
console.log(`ADVANCE APPLY E2E PASSED — ${passed} checks`);
