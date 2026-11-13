// PHOTO-INVOICE-TO-ITEMS — the full workflow in the real app: Photo → OFFLINE OCR → Review → Confirm →
// catalog write, then the SAME photo again cannot duplicate the product.
//   PHOTO_INVOICE=<image>   default: the SYNTHETIC invoice of the OCR spike (outside this repository).
//   E2E_SHOTS=<dir>         where screenshots go (a REAL supplier photo must never land in the repo).
// 🔴 No real supplier image or text is part of this repository: the photo is a path given at run time.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = process.env.E2E_EXECUTABLE ?? createRequire(import.meta.url)("electron");
const APP_ARGS = process.env.E2E_EXECUTABLE ? [] : [APP];
const PHOTO = process.env.PHOTO_INVOICE ?? "C:/dev/alzabt-pos-ocr/spikes/ocr/invoices/A-clean.png";
const SHOTS = (process.env.E2E_SHOTS ?? join(APP, "e2e-output")) + "/";
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(PHOTO)) throw new Error(`photo not found: ${PHOTO}`);
const Database = createRequire(import.meta.url)("better-sqlite3");
const home = mkdtempSync(join(tmpdir(), "pos-e2e-photo-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1" };
delete env.ELECTRON_RUN_AS_NODE;

let passed = 0;
const assert = (c, m) => {
  if (!c) throw new Error("ASSERTION FAILED: " + m);
  passed += 1;
  console.log("• PASS", m);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const q = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return db.prepare(sql).all(...p);
  } finally {
    db.close();
  }
};
const SALE = "9.75";

async function readAndReview(page, app) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => [p];
  }, PHOTO);
  await testid(page, "tab-products").click();
  await testid(page, "photo-invoice").click();
  await testid(page, "photo-flow").waitFor({ timeout: 15000 });
  const t0 = Date.now();
  await testid(page, "photo-flow-pick").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="photo-review"]') || document.querySelector('[data-testid="photo-flow"]')?.textContent?.includes("لم يُقرأ"), undefined, { timeout: 120000 });
  return Date.now() - t0;
}

