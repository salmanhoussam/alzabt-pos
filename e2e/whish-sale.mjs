// P2 · SELL-WHISH-REFERENCE-AND-CONFIRMATION (owner, 2026-11-07) — against the real app (or the INSTALLED
// one with E2E_EXECUTABLE).
//
// A till sale paid by Whish Money is recorded only after the operator typed the reference AND ticked
// that the money really arrived (never pre-ticked). A reference already used — even written differently —
// is refused with the till's own sentence and leaves NOTHING behind; the cart survives and cash still
// works. A double click records one sale. The receipt and History show «ويش موني» and the reference.
// After a restart, a CASHIER can sell by Whish too. Offline, synthetic data only, nothing contacts Whish.
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-whish-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
// Sold from the bundled sample, so this profile starts as an explicit demo (DEMO-FALLBACK).
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
const product = (page, name) => page.locator("button.product", { hasText: name });
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
  sales: count("SELECT count(*) FROM sales"),
  tenders: count("SELECT count(*) FROM sale_tenders"),
  refs: count("SELECT count(*) FROM external_references"),
});
const launch = async () => {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  return { app, page: await app.firstWindow() };
};
const toArabic = async (page) => {
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar", undefined, { timeout: 10000 });
};
const openWhish = async (page) => {
  await product(page, "Espresso").click();
  await testid(page, "complete-sale").click();
  await testid(page, "pay-whish").click();
  await testid(page, "whish-step").waitFor({ state: "visible", timeout: 10000 });
};

