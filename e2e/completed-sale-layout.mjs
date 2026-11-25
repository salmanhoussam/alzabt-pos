// J1 phase 3 (owner Windows run, 2026-11-20): "the completed-sale screen shows a large empty region and
// excessive vertical scrolling". This script MEASURES that screen; it does not assume the defect.
//
// Real app, NORMAL mode, throw-away profile (ALZABT_POS_USER_DATA = new temp folder). It never presses
// welcome-demo, uses no alzabt-test account, consumes no Demo slot and never reads a real ledger.
// It never presses a print or PDF button (no printer, no file written).
//
// The owner's sale had 8 lines. The Demo banner sits under the top bar in the Demo (owner capture 04); normal mode has
// none, so a SIMULATED banner (same classes, same two small buttons) is injected for the second pass and
// labelled as simulated in every result line.
//
//   node e2e/completed-sale-layout.mjs        (after `npm run build`)
//   SHOT_TAG=before|after                     names the screenshots
//   EXPECT_DEFECT=1                           record layout failures instead of throwing (the "before" run)
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
const TAG = process.env.SHOT_TAG ?? "run";
const SHOTS = join(APP, "e2e-output", "completed-sale") + "/";
mkdirSync(SHOTS, { recursive: true });
const CSV = join(APP, "tests", "fixtures", "demo-catalog", "alzabt-demo-catalog-import.csv");
const USERDATA = join(mkdtempSync(join(tmpdir(), "pos-e2e-completed-")), "userData");
const EXPECT = process.env.EXPECT_DEFECT === "1";

let passed = 0;
const defects = [];
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
const layoutCheck = (cond, msg) => {
  if (cond || !EXPECT) return assert(cond, msg);
  defects.push(msg);
  log("DEFECT (recorded)", msg);
};
const okOf = (r, what) => {
  if (!r || !r.ok) throw new Error(`${what}: ${JSON.stringify(r && r.error)}`);
  return r.data;
};
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const direct = (page, method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const aimOpen = (app, p) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialogSync = () => [f]; }, p);
const setWindow = (app, w, h) => app.evaluate(({ BrowserWindow }, [W, H]) => BrowserWindow.getAllWindows()[0].setContentSize(W, H), [w, h]);

const measure = (page) =>
  page.evaluate(() => {
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const content = document.querySelector("main.content");
    const card = r(document.querySelector('[data-testid="receipt"]'));
    const total = r(document.querySelector(".receipt-total"));
    const print80 = r(document.querySelector('[data-testid="receipt-print-80"]'));
    const newSale = r(document.querySelector('[data-testid="new-sale"]'));
    const c = r(content);
    const rows = document.querySelectorAll('[data-testid="receipt"] tbody tr').length;
    return {
      vw: innerWidth,
      vh: innerHeight,
      rows,
      contentTop: Math.round(c.top),
      contentH: Math.round(c.height),
      scrollH: content.scrollHeight,
      overflowY: content.scrollHeight - content.clientHeight,
      pageScrollX: document.documentElement.scrollWidth - innerWidth,
      card: { top: Math.round(card.top), bottom: Math.round(card.bottom), left: Math.round(card.left), right: Math.round(card.right), h: Math.round(card.height), w: Math.round(card.width) },
      gapAbove: Math.round(card.top - c.top),
      gapBelow: Math.round(c.bottom - card.bottom),
      totalBottom: Math.round(total.bottom),
      print80Bottom: Math.round(print80.bottom),
      newSaleBottom: Math.round(newSale.bottom),
      viewportBottom: Math.round(c.bottom),
    };
  });

const injectBanner = (page) =>
  page.evaluate(() => {
    const app = document.querySelector(".app");
    const b = document.createElement("div");
    b.className = "demo-banner demo-mode-banner";
    b.id = "simulated-demo-banner";
    b.innerHTML = '<strong>وضع التجربة — بيانات تجريبية</strong><span class="demo-hint">الطباعة معاينة فقط</span><span class="demo-actions"><button class="btn small">ابدأ من جديد</button><button class="btn small">خروج</button></span>';
    app.insertBefore(b, document.querySelector("main.content")); // the real Demo puts it under the top bar (owner capture 04)
    return Math.round(b.getBoundingClientRect().height);
  });

