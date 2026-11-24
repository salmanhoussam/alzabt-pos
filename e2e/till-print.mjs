// TILL-PRINT + F4 (DEC-35zz++) — the till receipt read from the ledger, printed and saved as PDF — in the real app.
// Synthetic data only. NO PHYSICAL PRINTER: print jobs go to a stubbed WebContents.print that RECORDS the options it
// receives (layout / page size); the PDF is a real file from Electron's own renderer; «no printer» is provoked by a
// stubbed getPrintersAsync returning []. Physical printing (80 mm roll, cut, thermal quality) is NOT claimed here.
//   A · seven sales: Cash · Whish · Split · On account · Partial · Paid from an advance (on screen) · Voided
//   B · the COMPLETION receipt of the advance sale = the ledger (sale total / ADV-000001 / left on account)
//   C · History reopens EVERY case from the ledger, marked as a reprint; 🔴 F4: the advance sale never reads
//       «amount due = sale total», and a LATER payment of its debt does not change its receipt
//   D · Print 80 mm + Print A5 (recorded jobs, original vs copy), a real PDF per case, «no printer» → message + PDF
//   E · English / LTR; a cashier prints what History shows them; printing wrote NOTHING; integrity ok
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = process.env.E2E_EXECUTABLE ?? createRequire(import.meta.url)("electron");
const APP_ARGS = process.env.E2E_EXECUTABLE ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const Database = createRequire(import.meta.url)("better-sqlite3");
const home = mkdtempSync(join(tmpdir(), "pos-e2e-tillprint-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1", ALZABT_POS_DEMO_CATALOG: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let passed = 0;
const assert = (c, m) => {
  if (!c) throw new Error("ASSERTION FAILED: " + m);
  passed += 1;
  console.log("• PASS", m);
};
const q = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return db.prepare(sql).all(...p);
  } finally {
    db.close();
  }
};
const n = (sql, ...p) => Number(Object.values(q(sql, ...p)[0])[0] ?? 0);
const footprint = () => JSON.stringify(["sales", "sale_tenders", "settlements", "obligations", "advance_applications", "advance_refunds", "receipts", "voids", "collection_documents"].map((t) => n(`SELECT count(*) FROM ${t}`)));
const digits = (s) => s.replace(/[^0-9.]/g, "");
const CUST = "زبون إيصالات البيع";

