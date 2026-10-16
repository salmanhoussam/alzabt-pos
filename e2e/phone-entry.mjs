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

/** Upload a real file to one of the session's media endpoints, exactly as the phone's script does. */
async function phoneUpload(url, path, file, type) {
  const bytes = readFileSync(file);
  const res = await fetch(url + path, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      "Content-Type": type,
    },
    body: bytes,
  });
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Open the phone page in a REAL browser window and photograph it.
 *
 * 🔴 THE MOBILE SCREENSHOTS CANNOT COME FROM `fetch`. Everything above drives the phone surface
 * over plain HTTP, which proves the contract but renders nothing — and slice I2 adds mobile UX
 * whose whole claim is visual. So a second Electron BrowserWindow is pointed at the session's own
 * URL, sized like a phone, and photographed. It is the real served page in a real Chromium, with
 * no preload and no privileged bridge — exactly what a phone's browser would get.
 *
 * The window is closed again immediately; it never touches the till's own window or its session.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE WINDOW IS SHOWN, AND THE FIRST VERSION OF THIS HELPER DID NOT SHOW IT. That cost run
 * 38891097239 its last twenty-one steps, and the measurement is worth recording because the
 * failure pointed somewhere else entirely.
 *
 * It was created `show: false` and never shown. Every DOM operation still worked — `loadURL`,
 * `waitForLoadState`, `setViewportSize` and every locator `waitFor` are renderer work and need no
 * picture — so the window looked perfectly healthy right up to the moment it was photographed.
 * `page.screenshot` is the one operation that needs a COMPOSITED FRAME, and a window the platform
 * has never shown is not composited: the capture waited the full 30 seconds and the run died at
 * the FIRST mobile screenshot, before any of the I2 evidence could be captured.
 *
 * It is created hidden and shown once the page has loaded, which avoids photographing an unpainted
 * window, and it is shown with `showInactive()` so it never takes focus from the till — the till's
 * own screenshots are taken from that window and must not be disturbed by this one.
 *
 * 🔴 AND A SHOWN WINDOW IS BETTER EVIDENCE, not merely a working one. These screenshots exist to
 * be looked at by a human; a capture forced out of a window no compositor ever drew is not what a
 * merchant's phone would show. This makes the picture and the thing it claims to depict the same.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * Replace a live session token with a placeholder.
 *
 * 🔴 DIAGNOSTICS MUST NOT PRINT THE CREDENTIAL. The token is in every media URL, CI logs are
 * readable by anyone who can see the run, and a diagnostic that leaks the thing the whole slice
 * exists to protect would be a worse defect than the one it is chasing.
 */
const redact = (text) => String(text).replace(/\/m\/[0-9a-f]{16,}/gi, "/m/<token>");

/** A bounded, sanitised record of what the phone page did. Diagnostics only — nothing asserts on it. */
function recordPhone(phone) {
  const rec = { console: [], errors: [], requests: [], responses: [], failed: [] };
  const interesting = (u) => /\/m\//.test(u);
  const cap = (a, v, n = 40) => {
    if (a.length < n) a.push(v);
  };

  phone.on("console", (m) => cap(rec.console, `${m.type()}: ${redact(m.text()).slice(0, 200)}`));
  phone.on("pageerror", (e) => cap(rec.errors, redact(String(e)).split("\n")[0].slice(0, 300)));
  phone.on("request", (r) => {
    if (interesting(r.url())) cap(rec.requests, `${r.method()} ${redact(r.url())}`);
  });
  phone.on("requestfailed", (r) => {
    if (interesting(r.url()))
      cap(rec.failed, `${r.method()} ${redact(r.url())} — ${redact(r.failure()?.errorText ?? "unknown")}`);
  });
  phone.on("response", (r) => {
    if (!interesting(r.url())) return;
    const line = { method: r.request().method(), route: redact(r.url()), status: r.status() };
    cap(rec.responses, line);
    // 🔴 THE BODY IS READ ONLY FOR JSON, AND ONLY A BOUNDED SLICE. The photo route's REQUEST body
    // is image bytes and is never read; the RESPONSE is the small {ok,...} envelope.
    const type = r.headers()["content-type"] ?? "";
    line.contentType = type.slice(0, 60);
    if (type.includes("application/json")) {
      r.text()
        .then((t) => {
          line.body = redact(t).slice(0, 300);
        })
        .catch(() => {
          line.body = "<unreadable>";
        });
    }
  });
  return rec;
}

/**
 * Arm a wait for one of the page's POSTs BEFORE the action that causes it.
 *
 * 🔴 EVENT BEFORE ACTION, AND THE ALTERNATIVE LOST A GATE. Reading a recorded list straight after
 * the DOM changed is a race: the page's own `xhr.onload` has already run and repainted, while
 * Playwright is still delivering the `response` event to Node over CDP. Check 102 failed exactly
 * that way in run 38925322111 — the response had plainly arrived, because the very next check read
 * the message the page writes in `onload`, and the same recorder reported that route as 200 later.
 *
 * Registering the waiter first removes the race rather than papering over it: no sleep, no longer
 * timeout, and the assertion gets STRONGER — it is now the response object itself, with its method
 * and path checked, instead of a lookup that might not have landed yet.
 *
 * `kind` is "/photo", "/barcode", or "save" for the Save POST, which goes to the page's own path.
 */
