// SELL-CART-LOST-ON-TAB (owner go, 2026-11-08) — the Sell cart survives a tab switch, against the real
// app (renderer → preload → IPC → service → SQLite), on a throw-away profile with the demo catalogue.
//
//   node e2e/sell-cart-tab.mjs
//
// What is proven: the same lines, quantities and total come back after visiting EVERY other tab; leaving
// and returning writes nothing (no sale, tender, settlement, receipt, obligation, void); an edit after
// returning is kept too; the payment step is modal (no switch mid-payment) and the sale is recorded ONCE;
// a completed sale and a cleared cart stay empty; a cart never passes to another operator, nor survives
// its own operator's sign-out.
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-cart-"));
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
const footprint = () => {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    const n = (t) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
    return { sales: n("sales"), lines: n("sale_lines"), tenders: n("sale_tenders"), settlements: n("settlements"), receipts: n("receipts"), obligations: n("obligations"), voids: n("voids") };
  } finally {
    db.close();
  }
};

const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
const page = await app.firstWindow();
// J1: a fresh real profile opens the joint-C1 Welcome first. Take its plain «Sign in» — NEVER welcome-demo.
await page.waitForSelector('[data-testid="select-cashier"], [data-testid="welcome-screen"]', { timeout: 30000 });
if (await page.locator('[data-testid="welcome-screen"]').count()) {
  await page.locator('[data-testid="welcome-login"]').click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
}
assert((await app.evaluate(({ app }) => app.getPath("userData"))) === env.ALZABT_POS_USER_DATA, "throw-away profile, never a real ledger");

const product = (name) => page.locator("button.product", { hasText: name });
const line = (name) => page.locator("li.line", { hasText: name });
const tab = (name) => page.locator(`[data-testid="tab-${name}"]`);
/** The cart exactly as the operator sees it: every line's text, in order, and the total. */
const snapshot = async () => ({
  lines: (await page.locator("li.line").allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim()),
  total: (await page.locator('[data-testid="cart-total"]').innerText()).trim(),
});
const backToSell = async () => {
  await tab("sell").click();
  await page.waitForSelector('[data-testid="cart"]');
  await page.waitForSelector("button.product");
};
const visit = async (name) => {
  await tab(name).click();
  await page.waitForTimeout(400); // let the other screen mount and load
  await backToSell();
};
const OTHER_TABS = ["today", "history", "products", "customers", "invoices", "tools"];

// ── 1 · The owner fills a cart ───────────────────────────────────────────────────────────────────
await signIn(page, "Cashier One", "1111");
await page.waitForSelector('[data-testid="cart"]');
await product("Espresso").click();
await product("Espresso").click();
await product("Mint Tea").click();
await product("Fresh Orange Juice").click();
const before = await snapshot();
assert(before.lines.length === 3, `three lines in the cart (${before.lines.length})`);
const empty = footprint();
assert(empty.sales === 0 && empty.tenders === 0, "nothing recorded yet");

// ── 2 · Every other tab, and back ────────────────────────────────────────────────────────────────
for (const name of OTHER_TABS) {
  await visit(name);
  const after = await snapshot();
  assert(JSON.stringify(after) === JSON.stringify(before), `🔴 after ${name}: the same lines, quantities and total (${after.total})`);
}
assert(JSON.stringify(footprint()) === JSON.stringify(empty), "🔴 visiting six tabs wrote NOTHING (no sale, tender, settlement, receipt, debt, void)");
await page.screenshot({ path: SHOTS + "CART1-kept-after-tabs.png" });

// ── 3 · An edit after returning is kept as well; nothing duplicated ──────────────────────────────
await line("Mint Tea").locator('[data-testid="line-inc"]').click();
await line("Fresh Orange Juice").locator('[data-testid="line-remove-btn"]').click();
const edited = await snapshot();
assert(edited.lines.length === 2 && edited.total !== before.total, `the edit applied (${edited.total})`);
await visit("history");
await visit("today");
assert(JSON.stringify(await snapshot()) === JSON.stringify(edited), "🔴 the edited cart is kept exactly — no line duplicated, no total changed");

