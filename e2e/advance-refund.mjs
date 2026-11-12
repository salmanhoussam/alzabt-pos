// DEC-35z+ REF — CASH REFUND OF A CUSTOMER ADVANCE — against the real app. Synthetic data only.
//   A · customer A holds a 10.00 CASH advance (ADV-000001); customer B a 20.00 WHISH advance (ADV-000002)
//   B · the OWNER refunds 4.00 of A's from the statement: review writes nothing; a repeated click gives ONE
//       REF-000001; the receipt states every field; a real PDF; print (stubbed printer) — nothing written
//   C · the statement lists REF-000001 with the balance 6.00; the REPRINT shows the SAME REF-, writes nothing
//   D · the rest (6.00) → REF-000002, balance 0, no refund button; above the balance is refused
//   E · B's WHISH advance, in ENGLISH: refunded in CASH, the note says nothing went back through Whish,
//       no reference registered again
//   F · Daily Money (panel = ledger): money in unchanged, refunds 30.00 CASH out, no Whish out, net down 30
//   G · a lost reply returns the SAME REF-; a CASHIER is refused (refund + reprint); integrity ok
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-advref-"));
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
const refNo = () => n("SELECT last_no FROM document_numbers WHERE kind = 'advance_refund'");
const digits = (s) => s.replace(/[^0-9.]/g, "");
const A = "زبون الاسترداد النقدي";
const B = "زبون استرداد ويش";