const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  const testid = (id) => page.locator(`[data-testid="${id}"]`);
  await signIn(page, "Cashier One", "1111"); // owner
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid("lang-toggle").click();
  // The stub printer RECORDS the options of each job (the native dialog cannot be driven; nothing is printed).
  await app.evaluate(({ webContents }) => {
    globalThis.__jobs = [];
    globalThis.__noPrinter = false;
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    const realGetPrinters = proto.getPrintersAsync;
    proto.getPrintersAsync = async function () {
      return globalThis.__noPrinter ? [] : [{ name: "E2E-STUB-PRINTER", displayName: "E2E stub", description: "", status: 0, isDefault: true, options: {} }];
    };
    globalThis.__realGetPrinters = realGetPrinters;
    proto.print = function (opts, cb) {
      globalThis.__jobs.push({ pageSize: opts?.pageSize ?? null, silent: opts?.silent ?? null });
      cb(true);
    };
  });
  const jobs = () => app.evaluate(() => globalThis.__jobs);

  // ── A · the sales (all but one through the real channels) ─────────────────────────────────────
  const ids = await page.evaluate(async (CUST) => {
    const must = (r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.data;
    };
    const L = [{ productId: "prod-0001", quantityMilli: 2000 }];
    const c = must(await window.pos.createCustomer({ displayName: CUST, phone: null, address: null, note: null })).customer.id;
    const cash = must(await window.pos.createSale({ idempotencyKey: "e2e-tp-cash-0001", lines: L, expectedTotalMinor: "500", paymentMethod: "cash" })).sale.id;
    const whish = must(await window.pos.createSale({ idempotencyKey: "e2e-tp-whish-001", lines: L, expectedTotalMinor: "500", paymentMethod: "external", whish: { reference: "WH-TP-E2E-1", fundsConfirmed: true } })).sale.id;
    const split = must(await window.pos.createSplitSale({ idempotencyKey: "e2e-tp-split-001", lines: L, expectedTotalMinor: "500", cashMinor: "200", whishMinor: "300", whish: { reference: "WH-TP-E2E-2", fundsConfirmed: true } })).sale.id;
    const credit = must(await window.pos.createCustomerCreditSale({ idempotencyKey: "e2e-tp-credit-01", lines: L, expectedTotalMinor: "500", customerId: c })).sale.id;
    const partial = must(await window.pos.createCustomerCreditSale({ idempotencyKey: "e2e-tp-partial-1", lines: L, expectedTotalMinor: "500", customerId: c, downPayment: { amountMinor: "200", method: "cash" } })).sale.id;
    const voided = must(await window.pos.createSale({ idempotencyKey: "e2e-tp-void-0001", lines: L, expectedTotalMinor: "500", paymentMethod: "cash" })).sale.id;
    must(await window.pos.voidSale({ saleId: voided, reason: "صنف خاطئ" }));
    must(await window.pos.recordAdvance({ customerId: c, amountMinor: "300", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "e2e-tp-adv-00001" }));
    await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-tp-adv-00001" });
    return { c, cash, whish, split, credit, partial, voided };
  }, CUST);
  assert(n("SELECT count(*) FROM sales") === 6 && n("SELECT count(*) FROM voids") === 1, "A: six sales recorded (cash, Whish, split, on account, partial, voided) and an advance of 3.00");

  // ── B · the advance sale ON SCREEN; its completion receipt is read back from the ledger ────────
  const product = (name) => page.locator("button.product", { hasText: name });
  await product("Espresso").click();
  await product("Espresso").click();
  await testid("sell-choose-customer").click();
  await testid("customer-finder").waitFor({ timeout: 30000 });
  await testid("customer-search").fill(CUST);
  await page.locator('[data-testid="customer-row"]').filter({ hasText: CUST }).first().click();
  await testid("customer-finder").waitFor({ state: "detached", timeout: 30000 });
  await testid("complete-sale").click();
  await page.locator('[data-testid="pay-on-advance"][data-advance="ADV-000001"]').waitFor({ timeout: 15000 });
  await testid("pay-on-advance").click();
  await testid("receipt-advance-applied").waitFor({ timeout: 30000 });
  const advSaleId = await page.evaluate(async () => (await window.pos.getSaleHistory({ limit: 1 })).data[0].sale.id);
  const dto = await page.evaluate(async (id) => (await window.pos.getSaleReceipt({ saleId: id })).data, advSaleId);
  const shown = async () => ({
    total: digits(await testid("receipt-sale-total").innerText()),
    paid: digits(await testid("receipt-advance-paid").innerText()),
    left: digits(await testid("receipt-debt-left").innerText()),
    number: await testid("receipt-advance-applied").getAttribute("data-advance"),
    due: await testid("receipt-balance-due").count(),
  });
  const onCompletion = await shown();
  assert(
    JSON.stringify(onCompletion) === JSON.stringify({ total: "5.00", paid: "3.00", left: "2.00", number: "ADV-000001", due: 0 }) &&
      dto.advanceApplied.applied.minor === "300" && dto.advanceApplied.debtLeft.minor === "200",
    `B: the completion receipt = the ledger: 5.00 / ADV-000001 3.00 / left 2.00, no «amount due» (${JSON.stringify(onCompletion)})`,
  );
  assert((await testid("receipt-print-bar").getAttribute("data-copy")) === "0" && (await testid("receipt-copy-note").count()) === 0, "B: right after the sale the receipt is the ORIGINAL (no «نسخة»)");
  await testid("receipt-print-80").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="receipt-print-note"]')?.textContent?.includes("أُرسل للطباعة"), undefined, { timeout: 15000 });
  await page.screenshot({ path: SHOTS + "TILLPRINT-completion-advance-arabic.png" });
  await testid("new-sale").click();
  ids.advance = advSaleId;

  // A LATER payment of the advance sale's debt (the rest, 2.00) — its receipt must NOT change (F4: facts of the sale).
  const later = await page.evaluate(async (c) => {
    const st = (await window.pos.getCustomerStatement({ customerId: c })).data;
    const open = st.obligations.find((o) => o.outstanding.minor === "200" && o.amount.minor === "500" && o.settlements.some((s) => s.advance));
    const r = await window.pos.recordCustomerPayment({ customerId: c, obligationId: open.id, idempotencyKey: "e2e-tp-later-pay1", amountMinor: "200", method: "cash" });
    return r.ok;
  }, ids.c);
  assert(later === true, "a LATER cash payment settled the rest of the advance sale's debt");

  // ── C · History reopens every case from the ledger, as a reprint ────────────────────────────────
  const fp = footprint();
  await testid("tab-history").click();
  const openSale = async (id) => {
    if ((await testid("history-back").count()) > 0) await testid("history-back").click();
    await page.locator(`[data-testid="history-row"][data-sale="${id}"]`).waitFor({ timeout: 30000 });
    await page.locator(`[data-testid="history-row"][data-sale="${id}"] [data-testid="history-open"]`).click();
    await testid("receipt-print-bar").waitFor({ timeout: 30000 });
  };
  await openSale(ids.advance);
  const fromHistory = await shown();
  assert(
    JSON.stringify(fromHistory) === JSON.stringify(onCompletion),
    `🔴 F4: History shows the SAME facts as the completion receipt — 5.00 / ADV-000001 3.00 / left 2.00 at sale time, no «amount due», even after the later payment (${JSON.stringify(fromHistory)})`,
  );
  assert((await testid("receipt-on-account-customer").innerText()).trim() === CUST, "F4: History names the customer of the sale");
  assert((await testid("receipt-print-bar").getAttribute("data-copy")) === "1" && (await testid("receipt-copy-note").count()) === 1, "C: from History it is a REPRINT («نسخة»)");
  await page.screenshot({ path: SHOTS + "TILLPRINT-history-advance-arabic.png" });

  const checks = [
    ["cash", async () => (await testid("receipt-method").getAttribute("data-method")) === "cash"],
    ["whish", async () => (await testid("receipt-reference").innerText()).includes("WH-TP-E2E-1")],
    ["split", async () => (await testid("receipt-tender").count()) === 2 && (await testid("receipt-tender-reference").innerText()).includes("WH-TP-E2E-2")],
    ["credit", async () => (await testid("receipt-on-account-customer").innerText()).trim() === CUST && digits(await testid("receipt-balance-due").innerText()) === "5.00"],
    ["partial", async () => digits(await testid("receipt-paid-amount").innerText()) === "2.00" && digits(await testid("receipt-balance-due").innerText()) === "3.00"],
    ["voided", async () => (await testid("voided-not-refund").count()) === 1],
  ];
  for (const [kind, check] of checks) {
    await openSale(ids[kind]);
    assert(await check(), `C: History reopens the ${kind.toUpperCase()} sale with its own facts`);
    const pdf = join(home, `receipt-${kind}.pdf`);
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialogSync = () => p;
    }, pdf);
    await testid("receipt-pdf").click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="receipt-print-note"]')?.textContent ?? "").includes(".pdf"), undefined, { timeout: 30000 });
    assert(existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === "%PDF-" && readFileSync(pdf).length > 1000, `D: a REAL PDF of the ${kind} receipt (offline)`);
  }

  // ── D · print jobs (recorded), original vs copy, layouts; and NO PRINTER ───────────────────────
  await openSale(ids.advance);
  const before = (await jobs()).length;
  await testid("receipt-print-80").click();
  await page.waitForFunction((k) => document.querySelector('[data-testid="receipt-print-note"]')?.textContent?.includes("أُرسل للطباعة"), undefined, { timeout: 15000 });
  await testid("receipt-print-a5").click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(500);
  const js = (await jobs()).slice(before);
  assert(js.length === 2 && js[0].pageSize?.width === 80000 && js[1].pageSize === "A5" && js.every((j) => j.silent === false), `D: two print jobs reached the (stub) printer — 80 mm wide then A5, through the Windows dialog (${JSON.stringify(js)})`);
  await app.evaluate(() => {
    globalThis.__noPrinter = true;
  });
  await testid("receipt-print-80").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="receipt-print-note"]')?.getAttribute("data-kind") === "warn", undefined, { timeout: 15000 });
  const noPrinter = (await testid("receipt-print-note").innerText()).trim();
  assert(noPrinter.includes("لا توجد طابعة مثبّتة") && (await jobs()).length === before + 2, `D: with NO printer installed: a clear message, no job, no crash («${noPrinter}»)`);
  await page.screenshot({ path: SHOTS + "TILLPRINT-no-printer-arabic.png" });
  const pdfNoPrinter = join(home, "receipt-no-printer.pdf");
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, pdfNoPrinter);
  await testid("receipt-pdf").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="receipt-print-note"]')?.textContent ?? "").includes(".pdf"), undefined, { timeout: 30000 });
  assert(existsSync(pdfNoPrinter) && readFileSync(pdfNoPrinter).subarray(0, 5).toString() === "%PDF-", "D: …and «Save PDF» still works without a printer");
  await app.evaluate(() => {
    globalThis.__noPrinter = false;
  });

  // ── E · English; cashier; nothing written ──────────────────────────────────────────────────────
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await openSale(ids.advance);
  const en = await page.locator('[data-testid="receipt-advance-applied"] dt').allInnerTexts();
  assert(en[0].trim() === "Sale total" && en[1].includes("ADV-000001") && en[2].trim() === "Left on account" && (await page.evaluate(() => document.documentElement.dir)) === "ltr", `E: English, left-to-right (${JSON.stringify(en)})`);
  await page.screenshot({ path: SHOTS + "TILLPRINT-history-advance-english.png" });
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar");
  assert(footprint() === fp, "🔴 E: reopening, printing (80 mm / A5 / no printer) and saving PDFs wrote NOTHING to the ledger");

  await testid("logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  await testid("tab-history").click();
  await openSale(ids.cash);
  const cBefore = (await jobs()).length;
  await testid("receipt-print-a5").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="receipt-print-note"]')?.textContent?.includes("أُرسل للطباعة"), undefined, { timeout: 15000 });
  assert((await jobs()).length === cBefore + 1 && (await testid("receipt-print-bar").getAttribute("data-copy")) === "1", "E: a CASHIER reprints a sale History shows them (marked as a copy)");
  const forged = await page.evaluate(async () => (await window.pos.printSaleReceipt({ saleId: "no-such-sale", layout: "a5", copy: true })).error?.code);
  assert(forged === "SALE_NOT_FOUND" && footprint() === fp, "E: an unknown sale is refused; still nothing written");
} finally {
  await app.close();
}
assert(q("PRAGMA integrity_check")[0].integrity_check === "ok" && q("PRAGMA foreign_key_check").length === 0, "integrity_check ok, no foreign-key violation");
console.log(`TILL PRINT E2E PASSED — ${passed} checks`);
