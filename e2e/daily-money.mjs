// DAILY MONEY IN / OUT (DEC-35x) — against the real app. Synthetic data only.
//   A · the owner sells (cash, Whish) and takes a Whish advance; a cashier sells (cash) and takes a
//       cash advance — the till's own channels, the real ledger
//   B · the CASHIER sees Today's Sales but no money panel, and the channel refuses them
//   C · the OWNER sees the panel: Cash and Whish per kind of money, money in, the two operators —
//       every figure equal to an independent read of the ledger file
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-dailymoney-"));
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData"), ALZABT_POS_DISABLE_AUTOSTART: "1", ALZABT_POS_DEMO_CATALOG: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let passed = 0;
const assert = (c, m) => {
  if (!c) throw new Error("ASSERTION FAILED: " + m);
  passed += 1;
  console.log("• PASS", m);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const n = (sql, ...p) => {
  const db = new Database(LEDGER, { readonly: true });
  try {
    return Number(Object.values(db.prepare(sql).get(...p))[0] ?? 0);
  } finally {
    db.close();
  }
};
const SALE = { lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: "199" };
const digits = (s) => s.replace(/[^0-9.\-]/g, "");

// ── A · the owner's part of the day ───────────────────────────────────────────────────────────────
const app = await electron.launch({ executablePath: ELECTRON, args: APP_ARGS, env });
let customerId;
try {
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111"); // owner
  customerId = await page.evaluate(async (SALE) => {
    const must = (r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.data;
    };
    must(await window.pos.createSale({ ...SALE, idempotencyKey: "e2e-dm-sale-0001", paymentMethod: "cash" }));
    must(await window.pos.createSale({ ...SALE, idempotencyKey: "e2e-dm-sale-0002", paymentMethod: "external", whish: { reference: "WH-DM-E2E-1", fundsConfirmed: true } }));
    const c = must(await window.pos.createCustomer({ displayName: "زبون المال اليومي", phone: null, address: null, note: null })).customer.id;
    must(await window.pos.recordAdvance({ customerId: c, amountMinor: "5000", channel: "whish", reference: "WH-DM-E2E-ADV", fundsConfirmed: true, idempotencyKey: "e2e-dm-adv-0001" }));
    await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-dm-adv-0001" });
    return c;
  }, SALE);
  assert(n("SELECT count(*) FROM sales") === 2 && n("SELECT count(*) FROM customer_advances") === 1, "owner: a cash sale, a Whish sale and a Whish advance recorded");

  // ── B · a cashier sells, takes cash, and sees no money panel (same launch: the demo catalog is
  //        only served on a ledger with no merchant data, so a relaunch would have no product) ──────
  await testid(page, "logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  const refused = await page.evaluate(async ({ SALE, customerId }) => {
    const must = (r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.data;
    };
    must(await window.pos.createSale({ ...SALE, idempotencyKey: "e2e-dm-sale-0003", paymentMethod: "cash" }));
    must(await window.pos.recordAdvance({ customerId, amountMinor: "2000", channel: "cash", reference: null, fundsConfirmed: false, idempotencyKey: "e2e-dm-adv-0002" }));
    await window.pos.acknowledgeAdvance({ idempotencyKey: "e2e-dm-adv-0002" });
    return (await window.pos.getDailyMoney({})).error?.code;
  }, { SALE, customerId });
  assert(refused === "NOT_AUTHORIZED", "🔴 the channel refuses a cashier (NOT_AUTHORIZED)");
  await testid(page, "tab-today").click();
  await testid(page, "today-net").waitFor({ timeout: 30000 });
  assert((await testid(page, "dm-panel").count()) === 0, "🔴 a cashier's Today screen shows no money panel");

  // ── C · the owner reads the day ─────────────────────────────────────────────────────────────────
  await testid(page, "logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier One", "1111");
  if ((await page.evaluate(() => document.documentElement.lang)) !== "ar") await testid(page, "lang-toggle").click();
  await testid(page, "tab-today").click();
  await testid(page, "dm-panel").waitFor({ timeout: 30000 });
  const cell = async (id) => digits(await testid(page, id).innerText());
  // Independent reads of the ledger file (minor units → 2 decimals).
  const d = (minor) => (minor / 100).toFixed(2);
  const salesCash = n("SELECT sum(t.amount_minor) FROM sale_tenders t WHERE t.method = 'cash'");
  const salesWhish = n("SELECT sum(t.amount_minor) FROM sale_tenders t WHERE t.method = 'external' AND t.provider = 'whish'");
  assert(salesCash === 398 && salesWhish === 199, "ledger: tenders cash 3.98, Whish 1.99");
  assert((await cell("dm-sales-cash")) === d(salesCash) && (await cell("dm-sales-whish")) === d(salesWhish), "panel: sales received Cash 3.98 / Whish 1.99 = the ledger");
  assert((await cell("dm-advances-cash")) === "20.00" && (await cell("dm-advances-whish")) === "50.00", "panel: advances received Cash 20.00 / Whish 50.00");
  assert((await cell("dm-in-cash")) === "23.98" && (await cell("dm-in-whish")) === "51.99" && (await cell("dm-in-total")) === "75.97", "panel: money in Cash 23.98 / Whish 51.99 / total 75.97");
  assert((await cell("dm-out-total")) === "0.00" && (await cell("dm-net-total")) === "75.97", "panel: nothing out, net 75.97");
  assert(digits(await testid(page, "dm-revenue").innerText()).startsWith("5.97"), "panel: revenue 5.97 shown apart from money");
  const ops = await testid(page, "dm-op-row").count();
  assert(ops === 2, "panel: two operators, each with their own money");
  const two = page.locator('[data-testid="dm-op-row"][data-operator="Cashier Two"]');
  assert(digits(await two.locator('[data-testid="dm-op-in-cash"]').innerText()) === "21.99", "panel: Cashier Two took 21.99 cash (sale 1.99 + advance 20.00)");
  // No double scroll: the page itself does not overflow sideways at this window size.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, "no horizontal page scroll");
  // The panel itself (the content area scrolls, so a page screenshot would cut it): same width as the Today card.
  const widths = await page.evaluate(() => [document.querySelector(".card.today").getBoundingClientRect().width, document.querySelector('[data-testid="dm-panel"]').getBoundingClientRect().width]);
  assert(Math.abs(widths[0] - widths[1]) <= 1, `the money panel is as wide as the Today card (${widths.join(" / ")})`);
  await testid(page, "dm-panel").screenshot({ path: SHOTS + "DAILYMONEY-owner-arabic.png" });
  await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await testid(page, "dm-panel").screenshot({ path: SHOTS + "DAILYMONEY-owner-english.png" });
} finally {
  await app.close();
}
{
  const db = new Database(LEDGER, { readonly: true });
  try {
    assert(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "integrity_check ok");
  } finally {
    db.close();
  }
}
console.log(`DAILY MONEY E2E PASSED — ${passed} checks`);