function expectPost(phone, kind) {
  return phone.waitForResponse(
    (r) => {
      if (r.request().method() !== "POST") return false;
      const path = new URL(r.url()).pathname;
      return kind === "save" ? /^\/m\/[0-9a-f]{16,}$/i.test(path) : path.endsWith(kind);
    },
    { timeout: 30000 },
  );
}

/** Describe a response for a check message without ever printing the token. */
const seen = (res) => (res ? `${res.request().method()} ${redact(new URL(res.url()).pathname)} → ${res.status()}` : "no response");

/**
 * Photograph a named state with the thing it claims to show ACTUALLY IN FRAME.
 *
 * 🔴 A FILENAME IS A CLAIM, AND ONE OF THESE WAS LYING. `I2-mobile-photo-accepted.png` showed the
 * top of the form: the page is 1532px tall, the capture is a 844px viewport, and the photo section
 * sits below the Catalogue section — so the one file whose whole purpose was to show an accepted
 * photo could not contain one. Nothing failed; the evidence was simply false, which is worse than
 * a red check because it reads as proof.
 *
 * So the elements are scrolled into view and their boxes are MEASURED against the viewport before
 * the shutter. If a state cannot be framed, that is a failed check — not a quietly wrong picture.
 */
async function shotShowing(phone, shot, ids, name) {
  const settle = () =>
    phone
      .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
      .catch(() => undefined);
  // A plain name is a test id; ANYTHING ELSE is a raw CSS selector. The Product Photo heading is
  // a <legend> with no test id, and requiring it must not mean adding a hook to the product for a
  // screenshot's benefit.
  //
  // 🔴 DECIDED BY WHAT A TEST ID LOOKS LIKE, NOT BY A PREFIX. The first version asked whether the
  // string STARTED with `[`, `.` or `#`, then was handed `fieldset:has(#photoFile) legend`, which
  // starts with none of them — so it became `[data-testid="fieldset:has(#photoFile) legend"]`,
  // matched nothing, and `boundingBox()` waited its full thirty seconds. Run 38941276178 died
  // there. A test id is word characters and hyphens; every other shape is a selector.
  const sel = (id) => (/^[\w-]+$/.test(id) ? `[data-testid="${id}"]` : id);
  const boxes = async () => {
    const out = {};
    for (const id of ids) out[id] = await phone.locator(sel(id)).boundingBox();
    return out;
  };

  // 🔴 SCROLL THE BOTTOM-MOST REQUIRED ELEMENT, MEASURED — NOT THE FIRST ONE LISTED. The first
  // version scrolled `ids[0]`, which framed the photo preview and pushed the staged-state text 36
  // pixels below an 844-pixel fold. Bringing the LOWEST one into view brings everything above it
  // with it, and which one is lowest is read from the page rather than assumed from the argument
  // order — the caller lists what matters, not what sits where.
  const first = await boxes();
  const lowest = ids
    .filter((id) => first[id])
    .sort((a, b) => first[a].y + first[a].height - (first[b].y + first[b].height))
    .pop();
  if (lowest) await phone.locator(sel(lowest)).scrollIntoViewIfNeeded();
  await settle();

  // 🔴 THE VIEWPORT'S BOTTOM IS NOT THE VISIBLE BOTTOM. The page carries a fixed Save bar pinned
  // to the bottom edge, and it PAINTS OVER whatever is beneath it — so `bottom <= viewport.height`
  // is satisfied by an element the merchant cannot see. In the previous run that bar is exactly
  // what clipped the preview's lower edge in a file that otherwise looked correct.
  //
  // Its top edge is measured, never assumed: anything fixed or sticky that is anchored to the
  // bottom of the viewport counts, so this keeps working if the bar is restyled or another one is
  // added. No height is hard-coded anywhere.
  const usableBottom = async () =>
    await phone.evaluate(() => {
      const vh = window.innerHeight;
      let top = vh;
      for (const el of document.body.getElementsByTagName("*")) {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.bottom >= vh - 2 && r.top < top) top = r.top;
      }
      return top;
    });

  // One MEASURED correction, not a guess: if the lowest element still sits under the bar, scroll
  // by exactly the overlap. A page that cannot scroll further leaves the check to fail honestly
  // rather than being retried until it passes.
  let limit = await usableBottom();
  const afterScroll = await boxes();
  if (lowest && afterScroll[lowest]) {
    const overlap = afterScroll[lowest].y + afterScroll[lowest].height - limit;
    if (overlap > 0) {
      await phone.evaluate((by) => window.scrollBy(0, by), Math.ceil(overlap));
      await settle();
      limit = await usableBottom();
    }
  }

  const final = await boxes();
  const out = [];
  for (const id of ids) {
    const box = final[id];
    if (!box || box.width <= 0 || box.height <= 0) {
      out.push(`${id}=absent`);
    } else if (box.y < 0) {
      out.push(`${id}=above-frame(y${Math.round(box.y)})`);
    } else if (box.y + box.height > limit + 1) {
      // Named distinctly, because "below the fold" and "behind the Save bar" need different fixes.
      const why = limit < (phone.viewportSize()?.height ?? 844) - 1 ? "under-footer" : "below-fold";
      out.push(`${id}=${why}(y${Math.round(box.y)} h${Math.round(box.height)} limit${Math.round(limit)})`);
    }
  }
  check(out.length === 0, `🔴 ${name}.png really shows what its name claims (off-frame: ${out.join(", ") || "none"})`);
  await shot(name);
}