const productsBefore = () => q("SELECT count(*) AS n FROM catalog_products")[0].n;
const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");
  // Two EXISTING products, so "the catalog stays intact" is checked against real rows, not an empty table.
  const seeded = await page.evaluate(async () => {
    const mk = async (nameAr, price) => (await window.pos.createProduct({ draft: { nameAr, nameEn: null, sku: null, price, baseUnit: "piece" } })).ok;
    return [await mk("صنف قائم أ", "3.50"), await mk("صنف قائم ب", "7.25")];
  });
  assert(seeded.every(Boolean), "two existing products seeded");

  // ── FAILURE FIRST: a file that is not an image → an on-screen refusal, NO main-process error box,
  //    the POS stays alive, retry and manual entry are offered, nothing is written ──────────────────
  const notImage = join(home, "not-an-image.jpg");
  writeFileSync(notImage, "this is not an image");
  const productsAtStart = Number(productsBefore());
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialogSync = () => [p];
  }, notImage);
  await testid(page, "tab-products").click();
  await testid(page, "photo-invoice").click();
  await testid(page, "photo-flow-pick").click();
  await testid(page, "photo-flow-error").waitFor({ timeout: 30000 });
  const failText = (await testid(page, "photo-flow-error").innerText()).trim();
  assert(failText.includes("ليس صورة"), `🔴 a non-image is refused ON SCREEN in Arabic («${failText}»)`);
  // OCR-REVIEW-UX #7: the same refusal in English on its OWN line — never one mixed sentence.
  const failLines = await testid(page, "photo-flow-error").locator("p").allInnerTexts();
  assert(failLines.length === 2 && /[\u0600-\u06FF]/.test(failLines[0]) && !/[A-Za-z]{3,}/.test(failLines[0].replace(/\b(JPG|PNG)\b/g, "")) && failLines[1].includes("not a readable image"), `🔴 two lines: Arabic, then English (${JSON.stringify(failLines)})`);
  assert((await testid(page, "photo-flow-pick").innerText()).includes("إعادة المحاولة"), "retry is offered");
  assert(await page.evaluate(() => typeof window.pos.getSettings === "function"), "the POS is still alive (renderer + bridge)");
  assert(Number(productsBefore()) === productsAtStart, "nothing was written");
  await page.screenshot({ path: SHOTS + "PHOTO-failure.png" });
  await testid(page, "photo-flow-manual").click();
  await testid(page, "save-product").waitFor({ timeout: 10000 });
  assert((await testid(page, "photo-flow").count()) === 0, "«إدخال يدوي» closes the reader and opens the manual add form");
  await testid(page, "cancel-product").click();
  await testid(page, "save-product").waitFor({ state: "detached", timeout: 10000 });

  const ms = await readAndReview(page, app);
  const rows = await testid(page, "photo-review-row").count();
  console.log(`• read in ${ms} ms · ${rows} candidate rows`);
  assert(rows > 0, `the photo produced candidate rows (${rows})`);
  assert((await page.locator('[data-testid="photo-review-row"][data-decision="pending"]').count()) === rows, "🔴 every row starts PENDING");
  assert(await testid(page, "photo-review-finish").isDisabled(), "🔴 finishing is impossible while a row is pending");
  assert((await testid(page, "photo-review-preview").count()) === 1, "the photo is shown BESIDE the rows");
  assert((await testid(page, "photo-review-crop").count()) === rows, `every row shows its strip of the ORIGINAL photo (${rows})`);
  // 🔴 NO NETWORK: the app's processes hold no TCP connection after an OCR run (Windows connection table).
  if (process.platform === "win32") {
    const { execFileSync } = await import("node:child_process");
    const pid = app.process().pid;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `$ids = @(${pid}) + @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.ProcessId }); @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') }).Count`], { encoding: "utf8" }).trim();
    assert(out === "0", `🔴 no outbound network connection from the app during OCR (found ${out})`);
  }
  const existingBefore = q("SELECT id, name_ar, selling_price_minor AS p, sku FROM catalog_products ORDER BY id");
  await page.screenshot({ path: SHOTS + "PHOTO-review.png", fullPage: true });
  const before = Number(productsBefore());

  // first row → NEW with a typed sale price; every other row → skip
  const first = testid(page, "photo-review-row").first();
  const name = (await first.locator('[data-testid="photo-review-name"]').inputValue()).trim();
  await first.locator('[data-testid="photo-review-name"]').fill(name + " (اختبار)");
  await first.locator('[data-testid="photo-review-new"]').click();
  assert((await first.locator('[data-testid="photo-review-sale-price"]').inputValue()) === "", "🔴 a NEW product's sale price starts EMPTY — never the supplier price");
  await first.locator('[data-testid="photo-review-sale-price"]').fill(SALE);
  for (let i = 1; i < rows; i++) await testid(page, "photo-review-row").nth(i).locator('[data-testid="photo-review-skip"]').click();
  assert(Number(productsBefore()) === before, "🔴 nothing written during the review");
  await testid(page, "photo-review-finish").click();
  await testid(page, "photo-flow-confirm").waitFor({ timeout: 15000 });
  assert(Number(productsBefore()) === before, "🔴 nothing written at the confirmation step");
  await page.screenshot({ path: SHOTS + "PHOTO-confirm.png" });
  await testid(page, "photo-flow-write").click();
  await testid(page, "photo-flow-done").waitFor({ timeout: 15000 });
  const made = q("SELECT id, name_ar, sku, barcode, selling_price_minor AS p FROM catalog_products WHERE name_ar = ?", name + " (اختبار)");
  assert(made.length === 1, "exactly one product created");
  const existingAfter = q("SELECT id, name_ar, selling_price_minor AS p, sku FROM catalog_products WHERE id <> ? ORDER BY id", made[0].id);
  assert(existingBefore.length >= 2 && JSON.stringify(existingAfter) === JSON.stringify(existingBefore), `🔴 every existing product is untouched (${existingBefore.length})`);
  assert((await page.getByText("أُضيف 1").count()) >= 1, "the result says what was added / linked / not done");
  assert(made[0].sku === null && made[0].barcode === null, "🔴 no SKU and no barcode invented");
  assert(Number(made[0].p) === 975, `🔴 the price is the SALE price typed (${made[0].p} minor), not the supplier cost`);
  assert(q("SELECT count(*) AS n FROM audit_events WHERE event_type = 'PRODUCT_CREATED' AND entity_id = ?", made[0].id)[0].n >= 1, "the creation is in the durable audit trail");
  await page.getByText("إغلاق").last().click();

  // the SAME photo again: the created name cannot be created twice
  await readAndReview(page, app);
  const again = testid(page, "photo-review-row").first();
  await again.locator('[data-testid="photo-review-name"]').fill(name + " (اختبار)");
  await again.locator('[data-testid="photo-review-new"]').click();
  await again.locator('[data-testid="photo-review-sale-price"]').fill(SALE);
  assert((await again.locator('[data-issue="DUPLICATE_PRODUCT_NAME"]').count()) === 1, "🔴 re-processing: the existing name is flagged — link it instead");
  for (let i = 1; i < rows; i++) await testid(page, "photo-review-row").nth(i).locator('[data-testid="photo-review-skip"]').click();
  assert(await testid(page, "photo-review-finish").isDisabled(), "🔴 and the review cannot finish while it would duplicate");
  await page.screenshot({ path: SHOTS + "PHOTO-duplicate-blocked.png", fullPage: true });
  assert(q("SELECT count(*) AS n FROM catalog_products WHERE name_ar = ?", name + " (اختبار)")[0].n === 1, "still exactly one product");

  // ── OCR-REVIEW-UX #1–#3: MEASURED on the live window, not inferred from CSS ─────────────────────────────
  const layout = await page.evaluate(() => {
    const flow = document.querySelector('[data-testid="photo-flow"] .panel.photo-flow');
    const r = flow.getBoundingClientRect();
    const scrollers = [...flow.querySelectorAll("*")]
      .filter((el) => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      })
      .map((el) => el.className || el.tagName);
    const fin = document.querySelector('[data-testid="photo-review-finish"]').getBoundingClientRect();
    const photo = document.querySelector('[data-testid="photo-review-preview"]').getBoundingClientRect();
    const list = document.querySelector('[data-testid="photo-review-table"]').getBoundingClientRect();
    const ov = flow.parentElement; // the overlay itself must not scroll either (98vw + its padding once did)
    return { vw: innerWidth, vh: innerHeight, w: r.width, h: r.height, overlayScrolls: ov.scrollWidth > ov.clientWidth + 1 || ov.scrollHeight > ov.clientHeight + 1, pageScrolls: document.documentElement.scrollWidth > innerWidth + 1, panelScrolls: flow.scrollHeight > flow.clientHeight + 1, scrollers, finVisible: fin.bottom <= innerHeight && fin.top >= 0, side: photo.right <= list.left + 1 || list.right <= photo.left + 1 };
  });
  console.log("layout", JSON.stringify(layout));
  assert(layout.w >= Math.min(1680, layout.vw - 32) - 2 && layout.h >= layout.vh - 34, `#1 the window uses the desktop (${Math.round(layout.w)}×${Math.round(layout.h)} of ${layout.vw}×${layout.vh})`);
  assert(!layout.overlayScrolls && !layout.pageScrolls, `#2 neither the overlay nor the page scrolls (overlay ${layout.overlayScrolls}, page ${layout.pageScrolls})`);
  assert(!layout.panelScrolls && layout.scrollers.every((c) => String(c).includes("pir-rows")), `#2 at most ONE scroller, the row list (${JSON.stringify(layout.scrollers)})`);
  assert(layout.finVisible, "#2 «إنهاء المراجعة» stays in view without scrolling the window");
  assert(layout.side, "#3 the photo is BESIDE the rows");
  await page.screenshot({ path: SHOTS + "PHOTO-UX-review-layout.png" });
  // DEC-35zzzz: the smallest usual Windows window. Measured defect before the fix: «المجموع» clipped and every card
  // scrolling sideways at 1024×768. Every field of the first cards must sit fully inside its card.
  const size0 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setContentSize(1024, 768);
  });
  await page.waitForFunction(() => innerWidth === 1024);
  const at1024 = await page.evaluate(() => {
    const bad = [];
    for (const card of [...document.querySelectorAll('[data-testid="photo-review-row"]')].slice(0, 3)) {
      const c = card.getBoundingClientRect();
      for (const el of card.querySelectorAll("input, select")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.left < c.left - 1 || r.right > c.right + 1 || r.width < 60)) bad.push(el.getAttribute("data-testid") ?? el.tagName);
      }
      if (card.scrollWidth > card.clientWidth + 1) bad.push("card-scrolls-sideways");
    }
    const ov = document.querySelector('[data-testid="photo-flow"]');
    if (ov.scrollWidth > ov.clientWidth + 1) bad.push("overlay-scrolls");
    return bad;
  });
  assert(at1024.length === 0, `1024×768: every field inside its card, nothing scrolls sideways (${at1024.join(", ")})`);
  await page.screenshot({ path: SHOTS + "PHOTO-UX-review-1024.png" });
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), size0);
  await page.locator(".pir-foot").getByText("إلغاء").click();
  await testid(page, "photo-flow").waitFor({ state: "detached", timeout: 10000 });

  // ── OCR-REVIEW-UX #8: a HANDWRITTEN invoice — the photo beside rows typed by hand; NO OCR; Enter = next row ──
  const atHand = Number(productsBefore());
  await testid(page, "photo-invoice").click();
  await testid(page, "photo-flow").waitFor({ timeout: 15000 });
  const h0 = Date.now();
  await testid(page, "photo-flow-handwritten").click();
  await page.locator('[data-testid="photo-review"][data-mode="photo-only"]').waitFor({ timeout: 15000 });
  const openMs = Date.now() - h0;
  assert(openMs < 10000, `the photo opens without OCR (${openMs} ms)`);
  assert((await testid(page, "photo-review-row").count()) === 1 && (await testid(page, "photo-review-preview").count()) === 1, "one empty row, beside the photo");
  assert((await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "photo-review-name", "the cursor is already in the first name");
  const HAND = [
    { name: "يدوي تجريبي ١ 10mm", qty: "4", cost: "2.50", total: "10.00", sale: "3.75" },
    { name: "Hand test 2 خرطوم", qty: "2", cost: "6", total: "12", sale: "8.50" },
  ];
  for (let i = 0; i < HAND.length; i++) {
    const r = HAND[i];
    const row = testid(page, "photo-review-row").nth(i);
    await page.keyboard.type(r.name);
    await row.locator('[data-testid="photo-review-qty"]').fill(r.qty);
    await row.locator('[data-testid="photo-review-cost"]').fill(r.cost);
    await row.locator('[data-testid="photo-review-total"]').fill(r.total);
    await row.locator('[data-testid="photo-review-new"]').click();
    assert((await row.locator('[data-testid="photo-review-sale-price"]').inputValue()) === "", `row ${i + 1}: the sale price starts EMPTY`);
    await row.locator('[data-testid="photo-review-sale-price"]').fill(r.sale);
    await row.locator('[data-testid="photo-review-sale-price"]').press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="photo-review-row"]').length === n, i + 2);
    assert((await page.evaluate(() => document.activeElement?.closest("[data-row]")?.getAttribute("data-row") === document.querySelectorAll('[data-testid="photo-review-row"]')[document.querySelectorAll('[data-testid="photo-review-row"]').length - 1].getAttribute("data-row") && document.activeElement?.getAttribute("data-testid") === "photo-review-name")), `row ${i + 1}: Enter opened the next row with the cursor in its name`);
  }
  // the third line on the paper is an item the shop already has: the suggestion links it in ONE click
  const third = testid(page, "photo-review-row").nth(2);
  await page.keyboard.type("صنف قائم أ");
  await third.locator('[data-testid="photo-review-qty"]').fill("3");
  await third.locator('[data-testid="photo-review-cost"]').fill("2");
  await third.locator('[data-testid="photo-review-total"]').fill("6");
  assert((await third.locator('[data-testid="photo-review-suggest"]').count()) >= 1, "#5 a visible suggestion with its match share");
  assert((await third.locator('[data-testid="photo-review-suggest"]').first().innerText()).includes("٪"), "#5 the suggestion shows its match share");
  await third.locator('[data-testid="photo-review-suggest"]', { hasText: "صنف قائم أ" }).click();
  // DEC-35z9: decision BUTTONS, keyboard, and an explicit link from the search — changeable until confirmation
  assert((await third.locator("select").count()) === 0, "DEC-35z9: no dropdown on a row");
  await third.locator('[data-testid="photo-review-qty"]').focus();
  await page.keyboard.press("Alt+3");
  assert((await third.getAttribute("data-decision")) === "skip", "Alt+3 = تجاهل (ignore)");
  await page.keyboard.press("Alt+2");
  await third.locator('[data-testid="photo-review-link-panel"]').waitFor({ timeout: 5000 });
  assert((await third.getAttribute("data-decision")) === "skip", "🔴 opening «ربط بصنف موجود» does NOT link anything by itself");
  await third.locator('[data-testid="photo-review-link-search"]').press("Escape");
  assert((await third.locator('[data-testid="photo-review-link-panel"]').count()) === 0, "Escape closes the search");
  await third.locator('[data-testid="photo-review-link"]').click();
  await third.locator('[data-testid="photo-review-link-search"]').fill("قائم ب");
  await third.locator('[data-testid="photo-review-link-option"]', { hasText: "صنف قائم ب" }).click();
  assert((await third.getAttribute("data-decision")) === "link" && (await third.locator('[data-testid="photo-review-linked"]').innerText()).includes("صنف قائم ب"), "a click on a search result links (ب)");
  // R-1 (found 2026-11-13, pre-existing in 97b9b99): re-choosing «صنف جديد» never shows a stale sale price. The field
  // starts EMPTY again (never the old price, never the supplier cost) and the row is blocked until a price is typed.
  const sale = () => third.locator('[data-testid="photo-review-sale-price"]').inputValue();
  const saleRequired = async () => (await third.locator('[data-issue="SALE_PRICE_REQUIRED"]').count()) === 1;
  await third.locator('[data-testid="photo-review-new"]').click();
  assert((await third.getAttribute("data-decision")) === "new" && (await third.locator('[data-testid="photo-review-linked"]').count()) === 0, "R-1: link → «صنف جديد» unlinks");
  assert((await sale()) === "" && (await saleRequired()), "R-1: link → new: sale price EMPTY (not the cost 2) and required");
  await third.locator('[data-testid="photo-review-sale-price"]').fill("4.5");
  assert(!(await saleRequired()), "R-1: a typed sale price satisfies the row");
  await third.locator('[data-testid="photo-review-link"]').click();
  await third.locator('[data-testid="photo-review-link-cancel"]').click();
  assert((await third.getAttribute("data-decision")) === "new" && (await sale()) === "4.5" && !(await saleRequired()), "R-1: opening then cancelling the link search keeps «new» and its typed price");
  await third.locator('[data-testid="photo-review-skip"]').click();
  assert((await third.getAttribute("data-decision")) === "skip", "R-1: new → ignore (button)");
  await third.locator('[data-testid="photo-review-new"]').click();
  assert((await sale()) === "" && (await saleRequired()), "🔴 R-1: new → ignore → new (buttons): the old price 4.5 is NOT shown or restored; the price is required again");
  await third.locator('[data-testid="photo-review-sale-price"]').fill("7");
  await third.locator('[data-testid="photo-review-qty"]').focus();
  await page.keyboard.press("Alt+3");
  assert((await third.getAttribute("data-decision")) === "skip", "R-1: Alt+3 ignores");
  await page.keyboard.press("Alt+1");
  assert((await third.getAttribute("data-decision")) === "new" && (await sale()) === "" && (await saleRequired()), "🔴 R-1: new → ignore → new (Alt+3 / Alt+1): the price field is EMPTY and required again");
  await third.locator('[data-testid="photo-review-sale-price"]').fill("8");
  await third.locator('[data-testid="photo-review-qty"]').focus();
  await page.keyboard.press("Alt+1");
  assert((await third.getAttribute("data-decision")) === "new" && (await sale()) === "8" && !(await saleRequired()), "R-1: Alt+1 on a row already «new» keeps its typed price");
  assert(Number(productsBefore()) === atHand, "🔴 R-1: nothing written while switching decisions");
  await third.locator('[data-testid="photo-review-link"]').click();
  await third.locator('[data-testid="photo-review-link-search"]').fill("قائم أ");
  await third.locator('[data-testid="photo-review-link-option"]', { hasText: "صنف قائم أ" }).click();
  assert((await third.locator('[data-testid="photo-review-link-panel"]').count()) === 0, "choosing a result closes the search");
  assert((await third.getAttribute("data-decision")) === "link" && (await third.locator('[data-testid="photo-review-linked"]').innerText()).includes("صنف قائم أ"), "#5 linked by name, «no change to the product» said");
  assert((await testid(page, "photo-review-pending").innerText()) === "0", "header: nothing left without a decision");
  assert((await testid(page, "photo-review-kept").innerText()).includes("28.00"), `header: kept total to compare with the paper (${await testid(page, "photo-review-kept").innerText()})`);
  assert(Number(productsBefore()) === atHand, "🔴 nothing written while typing");
  await page.screenshot({ path: SHOTS + "PHOTO-UX-handwritten.png" });
  await testid(page, "photo-review-finish").click();
  await testid(page, "photo-flow-confirm").waitFor({ timeout: 15000 });
  const confirmText = await testid(page, "photo-flow-confirm").innerText();
  assert((await testid(page, "photo-flow-confirm-new").locator("tbody tr").count()) === 2 && (await testid(page, "photo-flow-confirm-link").locator("tbody tr").count()) === 1, "#6 the confirmation is a clean table: 2 new, 1 linked");
  assert(!confirmText.includes("قرأ البرنامج") && !confirmText.includes("(إدخال يدوي)"), "#6 no engine text on the confirmation");
  assert(Number(productsBefore()) === atHand, "🔴 nothing written at the confirmation step");
  await page.screenshot({ path: SHOTS + "PHOTO-UX-confirm.png" });
  await testid(page, "photo-flow-write").click();
  await testid(page, "photo-flow-result").waitFor({ timeout: 15000 });
  const handMs = Date.now() - h0;
  assert((await testid(page, "photo-flow-result").innerText()).includes("أُضيف 2"), "the result: 2 added, 1 linked");
  const handRows = q("SELECT name_ar, selling_price_minor AS p, sku, barcode FROM catalog_products WHERE name_ar IN (?, ?) ORDER BY name_ar", HAND[0].name, HAND[1].name);
  assert(handRows.length === 2 && Number(productsBefore()) === atHand + 2, "exactly the two typed products were created");
  assert(handRows.map((r) => Number(r.p)).sort((a, b) => a - b).join() === "375,850", `🔴 their SALE prices are the typed ones (${handRows.map((r) => r.p)}), never the supplier cost`);
  assert(handRows.every((r) => r.sku === null && r.barcode === null), "no SKU / barcode invented");
  assert(q("SELECT count(*) AS n FROM catalog_products WHERE name_ar = ?", "صنف قائم أ")[0].n === 1, "🔴 the linked product was NOT duplicated");
  console.log(`handwritten 3-line invoice by keyboard, open→written: ${handMs} ms (machine time, not a human measure)`);
  await page.getByText("إغلاق").last().click();
} finally {
  await app.close();
}
console.log(`PHOTO INVOICE E2E PASSED — ${passed} checks`);
