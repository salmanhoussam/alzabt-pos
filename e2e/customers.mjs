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

/**
 * Creates a customer through the real panel, and WAITS FOR THE APP TO SETTLE.
 *
 * 🔴 IT USED TO RETURN ON THE CLICK. That is what failed Windows gate 39933933238 at the
 * duplicate-name assertion: the warning is rendered only once `createCustomer` has come back, and
 * the caller counted it immediately. It had been winning that race, not asserting a settled state
 * — the green gate had the warning within 449ms, the failed one still did not at 600ms.
 *
 * 🔴 THE SETTLED STATE IS NOT THE SAME IN BOTH CASES, which is why this takes an explicit option
 * rather than waiting for one universal thing. `CustomerFinder` calls `onPick` ONLY when the new
 * name is unique (`created.sameName.length === 0`), which closes the panel. When another account
 * already carries that name the panel deliberately STAYS OPEN so the operator reads the warning.
 * So:
 *
 *   expect "picked"   (default) -> the panel is gone: the customer was created and handed back
 *   expect "sameName"           -> the warning is on screen: created, and reported as a twin
 *
 * 🔴 NEITHER WAIT CAN HIDE A FAILED CREATION. If the save is refused the panel stays open AND no
 * warning appears, so both branches time out and the test fails loudly. A warning alone is also
 * never treated as proof the record exists — the caller proves that separately, by identity.
 */
