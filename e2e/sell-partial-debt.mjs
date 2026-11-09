// SELL-PARTIAL-DEBT (owner, 2026-11-08) — part received now, the rest on the customer's account, against
// the real app (renderer → preload → IPC → service → SQLite), on a throw-away profile with the demo catalogue.
//
//   node e2e/sell-partial-debt.mjs
//
// Proven: the owner types the amount received now; zero, a non-number and an amount ≥ the total are
// refused on screen and write nothing; cash 2.00 of 5.00 records ONE partial sale, ONE cash tender of 2.00
// and ONE debt of exactly 3.00, and the receipt says both halves; a double click records one sale; Whish
// 1.50 of 5.00 needs its reference + confirmation and records an external tender with that reference and a
// debt of 3.50; a reused Whish reference is refused with nothing written; the debts are on the statement
// and collected later in cash; a cashier is offered nothing and the bridge refuses them.
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-partial-"));
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
  references: n("SELECT count(*) AS n FROM external_references"),
});
const lastSale = () =>
  read((db) => {
    const r = db
      .prepare(
        `SELECT s.id, s.total_minor AS t, s.paid_minor AS p, s.balance_due_minor AS b, s.payment_status AS st,
                s.payment_method AS m, s.customer_id AS c, s.tender_count AS tc,
                o.amount_minor AS oa, o.party_id AS op,
                (SELECT group_concat(method || ':' || amount_minor || ':' || coalesce(reference, '-')) FROM sale_tenders t WHERE t.sale_id = s.id) AS tenders
           FROM sales s LEFT JOIN obligations o ON o.source_ref = s.id ORDER BY s.rowid DESC LIMIT 1`,
      )
      .get();
    return { ...r, t: Number(r.t), p: Number(r.p), b: Number(r.b), oa: Number(r.oa), tc: Number(r.tc) };
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

// ── 1 · The owner and one customer ───────────────────────────────────────────────────────────────
await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();
const CUST = "زبون الدفعة الجزئية";
const cust = okOf(await direct("createCustomer", { displayName: CUST, phone: null, address: null, note: null }), "createCustomer").customer;

// ── 2 · On screen: zero, a non-number, the whole total → refused, and nothing written ────────────
await product("Espresso").click();
await product("Espresso").click();
await pick(CUST);
await testid("complete-sale").click();
await testid("pay-partial-amount").waitFor();
const b2 = footprint();
for (const [typed, kind] of [["0", "invalid"], ["abc", "invalid"], ["5", "notLess"], ["7.25", "notLess"]]) {
  await testid("pay-partial-amount").fill(typed);
  assert((await testid("pay-partial-note").getAttribute("data-kind")) === kind, `«${typed}» → ${kind}, said on screen`);
  assert((await testid("pay-partial-cash").count()) === 0 && (await testid("pay-on-account").count()) === 0, `«${typed}»: no button records anything`);
}
assert(JSON.stringify(footprint()) === JSON.stringify(b2), "🔴 nothing was written by any refused amount");

// ── 3 · Cash 2.00 of 5.00: one partial sale, one cash tender 2.00, one debt of exactly 3.00 ──────
await testid("pay-partial-amount").fill("2");
const split = testid("pay-partial-split");
assert((await split.getAttribute("data-paid")) === "200" && (await split.getAttribute("data-rest")) === "300", "the screen says: 2.00 now, 3.00 on the account");
// Found by looking at the screenshot of the first green run: the full-payment buttons stayed live (a press
// would record 5.00 PAID), and the note still said "the whole amount is a debt, nothing received".
assert((await testid("pay-cash").isDisabled()) && (await testid("pay-whish").isDisabled()), "🔴 with an amount typed, the full-payment buttons cannot record the whole total as paid");
assert((await testid("pay-on-account-note").getAttribute("data-kind")) === "partial" && (await testid("pay-on-account-note").innerText()).includes("والباقي فقط"), "🔴 the note says what happens NOW: the part is a payment, only the rest a debt");
await page.screenshot({ path: SHOTS + "PARTIAL1-pay-split.png" });
await testid("pay-partial-cash").click();
await testid("receipt").waitFor();
await page.screenshot({ path: SHOTS + "PARTIAL2-receipt-cash.png" });
assert((await testid("receipt-method").getAttribute("data-method")) === "cash", "the receipt: paid by cash…");
assert((await testid("receipt-paid-amount").innerText()).includes("2.00"), "…2.00 received now…");
assert((await testid("receipt-balance-due").innerText()).includes("3.00"), "…3.00 still due…");
assert((await testid("receipt-on-account-customer").innerText()).trim() === CUST, "…on the named customer's account");
const s3 = lastSale();
assert(s3.st === "partial" && s3.m === "cash" && s3.t === 500 && s3.p === 200 && s3.b === 300 && s3.tc === 1, `🔴 the sale: partial, cash, 5.00 = 2.00 paid + 3.00 due (${JSON.stringify(s3)})`);
assert(s3.tenders === "cash:200:-", "🔴 ONE cash tender for exactly what was received");
assert(s3.oa === 300 && s3.op === cust.id && s3.c === cust.id, "🔴 ONE debt for exactly the rest, on the customer the sale names");
assert(footprint().settlements === 0, "the part received now is a tender, never a settlement of the debt");
await testid("new-sale").click();

// ── 4 · A double click records ONE sale and ONE debt ─────────────────────────────────────────────
await product("Mint Tea").click();
await pick(CUST);
await testid("complete-sale").click();
await testid("pay-partial-amount").fill("1");
const b4 = footprint();
await testid("pay-partial-cash").dblclick();
await testid("receipt").waitFor();
await page.waitForTimeout(500);
const a4 = footprint();
assert(a4.sales === b4.sales + 1 && a4.obligations === b4.obligations + 1 && a4.tenders === b4.tenders + 1, `🔴 a double click: one sale, one tender, one debt (${JSON.stringify({ b4, a4 })})`);
assert(lastSale().oa === 99, "1.99 − 1.00 = 0.99 on the account");
await testid("new-sale").click();

// ── 5 · Whish 1.50 of 5.00: reference + confirmation, external tender, debt 3.50 ─────────────────
await product("Espresso").click();
await product("Espresso").click();
await pick(CUST);
await testid("complete-sale").click();
await testid("pay-partial-amount").fill("1.50");
await testid("pay-partial-whish").click();
assert((await testid("whish-step").getAttribute("data-for")) === "partial", "the Whish step opens FOR the down payment");
assert((await testid("whish-partial-split").innerText()).includes("1.50") && (await testid("whish-partial-split").innerText()).includes("3.50"), "…and says 1.50 by Whish, 3.50 on the account");
assert(await testid("whish-submit").isDisabled(), "nothing recorded before the reference and the confirmation");
await testid("whish-reference").fill("WH-PARTIAL-E2E-1");
assert(await testid("whish-submit").isDisabled(), "a reference alone is not enough — the money must be confirmed");
await testid("whish-confirm").check();
await page.screenshot({ path: SHOTS + "PARTIAL3-whish-step.png" });
await testid("whish-submit").click();
await testid("receipt").waitFor();
assert((await testid("receipt-method").getAttribute("data-provider")) === "whish", "the receipt: paid by Whish Money…");
assert((await testid("receipt-reference").innerText()).trim() === "WH-PARTIAL-E2E-1", "…with its reference…");
assert((await testid("receipt-balance-due").innerText()).includes("3.50"), "…and 3.50 still due");
const s5 = lastSale();
assert(s5.st === "partial" && s5.m === "external" && s5.p === 150 && s5.b === 350 && s5.oa === 350, `🔴 partial Whish sale: 1.50 paid, 3.50 debt (${JSON.stringify(s5)})`);
assert(s5.tenders === "external:150:WH-PARTIAL-E2E-1", "🔴 ONE external tender with the reference, for exactly 1.50");
await testid("new-sale").click();

// ── 6 · The same Whish reference again → refused on screen, nothing written ──────────────────────
await product("Mint Tea").click();
await pick(CUST);
await testid("complete-sale").click();
await testid("pay-partial-amount").fill("1");
await testid("pay-partial-whish").click();
await testid("whish-reference").fill("WH-PARTIAL-E2E-1");
await testid("whish-confirm").check();
const b6 = footprint();
await testid("whish-submit").click();
await page.locator(".dialog .error").waitFor({ timeout: 15000 });
assert((await testid("receipt").count()) === 0, "🔴 a reused Whish reference is refused — no receipt");
assert(JSON.stringify(footprint()) === JSON.stringify(b6), "…and nothing was written (sale, tender, reference, debt)");
await page.screenshot({ path: SHOTS + "PARTIAL4-whish-duplicate.png" });
await testid("whish-back").click();
await testid("pay-back").click();

// ── 7 · The statement holds the three debts; one is collected later in cash ──────────────────────
const st = okOf(await direct("getCustomerStatement", { customerId: cust.id }), "statement");
assert(st.obligations.length === 3 && st.balances.some((b) => b.minor === "749"), `the statement: 3.00 + 0.99 + 3.50 = 7.49 (${JSON.stringify(st.balances)})`);
const first = st.obligations.find((o) => o.amount.minor === "300");
okOf(await direct("recordCustomerPayment", { customerId: cust.id, obligationId: first.id, idempotencyKey: "partial-e2e-collect-1", amountMinor: "300", method: "cash" }), "collect");
const st2 = okOf(await direct("getCustomerStatement", { customerId: cust.id }), "statement");
assert(st2.obligations.find((o) => o.id === first.id).fullyPaid === true, "collected later in cash: that debt is fully paid");
assert(st2.balances.some((b) => b.minor === "449"), "4.49 is still owed");

// ── 8 · A cashier: no amount field, no on-account, and the bridge refuses ────────────────────────
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier Two", "2222");
await testid("cart").waitFor();
await testid("cart").waitFor();
await product("Espresso").click();
await pick(CUST);
await testid("complete-sale").click();
await testid("pay-cash").waitFor();
assert((await testid("pay-partial-amount").count()) === 0 && (await testid("pay-on-account").count()) === 0, "🔴 a cashier is offered neither part-payment nor on-account");
await testid("pay-back").click();
const b8 = footprint();
const r8 = await direct("createCustomerCreditSale", {
  idempotencyKey: "partial-e2e-cashier-1",
  lines: [{ productId: "prod-0001", quantityMilli: 1000 }],
  expectedTotalMinor: "250",
  customerId: cust.id,
  downPayment: { amountMinor: "100", method: "cash" },
});
assert(!r8.ok && r8.error.code === "NOT_AUTHORIZED", `🔴 the bridge refuses a cashier's part-payment debt (${JSON.stringify(r8.error)})`);
assert(JSON.stringify(footprint()) === JSON.stringify(b8), "…and nothing was written");

// ── 9 · Ledger arithmetic for every partial sale ─────────────────────────────────────────────────
const bad = read((db) =>
  Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM sales s LEFT JOIN obligations o ON o.source_ref = s.id
          WHERE s.payment_status = 'partial' AND s.source_type = 'pos'
            AND (o.id IS NULL OR o.amount_minor <> s.balance_due_minor OR s.tender_count <> 1
                 OR s.paid_minor <> (SELECT coalesce(sum(amount_minor), 0) FROM sale_tenders t WHERE t.sale_id = s.id)
                 OR s.paid_minor + s.balance_due_minor <> s.total_minor)`,
      )
      .get().n,
  ),
);
assert(bad === 0 && n("SELECT count(*) AS n FROM sales WHERE payment_status = 'partial'") === 3, "🔴 every partial sale: one tender = paid, one debt = the rest, paid + debt = total");

await app.close();
console.log(`SELL-PARTIAL-DEBT E2E PASSED — ${passed} checks`);