let { app, page } = await launch();
try {
  await signIn(page, "Cashier One", "1111");
  await toArabic(page);

  // ── A · the Whish step: nothing records until BOTH the reference and the confirmation ──────────────
  await openWhish(page);
  const submit = testid(page, "whish-submit");
  assert(await submit.isDisabled(), "Whish: «تسجيل» is disabled with no reference and no confirmation");
  assert(!(await testid(page, "whish-confirm").isChecked()), "🔴 the confirmation is NOT pre-ticked");
  await testid(page, "whish-reference").fill("WH-E2E-777");
  assert(await submit.isDisabled(), "🔴 a reference alone does not record — the money must be confirmed");
  await testid(page, "whish-confirm").check();
  await testid(page, "whish-reference").fill("   ");
  assert(await submit.isDisabled(), "🔴 a confirmation with a blank reference does not record");
  await testid(page, "whish-reference").fill("WH-E2E-777");
  await testid(page, "whish-reference").press("Enter");
  assert(footprint().sales === 0, "🔴 Enter in the reference box records nothing (a scanner ends in Enter)");
  assert(await submit.isEnabled(), "reference + confirmation → «تسجيل البيعة — ويش موني» is enabled");
  await page.screenshot({ path: SHOTS + "P2-whish-step-arabic.png" });
  await submit.click();
  await testid(page, "receipt").waitFor({ state: "visible", timeout: 15000 });
  const method = testid(page, "receipt-method");
  assert((await method.getAttribute("data-method")) === "external" && (await method.getAttribute("data-provider")) === "whish", "receipt: method external, provider whish");
  assert((await method.innerText()).trim() === "ويش موني", `receipt says «ويش موني» («${(await method.innerText()).trim()}»)`);
  assert((await testid(page, "receipt-reference").innerText()).trim() === "WH-E2E-777", "receipt shows the reference WH-E2E-777");
  await page.screenshot({ path: SHOTS + "P2-whish-receipt-arabic.png" });
  const t1 = q("SELECT method, provider, reference, funds_confirmed AS fc, amount_minor AS amt FROM sale_tenders");
  const s1 = q("SELECT paid_minor AS paid, payment_method AS m, tender_count AS n FROM sales");
  assert(
    t1.method === "external" && t1.provider === "whish" && t1.reference === "WH-E2E-777" && Number(t1.fc) === 1 && Number(t1.amt) === Number(s1.paid) && Number(s1.n) === 1,
    `ledger: ONE external tender whish / WH-E2E-777 / confirmed / amount = paid (${JSON.stringify({ ...t1, amt: String(t1.amt) })})`,
  );
  assert(count("SELECT count(*) FROM external_references WHERE owner_kind = 'sale_tender' AND legacy = 0") === 1, "the reference is registered once");
  await testid(page, "new-sale").click();

  // ── B · the same reference, written differently: refused, NOTHING written, the cart survives ───────
  const before = footprint();
  await openWhish(page);
  await testid(page, "whish-reference").fill("wh e2e 777");
  await testid(page, "whish-confirm").check();
  await testid(page, "whish-submit").click();
  const err = page.locator(".dialog .error");
  await err.waitFor({ state: "visible", timeout: 10000 });
  const errText = (await err.innerText()).trim();
  assert(errText === "هذا المرجع مسجَّل مسبقاً لدفعة أخرى. لم تُسجَّل البيعة — تحقّق من المرجع.", `🔴 duplicate refused with the till's own sentence («${errText}»)`);
  assert(JSON.stringify(footprint()) === JSON.stringify(before), "🔴 nothing written: no sale, no tender, no registration");
  assert(await testid(page, "receipt").count() === 0, "no receipt was shown");
  assert((await testid(page, "whish-reference").inputValue()) === "wh e2e 777", "the typed reference is still there to correct");
  await page.screenshot({ path: SHOTS + "P2-whish-duplicate-arabic.png" });

  // ── C · back to the methods → cash still works on the SAME cart ───────────────────────────────────
  await testid(page, "whish-back").click();
  await testid(page, "pay-cash").click();
  await testid(page, "receipt").waitFor({ state: "visible", timeout: 15000 });
  assert((await testid(page, "receipt-method").getAttribute("data-method")) === "cash", "cash after a refused Whish: recorded as cash");
  assert((await testid(page, "receipt-reference").count()) === 0, "a cash receipt carries no reference");
  const cashT = q("SELECT method, provider, reference FROM sale_tenders WHERE sale_id = (SELECT id FROM sales ORDER BY receipt_number DESC LIMIT 1)");
  assert(cashT.method === "cash" && cashT.provider === null && cashT.reference === null, "the cash sale has ONE cash tender, no reference (P1 unchanged)");
  await testid(page, "new-sale").click();

  // ── D · a double click records ONE sale ──────────────────────────────────────────────────────────
  const beforeDbl = footprint();
  await openWhish(page);
  await testid(page, "whish-reference").fill("WH-DBL-42");
  await testid(page, "whish-confirm").check();
  await testid(page, "whish-submit").dblclick();
  await testid(page, "receipt").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(500);
  const afterDbl = footprint();
  assert(afterDbl.sales === beforeDbl.sales + 1 && afterDbl.tenders === beforeDbl.tenders + 1 && afterDbl.refs === beforeDbl.refs + 1, `🔴 double click → exactly one sale, one tender, one registration (${JSON.stringify(afterDbl)})`);
  await testid(page, "new-sale").click();

  // ── E · forged requests straight through window.pos: refused, nothing written ─────────────────────
  const beforeForged = footprint();
  const forged = await page.evaluate(async () => {
    const base = { lines: [{ productId: "prod-0001", quantityMilli: 1000 }], expectedTotalMinor: "250" };
    const r = async (k, extra) => (await window.pos.createSale({ idempotencyKey: k, ...base, ...extra })).error?.code ?? "OK";
    return {
      noEvidence: await r("forged-whish-0001", { paymentMethod: "external" }),
      notConfirmed: await r("forged-whish-0002", { paymentMethod: "external", whish: { reference: "WH-F-1", fundsConfirmed: false } }),
      extraKey: await r("forged-whish-0003", { paymentMethod: "external", whish: { reference: "WH-F-2", fundsConfirmed: true, provider: "bank_transfer" } }),
      onCash: await r("forged-whish-0004", { paymentMethod: "cash", whish: { reference: "WH-F-3", fundsConfirmed: true } }),
      reused: await r("forged-whish-0005", { paymentMethod: "external", whish: { reference: "WH-DBL-42", fundsConfirmed: true } }),
    };
  });
  log("forged:", JSON.stringify(forged));
  assert(forged.noEvidence === "INVALID_INPUT", "forged: external without evidence → INVALID_INPUT");
  assert(forged.notConfirmed === "FUNDS_NOT_CONFIRMED", "forged: not confirmed → FUNDS_NOT_CONFIRMED");
  assert(forged.extraKey === "INVALID_INPUT", "forged: an extra key (a provider choice) → INVALID_INPUT — bank transfer cannot be smuggled in");
  assert(forged.onCash === "INVALID_INPUT", "forged: Whish evidence on a cash sale → INVALID_INPUT");
  assert(forged.reused === "DUPLICATE_PAYMENT_REFERENCE", "forged: a reused reference → DUPLICATE_PAYMENT_REFERENCE");
  assert(JSON.stringify(footprint()) === JSON.stringify(beforeForged), "🔴 forged requests wrote nothing");

  // ── F · History says Whish Money and the reference, in Arabic and in English ──────────────────────
  await testid(page, "tab-history").click();
  const whishRow = page.locator('tr[data-payment-method="external"]').first();
  await whishRow.waitFor({ state: "visible", timeout: 15000 });
  const arRow = (await whishRow.locator('[data-testid="history-payment"]').innerText()).trim();
  assert(arRow.includes("ويش موني") && arRow.includes("WH-DBL-42"), `History (AR): «${arRow}»`);
  await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en", undefined, { timeout: 10000 });
  const enRow = (await whishRow.locator('[data-testid="history-payment"]').innerText()).trim();
  assert(enRow.includes("Whish Money") && enRow.includes("WH-DBL-42"), `History (EN): «${enRow}»`);
  await page.screenshot({ path: SHOTS + "P2-whish-history-english.png" });
  await testid(page, "tab-sell").click();
  assert((await page.locator('[data-testid="pay-external"]').count()) === 0, "the plain «External transfer» button is gone");
  await product(page, "Espresso").click();
  await testid(page, "complete-sale").click();
  assert((await testid(page, "pay-whish").innerText()).trim() === "Whish Money", "EN: the button reads «Whish Money»");
  await page.screenshot({ path: SHOTS + "P2-whish-methods-english.png" });
  await page.keyboard.press("Escape");
} finally {
  await app.close();
}

