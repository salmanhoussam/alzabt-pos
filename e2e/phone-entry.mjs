/**
 * E2E — slice H2: entering a product from a phone, against the INSTALLED app.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE QR IS READ THE WAY A PHONE READS IT: the dialog's QR element is PHOTOGRAPHED with a real
 * element screenshot, and the PNG is decoded with `zxing-wasm`'s reader. Nothing in the app is
 * asked for the token — the DTO does not carry one, the dialog never prints one, and no test hook
 * was added to expose one.
 *
 * That is a deliberate choice over the alternatives. A test-only channel returning the token would
 * be a real surface added for a test's convenience. Reading main's memory would need the bridge
 * exported. Decoding the picture needs neither, and it proves something stronger than either: that
 * the symbol this dialog actually renders, at the size and contrast the CSS gives it, is
 * MACHINE-READABLE. A QR that renders but cannot be decoded would pass a "the svg exists"
 * assertion and fail in a merchant's hand.
 *
 * 🔴 THE READER IS USED HERE AND NOWHERE IN THE PRODUCT. Slice I owns barcode decoding as a
 * FEATURE — photographing a product's barcode and reading it. This is test tooling reading our own
 * pairing code, in a file that is never packaged (`build.files` ships `dist/**` and
 * `package.json`). No product code gained a reader in H2.
 *
 * 🔴 AND THE PHONE ITSELF IS A SYNTHETIC HTTP CLIENT, which is honest but LIMITED. It proves the
 * served form, the save path, the refusals and the lifecycle. It does NOT prove a phone crossing
 * Windows Firewall, a real mobile browser's rendering, or iPhone file capture. Those stay physical
 * acceptance gates — §18 — and this script claims none of them.
 *
 * Run: node e2e/phone-entry.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const require_ = createRequire(import.meta.url);
const ELECTRON = PACKAGED ?? require_("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];

const home = mkdtempSync(join(tmpdir(), "pos-e2e-phone-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };

const log = (...a) => console.log("•", ...a);
let step = 0;
let failures = 0;
const check = (cond, msg) => {
  step += 1;
  if (cond) console.log(`  ✓ ${step} ${msg}`);
  else {
    failures += 1;
    console.log(`  ✗ ${step} ${msg}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
};
const testid = (page, id) => page.locator(`[data-testid="${id}"]`);

// ── The QR reader, with its WASM read from disk. No CDN, in a test either. ─────────────────────
const reader = require_("zxing-wasm/reader");
reader.prepareZXingModule({
  overrides: { wasmBinary: readFileSync(require_.resolve("zxing-wasm/reader/zxing_reader.wasm")) },
  fireImmediately: false,
});

/** Decode the pairing URL out of a PNG of the on-screen QR. */
async function decodeQr(png) {
  const hits = await reader.readBarcodes(new Blob([png], { type: "image/png" }), {
    formats: ["QRCode"],
    tryHarder: true,
  });
  return hits.length > 0 ? hits[0].text : null;
}

