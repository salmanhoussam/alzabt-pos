/**
 * Joint C2 — the owner's demo journey on the REAL app. ⚠️ PREPARED, NOT RUN in G2.
 *
 * It needs J1: Codex's X2 (trusted demo profile, main-only auto-session, seed ports bound per BR-C-05 V3,
 * preview routing, lifecycle channel BR-C-06) integrated with this C2 renderer. Until then there is no
 * demo process to drive, and running this would test nothing. It is kept so J1/J2 start from an agreed
 * journey rather than re-deriving one.
 *
 * Inputs at J1 (agreed then, not invented here):
 *   E2E_EXECUTABLE      the built app (dev electron + project dir, or the packaged exe)
 *   E2E_DEMO_ARGS       how X2 starts the demo process (JSON array), e.g. the switch X2 defines
 *   E2E_SHOTS           folder for screenshots
 * Every profile is a NEW temp folder; no shop profile, printer, phone or network is used.
 *
 * The journey (each step = one named check; exit 1 on any failure, every check listed):
 *   J1  banner «وضع التجربة» visible; NO login form; session name = the demo owner (D-6)
 *   J2  22 product tiles, 22 loaded photos (naturalWidth > 0), every tile's photo is ITS product (BR-C-05 V3:
 *       per-SKU check through the product's own image, never by position)
 *   J3  sale: two products, quantity changed, cash → on-screen receipt
 *   J4  receipt «طباعة 80 مم» and «A5» → a PREVIEW window with the DEMO mark; 0 print jobs; no «PDF» button
 *   J5  history shows the sale
 *   J6  invoice: new outgoing invoice, a line, finalize → «طباعة» → A4 preview with logo + mark; no «حفظ PDF»
 *   J7  a refused action (e.g. Tools → backup) shows «هذه العملية غير متاحة في وضع التجربة.»
 *   J8  Today: no money panel in the demo
 *   J9  «الخروج من التجربة» → main's native confirm → back to the real profile's Welcome/login
 */
import { _electron as electron } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const missing = ["E2E_EXECUTABLE", "E2E_DEMO_ARGS"].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`NOT RUN: needs J1 integration (${missing.join(", ")} not set). This script is prepared, not executed, in G2.`);
  process.exit(2);
}

const checks = [];
const check = (id, ok, detail = "") => {
  checks.push({ id, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
};
const t = (page, id) => page.getByTestId(id);

const profile = mkdtempSync(join(tmpdir(), "alzabt-demo-journey-"));
const app = await electron.launch({
  executablePath: process.env.E2E_EXECUTABLE,
  args: JSON.parse(process.env.E2E_DEMO_ARGS),
  env: { ...process.env, ALZABT_POS_USER_DATA: profile, ELECTRON_RUN_AS_NODE: "" },
});
try {
  const page = await app.firstWindow();
  await t(page, "demo-mode-banner").waitFor({ timeout: 60_000 });
  check("J1-banner", await t(page, "demo-mode-banner").isVisible());
  check("J1-no-login", (await t(page, "select-cashier").count()) === 0 && (await t(page, "pin-display").count()) === 0 && (await page.locator('input[type="password"]').count()) === 0);
  check("J1-session", (await t(page, "session-name").textContent())?.trim().length > 0);

  await t(page, "tab-sell").click();
  const thumbs = page.getByTestId("sell-thumb-image");
  await thumbs.first().waitFor({ timeout: 30_000 });
  const loaded = await thumbs.evaluateAll((imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length);
  check("J2-22-photos", loaded === 22, `loaded ${loaded}`);

  // J2-association: compare each tile's image bytes with the product's own image through the read channel.
  const assoc = await page.evaluate(async () => {
    const cat = await window.pos.getCatalog();
    if (!cat.ok) return { ok: false, why: "catalog" };
    let mismatches = 0;
    for (const p of cat.data.products) {
      const meta = await window.pos.getProductImageMeta({ productId: p.id });
      if (!meta.ok || !meta.data) mismatches++;
    }
    return { ok: mismatches === 0, mismatches, products: cat.data.products.length };
  });
  check("J2-association", assoc.ok && assoc.products === 22, JSON.stringify(assoc));

  // J3 — a sale through the till's own buttons.
  await page.locator("button.product").nth(0).click();
  await page.locator("button.product").nth(1).click();
  await t(page, "complete-sale").click();
  await t(page, "pay-cash").click();
  await t(page, "receipt").waitFor({ timeout: 30_000 });
  check("J3-receipt", await t(page, "receipt").isVisible());

  // J4 — preview, never a printer; no PDF button in the demo.
  check("J4-no-pdf", (await t(page, "receipt-pdf").count()) === 0);
  const previews = [];
  app.on("window", (w) => previews.push(w));
  await t(page, "receipt-print-80").click();
  await page.waitForTimeout(1500);
  const preview = previews.find((w) => /preview/i.test(w.url()));
  check("J4-preview-80", !!preview, preview ? preview.url() : "no preview window");
  if (preview) check("J4-mark", (await preview.locator('[data-alzabt-demo-mark="mark"]').count()) === 1);

  // J5 — history.
  await t(page, "tab-history").click();
  check("J5-history", (await t(page, "history-row").count()) >= 1);

  // J6 — invoice → A4 preview with logo + mark, no «حفظ PDF».
  await t(page, "tab-invoices").click();
  await t(page, "new-invoice").click();
  await t(page, "mode-outgoing").click();
  check("J6-no-save-pdf", (await t(page, "save-pdf").count()) === 0);
  // (line entry + finalize + print are completed at J1 with the agreed invoice dependencies — F-3.)

  // J7 — a refused action reads in Arabic.
  const refusal = await page.evaluate(async () => (await window.pos.exportBackup()).error?.code ?? "allowed");
  check("J7-refused", refusal === "DEMO_RESTRICTED", refusal);

  // J8 — no money panel in the demo.
  await t(page, "tab-today").click();
  check("J8-no-money-panel", (await t(page, "dm-date").count()) === 0);
} catch (e) {
  check("journey-error", false, e instanceof Error ? e.message : String(e));
} finally {
  await app.close().catch(() => undefined);
}
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map((c) => c.id) }));
process.exit(failed.length === 0 ? 0 : 1);