// ── 4 · The payment step is modal: no tab switch can happen mid-payment; the sale is recorded ONCE ──
await page.locator('[data-testid="complete-sale"]').click();
await page.waitForSelector('[data-testid="pay-cash"]');
{
  // Measured, not assumed: what is under the pointer at the centre of the Customers tab is the overlay.
  const covered = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="tab-customers"]').getBoundingClientRect();
    const hit = document.elementFromPoint(t.x + t.width / 2, t.y + t.height / 2);
    return hit !== null && hit.closest(".overlay") !== null;
  });
  assert(covered, "🔴 while the payment step is open the tab bar is covered — leaving mid-payment is not possible");
}
await page.locator('[data-testid="pay-cash"]').click();
await page.waitForSelector('[data-testid="receipt"]');
const paid = footprint();
assert(paid.sales === 1 && paid.lines === 2 && paid.tenders === 1, `ONE sale with its two lines and one cash tender (${JSON.stringify(paid)})`);
await page.locator('[data-testid="new-sale"]').click();

// ── 5 · A completed sale does not come back as a cart ────────────────────────────────────────────
await visit("history");
assert((await page.locator("li.line").count()) === 0, "🔴 after a completed sale the cart is empty, also after a tab switch");
assert(footprint().sales === 1, "still exactly one sale");

// ── 6 · A cleared cart stays cleared ─────────────────────────────────────────────────────────────
await product("Espresso").click();
await page.locator('[data-testid="clear-cart"]').click();
await page.locator('[data-testid="clear-confirm"]').click();
await visit("today");
assert((await page.locator("li.line").count()) === 0, "a cleared cart stays empty after a tab switch");

// ── 7 · A cart never passes to another operator, nor survives sign-out ───────────────────────────
await product("Butter Croissant").click();
await product("Butter Croissant").click();
assert((await page.locator("li.line").count()) === 1, "the owner has a cart again");
await page.locator('[data-testid="logout"]').click();
await page.waitForSelector('[data-testid="select-cashier"]');
await signIn(page, "Cashier Two", "2222");
await page.waitForSelector('[data-testid="cart"]');
assert((await page.locator("li.line").count()) === 0, "🔴 the next operator starts with an EMPTY cart — never the previous one's");
await product("Mint Tea").click();
await visit("history");
assert((await page.locator("li.line").count()) === 1, "the second operator's own cart is kept across a tab switch");
await page.locator('[data-testid="logout"]').click();
await page.waitForSelector('[data-testid="select-cashier"]');
await signIn(page, "Cashier One", "1111");
await page.waitForSelector('[data-testid="cart"]');
assert((await page.locator("li.line").count()) === 0, "🔴 sign-out ended the owner's cart too — it does not come back at the next sign-in");
assert(footprint().sales === 1, "after all of it: still exactly one sale");
await page.screenshot({ path: SHOTS + "CART2-after-operators.png" });

// ── 8 · The chosen customer is kept; removed / deactivated / re-priced products while away ───────
const direct = (method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const okOf = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r;
};
const cust = okOf(await direct("createCustomer", { displayName: "زبون السلّة", phone: null, address: null, note: null }), "createCustomer").data.customer;
await product("Espresso").click();
await product("Mint Tea").click();
await page.locator('[data-testid="sell-choose-customer"]').click();
await page.locator('[data-testid="customer-finder"]').waitFor({ timeout: 30000 });
await page.locator('[data-testid="customer-search"]').fill("زبون السلّة");
await page.locator('[data-testid="customer-row"]').filter({ hasText: "زبون السلّة" }).first().click();
await page.locator('[data-testid="sell-customer"]').waitFor({ timeout: 30000 });
await visit("customers");
assert((await page.locator('[data-testid="sell-customer"]').getAttribute("data-customer")) === cust.id, "🔴 the chosen customer is kept across a tab switch");
assert((await page.locator("li.line").count()) === 2, "with its two lines");

