/**
 * Alzabt POS — the owner's Demo journey on the COMBINED (J1) build. ⚠️ PREPARED, NOT RUN.
 * Owner: Claude (functional). Security E2E is Codex's (e2e/demo-security.mjs). Placed in e2e/ at J1 only.
 *
 * Journey (one named check each; exit 1 on ANY failure; exit 2 = NOT RUN, inputs missing):
 *   W1  fresh synthetic REAL profile → Welcome; Arabic RTL (html dir=rtl) and English LTR (dir=ltr) both render
 *   W2  «جرّب النظام» → Main's native confirm (stubbed in THIS Playwright-launched process) → "restarting";
 *       the process exits (app.relaunch handover, BR-C-06 V7)
 *   D1  successor (attached over CDP, E-1): Demo banner, NO login form, a session name (D-6)
 *   D2  22 tiles, 22 decoded photos, 22 DISTINCT stored image hashes, every tile name = its mapping SKU's name
 *   D3  sale (two products, cash) → on-screen receipt
 *   D4  receipt «80 مم» → a PREVIEW window carrying the demo mark; the note says preview (print.previewOpened);
 *       no PDF button
 *   D5  invoice: new outgoing, one line, finalize → «طباعة» → A4 preview with mark (+ logo); no «حفظ PDF»
 *   D6  a refused action returns DEMO_RESTRICTED and reads in Arabic
 *   D7  Today: no money panel
 *   D8  English pass on the Demo: switch language → dir=ltr, banner in English; switch back
 *   D9  «ابدأ التجربة من جديد» → confirm (E-2) → a NEW successor: banner, the catalog fresh (no history rows)
 *   D10 «الخروج من التجربة» → confirm (E-2) → the REAL process: no Demo banner, logged out (N4 surface check)
 *
 * Harness requirements (Codex, to be agreed at J1; none may become a shipped authority switch):
 *   E-1  In DEV-GATED builds only, app.relaunch keeps a Chromium `--remote-debugging-port=<p>` that the FIRST
 *        process was started with, so this script can attach to each successor over CDP. Never in distributables
 *        (X3/N6). K and the nonce stay as V7 defines; this script never reads or forges them.
 *   E-2  Native confirmations in successors (no main-process access over CDP) are pressed by a Windows UI
 *        Automation helper (E2E_CONFIRM_HELPER, a script that clicks the confirm button by its AR/EN label in a
 *        window owned by the tracked successor PID only).
 *   E-3  SAFETY: relaunch inherits the environment. The Demo successor's profile must come ONLY from the verified
 *        intent; ALZABT_POS_USER_DATA must never select or redirect the Demo profile.
 *
 * Inputs: E2E_EXECUTABLE (built app), E2E_CDP_PORT, E2E_CONFIRM_HELPER, E2E_DEMO_MAPPING
 * (…\c2-demo-assets-staging-2026-11-18\catalog\product-image-mapping.json, read-only), E2E_SHOTS.
 * Run under the dedicated test identity (alzabt-test) with synthetic profiles only. No shop profile, printer,
 * phone or network.
 */
import { _electron as electron, chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const need = ["E2E_EXECUTABLE", "E2E_CDP_PORT", "E2E_CONFIRM_HELPER", "E2E_DEMO_MAPPING"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`NOT RUN: needs the J1 build and harness (${missing.join(", ")} not set).`);
  process.exit(2);
}
const port = Number(process.env.E2E_CDP_PORT);
const shots = process.env.E2E_SHOTS ?? join(tmpdir(), "alzabt-demo-journey-shots");
mkdirSync(shots, { recursive: true });
const mapping = JSON.parse(readFileSync(process.env.E2E_DEMO_MAPPING, "utf8"));

const checks = [];
const check = (id, ok, detail = "") => {
  checks.push({ id, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
};
const t = (page, id) => page.getByTestId(id);
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }).catch(() => undefined);
const dir = (page) => page.evaluate(() => document.documentElement.dir);