async function withPhoneWindow(app, url, body) {
  const created = app.waitForEvent("window", { timeout: 30000 });
  const id = await app.evaluate(async ({ BrowserWindow }, target) => {
    const w = new BrowserWindow({
      width: 390,
      height: 844,
      // Hidden only while it loads, so no unpainted frame is ever shown or photographed.
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await w.loadURL(target);
    // Shown WITHOUT stealing focus: it must be composited to be photographable, and the till
    // window must stay the active one.
    w.showInactive();
    return w.id;
  }, url);
  const phone = await created;
  // Attached before the page is driven, so nothing it does goes unrecorded.
  const rec = recordPhone(phone);
  await phone.waitForLoadState("domcontentloaded").catch(() => undefined);
  await phone.setViewportSize({ width: 390, height: 844 }).catch(() => undefined);

  // 🔴 MEASURED, NOT ASSUMED. The window states it is visible and proves it has painted before
  // anything photographs it, and both facts are asserted rather than hoped for.
  const health = await phoneHealth(app, phone, id);
  log("phone window before capture: " + JSON.stringify(health));
  check(health.visible === true, `🔴 the phone window is composited before it is photographed (visible=${health.visible})`);
  check(health.painted === true, `…and it produced a real frame — rAF advanced (painted=${health.painted})`);

  const shot = (name) => phoneShot(app, phone, id, name);
  try {
    await body(phone, shot, rec);
  } catch (err) {
    // 🔴 THE PHONE WINDOW IS PHOTOGRAPHED TOO. The outer catch dumps the TILL window, which says
    // nothing about a mobile failure — that gap is why two rounds of this went undiagnosed.
    // The original error is preserved and re-thrown either way.
    try {
      await phone.screenshot({ path: SHOTS + "I2-DIAGNOSTIC-phone-failure.png", timeout: 15000 });
      console.log("  (phone window photographed to I2-DIAGNOSTIC-phone-failure.png)");
    } catch (shotErr) {
      console.log("  (the phone window could NOT be photographed: " + String(shotErr).split("\n")[0] + ")");
    }
    console.log("  phone console/errors/traffic: " + JSON.stringify(rec));
    throw err;
  } finally {
    await phone.close().catch(() => undefined);
  }
}

/**
 * Read the two paths APART.
 *
 * 🔴 UPLOAD AND PREVIEW ARE INDEPENDENT, AND CONFLATING THEM IS WHAT COST TWO GATES. One path is
 * file → POST → staging; the other is file → FileReader → data: URL → <img> render. Either can
 * fail while the other succeeds, so each is reported on its own.
 *
 * Only a PREFIX of the preview src is read — never the base64 payload.
 */
async function previewState(phone) {
  return await phone
    .evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const img = q("phone-photo-preview");
      const wrap = document.getElementById("photoPreviewWrap");
      const input = q("phone-photo-input");
      const rect = img ? img.getBoundingClientRect() : null;
      const raw = img ? img.getAttribute("src") : null;
      return {
        // PATH 1 — the upload, as the page reports it.
        status: (q("phone-photo-status")?.textContent ?? "").trim().slice(0, 120),
        // PATH 2 — the local preview, as the DOM actually holds it.
        previewNote: (q("phone-photo-preview-status")?.textContent ?? "").trim().slice(0, 120),
        wrapperHidden: wrap ? wrap.hidden : null,
        srcKind: raw === null ? "<none>" : raw.slice(0, 24) + (raw.length > 24 ? "…" : ""),
        srcLength: raw === null ? 0 : raw.length,
        complete: img ? img.complete : null,
        naturalW: img ? img.naturalWidth : null,
        naturalH: img ? img.naturalHeight : null,
        rect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        files: input && input.files ? input.files.length : null,
        events: globalThis.__e2eEvents ?? null,
      };
    })
    .catch((e) => ({ unreadable: String(e).split("\n")[0] }));
}

/**
 * Wait for the preview exactly as before — and if it never comes, say what the page was doing.
 *
 * 🔴 THE ASSERTION IS NOT WEAKENED. Same locator, same `visible` state, same 30 second budget, and
 * the original error is re-thrown. A rendered preview is still the only thing that counts as
 * success; everything sampled here is a diagnostic intermediate, never an acceptance criterion.
 */
