// J1-CART-THUMBS (owner, 2026-11-19): the Current Sale lines show each product's photo.
//
// Real app, NORMAL mode, on a throw-away profile: ALZABT_POS_USER_DATA is always a new temp folder.
// It never enters the Demo (it never touches welcome-demo), so it uses no alzabt-test account and
// consumes no Demo slot. It never reads a real shop's ledger.
//
//   node e2e/sell-cart-thumbs.mjs            (after `npm run build`)
//   SHOT_TAG=before|after                    names the screenshots, for a before/after pair
//
// What it checks, through the real renderer:
//   1. three photographed products + one without a photo go into the cart;
//   2. each photographed line shows ITS OWN photo (the same data: URL as its grid card), decoded;
//   3. the photo-less line shows the placeholder, never a broken image;
//   4. a search that hides every cart product from the grid keeps the cart photos;
//   5. a quantity change keeps them; the cart total is unchanged by any of this;
//   6. the same holds after switching to English (LTR), and the thumb sits at the inline start.
// Exit 0 = all PASS; exit 1 = an assertion failed (the message says which).
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = require("electron");
const TAG = process.env.SHOT_TAG ?? "run";
const SHOTS = join(APP, "e2e-output", "cart-thumbs") + "/";
mkdirSync(SHOTS, { recursive: true });
const CAT = join(APP, "tests", "fixtures", "demo-catalog");
const CSV = join(CAT, "alzabt-demo-catalog-import.csv");
const IMAGES = join(CAT, "images");
const DEF = JSON.parse(readFileSync(join(CAT, "catalog.json"), "utf8"));
const home = mkdtempSync(join(tmpdir(), "pos-e2e-cartthumbs-"));
const USERDATA = join(home, "userData");

let passed = 0;
let expectFail = process.env.EXPECT_DEFECT === "1"; // "before": record, do not throw, on the cart checks
const defects = [];
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
const cartCheck = (cond, msg) => {
  if (cond) return assert(true, msg);
  if (!expectFail) return assert(false, msg);
  defects.push(msg);
  log("DEFECT (expected on the old renderer)", msg);
};
const okOf = (r, what) => {
  if (!r || !r.ok) throw new Error(`${what}: ${JSON.stringify(r && r.error)}`);
  return r.data;
};
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const direct = (page, method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const aimOpen = (app, p) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialogSync = () => [f]; }, p);

