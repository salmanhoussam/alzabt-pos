// ADV-RECORD-CASH-WHISH (migration 20, owner DEC-35r/35s) — against the real app (or the INSTALLED one
// with E2E_EXECUTABLE). Offline, synthetic data only; nothing contacts Whish.
//
//   A · the owner receives a CASH advance: form → REVIEW → confirm → receipt ADV-000001; nothing is
//       recorded before «تأكيد القبض»; the receipt is acknowledged only when closed
//   B · a WHISH advance needs the reference AND the confirmation; the reference is registered once
//   C · the same reference again (written differently) is refused in Arabic, NOTHING written
//   D · the same request sent twice (a lost reply) returns the SAME receipt; one row
//   E · the receipt prints to a real PDF (A5) — the file exists and is a PDF
//   F · the owner's statement shows advances SEPARATE from debt, with balances
//   G · restart: an advance whose program died mid-way is listed from the LEDGER and finished under
//       its own key; a CASHIER records an advance and cannot read balances or correct
//   H · the ledger adds up
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-advance-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1", ALZABT_POS_DEMO_CATALOG: "1" };
delete env.ELECTRON_RUN_AS_NODE;

const log = (...a) => console.log("•", ...a);
let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed += 1;
  log("PASS", msg);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const q = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return db.prepare(sql).get(...p);
  } finally {
    db.close();
  }
};
const count = (sql, ...p) => Number(Object.values(q(sql, ...p))[0]);
const footprint = () => ({
  advances: count("SELECT count(*) FROM customer_advances"),
  attempts: count("SELECT count(*) FROM advance_attempts"),
  refs: count("SELECT count(*) FROM external_references WHERE owner_kind = 'advance'"),
  lastNo: count("SELECT last_no FROM document_numbers WHERE kind = 'advance'"),
});
const launch = async () => {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  return { app, page: await app.firstWindow() };
};
const toArabic = async (page) => {
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar", undefined, { timeout: 10000 });
};
const openCustomer = async (page, name) => {
  await testid(page, "tab-customers").click();
  await testid(page, "customers-search").fill(name);
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('[data-testid="customers-row"]')].some((r) => r.textContent.includes(n)),
    name,
    { timeout: 30000 },
  );
  await testid(page, "customers-row").filter({ hasText: name }).first().click();
  await testid(page, "customers-detail").waitFor({ timeout: 30000 });
};
const receiveAdvance = async (page, { amount, whish }) => {
  await testid(page, "customers-advance").click();
  await testid(page, "adv-sheet").waitFor({ timeout: 15000 });
  await testid(page, "adv-amount-input").fill(amount);
  if (whish) {
    await testid(page, "adv-channel-whish").check();
    await testid(page, "adv-reference-input").fill(whish);
    await testid(page, "adv-funds-confirmed").check();
  }
  await testid(page, "adv-review").click();
  await testid(page, "adv-review-step").waitFor({ timeout: 15000 });
};

