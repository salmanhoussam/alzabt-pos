// End-to-end smoke test: drives the BUILT Alzabt POS Electron app through its real UI
// (renderer → preload → IPC → service → SQLite), restarts it, and hard-kills it.
//
//   npm run e2e                      (Windows / macOS)
//   xvfb-run -a npm run e2e          (Linux without a display)
//   E2E_EXECUTABLE="release/win-unpacked/Alzabt POS.exe" node e2e/smoke.mjs   (a PACKAGED build)
//
// Uses a throw-away profile directory — it never touches a real ledger. Screenshots land in
// e2e-output/ (git-ignored).
import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
// Default: the dev Electron binary running this folder. With E2E_EXECUTABLE: a packaged app.
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
// Chromium refuses its OS sandbox as root on Linux (containers/CI); never needed on Windows.
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const home = mkdtempSync(join(tmpdir(), "pos-e2e-home-"));
// Isolate the ledger in a throw-away profile on every OS (honoured by src/main/main.ts).
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
// 🔴 Tabs are selected by data-testid, NOT by their visible text. The terminal's default language
// is Arabic, so "Sell" / "History" / "Today's Sales" / "Tools" are no longer the rendered labels —
// an E2E that clicks by English name passes only while the UI happens to be English, which is
// exactly the kind of test that goes green for the wrong reason. The test id is language-neutral.
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

async function launch() {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [...EXTRA_ARGS, ...APP_ARGS],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  return { app, page };
}

async function login(page, name, pin) {
  await page.getByRole("button", { name }).click();
  for (const d of pin) await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await page.locator('[data-testid="login-submit"]').click();
  await page.waitForSelector('[data-testid="cart"]');
}

const product = (page, name) => page.locator("button.product", { hasText: name });
const line = (page, name) => page.locator("li.line", { hasText: name });
const totalText = async (page) => (await page.locator(".total strong").innerText()).trim();

/**
 * Reads one figure off Today's Sales.
 *
 * 🔴 BY TESTID, NOT BY LABEL TEXT. This used to walk `.stats dt` looking for "Net sales" — which
 * depended on BOTH the English label and the <dl> markup. The screen is Arabic now and the layout
 * is no longer a definition list, so either change alone would have broken it silently.
 */
const STAT_TESTID = {
  "Completed sales": "today-completed",
  "Voided sales": "today-voided",
  "Gross sales": "today-gross",
  "Voids": "today-void-amount",
  "Net sales": "today-net",
};
async function stat(page, label) {
  const id = STAT_TESTID[label];
  // 🔴 A MISSING LABEL IS A BROKEN TEST, NOT A MISSING NUMBER. This map replaced a lookup by
  // English label text, and the first version covered four of the screen's five figures — the
  // void AMOUNT (distinct from the void COUNT) was left out and reported as "no stat Voids",
  // which reads like the screen lost a figure rather than like the map being short.
  if (!id) throw new Error(`no stat "${label}" — known: ${Object.keys(STAT_TESTID).join(", ")}`);
  return (await page.locator(`[data-testid="${id}"]`).innerText()).trim();
}

// ── Run 1 ───────────────────────────────────────────────────────────────────────────────────────
let { app, page } = await launch();
const userData = await app.evaluate(({ app }) => app.getPath("userData"));
log("userData:", userData);
assert(userData === env.ALZABT_POS_USER_DATA, "e2e runs against a throw-away profile, never a real ledger");

// Security boundary as seen from inside the renderer.
const surface = await page.evaluate(() => ({
  posKeys: Object.keys(window.pos).sort(),
  require: typeof window.require,
  process: typeof window.process,
  ipcRenderer: typeof window.ipcRenderer,
  frozen: Object.isFrozen(window.pos),
}));
log("renderer surface:", JSON.stringify(surface));
assert(surface.require === "undefined" && surface.process === "undefined" && surface.ipcRenderer === "undefined", "renderer has no require/process/ipcRenderer");
// The surface is asserted by NAME, not by count, so a new channel has to be added here deliberately.
// It was 13 before offline product management; the six that added are createProduct, listProducts,
// updateProduct, setProductActive, getSettings and setTerminalLanguage.
// It went 19 -> 44 with manual invoices (migration 6), 45 with per-invoice tax (setInvoiceTax),
// and 46 on 2026-10-10 with addInvoiceLines, then 53 with operator accounts (migration 8).
//
// 🔴 This assertion did its job. It FAILED the first Windows gate for migration 6, because the
// channels had been added to the contract, the handlers, the preload and the unit-level surface
// test — and not here. That is exactly why it is written by name: the one place that is not
// derived from the contract is the one place a human has to notice.
assert(
  JSON.stringify(surface.posKeys) === JSON.stringify(["addInvoiceLine","addInvoiceLines","completeBootstrapSetup","createInvoiceDraft","createOperator","createProduct","createSale","currentCashier","discardInvoiceDraft","exportBackup","exportCatalog","finalizeInvoice","findInvoiceByNumber","getAppInfo","getCatalog","getCompanyProfile","getInvoice","getSaleHistory","getSettings","getTodaySales","importCatalog","listCashiers","listInvoiceDrafts","listInvoices","listOperators","listProducts","listReconciliation","listReconciliationQueue","login","logout","pickInvoiceLogo","printInvoice","removeInvoiceLine","renameOperator","resetOperatorPin","resolveCreateProduct","resolveKeepCatalog","resolveKeepInvoiceOnly","resolveLinkProduct","resolveUpdateCatalog","saveCompanyProfile","saveInvoicePdf","searchInvoices","setInvoiceTax","setNextInvoiceNumber","setOperatorActive","setOperatorRole","setProductActive","setTerminalLanguage","updateInvoiceHeader","updateInvoiceLine","updateProduct","voidSale"]),
  `window.pos exposes exactly the 53 business methods, and nothing else (got ${surface.posKeys.length})`,
);
await page.screenshot({ path: SHOTS + "01-login.png" });