async function createThroughPanel(page, { name, phone, expect: expected = "picked" }) {
  await testid(page, "customer-new").click();
  await testid(page, "customer-field-name").fill(name);
  if (phone) await testid(page, "customer-field-phone").fill(phone);
  await testid(page, "customer-save").click();
  if (expected === "sameName") {
    await testid(page, "customer-same-name").waitFor({ state: "visible", timeout: 30000 });
  } else {
    await testid(page, "customer-finder").waitFor({ state: "detached", timeout: 30000 });
  }
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
  // 🔴 NO FABRICATED BALANCE IN THE DIRECTORY RECORD. S1B is a directory: a customer's identity
  //    and contact fields must never claim that a balance exists.
  //
  //    🔴 THE SCOPE CHANGED FOR S3B, DELIBERATELY, AND THE OLD VALUE IS NAMED. This assertion used
  //    to scan ALL of `customers-detail` for money words, which was exactly right while that
  //    container held nothing but the directory record. S3B mounts the owner-only Customer
  //    Statement inside the same container, and that statement TRUTHFULLY says «لا ديون مسجّلة» —
  //    a sentence in which "دين" appears as a substring of "ديون". That is what failed gate
  //    39911215149 at step 21: the assertion fired on the very sentence stating there are NO
  //    debts. A statement rendered beside the record is not a balance ON the record.
  //
  //    So the scope is now "everything in the detail pane EXCEPT the statement subtree". The
  //    original guarantee still covers the heading, the contact fields and the action buttons;
  //    the statement owns its own figures, and lines 409+ below are what hold it to them.
  //
  //    The exclusion selector is the CLASS `.customer-statement`, not the test id, because the
  //    component renders that class on its root in ALL THREE of its states — loaded, loading and
  //    error — while `data-testid="customer-statement"` exists only on the loaded one. Excluding
  //    by test id would leave the loading and error states inside the scanned region.
  //
  //    Wait for the settled empty state FIRST, so the exclusion is deterministic rather than a
  //    race against a statement that may still be loading — the same lesson as `customers-empty`.
  await testid(page, "statement-empty").waitFor({ state: "visible", timeout: 30000 });
  const FORBIDDEN_IN_RECORD = ["0.00", "USD", "رصيد", "دين", "Balance"];
  const scoped = await page.evaluate(() => {
    const detail = document.querySelector('[data-testid="customers-detail"]');
    if (!detail) return null;
    const clone = detail.cloneNode(true);
    const statements = clone.querySelectorAll(".customer-statement");
    const removed = statements.length;
    statements.forEach((n) => n.remove());
    // 🔴 textContent, NOT innerText: a detached clone has no layout, so innerText would come back
    // empty and every negative check below would pass vacuously. textContent is also the STRICTER
    // choice for a negative assertion — it sees text innerText would skip.
    return { record: clone.textContent ?? "", removed, live: detail.textContent ?? "" };
  });
  assert(scoped !== null, "the customer detail pane exists, so the scoped read is reading something real");
  // 🔴 ANTI-VACUITY, THREE WAYS. A negative loop over an empty or wrong node passes while proving
  // nothing — which is precisely how a narrowed assertion goes quietly blind.
  assert(scoped.removed === 1, `exactly one statement subtree was excluded (removed ${scoped.removed})`);
  assert(
    scoped.record.includes("أبو خالد التجاري") && scoped.record.includes("0100100"),
    "the scoped record still holds the customer's name and phone — the right region, not an empty node",
  );
  assert(
    scoped.live.includes("لا ديون مسجّلة"),
    "🔴 the statement WAS rendered and then excluded — not merely absent, which would make this trivial",
  );
  for (const word of FORBIDDEN_IN_RECORD) {
    assert(
      !scoped.record.includes(word),
      `the customer-directory record shows no "${word}" — identity and contact carry no balance`,
    );
  }
  // 🔴 AND THE CHECK STILL BITES. The identical extraction, run against a record that DOES carry a
  // fabricated balance, must catch every forbidden term. Without this control the loop above would
  // keep passing even if the scoping were widened until it excluded the record itself.
  const control = await page.evaluate((words) => {
    const d = document.createElement("div");
    d.innerHTML =
      "<h2>أبو خالد التجاري</h2><dl><dt>الهاتف</dt><dd>0100100</dd>" +
      "<dt>الرصيد</dt><dd>رصيد 0.00 USD · دين · Balance</dd></dl>" +
      '<section class="customer-statement"><p>لا ديون مسجّلة.</p></section>';
    d.querySelectorAll(".customer-statement").forEach((n) => n.remove());
    const text = d.textContent ?? "";
    return words.filter((w) => text.includes(w));
  }, FORBIDDEN_IN_RECORD);
  assert(
    control.length === FORBIDDEN_IN_RECORD.length,
    `the scoped check catches every forbidden term when one is really present ` +
      `(caught ${control.length}/${FORBIDDEN_IN_RECORD.length}: ${JSON.stringify(control)})`,
  );
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
  // The FIRST «محمد علي» is unique at this moment, so the panel closes and hands it back.
  await createThroughPanel(page, { name: "محمد علي", phone: "0111111" });
  await testid(page, "customers-add").click();
  // 🔴 AND THE PANEL IS FRESH. Asserted before the save, so a warning left over from a previous
  // interaction cannot be what satisfies the assertion below. The panel unmounts on `onPick`, so
  // this should hold — the point is that it is checked rather than assumed.
  assert(
    (await testid(page, "customer-same-name").count()) === 0,
    "🔴 no stale duplicate-name warning is on screen before the second creation",
  );
  // The second creation reports the first rather than merging or refusing — and this now WAITS for
  // that warning rather than counting it the instant the Save click returns.
  await createThroughPanel(page, { name: "محمد علي", phone: "0222222", expect: "sameName" });
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
    // 🔴 TRANSITION 13 -> 14 with migration 14 (credit_sale_identity_and_unpaid_state). The old value was 13.
    assert(n("SELECT max(version) AS n FROM schema_migrations") === 14, "the installed app's ledger is at schema v14");
    assert(n("SELECT count(*) AS n FROM parties") === 5, "five party rows, and no more");
    assert(n("SELECT count(*) AS n FROM party_contact_history") === 0, "and zero contact-history rows — nothing was edited");
    assert(n("SELECT count(*) AS n FROM sales") === 0, "🔴 and still not one sale, obligation or payment anywhere");
    db.close();
  }
  await restarted.close().catch(() => undefined);

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // S3B · the read-only account statement
  //
  // 🔴 THE DEBTS BELOW ARE SEEDED DIRECTLY INTO THIS RUN'S DISPOSABLE LEDGER, and they have to be:
  // S3B is READ-ONLY, so there is no screen and no channel that could create one. That is the
  // feature, not a shortcut. These are fixture rows in a temp profile — not a merchant's books.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  let statementCustomerId;
  let emptyCustomerId;
  {
    const db = new Database(LEDGER);
    const op = db.prepare("SELECT id FROM operators WHERE role = 'owner' LIMIT 1").get().id;
    // The two «محمد علي» rows differ only by phone — seed against ONE of them on purpose, so the
    // screenshot proves the statement follows the id and not the name.
    statementCustomerId = db.prepare("SELECT id FROM parties WHERE phone = '0111111'").get().id;
    emptyCustomerId = db.prepare("SELECT id FROM parties WHERE phone = '0222222'").get().id;
    const obligation = db.prepare(
      `INSERT INTO obligations (id, party_id, party_kind, direction, source_kind, source_ref,
                                sale_id, currency, amount_minor, posted_by, posted_at, business_date)
       VALUES (?, ?, 'customer', 'receivable', 'manual', ?, NULL, ?, ?, ?, ?, ?)`,
    );
    const settle = db.prepare(
      `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint,
                                amount_minor, method, settled_by, settled_at, business_date)
       VALUES (?, ?, ?, ?, 'e2e', ?, ?, ?, ?, ?)`,
    );
    // 1 · unpaid USD 25.00   2 · part-paid USD 40.00 (10.00 cash)   3 · fully paid LBP 300000
    obligation.run("o-unpaid", statementCustomerId, "FIX-001", "USD", 2500, op, "2026-10-20T08:00:00.000Z", "2026-10-20");
    obligation.run("o-part", statementCustomerId, "FIX-002", "USD", 4000, op, "2026-10-21T08:00:00.000Z", "2026-10-21");
    settle.run("s-part", "o-part", "USD", "e2e-pay-0001", 1000, "cash", op, "2026-10-21T09:00:00.000Z", "2026-10-21");
    obligation.run("o-lbp", statementCustomerId, "FIX-003", "LBP", 300000, op, "2026-10-22T08:00:00.000Z", "2026-10-22");
    settle.run("s-lbp", "o-lbp", "LBP", "e2e-pay-0002", 300000, "card", op, "2026-10-22T09:00:00.000Z", "2026-10-22");
    db.close();
  }

  const owner2 = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const p3 = await owner2.firstWindow();
  await signIn(p3, "Cashier One", "1111");
  await p3.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  await p3.locator('[data-testid="tab-customers"]').click();
  await testid(p3, "customers-search").fill("0111111");
  await p3.locator(`[data-customer="${statementCustomerId}"]`).first().click();
  await testid(p3, "customer-statement").waitFor({ state: "visible", timeout: 30000 });

  // The statement answered for the customer that was asked for, not the same-named one.
  assert(
    (await testid(p3, "customer-statement").getAttribute("data-customer")) === statementCustomerId,
    "🔴 the statement names the customer it was asked for, by id",
  );
  const obligations = await p3.$$('[data-testid="statement-obligation"]');
  assert(obligations.length === 3, `three seeded obligations are listed (${obligations.length})`);

  // 🔴 TWO BALANCES, NEVER ONE. 25.00 unpaid + 30.00 still owed on the part-paid = 55.00 USD, and
  // the LBP debt is fully settled at 0. Blending them would need a rate this product has none of.
  const balances = await p3.$$eval('[data-testid="statement-balance"]', (els) =>
    els.map((e) => ({ currency: e.getAttribute("data-currency"), text: e.innerText.replace(/\s+/g, " ").trim() })),
  );
  assert(balances.length === 2, `two balances, one per currency (${balances.length})`);
  const usd = balances.find((b) => b.currency === "USD");
  const lbp = balances.find((b) => b.currency === "LBP");
  assert(usd && usd.text.includes("55.00"), `🔴 the USD balance is 55.00 (got "${usd && usd.text}")`);
  assert(lbp && lbp.text.includes("0.00"), `🔴 the LBP debt reads 0.00 — it was settled in full (got "${lbp && lbp.text}")`);
  assert(
    !balances.some((b) => b.text.includes("300055") || b.text.includes("3000.55")),
    "🔴 and nothing anywhere is the two currencies added together",
  );

  const settled = await p3.$$('[data-testid="statement-settled"]');
  assert(settled.length === 1, `exactly one obligation shows as paid in full (${settled.length})`);
  const noSettlements = await p3.$$('[data-testid="statement-no-settlements"]');
  assert(noSettlements.length === 1, `and exactly one shows no payments yet (${noSettlements.length})`);
  assert((await testid(p3, "statement-read-only").count()) === 1, "🔴 the screen says it is read-only");
  await p3.screenshot({ path: SHOTS + "S3B-A1-statement-arabic.png" });

  // English LTR, same statement.
  await testid(p3, "lang-toggle").click();
  await p3.waitForFunction(() => document.documentElement.dir === "ltr", undefined, { timeout: 20000 });
  await testid(p3, "customer-statement").waitFor({ state: "visible", timeout: 30000 });
  await p3.screenshot({ path: SHOTS + "S3B-A2-statement-english.png" });
  await testid(p3, "lang-toggle").click();
  await p3.waitForFunction(() => document.documentElement.dir === "rtl", undefined, { timeout: 20000 });

  // The OTHER «محمد علي» — same name, no debts. The empty state, not a fabricated zero.
  await testid(p3, "customers-search").fill("0222222");
  await p3.locator(`[data-customer="${emptyCustomerId}"]`).first().click();
  await testid(p3, "statement-empty").waitFor({ state: "visible", timeout: 30000 });
  assert(
    (await p3.$$('[data-testid="statement-obligation"]')).length === 0,
    "🔴 the same-named customer has NO obligations — the two never shared a balance",
  );
  const emptyText = (await testid(p3, "statement-empty").innerText()).trim();
  assert(emptyText === "لا ديون مسجّلة.", `🔴 it says "no posted debts", not a zero (got "${emptyText}")`);
  assert((await p3.$$('[data-testid="statement-balance"]')).length === 0, "and shows no balance figure at all");
  await p3.screenshot({ path: SHOTS + "S3B-A3-statement-empty-arabic.png" });

  // 1024x640, the narrowest supported window.
  // main.ts pins minWidth 1024 / minHeight 640. Resize the REAL BrowserWindow, which is what a
  // shop actually does — `setViewportSize` is a browser-context call and does not move an Electron
  // window. Pattern taken from e2e/product-master.mjs, which already proves it works here.
  await owner2.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1024, 640);
  });
  await p3.waitForFunction(() => window.innerWidth <= 1024, undefined, { timeout: 10000 });
  await testid(p3, "customers-search").fill("0111111");
  await p3.locator(`[data-customer="${statementCustomerId}"]`).first().click();
  await testid(p3, "customer-statement").waitFor({ state: "visible", timeout: 30000 });
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `🔴 no horizontal overflow at 1024x640 (${overflow}px)`);
  await p3.screenshot({ path: SHOTS + "S3B-A4-statement-1024x640.png" });
  await owner2.close().catch(() => undefined);

  // ── The cashier sees none of it, and cannot fetch it either ──────────────────────────────────
  const cash2 = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const p4 = await cash2.firstWindow();
  await signIn(p4, "Cashier Two", "2222");
  await p4.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  await p4.locator('[data-testid="tab-customers"]').click();
  await testid(p4, "customers-search").fill("0111111");
  await p4.locator(`[data-customer="${statementCustomerId}"]`).first().click();
  await testid(p4, "customers-owner-only").waitFor({ timeout: 30000 });
  assert((await p4.$$('[data-testid="customer-statement"]')).length === 0, "🔴 a cashier is shown NO statement panel");
  assert((await p4.$$('[data-testid="statement-balance"]')).length === 0, "🔴 and no balance anywhere on the screen");
  await p4.screenshot({ path: SHOTS + "S3B-B1-cashier-no-statement.png" });

  // 🔴 AND THE BRIDGE REFUSES IT, which is the real guard — hiding a panel is not authorization.
  const refused = await direct(p4, "getCustomerStatement", { customerId: statementCustomerId });
  assert(refused.ok === false, "🔴 the bridge refuses a cashier's statement request");
  assert(refused.error.code === "NOT_AUTHORIZED", `🔴 with NOT_AUTHORIZED (got ${refused.error.code})`);
  // 🔴 TRANSITION, AND THE OLD ASSERTION IS NAMED. Through S3B this asserted the list was EMPTY —
  // there was no financial write channel at all. S3C adds exactly one, `recordCustomerPayment`, so
  // the assertion becomes "exactly one, and it is that one". A second name appearing here is a
  // financial-surface change that has to be argued for.
  const bridge = await p4.evaluate(() => Object.keys(window.pos).filter((k) => /obligation|settle|payment|balance/i.test(k)));
  assert(
    JSON.stringify(bridge) === '["recordCustomerPayment"]',
    `🔴 exactly ONE financial channel exists on the bridge (${JSON.stringify(bridge)})`,
  );
  // 🔴 AND THE CASHIER IS REFUSED BY IT. Its presence on the bridge is not permission to use it.
  const refusedPay = await direct(p4, "recordCustomerPayment", {
    customerId: statementCustomerId,
    obligationId: "o-unpaid",
    idempotencyKey: "e2e-cashier-attempt",
    amountMinor: "100",
    method: "cash",
  });
  assert(refusedPay.ok === false, "🔴 the bridge refuses a cashier's PAYMENT");
  assert(refusedPay.error.code === "NOT_AUTHORIZED", `🔴 with NOT_AUTHORIZED (got ${refusedPay.error.code})`);
  await cash2.close().catch(() => undefined);

  // ── Nothing was written by any of the reading above ──────────────────────────────────────────
  {
    const db = new Database(LEDGER, { readonly: true });
    const n = (sql) => Number(db.prepare(sql).get().n);
    assert(n("SELECT count(*) AS n FROM obligations") === 3, "the three seeded obligations are unchanged");
    assert(n("SELECT count(*) AS n FROM settlements") === 2, "and the two seeded settlements");
    assert(n("SELECT count(*) AS n FROM sales") === 0, "🔴 still not one sale");
    assert(n("SELECT count(*) AS n FROM invoices") === 0, "and not one invoice");
    assert(n("SELECT count(*) AS n FROM parties") === 5, "and the directory is untouched at five");
    db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // S3C · the OWNER records cash against an existing debt
  //
  // 🔴 EVERY DEBT HERE WAS SEEDED ABOVE. S3C collects against obligations that already exist; it
  // still cannot create one, and there is no channel that could. The money only moves DOWN.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const owner3 = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const p5 = await owner3.firstWindow();
  await signIn(p5, "Cashier One", "1111");
  await p5.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  await p5.locator('[data-testid="tab-customers"]').click();
  await testid(p5, "customers-search").fill("0111111");
  await p5.locator(`[data-customer="${statementCustomerId}"]`).first().click();
  await testid(p5, "customer-statement").waitFor({ state: "visible", timeout: 30000 });

  const card = (id) => p5.locator(`[data-obligation="${id}"]`);
  const outstandingText = async (id) => (await card(id).locator('[data-testid="statement-outstanding"]').innerText()).trim();
  const usdBalance = async () =>
    (await p5.locator('[data-testid="statement-balance"][data-currency="USD"]').innerText()).trim();

  assert((await outstandingText("o-unpaid")).includes("25.00"), `the unpaid debt starts at 25.00 (${await outstandingText("o-unpaid")})`);
  assert((await usdBalance()).includes("55.00"), `🔴 the USD balance starts at 55.00 (${await usdBalance()})`);

  // ── A · a PARTIAL payment ───────────────────────────────────────────────────────────────────
  await card("o-unpaid").locator('[data-testid="collect-open"]').click();
  await testid(p5, "collect-form").waitFor({ state: "visible", timeout: 30000 });
  assert(
    (await testid(p5, "collect-outstanding").innerText()).includes("25.00"),
    "the form shows what is outstanding on THIS debt",
  );
  assert((await testid(p5, "collect-method").innerText()).trim().length > 0, "and names the method it will record");
  await p5.screenshot({ path: SHOTS + "S3C-A1-collect-form-arabic.png" });

  await testid(p5, "collect-amount").fill("10.00");
  await testid(p5, "collect-confirm").click();
  await testid(p5, "collect-done").waitFor({ state: "visible", timeout: 30000 });

  assert(
    (await outstandingText("o-unpaid")).includes("15.00"),
    `🔴 the debt fell 25.00 -> 15.00 (${await outstandingText("o-unpaid")})`,
  );
  assert((await usdBalance()).includes("45.00"), `🔴 and the USD balance fell 55.00 -> 45.00 (${await usdBalance()})`);
  const paid = await card("o-unpaid").locator('[data-testid="statement-settlement"]').allInnerTexts();
  assert(paid.length === 1, `the payment is in the history (${paid.length})`);
  assert(paid[0].includes("10.00"), `🔴 and it reads 10.00 (${paid[0]})`);
  // 🔴 THE LBP DEBT IS UNTOUCHED BY A USD PAYMENT — the currencies never mix.
  const lbpAfter = (await p5.locator('[data-testid="statement-balance"][data-currency="LBP"]').innerText()).trim();
  assert(lbpAfter.includes("0.00"), `🔴 the LBP balance is still its own figure (${lbpAfter})`);
  await p5.screenshot({ path: SHOTS + "S3C-A2-after-partial-arabic.png" });

  // ── B · the SAME attempt replayed through the bridge posts exactly once ──────────────────────
  const dupReq = {
    customerId: statementCustomerId,
    obligationId: "o-unpaid",
    idempotencyKey: "e2e-retry-key-0001",
    amountMinor: "200",
    method: "cash",
  };
  const once = await direct(p5, "recordCustomerPayment", dupReq);
  assert(once.ok === true && once.data.duplicate === false, "a fresh key posts a real payment");
  const twice = await direct(p5, "recordCustomerPayment", dupReq);
  assert(twice.ok === true, "🔴 the replay is answered, not refused");
  assert(twice.data.duplicate === true, "🔴 and it is flagged as a DUPLICATE, not a second payment");
  assert(
    twice.data.settlement.id === once.data.settlement.id,
    "🔴 the SAME settlement row comes back — the money was taken once",
  );
  // 🔴 AND A CHANGED AMOUNT UNDER THAT KEY IS REFUSED.
  const clash = await direct(p5, "recordCustomerPayment", { ...dupReq, amountMinor: "300" });
  assert(clash.ok === false, "🔴 the same key with a different amount is refused");
  assert(clash.error.code === "IDEMPOTENCY_CONFLICT", `🔴 with IDEMPOTENCY_CONFLICT (got ${clash.error.code})`);

  // ── C · settle it IN FULL, and show the paid badge ───────────────────────────────────────────
  // 🔴 NOT `page.reload()`. The two payments above went through the bridge, so the statement on
  // screen is stale — but reloading an Electron window risks the session this test is signed into.
  // Selecting the OTHER «محمد علي» and coming back changes `customerId` twice, which is what the
  // component's own effect watches, so it refetches for the real reason rather than by force.
  await testid(p5, "customers-search").fill("0222222");
  await p5.locator(`[data-customer="${emptyCustomerId}"]`).first().click();
  await testid(p5, "statement-empty").waitFor({ state: "visible", timeout: 30000 });
  await testid(p5, "customers-search").fill("0111111");
  await p5.locator(`[data-customer="${statementCustomerId}"]`).first().click();
  await testid(p5, "customer-statement").waitFor({ state: "visible", timeout: 30000 });
  assert(
    (await outstandingText("o-unpaid")).includes("13.00"),
    `after the 2.00 bridge payment the debt is 13.00 (${await outstandingText("o-unpaid")})`,
  );

  await card("o-unpaid").locator('[data-testid="collect-open"]').click();
  await testid(p5, "collect-amount").fill("13.00");
  await testid(p5, "collect-confirm").click();
  await testid(p5, "collect-done").waitFor({ state: "visible", timeout: 30000 });

  const settledBadge = card("o-unpaid").locator('[data-testid="statement-settled"]');
  await settledBadge.waitFor({ state: "visible", timeout: 30000 });
  assert((await settledBadge.innerText()).trim().length > 0, "🔴 the debt now shows as PAID IN FULL");
  assert(
    (await card("o-unpaid").locator('[data-testid="statement-outstanding"]').count()) === 0,
    "🔴 and no outstanding figure is printed beside it",
  );
  assert((await usdBalance()).includes("30.00"), `🔴 the USD balance is now 30.00 (${await usdBalance()})`);
  // 🔴 SCROLLED INTO VIEW BEFORE THE SHOT, so the settled badge is genuinely IN the screenshot
  // rather than below the fold — the S3B review could only verify that one by assertion.
  await settledBadge.scrollIntoViewIfNeeded();
  await p5.screenshot({ path: SHOTS + "S3C-A3-settled-badge-arabic.png" });

  // ── D · the Arabic overpayment refusal preserves the authoritative balance ──────────────────
  await card("o-part").locator('[data-testid="collect-open"]').click();
  await testid(p5, "collect-amount").fill("999.00");
  await testid(p5, "collect-confirm").click();
  await testid(p5, "collect-error").waitFor({ state: "visible", timeout: 30000 });
  const arabicRefusalText = (await testid(p5, "collect-error").innerText()).trim();
  assert(
    arabicRefusalText === "المبلغ المدخل أكبر من المتبقي على هذا الدَّين. المتبقي: \u206830.00 USD\u2069.",
    `🔴 Arabic overpayment refusal preserves the exact outstanding amount (${arabicRefusalText})`,
  );
  assert(!arabicRefusalText.includes("3000 USD"), `🔴 Arabic never presents raw minor units (${arabicRefusalText})`);
  await p5.screenshot({ path: SHOTS + "S3C-A4-overpayment-refused-arabic.png" });
  await testid(p5, "collect-cancel").click();

  // ── E · the same screen in English ───────────────────────────────────────────────────────────
  await p5.locator('[data-testid="lang-toggle"]').click();
  await testid(p5, "customer-statement").waitFor({ state: "visible", timeout: 30000 });
  await card("o-part").locator('[data-testid="collect-open"]').click();
  await testid(p5, "collect-form").waitFor({ state: "visible", timeout: 30000 });
  await p5.screenshot({ path: SHOTS + "S3C-A4-collect-form-english.png" });

  // ── F · an overpayment is refused in English, on screen, and writes nothing ─────────────────
  await testid(p5, "collect-amount").fill("999.00");
  await testid(p5, "collect-confirm").click();
  await testid(p5, "collect-error").waitFor({ state: "visible", timeout: 30000 });
  const refusalText = (await testid(p5, "collect-error").innerText()).trim();
  assert(
    refusalText === "That is more than is owed; 30.00 USD remains",
    `🔴 English overpayment refusal preserves the exact outstanding amount (${refusalText})`,
  );
  assert(!refusalText.includes("3000 USD"), `🔴 English never presents raw minor units (${refusalText})`);
  await p5.screenshot({ path: SHOTS + "S3C-A5-overpayment-refused-english.png" });
  await owner3.close().catch(() => undefined);

  // ── G · the ledger agrees, and nothing else moved ────────────────────────────────────────────
  {
    const db = new Database(LEDGER, { readonly: true });
    const n = (sql) => Number(db.prepare(sql).get().n);
    // 2 seeded + 3 recorded by S3C (10.00 UI, 2.00 bridge, 13.00 UI) = 5. The refused duplicate,
    // the conflict and the overpayment each wrote nothing.
    assert(n("SELECT count(*) AS n FROM settlements") === 5, `five settlements exist (${n("SELECT count(*) AS n FROM settlements")})`);
    assert(n("SELECT count(*) AS n FROM obligations") === 3, "🔴 and still exactly three obligations — none was CREATED");
    assert(
      n("SELECT sum(amount_minor) AS n FROM settlements WHERE obligation_id = 'o-unpaid'") === 2500,
      "🔴 the settled debt is paid to exactly its original 2500 minor units, never beyond",
    );
    assert(n("SELECT count(*) AS n FROM sales") === 0, "🔴 not one sale was touched");
    assert(n("SELECT count(*) AS n FROM invoices") === 0, "and not one invoice");
    assert(n("SELECT count(*) AS n FROM parties") === 5, "and the directory is still five");
    // 🔴 THE ORIGINAL DEBT ROW IS UNCHANGED. A payment reduces what is OUTSTANDING; it never
    // rewrites what was owed.
    const o = db.prepare("SELECT amount_minor, posted_at FROM obligations WHERE id = 'o-unpaid'").get();
    assert(Number(o.amount_minor) === 2500, `the original amount is still 2500 (${o.amount_minor})`);
    assert(o.posted_at === "2026-10-20T08:00:00.000Z", "and its posting time is untouched");
    assert(n("SELECT count(*) AS n FROM schema_migrations") === 14, "the ledger is still at schema v14");
    db.close();
  }

  log("customer collection E2E complete");
  log("customer statement E2E complete");
} finally {
  await app?.close().catch(() => undefined);
}