async function waitForPreview(phone, rec) {
  const trace = [];
  const started = Date.now();
  let polling = true;
  const sampler = (async () => {
    while (polling) {
      trace.push({ atMs: Date.now() - started, ...(await previewState(phone)) });
      if (!polling) break;
      await phone.waitForTimeout(2000).catch(() => undefined);
    }
  })();

  try {
    await phone.locator('[data-testid="phone-photo-preview"]').waitFor({ state: "visible", timeout: 30000 });
  } catch (err) {
    polling = false;
    await sampler.catch(() => undefined);
    console.log("  ── DIAGNOSTIC: the preview never became visible ──");
    console.log("  final state : " + JSON.stringify(await previewState(phone)));
    console.log("  transitions : " + JSON.stringify(trace));
    console.log("  traffic     : " + JSON.stringify(rec));
    throw err;
  } finally {
    polling = false;
    await sampler.catch(() => undefined);
  }
}

/**
 * What the phone window is actually doing — from BOTH sides.
 *
 * The main process is asked whether the window is visible and where it is; the page is asked
 * whether it is loaded and whether a frame actually advances. `requestAnimationFrame` is the
 * honest readiness signal here: it is the compositor answering, and it is self-limiting rather
 * than a blind sleep, so a window that will never paint reports `painted: false` in five seconds
 * instead of hanging.
 */
async function phoneHealth(app, phone, id) {
  const main = await app
    .evaluate(({ BrowserWindow }, wid) => {
      const w = BrowserWindow.fromId(wid);
      if (!w) return { visible: null, minimized: null, bounds: null };
      return { visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds() };
    }, id)
    .catch((e) => ({ visible: null, minimized: null, bounds: null, mainError: String(e).split("\n")[0] }));

  const dom = await phone
    .evaluate(
      () =>
        new Promise((resolve) => {
          const base = {
            readyState: document.readyState,
            visibility: document.visibilityState,
            bodyW: document.body?.clientWidth ?? null,
            bodyH: document.body?.clientHeight ?? null,
          };
          const timer = setTimeout(() => resolve({ ...base, painted: false }), 5000);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(timer);
              resolve({ ...base, painted: true });
            }),
          );
        }),
    )
    .catch((e) => ({ painted: false, domError: String(e).split("\n")[0] }));

  return { closed: phone.isClosed(), url: phone.url(), viewport: phone.viewportSize(), ...main, ...dom };
}

/**
 * Photograph the phone window — and if the capture ever hangs again, SAY what the window was doing.
 *
 * 🔴 THE DIAGNOSTIC IS THE POINT. The previous failure reported only `Timeout 30000ms exceeded`,
 * which named the operation and nothing about its subject — and the recorded diagnosis pointed at a
 * completely different part of the script as a result. This dumps the window's real state at the
 * moment of the failure, and still re-throws: evidence is added, nothing is weakened.
 */