const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
try {
  const page = await app.firstWindow();
  const testid = (id) => page.locator(`[data-testid="${id}"]`);
  await signIn(page, "Cashier One", "1111"); // owner
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid("lang-toggle").click();
  // A stub printer in MAIN: the native print dialog cannot be driven, so `print` is replaced on the
  // WebContents prototype and only COUNTS the jobs (the document itself is asserted by unit tests).
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
  const seeded = await page.evaluate(
    async ([A, B]) => {
      const must = (r) => {
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return r.data;
      };
      const a = must(await window.pos.createCustomer({ displayName: A, phone: null, address: null, note: null })).customer.id;
      const b = must(await window.pos.createCustomer({ displayName: B, phone: null, address: null, note: null })).customer.id;
      must(await window.pos.recordAdvance({ customerId: a, amountMinor: "1000", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "e2e-ref-adv-0001" }));
      await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-ref-adv-0001" });
      must(await window.pos.recordAdvance({ customerId: b, amountMinor: "2000", channel: "whish", reference: "WH-REF-E2E-1", fundsConfirmed: true, idempotencyKey: "e2e-ref-adv-0002" }));
      await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-ref-adv-0002" });
      const day = must(await window.pos.getDailyMoney({}));
      return { a, b, inBefore: day.moneyIn.total.minor, outBefore: day.moneyOut.total.minor, netCashBefore: day.net.byChannel.cash };
    },
    [A, B],
  );
  const refsBefore = q("SELECT * FROM external_references");
  const advRowsBefore = q("SELECT * FROM customer_advances ORDER BY doc_no");
  assert(n("SELECT count(*) FROM customer_advances") === 2 && refsBefore.length === 1, "A: a 10.00 cash advance and a 20.00 Whish advance (its reference registered once)");

  const openCustomer = async (name) => {
    await testid("tab-customers").click();
    await testid("customers-search").fill(name);
    await page.waitForFunction((x) => [...document.querySelectorAll('[data-testid="customers-row"]')].some((r) => r.textContent.includes(x)), name, { timeout: 30000 });
    await testid("customers-row").filter({ hasText: name }).first().click();
    await testid("adv-statement").waitFor({ timeout: 30000 });
  };

  // ── B · the owner refunds 4.00 of A's advance ─────────────────────────────────────────────────
  await openCustomer(A);
  await testid("adv-stmt-refund").click();
  await testid("ref-sheet").waitFor({ timeout: 15000 });
  assert(digits(await testid("ref-available").innerText()) === "10.00", "the sheet shows the available balance 10.00 before anything");
  assert((await testid("ref-amount-input").inputValue()) === "10.00", "the amount is PREFILLED with the whole balance (editable)");
  await testid("ref-amount-input").fill("4.00");
  assert((await testid("ref-review-open").isDisabled()) === true, "no reason → no review: the reason is mandatory");
  await testid("ref-reason-input").fill("الزبون طلب جزءاً من رصيده");
  await testid("ref-review-open").click();
  await testid("ref-review").waitFor({ timeout: 15000 });
  assert(digits(await testid("ref-review-amount").innerText()) === "4.00" && n("SELECT count(*) FROM advance_refunds") === 0 && refNo() === 0, "🔴 the REVIEW shows 4.00 cash from ADV-000001 and writes NOTHING (no row, no REF number)");
  await page.screenshot({ path: SHOTS + "REF-review-arabic.png" });
  // A repeated click: two clicks dispatched before React can re-render — ONE request, ONE REF-.
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="ref-confirm"]');
    b.click();
    b.click();
  });
  await testid("ref-receipt").waitFor({ timeout: 30000 });
  assert(n("SELECT count(*) FROM advance_refunds") === 1 && refNo() === 1 && (await testid("ref-duplicate").count()) === 0, "🔴 a repeated click: ONE refund, REF counter 1, no «already recorded» shown");
  const field = async (id) => (await testid(id).innerText()).trim();
  assert((await field("ref-number")) === "REF-000001", "receipt REF-000001");
  assert((await field("ref-customer")) === A, "receipt names the customer");
  assert(digits(await field("ref-amount")) === "4.00", "receipt: amount refunded 4.00");
  assert((await field("ref-method")) === "نقداً", "receipt: refunded in «نقداً»");
  assert((await field("ref-advance")).includes("ADV-000001"), "receipt: from ADV-000001");
  assert((await field("ref-reason")) === "الزبون طلب جزءاً من رصيده", "receipt: the reason");
  assert((await field("ref-by")) === "Cashier One", "receipt: who refunded (the owner)");
  assert(digits(await field("ref-unused")) === "6.00", "receipt: 6.00 left on the advance — read back from the ledger");
  assert((await testid("ref-whish-note").count()) === 0, "a cash advance carries no Whish note");
  await page.screenshot({ path: SHOTS + "REF-receipt-arabic.png" });
  const row = q("SELECT amount_minor AS a, method, reason, refunded_by AS by FROM advance_refunds")[0];
  assert(Number(row.a) === 400 && row.method === "cash" && row.by === "cashier-01", "ledger: 400 cash by the owner");
  assert(JSON.stringify(q("SELECT * FROM customer_advances ORDER BY doc_no")) === JSON.stringify(advRowsBefore), "🔴 the ADV rows are byte-for-byte unchanged");

  // PDF + print from the fresh receipt.
  const pdfPath = join(home, "REF-000001.pdf");
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, pdfPath);
  await testid("ref-pdf").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="ref-print-note"]')?.textContent ?? "").includes(".pdf"), undefined, { timeout: 30000 });
  assert(existsSync(pdfPath) && readFileSync(pdfPath).subarray(0, 5).toString() === "%PDF-", "🔴 a real PDF file was written (offline)");
  await testid("ref-print").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="ref-print-note"]')?.textContent ?? "").includes("أُرسل للطباعة"), undefined, { timeout: 30000 });
  assert((await printJobs()) === 1 && n("SELECT count(*) FROM advance_refunds") === 1 && refNo() === 1, "print: one job sent; printing and the PDF wrote nothing");
  await testid("ref-receipt-close").click();
  await testid("ref-sheet").waitFor({ state: "detached", timeout: 15000 });

  // ── C · the statement and the REPRINT ─────────────────────────────────────────────────────────
  await page.waitForFunction(() => document.querySelector('[data-testid="adv-stmt-line"]')?.getAttribute("data-unused") === "600", undefined, { timeout: 15000 });
  assert((await testid("adv-stmt-refunded").getAttribute("data-ref-number")) === "REF-000001", "the advance statement lists REF-000001 under ADV-000001, balance 6.00");
  assert((await testid("adv-stmt-refunded").innerText()).includes("الزبون طلب جزءاً من رصيده"), "…with its reason");
  await page.screenshot({ path: SHOTS + "REF-statement-arabic.png" });
  await testid("adv-stmt-ref-open").click();
  await testid("ref-reprint").waitFor({ timeout: 15000 });
  assert((await field("ref-number")) === "REF-000001" && digits(await field("ref-amount")) === "4.00" && (await testid("ref-unused").count()) === 0, "REPRINT: the SAME REF-000001, 4.00, and no live balance");
  const pdf2 = join(home, "REF-000001-reprint.pdf");
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, pdf2);
  await testid("ref-pdf").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="ref-print-note"]')?.textContent ?? "").includes(".pdf"), undefined, { timeout: 30000 });
  await testid("ref-print").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="ref-print-note"]')?.textContent ?? "").includes("أُرسل للطباعة"), undefined, { timeout: 30000 });
  assert(existsSync(pdf2) && readFileSync(pdf2).subarray(0, 5).toString() === "%PDF-" && (await printJobs()) === 2, "reprint: a second PDF and a second print job");
  assert(n("SELECT count(*) FROM advance_refunds") === 1 && refNo() === 1, "🔴 the reprint created NO second refund and consumed no REF number");
  await testid("ref-receipt-close").click();

  // ── D · the rest: 6.00 → REF-000002; above the balance refused ─────────────────────────────────
  await testid("adv-stmt-refund").click();
  await testid("ref-sheet").waitFor({ timeout: 15000 });
  assert((await testid("ref-amount-input").inputValue()) === "6.00", "the sheet now offers the 6.00 left");
  // ── DEC-35zz++ Option A: a SECOND refund of the same advance TODAY names the earlier one and needs «new refund» ──
  await testid("ref-reason-input").fill("إغلاق الرصيد");
  const todayItems = await page.locator('[data-testid="ref-today-item"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-ref-number")));
  assert(JSON.stringify(todayItems) === JSON.stringify(["REF-000001"]), `Option A: the sheet names today's earlier REF-000001 before another refund (${JSON.stringify(todayItems)})`);
  assert((await testid("ref-review-open").isDisabled()) === true, "🔴 Option A: no review until the owner confirms it is a NEW refund");
  await page.screenshot({ path: SHOTS + "REF-today-warning-arabic.png" });
  await testid("ref-repeat-confirm").check();
  assert((await testid("ref-review-open").isEnabled()) === true, "Option A: confirmed → the review opens");
  await testid("ref-amount-input").fill("6.01");
  await testid("ref-reason-input").fill("إغلاق الرصيد");
  await testid("ref-review-open").click();
  await testid("ref-confirm").click();
  await testid("ref-error").waitFor({ timeout: 15000 });
  assert((await field("ref-error")) === "المبلغ أكبر من الرصيد المتاح في الدفعة المقدّمة." && n("SELECT count(*) FROM advance_refunds") === 1 && refNo() === 1, "🔴 above the balance: refused in Arabic, nothing written, no REF number used");
  // As on the ADV sheet: after a refusal the review stays locked; the owner goes BACK to edit.
  await testid("ref-back").click();
  await testid("ref-amount-input").fill("6.00");
  await testid("ref-review-open").click();
  await testid("ref-confirm").click();
  await testid("ref-receipt").waitFor({ timeout: 30000 });
  assert((await field("ref-number")) === "REF-000002" && digits(await field("ref-unused")) === "0.00", "REF-000002 for 6.00 — the advance is at 0.00");
  await testid("ref-receipt-close").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="adv-stmt-line"]')?.getAttribute("data-unused") === "0", undefined, { timeout: 15000 });
  assert((await testid("adv-stmt-refund").count()) === 0 && (await testid("adv-stmt-refunded").count()) === 2, "a used-up advance offers no refund; both REF- are listed");

  // ── E · B's WHISH advance, in ENGLISH ─────────────────────────────────────────────────────────
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await openCustomer(B);
  await testid("adv-stmt-refund").click();
  await testid("ref-sheet").waitFor({ timeout: 15000 });
  assert((await field("ref-sheet-whish-note")).includes("Nothing is sent back through Whish Money"), "EN: before anything, the sheet says the refund is CASH, not back through Whish");
  await testid("ref-reason-input").fill("Customer cancelled the order");
  await testid("ref-review-open").click();
  await testid("ref-confirm").click();
  await testid("ref-receipt").waitFor({ timeout: 30000 });
  assert((await field("ref-number")) === "REF-000003" && digits(await field("ref-amount")) === "20.00", "EN: REF-000003 for 20.00");
  assert((await field("ref-method")) === "Cash" && (await field("ref-advance")).includes("WH-REF-E2E-1"), "EN: refunded in Cash; the original Whish reference is shown");
  assert((await field("ref-whish-note")).includes("Nothing is sent back through Whish Money"), "EN: the receipt says nothing went back through Whish");
  assert((await page.evaluate(() => document.documentElement.dir)) === "ltr", "EN: left-to-right");
  await page.screenshot({ path: SHOTS + "REF-receipt-whish-english.png" });
  await testid("ref-receipt-close").click();
  assert(JSON.stringify(q("SELECT * FROM external_references")) === JSON.stringify(refsBefore), "🔴 no Whish reference registered again");
  await testid("lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar");

  // ── F · Daily Money — the panel equals the ledger ─────────────────────────────────────────────
  const day = await page.evaluate(async () => (await window.pos.getDailyMoney({})).data);
  assert(day.moneyIn.total.minor === seeded.inBefore, "🔴 money in unchanged: a refund is not a receipt");
  assert(day.refunds.total.minor === "3000" && day.refunds.byChannel.cash === "3000" && day.refunds.byChannel.whish === "0", "🔴 refunds = 30.00, all CASH (the Whish advance too), no Whish out");
  assert(BigInt(day.moneyOut.total.minor) === BigInt(seeded.outBefore) + 3000n && BigInt(day.net.byChannel.cash) === BigInt(seeded.netCashBefore) - 3000n, "money out +30.00; net cash −30.00");
  assert(day.refunds.total.minor === String(n("SELECT sum(amount_minor) FROM advance_refunds")), "the report's refunds = the ledger's refunds");
  await testid("tab-today").click();
  await testid("dm-panel").waitFor({ timeout: 30000 });
  const cell = async (id) => digits((await testid(id).innerText()).trim());
  assert((await cell("dm-refunds-cash")) === "30.00" && (await cell("dm-refunds-total")) === "30.00", "panel: «استرداد نقدي (REF)» 30.00 in the Cash column");
  assert((await cell("dm-out-total")) === (Number(day.moneyOut.total.minor) / 100).toFixed(2), "panel: money out = the report");
  // 🔴 F3: the Whish advance refunded in CASH puts the cash column BELOW zero. The panel used to throw on
  // a negative figure and blank the whole window; it must show the sign, never drop it.
  const netCash = (await testid("dm-net-cash").innerText()).trim();
  assert(day.net.byChannel.cash === "-2000" && netCash.startsWith("−") && digits(netCash) === "20.00", `panel: net cash is shown NEGATIVE «${netCash}» (ledger −20.00) — not dropped, not a crash`);
  assert(digits(await testid("dm-net-whish").innerText()) === "20.00" && !(await testid("dm-net-whish").innerText()).includes("−"), "panel: net Whish +20.00 (the Whish money stayed in Whish)");
  await testid("dm-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + "REF-daily-money-arabic.png" });
  // ── DEC-35zz++ Option A: «استردادات اليوم» — each REF- by name; opening one is a VIEW, never a new refund ──
  const listed = await page.locator('[data-testid="dm-refund-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-ref-number")));
  assert(JSON.stringify(listed) === JSON.stringify(["REF-000001", "REF-000002", "REF-000003"]), `Option A: «استردادات اليوم» lists the three REF- of today (${JSON.stringify(listed)})`);
  const firstRow = (await page.locator('[data-testid="dm-refund-row"]').first().innerText()).replace(/\s+/g, " ");
  assert(firstRow.includes(A) && firstRow.includes("4.00") && firstRow.includes("Cashier One"), `Option A: each row names the customer, the amount and who refunded («${firstRow}»)`);
  const refsBeforeView = n("SELECT count(*) FROM advance_refunds");
  await testid("dm-refund-open").first().click();
  await testid("dm-refund-reprint").waitFor({ timeout: 15000 });
  assert((await field("ref-number")) === "REF-000001" && (await testid("ref-reprint-note").count()) === 1, "Option A: the REF- opens as a VIEW, with «do not hand the cash over again»");
  await testid("dm-refund-list").scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + "REF-today-list-reprint-arabic.png" });
  await testid("ref-receipt-close").click();
  assert(n("SELECT count(*) FROM advance_refunds") === refsBeforeView && refNo() === 3, "🔴 opening a REF- from the list wrote NOTHING");

  // ── G · lost reply; cashier ───────────────────────────────────────────────────────────────────
  const lost = await page.evaluate(async () => {
    const must = (r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.data;
    };
    const c = must(await window.pos.createCustomer({ displayName: "زبون الرد الضائع", phone: null, address: null, note: null })).customer.id;
    must(await window.pos.recordAdvance({ customerId: c, amountMinor: "500", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "e2e-ref-adv-0003" }));
    await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-ref-adv-0003" });
    const advanceId = must(await window.pos.getAdvanceStatement({ customerId: c })).lines[0].advance.id;
    const req = { advanceId, amountMinor: "200", reason: "رد ضائع", idempotencyKey: "e2e-ref-lost-0001" };
    const one = must(await window.pos.refundAdvance(req));
    const two = must(await window.pos.refundAdvance(req));
    return { advanceId, refundId: one.refund.id, one: one.refund.number, two: two.refund.number, dup: two.duplicate };
  });
  assert(lost.one === "REF-000004" && lost.two === "REF-000004" && lost.dup === true && n("SELECT count(*) FROM advance_refunds") === 4, "🔴 a lost reply: the same request returns the SAME REF-000004, one row");

  await testid("logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  const forged = await page.evaluate(async (x) => {
    const r = await window.pos.refundAdvance({ advanceId: x.advanceId, amountMinor: "100", reason: "محاولة كاشير", idempotencyKey: "e2e-ref-forged-01" });
    const p = await window.pos.printAdvanceRefund({ refundId: x.refundId });
    return [r.error?.code, p.error?.code];
  }, lost);
  assert(forged[0] === "NOT_AUTHORIZED" && forged[1] === "NOT_AUTHORIZED" && n("SELECT count(*) FROM advance_refunds") === 4 && refNo() === 4, "🔴 a cashier is refused (refund AND reprint); nothing written");
} finally {
  await app.close();
}
assert(q("PRAGMA integrity_check")[0].integrity_check === "ok" && q("PRAGMA foreign_key_check").length === 0, "integrity_check ok, no foreign-key violation");
console.log(`ADVANCE REFUND E2E PASSED — ${passed} checks`);
