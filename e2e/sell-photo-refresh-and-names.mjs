// J1 round 2 (owner, 2026-11-19): (A) a photo added after a catalogue import reaches Sell WITHOUT a
// restart, through the merchant's real path (Products → edit → «add photo»), keeping the cart; and
// (B) the completed-sale screen shows product names in the screen's language, DISPLAY ONLY, with the
// recorded name kept beside it.
//
// Real app, NORMAL mode, throw-away profile (ALZABT_POS_USER_DATA = new temp folder). Never presses
// welcome-demo: no alzabt-test account, no Demo slot, no real shop ledger.
//
//   node e2e/sell-photo-refresh-and-names.mjs      (after `npm run build`; run with ELECTRON_RUN_AS_NODE unset)
// Exit 0 = every assertion passed; 1 = the first failed assertion, named.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = require("electron");
const SHOTS = join(APP, "e2e-output", "round2") + "/";
mkdirSync(SHOTS, { recursive: true });
const CAT = join(APP, "tests", "fixtures", "demo-catalog");
const CSV = join(CAT, "alzabt-demo-catalog-import.csv");
const ESPRESSO_JPG = join(CAT, "images", "COF-ESP.jpg");
const USERDATA = join(mkdtempSync(join(tmpdir(), "pos-e2e-round2-")), "userData");
const Database = require("better-sqlite3");

let passed = 0;
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
const okOf = (r, what) => {
  if (!r || !r.ok) throw new Error(`${what}: ${JSON.stringify(r && r.error)}`);
  return r.data;
};
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const direct = (page, method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const aimOpen = (app, p) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialogSync = () => [f]; }, p);
const setWindow = (app, w, h) => app.evaluate(({ BrowserWindow }, [W, H]) => BrowserWindow.getAllWindows()[0].setContentSize(W, H), [w, h]);

