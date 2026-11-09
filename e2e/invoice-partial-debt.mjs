// INV-PARTIAL-DEBT — OPTION B (owner, DEC-35h, 2026-11-09) — a part-paid invoice puts its remainder on
// the customer's account, against the real app (renderer → preload → IPC → service → SQLite), on a
// throw-away profile.
//
//   node e2e/invoice-partial-debt.mjs
//
// Proven: a part-paid invoice with NO account is refused before the confirmation (nothing written, no
// number); with the account chosen and "issue on account" ticked, the confirmation shows the REMAINDER
// against the account and asks how the paid part arrived; Whish 2.00 of 5.00 issues ONE tender with the
// reference + ONE receivable of 3.00, atomically; the statement owes 3.00 and a cash collection clears
// it; on account with nothing left owed is refused; a cashier is refused; a repeat over the bridge
// verifies and writes nothing, a repeat with another payment is refused; a reused reference refuses the
// whole issue; and a backup restored into a NEW profile carries the invoice, tender and debt.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? require("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const home = mkdtempSync(join(tmpdir(), "pos-e2e-invpartial-"));
const USERDATA = join(home, "userData");
const LEDGER = join(USERDATA, "alzabt-pos-ledger.sqlite");
const Database = require("better-sqlite3");

let passed = 0;
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
const read = (file, fn) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const n = (sql, ...p) => read(LEDGER, (db) => Number(db.prepare(sql).get(...p).n));
const footprint = () => ({
  sales: n("SELECT count(*) AS n FROM sales"),
  tenders: n("SELECT count(*) AS n FROM sale_tenders"),
  obligations: n("SELECT count(*) AS n FROM obligations"),
  references: n("SELECT count(*) AS n FROM external_references"),
  final: n("SELECT count(*) AS n FROM invoices WHERE status = 'final'"),
});
const invoiceFacts = (file, number) =>
  read(file, (db) => {
    const r = db
      .prepare(
        `SELECT i.id AS invoiceId, s.id, s.payment_method AS m, s.payment_status AS st, s.paid_minor AS p, s.balance_due_minor AS b, s.tender_count AS tc,
                (SELECT group_concat(method || ':' || amount_minor || ':' || coalesce(reference, '-')) FROM sale_tenders t WHERE t.sale_id = s.id) AS tenders,
                (SELECT group_concat(direction || ':' || amount_minor) FROM obligations o WHERE o.sale_id = s.id) AS debts,
                (SELECT o.party_id FROM obligations o WHERE o.sale_id = s.id) AS party
           FROM sales s JOIN invoices i ON i.id = s.invoice_id WHERE i.invoice_number = ?`,
      )
      .get(number);
    return r && { ...r, p: Number(r.p), b: Number(r.b), tc: Number(r.tc) };
  });

async function launch(userData) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env: { ...process.env, ALZABT_POS_USER_DATA: userData, ALZABT_POS_DEMO_CATALOG: "1" } });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 60000 });
  return { app, page };
}
let { app, page } = await launch(USERDATA);
assert((await app.evaluate(({ app }) => app.getPath("userData"))) === USERDATA, "throw-away profile, never a real ledger");
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
    nameAr: "متجر فحص الدين الجزئي", nameEn: null, legalName: null, tagline: null, address: null, phone1: null, phone2: null, email: null,
    logoPath: null, taxpayerNumber: null, commercialRegister: null, vatNumber: null, taxEnabled: false, taxRatePercent: null, taxLabel: null,
  }),
  "saveCompanyProfile",
);
const ACCOUNT = "زبون الدين الجزئي";

