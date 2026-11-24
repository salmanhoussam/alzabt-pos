// SELL-SPLIT-CASH-WHISH (owner, 2026-11-09) — ONE sale paid in full by cash AND Whish Money, against the
// real app (renderer → preload → IPC → service → SQLite), on a throw-away profile with the demo catalogue.
//
//   node e2e/sell-split.mjs
//
// Proven: the split step shows the total and what is left BEFORE anything can be recorded; empty, short,
// over and zero/garbage amounts cannot be recorded; 1.10 cash + 3.90 Whish of 5.00 records ONE paid sale
// with NO single method, TWO tenders (cash 1.10, Whish 3.90 + its reference), no debt; the receipt names
// both parts; a double click records one sale; a reused Whish reference is refused with nothing written;
// History names both parts; a customer-linked split is on the statement with both parts and no debt; a
// cashier may split (a paid sale, never a debt); the owner's void says it is neither a cash nor a Whish refund.
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-split-"));
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
  references: n("SELECT count(*) AS n FROM external_references"),
});
const lastSale = () =>
  read((db) => {
    const r = db
      .prepare(
        `SELECT s.id, s.total_minor AS t, s.paid_minor AS p, s.balance_due_minor AS b, s.payment_status AS st,
                s.payment_method AS m, s.tender_count AS tc, s.customer_id AS c,
                (SELECT group_concat(seq || ':' || method || ':' || amount_minor || ':' || coalesce(reference, '-'), ' ')
                   FROM (SELECT * FROM sale_tenders t WHERE t.sale_id = s.id ORDER BY seq)) AS tenders,
                (SELECT count(*) FROM obligations o WHERE o.source_ref = s.id) AS debts
           FROM sales s ORDER BY s.rowid DESC LIMIT 1`,
      )
      .get();
    return { ...r, t: Number(r.t), p: Number(r.p), b: Number(r.b), tc: Number(r.tc), debts: Number(r.debts) };
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
const fillSplit = async (cash, whish, ref, confirm) => {
  await testid("split-cash").fill(cash);
  await testid("split-whish").fill(whish);
  if (ref !== undefined) await testid("split-whish-reference").fill(ref);
  if (confirm) await testid("split-whish-confirm").check();
};

// ── 1 · The owner opens the split step: total and "still to cover" BEFORE anything is recorded ────
await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();
await product("Espresso").click();
await product("Espresso").click();
await testid("complete-sale").click();
await testid("pay-split").click();
await testid("split-step").waitFor();
const b1 = footprint();
const state = async () => ({ kind: await testid("split-remaining").getAttribute("data-kind"), rem: await testid("split-remaining").getAttribute("data-remaining") });
assert((await state()).kind === "empty" && (await testid("split-submit").isDisabled()), "nothing typed → nothing can be recorded");
for (const [cash, whish, kind, rem] of [
  ["2", "", "under", "300"],
  ["2", "2", "under", "100"],
  ["2", "4", "over", "-100"],
  ["0", "5", "invalid", ""],
  ["abc", "3", "invalid", ""],
  ["2.001", "2.999", "invalid", ""],
]) {
  await fillSplit(cash, whish);
  const s = await state();
  assert(s.kind === kind && s.rem === rem, `cash «${cash}» + Whish «${whish}» → ${kind}${rem ? ` (${rem})` : ""} (${JSON.stringify(s)})`);
  assert(await testid("split-submit").isDisabled(), `…and «${cash}» + «${whish}» cannot be recorded`);
}
assert(JSON.stringify(footprint()) === JSON.stringify(b1), "🔴 nothing was written by any of those");

// ── 2 · 1.10 cash + 3.90 Whish = 5.00 exactly; the reference AND the confirmation are required ─────
await fillSplit("1.10", "3.90");
assert((await state()).kind === "ok" && (await state()).rem === "0", "1.10 + 3.90 = 5.00 exactly, in whole cents");
assert(await testid("split-submit").isDisabled(), "exact amounts alone are not enough — the Whish reference is missing");
await testid("split-whish-reference").fill("WH-SPLIT-E2E-1");
assert(await testid("split-submit").isDisabled(), "…and the transfer is not confirmed yet (never pre-ticked)");
await testid("split-whish-confirm").check();
await page.screenshot({ path: SHOTS + "SPLIT1-step.png" });
assert(!(await testid("split-submit").isDisabled()), "with the reference and the confirmation it can be recorded");
await testid("split-submit").click();
await testid("receipt").waitFor();
await page.screenshot({ path: SHOTS + "SPLIT2-receipt.png" });
const rows = testid("receipt-tender");
assert((await rows.count()) === 2 && (await testid("receipt-method").count()) === 0, "🔴 the receipt has two payment lines and no single «paid by»");
assert((await rows.nth(0).getAttribute("data-method")) === "cash" && (await rows.nth(0).innerText()).includes("1.10"), "line 1: cash 1.10");
assert((await rows.nth(1).getAttribute("data-provider")) === "whish" && (await rows.nth(1).innerText()).includes("3.90") && (await rows.nth(1).innerText()).includes("WH-SPLIT-E2E-1"), "line 2: Whish 3.90 with its reference");
const s2 = lastSale();
assert(s2.st === "paid" && s2.m === null && s2.t === 500 && s2.p === 500 && s2.b === 0 && s2.tc === 2, `🔴 ONE paid sale, no single method, two tenders (${JSON.stringify(s2)})`);
assert(s2.tenders === "1:cash:110:- 2:external:390:WH-SPLIT-E2E-1", `🔴 the tenders: cash 1.10 then Whish 3.90 + reference (${s2.tenders})`);
assert(s2.debts === 0, "🔴 NO debt");
const a2 = footprint();
assert(a2.sales === b1.sales + 1 && a2.tenders === b1.tenders + 2 && a2.references === b1.references + 1 && a2.obligations === b1.obligations, "exactly one sale, two tenders, one registered reference, no obligation");
await testid("new-sale").click();

// ── 3 · A double click records ONE sale ───────────────────────────────────────────────────────────
await product("Mint Tea").click();
await testid("complete-sale").click();
await testid("pay-split").click();
await fillSplit("1", "0.99", "WH-SPLIT-E2E-2", true);
const b3 = footprint();
await testid("split-submit").dblclick();
await testid("receipt").waitFor();
await page.waitForTimeout(500);
const a3 = footprint();
assert(a3.sales === b3.sales + 1 && a3.tenders === b3.tenders + 2, `🔴 a double click: one sale, two tenders (${JSON.stringify({ b3, a3 })})`);
await testid("new-sale").click();

// ── 4 · The same Whish reference again → refused on screen, NOTHING written (not even the cash part) ─
await product("Espresso").click();
await product("Espresso").click();
await testid("complete-sale").click();
await testid("pay-split").click();
await fillSplit("2", "3", "WH-SPLIT-E2E-1", true);
const b4 = footprint();
await testid("split-submit").click();
await page.locator(".dialog .error").last().waitFor({ timeout: 15000 });
assert((await testid("receipt").count()) === 0, "🔴 a reused Whish reference is refused — no receipt");
assert(JSON.stringify(footprint()) === JSON.stringify(b4), "…and nothing was written: no sale, no cash tender, no reference");
await page.screenshot({ path: SHOTS + "SPLIT3-duplicate.png" });
await testid("split-back").click();
await testid("pay-back").click();

// ── 5 · History names both parts ─────────────────────────────────────────────────────────────────
await testid("tab-history").click();
const hRow = page.locator(`[data-testid="history-row"][data-sale="${s2.id}"]`);
await hRow.waitFor();
const hText = (await hRow.locator('[data-testid="history-payment"]').innerText()).trim();
assert(hText.includes("نقداً") && hText.includes("ويش موني") && hText.includes("1.10") && hText.includes("3.90") && hText.includes("WH-SPLIT-E2E-1"), `🔴 History: both parts and the reference (${hText})`);
await testid("tab-sell").click();

// ── 6 · A customer-linked split sale: on the statement with both parts, and still no debt ───────────
const CUST = "زبون الدفع المقسوم";
const cust = okOf(await direct("createCustomer", { displayName: CUST, phone: null, address: null, note: null }), "createCustomer").customer;
// The cart refused in step 4 is still here (Espresso × 2, kept across the History tab): a refused
// payment never empties the till. Found by the first run of this script, which added two more.
assert((await testid("cart-total").innerText()).includes("5.00"), "the refused cart (5.00) is still on the till after History");
await pick(CUST);
await testid("complete-sale").click();
await testid("pay-split").click();
await fillSplit("2", "3", "WH-SPLIT-E2E-3", true);
await testid("split-submit").click();
await testid("receipt").waitFor();
await testid("new-sale").click();
const st = okOf(await direct("getCustomerStatement", { customerId: cust.id }), "statement");
assert(st.obligations.length === 0, "🔴 no debt on the customer");
const ps = st.paidSales[0];
assert(st.paidSales.length === 1 && ps.paymentMethod === null && ps.tenders.length === 2, `the statement lists the paid split sale (${JSON.stringify(ps)})`);
assert(ps.tenders[0].method === "cash" && ps.tenders[0].amount.minor === "200" && ps.tenders[1].reference === "WH-SPLIT-E2E-3", "…with cash 2.00 and Whish 3.00 + its reference");

// ── 7 · A cashier may split (a paid sale) — and is still never offered on-account ─────────────────
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier Two", "2222");
await testid("cart").waitFor();
await product("Espresso").click();
await product("Espresso").click();
await testid("complete-sale").click();
assert((await testid("pay-on-account").count()) === 0, "a cashier has no on-account");
await testid("pay-split").click();
await fillSplit("2.50", "2.50", "WH-SPLIT-E2E-4", true);
await testid("split-submit").click();
await testid("receipt").waitFor();
const s7 = lastSale();
assert(s7.st === "paid" && s7.tc === 2 && s7.debts === 0, "🔴 a cashier's split sale: paid, two tenders, no debt");
await testid("new-sale").click();

// ── 8 · The owner voids a split sale: it says it is neither a cash nor a Whish refund ───────────────
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();
await testid("tab-history").click();
await page.locator(`[data-testid="history-row"][data-sale="${s2.id}"]`).locator('[data-testid="history-void"]').click();
const notice = (await testid("void-not-refund").innerText()).trim();
assert(notice.includes("النقد") && notice.includes("ويش موني"), `🔴 the split void dialog names BOTH: not a cash refund, not a Whish refund (${notice})`);
const b8 = footprint();
await testid("void-reason").fill("الزبون غيّر رأيه");
await testid("void-confirm").click();
await page.waitForSelector(`tr.voided[data-sale="${s2.id}"]`);
assert(JSON.stringify(footprint()) === JSON.stringify(b8), "the void writes no tender and frees no reference");

// ── 9 · Ledger arithmetic for every split sale ─────────────────────────────────────────────────────
const bad = read((db) =>
  Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM sales s
          WHERE s.tender_count >= 2
            AND (s.payment_method IS NOT NULL OR s.payment_status <> 'paid' OR s.balance_due_minor <> 0
                 OR s.paid_minor <> s.total_minor
                 OR s.tender_count <> (SELECT count(*) FROM sale_tenders t WHERE t.sale_id = s.id)
                 OR s.paid_minor <> (SELECT sum(amount_minor) FROM sale_tenders t WHERE t.sale_id = s.id)
                 OR EXISTS (SELECT 1 FROM obligations o WHERE o.source_ref = s.id))`,
      )
      .get().n,
  ),
);
assert(bad === 0 && n("SELECT count(*) AS n FROM sales WHERE tender_count >= 2") === 4, "🔴 every split sale: tenders = paid = total, no single method, no debt");

await app.close();
console.log(`SELL-SPLIT-CASH-WHISH E2E PASSED — ${passed} checks`);