// A real product appears → the sample catalogue is withdrawn: every sample line in the kept cart is no
// longer for sale. They are removed AND said so; nothing unavailable can be sold.
const a = okOf(await direct("createProduct", { draft: { nameAr: "صنف أ", nameEn: "Item A", sku: "CART-A", price: "2.50", baseUnit: "piece" } }), "createProduct A").data;
const b = okOf(await direct("createProduct", { draft: { nameAr: "صنف ب", nameEn: "Item B", sku: "CART-B", price: "4.00", baseUnit: "piece" } }), "createProduct B").data;
await visit("products");
assert((await page.locator("li.line").count()) === 0, "🔴 products that left the catalogue left the cart");
assert((await page.locator('[data-testid="cart-dropped-note"]').count()) === 1, "🔴 …and the cart says so (never a silent shrink)");

const itemA = () => page.locator("button.product", { hasText: "Item A" }).or(page.locator("button.product", { hasText: "صنف أ" })).first();
const itemB = () => page.locator("button.product", { hasText: "Item B" }).or(page.locator("button.product", { hasText: "صنف ب" })).first();
await itemA().click();
await itemA().click();
await itemB().click();
assert((await snapshot()).total.startsWith("9.00"), `2 × 2.50 + 4.00 = 9.00 (${(await snapshot()).total})`);

// The price of A changes while the operator is away → the kept cart is priced NOW (main re-prices too).
okOf(await direct("updateProduct", { id: a.id, draft: { nameAr: "صنف أ", nameEn: "Item A", sku: "CART-A", price: "3.00", baseUnit: "piece" }, isActive: true }), "updateProduct A");
await visit("products");
assert((await snapshot()).total.startsWith("10.00"), `🔴 a changed price applies on return: 2 × 3.00 + 4.00 = 10.00 (${(await snapshot()).total})`);
assert((await page.locator("li.line").count()) === 2, "same two lines, same quantities");

// B is deactivated while away → removed from the cart, said so; A stays.
okOf(await direct("setProductActive", { id: b.id, isActive: false }), "setProductActive B");
await visit("history");
const afterOff = await snapshot();
assert(afterOff.lines.length === 1 && afterOff.total.startsWith("6.00"), `🔴 a deactivated product left the cart; 2 × 3.00 = 6.00 remains (${afterOff.total})`);
assert((await page.locator('[data-testid="cart-dropped-note"]').count()) === 1, "the removal is said");
const pre = footprint();
await page.locator('[data-testid="complete-sale"]').click();
await page.locator('[data-testid="pay-cash"]').click();
await page.waitForSelector('[data-testid="receipt"]');
{
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    const s = db.prepare("SELECT id, total_minor AS t, customer_id AS c FROM sales ORDER BY rowid DESC LIMIT 1").get();
    const ls = db.prepare("SELECT product_id AS p, quantity_milli AS q, unit_price_minor AS u FROM sale_lines WHERE sale_id = ?").all(s.id);
    assert(Number(s.t) === 600 && s.c === cust.id, `🔴 the sale is 6.00 at TODAY's price, for the kept customer (${JSON.stringify({ t: Number(s.t), c: s.c })})`);
    assert(ls.length === 1 && ls[0].p === a.id && Number(ls[0].q) === 2000 && Number(ls[0].u) === 300, `one line: A × 2 at 3.00 — no inactive product sold (${JSON.stringify(ls.map((l) => ({ ...l, q: Number(l.q), u: Number(l.u) })))})`);
  } finally {
    db.close();
  }
}
assert(footprint().sales === pre.sales + 1, "exactly one more sale");
await page.locator('[data-testid="new-sale"]').click();

await app.close();
console.log(`SELL-CART-KEEP-ON-TAB E2E PASSED — ${passed} checks`);