// Wrong PIN first.
await page.getByRole("button", { name: "Cashier One" }).click();
for (const d of "9999") await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
await page.locator('[data-testid="login-submit"]').click();
await page.waitForSelector("text=Cashier or PIN is incorrect");
log("PASS wrong PIN refused");
for (const d of "1111") await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
await page.locator('[data-testid="login-submit"]').click();
await page.waitForSelector('[data-testid="cart"]');

// Cart editing.
await product(page, "Espresso").click();
await product(page, "Espresso").click();
await product(page, "Fresh Orange Juice").click();
await product(page, "Butter Croissant").click();
assert((await totalText(page)) === "11.35 USD", "cart total 2×2.50 + 4.10 + 2.25 = 11.35");
await line(page, "Espresso").locator('[data-testid="line-dec"]').click();
await line(page, "Butter Croissant").locator('[data-testid="line-remove-btn"]').click();
await line(page, "Fresh Orange Juice").locator('[data-testid="line-inc"]').click();
await line(page, "Fresh Orange Juice").locator('[data-testid="line-inc"]').click();
assert((await totalText(page)) === "14.80 USD", "after edits 2.50 + 3×4.10 = 14.80 (IEEE-754 float gives 14.799999999999999)");
await page.screenshot({ path: SHOTS + "02-cart.png" });

// Complete sale — cash.
await page.locator('[data-testid="complete-sale"]').click();
await page.screenshot({ path: SHOTS + "03-payment.png" });
await page.locator('[data-testid="pay-cash"]').click();
await page.waitForSelector('[data-testid="receipt"]');
const receipt1 = await page.locator(".receipt").innerText();
// 🔴 THE METHOD IS READ AS DATA, NOT AS PROSE. The receipt prints the method in the terminal
// language, so asserting the English word "cash" tested the translation rather than the sale.
const method1 = await page.locator('[data-testid="receipt-method"]').getAttribute("data-method");
assert(
  receipt1.includes("#1") && receipt1.includes("14.80 USD") && method1 === "cash",
  `receipt #1 shows 14.80 USD paid by cash (method=${method1})`,
);
await page.screenshot({ path: SHOTS + "04-receipt.png" });
await page.locator('[data-testid="new-sale"]').click();

// Second sale — card.
for (let i = 0; i < 3; i++) await product(page, "Mint Tea").click();
assert((await totalText(page)) === "5.97 USD", "3 × 1.99 = 5.97");
await page.locator('[data-testid="complete-sale"]').click();
await page.locator('[data-testid="pay-card"]').click();
await page.waitForSelector('[data-testid="receipt-number"]:has-text("#2")');
await page.locator('[data-testid="new-sale"]').click();

// Forged calls straight through window.pos (what a compromised renderer could try).
const forged = await page.evaluate(async () => ({
  extraField: await window.pos.createSale({ idempotencyKey: "forged-key-0001", lines: [{ productId: "prod-0001", quantityMilli: 1000 }], paymentMethod: "cash", expectedTotalMinor: "1", unitPrice: "1" }),
  wrongTotal: await window.pos.createSale({ idempotencyKey: "forged-key-0002", lines: [{ productId: "prod-0001", quantityMilli: 1000 }], paymentMethod: "cash", expectedTotalMinor: "1" }),
}));
log("forged:", JSON.stringify(forged));
assert(!forged.extraField.ok && forged.extraField.error.code === "INVALID_INPUT", "forged extra field rejected");
assert(!forged.wrongTotal.ok && forged.wrongTotal.error.code === "TOTAL_MISMATCH", "forged total rejected");

// Today's sales.
await page.locator('[data-testid="tab-today"]').click();
await page.waitForSelector('[data-testid="today-net"]');
assert((await stat(page, "Completed sales")) === "2", "today: 2 completed sales");
assert((await stat(page, "Gross sales")) === "20.77 USD", "today gross 14.80 + 5.97 = 20.77");
assert((await stat(page, "Net sales")) === "20.77 USD", "today net 20.77 before void");
await page.screenshot({ path: SHOTS + "05-today.png" });

