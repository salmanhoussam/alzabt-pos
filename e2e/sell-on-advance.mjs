// DEC-35x — APPLY A CUSTOMER ADVANCE TO A NEW SALE, at the till — against the real app. Synthetic data.
//   A · a customer holds a 3.00 cash advance; the owner rings up 5.00 (2 × Espresso) for them
//   B · «على الحساب مع تطبيق الدفعة المقدّمة ADV-000001»: ONE sale on account, 3.00 applied, 2.00 left on
//       the account; the receipt says so; no tender; no new money in the day's report
//   C · the advance is used up: the button is no longer offered; a CASHIER is refused by the channel
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-sellonadv-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1", ALZABT_POS_DEMO_CATALOG: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let passed = 0;
const assert = (c, m) => {
  if (!c) throw new Error("ASSERTION FAILED: " + m);
  passed += 1;
  console.log("• PASS", m);
};
const n = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return Number(Object.values(db.prepare(sql).get(...p))[0] ?? 0);
  } finally {
    db.close();
  }
};
const CUST = "زبون البيع على الدفعة";

const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  const testid = (id) => page.locator(`[data-testid="${id}"]`);
  const product = (name) => page.locator("button.product", { hasText: name });
  await signIn(page, "Cashier One", "1111"); // owner
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid("lang-toggle").click();
  await testid("cart").waitFor();

  const digits = (s) => s.replace(/[^0-9.]/g, "");
  const seedCustomer = (name, advMinor, key) =>
    page.evaluate(
      async ([name, advMinor, key]) => {
        const must = (r) => {
          if (!r.ok) throw new Error(JSON.stringify(r.error));
          return r.data;
        };
        const c = must(await window.pos.createCustomer({ displayName: name, phone: null, address: null, note: null })).customer.id;
        const a = must(await window.pos.recordAdvance({ customerId: c, amountMinor: advMinor, channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: key }));
        await window.pos.acknowledgeAdvance({ idempotencyKey: key });
        return { c, number: a.advance.number, inBefore: must(await window.pos.getDailyMoney({})).moneyIn.total.minor };
      },
      [name, advMinor, key],
    );
  /** Ring 5.00 (2 × Espresso) for `name` and pay it from their advance — a DOUBLE click (one sale only). */
  const sellOnAdvance = async (name, number) => {
    await product("Espresso").click();
    await product("Espresso").click();
    await testid("sell-choose-customer").click();
    await testid("customer-finder").waitFor({ timeout: 30000 });
    await testid("customer-search").fill(name);
    await page.locator('[data-testid="customer-row"]').filter({ hasText: name }).first().click();
    await testid("customer-finder").waitFor({ state: "detached", timeout: 30000 });
    await testid("complete-sale").click();
    await page.locator(`[data-testid="pay-on-advance"][data-advance="${number}"]`).waitFor({ timeout: 15000 });
    await testid("pay-on-advance").dblclick();
    await testid("receipt").waitFor({ timeout: 30000 });
  };
  /**
   * DEC-35z: EVERY figure and EVERY label of the advance receipt, and no generic «amount due» (the sale
   * total is not what is owed once an advance paid part of it). The displayed debt must equal the ledger.
   */
  const receiptSays = async (what, { total, paid, left, number, labels }) => {
    assert((await testid("receipt-balance-due").count()) === 0, `${what}: no «amount due» line showing the sale total`);
    assert((await testid("receipt-advance-applied").getAttribute("data-advance")) === number, `${what}: the receipt names ${number}`);
    const dts = await page.locator('[data-testid="receipt-advance-applied"] dt').allInnerTexts();
    assert(JSON.stringify(dts.map((s) => s.trim())) === JSON.stringify(labels), `${what}: the three labels read ${JSON.stringify(labels)} (got ${JSON.stringify(dts)})`);
    const shown = [await testid("receipt-sale-total").innerText(), await testid("receipt-advance-paid").innerText(), await testid("receipt-debt-left").innerText()].map(digits);
    assert(JSON.stringify(shown) === JSON.stringify([total, paid, left]), `${what}: sale total ${total} · paid from advance ${paid} · left on account ${left} (got ${shown})`);
    // 🔴 What the customer is told they owe IS what the ledger says they owe for THIS sale.
    const saleId = (await page.evaluate(async () => (await window.pos.getSaleHistory({ limit: 1 })).data[0].sale.id));
    const owed = n("SELECT o.amount_minor - coalesce((SELECT sum(amount_minor) FROM settlements WHERE obligation_id = o.id), 0) FROM obligations o WHERE o.sale_id = ?", saleId);
    assert((owed / 100).toFixed(2) === left, `${what}: the ledger's outstanding debt for this sale is ${left}`);
  };
  const AR = (n) => ["إجمالي البيع", `المسدّد من الدفعة المقدّمة ${n}`, "المتبقّي على الحساب"];

  // ── A · advance BELOW the sale: 3.00 of 5.00 ────────────────────────────────────────────────
  const seeded = await seedCustomer(CUST, "300", "e2e-sellonadv-adv-01");
  await product("Espresso").click();
  await product("Espresso").click();
  await testid("sell-choose-customer").click();
  await testid("customer-finder").waitFor({ timeout: 30000 });
  await testid("customer-search").fill(CUST);
  await page.locator('[data-testid="customer-row"]').filter({ hasText: CUST }).first().click();
  await testid("customer-finder").waitFor({ state: "detached", timeout: 30000 });
  await testid("complete-sale").click();
  await page.locator('[data-testid="pay-on-advance"][data-advance="ADV-000001"]').waitFor({ timeout: 15000 });
  assert((await testid("pay-on-advance").count()) === 1, "the till offers the customer's advance ADV-000001 beside «on account»");
  await page.screenshot({ path: SHOTS + "SELLONADV-offer-arabic.png" });
  // DEC-35y review: a REPEATED click — the same checkout key and the busy guard must give ONE sale.
  await testid("pay-on-advance").dblclick();
  await testid("receipt").waitFor({ timeout: 30000 });
  await receiptSays("BELOW", { total: "5.00", paid: "3.00", left: "2.00", number: "ADV-000001", labels: AR("ADV-000001") });
  await page.screenshot({ path: SHOTS + "SELLONADV-receipt-below-arabic.png" });
  assert(n("SELECT count(*) FROM sales") === 1 && n("SELECT count(*) FROM sale_tenders") === 0, "ledger: ONE sale, no tender (no cash, no Whish)");
  assert(n("SELECT amount_minor FROM obligations") === 500 && n("SELECT sum(amount_minor) FROM settlements") === 300, "ledger: the debt is 5.00, 3.00 of it settled from the advance");
  assert(n("SELECT count(*) FROM advance_applications") === 1 && n("SELECT count(*) FROM receipts") === 0, "ledger: one application, no receipt");
  const day = await page.evaluate(async () => (await window.pos.getDailyMoney({})).data);
  assert(day.moneyIn.total.minor === seeded.inBefore && day.advanceApplied.total.minor === "300" && day.sales.onAccount.minor === "500", "🔴 the day's money in is unchanged; 3.00 shown as applied; 5.00 sold on account");
  await testid("new-sale").click();

  // ── A2 · advance EQUAL to the sale: 5.00 of 5.00 → nothing owed, no debt suggested ────────────
  const eq = await seedCustomer("زبون الدفعة المساوية", "500", "e2e-sellonadv-adv-02");
  await sellOnAdvance("زبون الدفعة المساوية", eq.number);
  await receiptSays("EQUAL", { total: "5.00", paid: "5.00", left: "0.00", number: eq.number, labels: AR(eq.number) });
  await page.screenshot({ path: SHOTS + "SELLONADV-receipt-equal-arabic.png" });
  await testid("new-sale").click();

  // ── A3 · advance ABOVE the sale: 10.00 for 5.00 → 5.00 applied, 0.00 owed, 5.00 stays on the ADV ─
  const gt = await seedCustomer("زبون الدفعة الأكبر", "1000", "e2e-sellonadv-adv-03");
  await sellOnAdvance("زبون الدفعة الأكبر", gt.number);
  await receiptSays("ABOVE", { total: "5.00", paid: "5.00", left: "0.00", number: gt.number, labels: AR(gt.number) });
  const advLeft = await page.evaluate(async (c) => (await window.pos.getAdvanceStatement({ customerId: c })).data.lines[0].unused.minor, gt.c);
  assert(advLeft === "500", "ABOVE: 5.00 stays on the advance");
  // English, LTR: the same three facts, translated.
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await receiptSays("ABOVE (English)", { total: "5.00", paid: "5.00", left: "0.00", number: gt.number, labels: ["Sale total", `Paid from advance ${gt.number}`, "Left on account"] });
  await page.screenshot({ path: SHOTS + "SELLONADV-receipt-above-english.png" });
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar");
  await testid("new-sale").click();

  // ── C ────────────────────────────────────────────────────────────────────────────────────────
  await product("Espresso").click();
  await testid("sell-choose-customer").click();
  await testid("customer-finder").waitFor({ timeout: 30000 });
  await testid("customer-search").fill(CUST);
  await page.locator('[data-testid="customer-row"]').filter({ hasText: CUST }).first().click();
  await testid("customer-finder").waitFor({ state: "detached", timeout: 30000 });
  await testid("complete-sale").click();
  await testid("pay-on-account").waitFor({ timeout: 15000 });
  // Deterministic: the panel says WHOSE advances it has read, so "none offered" is never "not read yet".
  await page.waitForFunction((c) => document.querySelector('[data-testid="on-account"]')?.getAttribute("data-advances-for") === c, seeded.c, { timeout: 15000 });
  assert((await testid("pay-on-advance").count()) === 0, "a used-up advance is no longer offered");
  await testid("pay-back").click();

  await testid("logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  const forged = await page.evaluate(
    async (c) => (await window.pos.sellOnAdvance({ idempotencyKey: "e2e-sellonadv-forged", lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: "250", customerId: c, advanceId: "x", amountMinor: "100" })).error?.code,
    seeded.c,
  );
  assert(forged === "NOT_AUTHORIZED" && n("SELECT count(*) FROM sales") === 3, "🔴 a cashier is refused by the channel; no sale written");
} finally {
  await app.close();
}
{
  const db = new Database(LEDGER, { readonly: true });
  try {
    assert(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "integrity_check ok");
  } finally {
    db.close();
  }
}
console.log(`SELL ON ADVANCE E2E PASSED — ${passed} checks`);