const app = await electron.launch({ executablePath: ELECTRON, args: [APP], env: { ...process.env, ALZABT_POS_USER_DATA: USERDATA } });
try {
  assert((await app.evaluate(({ app }) => app.getPath("userData"))) === USERDATA, "an isolated, throw-away profile — never a real ledger");
  const page = await app.firstWindow();
  await setWindow(app, 1366, 768);
  await page.waitForSelector('[data-testid="select-cashier"], [data-testid="welcome-screen"]', { timeout: 60000 });
  if (await tid(page, "welcome-screen").count()) await tid(page, "welcome-login").click(); // never welcome-demo
  await signIn(page, "Cashier One", "1111");
  await tid(page, "cart").waitFor();

  await aimOpen(app, CSV);
  await tid(page, "tab-tools").click();
  await tid(page, "import-catalog").click();
  await page.locator(".import-report").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
  await tid(page, "cart").waitFor();

  // Eight distinct products, as in the owner's run.
  const listed = okOf(await direct(page, "listProducts", undefined), "listProducts").filter((p) => p.active !== false);
  const eight = listed.slice(0, 8);
  for (const p of eight) await page.locator(`.product-cell:has([data-product="${p.id}"]) button.product`).first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cart-line-name"]').length === 8, null, { timeout: 15000 });
  await tid(page, "complete-sale").click();
  await tid(page, "pay-cash").click();
  await tid(page, "receipt").waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);

  const results = [];
  for (const banner of [false, true]) {
    if (banner) log("simulated Demo banner height", await injectBanner(page), "px");
    for (const [w, h] of [[1366, 768], [1024, 768], [1920, 1080]]) {
      await setWindow(app, w, h);
      await page.waitForTimeout(300);
      await page.locator("main.content").evaluate((el) => el.scrollTo(0, 0));
      const m = await measure(page);
      const label = `${banner ? "banner(sim)" : "no-banner"} ${w}×${h}`;
      results.push({ label, ...m });
      log(label, JSON.stringify(m));
      await page.screenshot({ path: SHOTS + `${TAG}-${banner ? "banner" : "plain"}-${w}x${h}.png` });
      assert(m.rows === 8, `${label}: the completed sale lists all 8 lines`);
      assert(m.pageScrollX <= 0, `${label}: no sideways page scroll`);
      // What a cashier needs without scrolling: the total and the print row; New Sale should also be reachable.
      layoutCheck(m.totalBottom <= m.viewportBottom, `${label}: the total is visible without scrolling (total ${m.totalBottom} ≤ ${m.viewportBottom})`);
      layoutCheck(m.print80Bottom <= m.viewportBottom, `${label}: the print buttons are visible without scrolling (${m.print80Bottom} ≤ ${m.viewportBottom})`);
      layoutCheck(m.newSaleBottom <= m.viewportBottom, `${label}: «بيع جديد» is visible without scrolling (${m.newSaleBottom} ≤ ${m.viewportBottom})`);
      // An empty band above the card while the content still scrolls = wasted height.
      layoutCheck(!(m.overflowY > 0 && m.gapAbove > 48), `${label}: no wasted gap above the card while the screen scrolls (gapAbove ${m.gapAbove}, overflow ${m.overflowY})`);
    }
  }
  // The lines still reach their end: scroll the lines region, the last row and the total are both visible.
  await setWindow(app, 1366, 768);
  await page.waitForTimeout(300);
  const reach = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="receipt-lines"]');
    box.scrollTop = box.scrollHeight;
    const b = box.getBoundingClientRect();
    const rows = box.querySelectorAll("tbody tr");
    const last = rows[rows.length - 1].getBoundingClientRect();
    const total = document.querySelector(".receipt-total").getBoundingClientRect();
    return { scrolls: box.scrollHeight > box.clientHeight, lastTop: Math.round(last.top), lastBottom: Math.round(last.bottom), totalTop: Math.round(total.top), boxTop: Math.round(b.top), boxBottom: Math.round(b.bottom) };
  });
  log("lines scrolled to end", JSON.stringify(reach));
  assert(reach.scrolls, "banner(sim) 1366×768: the 8 lines scroll INSIDE the card");
  assert(reach.lastTop >= reach.boxTop && reach.lastBottom <= reach.totalTop + 1, "the last line is reachable and sits above the sticky total, not under it");
  assert(reach.totalTop >= reach.boxTop && reach.totalTop < reach.boxBottom, "the total stays visible while the lines are scrolled");
  await page.screenshot({ path: SHOTS + `${TAG}-banner-1366x768-scrolled.png` });
  await page.evaluate(() => document.getElementById("simulated-demo-banner")?.remove());

  // History's reprint has no «new sale» and keeps its ordinary flow.
  await tid(page, "new-sale").click();
  await tid(page, "tab-history").click();
  await tid(page, "history-open").first().click();
  await tid(page, "receipt").waitFor({ timeout: 15000 });
  // J1-PHASE5 U-3 reversed the phase-3 decision on purpose: the reprint is now fitted too (UX-SCALING found its total
  // and print row 438–1,081 px below the fold). Its own geometry is asserted in claude-ux-scaling/phase5-focused.mjs.
  assert((await tid(page, "receipt-screen").getAttribute("data-fit")) === "1", "History reprint: fit mode (U-3)");
  assert((await tid(page, "new-sale").count()) === 0, "History reprint: no «new sale» button");
  await page.screenshot({ path: SHOTS + `${TAG}-history-reprint-1366x768.png` });
  console.log("RESULTS " + JSON.stringify(results));
  console.log(`\n${passed} PASS · ${defects.length} DEFECT${defects.length ? "\n  - " + defects.join("\n  - ") : ""}`);
} finally {
  await app.close();
}
process.exit(defects.length && !EXPECT ? 1 : 0);