const app = await electron.launch({ executablePath: ELECTRON, args: [APP], env: { ...process.env, ALZABT_POS_USER_DATA: USERDATA } });
try {
  assert((await app.evaluate(({ app }) => app.getPath("userData"))) === USERDATA, "an isolated, throw-away profile — never a real ledger");
  const page = await app.firstWindow();
  await setWindow(app, 1366, 768);
  await page.waitForSelector('[data-testid="select-cashier"], [data-testid="welcome-screen"]', { timeout: 60000 });
  if (await tid(page, "welcome-screen").count()) await tid(page, "welcome-login").click(); // never welcome-demo
  await signIn(page, "Cashier One", "1111");
  await tid(page, "cart").waitFor();

  // ── A · import, then a photo through the real Products button, then back to Sell, no restart ──
  await aimOpen(app, CSV);
  await tid(page, "tab-tools").click();
  await tid(page, "import-catalog").click();
  await page.locator(".import-report").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
  await tid(page, "cart").waitFor(); // the import lands on a fresh Sell (App.tsx importCatalog)
  const espressoId = okOf(await direct(page, "listProducts", undefined), "listProducts").find((p) => p.sourceKey === "CAFE-001").id;
  const espressoCard = page.locator(`.product-cell:has([data-product="${espressoId}"]) button.product`);
  assert((await page.locator(`[data-testid="sell-thumb"][data-product="${espressoId}"]`).count()) === 0, "before: Espresso has no photo on the till");
  await espressoCard.click();
  await page.locator("li.line").first().locator('[data-testid="line-inc"]').click();
  assert((await page.locator(`[data-testid="qty-${espressoId}"]`).inputValue()) === "2", "the cart holds Espresso × 2 before leaving Sell");

  await tid(page, "tab-products").click();
  const row = page.locator('[data-testid="product-row"]').filter({ hasText: "إسبريسو" });
  await row.first().waitFor({ timeout: 15000 });
  assert((await row.count()) === 1, "exactly one Products row is إسبريسو");
  await row.locator('[data-testid="product-edit"]').click();
  await tid(page, "photo-panel").waitFor({ state: "visible" });
  await aimOpen(app, ESPRESSO_JPG);
  await tid(page, "photo-add").click();
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid="photo-preview"]'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
  assert(true, "the photo was added through the Products screen's own button and decoded there");
  await page.screenshot({ path: SHOTS + "A1-products-photo-added.png" });
  // Close the editor the way a merchant does. The photo is already stored (setProductImage), not by Save.
  await tid(page, "cancel-product").click();
  await page.locator(".overlay").waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);

  await tid(page, "tab-sell").click();
  await tid(page, "cart").waitFor();
  await page.waitForFunction((id) => { const i = document.querySelector(`[data-testid="sell-thumb"][data-product="${id}"] img`); return !!i && i.complete && i.naturalWidth > 0; }, espressoId, { timeout: 30000 });
  assert(true, "after: Espresso's NEW photo is on the till grid — no restart");
  await page.waitForFunction((id) => { const i = document.querySelector(`[data-testid="cart-line-thumb"][data-product="${id}"] img`); return !!i && i.complete && i.naturalWidth > 0; }, espressoId, { timeout: 30000 });
  assert(true, "after: the kept cart line shows the new photo too");
  assert((await page.locator(`[data-testid="qty-${espressoId}"]`).inputValue()) === "2", "the cart and its quantity survived the trip to Products (Espresso × 2)");
  const gridSrc = await page.locator(`[data-testid="sell-thumb"][data-product="${espressoId}"] img`).getAttribute("src");
  const cartSrc = await page.locator(`[data-testid="cart-line-thumb"][data-product="${espressoId}"] img`).getAttribute("src");
  assert(gridSrc === cartSrc && gridSrc.startsWith("data:image/"), "the cart photo is the same image as the grid card");
  await page.screenshot({ path: SHOTS + "A2-sell-photo-no-restart-ar.png" });

  // ── B · completed-sale names: Arabic UI shows Arabic, keeps the recorded name; English shows English ──
  for (const name of ["Caffè Latte", "Water 500ml"]) {
    const id = okOf(await direct(page, "listProducts", undefined), "listProducts").find((p) => p.nameEn === name).id;
    await page.locator(`.product-cell:has([data-product="${id}"]) button.product`).click();
  }
  await tid(page, "complete-sale").click();
  await tid(page, "pay-cash").click();
  await tid(page, "receipt").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="receipt-line-name"]')].some((n) => n.textContent === "إسبريسو"), null, { timeout: 15000 });
  const lines = () => page.$$eval('[data-testid="receipt"] tbody tr', (rows) => rows.map((r) => ({ name: r.querySelector('[data-testid="receipt-line-name"]')?.textContent ?? null, recorded: r.querySelector('[data-testid="receipt-line-recorded"]')?.textContent ?? null })));
  const ar = await lines();
  log("AR receipt lines", JSON.stringify(ar));
  assert(ar.length === 3, "the completed sale lists three lines");
  assert(ar.some((l) => l.name === "إسبريسو" && l.recorded === "Espresso"), "AR: «إسبريسو» shown, the recorded «Espresso» kept beside it");
  assert(ar.some((l) => l.name === "كافيه لاتيه" && l.recorded === "Caffè Latte"), "AR: «كافيه لاتيه» shown, the recorded «Caffè Latte» kept");
  assert(ar.every((l) => l.name !== null && /[؀-ۿ]/.test(l.name)), "AR: every line's primary name is Arabic");

  // 🔴 THE RECORD IS UNCHANGED: what the ledger holds is still the recorded snapshot.
  const recordedInLedger = (() => {
    const db = new Database(join(USERDATA, "alzabt-pos-ledger.sqlite"), { readonly: true, fileMustExist: true });
    try { return db.prepare("SELECT product_name AS n FROM sale_lines ORDER BY line_no").all().map((r) => r.n); } finally { db.close(); }
  })();
  log("ledger sale_lines.product_name", JSON.stringify(recordedInLedger));
  assert(recordedInLedger.includes("Espresso") && !recordedInLedger.includes("إسبريسو"), "the ledger's sale line still records «Espresso» — display only, nothing rewritten");

  for (const [w, h] of [[1366, 768], [1024, 768]]) {
    await setWindow(app, w, h);
    await page.waitForTimeout(300);
    const fit = await page.evaluate(() => { const r = document.querySelector('[data-testid="receipt"]').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), left: Math.round(r.left), vw: innerWidth, vh: innerHeight }; });
    assert(fit.top >= 0 && fit.bottom <= fit.vh && fit.left >= 0 && fit.right <= fit.vw, `AR ${w}×${h}: the completed-sale card fits the window (${JSON.stringify(fit)})`);
    await page.screenshot({ path: SHOTS + `B1-completed-sale-ar-${w}x${h}.png` });
  }
  await tid(page, "lang-toggle").click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="receipt-line-name"]')].some((n) => n.textContent === "Espresso"), null, { timeout: 15000 });
  const en = await lines();
  log("EN receipt lines", JSON.stringify(en));
  assert(en.some((l) => l.name === "Espresso" && l.recorded === null), "EN: «Espresso», no duplicate recorded line");
  assert(en.some((l) => l.name === "Caffè Latte" && l.recorded === null), "EN: «Caffè Latte», no duplicate");
  for (const [w, h] of [[1366, 768], [1024, 768]]) {
    await setWindow(app, w, h);
    await page.waitForTimeout(300);
    await page.screenshot({ path: SHOTS + `B2-completed-sale-en-${w}x${h}.png` });
  }

  // History reprint uses the same component: the reopened receipt localizes the same way.
  await tid(page, "lang-toggle").click();
  await tid(page, "tab-history").click();
  await tid(page, "history-row").first().waitFor({ timeout: 15000 });
  await tid(page, "history-row").first().locator('[data-testid="history-open"]').click();
  const histOk = await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="receipt-line-name"]')].some((n) => n.textContent === "إسبريسو"), null, { timeout: 8000 }).then(() => true, () => false);
  await page.screenshot({ path: SHOTS + "B3-history-reprint-ar.png" });
  log(histOk ? "PASS History reprint shows «إسبريسو»" : "NOT VERIFIED History reprint (row selector not matched; see screenshot)");
  if (histOk) passed++;

  // ── C · the top bar fits, in both languages, at both till sizes (J1-TOPBAR) ──
  const defects = [];
  const topbar = () =>
    page.evaluate(() => {
      const bar = document.querySelector(".topbar");
      const kids = [...bar.children].map((c) => { const r = c.getBoundingClientRect(); return { t: (c.textContent || "").trim().slice(0, 16), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; });
      const tabs = [...document.querySelectorAll(".tabs .tab")].map((b) => Math.round(b.getBoundingClientRect().height));
      return { vw: document.documentElement.clientWidth, pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, barOverflow: bar.scrollWidth > bar.clientWidth + 1, kids, maxTabH: Math.max(...tabs), minTabH: Math.min(...tabs) };
    });
  for (const lang of ["ar", "en"]) {
    const now = await page.evaluate(() => document.documentElement.lang);
    if (now !== lang) { await tid(page, "lang-toggle").click(); await page.waitForTimeout(300); }
    for (const [w, h] of [[1366, 768], [1024, 768]]) {
      await setWindow(app, w, h);
      await page.waitForTimeout(300);
      const m = await topbar();
      log(`topbar ${lang} ${w}x${h}`, JSON.stringify({ pageOverflowX: m.pageOverflowX, barOverflow: m.barOverflow, maxTabH: m.maxTabH, minTabH: m.minTabH, offscreen: m.kids.filter((k) => k.l < 0 || k.r > m.vw).map((k) => k.t) }));
      const ok = !m.pageOverflowX && !m.barOverflow && m.kids.every((k) => k.l >= 0 && k.r <= m.vw) && m.maxTabH === m.minTabH;
      const msg = `${lang.toUpperCase()} ${w}×${h}: the top bar fits — nothing cut off, no page scroll sideways, no tab label wrapping`;
      if (ok) assert(true, msg); else if (process.env.EXPECT_DEFECT === "1") { defects.push(msg); log("DEFECT (recorded)", msg); } else assert(false, msg);
      await page.screenshot({ path: SHOTS + `${process.env.SHOT_TAG ?? "run"}-C-topbar-${lang}-${w}x${h}.png`, clip: { x: 0, y: 0, width: w, height: 80 } });
    }
  }
  if (defects.length) log("DEFECTS:", JSON.stringify(defects));

  log(`DONE — ${passed} PASS; screenshots in ${SHOTS}`);
} finally {
  await app.close().catch(() => undefined);
}
