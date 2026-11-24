// UX-REF-NUMBERS (owner finding DEC-33 #2) — the invoice number and the sale receipt number are DIFFERENT
// series, and the statement shows the invoice's own number, never the sale's receipt number or its id.
//
// Built so the two numbers genuinely differ: two till sales first (receipt #1, #2), THEN an invoice issued
// on account — invoice #1, whose sale carries receipt #3. The screen must say «فاتورة #1» / «Invoice #1»,
// never «#3», never an id. A manual debt shows the owner's own reference. Offline, synthetic data only.
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-uxref-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
// The two opening till sales are sold from the bundled sample, so this profile starts as an explicit
// demo (the switch is honoured only while the ledger holds no merchant data — DEMO-FALLBACK).
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1", ALZABT_POS_DEMO_CATALOG: "1" };
delete env.ELECTRON_RUN_AS_NODE;

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ok = async (page, method, payload) => {
  const r = await page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
  if (!r.ok) throw new Error(`${method} refused: ${JSON.stringify(r.error)}`);
  return r.data;
};
const one = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return db.prepare(sql).get(...p);
  } finally {
    db.close();
  }
};

const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
const page = await app.firstWindow();
try {
  await signIn(page, "Cashier One", "1111");

  // 1 · two ordinary till sales → receipts #1 and #2
  for (const key of ["uxref-till-sale-0001", "uxref-till-sale-0002"]) {
    await ok(page, "createSale", { idempotencyKey: key, lines: [{ productId: "prod-0001", quantityMilli: 1000 }], paymentMethod: "cash", expectedTotalMinor: "250" });
  }

  // 2 · an invoice issued on account → invoice #1, sale receipt #3
  await ok(page, "saveCompanyProfile", {
    nameAr: "متجر المراجع", nameEn: "Refs Store", legalName: null, tagline: null, address: null, phone1: null, phone2: null, email: null,
    logoPath: null, taxpayerNumber: null, commercialRegister: null, vatNumber: null, taxEnabled: false, taxRatePercent: null, taxLabel: null,
  });
  const customer = (await ok(page, "createCustomer", { displayName: "زبون الأرقام", phone: null, address: null, note: null })).customer;
  const draft = (await ok(page, "createInvoiceDraft", undefined)).invoice.id;
  await ok(page, "addInvoiceLines", {
    invoiceId: draft,
    lines: [{ description: "بند", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "12.00" }],
    idempotencyKey: "uxref-invoice-batch-0001",
  });
  await ok(page, "updateInvoiceHeader", { invoiceId: draft, patch: { customerPartyId: customer.id } });
  await ok(page, "finalizeInvoice", { invoiceId: draft, issueOnAccount: true });

  const nums = one(
    "SELECT i.invoice_number AS inv, s.receipt_number AS rcpt, s.id AS saleId FROM invoices i JOIN sales s ON s.invoice_id = i.id WHERE i.id = ?",
    draft,
  );
  assert(Number(nums.inv) !== Number(nums.rcpt), `the two series genuinely differ here (invoice #${nums.inv}, its sale's receipt #${nums.rcpt})`);

  // 3 · the statement, in Arabic then English
  await testid(page, "tab-customers").click();
  await testid(page, "customers-search").fill("زبون الأرقام");
  await page.locator(`[data-customer="${customer.id}"]`).first().click();
  await testid(page, "customer-statement").waitFor({ state: "visible", timeout: 30000 });
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar", undefined, { timeout: 10000 });
  let src = (await testid(page, "statement-source").first().innerText()).trim();
  assert(src === `فاتورة #${Number(nums.inv)}`, `🔴 Arabic: the debt shows the INVOICE number («${src}»)`);
  assert(!src.includes(`#${Number(nums.rcpt)}`) && !UUID.test(src) && !src.includes(nums.saleId), `🔴 Arabic: not the sale's receipt #${nums.rcpt}, not an id`);
  await page.screenshot({ path: SHOTS + "UXREF-distinct-arabic.png" });

  await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en", undefined, { timeout: 10000 });
  src = (await testid(page, "statement-source").first().innerText()).trim();
  assert(src === `Invoice #${Number(nums.inv)}`, `🔴 English: the debt shows the invoice number («${src}»)`);
  await testid(page, "collect-open").first().click();
  const ref = (await testid(page, "collect-reference").innerText()).trim();
  assert(ref === `Invoice #${Number(nums.inv)}`, `🔴 English payment form: the same document («${ref}»)`);
  await page.screenshot({ path: SHOTS + "UXREF-distinct-english.png" });
  await testid(page, "collect-cancel").click();

  // 4 · the accounting links still carry the ids, untouched
  const ob = one("SELECT source_ref AS ref, sale_id AS sid FROM obligations WHERE party_id = ?", customer.id);
  assert(ob.ref === nums.saleId && ob.sid === nums.saleId, "the debt is still linked to its sale by id (nothing renumbered)");
  log("UX-REF-NUMBERS E2E PASSED");
} finally {
  await app.close();
}
