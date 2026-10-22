/**
 * E2E — the Customer directory and Sell quick-create, against the REAL app (the installed .exe).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * It produces the evidence a unit test cannot, and the five claims are the ones S1B is judged on:
 *
 *   A  an owner creates a customer and finds it again
 *   B  a signed-in CASHIER creates a customer and gains no edit, archive or supplier power
 *   C  quick-create from Sell leaves the CART, the product search and the quantities untouched
 *   D  two customers with the same name stay two customers
 *   E  a restart preserves them
 *
 * 🔴 Selectors are data-testid, never visible text: the terminal's default language is Arabic, so a
 * script that clicks "Save" passes only while the UI happens to be English.
 *
 * 🔴 AND C IS THE ONE THAT NEEDED A REAL APP. "The cart survives" is a claim about React keeping
 * state across a panel opening, which no DOM-less unit test can make. Here the cart is built, the
 * panel is opened, a customer is created, and the cart is read back off the real screen.
 *
 * Run: node e2e/customers.mjs            (CI sets E2E_EXECUTABLE to the installed .exe)
 *      Linux without a display: xvfb-run -a node e2e/customers.mjs
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
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

// A fresh profile per run: this script creates records and must never touch a real ledger.
const home = mkdtempSync(join(tmpdir(), "pos-e2e-customers-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
const tab = (page, name) => page.locator(`[data-testid="tab-${name}"]`).click();

/** Calls a channel straight through the bridge, exactly as an untrusted renderer could. */
const direct = (page, method, payload) =>
  page.evaluate(
    ([m, p]) => window.pos[m](p).then((r) => r),
    [method, payload],
  );

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  return { app, page };
}

/** Creates a customer through the real panel. Returns its id, read off the screen. */
async function createThroughPanel(page, { name, phone }) {
  await testid(page, "customer-new").click();
  await testid(page, "customer-field-name").fill(name);
  if (phone) await testid(page, "customer-field-phone").fill(phone);
  await testid(page, "customer-save").click();
  return name;
}