// ── G · restart: everything persisted; a CASHIER sells by Whish ──────────────────────────────────────
({ app, page } = await launch());
try {
  await signIn(page, "Cashier Two", "2222");
  await toArabic(page);
  await testid(page, "tab-history").click();
  await page.locator('tr[data-payment-method="external"]').first().waitFor({ state: "visible", timeout: 15000 });
  assert((await page.locator('tr[data-payment-method="external"]').count()) === 2, "after restart: both Whish sales are in History");
  await testid(page, "tab-sell").click();
  await openWhish(page);
  await testid(page, "whish-reference").fill("WH-CASHIER-1");
  await testid(page, "whish-confirm").check();
  await testid(page, "whish-submit").click();
  await testid(page, "receipt").waitFor({ state: "visible", timeout: 15000 });
  assert((await testid(page, "receipt-reference").innerText()).trim() === "WH-CASHIER-1", "a cashier records a Whish sale with its reference");
  const cashierRow = q("SELECT s.cashier_id AS c, t.reference AS r FROM sales s JOIN sale_tenders t ON t.sale_id = s.id ORDER BY s.receipt_number DESC LIMIT 1");
  assert(cashierRow.c === "cashier-02" && cashierRow.r === "WH-CASHIER-1", "recorded under the cashier, with the reference");
} finally {
  await app.close();
}

// ── H · the ledger adds up ───────────────────────────────────────────────────────────────────────────
assert(q("PRAGMA integrity_check").integrity_check === "ok", "integrity_check ok");
assert(count("SELECT count(*) FROM sales s WHERE s.tender_count <> (SELECT count(*) FROM sale_tenders t WHERE t.sale_id = s.id) OR (s.tender_count > 0 AND s.paid_minor <> (SELECT sum(amount_minor) FROM sale_tenders t WHERE t.sale_id = s.id))") === 0, "every sale: tenders = declared, Σ = paid");
assert(count("SELECT count(*) FROM sale_tenders WHERE method = 'external' AND (provider <> 'whish' OR reference IS NULL OR funds_confirmed IS NOT 1)") === 0, "every external tender is Whish with a reference and a confirmation");
assert(count("SELECT count(*) FROM obligations") === 0, "no debt was created by any of these paid sales");
log(`WHISH SALE E2E PASSED — ${passed} checks`);