async function launch() {
  const a = await electron.launch({ executablePath: ELECTRON, args: [APP], env: { ...process.env, ALZABT_POS_USER_DATA: USERDATA } });
  assert((await a.evaluate(({ app }) => app.getPath("userData"))) === USERDATA, "an isolated, throw-away profile — never a real ledger");
  const p = await a.firstWindow();
  await p.waitForSelector('[data-testid="select-cashier"], [data-testid="welcome-screen"]', { timeout: 60000 });
  if (await tid(p, "welcome-screen").count()) {
    // The login path only. welcome-demo is NEVER pressed here.
    await p.screenshot({ path: SHOTS + `${TAG}-0-welcome-normal.png` });
    await tid(p, "welcome-login").click();
  }
  await signIn(p, "Cashier One", "1111");
  await tid(p, "cart").waitFor();
  return { a, p };
}
let { a: app, p: page } = await launch();
try {
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.type() + ": " + m.text().slice(0, 200)));
  page.on("pageerror", (e) => consoleLines.push("pageerror: " + String(e).slice(0, 200)));

  // Load the fixture catalogue through the merchant's import, then photos for three products.
  await aimOpen(app, CSV);
  await tid(page, "tab-tools").click();
  await tid(page, "import-catalog").click();
  await page.locator(".import-report").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /^(حسناً|OK)$/ }).click();
  const listed = okOf(await direct(page, "listProducts", undefined), "listProducts");
  const bySource = Object.fromEntries(listed.map((p) => [p.sourceKey, p]));
  const pick = DEF.products.filter((p) => p.active && existsSync(join(IMAGES, `${p.sku}.jpg`))).slice(0, 3);
  const noPhoto = DEF.products.find((p) => p.active && !pick.includes(p) && bySource[p.source_id]);
  for (const p of pick) {
    await aimOpen(app, join(IMAGES, `${p.sku}.jpg`));
    okOf(await direct(page, "setProductImage", { productId: bySource[p.source_id].id }), `setProductImage ${p.sku}`);
  }
  const ids = pick.map((p) => bySource[p.source_id].id);
  const noPhotoId = bySource[noPhoto.source_id].id;

  // Relaunch, as the J1 Demo starts with its photos already seeded. (Within one session the Sell
  // screen is not remounted by setProductImage; see the report, finding F-PHOTO-STALE.)
  await app.close();
  ({ a: app, p: page } = await launch());
  page.on("console", (m) => consoleLines.push(m.type() + ": " + m.text().slice(0, 200)));
  await page
    .waitForFunction((n) => document.querySelectorAll('[data-testid="sell-thumb-image"]').length >= n, 3, { timeout: 30000 })
    .catch(async (e) => {
      await page.screenshot({ path: SHOTS + `${TAG}-FAIL-grid.png` });
      log("grid diag", JSON.stringify(await page.evaluate(() => ({ img: document.querySelectorAll('[data-testid="sell-thumb-image"]').length, empty: document.querySelectorAll('[data-testid="sell-thumb-empty"]').length, cards: document.querySelectorAll("button.product").length }))));
      const lp = await direct(page, "listProducts", undefined);
      const ph = lp.ok ? lp.data.filter((p) => p.hasImage) : [];
      log("listProducts", lp.ok, "withImage", ph.length);
      log("row0", JSON.stringify(ph[0]));
      if (ph[0]) { const r = await direct(page, "getProductImageBytes", { imageId: ph[0].primaryImageId }); log("bytes", JSON.stringify({ ok: r.ok, err: r.error ?? null, n: r.ok ? (r.data.bytes.length ?? r.data.bytes.byteLength) : 0 })); }
      log("decode", await page.evaluate(async (id) => { const r = await window.pos.getProductImageBytes({ imageId: id }); const b = new Uint8Array(r.data.bytes); let bin = ""; for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192)); const url = `data:${r.data.meta.mime};base64,${btoa(bin)}`; const img = new Image(); img.src = url; try { await img.decode(); return "ok " + img.naturalWidth + " mime=" + r.data.meta.mime + " type=" + Object.prototype.toString.call(r.data.bytes); } catch (x) { return "decode-fail " + String(x) + " mime=" + r.data.meta.mime; } }, ph[0].primaryImageId));
      log("console", JSON.stringify(consoleLines.slice(-15)));
      throw e;
    });

  const addById = async (id) => page.locator(`.product-cell:has([data-product="${id}"]) button.product`).first().click();
  for (const id of [...ids, noPhotoId]) await addById(id);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cart-line-name"]').length === 4, null, { timeout: 10000 });
  const totalBefore = await page.locator(".total").first().innerText();

  const cartState = () =>
    page.evaluate(() => {
      const grid = Object.fromEntries(
        [...document.querySelectorAll('[data-testid="sell-thumb"][data-product]')].map((b) => [b.getAttribute("data-product"), b.querySelector("img")?.getAttribute("src") ?? null]),
      );
      const ready = [...document.querySelectorAll('[data-testid="cart-line-thumb"]')].map((s) => {
        const img = s.querySelector("img");
        return { id: s.getAttribute("data-product"), src: img?.getAttribute("src") ?? "", decoded: !!img && img.complete && img.naturalWidth > 0, rect: s.getBoundingClientRect().toJSON(), line: s.closest("li").getBoundingClientRect().toJSON() };
      });
      const empty = [...document.querySelectorAll('[data-testid="cart-line-thumb-empty"]')].map((s) => s.getAttribute("data-product"));
      return { grid, ready, empty, dir: document.documentElement.dir || getComputedStyle(document.body).direction };
    });
  const waitCartThumbs = (n) => page.waitForFunction((k) => [...document.querySelectorAll('[data-testid="cart-line-thumb"] img')].filter((i) => i.complete && i.naturalWidth > 0).length >= k, n, { timeout: 15000 }).catch(() => undefined);

  const verify = async (label, gridHasCart) => {
    await waitCartThumbs(3);
    const s = await cartState();
    cartCheck(s.ready.length === 3, `${label}: the three photographed cart lines show a photo (got ${s.ready.length})`);
    cartCheck(s.ready.length > 0 && s.ready.every((r) => r.decoded), `${label}: every cart photo decoded (no broken image)`);
    cartCheck(ids.every((id) => s.ready.some((r) => r.id === id)), `${label}: each photo is on ITS OWN product's line`);
    if (gridHasCart) cartCheck(s.ready.length > 0 && s.ready.every((r) => s.grid[r.id] === r.src), `${label}: each cart photo is the same image as its grid card`);
    cartCheck(s.empty.length === 1 && s.empty[0] === noPhotoId, `${label}: the photo-less product shows the placeholder, only that one`);
    // J1-PHASE5 U-2: below 900 px of window height the compact cart uses a 40 px photo (styles.css). The size is still
    // FIXED and SQUARE, and it is read from the same media query the stylesheet uses, never loosened to a range.
    const side = (await page.evaluate(() => matchMedia("(max-height: 900px)").matches)) ? 40 : 48;
    cartCheck(s.ready.length > 0 && s.ready.every((r) => Math.round(r.rect.width) === side && Math.round(r.rect.height) === side), `${label}: every cart photo is the fixed ${side}×${side} square`);
    return s;
  };

  // Arabic / RTL (the terminal default).
  let s = await verify("AR", true);
  if (s.ready.length) assert(s.ready.every((r) => r.rect.right > r.line.right - 60), "AR/RTL: the photo sits at the inline START (right edge)");
  await page.screenshot({ path: SHOTS + `${TAG}-1-cart-ar.png` });

  // J1-CART-FOOT: the total and «إتمام البيع» stay on screen as the cart grows; the LINES scroll.
  const footState = () =>
    page.evaluate(() => {
      const btn = document.querySelector('[data-testid="complete-sale"]').getBoundingClientRect();
      const total = document.querySelector('[data-testid="cart-total"]').getBoundingClientRect();
      const content = document.querySelector(".content");
      const lines = document.querySelector("ul.lines");
      return { vh: window.innerHeight, btnBottom: Math.round(btn.bottom), totalBottom: Math.round(total.bottom), pageScrolls: content.scrollHeight > content.clientHeight + 1, linesScroll: !!lines && lines.scrollHeight > lines.clientHeight + 1 };
    });
  const setWindow = (w, h) => app.evaluate(({ BrowserWindow }, [W, H]) => BrowserWindow.getAllWindows()[0].setContentSize(W, H), [w, h]);
  const extra = DEF.products.filter((p) => p.active && bySource[p.source_id] && !pick.includes(p) && p !== noPhoto).slice(0, 3);
  for (const p of extra) await addById(bySource[p.source_id].id);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cart-line-name"]').length === 7, null, { timeout: 10000 });
  for (const [w, h] of [[1366, 768], [1024, 768]]) {
    await setWindow(w, h);
    await page.waitForTimeout(400);
    const f = await footState();
    log(`foot ${w}x${h}`, JSON.stringify(f));
    cartCheck(f.btnBottom <= f.vh && f.totalBottom <= f.vh, `${w}×${h}, 7 lines: the total and Complete Sale are on screen (button bottom ${f.btnBottom} ≤ ${f.vh})`);
    cartCheck(!f.pageScrolls, `${w}×${h}, 7 lines: the page itself does not scroll; the cart lines do (lines scroll: ${f.linesScroll})`);
    await page.screenshot({ path: SHOTS + `${TAG}-1b-cart-ar-7-lines-${w}x${h}.png` });
  }
  await setWindow(1264, 740);
  for (let k = 0; k < extra.length; k++) await page.locator('li.line').last().locator('[data-testid="line-remove-btn"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cart-line-name"]').length === 4, null, { timeout: 10000 });

  // A search that hides every cart product from the grid.
  await tid(page, "product-search").fill("zzzz-no-match");
  await page.waitForTimeout(400);
  await verify("AR search hides grid", false);
  await page.screenshot({ path: SHOTS + `${TAG}-2-cart-ar-search-hidden.png` });
  await tid(page, "product-search").fill("");

  // Quantity change through the line's own + button.
  await page.locator("li.line").first().locator('[data-testid="line-inc"]').click();
  await page.waitForTimeout(300);
  await verify("AR after quantity change", true);
  const totalAfterQty = await page.locator(".total").first().innerText();
  assert(totalAfterQty !== totalBefore, "the quantity change still reprices the cart (cart math untouched, and alive)");

  // English / LTR.
  await tid(page, "lang-toggle").click();
  await page.waitForTimeout(400);
  s = await verify("EN", true);
  if (s.ready.length) assert(s.ready.every((r) => r.rect.left < r.line.left + 60), "EN/LTR: the photo sits at the inline START (left edge)");
  await page.screenshot({ path: SHOTS + `${TAG}-3-cart-en.png` });
  await tid(page, "lang-toggle").click();

  // J1 sale completion, as the customer sees it (normal mode; the Demo shell differs only by its banner).
  await setWindow(1366, 768);
  await page.waitForTimeout(300);
  await tid(page, "complete-sale").click();
  await tid(page, "pay-cash").waitFor();
  const dlg = await page.evaluate(() => { const r = document.querySelector(".overlay .dialog").getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }; });
  assert(dlg.top >= 0 && dlg.bottom <= dlg.vh, `the payment dialog fits the 1366×768 window (${JSON.stringify(dlg)})`);
  await page.screenshot({ path: SHOTS + `${TAG}-4-pay-ar.png` });
  await tid(page, "pay-cash").click();
  await tid(page, "receipt").waitFor({ timeout: 30000 });
  const rc = await page.evaluate(() => { const r = document.querySelector('[data-testid="receipt"]').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, lines: document.querySelectorAll('[data-testid="cart-line-name"]').length }; });
  log("receipt rect", JSON.stringify(rc));
  await page.screenshot({ path: SHOTS + `${TAG}-5-receipt-ar.png` });
  await tid(page, "lang-toggle").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + `${TAG}-6-receipt-en.png` });
  await tid(page, "lang-toggle").click();

  log(`DONE — ${passed} PASS; ${defects.length} expected defect(s) recorded; screenshots in ${SHOTS}`);
  if (defects.length) log("DEFECTS:", JSON.stringify(defects, null, 1));
} finally {
  await app.close().catch(() => undefined);
}