/** A plain HTTP request to the till's temporary listener — this script standing in for a phone. */
async function phoneRequest(url, { method = "GET", body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === null ? {} : { body }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

const submission = (over = {}) =>
  JSON.stringify({
    product: {
      nameAr: "مفتاح من الهاتف",
      nameEn: "Phone Wrench",
      sku: "PH-1",
      price: "17.25",
      baseUnit: "piece",
      ...(over.product ?? {}),
    },
    master: {
      categoryId: "",
      barcode: "036000291452",
      brand: "Stanley",
      descriptionAr: "أُدخل من الهاتف",
      descriptionEn: "",
      isOnlineVisible: true,
      ...(over.master ?? {}),
    },
  });

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");
  return { app, page };
}

/**
 * Open the pairing dialog and return everything about it, PHOTOGRAPHED BEFORE ANYTHING IS CLICKED.
 *
 * 🔴 THE SCREENSHOT ORDER IS THE POINT. G3's own defect was a file named "export summary" that
 * showed the Products list, because the script dismissed the dialog and photographed afterwards.
 * Here the dialog shot and the QR element shot are both taken while the dialog is open and before
 * any save, cancel or close.
 */
async function openPairing(page, shotName, opener) {
  await opener();
  const dialog = testid(page, "phone-dialog");
  await dialog.waitFor({ state: "visible", timeout: 30000 });
  const qr = testid(page, "phone-qr");
  await qr.waitFor({ state: "visible", timeout: 30000 });
  // Give the SVG a frame to lay out before it is photographed.
  await page.waitForTimeout(400);

  await page.screenshot({ path: SHOTS + shotName + ".png" });
  const png = await qr.screenshot({ path: SHOTS + shotName + "-qr.png" });

  const dialogText = (await dialog.innerText()).trim();
  const address = (await testid(page, "phone-address").innerText()).trim();
  const box = await qr.boundingBox();
  return { dialog, qr, png, dialogText, address, box };
}

const { app, page } = await launch();

try {
  // ── 1 · The owner sees the action, and the dialog renders a real, scannable QR ───────────────
  log("owner opens Add Product from Phone");
  await testid(page, "tab-products").click();
  await page.waitForSelector('[data-testid="add-product"]');

  check((await testid(page, "add-product-phone").count()) === 1, "the OWNER sees «إضافة صنف من الهاتف»");

  const pairing = await openPairing(page, "H1-phone-dialog-arabic", () =>
    testid(page, "add-product-phone").click(),
  );

  // 🔴 THE QR IS NOT MERELY PRESENT — IT CARRIES REAL MODULE GEOMETRY AND IS BIG ENOUGH TO SCAN.
  //
  // 🔴 AND THE FIRST VERSION OF THIS CHECK WAS WRONG ABOUT CORRECT CODE. It counted
  // `rect, path` elements and demanded more than ten, assuming a QR is drawn as one rect per
  // module. zxing-wasm's SVG writer does not work that way: it emits ONE background `<rect>` and
  // ONE `<path>` whose `d` holds the entire pattern. The gate reported "2 shapes" against a
  // perfectly good symbol that the screenshot decode (below) read without trouble.
  //
  // Measured on a real pairing URL: `d` is ~4,300 characters with ~310 `M` commands — one per
  // module run. THAT is the geometry, so that is what is asserted. A blank or stub symbol has
  // almost none, so this still fails for the reason the original was reaching for, without
  // weakening into "an svg exists".
  const svgInfo = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="phone-qr"] svg');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const d = Array.from(el.querySelectorAll("path"))
      .map((p) => p.getAttribute("d") ?? "")
      .join("");
    return {
      ns: el.namespaceURI,
      moves: (d.match(/M/g) ?? []).length,
      dLen: d.length,
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
  check(svgInfo !== null, "the dialog contains a real <svg> element");
  check(svgInfo?.ns === "http://www.w3.org/2000/svg", `the element is in the SVG namespace (${svgInfo?.ns})`);
  check(
    (svgInfo?.moves ?? 0) >= 100,
    `the QR carries real module geometry (${svgInfo?.moves} path moves, ${svgInfo?.dLen} chars)`,
  );

  // 🔴 THE PAINTED SYMBOL, NOT THE ELEMENT BOX — AND THIS REPLACES AN ASSERTION THAT COULD NOT
  // SEE THE DEFECT IT WAS SUPPOSED TO CATCH.
  //
  // The old check measured `getBoundingClientRect()` on the <svg> and reported "236x236, large
  // enough to scan". The ELEMENT was 236px; the drawing inside was ~45px in the top-left corner,
  // because zxing emits no viewBox and CSS was stretching an element whose contents did not
  // scale. The Windows screenshot showed a tiny QR floating in a big white plate while every
  // assertion stayed green.
  //
  // So this measures the ink: the path's own `getBBox()` (user units) pushed through
  // `getScreenCTM()` to real screen pixels, then compared against the plate. It fails if the
  // viewBox fix is removed — which is the only reason to write it.
  const painted = await page.evaluate(() => {
    const plate = document.querySelector('[data-testid="phone-qr"]');
    const path = plate?.querySelector("svg path");
    if (!plate || !path) return null;
    const bb = path.getBBox();
    const m = path.getScreenCTM();
    if (!m) return null;
    const pr = plate.getBoundingClientRect();
    // Transform the two opposite corners of the painted box into screen space.
    const pt = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    const p1 = pt(bb.x, bb.y);
    const p2 = pt(bb.x + bb.width, bb.y + bb.height);
    return {
      inkW: Math.round(Math.abs(p2.x - p1.x)),
      inkH: Math.round(Math.abs(p2.y - p1.y)),
      plateW: Math.round(pr.width),
      plateH: Math.round(pr.height),
      // How far the ink's top-left sits from the plate's, as a fraction of the plate.
      offX: Math.round(((Math.min(p1.x, p2.x) - pr.left) / pr.width) * 100),
      offY: Math.round(((Math.min(p1.y, p2.y) - pr.top) / pr.height) * 100),
    };
  });
  check(painted !== null, "the painted QR geometry is measurable");
  const fill = painted ? Math.round((painted.inkW / painted.plateW) * 100) : 0;
  check(
    fill >= 60,
    `🔴 the PAINTED symbol fills the plate (${painted?.inkW}x${painted?.inkH} ink in ` +
      `${painted?.plateW}x${painted?.plateH} plate = ${fill}%)`,
  );
  check(
    painted !== null && Math.abs(painted.inkW - painted.inkH) <= 4,
    `the painted symbol keeps its aspect ratio (${painted?.inkW}x${painted?.inkH})`,
  );
  // 🔴 NOT STUCK IN THE CORNER. With the viewBox missing the ink sat at ~0%,0%; a centred symbol
  // leaves a roughly equal margin on each side.
  check(
    painted !== null && painted.offX >= 2 && painted.offY >= 2,
    `the painted symbol is not jammed into the top-left (inset ${painted?.offX}%, ${painted?.offY}%)`,
  );
  check(
    svgInfo !== null && svgInfo.w >= 180 && svgInfo.h >= 180,
    `the QR renders large enough to scan (${svgInfo?.w}x${svgInfo?.h} CSS px)`,
  );
  check(
    pairing.box !== null && pairing.box.width >= 180,
    `the QR element occupies real space on screen (${Math.round(pairing.box?.width ?? 0)}px)`,
  );

  // Arabic copy, on the default Arabic terminal.
  check(pairing.dialogText.includes("امسح الرمز"), "the dialog's Arabic heading asks the owner to scan the code");
  check(pairing.dialogText.includes("نفس شبكة المحلّ"), "the Arabic copy says the phone must be on the shop network");
  check(
    pairing.dialogText.includes("لا تحتاج إلى إنترنت"),
    "🔴 the Arabic copy states that no Internet is needed — the claim the architecture makes",
  );
  check(pairing.dialogText.includes("الشبكات الخاصة"), "the honest Windows Firewall note is shown");
  check((await testid(page, "phone-countdown").count()) === 1, "an expiry countdown is shown");

  // 🔴 THE TOKEN IS NOT ON SCREEN ANYWHERE.
  const screenText = await page.evaluate(() => document.body.innerText);
  check(!/\b[0-9a-f]{64}\b/.test(screenText), "🔴 no 64-hex token appears as visible text anywhere on screen");

  // ── 2 · Decode the symbol the way a phone would ──────────────────────────────────────────────
  const url = await decodeQr(pairing.png);
  check(typeof url === "string" && url.length > 0, "🔴 the on-screen QR DECODES from a screenshot — it is scannable");
  assert(url, "the pairing QR could not be decoded; nothing below can run");
  log("decoded pairing URL host/port:", url.replace(/\/m\/[0-9a-f]+$/, "/m/<token>"));

  const parsed = /^http:\/\/([0-9.]+):(\d+)\/m\/([0-9a-f]{64})$/.exec(url);
  check(parsed !== null, "the QR carries exactly http://<ipv4>:<port>/m/<64-hex> and nothing else");
  assert(parsed, "the decoded URL is not the expected shape");
  const host = parsed[1];
  check(!/^127\.|^0\.0\.0\.0$/.test(host), `🔴 the QR points at a LAN address, never loopback (${host})`);
  check(pairing.address.includes(host), "the address shown to the owner is the address in the QR");

  // 🔴 VISUAL ORDER, NOT STRING ORDER — AND THIS IS THE ASSERTION THAT WAS MISSING.
  //
  // The line above uses `innerText`, which returns DOM order. It passed while the Windows
  // screenshot showed `60310:10.1.0.75` — the address BACKWARDS, because host and port were two
  // bidi-isolated runs with a neutral colon between them inside an RTL paragraph, so the
  // paragraph laid them out right-to-left. A merchant reading that aloud gives the wrong address.
  //
  // So the proof is where the characters actually ARE on screen, the same principle
  // `tests/renderer/lineMath.test.ts` uses for a receipt line: walk the text node character by
  // character with a Range and read each x. The host must be painted to the LEFT of the port.
  const addrOrder = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="phone-address"]');
    if (!el) return null;
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return null;
    const text = node.textContent ?? "";
    const xs = [];
    for (let i = 0; i < text.length; i += 1) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      xs.push({ ch: text[i], x: Math.round(r.getBoundingClientRect().left) });
    }
    return { text, xs };
  });
  check(addrOrder !== null, "the endpoint is one text run that can be measured");
  if (addrOrder) {
    const colonIdx = addrOrder.text.indexOf(":");
    const firstX = addrOrder.xs[0]?.x ?? 0;
    const colonX = addrOrder.xs[colonIdx]?.x ?? 0;
    const lastX = addrOrder.xs[addrOrder.xs.length - 1]?.x ?? 0;
    check(
      addrOrder.text === `${host}:${parsed[2]}`,
      `the endpoint reads exactly host:port ("${addrOrder.text}")`,
    );
    check(
      firstX < colonX && colonX < lastX,
      `🔴 host is painted LEFT of the colon, and the colon left of the port ` +
        `(x: ${firstX} < ${colonX} < ${lastX})`,
    );
  }
  check(!pairing.dialogText.includes(parsed[3]), "the token in the QR is not also printed in the dialog");

  // ── 3 · The phone fetches the form ───────────────────────────────────────────────────────────
  const form = await phoneRequest(url);
  check(form.status === 200, "the phone GETs the form over the LAN");
  check(form.text.includes('data-testid="phone-nameAr"'), "the served page is the real product form");
  check(form.text.includes('data-testid="phone-save"'), "the form has a Save button");
  check(form.text.includes('dir="rtl"'), "the mobile form is RTL");
  check(form.text.includes("إضافة صنف جديد"), "the mobile form's Arabic heading is correct for a NEW product");
  check(form.text.includes('data-testid="phone-photo-soon"'), "the photo section is a placeholder in H2, not an upload");
  check(!/https?:\/\//.test(form.text), "🔴 the mobile page references NO external URL — no CDN, no remote font");
  check(!form.text.includes(parsed[3]), "the served page does not echo the token");
  for (const u of ["piece", "box", "pack", "kg", "meter", "other"]) {
    check(form.text.includes(`value="${u}"`), `the authoritative unit '${u}' is offered by the form`);
  }

  // ── 4 · The phone saves, and the till shows it ───────────────────────────────────────────────
  const saved = await phoneRequest(url, { method: "POST", body: submission() });
  check(saved.status === 200 && saved.json?.ok === true, "the phone's Save succeeds");

  // The dialog's own success state, photographed BEFORE it is dismissed.
  const savedBanner = testid(page, "phone-dialog-saved");
  await savedBanner.waitFor({ state: "visible", timeout: 30000 });
  await page.screenshot({ path: SHOTS + "H2-phone-saved-arabic.png" });
  const savedText = (await savedBanner.innerText()).trim();
  check(savedText.includes("تم إضافة الصنف من الهاتف"), `the dialog reports the save in Arabic ("${savedText}")`);

  // 🔴 THE HEADING MOVED ON TOO. It used to keep saying «امسح الرمز بكاميرا الهاتف» — "scan the
  // code" — above a success message, a title describing the state the owner had already left.
  const doneTitle = (await testid(page, "phone-dialog-title").innerText()).trim();
  check(
    doneTitle.includes("تمّت إضافة الصنف"),
    `the success heading describes the ADDITION, not the previous pairing state ("${doneTitle}")`,
  );
  check(!doneTitle.includes("امسح"), "the stale «scan the code» heading is gone from the success state");
  // One success surface: the phone dialog and nothing stacked over it.
  check(
    (await page.locator(".overlay").count()) === 1,
    `exactly ONE overlay is on screen at success (${await page.locator(".overlay").count()})`,
  );
  check(
    !(await page.locator(".overlay").innerText()).includes("تعديلُ السعر"),
    "🔴 no price-history sentence appears on a phone save",
  );

  await testid(page, "phone-dialog-close").click();
  await testid(page, "phone-dialog").waitFor({ state: "detached", timeout: 30000 });

  // 🔴 THE PRODUCT IS IN THE DESKTOP LIST, read back from the ledger by the ordinary path.
  await page.waitForTimeout(500);
  const listText = await page.locator(".catalog-admin").innerText();
  check(listText.includes("مفتاح من الهاتف"), "🔴 the phone-entered product appears in the desktop list");
  check(listText.includes("17.25"), "with the price the phone submitted");
  await page.screenshot({ path: SHOTS + "H3-desktop-list-after-phone-save.png" });

  // ── 5 · Replay is refused and the listener is gone ───────────────────────────────────────────
  let replayRefused = false;
  try {
    const replay = await phoneRequest(url, { method: "POST", body: submission() });
    replayRefused = replay.json?.ok !== true;
  } catch {
    // Connection refused — the listener closed behind the save, which is the strongest refusal.
    replayRefused = true;
  }
  check(replayRefused, "🔴 replaying the saved session's URL is refused (or the port is simply gone)");

  // ── 6 · Edit from the phone, bound to one product ────────────────────────────────────────────
  log("owner opens Continue on Phone for an existing product");
  const editPairing = await openPairing(page, "H4-phone-dialog-edit", async () => {
    await testid(page, "product-edit-phone").first().click();
  });
  check(
    editPairing.dialogText.includes("امسح الرمز"),
    "the edit pairing dialog opens with the same scan instruction",
  );

  const editUrl = await decodeQr(editPairing.png);
  assert(editUrl, "the edit pairing QR could not be decoded");
  check(editUrl !== url, "🔴 the edit session's URL is a NEW token, not the spent one");

  const editForm = await phoneRequest(editUrl);
  check(editForm.status === 200, "the phone GETs the edit form");
  check(editForm.text.includes("تعديل صنف"), "the edit form's Arabic heading says EDIT, not ADD");
  // 🔴 PREFILLED FROM THE AUTHORITATIVE ROW — whichever product the first row is, its own values.
  const prefilled = /value="([^"]*)"[^>]*data-testid="phone-nameAr"|data-testid="phone-nameAr"[^>]*value="([^"]*)"/.exec(
    editForm.text,
  );
  check(prefilled !== null, "the edit form prefills the product's Arabic name");

  const editedName = (prefilled?.[1] ?? prefilled?.[2] ?? "") + " معدّل";
  const editSaved = await phoneRequest(editUrl, {
    method: "POST",
    body: submission({
      product: { nameAr: editedName, nameEn: "", sku: "", price: "99.00", baseUnit: "piece" },
      master: { categoryId: "", barcode: "", brand: "", descriptionAr: "", descriptionEn: "", isOnlineVisible: false },
    }),
  });
  check(editSaved.status === 200 && editSaved.json?.ok === true, "the phone's edit Save succeeds");

  const editBanner = testid(page, "phone-dialog-saved");
  await editBanner.waitFor({ state: "visible", timeout: 30000 });
  await page.screenshot({ path: SHOTS + "H5-phone-saved-edit-arabic.png" });
  check(
    (await editBanner.innerText()).includes("تم تحديث الصنف من الهاتف"),
    "the dialog reports an UPDATE, with its own sentence — not the add message",
  );
  const editTitle = (await testid(page, "phone-dialog-title").innerText()).trim();
  check(
    editTitle.includes("تمّ تحديث الصنف"),
    `the success heading is operation-specific — UPDATE, not addition ("${editTitle}")`,
  );
  await testid(page, "phone-dialog-close").click();
  await testid(page, "phone-dialog").waitFor({ state: "detached", timeout: 30000 });

  await page.waitForTimeout(500);
  const afterEdit = await page.locator(".catalog-admin").innerText();
  check(afterEdit.includes("معدّل"), "🔴 the edited product's new name appears in the desktop list");
  check(afterEdit.includes("99.00"), "with the price the phone submitted");
  await page.screenshot({ path: SHOTS + "H6-desktop-list-after-phone-edit.png" });

  // ── 7 · Cancel closes the session ────────────────────────────────────────────────────────────
  log("owner cancels a pairing session");
  const cancelPairing = await openPairing(page, "H7-phone-dialog-before-cancel", () =>
    testid(page, "add-product-phone").click(),
  );
  const cancelUrl = await decodeQr(cancelPairing.png);
  assert(cancelUrl, "the cancel-case QR could not be decoded");
  // It is reachable while open.
  check((await phoneRequest(cancelUrl)).status === 200, "the session answers while it is open");

  await testid(page, "phone-dialog-cancel").click();
  await testid(page, "phone-dialog").waitFor({ state: "detached", timeout: 30000 });

  let closed = false;
  try {
    const after = await phoneRequest(cancelUrl);
    closed = after.status === 404;
  } catch {
    closed = true; // connection refused — the port is shut
  }
  check(closed, "🔴 Cancel really closes the surface — the URL no longer serves");
  await page.screenshot({ path: SHOTS + "H8-desktop-after-cancel.png" });

  // ── 8 · The cashier has no mutation capability ───────────────────────────────────────────────
  //
  // 🔴 THE CASHIER IS SIGNED IN THROUGH THE REAL UI, NOT THROUGH `window.pos.login`.
  // `cashier-02` still carries `must_reset_pin = 1`, so a bare bridge login returns a SETUP
  // TICKET rather than a session — `{ok:true}` with no session behind it. A first draft of this
  // step did exactly that and would have "proven" the refusal with nobody logged in, where
  // `startPhoneSession` answers NOT_LOGGED_IN and the owner guard is never reached. `signIn`
  // completes the ceremony through the screens, which is the only way to get a real cashier
  // session on the installed app.
  log("cashier cannot open a phone session");
  await page.locator('[data-testid="logout"]').click();
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await signIn(page, "Cashier Two", "2222");
  await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });

  // A session really exists, so the refusals below mean something rather than passing because
  // nobody is signed in — which is the only thing this needs to establish.
  //
  // 🔴 IT DOES NOT READ A ROLE, AND THE REMOVED CHECK IS NAMED. There used to be a second
  // assertion here, `who?.role === "cashier"`, and it FAILED the gate against a perfectly correct
  // app: `currentCashier` returns `service.currentCashier()` raw (`ipcHandlers.ts:544`), so it
  // carries `{id, name}` and no role. Only `login` goes through `cashierDto()`, which attaches
  // one; `CashierDto.role` is declared optional and documented "Present on a SESSION". The test
  // was asserting a field the channel never promised.
  //
  // It was also redundant. The five checks below prove the operator is a cashier the way that
  // actually matters — the main process REFUSES every owner channel — and a behavioural refusal
  // is stronger evidence than a label read back from a session object. So it is deleted rather
  // than repaired, and no contract was widened to satisfy a test.
  const who = await page.evaluate(async () => {
    const r = await window.pos.currentCashier();
    return r?.data ?? null;
  });
  check(who !== null, `(a real session exists — ${who?.name ?? "none"})`);

  // Each payload is a shape the handler would ACCEPT, so a missing guard makes these go green for
  // the right reason rather than tripping payload validation and looking refused either way.
  const refusals = await page.evaluate(async () => {
    const start = await window.pos.startPhoneSession({ action: "NEW_PRODUCT" });
    const cancel = await window.pos.cancelPhoneSession();
    const state = await window.pos.phoneSessionState();
    return {
      start: { ok: start?.ok, code: start?.error?.code },
      cancel: { ok: cancel?.ok, code: cancel?.error?.code },
      state: { ok: state?.ok, code: state?.error?.code },
    };
  });

  check(
    refusals.start.ok === false && refusals.start.code === "NOT_AUTHORIZED",
    `🔴 a cashier calling window.pos.startPhoneSession directly is REFUSED as NOT_AUTHORIZED (${refusals.start.code})`,
  );
  check(
    refusals.cancel.ok === false && refusals.cancel.code === "NOT_AUTHORIZED",
    `a cashier cannot cancel an owner's phone session (${refusals.cancel.code})`,
  );
  check(
    refusals.state.ok === false && refusals.state.code === "NOT_AUTHORIZED",
    `a cashier cannot read the phone session state (${refusals.state.code})`,
  );

  // 🔴 AND PRESSING THE BUTTON FAILS SAFE — which is the assertion that matches how this screen
  // actually works. The Products screen deliberately does NOT branch on role: `channelPolicy.ts`
  // says in as many words that hiding a button is a courtesy and the renderer is the untrusted
  // side of the bridge. `add-product` has always been visible to a cashier and refused by main for
  // the same reason. So the claim worth proving is not that the control is absent — it is that
  // using it opens NO session and tells the operator plainly.
  //
  // (A first draft asserted the button was hidden. It is not, and asserting that would have
  // either failed honestly or pushed me to add role-branching the architecture argues against.)
  await testid(page, "tab-products").click();
  await page.waitForSelector('[data-testid="add-product-phone"]', { timeout: 30000 });
  await testid(page, "add-product-phone").click();
  await page.waitForTimeout(1200);
  check(
    (await testid(page, "phone-dialog").count()) === 0,
    "🔴 a cashier pressing the phone action opens NO pairing dialog",
  );
  // The refusal surfaces in the screen's own notice overlay (`.overlay .card.dialog` with an
  // `.error` paragraph) — the same place every other refused action on this screen reports.
  const errorCard = page.locator(".overlay .card.dialog").last();
  await errorCard.waitFor({ state: "visible", timeout: 20000 });
  const shownError = (await errorCard.innerText()).trim();
  check(shownError.length > 0, `and the refusal is shown to them ("${shownError.slice(0, 70).replace(/\n/g, " ")}")`);
  await page.screenshot({ path: SHOTS + "H9-cashier-refused.png" });
  await errorCard.locator("button").first().click();
} catch (err) {
  failures += 1;
  console.log("  ✗ UNCAUGHT: " + String(err).split("\n")[0]);
  try {
    await page.screenshot({ path: SHOTS + "H0-phone-entry-failure.png" });
    console.log("  (screen dump written to H0-phone-entry-failure.png)");
    console.log((await page.locator("body").innerText()).slice(0, 2000));
  } catch {
    console.log("  (could not photograph the failure)");
  }
} finally {
  await app.close().catch(() => undefined);
}

console.log("");
if (failures > 0) {
  console.log("CONCLUSION: failure");
  console.log(`steps passed: ${step - failures}`);
  console.log(`FAILED: ${failures} phone-entry check(s)`);
  process.exit(1);
}
console.log("CONCLUSION: success");
console.log(`steps passed: ${step}`);