/** A new outgoing invoice, one 5.00 line, `paid` committed; optionally on a NEW account. Clicks Finalize. */
async function draftAndFinalize(paid, { account = null, issueOnAccount = false } = {}) {
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
  if (account !== null) {
    await testid("account-choose").click();
    await testid("customer-finder").waitFor({ timeout: 30000 });
    if (account.create) {
      await testid("customer-new").click();
      await testid("customer-field-name").fill(account.name);
      await testid("customer-save").click();
    } else {
      await testid("customer-search").fill(account.name);
      await page.locator('[data-testid="customer-row"]').filter({ hasText: account.name }).first().click();
    }
    await testid("customer-finder").waitFor({ state: "detached", timeout: 30000 });
    await testid("sheet-account-name").waitFor({ timeout: 30000 });
  }
  if (issueOnAccount) await testid("account-issue").check();
  await testid("sheet-paid").fill(paid);
  await testid("sheet-paid").press("Tab");
  await page.waitForFunction((v) => document.querySelector('[data-testid="sheet-paid"]')?.value === v, paid);
  await testid("finalize").click();
}
const draftCount = () => n("SELECT count(*) AS n FROM invoices WHERE status = 'draft'");

// ── 1 · Part-paid with NO account: refused before the confirmation, nothing written ─────────────
const b1 = footprint();
await draftAndFinalize("2.00");
await page.locator(".error").first().waitFor({ timeout: 15000 });
assert((await testid("finalize-confirm").count()) === 0, "🔴 a part-paid invoice with no account never reaches the confirmation");
const e1 = await page.locator(".error").first().innerText();
assert(e1.includes("مدفوعة جزئياً") && e1.includes("حساب العميل"), `the owner is told the remainder must go on a customer account (${e1})`);
assert(JSON.stringify(footprint()) === JSON.stringify(b1), "…nothing written: no number, sale, tender or debt");
await page.screenshot({ path: SHOTS + "INVPART1-refused-no-account.png" });
// The bridge refuses it too (the service is the authority, not the screen).
const d1 = read(LEDGER, (db) => db.prepare("SELECT id FROM invoices WHERE status = 'draft'").get().id);
const r1 = await direct("finalizeInvoice", { invoiceId: d1, payment: { method: "cash" } });
assert(!r1.ok && r1.error.code === "CREDIT_PARTIAL_NEEDS_ACCOUNT", `🔴 the bridge refuses it: ${JSON.stringify(r1.error)}`);
await testid("leave-draft").click().catch(() => {});

// ── 2 · On account, Whish 2.00 of 5.00: the confirmation shows the remainder and asks the method ──
const b2 = footprint();
await draftAndFinalize("2.00", { account: { name: ACCOUNT, create: true }, issueOnAccount: true });
await testid("finalize-confirm").waitFor({ timeout: 30000 });
const conf = await testid("confirm-account").innerText();
assert(conf.includes(ACCOUNT) && conf.includes("3.00") && !conf.includes("5.00"), `🔴 the confirmation puts the REMAINDER 3.00 on the account (${conf})`);
assert((await testid("confirm-pay").count()) === 1 && (await testid("finalize-confirm-yes").isDisabled()), "it asks how the paid 2.00 arrived, and cannot issue before");
await testid("confirm-pay-whish").click();
await testid("confirm-pay-reference").fill("WH-PART-E2E-1");
assert(await testid("finalize-confirm-yes").isDisabled(), "Whish without the confirmation → still cannot issue");
await testid("confirm-pay-confirmed").check();
await page.screenshot({ path: SHOTS + "INVPART2-confirm-remainder.png" });
await testid("finalize-confirm-yes").click();
await testid("finalized-notice").waitFor({ timeout: 60000 });
assert((await testid("finalized-on-account").innerText()).includes(ACCOUNT), "the issued notice names the account that carries the remainder");
const s2 = invoiceFacts(LEDGER, 1);
assert(s2 && s2.m === "external" && s2.st === "partial" && s2.p === 200 && s2.b === 300 && s2.tc === 1, `🔴 invoice #1: partial, Whish (${JSON.stringify(s2)})`);
assert(s2.tenders === "external:200:WH-PART-E2E-1", `🔴 ONE Whish tender of the paid 2.00 with its reference (${s2.tenders})`);
assert(s2.debts === "receivable:300", `🔴 ONE receivable of the remainder 3.00 — a debt, not a payment (${s2.debts})`);
const a2 = footprint();
assert(
  a2.final === b2.final + 1 && a2.sales === b2.sales + 1 && a2.tenders === b2.tenders + 1 && a2.obligations === b2.obligations + 1 && a2.references === b2.references + 1,
  "exactly one invoice, one sale, one tender, one debt and one registered reference",
);
await page.screenshot({ path: SHOTS + "INVPART3-issued.png" });

