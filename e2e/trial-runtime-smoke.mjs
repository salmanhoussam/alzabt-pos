// Packaged Electron, synthetic data, and a disposable GitHub-hosted Windows VM only.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { requireStandardLocalAccount, selectTrialAppEnvironment } from "./trial-smoke-env.mjs";

if (process.platform !== "win32") throw new Error("This smoke test requires Windows");
// The installed mode has a fixed path beneath the Windows shell folder; it
// deliberately accepts no caller-supplied executable path. Environment-only
// redirection is not evidence that NSIS resolves the same folder.
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["--installed", "--installed-local"].includes(args[0]))) {
  throw new Error("Unsupported trial smoke arguments");
}
const installed = args.length === 1;
const localMode = args[0] === "--installed-local";
let localAppData;
let localRoaming;
if (installed) {
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw new Error("Missing Windows system root");
  const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const shellFolder = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::Write([Environment]::GetFolderPath('LocalApplicationData'))"], { encoding: "utf8" }).trim();
  if (!shellFolder || !isAbsolute(shellFolder) || resolve(shellFolder) === parse(resolve(shellFolder)).root) {
    throw new Error("Unable to resolve a safe Windows shell LocalApplicationData folder");
  }
  localAppData = resolve(shellFolder);
  if (localMode) {
    localRoaming = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::Write([Environment]::GetFolderPath('ApplicationData'))"], { encoding: "utf8" }).trim();
    const whoami = join(process.env.SystemRoot, "System32", "whoami.exe");
    const query = (params) => execFileSync(whoami, params, { encoding: "utf8", windowsHide: true, timeout: 5000 });
    requireStandardLocalAccount(hostname(), query(["/user", "/fo", "csv", "/nh"]), query(["/groups", "/fo", "csv", "/nh"]));
  }
}
const appEnv = selectTrialAppEnvironment(process.env, localMode ? "local" : "runner", localRoaming);
const executable = installed
  ? join(localAppData, "Programs", "alzabt-pos-trial", "Alzabt POS TRIAL TEST ONLY.exe")
  : resolve("release/win-unpacked/Alzabt POS TRIAL TEST ONLY.exe");
if (!existsSync(executable)) throw new Error("Missing designated trial executable");
if (installed) {
  // This checks for accidental substitutions. It is not an atomic binding
  // against a malicious process replacing the file after the check.
  const expectedHash = process.env.ALZABT_TRIAL_INSTALLED_EXE_SHA256 ?? "";
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error("Missing installed executable SHA-256");
  for (let current = executable; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (current === executable && (!info.isFile() || info.nlink !== 1))) {
      throw new Error("Installed executable path is linked or unexpected");
    }
    if (current === parse(current).root) break;
  }
  const actualHash = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (actualHash !== expectedHash) throw new Error("Installed executable SHA-256 mismatch");
}
const profile = join(appEnv.APPDATA, "Alzabt POS TRIAL Test Data");
const ledger = join(profile, "alzabt-pos-trial-only-ledger.sqlite");
if (existsSync(profile)) throw new Error("Smoke requires a fresh synthetic profile");
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);

