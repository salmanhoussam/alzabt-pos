// DEMO-FALLBACK (RISK-24) E2E — owner decision D-DF1 = option A, 2026-11-06.
//
// A · MERCHANT DEFAULT, fresh profile, NO switch: the owner sees the empty state (never the sample
//     café), no demo banner, no product card; a sample sale forced through the bridge is refused and
//     writes nothing; a cashier sees the "ask the owner" guidance.
// B · DEMO, fresh profile WITH ALZABT_POS_DEMO_CATALOG=1: a permanent banner, the sample catalog, a
//     sale works; a relaunch is still a demo (its own sample sales are not merchant data).
// C · THE SWITCH CANNOT TURN A SHOP INTO A DEMO: once a real product exists the switch is ignored;
//     deactivating every product gives the EMPTY till, never the sample — also after a relaunch WITH
//     the switch. The demo sales recorded in B are untouched (history is never rewritten).
//
// Offline: nothing here opens a network connection. Real exit codes; screenshots in e2e-output/.
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
const Database = createRequire(import.meta.url)("better-sqlite3");

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);

function profile() {
  const home = mkdtempSync(join(tmpdir(), "pos-e2e-demo-"));
  return { userData: join(home, "userData"), ledger: join(home, "userData", "alzabt-pos-ledger.sqlite") };
}

function baseEnv(userData, demo) {
  const env = { ...process.env, ALZABT_POS_USER_DATA: userData, ALZABT_POS_DISABLE_AUTOSTART: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ALZABT_POS_DEMO_CATALOG;
  if (demo) env.ALZABT_POS_DEMO_CATALOG = "1";
  return env;
}

async function launch(userData, demo) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env: baseEnv(userData, demo) });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  return { app, page };
}

function counts(ledger) {
  const db = new Database(ledger, { readonly: true });
  try {
    const n = (sql) => Number(db.prepare(sql).get().n);
    return {
      sales: n("SELECT count(*) AS n FROM sales"),
      lines: n("SELECT count(*) AS n FROM sale_lines"),
      products: n("SELECT count(*) AS n FROM catalog_products"),
      fixtureLines: n("SELECT count(*) AS n FROM sale_lines WHERE product_id LIKE 'prod-00%'"),
    };
  } finally {
    db.close();
  }
}

const cards = (page) => page.locator("button.product");

// ── A · merchant default ──────────────────────────────────────────────────────────────────────
{
  const p = profile();
  const { app, page } = await launch(p.userData, false);
  await signIn(page, "Cashier One", "1111");
  await testid(page, "sell-empty-catalog").waitFor({ state: "visible", timeout: 30000 });
  assert((await testid(page, "sell-empty-catalog").getAttribute("data-role")) === "owner", "A: the owner gets the owner's empty-state guidance");
  assert(
    (await testid(page, "sell-empty-catalog").innerText()).includes("لا يُعرض أيّ كتالوج تجريبي"),
    "A: the empty state says in Arabic that no sample catalog is shown",
  );
  assert((await cards(page).count()) === 0, "🔴 A: NO product card — the sample café catalog is not served");
  assert((await testid(page, "demo-banner").count()) === 0, "A: no demo banner in merchant mode");
  assert(!(await page.locator(".products-pane").innerText()).includes("لا صنف يطابق البحث"), "A: no misleading 'no match' line under the empty state");
  const catalog = await page.evaluate(() => window.pos.getCatalog());
  assert(catalog.ok && catalog.data.products.length === 0 && catalog.data.demo === false, `A: the bridge reports an empty, non-demo catalog (${JSON.stringify(catalog.ok ? { n: catalog.data.products.length, demo: catalog.data.demo } : catalog)})`);
  await page.screenshot({ path: SHOTS + "DF-A-empty-owner-arabic.png" });

  const before = counts(p.ledger);
  const forced = await page.evaluate(() =>
    window.pos.createSale({
      idempotencyKey: "df-forced-sample-0001",
      lines: [{ productId: "prod-0001", quantityMilli: 1000 }],
      paymentMethod: "cash",
      expectedTotalMinor: "250",
    }),
  );
  assert(!forced.ok && forced.error.code === "UNKNOWN_PRODUCT", `🔴 A: a sample sale forced through the bridge is REFUSED (${JSON.stringify(forced)})`);
  assert(JSON.stringify(counts(p.ledger)) === JSON.stringify(before) && before.sales === 0, `🔴 A: the refusal wrote NOTHING (${JSON.stringify(counts(p.ledger))})`);

  await testid(page, "logout").click();
  await signIn(page, "Cashier Two", "2222");
  await testid(page, "sell-empty-catalog").waitFor({ state: "visible", timeout: 30000 });
  assert((await testid(page, "sell-empty-catalog").getAttribute("data-role")) === "cashier", "A: a cashier gets the cashier's guidance");
  assert((await testid(page, "sell-empty-catalog").innerText()).includes("اطلب من المالك"), "A: the cashier is told to ask the owner");
  await page.screenshot({ path: SHOTS + "DF-A-empty-cashier-arabic.png" });
  await app.close();
}

