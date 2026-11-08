// VOID-CASH OWNER-ONLY (DEC-35c, owner 2026-11-08) — voiding a CASH sale, against the real app
// (renderer → preload → IPC → service → SQLite), on a throw-away profile with the demo catalogue.
//
//   node e2e/void-cash.mjs
//
// Proven: a cashier is offered no void button on a cash sale and the bridge refuses them, writing
// nothing; the owner voids with a mandatory reason (a too-short one cannot be confirmed); the void
// row carries the sale, the owner's id and name, the reason, the business date and the time; a second
// void of the same sale is refused and no button is offered for it; the sale, its lines, its tender,
// debts, settlements and the catalogue are untouched by the void; and both the dialog and the voided
// sale say a void is NOT a record that cash went back to the customer.
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-voidcash-"));
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
const all = (sql, ...p) => read((db) => db.prepare(sql).all(...p));
const n = (sql, ...p) => read((db) => Number(db.prepare(sql).get(...p).n));
// Everything a void must NOT change, as data: the sale rows, their lines and tenders, debts,
// settlements and the catalogue. Only `voids` may grow.
const untouchable = () =>
  JSON.stringify({
    sales: all("SELECT * FROM sales ORDER BY id").map((r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v))),
    lines: all("SELECT * FROM sale_lines ORDER BY sale_id, rowid").map((r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v))),
    tenders: all("SELECT * FROM sale_tenders ORDER BY sale_id, rowid").map((r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v))),
    obligations: n("SELECT count(*) AS n FROM obligations"),
    settlements: n("SELECT count(*) AS n FROM settlements"),
    products: all("SELECT * FROM catalog_products ORDER BY id").map((r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v))),
  });
const voidCount = () => n("SELECT count(*) AS n FROM voids");

const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
assert((await app.evaluate(({ app }) => app.getPath("userData"))) === env.ALZABT_POS_USER_DATA, "throw-away profile, never a real ledger");

const testid = (id) => page.locator(`[data-testid="${id}"]`);
const product = (name) => page.locator("button.product", { hasText: name });
const direct = (method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const cashRow = (saleId) => page.locator(`[data-testid="history-row"][data-sale="${saleId}"]`);

// ── 1 · The owner records one CASH sale ──────────────────────────────────────────────────────────
await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();
await product("Espresso").click();
await product("Espresso").click();
await testid("complete-sale").click();
await testid("pay-cash").click();
await testid("receipt").waitFor();
assert((await testid("receipt-method").getAttribute("data-method")) === "cash", "a cash sale of 5.00 is recorded");
await testid("new-sale").click();
const sale = read((db) => db.prepare("SELECT id, total_minor AS t, payment_method AS m FROM sales ORDER BY rowid DESC LIMIT 1").get());
assert(sale.m === "cash" && Number(sale.t) === 500, "the ledger holds it: cash, 5.00");
const before = untouchable();
assert(voidCount() === 0, "no void yet");

// ── 2 · A cashier: no void button, and the bridge refuses — nothing written ──────────────────────
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier Two", "2222");
await testid("cart").waitFor();
await testid("tab-history").click();
await cashRow(sale.id).waitFor();
assert((await cashRow(sale.id).locator('[data-testid="history-void"]').count()) === 0, "🔴 a cashier is not offered «إبطال» on a cash sale");
await page.screenshot({ path: SHOTS + "VOIDCASH1-cashier-history.png" });
const r2 = await direct("voidSale", { saleId: sale.id, reason: "الكاشير يحاول" });
assert(!r2.ok && r2.error.code === "NOT_AUTHORIZED", `🔴 the bridge refuses a cashier's void (${JSON.stringify(r2.error)})`);
assert(voidCount() === 0 && untouchable() === before, "…and nothing was written");

// ── 3 · The owner: reason mandatory, the dialog says it is not a refund ──────────────────────────
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();
await testid("tab-history").click();
await cashRow(sale.id).locator('[data-testid="history-void"]').click();
await testid("void-reason").waitFor();
assert(await testid("void-confirm").isDisabled(), "🔴 no reason → the void cannot be confirmed");
await testid("void-reason").fill("ab");
assert(await testid("void-confirm").isDisabled(), "a 2-character reason → still cannot be confirmed");
const notice = (await testid("void-not-refund").innerText()).trim();
assert(notice.includes("نقداً") && notice.includes("لا يسجّل"), `🔴 the cash void dialog says it does NOT record cash going back (${notice})`);
const REASON = "الزبون غيّر رأيه";
await testid("void-reason").fill(REASON);
await page.screenshot({ path: SHOTS + "VOIDCASH2-owner-dialog.png" });
await testid("void-confirm").click();
await page.waitForSelector(`tr.voided[data-sale="${sale.id}"]`);

// ── 4 · The void row: sale, who, why, when — and nothing else moved ──────────────────────────────
const voids = all("SELECT v.sale_id, v.cashier_id, v.cashier_name, v.reason, v.business_date, v.created_at, o.role FROM voids v LEFT JOIN operators o ON o.id = v.cashier_id");
assert(voids.length === 1, "exactly one void row");
const v = voids[0];
assert(v.sale_id === sale.id, "🔴 it names the voided sale");
assert(v.role === "owner" && v.cashier_id === "cashier-01" && v.cashier_name === "Cashier One", `🔴 it names the OWNER who voided (${v.cashier_id} / ${v.cashier_name} / ${v.role})`);
assert(v.reason === REASON, "🔴 it keeps the reason exactly");
assert(/^\d{4}-\d{2}-\d{2}$/.test(v.business_date) && !Number.isNaN(Date.parse(v.created_at)), `🔴 it carries the business date and the time (${v.business_date} / ${v.created_at})`);
assert(untouchable() === before, "🔴 the sale, its lines, its cash tender, debts, settlements and the catalogue are unchanged by the void");

// ── 5 · A second void of the same sale: no button, and the bridge refuses ────────────────────────
assert((await cashRow(sale.id).locator('[data-testid="history-void"]').count()) === 0, "a voided sale offers no second void");
const r5 = await direct("voidSale", { saleId: sale.id, reason: "مرّة ثانية" });
assert(!r5.ok && r5.error.code === "ALREADY_VOIDED", `🔴 a double void is refused (${JSON.stringify(r5.error)})`);
assert(voidCount() === 1 && untouchable() === before, "…and nothing was written");

// ── 6 · The voided sale still says: not a record that cash went back ─────────────────────────────
await cashRow(sale.id).getByRole("button").first().click();
const after = (await testid("voided-not-refund").innerText()).trim();
assert(after === notice, "🔴 the voided sale's details repeat it: a void is not a cash refund");
await page.screenshot({ path: SHOTS + "VOIDCASH3-voided-details.png" });

await app.close();
console.log(`VOID-CASH E2E PASSED — ${passed} checks`);
