// INV-PAY-METHOD (owner, 2026-11-09) — an issued invoice records HOW its paid amount arrived, against the
// real app (renderer → preload → IPC → service → SQLite), on a throw-away profile.
//
//   node e2e/invoice-pay-method.mjs
//
// Proven: with money marked paid, the issue confirmation asks how it was received and cannot issue until
// it is answered (Whish needs its reference AND an unticked-by-default confirmation); Whish 5.00 of 5.00
// records ONE external tender with the reference and NO debt, and the issued sheet says so; cash 2.00 of
// 5.00 with no account is refused (INV-PARTIAL-DEBT, Option B) and, paid in full, records ONE cash tender; an unpaid
// invoice is asked nothing and records no method; a reused Whish reference refuses the issue and the
// invoice stays a draft; History names the method; the bridge refuses a paid issue with no method.
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-invpay-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DEMO_CATALOG: "1" };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

let passed = 0;
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
const read = (fn) => {
  const db = new Database(LEDGER, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const n = (sql, ...p) => read((db) => Number(db.prepare(sql).get(...p).n));
const footprint = () => ({
  sales: n("SELECT count(*) AS n FROM sales"),
  tenders: n("SELECT count(*) AS n FROM sale_tenders"),
  obligations: n("SELECT count(*) AS n FROM obligations"),
  references: n("SELECT count(*) AS n FROM external_references"),
  final: n("SELECT count(*) AS n FROM invoices WHERE status = 'final'"),
});
const invoiceSale = (number) =>
  read((db) => {
    const r = db
      .prepare(
        `SELECT s.id, s.payment_method AS m, s.payment_status AS st, s.paid_minor AS p, s.balance_due_minor AS b, s.tender_count AS tc,
                (SELECT group_concat(method || ':' || amount_minor || ':' || coalesce(reference, '-')) FROM sale_tenders t WHERE t.sale_id = s.id) AS tenders,
                (SELECT count(*) FROM obligations o WHERE o.source_ref = s.id) AS debts
           FROM sales s JOIN invoices i ON i.id = s.invoice_id WHERE i.invoice_number = ?`,
      )
      .get(number);
    return r && { ...r, p: Number(r.p), b: Number(r.b), tc: Number(r.tc), debts: Number(r.debts) };
  });

const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
assert((await app.evaluate(({ app }) => app.getPath("userData"))) === env.ALZABT_POS_USER_DATA, "throw-away profile, never a real ledger");

const testid = (id) => page.locator(`[data-testid="${id}"]`);
const direct = (method, payload) => page.evaluate(([m, p]) => window.pos[m](p), [method, payload]);
const okOf = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};

await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();
okOf(
  await direct("saveCompanyProfile", {
    nameAr: "متجر فحص طريقة الدفع", nameEn: null, legalName: null, tagline: null, address: null, phone1: null, phone2: null, email: null,
    logoPath: null, taxpayerNumber: null, commercialRegister: null, vatNumber: null, taxEnabled: false, taxRatePercent: null, taxLabel: null,
  }),
  "saveCompanyProfile",
);

/** Opens a new outgoing invoice with one 5.00 line and `paid` committed; leaves it at the confirmation. */
async function draftToConfirmation(paid, confirmTimeout = 30000) {
  // After an issue, the "issued" notice is a modal overlay: dismiss it (review later / OK), then close the
  // read-only sheet, which returns to the list. Found by this script's own runs, not assumed.
  for (const dismiss of ["review-later", "review-clear-ok"]) {
    if (await testid(dismiss).count()) await testid(dismiss).click();
  }
  if (await testid("sheet-close").count()) await testid("sheet-close").click();
  await testid("tab-invoices").click();
  await testid("new-invoice").click();
  await testid("invoice-mode-chooser").waitFor();
  await testid("mode-outgoing").click();
  await testid("add-row").waitFor();
  await testid("add-row").click();
  await testid("new-line-description").fill("صنف للفحص");
  await testid("new-line-quantity").fill("1");
  const select = page.locator('[data-testid="sheet-draft-row"]').last().locator('[data-testid^="unit-select-"]').first();
  const first = await select.evaluate((el) => Array.from(el.options).map((o) => o.value).find((v) => v && v !== "other"));
  await select.selectOption(first);
  await testid("new-line-price").fill("5.00");
  await testid("save-draft").click();
  await page.waitForSelector('[data-testid="sheet-draft-row"]', { state: "detached" });
  if (paid !== null) {
    await testid("sheet-paid").fill(paid);
    await testid("sheet-paid").press("Tab");
    await page.waitForFunction((v) => document.querySelector('[data-testid="sheet-paid"]')?.value === v, paid);
  }
  await testid("finalize").click();
  await testid("finalize-confirm").waitFor({ timeout: confirmTimeout });
}

// ── 1 · Whish, paid in full: the confirmation asks, and nothing issues until it is answered ───────
const b1 = footprint();
await draftToConfirmation("5.00");
assert((await testid("confirm-pay").count()) === 1, "with 5.00 marked paid, the confirmation asks how it was received");
assert(await testid("finalize-confirm-yes").isDisabled(), "🔴 …and cannot issue before it is answered");
await testid("confirm-pay-whish").click();
assert(await testid("finalize-confirm-yes").isDisabled(), "Whish chosen, no reference yet → still cannot issue");
await testid("confirm-pay-reference").fill("WH-INV-E2E-1");
assert(!(await testid("confirm-pay-confirmed").isChecked()) && (await testid("finalize-confirm-yes").isDisabled()), "the confirmation is never pre-ticked, and without it nothing issues");
await testid("confirm-pay-confirmed").check();
await page.screenshot({ path: SHOTS + "INVPAY1-confirm-whish.png" });
assert(!(await testid("finalize-confirm-yes").isDisabled()), "with the reference and the confirmation, it can issue");
await testid("finalize-confirm-yes").click();
await page.waitForSelector('[data-testid="finalized-notice"], .error', { timeout: 30000 });
if ((await testid("finalized-notice").count()) === 0) {
  await page.screenshot({ path: SHOTS + "INVPAY-debug-after-yes.png" });
  throw new Error("ASSERTION FAILED: the issue did not complete — on screen: " + (await page.locator(".error").first().innerText()));
}
const s1 = invoiceSale(1);
assert(s1 && s1.m === "external" && s1.st === "paid" && s1.p === 500 && s1.b === 0 && s1.tc === 1, `🔴 invoice #1: paid, Whish, one tender (${JSON.stringify(s1)})`);
assert(s1.tenders === "external:500:WH-INV-E2E-1" && s1.debts === 0, "🔴 ONE external tender of 5.00 with the reference, and NO debt");
const a1 = footprint();
assert(a1.final === b1.final + 1 && a1.references === b1.references + 1 && a1.obligations === b1.obligations, "one issued invoice, one registered reference, no obligation");
assert((await testid("sheet-payment").getAttribute("data-provider")) === "whish" && (await testid("sheet-payment").innerText()).includes("WH-INV-E2E-1"), "the issued sheet says Whish Money and its reference");
await page.screenshot({ path: SHOTS + "INVPAY2-issued-sheet.png" });

// ── 2 · Cash 2.00 of 5.00 WITHOUT an account: refused before the confirmation (INV-PARTIAL-DEBT) ───
// TRANSITION · INV-PARTIAL-DEBT (Option B, DEC-35h): this used to ISSUE as a partial invoice with one cash
// tender and NO debt (the 3.00 untracked). Now it is refused before the confirmation and nothing is
// written; the account path is proven in invoice-partial-debt.mjs. The same draft is then paid in full.
const b2 = footprint();
let refused = false;
try {
  await draftToConfirmation("2.00", 5000);
} catch {
  refused = true;
}
assert(refused && (await testid("finalize-confirm").count()) === 0, "🔴 a part-paid invoice with no account never reaches the confirmation");
assert((await page.locator(".error").first().innerText()).includes("مدفوعة جزئياً"), "…and the owner is told the remainder must go on a customer account");
assert(JSON.stringify(footprint()) === JSON.stringify(b2), "…and nothing was written");
await testid("sheet-paid").fill("5.00");
await testid("sheet-paid").press("Tab");
await page.waitForFunction(() => document.querySelector('[data-testid="sheet-paid"]')?.value === "5.00");
await testid("finalize").click();
await testid("finalize-confirm").waitFor();
await testid("confirm-pay-cash").click();
assert(!(await testid("finalize-confirm-yes").isDisabled()), "cash needs nothing more");
await testid("finalize-confirm-yes").click();
await testid("finalized-notice").waitFor();
const s2 = invoiceSale(2);
assert(s2.m === "cash" && s2.st === "paid" && s2.p === 500 && s2.b === 0 && s2.tenders === "cash:500:-", `🔴 invoice #2: paid in full, ONE cash tender (${JSON.stringify(s2)})`);
assert(s2.debts === 0, "a fully paid invoice creates no debt");

// ── 3 · Unpaid: asked nothing, records no method ─────────────────────────────────────────────────
await draftToConfirmation(null);
assert((await testid("confirm-pay").count()) === 0 && !(await testid("finalize-confirm-yes").isDisabled()), "with nothing paid the confirmation asks no method");
await testid("finalize-confirm-yes").click();
await testid("finalized-notice").waitFor();
const s3 = invoiceSale(3);
assert(s3.m === null && s3.tc === 0 && s3.st === "unpaid", "🔴 invoice #3: unpaid, NO method, NO tender — never invented");
assert((await testid("sheet-payment").count()) === 0, "…and its sheet shows no payment method");

// ── 4 · A reused Whish reference: the issue is refused, the invoice stays a draft ─────────────────
await draftToConfirmation("5.00");
await testid("confirm-pay-whish").click();
await testid("confirm-pay-reference").fill("WH-INV-E2E-1");
await testid("confirm-pay-confirmed").check();
const b4 = footprint();
await testid("finalize-confirm-yes").click();
await page.locator(".error").first().waitFor({ timeout: 15000 });
assert((await testid("finalized-notice").count()) === 0, "🔴 a reused Whish reference refuses the issue");
assert(JSON.stringify(footprint()) === JSON.stringify(b4), "…and NOTHING was written: no number, no sale, no tender, no reference");
assert(n("SELECT count(*) AS n FROM invoices WHERE status = 'draft'") === 1, "the invoice is still a draft");
await page.screenshot({ path: SHOTS + "INVPAY3-duplicate.png" });

// ── 5 · The bridge: a paid issue with NO method is refused ────────────────────────────────────────
const draftId = read((db) => db.prepare("SELECT id FROM invoices WHERE status = 'draft'").get().id);
const r5 = await direct("finalizeInvoice", { invoiceId: draftId });
assert(!r5.ok && r5.error.code === "INVOICE_PAYMENT_METHOD_REQUIRED", `🔴 the bridge refuses a paid issue with no method (${JSON.stringify(r5.error)})`);
const r5b = await direct("finalizeInvoice", { invoiceId: draftId, payment: { method: "card" } });
assert(!r5b.ok && r5b.error.code === "INVALID_INPUT", "…and a Card method never crosses the bridge");

// ── 6 · History names how each invoice was paid ───────────────────────────────────────────────────
await testid("tab-history").click();
const row = (id) => page.locator(`[data-testid="history-row"][data-sale="${id}"]`);
await row(s1.id).waitFor();
const t1 = (await row(s1.id).locator('[data-testid="history-payment"]').innerText()).trim();
const t2 = (await row(s2.id).locator('[data-testid="history-payment"]').innerText()).trim();
assert(t1.includes("ويش موني") && t1.includes("WH-INV-E2E-1"), `History, invoice #1: Whish and its reference (${t1})`);
assert(t2.includes("نقداً"), `History, invoice #2: cash (${t2})`);
assert(!t1.includes("غير مسجّلة") && !t2.includes("غير مسجّلة"), "🔴 neither says «الطريقة غير مسجّلة» any more");

// ── 7 · Ledger arithmetic for every invoice sale that records a method ────────────────────────────
const bad = read((db) =>
  Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM sales s WHERE s.source_type = 'invoice' AND s.payment_method IS NOT NULL
           AND (s.tender_count <> 1 OR s.paid_minor <> (SELECT sum(amount_minor) FROM sale_tenders t WHERE t.sale_id = s.id)
                OR EXISTS (SELECT 1 FROM sale_tenders t WHERE t.sale_id = s.id AND t.method <> s.payment_method))`,
      )
      .get().n,
  ),
);
assert(bad === 0 && n("SELECT count(*) AS n FROM obligations") === 0, "🔴 every invoice sale with a method: one tender = the paid amount, same method; no debt anywhere");

await app.close();
console.log(`INV-PAY-METHOD E2E PASSED — ${passed} checks`);