// ── B · explicit demo on an empty ledger ─────────────────────────────────────────────────────
const demoProfile = profile();
{
  const { app, page } = await launch(demoProfile.userData, true);
  await signIn(page, "Cashier One", "1111");
  await testid(page, "demo-banner").waitFor({ state: "visible", timeout: 30000 });
  assert((await testid(page, "demo-banner").innerText()).includes("وضع العرض التجريبي"), "B: the permanent demo banner is shown in Arabic");
  assert((await cards(page).count()) === 8, `B: the sample catalog is served under the switch (${await cards(page).count()} cards)`);
  assert((await testid(page, "sell-empty-catalog").count()) === 0, "B: no empty state in demo mode");
  await cards(page).filter({ hasText: "Espresso" }).click();
  await testid(page, "complete-sale").click();
  await testid(page, "pay-cash").click();
  await page.locator('[data-testid="receipt"], .receipt').first().waitFor({ state: "visible", timeout: 30000 });
  assert(counts(demoProfile.ledger).sales === 1, "B: a demo sale is recorded in the demo profile");
  assert(await testid(page, "demo-banner").isVisible(), "🔴 B: the demo warning stays on the sale confirmation — a demo sale never reads like a real one");
  await page.screenshot({ path: SHOTS + "DF-B-demo-banner-arabic.png" });
  // 🔴 EVERY screen that shows the demo sale carries the warning, not only Sell.
  for (const tab of ["today", "history", "customers", "invoices"]) {
    await testid(page, `tab-${tab}`).click();
    await page.waitForTimeout(300);
    assert(await testid(page, "demo-banner").isVisible(), `🔴 B: the demo warning is shown on the ${tab} tab`);
    if (tab === "history") await page.screenshot({ path: SHOTS + "DF-B-demo-banner-history.png" });
  }
  await app.close();
}
{
  const { app, page } = await launch(demoProfile.userData, true);
  await signIn(page, "Cashier One", "1111");
  await testid(page, "demo-banner").waitFor({ state: "visible", timeout: 30000 });
  assert((await cards(page).count()) === 8, "B: after a relaunch the demo profile is still a demo, warning shown (its own sample sales are not merchant data)");
  await testid(page, "tab-history").click();
  assert(await testid(page, "demo-banner").isVisible(), "🔴 B: after a relaunch the warning is still on History");
  await app.close();
}

// ── C · the switch cannot turn a shop into a demo ────────────────────────────────────────────
{
  const { app, page } = await launch(demoProfile.userData, true);
  await signIn(page, "Cashier One", "1111");
  const made = await page.evaluate(() =>
    window.pos.createProduct({ draft: { nameAr: "صنف حقيقي", nameEn: "Real item", sku: "DF-REAL-1", price: "3.00", baseUnit: "piece" } }),
  );
  assert(made.ok, `C: the owner creates a real product (${JSON.stringify(made.ok ? made.data.id : made)})`);
  await app.close();

  const r = await launch(demoProfile.userData, true);
  await signIn(r.page, "Cashier One", "1111");
  await r.page.locator("button.product").first().waitFor({ state: "visible", timeout: 30000 });
  assert((await testid(r.page, "demo-banner").count()) === 0, "🔴 C: with a real product the switch is IGNORED — no banner");
  assert((await cards(r.page).count()) === 1, "C: only the real product is sellable");
  await testid(r.page, "tab-history").click();
  await r.page.waitForTimeout(300);
  assert((await testid(r.page, "demo-banner").count()) === 0, "C: no warning on History either once the shop is real");
  await testid(r.page, "tab-sell").click();
  await r.page.locator("button.product").first().waitFor({ state: "visible", timeout: 30000 });

  const off = await r.page.evaluate((id) => window.pos.setProductActive({ id, isActive: false }), made.data.id);
  assert(off.ok, "C: the owner deactivates the only product");
  await r.page.locator('[data-testid="tab-today"]').click();
  await r.page.locator('[data-testid="tab-sell"]').click();
  await testid(r.page, "sell-empty-catalog").waitFor({ state: "visible", timeout: 30000 });
  assert((await cards(r.page).count()) === 0, "🔴 C: every product deactivated ⇒ the EMPTY till, never the sample");
  await r.page.screenshot({ path: SHOTS + "DF-C-all-inactive-empty.png" });
  await r.app.close();

  const again = await launch(demoProfile.userData, true);
  await signIn(again.page, "Cashier One", "1111");
  await testid(again.page, "sell-empty-catalog").waitFor({ state: "visible", timeout: 30000 });
  assert((await testid(again.page, "demo-banner").count()) === 0 && (await cards(again.page).count()) === 0, "🔴 C: a relaunch WITH the switch stays empty — an inactive product is still merchant data");
  await again.app.close();

  const c = counts(demoProfile.ledger);
  assert(c.sales === 1 && c.fixtureLines === 1, `C: the demo sale recorded in B is untouched — history is never rewritten (${JSON.stringify(c)})`);
}

log("DEMO-FALLBACK E2E PASSED");