let customerA = "";
let customerB = "";
let { app, page } = await launch();
try {
  await signIn(page, "Cashier One", "1111"); // the owner
  await toArabic(page);
  const made = await page.evaluate(async () => {
    const mk = async (displayName) => (await window.pos.createCustomer({ displayName, phone: null, address: null, note: null })).data.customer.id;
    return { a: await mk("زبون الدفعة أ"), b: await mk("زبون الدفعة ب") };
  });
  customerA = made.a;
  customerB = made.b;

  // ── A · cash: nothing is recorded before the confirmation; then ADV-000001 ─────────────────────────
  await openCustomer(page, "زبون الدفعة أ");
  await testid(page, "customers-advance").click();
  await testid(page, "adv-sheet").waitFor({ timeout: 15000 });
  assert(await testid(page, "adv-review").isDisabled(), "«مراجعة» is disabled with no amount");
  await testid(page, "adv-amount-input").fill("0");
  assert(await testid(page, "adv-review").isDisabled(), "a zero amount cannot be reviewed");
  await testid(page, "adv-amount-input").fill("25.00");
  await testid(page, "adv-review").click();
  await testid(page, "adv-review-step").waitFor({ timeout: 15000 });
  assert((await testid(page, "adv-review-amount").innerText()).includes("25.00"), "the review shows the amount");
  assert(footprint().advances === 0 && footprint().attempts === 0, "🔴 nothing is written at the review step");
  await page.screenshot({ path: SHOTS + "ADV-A-review-arabic.png" });
  await testid(page, "adv-confirm").click();
  await testid(page, "adv-receipt").waitFor({ timeout: 15000 });
  assert((await testid(page, "adv-number").innerText()).trim() === "ADV-000001", "receipt ADV-000001");
  assert((await testid(page, "adv-channel").innerText()).includes("نقداً"), "receipt says «نقداً»");
  const a1 = q("SELECT amount_minor AS amt, method, origin, received_by AS by FROM customer_advances");
  assert(Number(a1.amt) === 2500 && a1.method === "cash" && a1.origin === "receipt" && a1.by === "cashier-01", "ledger: 2500 cash receipt by the owner");
  assert(count("SELECT count(*) FROM advance_attempts WHERE resolution = 'recorded' AND acknowledged_at IS NULL") === 1, "not acknowledged while the receipt is on screen");
  await page.screenshot({ path: SHOTS + "ADV-A-receipt-arabic.png" });

  // ── E · the receipt as a real PDF ──────────────────────────────────────────────────────────────────
  const pdfPath = join(home, "ADV-000001.pdf");
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, pdfPath);
  await testid(page, "adv-pdf").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="adv-print-note"]')?.textContent ?? "").includes(".pdf"), undefined, { timeout: 30000 });
  assert(existsSync(pdfPath) && readFileSync(pdfPath).subarray(0, 5).toString() === "%PDF-", "🔴 a real PDF file was written");

  await testid(page, "adv-receipt-close").click();
  await testid(page, "adv-sheet").waitFor({ state: "detached", timeout: 15000 });
  assert(count("SELECT count(*) FROM advance_attempts WHERE acknowledged_at IS NULL") === 0, "closing the receipt acknowledges it");

  // ── B · Whish: reference + confirmation; registered once ──────────────────────────────────────────
  await receiveAdvance(page, { amount: "40.00", whish: "WH-ADV-E2E-1" });
  await testid(page, "adv-confirm").click();
  await testid(page, "adv-receipt").waitFor({ timeout: 15000 });
  assert((await testid(page, "adv-number").innerText()).trim() === "ADV-000002", "receipt ADV-000002");
  assert((await testid(page, "adv-channel").innerText()).includes("WH-ADV-E2E-1"), "the receipt shows the Whish reference");
  assert(footprint().refs === 1, "the reference is registered once, against the advance");
  await testid(page, "adv-receipt-close").click();

  // ── C · the same reference, written differently: refused, nothing written ───────────────────────────
  const beforeC = footprint();
  await receiveAdvance(page, { amount: "10.00", whish: "wh adv e2e 1" });
  await testid(page, "adv-confirm").click();
  await testid(page, "adv-error").waitFor({ timeout: 15000 });
  const errC = (await testid(page, "adv-error").innerText()).trim();
  assert(errC === "رقم مرجع ويش هذا مسجَّل من قبل. تحقّق من الرقم.", `🔴 refused in Arabic («${errC}»)`);
  const afterC = footprint();
  assert(afterC.advances === beforeC.advances && afterC.refs === beforeC.refs && afterC.lastNo === beforeC.lastNo, "🔴 no advance, no registration, no ADV number consumed");
  await page.screenshot({ path: SHOTS + "ADV-C-duplicate-reference-arabic.png" });
  await testid(page, "adv-back").click();
  await testid(page, "adv-cancel").click();

  // ── D · the same request twice (a lost reply): the SAME receipt, one row ───────────────────────────
  const beforeD = footprint();
  const twice = await page.evaluate(async (customerId) => {
    const req = { customerId, amountMinor: "700", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "e2e-adv-lost-reply-0001" };
    const one = await window.pos.recordAdvance(req);
    const two = await window.pos.recordAdvance(req);
    const forged = await window.pos.recordAdvance({ ...req, channel: "card", idempotencyKey: "e2e-adv-forged-0001" });
    return { one: one.data?.advance.number, two: two.data?.advance.number, dup: two.data?.duplicate, forged: forged.error?.code };
  }, customerA);
  assert(twice.one === "ADV-000003" && twice.two === "ADV-000003" && twice.dup === true, `🔴 the retry returns the SAME receipt (${JSON.stringify(twice)})`);
  assert(twice.forged === "PAYMENT_METHOD_NOT_ACCEPTED", "a forged Card advance is refused");
  assert(footprint().advances === beforeD.advances + 1, "🔴 exactly ONE advance for the two sends");

  // ── F · the owner's statement: advances separate from debt ─────────────────────────────────────────
  await testid(page, "tab-sell").click();
  await openCustomer(page, "زبون الدفعة أ");
  await testid(page, "adv-statement").waitFor({ timeout: 15000 });
  assert((await testid(page, "adv-stmt-line").count()) === 3, "three advances listed");
  assert((await testid(page, "adv-stmt-total").innerText()).includes("72.00"), "total advance balance 25 + 40 + 7 = 72.00");
  assert((await testid(page, "adv-pending").count()) === 1, "the forged-API advance (never acknowledged) is listed as recorded, with its receipt");
  await page.screenshot({ path: SHOTS + "ADV-F-statement-arabic.png" });
  await testid(page, "adv-pending-show").first().click();
  await testid(page, "adv-receipt").waitFor({ timeout: 15000 });
  await testid(page, "adv-receipt-close").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="adv-pending-row"]').length === 0, undefined, { timeout: 15000 });
} finally {
  await app.close();
}

