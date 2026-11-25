// OWNER-ONLY R5 PREVIEW — installed-app Demo smoke. Packaged Electron, synthetic data, the disposable GitHub-hosted
// Windows VM only, run AS the standard account `alzabt-test` by scripts/preview-installed-windows.ps1.
// Modelled on e2e/trial-runtime-smoke.mjs (R3): the same installed-executable hash and path-link checks.
//
// What it proves:
//   LAUNCHER  the preview's non-demo entry shows «جرّب النظام» and main REFUSES business channels there
//   DEMO 1    a fresh in-memory Demo: 22 products, 8 categories, 0 sales; one synthetic cash sale with exact USD
//             totals; the owner sets the rate and turns LBP on — the indicative LBP line appears and the stored
//             USD sale is unchanged
//   RESET     close, then a NEW Demo: 0 sales and the original 22 products at their original prices
//   DISK      no Demo ledger/journal file anywhere under the preview data folder, and the first session's sale id
//             appears in no file there (UTF-8 or UTF-16LE)
// What it does NOT prove: the click on «جرّب النظام» → native confirmation → relaunch hop (a new process Playwright cannot
// follow). The smoke starts the Demo with the SAME flag that relaunch passes. The owner checks that hop by hand.
import { _electron as electron } from "playwright-core";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
async function launch(args) {
  const app = await electron.launch({ executablePath: executable, args, env: appEnv, timeout: 90000 });
  const page = await app.firstWindow({ timeout: 90000 });
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

let current;
let failure;
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
  const item = before.products.find((p) => p.price.minor !== "0");
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
  const lbp = await call(current.page, async (saleId) => {
    const rate = await window.pos.setLbpRate({ rate: "89000" });
    const show = await window.pos.setDisplayCurrency({ currency: "LBP" });
    const receipt = await window.pos.getSaleReceipt({ saleId });
    return { rate: rate.ok && rate.data.lbpRateConfirmed, show: show.ok && show.data.displayCurrency, receipt: receipt.ok ? receipt.data.sale : null };
  }, sale.id);
  if (lbp.rate !== true || lbp.show !== "LBP") throw new Error("LBP display could not be enabled after confirming the rate");
  for (const f of ["subtotal", "tax", "total", "paid", "balanceDue"]) {
    if (JSON.stringify(lbp.receipt?.[f]) !== JSON.stringify(sale[f])) throw new Error(`LBP display changed stored ${f}`);
  }
  await current.page.reload();
  await testid(current.page, "lbp-equivalent").first().waitFor({ timeout: 60000 });
  console.log(`DEMO 1: 22 products, 8 categories, cash sale ${sale.total.minor} USD minor; LBP line shown; stored USD unchanged`);
  await closeAndVerify(current.app);
  current = undefined;

  // ── RESET ─────────────────────────────────────────────────────────────────────────────────────
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