// ── 3 · A repeat over the bridge (lost response): verifies, writes nothing; another payment refused ─
const r3 = await direct("finalizeInvoice", { invoiceId: s2.invoiceId, issueOnAccount: true, payment: { method: "external", whish: { reference: "WH-PART-E2E-1", fundsConfirmed: true } } });
assert(r3.ok && r3.data.invoice.invoiceNumber === 1, `🔴 the same request again verifies the issued invoice (${JSON.stringify(r3.ok ? "ok" : r3.error)})`);
const r3b = await direct("finalizeInvoice", { invoiceId: s2.invoiceId, issueOnAccount: true, payment: { method: "cash" } });
assert(!r3b.ok && r3b.error.code === "IDEMPOTENCY_CONFLICT", `🔴 …a repeat naming another payment is refused (${JSON.stringify(r3b.error)})`);
assert(JSON.stringify(footprint()) === JSON.stringify(a2), "…and neither wrote anything");

// ── 4 · On account with NOTHING left owed is refused; a reused reference refuses the whole issue ──
await draftAndFinalize("5.00", { account: { name: ACCOUNT, create: false }, issueOnAccount: true });
await page.locator(".error").first().waitFor({ timeout: 15000 });
assert((await page.locator(".error").first().innerText()).includes("مدفوعة بالكامل"), "🔴 on account with nothing left owed is refused before the confirmation");
await testid("leave-draft").click().catch(() => {});
const b4 = footprint();
await draftAndFinalize("1.00", { account: { name: ACCOUNT, create: false }, issueOnAccount: true });
await testid("finalize-confirm").waitFor({ timeout: 30000 });
await testid("confirm-pay-whish").click();
await testid("confirm-pay-reference").fill("WH-PART-E2E-1");
await testid("confirm-pay-confirmed").check();
await testid("finalize-confirm-yes").click();
await page.locator(".error").first().waitFor({ timeout: 15000 });
assert((await testid("finalized-notice").count()) === 0, "🔴 a reused Whish reference refuses the issue");
assert(JSON.stringify(footprint()) === JSON.stringify(b4), "…nothing written: no number, sale, tender, debt or reference");
await page.screenshot({ path: SHOTS + "INVPART4-duplicate-ref.png" });
await testid("leave-draft").click().catch(() => {});

// ── 5 · The statement owes 3.00; a cash collection clears it (the ordinary ledger path) ─────────
const partyId = s2.party;
const st = okOf(await direct("getCustomerStatement", { customerId: partyId }), "getCustomerStatement");
const ob = st.obligations.find((o) => o.amount.minor === "300");
assert(ob && st.paidSales.length === 0, `🔴 the statement holds the 3.00 remainder as a debt (${JSON.stringify(st.balances)})`);
okOf(await direct("recordCustomerPayment", { customerId: partyId, obligationId: ob.id, idempotencyKey: "invpart-e2e-collect-1", amountMinor: "300", method: "cash" }), "recordCustomerPayment");
const st2 = okOf(await direct("getCustomerStatement", { customerId: partyId }), "getCustomerStatement");
assert(st2.obligations.find((o) => o.id === ob.id).fullyPaid === true, "collected later in cash: the remainder is fully paid");
assert(invoiceFacts(LEDGER, 1).tenders === "external:200:WH-PART-E2E-1", "…and the invoice's own tender is untouched (the collection is a separate ledger entry)");

