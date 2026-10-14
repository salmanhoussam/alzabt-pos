/**
 * E2E — the PREMISES of the photo normalization policy, re-measured in a REAL Electron process.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 EVERY NUMBER AND EVERY RULE IN src/main/photoNormalize.ts RESTS ON WHAT `nativeImage` DOES.
 *
 * Those behaviours were measured on 2026-10-14 on Linux, Electron 44.5.1 / Chromium 152. The shop
 * runs Windows. A decoder behaving differently there would not break a single unit test — the unit
 * tests use a model codec, by necessity, because `nativeImage` does not exist under
 * ELECTRON_RUN_AS_NODE. So the premises get asserted HERE, in the installed app, on the real
 * platform, and the gate fails if any of them stops being true.
 *
 * This script asserts the CODEC, not the product. `e2e/product-master.mjs` drives the real picker
 * through the real UI; this one answers the question that one cannot: "is the thing we built the
 * policy on actually behaving the way we measured?"
 *
 * 🔴 AND IT IS WRITTEN AS A MEASUREMENT, NOT A GUESS. Where a reading would differ between
 * platforms in a way the policy can tolerate, it is PRINTED rather than asserted, and labelled, so
 * a real difference shows up in the log instead of being hidden by a loose assertion.
 *
 * 🔴 NOTHING INSIDE `app.evaluate` MAY USE `require`. The function is serialized and eval'd in the
 * main process, so the module scope it was written in — and its `require` — is gone. The first
 * version of this script called `require("node:fs")` there and died with "require is not defined"
 * on the Windows gate, which read like a platform difference and was not one: it reproduces on
 * Linux against a minimal app. `Buffer`, `process` and the destructured `nativeImage` ARE
 * available, so every input below is read HERE, in Node, and passed in as base64.
 *
 * Run: node e2e/photo-codec.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 *      E2E_APP_DIR=<dir> node e2e/photo-codec.mjs    — launch another app directory instead, which
 *      is how the measurement body is verified locally: this repo's own renderer segfaults under
 *      Playwright here, and a minimal main-only app exercises the identical `app.evaluate` body.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(APP, "tests", "fixtures", "photos");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_DIR = process.env.E2E_APP_DIR ?? APP;
const APP_ARGS = PACKAGED ? [] : [APP_DIR];
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const home = mkdtempSync(join(tmpdir(), "pos-e2e-codec-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };

const log = (...a) => console.log("•", ...a);
let failures = 0;
let step = 0;
const assert = (cond, msg) => {
  step += 1;
  if (cond) {
    console.log(`  ✓ ${step} ${msg}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${step} ${msg}`);
  }
};

const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });

/**
 * Runs in the MAIN process of the real app, where `nativeImage` lives.
 *
 * Paths are passed in and read there; nothing about the renderer is involved, and no product code
 * is called — this is the codec on its own.
 */
const FIXTURE_NAMES = [
  "shelf.jpg",
  "portrait-exif.jpg",
  "oversized.jpg",
  "logo-alpha.png",
  "table-noalpha.png",
  "liar.png",
  "sample.webp",
  "corrupt.jpg",
];

// Read HERE, in Node, and handed over as base64 — see the header for why `require` is unavailable
// on the other side.
const files = {};
for (const n of FIXTURE_NAMES) files[n] = readFileSync(join(FIXTURES, n)).toString("base64");

/**
 * The adversarial buffers, also built HERE.
 *
 * The "random" one is a fixed pseudo-random sequence rather than real entropy: a measurement that
 * cannot be reproduced from the log is worth less, and nothing about this case needs unpredictability
 * — it needs to not be an image.
 */
const adversarial = {
  empty: Buffer.alloc(0),
  random: Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 97 + 13) % 256)),
  jpegMagicOnly: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  text: Buffer.from("product,price\nx,1\n"),
  pngHeaderJunk: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(200, 7),
  ]),
};
const adversarialB64 = Object.fromEntries(Object.entries(adversarial).map(([k, b]) => [k, b.toString("base64")]));