async function phoneShot(app, phone, id, name) {
  try {
    await phone.screenshot({ path: SHOTS + name + ".png", timeout: 20000 });
  } catch (err) {
    console.log(`  ✗ DIAGNOSTIC ${name}: ${String(err).split("\n")[0]}`);
    console.log("    phone window at the failed capture: " + JSON.stringify(await phoneHealth(app, phone, id)));
    throw err;
  }
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

/**
 * The operating-system process behind a launched Electron app, and whether it has exited.
 *
 * Playwright exposes the real child process, so this is the actual PID rather than a proxy for
 * one. Both are defensive: `process()` is not part of the stable surface in every version, and a
 * diagnostic must never be the thing that fails a run.
 */
function pidOf(electronApp) {
  try {
    return electronApp.process()?.pid ?? null;
  } catch {
    return null;
  }
}

function exitOf(electronApp) {
  try {
    const p = electronApp.process();
    return p ? `${p.exitCode}/${p.signalCode ?? "none"} killed=${p.killed}` : "no handle";
  } catch (e) {
    return "unavailable: " + String(e).split("\n")[0];
  }
}

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

let { app, page } = await launch();
/** The window currently under test — reassigned after a restart, and closed in `finally`. */
let closable = app;

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
  // 🔴 SLICE I2 — the placeholder is gone and real capture controls are here. The old assertion
  // required `phone-photo-soon`, which was H2's honest "not yet"; keeping it would now fail
  // against the feature it was waiting for.
  for (const id of ["phone-photo-take", "phone-photo-choose", "phone-photo-input", "phone-barcode-scan", "phone-barcode-input"]) {
    check(form.text.includes(`data-testid="${id}"`), `the mobile form offers ${id}`);
  }
  check(
    (form.text.match(/capture="environment"/g) ?? []).length >= 2,
    "photo and barcode both use a file input with capture — no live-camera API",
  );
  check(
    !/getUserMedia|BarcodeDetector|mediaDevices/.test(form.text),
    "🔴 the mobile page names no live-camera API (they are secure-context only, so unusable here)",
  );
  check(
    !/data-testid="phone-barcode"[^>]*\b(readonly|disabled)\b/.test(form.text),
    "🔴 the barcode field stays EDITABLE — manual correction is mandatory",
  );
  check(!/https?:\/\//.test(form.text), "🔴 the mobile page references NO external URL — no CDN, no remote font");
  check(!form.text.includes(parsed[3]), "the served page does not echo the token");
  for (const u of ["piece", "box", "pack", "kg", "meter", "other"]) {
    check(form.text.includes(`value="${u}"`), `the authoritative unit '${u}' is offered by the form`);
  }

  // ── 3b · I2: the phone uploads a photo and photographs a barcode ─────────────────────────────
  log("phone uploads a product photo and a barcode image");
  const photoUp = await phoneUpload(url, "/photo", join(APP, "tests", "fixtures", "photos", "shelf.jpg"), "image/jpeg");
  check(photoUp.status === 200 && photoUp.json?.ok === true, "🔴 the phone's product photo is accepted and STAGED");
  check(photoUp.json?.staged === true, "the till reports it as staged, not saved");
  check(Number(photoUp.json?.widthPx) > 0 && Number(photoUp.json?.byteSize) > 0, "with real normalized dimensions");
  check(
    !JSON.stringify(photoUp.json ?? {}).match(/shelf|\.jpg|[A-Za-z]:\\\\|\/home\/|base64/i),
    "🔴 and the answer carries no filename, path or bytes",
  );

  const scan = await phoneUpload(url, "/barcode", join(APP, "tests", "fixtures", "barcodes", "ean13.png"), "image/png");
  check(scan.status === 200 && scan.json?.found === true, "🔴 the till DECODES the photographed barcode");
  check(scan.json?.value === "5901234123457", `the decoded value is the fixture's (${scan.json?.value})`);
  check(typeof scan.json?.format === "string" && scan.json.format.length > 0, `and its format is reported (${scan.json?.format})`);

  const miss = await phoneUpload(url, "/barcode", join(APP, "tests", "fixtures", "photos", "shelf.jpg"), "image/jpeg");
  check(miss.status === 200 && miss.json?.found === false, "🔴 a photo with no barcode answers found:false, not an error");

  const badPhoto = await phoneUpload(url, "/photo", join(APP, "tests", "fixtures", "photos", "corrupt.jpg"), "image/jpeg");
  check(badPhoto.status === 422, "an undecodable photo is refused with a readable message");
  check(typeof badPhoto.json?.message === "string" && badPhoto.json.message.length > 0, "…and the message is non-empty");

  // 🔴 MANUAL CORRECTION. The merchant edits what the decoder returned before saving — the
  // decoder reads roughly two labels in three, so this is the common path, not an edge case.
  const CORRECTED = "4006381333931";

  // ── 4 · The phone saves, and the till shows it ───────────────────────────────────────────────
  const saved = await phoneRequest(url, { method: "POST", body: submission({ master: { barcode: CORRECTED } }) });
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
  check(listText.includes(CORRECTED), "🔴 the CORRECTED barcode is stored, not the decoded one");
  check(!listText.includes("5901234123457"), "…and the decoded value it replaced is not");
  // The thumbnail the phone's photo produced, on the desktop row.
  const thumb = await page.evaluate(() => {
    const img = document.querySelector('[data-testid="product-row"] img');
    return img ? { src: (img.getAttribute("src") ?? "").slice(0, 16), w: img.naturalWidth } : null;
  });
  check(thumb !== null, "🔴 the phone-uploaded photo appears as a thumbnail on the desktop row");
  check(thumb !== null && thumb.src.startsWith("data:image/"), `the thumbnail is a local data URL (${thumb?.src}…)`);
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

  // The edit form must say the existing photo survives an untouched save.
  check(
    editForm.text.includes('data-testid="phone-photo-current"'),
    "🔴 the edit form tells the merchant the existing photo is kept unless replaced",
  );

  // I2: replace the photo from the phone, and correct a freshly decoded barcode.
  const editPhoto = await phoneUpload(
    editUrl,
    "/photo",
    join(APP, "tests", "fixtures", "photos", "logo-alpha.png"),
    "image/png",
  );
  check(editPhoto.status === 200 && editPhoto.json?.ok === true, "🔴 a REPLACEMENT photo is staged from the phone");
  const editScan = await phoneUpload(editUrl, "/barcode", join(APP, "tests", "fixtures", "barcodes", "code128.png"), "image/png");
  check(editScan.json?.value === "Alz-7781-A", `🔴 Code 128 keeps its case through the phone (${editScan.json?.value})`);

  const editedName = (prefilled?.[1] ?? prefilled?.[2] ?? "") + " معدّل";
  const editSaved = await phoneRequest(editUrl, {
    method: "POST",
    body: submission({
      product: { nameAr: editedName, nameEn: "", sku: "", price: "99.00", baseUnit: "piece" },
      master: {
        categoryId: "",
        barcode: String(editScan.json?.value ?? ""),
        brand: "",
        descriptionAr: "",
        descriptionEn: "",
        isOnlineVisible: false,
      },
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
  check(afterEdit.includes("Alz-7781-A"), "🔴 the Code 128 barcode reached storage with its case intact");
  await page.screenshot({ path: SHOTS + "H6-desktop-list-after-phone-edit.png" });

  // ── 6b · Restart durability: the phone's photo and barcode survive a real app restart ────────
  log("restarting the installed app to prove the phone's work is durable");
  // 🔴 THE PIDs ARE RECORDED BECAUSE A PREVIOUS DIAGNOSIS BLAMED THIS SEQUENCE. `main.ts` takes
  // `app.requestSingleInstanceLock()`, so a prior process that had not exited would make the next
  // launch quit immediately and hand Playwright a window belonging to the OLD process. That was a
  // hypothesis, and it was wrong — the real failure was a never-shown phone window in §7b. These
  // lines are measurement, not a fix: nothing about the sequencing changes, and the next run says
  // plainly whether each instance is a genuinely new process that fully exits.
  const pid0 = pidOf(app);
  await app.close().catch(() => undefined);
  log(`instance 1 pid=${pid0} after close: exitCode=${exitOf(app)}`);
  const restarted = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page2 = await restarted.firstWindow();
  await signIn(page2, "Cashier One", "1111");
  await page2.locator('[data-testid="tab-products"]').click();
  await page2.locator('[data-testid="product-row"]').first().waitFor({ timeout: 30000 });
  const afterRestart = await page2.locator(".catalog-admin").innerText();
  check(afterRestart.includes("معدّل"), "🔴 the phone-edited product survives a restart");
  check(afterRestart.includes("Alz-7781-A"), "…with its barcode");
  const thumb2 = await page2.evaluate(() => {
    const img = document.querySelector('[data-testid="product-row"] img');
    return img ? { ok: (img.getAttribute("src") ?? "").startsWith("data:image/"), w: img.naturalWidth } : null;
  });
  check(thumb2?.ok === true, "🔴 …and the phone-uploaded photo is still decoded and drawn after restart");
  await page2.screenshot({ path: SHOTS + "I1-desktop-after-restart.png" });
  const pid1 = pidOf(restarted);
  await restarted.close().catch(() => undefined);
  log(`instance 2 pid=${pid1} after close: exitCode=${exitOf(restarted)}`);

  // Everything below continues on a fresh window.
  const relaunched = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const pid2 = pidOf(relaunched);
  log(`instance 3 pid=${pid2}`);
  check(
    pid2 !== null && pid2 !== pid0 && pid2 !== pid1,
    `🔴 the relaunched app is a genuinely NEW process, not a focused survivor (${pid0} → ${pid1} → ${pid2})`,
  );
  page = await relaunched.firstWindow();
  await signIn(page, "Cashier One", "1111");
  await page.locator('[data-testid="tab-products"]').click();
  await page.locator('[data-testid="product-row"]').first().waitFor({ timeout: 30000 });
  // 🔴 `app` IS REASSIGNED TOO, not just `closable`. Section 7b opens a browser window through
  // this handle, and the original app was closed above — using the stale one would fail with a
  // dead-target error that looks nothing like its cause.
  app = relaunched;
  closable = relaunched;

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

  // ── 7b · The WHOLE journey in a real browser, on its own session ─────────────────────────────
  //
  // 🔴 A SEPARATE SESSION, AND THE ONE-PHONE RULE IS WHY. Everything above drives the phone
  // surface with `fetch`, which CLAIMS the session for that client — a browser window arriving
  // afterwards would be a second phone and correctly refused. So the UI journey gets its own QR,
  // and the browser is its only claimant. That also makes this the end-to-end proof: capture,
  // decode, correct and Save, all through the real controls.
  log("driving the mobile form in a real browser window, end to end");
  const uiPairing = await openPairing(page, "I2-desktop-waiting-for-phone", () =>
    testid(page, "add-product-phone").click(),
  );
  const uiUrl = await decodeQr(uiPairing.png);
  assert(uiUrl, "the UI-journey pairing QR could not be decoded");

  await withPhoneWindow(app, uiUrl, async (phone, shot, rec) => {
    await phone.locator('[data-testid="phone-photo-take"]').waitFor({ timeout: 20000 });
    await shot("I2-mobile-form-top");

    const controls = await phone.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const bc = q("phone-barcode");
      const photoInput = q("phone-photo-input");
      return {
        photoTake: Boolean(q("phone-photo-take")),
        photoChoose: Boolean(q("phone-photo-choose")),
        barcodeScan: Boolean(q("phone-barcode-scan")),
        accept: photoInput?.getAttribute("accept") ?? null,
        capture: photoInput?.getAttribute("capture") ?? null,
        barcodeEditable: Boolean(bc) && !bc.readOnly && !bc.disabled,
        dir: document.documentElement.dir,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(controls.photoTake && controls.photoChoose, "the rendered mobile page shows both photo actions");
    check(controls.barcodeScan, "…and the barcode capture action");
    check(controls.accept === "image/*", `the photo input accepts images (${controls.accept})`);
    check(controls.capture === "environment", `…with capture=environment (${controls.capture})`);
    check(controls.barcodeEditable, "🔴 the barcode field is editable in the rendered page");
    check(controls.dir === "rtl", `the mobile page renders RTL (${controls.dir})`);
    check(controls.overflow <= 1, `🔴 no horizontal overflow at 390px (${controls.overflow}px)`);

    // 🔴 COUNT THE BROWSER'S OWN EVENTS, WITHOUT TOUCHING THE PAGE'S BEHAVIOUR. These listeners
    // are added by the TEST and only increment counters — the page's own handler is untouched and
    // still runs. "Did the change event fire at all?" is the first fork in the diagnosis and was
    // pure inference in both previous rounds.
    await phone.evaluate(() => {
      globalThis.__e2eEvents = { input: 0, change: 0 };
      const el = document.querySelector('[data-testid="phone-photo-input"]');
      if (!el) return;
      el.addEventListener("input", () => { globalThis.__e2eEvents.input += 1; });
      el.addEventListener("change", () => { globalThis.__e2eEvents.change += 1; });
    });
    console.log("  before setInputFiles: " + JSON.stringify(await previewState(phone)));

    // 🔴 THE DRAFT IS TYPED FIRST, so "a failed upload does not cost the draft" is a claim about
    // something that actually exists rather than about an empty form.
    await phone.locator('[data-testid="phone-nameAr"]').fill("مسودة قبل الخطأ");
    await phone.locator('[data-testid="phone-price"]').fill("12.00");

    // ── The error paths, from the REAL browser ───────────────────────────────────────────────
    //
    // 🔴 THESE RAN ONLY OVER `fetch` BEFORE, WHICH ENFORCES NO POLICY. A refusal that arrives as a
    // readable 422 over Node proves nothing about what the page DOES with it, and the page is what
    // the merchant sees. Each one is driven here through the real controls.
    const badPhotoWait = expectPost(phone, "/photo");
    await phone.locator('[data-testid="phone-photo-input"]').setInputFiles(
      join(APP, "tests", "fixtures", "photos", "corrupt.jpg"),
    );
    const badPhotoRes = await badPhotoWait;
    check(
      badPhotoRes.status() === 422,
      `🔴 the browser's photo POST reached the till and was refused with a real 422 (${seen(badPhotoRes)})`,
    );
    await phone.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="phone-photo-status"]');
        return Boolean(el) && el.className.includes("bad") && el.textContent.trim().length > 0;
      },
      undefined,
      { timeout: 30000 },
    );
    const badPhotoState = await previewState(phone);
    check(
      badPhotoState.status.length > 0,
      `🔴 a corrupt photo produces a READABLE failure on the phone ("${badPhotoState.status}")`,
    );
    check(badPhotoState.wrapperHidden === true, "…and no broken preview is left on screen");
    await shotShowing(phone, shot, ["phone-photo-status", "phone-photo-take"], "I2-mobile-photo-refused");

    // The draft survived the refusal.
    const draftAfterBadPhoto = await phone.evaluate(() => ({
      nameAr: document.querySelector('[data-testid="phone-nameAr"]').value,
      price: document.querySelector('[data-testid="phone-price"]').value,
    }));
    check(
      draftAfterBadPhoto.nameAr === "مسودة قبل الخطأ" && draftAfterBadPhoto.price === "12.00",
      "🔴 the refused photo cost the photo and NOT the draft",
    );

    // A photograph with no barcode in it — an ordinary outcome, never a fault.
    const missWait = expectPost(phone, "/barcode");
    await phone.locator('[data-testid="phone-barcode-input"]').setInputFiles(
      join(APP, "tests", "fixtures", "photos", "shelf.jpg"),
    );
    const missRes = await missWait;
    check(
      missRes.status() === 200,
      `🔴 the browser's barcode POST reached the till and answered (${seen(missRes)})`,
    );
    await phone.waitForFunction(
      () => (document.querySelector('[data-testid="phone-barcode-status"]')?.textContent ?? "").trim().length > 0,
      undefined,
      { timeout: 30000 },
    );
    const missNote = (await phone.locator('[data-testid="phone-barcode-status"]').innerText()).trim();
    check(missNote.length > 0, `a photo with no barcode reports it readably ("${missNote.slice(0, 50)}")`);
    const afterMiss = await phone.evaluate(() => ({
      barcode: document.querySelector('[data-testid="phone-barcode"]').value,
      editable: !document.querySelector('[data-testid="phone-barcode"]').readOnly,
      saveEnabled: !document.querySelector('[data-testid="phone-save"]').disabled,
      nameAr: document.querySelector('[data-testid="phone-nameAr"]').value,
    }));
    check(afterMiss.barcode === "", "…and writes nothing into the field it could not read");
    check(afterMiss.editable && afterMiss.saveEnabled, "🔴 a miss is NOT a fault: the field and Save both stay usable");
    check(afterMiss.nameAr === "مسودة قبل الخطأ", "…and the draft is still intact after it");

    // 🔴 THE SESSION SURVIVED BOTH. A media failure must never end the pairing — the merchant is
    // mid-draft, and losing the session would cost them everything they typed.
    check(rec.failed.length === 0, `🔴 not one request from the phone page was blocked by policy (${JSON.stringify(rec.failed)})`);

    // The page's OWN script does the uploading — this sets a file on the real input.
    const photoWait = expectPost(phone, "/photo");
    await phone.locator('[data-testid="phone-photo-input"]').setInputFiles(
      join(APP, "tests", "fixtures", "photos", "shelf.jpg"),
    );
    const photoRes = await photoWait;

    // What the browser actually holds now — the fixture's own name, type and size, nothing else.
    const picked = await phone
      .evaluate(() => {
        const el = document.querySelector('[data-testid="phone-photo-input"]');
        const f = el && el.files && el.files[0];
        return f ? { name: f.name, type: f.type, size: f.size, count: el.files.length } : { count: 0 };
      })
      .catch((e) => ({ unreadable: String(e).split("\n")[0] }));
    console.log("  after setInputFiles : " + JSON.stringify(picked));

    await waitForPreview(phone, rec);

    // 🔴 PATH A PROVEN AT THE BROWSER: a real HTTP response, not a policy-blocked request. The
    // preview rendering is the visible half; this is the half that was invisible for three slices.
    check(photoRes.status() === 200, `🔴 the browser's photo POST received a real 200 (${seen(photoRes)})`);
    const previewShown = await previewState(phone);
    check(
      previewShown.srcKind.startsWith("data:image/") && previewShown.naturalW > 0 && previewShown.rect.w > 0,
      `🔴 the preview is a RENDERED image, not just an element — ${previewShown.srcKind}, natural ${previewShown.naturalW}×${previewShown.naturalH}, drawn ${previewShown.rect.w}×${previewShown.rect.h}`,
    );
    const photoNote = (await phone.locator('[data-testid="phone-photo-status"]').innerText()).trim();
    check(photoNote.includes("جاهزة"), `the page reports the photo is ready ("${photoNote}")`);
    await shotShowing(
      phone,
      shot,
      [
        // The section heading «صورة الصنف» — a <legend>, identified by the fieldset that holds the
        // photo input rather than by a test id added to the product for a screenshot's sake.
        "fieldset:has(#photoFile) legend",
        "phone-photo-take",
        "phone-photo-choose",
        "phone-photo-preview",
        "phone-photo-status",
      ],
      "I2-mobile-photo-accepted",
    );
    // Supplementary only — the whole form in one frame. It does not replace the focused shots,
    // whose point is that the state is legible at a readable size.
    await phone.screenshot({ path: SHOTS + "I2-mobile-full-page.png", fullPage: true, timeout: 20000 });

    const bcWait = expectPost(phone, "/barcode");
    await phone.locator('[data-testid="phone-barcode-input"]').setInputFiles(
      join(APP, "tests", "fixtures", "barcodes", "ean13.png"),
    );
    const bcRes = await bcWait;
    await phone.waitForFunction(
      () => (document.querySelector('[data-testid="phone-barcode"]')?.value ?? "") === "5901234123457",
      undefined,
      { timeout: 30000 },
    );
    check(bcRes.status() === 200, `🔴 the browser's barcode POST received a real 200 (${seen(bcRes)})`);
    const bcNote = (await phone.locator('[data-testid="phone-barcode-status"]').innerText()).trim();
    check(bcNote.length > 0, `the page reports the decode ("${bcNote.slice(0, 60)}")`);
    await shotShowing(phone, shot, ["phone-barcode", "phone-barcode-status", "phone-barcode-scan"], "I2-mobile-barcode-decoded");

    // 🔴 STILL EDITABLE — typed over by hand, which is the common path.
    await phone.locator('[data-testid="phone-barcode"]').fill("4006381333931");
    check(
      (await phone.locator('[data-testid="phone-barcode"]').inputValue()) === "4006381333931",
      "🔴 the merchant can correct the decoded barcode by hand",
    );

    await phone.locator('[data-testid="phone-nameAr"]').fill("صنف من واجهة الهاتف");
    await phone.locator('[data-testid="phone-price"]').fill("8.50");
    await shotShowing(phone, shot, ["phone-barcode", "phone-barcode-status", "phone-barcode-scan"], "I2-mobile-barcode-corrected");

    // Save through the page's own button.
    const saveWait = expectPost(phone, "save");
    await phone.locator('[data-testid="phone-save"]').click();
    const saveRes = await saveWait;
    await phone.locator('[data-testid="phone-saved"]').waitFor({ state: "visible", timeout: 30000 });
    // 🔴 PATH C — THE ONE THAT WAS NEVER PROVEN FROM A BROWSER AT ALL. H2 accepted Save on the
    // strength of a Node `fetch`, which enforces no CSP; the same missing `connect-src` that broke
    // the uploads would have broken this too, and nothing would have noticed until a merchant did.
    check(saveRes.status() === 200, `🔴 the browser's SAVE POST received a real 200 (${seen(saveRes)})`);
    const doneText = (await phone.locator('[data-testid="phone-saved"]').innerText()).trim();
    check(doneText.includes("تم حفظ"), `🔴 the mobile page shows its own success state ("${doneText}")`);
    await shot("I2-mobile-saved");
  });

  // The desktop dialog should now report the save and close cleanly.
  await testid(page, "phone-dialog-saved").waitFor({ state: "visible", timeout: 30000 });
  await page.screenshot({ path: SHOTS + "I2-desktop-saved-from-ui.png" });
  await testid(page, "phone-dialog-close").click();
  await testid(page, "phone-dialog").waitFor({ state: "detached", timeout: 30000 });

  await page.waitForTimeout(500);
  const uiList = await page.locator(".catalog-admin").innerText();
  check(uiList.includes("صنف من واجهة الهاتف"), "🔴 the product created through the mobile UI is on the desktop");
  check(uiList.includes("4006381333931"), "…with the hand-corrected barcode");
  await page.screenshot({ path: SHOTS + "I2-desktop-list-after-ui-save.png" });

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
  await closable.close().catch(() => undefined);
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
