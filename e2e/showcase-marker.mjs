// SHOWCASE MARKER guards (owner, DEC-35h §5) — against the real app, on throw-away profiles.
//
//   node e2e/showcase-marker.mjs
//
// Proven: an ordinary profile — even one holding products — shows NO showcase banner; the SAME
// profile with the tooling-written marker shows it, for owner and cashier alike, and changes nothing
// else: the real catalogue is served, a sample-catalog sale is still refused, the demo switch is still
// refused on merchant data, a cashier still cannot read a statement; a malformed marker shows nothing;
// a full backup of a marked profile does not carry the marker, so a restore into a new profile shows
// no banner; the app never writes the marker.
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
const home = mkdtempSync(join(tmpdir(), "pos-e2e-showcase-"));
const MARKER = "alzabt-showcase-profile.json";
const GOOD = JSON.stringify({ kind: "alzabt-pos-showcase-profile", version: 1 }) + "\n";

let passed = 0;
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  passed++;
  log("PASS", msg);
};
async function launch(userData, extraEnv = {}) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env: { ...process.env, ALZABT_POS_USER_DATA: userData, ...extraEnv } });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 60000 });
  return { app, page };
}
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const direct = (page, m, p) => page.evaluate(([m, p]) => window.pos[m](p), [m, p]);
const okOf = (r, what) => {
  if (!r || !r.ok) throw new Error(`${what}: ${JSON.stringify(r && r.error)}`);
  return r.data;
};
const settle = (page) => page.waitForTimeout(800);

// ── 1 · An ordinary profile WITH products: no showcase banner ───────────────────────────────────────
const shop = join(home, "shop");
let { app, page } = await launch(shop);
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
okOf(await direct(page, "createProduct", { draft: { nameAr: "عدس أحمر", nameEn: "Red Lentils", sku: "SHOP-1", price: "2.30", baseUnit: "piece" } }), "createProduct");
await tid(page, "tab-today").click();
await tid(page, "tab-sell").click();
await page.locator("button.product").first().waitFor({ timeout: 30000 });
await settle(page);
assert((await tid(page, "showcase-banner").count()) === 0, "🔴 a profile that merely HAS products (as after an import) shows NO showcase banner");
await app.close();
assert(!existsSync(join(shop, MARKER)), "🔴 the app wrote no marker into the profile");

// ── 2 · The SAME profile with the tooling-written marker: banner, and nothing else changes ─────────
writeFileSync(join(shop, MARKER), GOOD, "utf8");
({ app, page } = await launch(shop, { ALZABT_POS_DEMO_CATALOG: "1" }));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
await tid(page, "showcase-banner").waitFor({ timeout: 15000 });
assert((await tid(page, "showcase-banner").innerText()).includes("DEMO"), "the marked profile shows the showcase banner (owner)");
assert((await tid(page, "demo-banner").count()) === 0, "🔴 …and NOT the sample-catalog banner: the demo switch is still refused on merchant data");
const cat = okOf(await direct(page, "getCatalog", undefined), "getCatalog");
assert(cat.demo === false && cat.showcaseProfile === true && cat.products.length === 1 && cat.products[0].sku === "SHOP-1", "🔴 the REAL catalogue is served — never the sample one");
const forced = await direct(page, "createSale", { idempotencyKey: "showcase-forced-sample-1", lines: [{ productId: "prod-0001", quantityMilli: 1000 }], paymentMethod: "cash", expectedTotalMinor: "250" });
assert(!forced.ok && forced.error.code === "UNKNOWN_PRODUCT", `🔴 a sample-catalog sale is still refused (${JSON.stringify(forced.error)})`);
await page.screenshot({ path: SHOTS + "SHOWCASE1-banner-owner.png" });
await tid(page, "logout").click();
await tid(page, "select-cashier").waitFor();
await signIn(page, "Cashier Two", "2222");
await tid(page, "cart").waitFor();
await tid(page, "showcase-banner").waitFor({ timeout: 15000 });
assert(true, "the cashier sees the same banner");
const st = await direct(page, "getCustomerStatement", { customerId: "x" });
assert(!st.ok && st.error.code !== "OK", `🔴 permissions unchanged: a cashier still cannot read a statement (${st.error.code})`);
await app.close();

// ── 3 · A malformed marker shows nothing ───────────────────────────────────────────────────────────
writeFileSync(join(shop, MARKER), JSON.stringify({ kind: "alzabt-pos-showcase-profile", version: 1, demoCatalog: true }), "utf8");
({ app, page } = await launch(shop));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
await settle(page);
assert((await tid(page, "showcase-banner").count()) === 0, "🔴 a marker with any extra field (or wrong shape) is ignored — no banner, no extra power");
await app.close();

// ── 4 · Backup of a MARKED profile → restore into a NEW profile: no marker, no banner ──────────────
writeFileSync(join(shop, MARKER), GOOD, "utf8");
({ app, page } = await launch(shop));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
const usb = join(home, "usb");
mkdirSync(usb, { recursive: true });
await app.evaluate(({ dialog }, p) => { dialog.showOpenDialogSync = () => [p]; }, usb);
const backup = okOf(await direct(page, "exportFullBackup", undefined), "exportFullBackup");
assert(backup.status === "saved" && backup.complete === true, "a complete full backup of the marked profile was written");
await app.close();
const pkg = join(backup.location, backup.folderName);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [e.name]));
assert(!walk(pkg).includes(MARKER), "🔴 the backup package does NOT contain the marker");
const engine = require(join(APP, "dist", "main", "persistence", "restoreEngine.js"));
const restored = join(home, "restored");
mkdirSync(restored, { recursive: true });
const inspected = engine.inspectRestorePackage(pkg);
engine.stageRestore({ userDataDir: restored, packageDir: pkg, consent: { manifestSha256: inspected.manifestSha256, acceptedMissingAssets: [] }, now: new Date() });
({ app, page } = await launch(restored));
await signIn(page, "Cashier One", "1111");
await tid(page, "cart").waitFor();
await settle(page);
assert(!existsSync(join(restored, MARKER)) && (await tid(page, "showcase-banner").count()) === 0, "🔴 the restored profile has no marker and no banner");
assert(okOf(await direct(page, "getCatalog", undefined), "getCatalog").products.length === 1, "…and its data came back intact");
await app.close();
console.log(`SHOWCASE MARKER E2E PASSED — ${passed} checks`);