async function closeAndVerify(app) {
  const child = app.process();
  await app.close();
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Trial process ${child.pid} exit was not observed`);
  }
  console.log(`TRIAL PROCESS EXIT: pid ${child.pid}, code ${child.exitCode}, signal ${child.signalCode}`);
}

async function launch() {
  const app = await electron.launch({ executablePath: executable, env: appEnv, timeout: 60000 });
  try {
    const page = await app.firstWindow({ timeout: 60000 });
    const details = await app.evaluate(({ app }) => ({ pid: process.pid, userData: app.getPath("userData"), packaged: app.isPackaged }));
    if (!details.packaged || resolve(details.userData) !== resolve(profile)) throw new Error("Unexpected packaged app profile");
    await testid(page, "select-cashier").waitFor({ timeout: 60000 });
    return { app, page, pid: details.pid };
  } catch (err) {
    try {
      await closeAndVerify(app);
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], "Trial startup and cleanup failed");
    }
    throw err;
  }
}

let current;
let failure;
try {
  current = await launch();
  console.log(`STARTUP 1: real packaged Electron window, pid ${current.pid}`);
  if (await signIn(current.page, "Cashier One", "1111") !== "setup") throw new Error("Fresh owner setup was not performed");
  if (!readFileSync(ledger).subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) throw new Error("Missing SQLite ledger header");
  // Create synthetic data through the real packaged app's IPC and save the
  // returned financial values for comparison with a fresh process below.
  const sale = await current.page.evaluate(async () => {
    const product = await window.pos.createProduct({ draft: { nameAr: "Trial item", nameEn: null, sku: "TRIAL-ONLY-001", price: "2.50", baseUnit: "piece" } });
    if (!product.ok) throw new Error(`Synthetic product refused: ${product.error?.code}`);
    const result = await window.pos.createSale({ idempotencyKey: "trial-installed-sale-0001", lines: [{ productId: product.data.id, quantityMilli: 2000 }], paymentMethod: "cash", expectedTotalMinor: "500" });
    if (!result.ok) throw new Error(`Synthetic sale refused: ${result.error?.code}`);
    return result.data.sale;
  });
  if (sale.currency !== "USD" || sale.subtotal.minor !== "500" || sale.tax.minor !== "0" || sale.total.minor !== "500" || sale.paid.minor !== "500" || sale.balanceDue.minor !== "0") throw new Error("Synthetic sale financial totals differ from expected");
  const firstPid = current.pid;
  await closeAndVerify(current.app); current = undefined;
  current = await launch();
  if (current.pid === firstPid) throw new Error("Restart did not create a new process");
  if (await signIn(current.page, "Cashier One", "1111") !== "resumed") throw new Error("Owner setup did not persist across restart");
  const receipt = await current.page.evaluate(async (saleId) => {
    const result = await window.pos.getSaleReceipt({ saleId });
    if (!result.ok) throw new Error(`Persisted sale receipt refused: ${result.error?.code}`);
    return result.data.sale;
  }, sale.id);
  for (const field of ["subtotal", "tax", "total", "paid", "balanceDue"]) {
    if (JSON.stringify(receipt[field]) !== JSON.stringify(sale[field])) throw new Error(`Persisted sale ${field} changed`);
  }
  if (receipt.id !== sale.id || receipt.lines.length !== 1 || receipt.lines[0].quantityMilli !== 2000 || receipt.lines[0].lineTotal.minor !== "500") throw new Error("Persisted sale identity or line changed");
  console.log("SALE: synthetic cash sale and financial totals persisted across installed-app restart");
  console.log(`RESTART: real process ${firstPid} -> ${current.pid}; persisted SQLite owner setup reopened`);

  const blocked = await current.page.evaluate(async () => ({
    restore: await window.pos.inspectRestoreBackup(),
    catalog: await window.pos.importCatalog(),
    productPhone: await window.pos.startPhoneSession({ action: "NEW_PRODUCT" }),
  }));
  if (Object.values(blocked).some((r) => r.ok || r.error?.code !== "FORBIDDEN")) throw new Error("A blocked trial entry was reachable");
  console.log("BOUNDARIES: restore, catalog import, product phone session refused");
  await testid(current.page, "tab-products").click();
  await testid(current.page, "add-product-phone").click();
  await testid(current.page, "phone-invoice-dialog").waitFor({ timeout: 30000 });
  if (!(await testid(current.page, "phone-address").innerText()).startsWith("127.0.0.1:")) throw new Error("Trial phone listener is not loopback");
  await testid(current.page, "phone-qr").waitFor();
  console.log("PHONE ENTRY: invoice-only loopback session and QR displayed; no device tested");
  await testid(current.page, "phone-invoice-dialog-cancel").click();
  await testid(current.page, "phone-invoice-dialog").waitFor({ state: "detached" });
  await testid(current.page, "photo-invoice").click();
  await testid(current.page, "photo-flow-pick").click();
  await current.page.waitForSelector('[data-testid="photo-review"], [data-testid="photo-flow-error"]', { timeout: 180000 });
  if (await testid(current.page, "photo-flow-error").count()) throw new Error(`Synthetic OCR failed: ${await testid(current.page, "photo-flow-error").innerText()}`);
  console.log("PHOTO OCR: built-in synthetic invoice reached review");
} catch (err) {
  failure = err;
} finally {
  if (current) {
    try {
      await closeAndVerify(current.app);
    } catch (cleanupError) {
      failure = failure ? new AggregateError([failure, cleanupError], "Trial test and cleanup failed") : cleanupError;
    }
  }
}
if (failure) throw failure;
