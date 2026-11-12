// DEC-35z+ COL — numbered COL- receipts for debt collections — against the real app. Synthetic data only.
//   A · a customer owes two credit sales (5.00 + 2.50); an older collection without a number is seeded
//   B · the OWNER collects 2.00 CASH from the statement: COL-000001 appears inline with every field; PDF;
//       print (stubbed printer); the statement row links COL-000001; the REPRINT is the same and writes nothing
//   C · a WHISH collection in ENGLISH: COL-000002 with the ORIGINAL reference, registered once
//   D · one shared Whish transfer across both debts: ONE COL-000003, both rows point at it
//   E · a lost reply returns the SAME COL-; the old collection stays unnumbered; Daily Money counts each
//       payment once; a CASHIER is refused; integrity ok
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-col-"));
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
const colNo = () => n("SELECT last_no FROM document_numbers WHERE kind = 'collection'");
const digits = (s) => s.replace(/[^0-9.]/g, "");
const NAME = "زبون إيصالات التحصيل";

const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  const testid = (id) => page.locator(`[data-testid="${id}"]`);
  await signIn(page, "Cashier One", "1111"); // owner
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid("lang-toggle").click();
  await app.evaluate(({ webContents }) => {
    globalThis.__printJobs = 0;
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    proto.print = function (_opts, cb) {
      globalThis.__printJobs += 1;
      cb(true);
    };
  });
  const printJobs = () => app.evaluate(() => globalThis.__printJobs);

  // ── A ──────────────────────────────────────────────────────────────────────────────────────────
  const seeded = await page.evaluate(async (NAME) => {
    const must = (r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.data;
    };
    const c = must(await window.pos.createCustomer({ displayName: NAME, phone: null, address: null, note: null })).customer.id;
    must(await window.pos.createCustomerCreditSale({ idempotencyKey: "e2e-col-sale-0001", customerId: c, lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: "500" }));
    must(await window.pos.createCustomerCreditSale({ idempotencyKey: "e2e-col-sale-0002", customerId: c, lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: "250" }));
    const st = must(await window.pos.getCustomerStatement({ customerId: c }));
    const big = st.obligations.find((o) => o.amount.minor === "500").id;
    const small = st.obligations.find((o) => o.amount.minor === "250").id;
    return { c, big, small, inBefore: must(await window.pos.getDailyMoney({})).collections.total.minor };
  }, NAME);
  // An OLDER collection, written as a build before COL wrote it: the settlement row, no document.
  {
    const db = new Database(LEDGER);
    try {
      db.prepare(
        `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, settled_by, settled_at, business_date)
         VALUES ('legacy-e2e-1', ?, 'USD', 'legacy-e2e-collect-1', 'fp-legacy', 50, 'cash', 'cashier-01', '2026-01-02T09:00:00.000Z', '2026-01-02')`,
      ).run(seeded.small);
    } finally {
      db.close();
    }
  }
  assert(n("SELECT count(*) FROM collection_documents") === 0 && colNo() === 0, "A: two credit-sale debts and one OLD unnumbered collection; no COL yet");

  await testid("tab-customers").click();
  await testid("customers-search").fill(NAME);
  await page.waitForFunction((x) => [...document.querySelectorAll('[data-testid="customers-row"]')].some((r) => r.textContent.includes(x)), NAME, { timeout: 30000 });
  await testid("customers-row").filter({ hasText: NAME }).first().click();
  const card = (id) => page.locator(`[data-obligation="${id}"]`);
  await card(seeded.big).waitFor({ timeout: 30000 });

  // ── B · cash collection → COL-000001 ─────────────────────────────────────────────────────────
  await card(seeded.big).locator('[data-testid="collect-open"]').click();
  await testid("collect-amount").fill("2.00");
  await testid("collect-confirm").click();
  await testid("col-receipt").waitFor({ timeout: 30000 });
  const field = async (id) => (await testid(id).innerText()).trim();
  assert((await field("col-number")) === "COL-000001", "COL-000001 appears with the payment");
  assert((await field("col-customer")) === NAME && digits(await field("col-amount")) === "2.00" && (await field("col-method")) === "نقداً", "it names the customer, 2.00 received, «نقداً»");
  const lineText = (await testid("col-line").allInnerTexts()).map((s) => s.trim());
  assert(lineText.length === 1 && lineText[0].includes("#1") && digits(lineText[0].split("·")[1] ?? "") === "2.00", `it names the debt it paid (sale receipt #1 · 2.00) — got ${JSON.stringify(lineText)}`);
  assert((await field("col-by")) === "Cashier One", "and who received the money");
  assert(n("SELECT count(*) FROM collection_documents WHERE settlement_id IS NOT NULL") === 1 && colNo() === 1, "ledger: one document, linked to the settlement");
  await page.screenshot({ path: SHOTS + "COL-receipt-cash-arabic.png" });
  const pdf = join(home, "COL-000001.pdf");
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, pdf);
  await testid("col-pdf").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="col-print-note"]')?.textContent ?? "").includes(".pdf"), undefined, { timeout: 30000 });
  assert(existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === "%PDF-", "🔴 a real PDF of COL-000001 (offline)");
  await testid("col-print").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="col-print-note"]')?.textContent ?? "").includes("أُرسل للطباعة"), undefined, { timeout: 30000 });
  assert((await printJobs()) === 1, "print: one job sent");
  await testid("col-receipt-close").click();
  const settlementsAfterB = n("SELECT count(*) FROM settlements");
  const rowCol = card(seeded.big).locator('[data-testid="statement-settlement-col"]');
  assert((await rowCol.getAttribute("data-col")) === "COL-000001", "the statement row links COL-000001");
  assert((await card(seeded.small).locator('[data-testid="statement-settlement-col-none"]').count()) === 1, "🔴 the OLD collection says it has no receipt number — never numbered retroactively");
  await rowCol.click();
  await testid("col-receipt").waitFor({ timeout: 15000 });
  assert((await field("col-number")) === "COL-000001" && (await testid("col-duplicate").count()) === 0, "REPRINT: the same COL-000001");
  await testid("col-print").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="col-print-note"]')?.textContent ?? "").includes("أُرسل للطباعة"), undefined, { timeout: 30000 });
  assert((await printJobs()) === 2 && n("SELECT count(*) FROM settlements") === settlementsAfterB && colNo() === 1, "🔴 the reprint printed again and wrote NO payment, NO number");
  await page.screenshot({ path: SHOTS + "COL-statement-arabic.png" });
  await testid("col-receipt-close").click();

  // ── C · a Whish collection, in English ────────────────────────────────────────────────────────
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await card(seeded.big).locator('[data-testid="collect-open"]').click();
  await testid("collect-amount").fill("1.00");
  await testid("collect-method").selectOption("whish");
  await testid("collect-payment-reference").fill("WH-COL-E2E-1");
  await testid("collect-funds-confirmed").check();
  await testid("collect-confirm").click();
  await testid("col-receipt").waitFor({ timeout: 30000 });
  assert((await field("col-number")) === "COL-000002" && (await field("col-reference")) === "WH-COL-E2E-1", "EN: COL-000002 carries the ORIGINAL Whish reference");
  assert((await field("col-method")).startsWith("Whish") && (await page.evaluate(() => document.documentElement.dir)) === "ltr", "EN: «Whish», left-to-right");
  await page.screenshot({ path: SHOTS + "COL-receipt-whish-english.png" });
  assert(n("SELECT count(*) FROM external_references WHERE ref_display = 'WH-COL-E2E-1'") === 1, "the reference is registered ONCE (with the payment, not the document)");
  await testid("col-receipt-close").click();
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar");

  // ── D · one shared transfer across both debts → ONE COL ───────────────────────────────────────
  const shared = await page.evaluate(async (s) => {
    const r = await window.pos.recordAllocatedReceipt({
      customerId: s.c,
      idempotencyKey: "e2e-col-shared-0001",
      channel: "whish",
      reference: "WH-COL-SHARED",
      fundsConfirmed: true,
      currency: "USD",
      totalMinor: "300",
      allocations: [
        { obligationId: s.big, amountMinor: "100" },
        { obligationId: s.small, amountMinor: "200" },
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return { number: r.data.collection.number, lines: r.data.collection.lines.length };
  }, seeded);
  assert(shared.number === "COL-000003" && shared.lines === 2 && n("SELECT count(*) FROM collection_documents WHERE receipt_id IS NOT NULL") === 1, "🔴 one shared transfer → ONE COL-000003 with two lines (not one per debt)");

  // ── E · lost reply; Daily Money; cashier ──────────────────────────────────────────────────────
  const lost = await page.evaluate(async (s) => {
    const req = { customerId: s.c, obligationId: s.big, idempotencyKey: "e2e-col-lost-0001", amountMinor: "10", method: "cash" };
    const one = await window.pos.recordCustomerPayment(req);
    const two = await window.pos.recordCustomerPayment(req);
    return { one: one.data.collection.number, two: two.data.collection.number, dup: two.data.duplicate };
  }, seeded);
  assert(lost.one === "COL-000004" && lost.two === "COL-000004" && lost.dup === true && colNo() === 4, "🔴 a lost reply: the same request returns the SAME COL-000004; no new number");
  const day = await page.evaluate(async () => (await window.pos.getDailyMoney({})).data);
  const added = BigInt(day.collections.total.minor) - BigInt(seeded.inBefore);
  assert(added === 610n && day.collections.byChannel.cash === "210" && day.collections.byChannel.whish === "400", "🔴 Daily Money: 2.00 + 1.00 + 3.00 + 0.10 = 6.10 collected ONCE each (cash 2.10 / Whish 4.00) — documents add nothing");
  const st = await page.evaluate(async (c) => (await window.pos.getCustomerStatement({ customerId: c })).data, seeded.c);
  const cols = st.obligations.flatMap((o) => o.settlements.map((s) => s.collection?.number ?? null)).sort();
  assert(JSON.stringify(cols) === JSON.stringify(["COL-000001", "COL-000002", "COL-000003", "COL-000003", "COL-000004", null]), `the statement: every row's COL- (the shared one twice), the old one none — ${JSON.stringify(cols)}`);

  await testid("logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  const refused = await page.evaluate(async () => [(await window.pos.getCollectionReceipt({ collectionNo: 1 })).error?.code, (await window.pos.printCollectionReceipt({ collectionNo: 1 })).error?.code]);
  assert(refused[0] === "NOT_AUTHORIZED" && refused[1] === "NOT_AUTHORIZED", "🔴 a cashier cannot read or print a COL- (no new right)");
} finally {
  await app.close();
}
assert(q("PRAGMA integrity_check")[0].integrity_check === "ok" && q("PRAGMA foreign_key_check").length === 0, "integrity_check ok, no foreign-key violation");
console.log(`COLLECTION RECEIPTS E2E PASSED — ${passed} checks`);