/** Attach to whichever product process now listens on the CDP port (a successor after app.relaunch). */
async function attachSuccessor(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !/preview/i.test(p.url()));
      if (page) return { browser, page };
      await browser.close();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("successor did not come up on the CDP port");
}
/** E-2: press the native confirmation (helper verifies the owning PID itself). */
const confirmNative = (label) => execFileSync(process.execPath, [process.env.E2E_CONFIRM_HELPER, label], { stdio: "inherit", timeout: 75_000 });

const realProfile = mkdtempSync(join(tmpdir(), "alzabt-journey-real-"));
let browser;
try {
  // ── W: the REAL process, launched by Playwright ─────────────────────────────────────────────
  const first = await electron.launch({
    executablePath: process.env.E2E_EXECUTABLE,
    args: [`--remote-debugging-port=${port}`],
    env: { ...process.env, ALZABT_POS_USER_DATA: realProfile, ALZABT_POS_DISABLE_AUTOSTART: "1", ELECTRON_RUN_AS_NODE: "" },
  });
  const w = await first.firstWindow();
  await t(w, "welcome-screen").waitFor({ timeout: 60_000 });
  check("W1-welcome", await t(w, "welcome-screen").isVisible());
  check("W1-ar-rtl", (await dir(w)) === "rtl");
  await t(w, "lang-toggle").click();
  check("W1-en-ltr", (await dir(w)) === "ltr");
  await shot(w, "W1-welcome-en");
  await t(w, "lang-toggle").click();
  check("W1-back-ar", (await dir(w)) === "rtl");
  await shot(w, "W1-welcome-ar");
  check("W1-demo-offered", (await t(w, "welcome-demo").count()) === 1);

  // Stub ONLY this test-launched process's native confirm: answer the first button that is NOT Main's cancelId.
  // (A test seam in the test process, not a product switch. Main must set cancelId on its confirmation — E-2.)
  await first.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (_w, opts) => {
      const o = opts ?? _w;
      const n = o?.buttons?.length ?? 2;
      const cancel = typeof o?.cancelId === "number" ? o.cancelId : -1;
      const confirm = [...Array(n).keys()].find((i) => i !== cancel) ?? 0;
      return { response: confirm, checkboxChecked: false };
    };
  });
  const exited = new Promise((r) => first.process().once("exit", r));
  await t(w, "welcome-demo").click();
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("no relaunch")), 75_000))]);
  check("W2-handover-exit", true);

  // ── D: the Demo successor (attached over CDP) ───────────────────────────────────────────────
  ({ browser, page: globalThis.d } = await attachSuccessor());
  const d = globalThis.d;
  await t(d, "demo-mode-banner").waitFor({ timeout: 90_000 });
  check("D1-banner", await t(d, "demo-mode-banner").isVisible());
  check("D1-no-login", (await t(d, "select-cashier").count()) === 0 && (await d.locator('input[type="password"]').count()) === 0);
  check("D1-session", ((await t(d, "session-name").textContent()) ?? "").trim().length > 0);
  await shot(d, "D1-demo-ar");

  await t(d, "tab-sell").click();
  const thumbs = d.getByTestId("sell-thumb-image");
  await thumbs.first().waitFor({ timeout: 30_000 });
  const decoded = await thumbs.evaluateAll((imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length);
  check("D2-22-photos", decoded === 22, `decoded ${decoded}`);
  const own = await d.evaluate(async (expected) => {
    const cat = await window.pos.getCatalog();
    if (!cat.ok) return { ok: false, why: "catalog" };
    const bySku = new Map(expected.map((p) => [p.sku, p]));
    const hashes = new Set();
    let wrong = 0;
    for (const p of cat.data.products) {
      const e = bySku.get(p.sku);
      const meta = await window.pos.getProductImageMeta({ productId: p.id });
      if (!e || !meta.ok || !meta.data || (p.nameAr ?? p.name_ar) !== e.name_ar) wrong++;
      else hashes.add(meta.data.sha256);
    }
    return { ok: wrong === 0, wrong, products: cat.data.products.length, distinctImages: hashes.size };
  }, mapping.products);
  check("D2-own-photo-per-sku", own.ok && own.products === 22 && own.distinctImages === 22, JSON.stringify(own));
  const categories = await d.evaluate(async () => (await window.pos.listCategories?.())?.data?.length ?? -1);
  check("D2-8-categories", categories === 8, `categories ${categories}`);

  await d.locator("button.product").nth(0).click();
  await d.locator("button.product").nth(1).click();
  await t(d, "complete-sale").click();
  await t(d, "pay-cash").click();
  await t(d, "receipt").waitFor({ timeout: 30_000 });
  check("D3-receipt", await t(d, "receipt").isVisible());
  check("D4-no-pdf", (await t(d, "receipt-pdf").count()) === 0);
  const ctx = d.context();
  const previewPromise = ctx.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await t(d, "receipt-print-80").click();
  const preview = await previewPromise;
  check("D4-preview-window", !!preview, preview ? preview.url() : "no preview");
  if (preview) {
    await preview.waitForLoadState();
    check("D4-mark", (await preview.locator('[data-alzabt-demo-mark="mark"]').count()) === 1);
    await shot(preview, "D4-preview-80");
  }
  check("D4-preview-note", ((await d.locator('[data-testid="receipt-print-bar"]').textContent()) ?? "").length > 0);

  await t(d, "tab-invoices").click();
  await t(d, "new-invoice").click();
  await t(d, "mode-outgoing").click();
  check("D5-no-save-pdf", (await t(d, "save-pdf").count()) === 0);
  // Line entry → finalize → print: selectors confirmed at J1 against the combined InvoiceSheet (F-3).
  await t(d, "finalize").click().catch(() => undefined);
  await t(d, "finalize-confirm-yes").click().catch(() => undefined);
  const a4 = ctx.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await t(d, "print").click().catch(() => undefined); // InvoiceSheet.tsx:1321 data-testid="print"
  const a4p = await a4;
  check("D5-a4-preview-mark", !!a4p && (await a4p.locator('[data-alzabt-demo-mark="mark"]').count()) === 1);

  const refusal = await d.evaluate(async () => (await window.pos.exportBackup()).error?.code ?? "allowed");
  check("D6-refused", refusal === "DEMO_RESTRICTED", refusal);
  await t(d, "tab-today").click();
  check("D7-no-money-panel", (await t(d, "dm-date").count()) === 0);

  await t(d, "lang-toggle").click();
  check("D8-en-ltr", (await dir(d)) === "ltr");
  await shot(d, "D8-demo-en");
  await t(d, "lang-toggle").click();

  // D9 Start Fresh → a new successor with a fresh catalog.
  await t(d, "demo-reset").click();
  confirmNative("start-fresh");
  await browser.close().catch(() => undefined);
  ({ browser, page: globalThis.d2 } = await attachSuccessor());
  const d2 = globalThis.d2;
  await t(d2, "demo-mode-banner").waitFor({ timeout: 90_000 });
  await t(d2, "tab-history").click();
  check("D9-fresh-no-history", (await t(d2, "history-row").count()) === 0);

  // D10 Exit → the REAL process, logged out, no Demo banner.
  await t(d2, "demo-exit").click();
  confirmNative("exit");
  await browser.close().catch(() => undefined);
  ({ browser, page: globalThis.r } = await attachSuccessor());
  const r = globalThis.r;
  await r.waitForLoadState();
  check("D10-real-no-banner", (await t(r, "demo-mode-banner").count()) === 0);
  check("D10-logged-out", (await t(r, "session-name").count()) === 0);
  await shot(r, "D10-real");
} catch (e) {
  check("journey-error", false, e instanceof Error ? e.message : String(e));
} finally {
  await browser?.close().catch(() => undefined);
}
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map((c) => c.id) }));
process.exit(failed.length === 0 ? 0 : 1);