let app;
let page;
try {
  ({ app, page } = await launch());
  await signIn(page, "Cashier One", "1111");
  await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  log("owner signed in");

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // A · An owner creates a customer and finds it again
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  await tab(page, "customers");
  // 🔴 WAIT ON THE SETTLED STATE, NOT ON THE TOOLBAR. `customers-search` lives above the list and
  // renders unconditionally, so waiting for it is satisfied while `rows` is still null — and gate
  // 39835438707 failed exactly there, 0.2s after sign-in, counting `customers-empty` while
  // `customers-loading` was on screen. `customers-empty` renders ONLY when the query has returned
  // and returned nothing (CustomersScreen.tsx: `rows === null ? loading : rows.length === 0 ?
  // empty : list`), so its visibility is proof the directory settled. A populated directory never
  // satisfies it and this times out rather than passing.
  await testid(page, "customers-empty").waitFor({ state: "visible", timeout: 30000 });
  assert((await testid(page, "customers-list").count()) === 0, "a new shop's directory holds no customer rows");
  assert(
    (await testid(page, "customers-empty").innerText()).trim() === "لا زبائن بعد.",
    "🔴 and it says the directory is EMPTY, not that a search matched nothing",
  );
  await page.screenshot({ path: SHOTS + "S1B-A1-customers-empty-arabic.png" });

  await testid(page, "customers-add").click();
  await testid(page, "customer-finder").waitFor({ timeout: 30000 });
  await createThroughPanel(page, { name: "أبو خالد التجاري", phone: "0100100" });
  await testid(page, "customers-detail").waitFor({ timeout: 30000 });
  assert(
    (await testid(page, "customers-detail").innerText()).includes("أبو خالد التجاري"),
    "🔴 the owner's new customer opens on its own detail pane, by Arabic name",
  );
  assert(
    (await testid(page, "customers-detail-phone").innerText()).trim() === "0100100",
    "with the phone that was typed",
  );
  // 🔴 NO BALANCE IS SHOWN, because none exists. S1B is a directory.
  const detailText = await testid(page, "customers-detail").innerText();
  for (const word of ["0.00", "USD", "رصيد", "دين", "Balance"]) {
    assert(!detailText.includes(word), `the detail pane shows no "${word}" — there is no balance to show`);
  }
  // 🔴 MEASURED, NOT ASSERTED FROM A SELECTOR. The defect the first gate shipped was invisible to
  // every text assertion: the phone number was present, correct and readable — it just sat ~600px
  // from its own label, because `dir="auto"` on the <dd> took its direction from the digits inside
  // it. A selector cannot see WHERE a thing is, so this reads real geometry.
  const gap = async () =>
    page.evaluate(() => {
      const dd = document.querySelector('[data-testid="customers-detail-phone"]');
      const dt = dd?.previousElementSibling;
      const value = dd?.querySelector("bdi");
      if (!dd || !dt || !value) return null;
      const d = dd.getBoundingClientRect();
      const t = dt.getBoundingClientRect();
      const v = value.getBoundingClientRect();
      return {
        rtl: getComputedStyle(dd).direction === "rtl",
        // How far the VALUE's text sits from the LABEL, whichever side the label is on.
        apart: Math.round(Math.min(Math.abs(v.left - t.right), Math.abs(t.left - v.right))),
        box: Math.round(d.width),
      };
    });
  {
    const g = await gap();
    assert(g !== null, "the phone row, its label and the isolated value are all on screen");
    assert(g.rtl, `🔴 the value box follows the Arabic UI, not its own digits (direction rtl: ${g.rtl})`);
    assert(g.apart <= 40, `🔴 the phone sits beside its label, not across the pane (${g.apart}px apart)`);
  }
  await page.screenshot({ path: SHOTS + "S1B-A2-customer-detail-arabic.png" });

  // Found again by searching, and the row carries the durable id.
  await testid(page, "customers-search").fill("خالد");
  await testid(page, "customers-row").first().waitFor({ timeout: 30000 });
  const ownerCustomerId = await testid(page, "customers-row").first().getAttribute("data-customer");
  assert(typeof ownerCustomerId === "string" && ownerCustomerId.length > 10, `the row names a durable id (${ownerCustomerId})`);
  assert((await testid(page, "customers-row").count()) === 1, "searching by part of the name finds exactly that one");

  // English LTR, same screen.
  await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.dir === "ltr", undefined, { timeout: 20000 });
  assert((await page.evaluate(() => document.documentElement.lang)) === "en", "the terminal is in English");
  // 🔴 AN ARABIC NAME ON AN ENGLISH TERMINAL. It used to jump to the opposite edge of its own pane,
  // because `dir="auto"` on the <h2> read the Arabic and flipped the whole heading. <bdi> isolates
  // the name instead, so the heading follows the English layout and the name still reads RTL.
  {
    const head = await page.evaluate(() => {
      const h2 = document.querySelector('[data-testid="customers-detail"] h2');
      const name = h2?.querySelector("bdi");
      const dl = document.querySelector('[data-testid="customers-detail"] dl');
      if (!h2 || !name || !dl) return null;
      return {
        dir: getComputedStyle(h2).direction,
        // Distance between where the NAME starts and where the fields below it start.
        offset: Math.round(Math.abs(name.getBoundingClientRect().left - dl.getBoundingClientRect().left)),
        text: name.textContent,
      };
    });
    assert(head !== null, "the heading, its isolated name and the field list are all on screen");
    assert(head.text === "أبو خالد التجاري", `the heading really carries the Arabic name ("${head.text}")`);
    assert(head.dir === "ltr", `🔴 the heading follows the English UI, not the Arabic name (${head.dir})`);
    assert(head.offset <= 40, `🔴 and it starts on the same side as its own fields (${head.offset}px off)`);
  }
  await page.screenshot({ path: SHOTS + "S1B-A3-customers-english-ltr.png" });
  await testid(page, "lang-toggle").click();
  await page.waitForFunction(() => document.documentElement.dir === "rtl", undefined, { timeout: 20000 });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // D · Two customers with the same name stay two customers
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  await testid(page, "customers-search").fill("");
  await testid(page, "customers-add").click();
  await createThroughPanel(page, { name: "محمد علي", phone: "0111111" });
  await testid(page, "customers-add").click();
  await createThroughPanel(page, { name: "محمد علي", phone: "0222222" });
  // The second creation reports the first rather than merging or refusing.
  assert(
    (await testid(page, "customer-same-name").count()) === 1,
    "🔴 the second same-named customer is ACCEPTED, with a warning that another exists",
  );
  const warning = await testid(page, "customer-same-name").innerText();
  assert(warning.includes("لم يُدمجا"), `and the warning says the accounts were not merged ("${warning.slice(0, 40)}…")`);
  await page.screenshot({ path: SHOTS + "S1B-D1-same-name-warning-arabic.png" });
  await testid(page, "customer-finder-close").click();

  await testid(page, "customers-search").fill("محمد علي");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="customers-row"]').length === 2,
    undefined,
    { timeout: 30000 },
  );
  const twinIds = await page.$$eval('[data-testid="customers-row"]', (els) =>
    els.map((e) => e.dataset.customer),
  );
  assert(new Set(twinIds).size === 2, `🔴 two DIFFERENT ids for the same name (${twinIds.join(", ")})`);
  const twinText = await page.locator(".customer-list").innerText();
  assert(twinText.includes("0111111") && twinText.includes("0222222"), "and each is shown with its own phone, to tell them apart");
  await page.screenshot({ path: SHOTS + "S1B-D2-two-same-name-customers.png" });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // C · Quick-create from Sell does not disturb the cart
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  await tab(page, "sell");
  await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  // Build a real cart: two different products, and a product search still typed in the box.
  const products = page.locator("button.product");
  await products.nth(0).click();
  await products.nth(1).click();
  await products.nth(1).click();
  // Selectors read from SellScreen.tsx, not guessed: the lines are `ul.lines > li.line`, the total
  // is `[data-testid="cart-total"]` and the product search is `[data-testid="product-search"]`.
  const beforeTotal = (await testid(page, "cart-total").innerText()).trim();
  const beforeLines = await page.locator('[data-testid="cart"] li.line').count();
  assert(beforeLines === 2, `the cart really holds two lines before the panel opens (${beforeLines})`);
  await testid(page, "product-search").fill("ا");
  const beforeQuery = await testid(page, "product-search").inputValue();
  assert(beforeQuery === "ا", "and the product search box holds what was typed");
  await page.screenshot({ path: SHOTS + "S1B-C1-cart-before-customer.png" });

  await testid(page, "sell-choose-customer").click();
  await testid(page, "customer-finder").waitFor({ timeout: 30000 });
  // 🔴 THE CART IS STILL ON SCREEN WHILE THE PANEL IS OPEN — not hidden, not unmounted.
  assert((await testid(page, "cart").count()) === 1, "🔴 the cart is still mounted while the panel is open");
  await createThroughPanel(page, { name: "زبون من الكاشير", phone: "0333333" });
  await testid(page, "sell-customer").waitFor({ timeout: 30000 });

  const afterLines = await page.locator('[data-testid="cart"] li.line').count();
  const afterQuery = await testid(page, "product-search").inputValue();
  const afterTotal = (await testid(page, "cart-total").innerText()).trim();
  assert(afterLines === beforeLines, `🔴 the cart still holds the same number of lines (${beforeLines} -> ${afterLines})`);
  assert(afterQuery === beforeQuery, `🔴 and the product search box still holds what was typed ("${afterQuery}")`);
  assert(
    (await testid(page, "sell-customer").innerText()).includes("زبون من الكاشير"),
    "the chosen customer is shown beside the cart",
  );
  assert(
    (await testid(page, "sell-customer-not-attached").count()) === 1,
    "🔴 and the screen SAYS it is not attached to the sale and records no debt",
  );
  // 🔴 THE BUTTON SAYS WHAT IT DOES. It used to borrow «تعديل» from the record-editing action,
  // which a cashier may never perform — so the one control a cashier DOES have was labelled with
  // the one thing they cannot do. It reopens the picker, so it says «تغيير الزبون».
  {
    const label = (await testid(page, "sell-choose-customer").innerText()).trim();
    assert(label === "تغيير الزبون", `🔴 the Sell button reads «تغيير الزبون», not «تعديل» (got "${label}")`);
  }
  await page.screenshot({ path: SHOTS + "S1B-C2-cart-after-customer-created.png" });

  // 🔴 AND THE MONEY IS UNCHANGED, which is the assertion that actually matters to a merchant.
  assert(afterTotal === beforeTotal, `🔴 the cart total is unchanged (${beforeTotal} -> ${afterTotal})`);
  // Nothing financial was written by any of it.
  {
    const db = new Database(LEDGER, { readonly: true });
    const n = (sql) => Number(db.prepare(sql).get().n);
    assert(n("SELECT count(*) AS n FROM sales") === 0, "no sale was recorded by choosing a customer");
    assert(n("SELECT count(*) AS n FROM invoices") === 0, "and no invoice");
    assert(n("SELECT count(*) AS n FROM parties WHERE kind = 'customer'") === 4, "four customers exist in the ledger");
    assert(n("SELECT count(*) AS n FROM parties WHERE kind = 'supplier'") === 0, "and zero suppliers — S1B creates none");
    db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // B · A signed-in CASHIER may create, and may not edit, archive or reach a supplier
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  await testid(page, "logout").click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  const who = (await page.locator(".topbar span.muted").first().innerText()).trim();
  assert(who === "Cashier Two", `a CASHIER is signed in (${who})`);

  await tab(page, "customers");
  await testid(page, "customers-search").waitFor({ timeout: 30000 });
  await testid(page, "customers-add").click();
  await createThroughPanel(page, { name: "زبون سجّله الكاشير", phone: "0444444" });
  await testid(page, "customers-detail").waitFor({ timeout: 30000 });
  assert(
    (await testid(page, "customers-detail").innerText()).includes("زبون سجّله الكاشير"),
    "🔴 a cashier CAN register a customer",
  );
  assert((await testid(page, "customers-edit").count()) === 0, "🔴 …and is offered NO edit control");
  assert((await testid(page, "customers-archive").count()) === 0, "🔴 …nor an archive control");
  assert((await testid(page, "customers-owner-only").count()) === 1, "and is told why, in the shop's language");
  await page.screenshot({ path: SHOTS + "S1B-B1-cashier-customers-no-edit.png" });

  // 🔴 AND THE BRIDGE AGREES WITH THE SCREEN, which is the half that matters.
  const cashierId = await testid(page, "customers-detail").getAttribute("data-customer");
  const refusals = await page.evaluate(async (id) => {
    const update = await window.pos.updateCustomerContact({ customerId: id, patch: { phone: "0999" } });
    const archive = await window.pos.setCustomerActive({ customerId: id, isActive: false });
    const search = await window.pos.searchCustomers({ query: "", includeArchived: false });
    return {
      update: { ok: update?.ok, code: update?.error?.code },
      archive: { ok: archive?.ok, code: archive?.error?.code },
      search: { ok: search?.ok, n: search?.data?.length ?? null },
      supplierChannels: Object.keys(window.pos).filter((k) => /supplier|party/i.test(k)),
    };
  }, cashierId);
  assert(
    refusals.update.ok === false && refusals.update.code === "NOT_AUTHORIZED",
    `🔴 the bridge refuses a cashier's edit (${refusals.update.code})`,
  );
  assert(
    refusals.archive.ok === false && refusals.archive.code === "NOT_AUTHORIZED",
    `🔴 and a cashier's archive (${refusals.archive.code})`,
  );
  assert(refusals.search.ok === true, `a cashier may still search (${refusals.search.n} customers)`);
  assert(
    refusals.supplierChannels.length === 0,
    `🔴 there is NO supplier or generic party channel on the bridge at all (${JSON.stringify(refusals.supplierChannels)})`,
  );
  // The refusals wrote nothing.
  {
    const db = new Database(LEDGER, { readonly: true });
    const row = db.prepare("SELECT phone, is_active FROM parties WHERE id = ?").get(cashierId);
    assert(row.phone === "0444444", `the refused edit changed nothing (${row.phone})`);
    assert(Number(row.is_active) === 1, "and the refused archive left it active");
    db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // E · A restart preserves every customer
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  await app.close().catch(() => undefined);
  const restarted = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page2 = await restarted.firstWindow();
  await signIn(page2, "Cashier One", "1111");
  await page2.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  await page2.locator('[data-testid="tab-customers"]').click();
  await page2.locator('[data-testid="customers-row"]').first().waitFor({ timeout: 30000 });
  const survived = await page2.$$eval('[data-testid="customers-row"]', (els) => els.map((e) => e.innerText));
  const joined = survived.join(" | ");
  for (const name of ["أبو خالد التجاري", "محمد علي", "زبون من الكاشير", "زبون سجّله الكاشير"]) {
    assert(joined.includes(name), `🔴 "${name}" survived the restart`);
  }
  assert(survived.length === 5, `all five customers are there after the restart (${survived.length})`);
  await page2.screenshot({ path: SHOTS + "S1B-E1-customers-after-restart.png" });
  {
    const db = new Database(LEDGER, { readonly: true });
    const n = (sql) => Number(db.prepare(sql).get().n);
    assert(n("SELECT max(version) AS n FROM schema_migrations") === 12, "the installed app's ledger is at schema v12");
    assert(n("SELECT count(*) AS n FROM parties") === 5, "five party rows, and no more");
    assert(n("SELECT count(*) AS n FROM party_contact_history") === 0, "and zero contact-history rows — nothing was edited");
    assert(n("SELECT count(*) AS n FROM sales") === 0, "🔴 and still not one sale, obligation or payment anywhere");
    db.close();
  }
  await restarted.close().catch(() => undefined);

  log("customer directory E2E complete");
} finally {
  await app?.close().catch(() => undefined);
}