// ── 6 · A cashier: the account option is not offered, and the bridge refuses ─────────────────────
const linkedDraft = read(LEDGER, (db) => db.prepare("SELECT id FROM invoices WHERE status = 'draft' AND customer_party_id IS NOT NULL AND paid_minor = 100").get().id);
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier Two", "2222");
await testid("cart").waitFor();
const b6 = footprint();
const c6 = await direct("finalizeInvoice", { invoiceId: linkedDraft, issueOnAccount: true, payment: { method: "cash" } });
assert(!c6.ok && c6.error.code === "CREDIT_OWNER_ONLY", `🔴 a cashier cannot put a remainder on an account (${JSON.stringify(c6.error)})`);
const c6b = await direct("finalizeInvoice", { invoiceId: linkedDraft, payment: { method: "cash" } });
assert(!c6b.ok && c6b.error.code === "CREDIT_PARTIAL_NEEDS_ACCOUNT", `🔴 …nor issue the part-paid invoice without one (${JSON.stringify(c6b.error)})`);
assert(JSON.stringify(footprint()) === JSON.stringify(b6), "…and nothing was written");

// ── 7 · Ledger arithmetic ─────────────────────────────────────────────────────────────────────────
const bad = read(LEDGER, (db) =>
  Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM sales s JOIN invoices i ON i.id = s.invoice_id
          WHERE s.payment_status = 'partial'
            AND (s.paid_minor <> (SELECT coalesce(sum(amount_minor), 0) FROM sale_tenders t WHERE t.sale_id = s.id)
                 OR s.balance_due_minor <> (SELECT coalesce(sum(amount_minor), 0) FROM obligations o WHERE o.sale_id = s.id AND o.direction = 'receivable')
                 OR s.paid_minor + s.balance_due_minor <> s.total_minor)`,
      )
      .get().n,
  ),
);
assert(bad === 0, "🔴 every part-paid invoice sale: tenders = paid, receivable = balance, paid + balance = total");
await testid("logout").click();
await testid("select-cashier").waitFor();
await signIn(page, "Cashier One", "1111");
await testid("cart").waitFor();

// ── 8 · Full backup → restore into a NEW profile: the invoice, its tender and its debt are all there ─
const usb = join(home, "usb");
mkdirSync(usb, { recursive: true });
await app.evaluate(({ dialog }, p) => { dialog.showOpenDialogSync = () => [p]; }, usb);
const backup = okOf(await direct("exportFullBackup", undefined), "exportFullBackup");
assert(backup.status === "saved" && backup.complete === true, "a complete full backup was written");
await app.close();
const engine = require(join(APP, "dist", "main", "persistence", "restoreEngine.js"));
const restored = join(home, "restored-userData");
mkdirSync(restored, { recursive: true });
const pkg = join(backup.location, backup.folderName);
const inspected = engine.inspectRestorePackage(pkg);
engine.stageRestore({ userDataDir: restored, packageDir: pkg, consent: { manifestSha256: inspected.manifestSha256, acceptedMissingAssets: [] }, now: new Date() });
({ app, page } = await launch(restored));
await signIn(page, "Cashier One", "1111");
await page.locator('[data-testid="cart"]').waitFor();
const RLEDGER = join(restored, "alzabt-pos-ledger.sqlite");
const r8 = invoiceFacts(RLEDGER, 1);
assert(
  r8 && r8.st === "partial" && r8.tenders === "external:200:WH-PART-E2E-1" && r8.debts === "receivable:300",
  `🔴 after restore, invoice #1 still has its Whish tender and its 3.00 receivable (${JSON.stringify(r8)})`,
);
assert(read(RLEDGER, (db) => db.prepare("PRAGMA integrity_check").get().integrity_check) === "ok", "the restored ledger is sound");
await app.close();
console.log(`INV-PARTIAL-DEBT E2E PASSED — ${passed} checks`);
