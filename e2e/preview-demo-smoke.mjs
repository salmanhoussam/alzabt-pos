// OWNER-ONLY R5 PREVIEW — installed-app Demo smoke. Packaged Electron, synthetic data, the disposable GitHub-hosted
// Windows VM only, run AS the standard account `alzabt-test` by scripts/preview-installed-windows.ps1.
// Modelled on e2e/trial-runtime-smoke.mjs (R3): the same installed-executable hash and path-link checks.
//
// What it proves:
//   LAUNCHER  the preview's non-demo entry shows «جرّب النظام» and main REFUSES business channels there
//   DEMO 1    a fresh in-memory Demo: 22 products, 8 categories, 0 sales; one synthetic cash sale with exact USD
//             totals; on the SELL SCREEN the real «ل.ل.» header toggle is clicked: refused (visible reason) while the
//             rate is unconfirmed, then — after the owner confirms the rate — the product card shows the exact
//             indicative «≈ … ل.ل.» figure next to its unchanged USD price, and the stored USD sale is unchanged
//   FAILURE   any failed check saves a screenshot + sanitized visible state (text, test ids, console errors) to
//             ALZABT_PREVIEW_EVIDENCE_DIR, which the hosted supervisor uploads even when the run fails
//
// Preview R2 (hosted run 45703295291) waited, after a reload, for the test id «lbp-equivalent». No Sell-screen
// element carries that id: every call site passes its own (`product-price-lbp`, `cart-line-lbp`, `cart-total-lbp`).
// The wait could never succeed. This version drives the real toggle and reads the real product-card id.
//   RESET     close, then a NEW Demo: 0 sales and the original 22 products at their original prices
//   DISK      no Demo ledger/journal file anywhere under the preview data folder, and the first session's sale id
//             appears in no file there (UTF-8 or UTF-16LE)
// What it does NOT prove: the click on «جرّب النظام» → native confirmation → relaunch hop (a new process Playwright cannot
// follow). The smoke starts the Demo with the SAME flag that relaunch passes. The owner checks that hop by hand.
import { _electron as electron } from "playwright-core";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("This smoke test requires Windows");
if (process.argv.length !== 2) throw new Error("The preview smoke accepts no arguments");
if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw new Error("Missing Windows system root");
const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const localAppData = resolve(
  execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Write([Environment]::GetFolderPath('LocalApplicationData'))"], {
    encoding: "utf8",
  }).trim(),
);
if (!isAbsolute(localAppData) || localAppData === parse(localAppData).root) throw new Error("Unsafe LocalApplicationData");

const executable = join(localAppData, "Programs", "alzabt-pos-r5-preview", "Alzabt POS R5 PREVIEW.exe");
const dataRoot = join(localAppData, "Alzabt-R5-Owner-Preview");
const DEMO_FLAGS = ["--alzabt-synthetic-dev", "--alzabt-ephemeral-demo"]; // exactly what the launcher's relaunch passes

// Accidental-substitution check, as in R3 (not an atomic binding against a malicious replacement).
const expectedHash = process.env.ALZABT_PREVIEW_INSTALLED_EXE_SHA256 ?? "";
if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error("Missing installed executable SHA-256");
for (let current = executable; ; current = dirname(current)) {
  const info = lstatSync(current);
  if (info.isSymbolicLink() || (current === executable && (!info.isFile() || info.nlink !== 1))) throw new Error("Installed executable path is linked or unexpected");
  if (current === parse(current).root) break;
}
if (createHash("sha256").update(readFileSync(executable)).digest("hex") !== expectedHash) throw new Error("Installed executable SHA-256 mismatch");

const appEnv = { ...process.env };
for (const k of ["ALZABT_POS_USER_DATA", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) delete appEnv[k];
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);