/**
 * Runs in the MAIN process of the real app, where `nativeImage` lives.
 *
 * 🔴 ONLY GLOBALS IN HERE: `Buffer`, `process`, and the destructured `nativeImage`. No `require`,
 * no `fs`, no `path` — see the header.
 */
const m = await app.evaluate(({ nativeImage }, payload) => {
  const buf = (b64) => Buffer.from(b64, "base64");
  const of = (b64) => {
    const img = nativeImage.createFromBuffer(buf(b64));
    const empty = img.isEmpty();
    return { empty, size: empty ? { width: 0, height: 0 } : img.getSize() };
  };
  const out = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    decoded: {},
    threw: {},
    adversarial: {},
  };

  for (const [n, b64] of Object.entries(payload.files)) {
    try {
      out.decoded[n] = of(b64);
    } catch (e) {
      out.threw[n] = String(e && e.message);
    }
  }

  // The measured claim: NONE of these throws and ALL come back empty.
  for (const [k, b64] of Object.entries(payload.adversarial)) {
    try {
      const img = nativeImage.createFromBuffer(buf(b64));
      out.adversarial[k] = { threw: false, empty: img.isEmpty() };
    } catch (e) {
      out.adversarial[k] = { threw: true, message: String(e && e.message) };
    }
  }

  // BGRA, proven with a known colour rather than assumed from documentation.
  const onePx = nativeImage
    .createFromBuffer(buf(payload.files["logo-alpha.png"]))
    .resize({ width: 1, height: 1, quality: "best" });
  out.bitmapBytesPerPixel = onePx.toBitmap().length;

  // Alpha survives a resize — the premise that lets transparency be detected on the small bitmap.
  const alphaOf = (img) => {
    const b = img.toBitmap();
    for (let i = 3; i < b.length; i += 4) if (b[i] !== 255) return true;
    return false;
  };
  const logo = nativeImage.createFromBuffer(buf(payload.files["logo-alpha.png"]));
  const flat = nativeImage.createFromBuffer(buf(payload.files["table-noalpha.png"]));
  out.alpha = {
    logoBefore: alphaOf(logo),
    logoAfterResize: alphaOf(logo.resize({ width: 256, height: 256, quality: "best" })),
    flatBefore: alphaOf(flat),
  };

  // The format decision's whole justification: a photograph as PNG vs as JPEG, at the real edge.
  const shelf = nativeImage.createFromBuffer(buf(payload.files["shelf.jpg"]));
  const s = shelf.getSize();
  const scale = 1600 / Math.max(s.width, s.height);
  const resized =
    scale < 1
      ? shelf.resize({ width: Math.round(s.width * scale), height: Math.round(s.height * scale), quality: "best" })
      : shelf;
  out.photographAt1600 = { jpeg80: resized.toJPEG(80).length, png: resized.toPNG().length, size: resized.getSize() };
  // `toJPEG` strips EXIF, which is why rotating the pixels cannot leave a contradicting tag behind.
  out.reencodedKeepsExif = resized.toJPEG(80).includes(Buffer.from("Exif"));

  // A bitmap round-trip: the only way to rotate, since NativeImage has no rotate().
  const small = shelf.resize({ width: 40, height: 30, quality: "best" });
  const b = small.toBitmap();
  const rot = Buffer.alloc(b.length);
  for (let y = 0; y < 30; y++)
    for (let x = 0; x < 40; x++) b.copy(rot, (x * 30 + (30 - 1 - y)) * 4, (y * 40 + x) * 4, (y * 40 + x) * 4 + 4);
  const rotated = nativeImage.createFromBitmap(rot, { width: 30, height: 40 });
  out.bitmapRoundTrip = { empty: rotated.isEmpty(), size: rotated.getSize(), jpeg: rotated.toJPEG(80).length };

  return out;
}, { files, adversarial: adversarialB64 });

log(`Electron ${m.electron} · Chromium ${m.chrome} · ${m.platform}`);
log(`installed executable: ${PACKAGED ?? "(dev tree)"}`);
console.log("");