// Void receipt #2 from history.
await page.locator('[data-testid="tab-history"]').click();
await page.waitForSelector(".history-table");
await page.locator('tr[data-payment-method="card"]').locator('[data-testid="history-void"]').click();
await page.locator('[data-testid="void-reason"]').fill("customer cancelled");
await page.screenshot({ path: SHOTS + "06-void-dialog.png" });
await page.locator('[data-testid="void-confirm"]').click();
await page.waitForSelector("tr.voided");
await page.screenshot({ path: SHOTS + "07-history.png" });

await page.locator('[data-testid="tab-today"]').click();
await page.waitForSelector('[data-testid="today-net"]');
assert((await stat(page, "Voided sales")) === "1", "today: 1 voided");
assert((await stat(page, "Gross sales")) === "20.77 USD", "gross unchanged by the void");
assert((await stat(page, "Voids")) === "− 5.97 USD", "void total 5.97");
assert((await stat(page, "Net sales")) === "14.80 USD", "net 20.77 − 5.97 = 14.80");
await app.close();
log("app closed normally");

// ── Run 2: restart, data must still be there ─────────────────────────────────────────────────────
({ app, page } = await launch());
await login(page, "Cashier Two", "2222");
await page.locator('[data-testid="tab-today"]').click();
await page.waitForSelector('[data-testid="today-net"]');
assert((await stat(page, "Completed sales")) === "2" && (await stat(page, "Net sales")) === "14.80 USD", "after restart: 2 sales, net 14.80 persisted");

// A third sale, then HARD-KILL the Electron main process (no clean shutdown) — the main process
// only: its helper processes are left alone, exactly as an application crash would leave them.
await page.locator('[data-testid="tab-sell"]').click();
await product(page, "Water 500ml").click();
await page.locator('[data-testid="complete-sale"]').click();
await page.locator('[data-testid="pay-other"]').click();
await page.waitForSelector('[data-testid="receipt-number"]:has-text("#3")');

// The REAL Electron main PID, asked of the main process itself. NOT app.process().pid: on Windows
// Playwright starts Electron through `cmd.exe /c` (shell: true), so app.process() is that wrapper —
// killing it leaves the whole POS running (the false "orphan" finding of Gate 2, runs #1 and #2).
const mainPid = await app.evaluate(() => process.pid);
const launcherPid = app.process().pid;
log(`main pid ${mainPid}, launcher pid ${launcherPid}${mainPid === launcherPid ? " (same process)" : " (wrapper)"}`);
const isAlive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
const image = basename(ELECTRON);
const appPids = () =>
  process.platform === "win32"
    ? execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
        .split(/\r?\n/)
        .filter((l) => l.toLowerCase().includes(image.toLowerCase()))
        .map((l) => Number(l.split('","')[1]))
    : [mainPid];
const beforeKill = appPids();
log(`app processes before the kill: ${beforeKill.length}`);
process.kill(mainPid, "SIGKILL"); // TerminateProcess on Windows
log("hard-killed the Electron main process only", mainPid);

// No cleanup: every process of the killed instance must go away BY ITSELF.
const killedAt = Date.now();
while (beforeKill.some(isAlive) && Date.now() - killedAt < 10000) await new Promise((r) => setTimeout(r, 100));
const leftovers = beforeKill.filter(isAlive);
assert(leftovers.length === 0, `all ${beforeKill.length} process(es) of the killed instance exited on their own (${Date.now() - killedAt} ms) — no cleanup`);

// ── Run 3: relaunch straight after the hard kill — no reboot, no manual cleanup ────────────────
({ app, page } = await launch());
await login(page, "Cashier One", "1111");
await page.locator('[data-testid="tab-today"]').click();
await page.waitForSelector('[data-testid="today-net"]');
assert((await stat(page, "Completed sales")) === "3", "after the hard kill: sale #3 (committed just before it) survived");
assert((await stat(page, "Net sales")) === "15.55 USD", "net 14.80 + 0.75 = 15.55");
await page.screenshot({ path: SHOTS + "08-today-after-kill.png" });

// The recovered till takes a new sale.
await page.locator('[data-testid="tab-sell"]').click();
await product(page, "Zaatar Manousheh").click();
await product(page, "Zaatar Manousheh").click();
await page.locator('[data-testid="complete-sale"]').click();
await page.locator('[data-testid="pay-cash"]').click();
await page.waitForSelector('[data-testid="receipt-number"]:has-text("#4")');
await page.locator('[data-testid="new-sale"]').click();
await page.locator('[data-testid="tab-today"]').click();
await page.waitForSelector('[data-testid="today-net"]');
assert((await stat(page, "Completed sales")) === "4", "new sale #4 completed after recovery");
assert((await stat(page, "Net sales")) === "18.55 USD", "net 15.55 + 2×1.50 = 18.55");
await page.locator('[data-testid="tab-history"]').click();
await page.waitForSelector(".history-table");
const rows = await page.locator(".history-table tbody tr").count();
assert(rows === 4, "history lists 4 sales");
await app.close();
log("ALL E2E CHECKS PASSED");