async function closeAndVerify(app) {
  const child = app.process();
  await app.close();
  if (child.exitCode === null && child.signalCode === null) throw new Error(`Preview process ${child.pid} exit was not observed`);
  console.log(`PREVIEW PROCESS EXIT: pid ${child.pid}, code ${child.exitCode}`);
}
// ── failure evidence ────────────────────────────────────────────────────────────────────────────
// Written only into the directory the supervisor grants this account (WorkRoot\evidence), and only on a failure
// (plus one success screenshot of the LBP state). Synthetic Demo data only; paths, the account and machine names are
// replaced before anything is written or printed.
const evidenceDir = (() => {
  const d = process.env.ALZABT_PREVIEW_EVIDENCE_DIR ?? "";
  if (!d || !isAbsolute(d) || !existsSync(d)) return null;
  const info = lstatSync(d);
  return info.isDirectory() && !info.isSymbolicLink() ? d : null;
})();
const secrets = [localAppData, process.env.USERPROFILE, process.env.APPDATA, process.env.TEMP, process.env.COMPUTERNAME, userInfo().username]
  .filter((s) => typeof s === "string" && s.length >= 3)
  .sort((a, b) => b.length - a.length);
function sanitize(text) {
  let out = String(text ?? "");
  for (const s of secrets) out = out.split(s).join("<redacted>").split(s.replaceAll("\\", "/")).join("<redacted>");
  return out.replace(/S-1-5-21-[0-9-]+/gi, "<sid>");
}
const consoleLog = [];
function watch(page) {
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && consoleLog.length < 50) consoleLog.push(`${m.type()}: ${sanitize(m.text()).slice(0, 300)}`);
  });
  page.on("pageerror", (e) => {
    if (consoleLog.length < 50) consoleLog.push(`pageerror: ${sanitize(e.message).slice(0, 300)}`);
  });
}
async function saveScreenshot(page, name) {
  if (!evidenceDir) return false;
  try {
    await page.screenshot({ path: join(evidenceDir, name), fullPage: true, timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}
async function captureFailure(stage, err) {
  const report = { stage, error: sanitize(err?.message ?? err).slice(0, 2000), console: consoleLog };
  const page = current?.page;
  if (page && !page.isClosed()) {
    report.screenshot = (await saveScreenshot(page, "preview-smoke-failure.png")) ? "preview-smoke-failure.png" : "not saved";
    try {
      const state = await page.evaluate(() => {
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const ids = [...new Set([...document.querySelectorAll("[data-testid]")].filter(visible).map((el) => el.getAttribute("data-testid")))];
        const toggle = document.querySelector('[data-testid="display-currency-toggle"]');
        return {
          url: location.href,
          title: document.title,
          visibleTestIds: ids.slice(0, 300),
          toggle: toggle ? { currency: toggle.getAttribute("data-display-currency"), text: toggle.textContent } : null,
          lbpLines: document.querySelectorAll(".lbp-equivalent").length,
          productCards: document.querySelectorAll("button.product").length,
          text: (document.body?.innerText ?? "").slice(0, 6000),
        };
      });
      report.page = JSON.parse(sanitize(JSON.stringify(state)));
    } catch (e) {
      report.page = `unreadable: ${sanitize(e?.message).slice(0, 300)}`;
    }
  } else {
    report.page = "no open window";
  }
  const json = JSON.stringify(report, null, 2);
  if (evidenceDir) {
    try {
      writeFileSync(join(evidenceDir, "preview-smoke-failure.json"), json, "utf8");
    } catch {
      /* the stdout copy below still carries it */
    }
  }
  console.log(`PREVIEW SMOKE FAILURE DIAGNOSTICS (evidence dir ${evidenceDir ? "set" : "NOT set"}):\n${json.slice(0, 8000)}`);
}

async function launch(args) {
  const app = await electron.launch({ executablePath: executable, args, env: appEnv, timeout: 90000 });
  const page = await app.firstWindow({ timeout: 90000 });
  watch(page);
  const details = await app.evaluate(({ app }) => ({ pid: process.pid, userData: app.getPath("userData"), packaged: app.isPackaged }));
  if (!details.packaged) throw new Error("Not the packaged app");
  if (!resolve(details.userData).toLowerCase().startsWith(dataRoot.toLowerCase() + "\\")) throw new Error(`Unexpected profile ${details.userData}`);
  return { app, page, details };
}
const call = (page, fn, arg) => page.evaluate(fn, arg);

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`Link inside the preview data folder: ${p}`);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

// The indicative figure, computed HERE independently of the app (src/domain/lbpDisplay.ts must agree):
// LBP minor = USD minor × rate (hundredths) / 100, ROUND_HALF_UP; grouped, two decimals.
function expectedLbpLine(usdMinor, rateWhole) {
  const product = BigInt(usdMinor) * BigInt(rateWhole) * 100n;
  const lbpMinor = product / 100n + (product % 100n >= 50n ? 1n : 0n);
  const whole = (lbpMinor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `≈ ${whole}.${(lbpMinor % 100n).toString().padStart(2, "0")} ل.ل.`;
}
const RATE = "89000";

let current;
let failure;
let stage = "launcher";
try {
  // ── LAUNCHER ──────────────────────────────────────────────────────────────────────────────────
  current = await launch([]);
  await testid(current.page, "welcome-demo").waitFor({ timeout: 90000 });
  const refused = await call(current.page, async () => ({
    enroll: await window.pos.enrollOwner({ name: "X", pin: "482613" }),
    sale: await window.pos.createSale({ idempotencyKey: "preview-launcher-0001", lines: [], paymentMethod: "cash", expectedTotalMinor: "0" }),
    restore: await window.pos.inspectRestoreBackup(),
  }));
  for (const [name, r] of Object.entries(refused)) if (r.ok || r.error?.code !== "NOT_AVAILABLE") throw new Error(`Launcher allowed ${name}`);
  console.log("LAUNCHER: «جرّب النظام» shown; enrollment, sale and restore refused in main (NOT_AVAILABLE)");
  await closeAndVerify(current.app);
  current = undefined;

  // ── DEMO 1 ────────────────────────────────────────────────────────────────────────────────────
  stage = "demo-1";
  current = await launch(DEMO_FLAGS);
  const firstSession = current.details.userData;
  const before = await call(current.page, async () => {
    const products = await window.pos.listProducts();
    const categories = await window.pos.listCategories();
    const today = await window.pos.getTodaySales();
    return { products: products.ok ? products.data : null, categories: categories.ok ? categories.data : null, today: today.ok ? today.data : null };
  });
  if (!before.products || before.products.length !== 22) throw new Error(`Demo products: ${before.products?.length}`);
  if (!before.categories || before.categories.filter((c) => c.isActive !== false).length !== 8) throw new Error("Demo categories are not 8");
  if (!before.today || before.today.completedSalesCount !== 0) throw new Error("A fresh Demo must have 0 sales");
  const original = JSON.stringify(before.products.map((p) => [p.id, p.sku, p.nameAr, p.price]).sort());
  // A priced product with a SKU, so its card can be found on screen by its unique code.
  const item = before.products.find((p) => p.price.minor !== "0" && typeof p.sku === "string" && p.sku !== "");
  if (!item) throw new Error("No priced Demo product with a SKU");
  if (before.products.filter((p) => p.sku === item.sku).length !== 1) throw new Error("The chosen SKU is not unique");
  const sale = await call(current.page, async (p) => {
    const r = await window.pos.createSale({
      idempotencyKey: "preview-demo-sale-0001",
      lines: [{ productId: p.id, quantityMilli: 2000 }],
      paymentMethod: "cash",
      expectedTotalMinor: String(BigInt(p.price.minor) * 2n),
    });
    if (!r.ok) throw new Error(`Demo sale refused: ${r.error?.code}`);
    return r.data.sale;
  }, item);
  const expectedTotal = String(BigInt(item.price.minor) * 2n);
  if (sale.currency !== "USD" || sale.total.minor !== expectedTotal || sale.paid.minor !== expectedTotal || sale.balanceDue.minor !== "0") throw new Error("Demo sale totals differ");
  console.log(`DEMO 1: 22 products, 8 categories, 0 sales; cash sale ${sale.total.minor} USD minor, exact totals`);

  // ── DEMO 1 · LBP through the REAL Sell-screen toggle (no reload) ─────────────────────────────
  stage = "demo-1-lbp";
  const page = current.page;
  await testid(page, "tab-sell").click({ timeout: 60000 });
  const card = page.locator("button.product").filter({ has: page.locator(".product-sku", { hasText: new RegExp(`^${item.sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
  await card.waitFor({ state: "visible", timeout: 60000 });
  if ((await card.count()) !== 1) throw new Error(`Expected one Sell-screen card for ${item.sku}, found ${await card.count()}`);
  const usdShown = (await card.locator(".product-price bdi").first().innerText()).trim();
  const lbpLine = card.locator('[data-testid="product-price-lbp"]');
  const toggle = testid(page, "display-currency-toggle");
  await toggle.waitFor({ state: "visible", timeout: 30000 });
  if ((await toggle.getAttribute("data-display-currency")) !== "USD") throw new Error("A fresh Demo must start in USD display");
  if ((await lbpLine.count()) !== 0) throw new Error("An LBP line is shown before the toggle is on");

  // 1) F8: with the rate not yet confirmed, the click is REFUSED in main and the reason is shown; USD stays.
  const settings0 = await call(page, async () => (await window.pos.getSettings()).data);
  if (settings0?.lbpRateConfirmed !== false) throw new Error("A fresh Demo must start with the rate unconfirmed");
  await toggle.click();
  await testid(page, "display-currency-error").waitFor({ state: "visible", timeout: 30000 });
  if ((await toggle.getAttribute("data-display-currency")) !== "USD" || (await lbpLine.count()) !== 0) throw new Error("The unconfirmed toggle changed the display");

  // 2) The owner confirms the rate (the same owner-only channel the Tools screen uses; this Demo session is the owner).
  const rate = await call(page, async (r) => window.pos.setLbpRate({ rate: r }), RATE);
  if (!rate.ok || rate.data.lbpRateConfirmed !== true || rate.data.lbpRate !== RATE) throw new Error(`Rate not confirmed: ${rate.error?.code ?? "?"}`);

  // 3) The real click turns LBP on; the line appears on the product card with the exact figure.
  await toggle.click();
  await page.locator('[data-testid="display-currency-toggle"][data-display-currency="LBP"]').waitFor({ timeout: 30000 });
  await lbpLine.waitFor({ state: "visible", timeout: 30000 });
  const lbpShown = (await lbpLine.innerText()).trim();
  const lbpExpected = expectedLbpLine(item.price.minor, RATE);
  if (lbpShown !== lbpExpected) throw new Error(`LBP line «${lbpShown}» differs from the expected «${lbpExpected}»`);
  if ((await card.locator(".product-price bdi").first().innerText()).trim() !== usdShown) throw new Error("The USD price on the card changed");
  if ((await testid(page, "display-currency-error").count()) !== 0) throw new Error("The refusal message stayed after a successful toggle");
  await saveScreenshot(page, "preview-demo-lbp-on.png");

  // 4) Nothing stored changed: the sale, the catalog prices, and main's settings agree with the screen.
  const stored = await call(page, async (saleId) => {
    const receipt = await window.pos.getSaleReceipt({ saleId });
    const products = await window.pos.listProducts();
    const settings = await window.pos.getSettings();
    return { receipt: receipt.ok ? receipt.data.sale : null, products: products.ok ? products.data : null, settings: settings.ok ? settings.data : null };
  }, sale.id);
  for (const f of ["subtotal", "tax", "total", "paid", "balanceDue"]) {
    if (JSON.stringify(stored.receipt?.[f]) !== JSON.stringify(sale[f])) throw new Error(`LBP display changed stored ${f}`);
  }
  if (stored.receipt?.currency !== "USD") throw new Error("The stored sale currency changed");
  if (JSON.stringify(stored.products?.map((p) => [p.id, p.sku, p.nameAr, p.price]).sort()) !== original) throw new Error("LBP display changed the catalog");
  if (stored.settings?.displayCurrency !== "LBP" || stored.settings?.lbpRate !== RATE) throw new Error("Main's settings disagree with the screen");
  console.log(`DEMO 1 LBP: Sell-screen toggle refused while unconfirmed (reason shown); after confirming ${RATE}, card ${item.sku} shows «${lbpShown}» beside «${usdShown}»; stored sale, catalog and USD unchanged`);
  stage = "demo-1-close";
  await closeAndVerify(current.app);
  current = undefined;

  // ── RESET ─────────────────────────────────────────────────────────────────────────────────────
  stage = "reset";
  current = await launch(DEMO_FLAGS);
  if (current.details.userData === firstSession) throw new Error("A Demo session folder was reused");
  const after = await call(current.page, async () => {
    const products = await window.pos.listProducts();
    const today = await window.pos.getTodaySales();
    const settings = await window.pos.getSettings();
    return { products: products.ok ? products.data : null, today: today.ok ? today.data : null, settings: settings.ok ? settings.data : null };
  });
  if (!after.today || after.today.completedSalesCount !== 0) throw new Error("The next Demo is not empty of sales");
  if (JSON.stringify(after.products.map((p) => [p.id, p.sku, p.nameAr, p.price]).sort()) !== original) throw new Error("The next Demo's catalog differs from the original");
  if (after.settings?.lbpRateConfirmed !== false || after.settings?.displayCurrency !== "USD") throw new Error("The Demo rate/toggle did not reset");
  console.log("RESET: the next Demo has 0 sales, the original 22 products and prices, and the rate reset");
  await closeAndVerify(current.app);
  current = undefined;

  // ── DISK ──────────────────────────────────────────────────────────────────────────────────────
  stage = "disk";
  const files = filesUnder(dataRoot);
  const ledgers = files.filter((f) => /\.sqlite$|\.sqlite-wal$|\.sqlite-journal$|\.sqlite-shm$/i.test(f));
  const nonLauncher = ledgers.filter((f) => !f.toLowerCase().includes("\\synthetic-entry-v1\\"));
  if (nonLauncher.length) throw new Error(`Demo ledger files on disk: ${nonLauncher.join(", ")}`);
  const needles = [Buffer.from(sale.id, "utf8"), Buffer.from(sale.id, "utf16le")];
  const sessionFiles = files.filter((f) => f.toLowerCase().includes("\\ephemeral-sessions\\"));
  for (const f of sessionFiles) {
    const bytes = readFileSync(f);
    if (needles.some((n) => bytes.includes(n))) throw new Error(`Demo sale id found on disk in ${f}`);
  }
  console.log(`DISK: no Demo ledger/journal; sale id in none of ${sessionFiles.length} session files (launcher ledgers: ${ledgers.length})`);
} catch (err) {
  failure = err;
  try {
    await captureFailure(stage, err);
  } catch (captureError) {
    console.log(`PREVIEW SMOKE: failure diagnostics could not be captured: ${sanitize(captureError?.message)}`);
  }
} finally {
  if (current) {
    try {
      await closeAndVerify(current.app);
    } catch (cleanupError) {
      failure = failure ? new AggregateError([failure, cleanupError], "Preview test and cleanup failed") : cleanupError;
    }
  }
}
if (failure) throw failure;
console.log("PREVIEW DEMO SMOKE PASSED");