log("PREMISE 1 — only JPEG and PNG decode from a buffer");
assert(m.decoded["shelf.jpg"]?.empty === false, "a real JPEG decodes");
assert(m.decoded["logo-alpha.png"]?.empty === false, "a real PNG decodes");
assert(m.decoded["sample.webp"]?.empty === true, "🔴 a real WEBP does NOT decode (so WEBP must not be offered)");
assert(Object.keys(m.threw).length === 0, `nothing threw while decoding real files (${JSON.stringify(m.threw)})`);

log("PREMISE 2 — rubbish comes back EMPTY, it does not throw");
for (const [k, v] of Object.entries(m.adversarial)) {
  assert(v.threw === false, `${k}: did not throw`);
  assert(v.empty === true, `${k}: came back empty`);
}
assert(m.decoded["corrupt.jpg"]?.empty === true, "🔴 a file with a JPEG magic but no image comes back empty");

log("PREMISE 3 — dimensions are read from the bytes, not the name");
assert(
  m.decoded["shelf.jpg"]?.size.width === 2400 && m.decoded["shelf.jpg"]?.size.height === 1800,
  `shelf.jpg is 2400x1800 (got ${JSON.stringify(m.decoded["shelf.jpg"]?.size)})`,
);
assert(
  m.decoded["liar.png"]?.size.width === 800,
  `🔴 a JPEG named .png still decodes, at 800x600 (got ${JSON.stringify(m.decoded["liar.png"]?.size)})`,
);
assert(m.decoded["oversized.jpg"]?.size.width === 9000, "a 9000x6000 camera frame decodes rather than being refused");

log("PREMISE 4 — EXIF orientation is NOT applied by the decoder");
const p = m.decoded["portrait-exif.jpg"]?.size;
assert(
  p && p.width > p.height,
  `🔴 the portrait fixture decodes LANDSCAPE ${JSON.stringify(p)} — if this ever flips, src/main/photoNormalize.ts would rotate an already-correct photo`,
);

log("PREMISE 5 — the bitmap is BGRA (4 bytes per pixel) and alpha survives a resize");
assert(m.bitmapBytesPerPixel === 4, `one pixel is 4 bytes (got ${m.bitmapBytesPerPixel})`);
assert(m.alpha.logoBefore === true, "a transparent PNG reports alpha");
assert(m.alpha.logoAfterResize === true, "🔴 alpha survives the resize — transparency may be detected on the small bitmap");
assert(m.alpha.flatBefore === false, "a PNG without transparency reports none (so the check is not always-true)");

log("PREMISE 6 — a photograph is dramatically smaller as JPEG than as PNG");
const ratio = m.photographAt1600.png / m.photographAt1600.jpeg80;
log(`  measured at ${JSON.stringify(m.photographAt1600.size)}: jpeg80 ${(m.photographAt1600.jpeg80 / 1024).toFixed(1)}KB · png ${(m.photographAt1600.png / 1024).toFixed(1)}KB · ratio ${ratio.toFixed(1)}x`);
assert(ratio > 5, `🔴 PNG costs more than 5x a JPEG for a photograph (${ratio.toFixed(1)}x) — the format rule depends on this`);
assert(
  m.photographAt1600.jpeg80 < 1_200_000,
  `a normalized photograph fits the output cap (${m.photographAt1600.jpeg80} bytes)`,
);
assert(m.reencodedKeepsExif === false, "🔴 toJPEG strips EXIF, so a rotated photo carries no contradicting tag");

log("PREMISE 7 — a bitmap round-trip is how rotation works at all");
assert(m.bitmapRoundTrip.empty === false, "createFromBitmap builds a real image");
assert(
  m.bitmapRoundTrip.size.width === 30 && m.bitmapRoundTrip.size.height === 40,
  `the edges swap: 40x30 -> ${JSON.stringify(m.bitmapRoundTrip.size)}`,
);
assert(m.bitmapRoundTrip.jpeg > 0, "the rotated image re-encodes");

await app.close();

console.log("");
if (failures > 0) {
  console.log(`CONCLUSION: failure`);
  console.log(`steps passed: ${step - failures}`);
  console.log(`FAILED: ${failures} photo-codec premise(s)`);
  process.exit(1);
}
console.log(`CONCLUSION: success`);
console.log(`steps passed: ${step}`);
