// SELL-CREDIT (owner, 2026-11-08) — a sale on a customer's account from the till, against the real app
// (renderer → preload → IPC → service → SQLite), on a throw-away profile with the demo catalogue.
//
//   node e2e/sell-credit.mjs
//
// Proven: the owner sees «على حساب الزبون» and it needs an active customer; the sale records ONE unpaid
// sale + ONE receivable equal to its total, linked to the sale and the customer, and NO payment record;
// the receipt says "on the customer's account", never "paid by"; a double click records one sale and one
// debt; the debt is on the statement and collected later in cash; an archived customer is refused; a
// cashier has no button and the bridge refuses them; nothing a refusal touched was written.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-credit-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DEMO_CATALOG: "1" };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

let passed = 0;
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
const read = (fn) => {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const n = (sql, ...p) => read((db) => Number(db.prepare(sql).get(...p).n));
const footprint = () => ({
  sales: n("SELECT count(*) AS n FROM sales"),
  tenders: n("SELECT count(*) AS n FROM sale_tenders"),
  obligations: n("SELECT count(*) AS n FROM obligations"),
  settlements: n("SELECT count(*) AS n FROM settlements"),
});

const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
assert((await app.evaluate(({ app }) => app.getPath("userData"))) === env.ALZABT_POS_USER_DATA, "throw-away profile, never a real ledger");

const testid = (id) => page.locator(`[data-testid="${id}"]`);
const product = (name) => page.locator("button.product", { hasText: name });
const direct = (method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const okOf = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};
const pick = async (name) => {
  await testid("sell-choose-customer").click();
  await testid("customer-finder").waitFor({ timeout: 30000 });
  await testid("customer-search").fill(name);
  await page.locator('[data-testid="customer-row"]').filter({ hasText: name }).first().click();
  await testid("customer-finder").waitFor({ state: "detached", timeout: 30000 });
  await testid("sell-customer").waitFor({ timeout: 30000 });
};

// ── 1 · The owner; two customers, one archived ───────────────────────────────────────────────────
await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();
const CUST = "زبون الدين";
const cust = okOf(await direct("createCustomer", { displayName: CUST, phone: null, address: null, note: null }), "createCustomer").customer;
const gone = okOf(await direct("createCustomer", { displayName: "زبون مؤرشف", phone: null, address: null, note: null }), "createCustomer").customer;
okOf(await direct("setCustomerActive", { customerId: gone.id, isActive: false }), "archive");

// ── 2 · Without a customer the choice is there but disabled, and says why ────────────────────────
await product("Espresso").click();
await product("Espresso").click();
await testid("complete-sale").click();
await testid("pay-on-account").waitFor();
assert(await testid("pay-on-account").isDisabled(), "🔴 on account is disabled until a customer is chosen");
assert((await testid("pay-on-account-note").innerText()).includes("اختر زبوناً"), "…and it says to choose a customer");
await testid("pay-back").click();

// ── 3 · With the customer: one unpaid sale, one receivable = total, no payment record ────────────
await pick(CUST);
const before = footprint();
await testid("complete-sale").click();
assert(!(await testid("pay-on-account").isDisabled()), "with an active customer, on account is available");
await testid("pay-on-account").click();
await testid("receipt").waitFor();
await page.screenshot({ path: SHOTS + "CREDIT1-receipt.png" });
assert((await testid("receipt-on-account").count()) === 1 && (await testid("receipt-method").count()) === 0, "🔴 the receipt says «على حساب الزبون», never «طريقة الدفع»");
assert((await testid("receipt-on-account-customer").innerText()).trim() === CUST, "the receipt names the customer");
assert((await testid("receipt-balance-due").innerText()).includes("5.00"), "the receipt shows 5.00 due");
const after = footprint();
assert(after.sales === before.sales + 1 && after.obligations === before.obligations + 1, "ONE sale and ONE debt");
assert(after.tenders === before.tenders && after.settlements === before.settlements, "🔴 NO payment record: no tender, no settlement");
const row = read((db) =>
  db.prepare(`SELECT s.id, s.total_minor AS t, s.paid_minor AS p, s.balance_due_minor AS b, s.payment_status AS st, s.payment_method AS m, s.customer_id AS c,
                     o.amount_minor AS oa, o.party_id AS op, o.source_ref AS osr
              FROM sales s JOIN obligations o ON o.source_ref = s.id ORDER BY s.rowid DESC LIMIT 1`).get(),
);
assert(Number(row.t) === 500 && Number(row.p) === 0 && Number(row.b) === 500 && row.st === "unpaid" && row.m === null, `🔴 the sale is 5.00, nothing paid, unpaid, no method (${JSON.stringify({ t: Number(row.t), p: Number(row.p), st: row.st, m: row.m })})`);
assert(Number(row.oa) === 500 && row.op === cust.id && row.c === cust.id, "🔴 the debt equals the unpaid amount and belongs to the customer the sale is linked to");
await testid("new-sale").click();

// ── 4 · A double click records ONE sale and ONE debt ─────────────────────────────────────────────
await product("Mint Tea").click();
await pick(CUST);
const b4 = footprint();
await testid("complete-sale").click();
await testid("pay-on-account").dblclick();
await testid("receipt").waitFor();
await page.waitForTimeout(500);
const a4 = footprint();
assert(a4.sales === b4.sales + 1 && a4.obligations === b4.obligations + 1, `🔴 a double click recorded one sale and one debt (${JSON.stringify({ b4, a4 })})`);
await testid("new-sale").click();

// ── 5 · The debt is on the statement and is collected later — cash ───────────────────────────────
const st = okOf(await direct("getCustomerStatement", { customerId: cust.id }), "statement");
assert(st.obligations.length === 2 && st.balances.some((b) => b.minor === "699"), `the statement holds both debts: 5.00 + 1.99 = 6.99 (${JSON.stringify(st.balances)})`);
assert(st.paidSales.length === 0, "a sale on account is a debt, never listed as paid activity");
const first = st.obligations.find((o) => o.amount.minor === "500");
okOf(await direct("recordCustomerPayment", { customerId: cust.id, obligationId: first.id, idempotencyKey: "credit-e2e-collect-1", amountMinor: "500", method: "cash" }), "collect");
const st2 = okOf(await direct("getCustomerStatement", { customerId: cust.id }), "statement");
assert(st2.obligations.find((o) => o.id === first.id).fullyPaid === true, "collected in cash later: that debt is fully paid");
assert(st2.balances.some((b) => b.minor === "199"), "1.99 is still owed");

// ── 6 · An archived customer is refused; nothing written ─────────────────────────────────────────
const b6 = footprint();
const r6 = await direct("createCustomerCreditSale", { idempotencyKey: "credit-e2e-archived-1", lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: "250", customerId: gone.id });
assert(!r6.ok && r6.error.code === "PARTY_NOT_FOUND", `🔴 an archived customer is refused (${JSON.stringify(r6.error)})`);
assert(JSON.stringify(footprint()) === JSON.stringify(b6), "…and nothing was written");

// ── 7 · A cashier: no button, and the bridge refuses ─────────────────────────────────────────────
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier Two", "2222");
await testid("cart").waitFor();
await product("Espresso").click();
await pick(CUST);
await testid("complete-sale").click();
await testid("pay-cash").waitFor();
assert((await testid("pay-on-account").count()) === 0, "🔴 a cashier is never offered «على حساب الزبون»");
await testid("pay-back").click();
const b7 = footprint();
const r7 = await direct("createCustomerCreditSale", { idempotencyKey: "credit-e2e-cashier-1", lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: "250", customerId: cust.id });
assert(!r7.ok && r7.error.code === "NOT_AUTHORIZED", `🔴 the bridge refuses a cashier's debt (${JSON.stringify(r7.error)})`);
assert(JSON.stringify(footprint()) === JSON.stringify(b7), "…and nothing was written");
await page.screenshot({ path: SHOTS + "CREDIT2-cashier.png" });

// ── 8 · Ledger arithmetic for every credit sale ──────────────────────────────────────────────────
const bad = read((db) =>
  Number(
    db.prepare(`SELECT count(*) AS n FROM sales s LEFT JOIN obligations o ON o.source_ref = s.id
                WHERE s.payment_status = 'unpaid' AND s.source_type = 'pos'
                  AND (o.id IS NULL OR o.amount_minor <> s.balance_due_minor OR s.tender_count <> 0)`).get().n,
  ),
);
assert(bad === 0, "🔴 every on-account sale has exactly its receivable = its unpaid amount, and no tender");

await app.close();
console.log(`SELL-CREDIT E2E PASSED — ${passed} checks`);