// ── G · a program that died after the intent: listed from the LEDGER, finished under its own key ──────
{
  const db = new Database(LEDGER);
  try {
    db.prepare(
      "INSERT INTO advance_attempts (idempotency_key, customer_id, currency, amount_minor, channel, request_fingerprint, created_by, created_at) VALUES ('e2e-adv-crash-0001', ?, 'USD', 1500, 'cash', 'fp-e2e', 'cashier-02', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(customerB);
  } finally {
    db.close();
  }
}
({ app, page } = await launch());
try {
  await signIn(page, "Cashier Two", "2222"); // a cashier
  await toArabic(page);
  await testid(page, "tab-customers").click();
  await testid(page, "adv-pending").waitFor({ timeout: 30000 });
  const row = testid(page, "adv-pending-row").first();
  assert((await row.getAttribute("data-status")) === "open", "the interrupted advance is listed OPEN — answered from the ledger");
  // A NEW advance for that customer is held until the open one is settled.
  const held = await page.evaluate(
    async (customerId) => (await window.pos.recordAdvance({ customerId, amountMinor: "100", channel: "cash", idempotencyKey: "e2e-adv-held-0001" })).error?.code,
    customerB,
  );
  assert(held === "ADVANCE_UNRESOLVED", "🔴 a new advance for that customer is held (ADVANCE_UNRESOLVED)");
  await page.screenshot({ path: SHOTS + "ADV-G-pending-open-arabic.png" });
  // The forged fingerprint cannot be finished as an advance (the trigger demands the identical intent),
  // so this cashier closes it as NOT received — her own intent.
  await testid(page, "adv-pending-close").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="adv-pending-row"]').length === 0, undefined, { timeout: 15000 });
  assert(count("SELECT count(*) FROM advance_attempts WHERE idempotency_key = 'e2e-adv-crash-0001' AND resolution = 'not_recorded'") === 1, "closed as not received");
  assert(count("SELECT count(*) FROM customer_advances WHERE idempotency_key = 'e2e-adv-crash-0001'") === 0, "and no money row exists for it");

  // The cashier records an advance and cannot read balances or correct.
  await openCustomer(page, "زبون الدفعة ب");
  assert((await testid(page, "adv-statement").count()) === 0, "a cashier sees no advance statement");
  await receiveAdvance(page, { amount: "15.00" });
  await testid(page, "adv-confirm").click();
  await testid(page, "adv-receipt").waitFor({ timeout: 15000 });
  assert((await testid(page, "adv-number").innerText()).trim() === "ADV-000004", "the cashier's advance is ADV-000004 (no number consumed by the closed one)");
  await testid(page, "adv-receipt-close").click();
  const forged = await page.evaluate(async (customerId) => ({
    stmt: (await window.pos.getAdvanceStatement({ customerId })).error?.code,
    corr: (await window.pos.correctAdvance({ advanceId: "x", kind: "not_received", reason: "test", confirmNotReceived: true, idempotencyKey: "e2e-corr-forged-0001" })).error?.code,
  }), customerB);
  assert(forged.stmt === "NOT_AUTHORIZED" && forged.corr === "NOT_AUTHORIZED", `a cashier cannot read balances or correct (${JSON.stringify(forged)})`);
  assert(q("SELECT received_by AS by FROM customer_advances WHERE doc_no = 4").by === "cashier-02", "recorded under the cashier who received it");
} finally {
  await app.close();
}

// ── H · the ledger adds up ───────────────────────────────────────────────────────────────────────────
assert(q("PRAGMA integrity_check").integrity_check === "ok", "integrity_check ok");
assert(count("SELECT count(*) FROM customer_advances a WHERE NOT EXISTS (SELECT 1 FROM advance_attempts t WHERE t.idempotency_key = a.idempotency_key AND t.resolution = 'recorded')") === 0, "every advance has its recorded intent");
assert(count("SELECT count(*) FROM customer_advances") === 4 && count("SELECT last_no FROM document_numbers WHERE kind = 'advance'") === 4, "4 advances, ADV numbers 1..4 with no gap");
assert(count("SELECT count(*) FROM sales") + count("SELECT count(*) FROM settlements") + count("SELECT count(*) FROM obligations") === 0, "an advance wrote no sale, no settlement, no debt");
log(`CUSTOMER ADVANCE E2E PASSED — ${passed} checks`);
