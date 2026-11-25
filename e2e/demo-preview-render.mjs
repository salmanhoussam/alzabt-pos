/**
 * Joint C2 — the demo's ON-SCREEN preview, checked in a real Chromium (Electron), on synthetic files only.
 *
 * Input: the watermarked HTML written by tests/main/demoPrint.test.ts with DEMO_PREVIEW_OUT=<in>
 * (real renderers, real synthetic sales / the repository's synthetic invoice samples).
 * For each document, in an off-screen window sized like the real preview (previewSizeFor):
 *   1. at the TOP, MIDDLE and BOTTOM scroll positions the DEMO mark is position:fixed with its centre on
 *      screen, and the DEMO bar is present — a PNG of each position is saved as evidence;
 *   2. for the A4 invoices only, Chromium's own paginator (printToPDF, in memory, never written to a
 *      user path, in a separate hidden window) reports the page count — "multi-page" is measured.
 * No shop profile, no printer (nothing is sent to one), no network (every non-file/data request is
 * cancelled; host resolution is disabled). userData is a fresh temp folder.
 *
 * Run (no ELECTRON_RUN_AS_NODE):
 *   node_modules/electron/dist/electron.exe e2e/demo-preview-render.mjs --in=<html folder> --out=<evidence folder>
 * Result: <out>/summary.json is written on EVERY path (pass, failure, crash, timeout) and is the authority;
 * the process exit code mirrors it (0 only when summary.ok). A document whose name starts with
 * "control-" is a deliberate NEGATIVE CONTROL: it must FAIL, and the run fails if it does not.
 *
 * Instrument history (kept, not hidden): run 1 hung — capturePage on a hidden normal window threw
 * UnknownVizError as an unhandled rejection; run 2 reported exit 0 although it had failed — the exit
 * was called from inside the rejection handler; a load after printToPDF in an off-screen window failed
 * with ERR_FAILED (kept: a separate window paginates now). Run 3 ended SILENTLY with exit 0 after the
 * first document: Electron's default quits on "window-all-closed" — which was also the real cause of
 * run 2's false 0. Hence: off-screen capture, a separate pagination window, no quit on last window,
 * process.exit, an exit guard, and a summary on every path.
 */
import { app, BrowserWindow, session } from "electron";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!arg("in") || !arg("out")) {
  console.error("usage: --in=<folder of watermarked html> --out=<evidence folder>");
  process.exit(2);
}
const IN = resolve(arg("in"));
const OUT = resolve(arg("out"));
mkdirSync(OUT, { recursive: true });
app.setPath("userData", mkdtempSync(join(tmpdir(), "alzabt-preview-check-")));
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");

const results = [];
const failures = [];
let finished = false;
function finish(extra) {
  if (finished) return;
  finished = true;
  if (extra) failures.push(extra);
  const summary = { ok: failures.length === 0, documents: results.length, failures, results };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, documents: summary.documents, failures }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
// Electron's default quits the app when the last window closes — with exit 0. Each document's window
// is destroyed after use, so without this the run ended silently after the first document (run 3).
app.on("window-all-closed", () => undefined);
// Any exit that did not come through finish() is a failure, recorded as such.
process.on("exit", (code) => {
  if (finished) return;
  try {
    writeFileSync(join(OUT, "summary.json"), JSON.stringify({ ok: false, documents: results.length, failures: [...failures, `process exited (${code}) before the run finished`], results }, null, 2));
  } catch {}
  process.exitCode = 1;
});
process.on("unhandledRejection", (e) => finish(`UNHANDLED: ${e && e.message ? e.message : String(e)}`));
process.on("uncaughtException", (e) => finish(`UNCAUGHT: ${e && e.message ? e.message : String(e)}`));
setTimeout(() => finish("TIMEOUT after 150 s"), 150_000).unref();

/** Same mapping as src/main/demoPrint.ts previewSizeFor (asserted there by tests/main/demoPrint.test.ts). */
const SIZE = { thermal80: { width: 420, height: 860 }, a5: { width: 640, height: 860 }, a4: { width: 860, height: 1000 } };
const paperOf = (file) => (file.includes("thermal80") ? "thermal80" : file.includes("-a5") ? "a5" : "a4");

const MEASURE = `(() => {
  const mark = document.querySelector('[data-alzabt-demo-mark="mark"]');
  const bar = document.querySelector('[data-alzabt-demo-mark="bar"]');
  const base = { scrollY: Math.round(scrollY), docHeight: document.documentElement.scrollHeight, viewHeight: innerHeight };
  if (!mark) return { ...base, mark: false, bar: !!bar };
  const r = mark.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return { ...base, mark: true, bar: !!bar, position: getComputedStyle(mark).position,
    centreOnScreen: cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight };
})()`;

async function load(win, url) {
  try {
    await win.loadURL(url);
    return 0;
  } catch {
    await new Promise((r) => setTimeout(r, 300));
    await win.loadURL(url); // one retry, recorded; a second failure throws
    return 1;
  }
}

async function checkDocument(file) {
  const paper = paperOf(file);
  const size = SIZE[paper];
  const url = pathToFileURL(join(IN, file)).href;
  const control = file.startsWith("control-");
  const docFailures = [];
  const win = new BrowserWindow({ show: false, width: size.width, height: size.height, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  const retries = await load(win, url);
  const first = await win.webContents.executeJavaScript(MEASURE);
  const maxScroll = Math.max(0, first.docHeight - first.viewHeight);
  const positions = [];
  for (const [label, y] of [["top", 0], ["middle", Math.round(maxScroll / 2)], ["bottom", maxScroll]]) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${y}); true`);
    await new Promise((r) => setTimeout(r, 150));
    const m = await win.webContents.executeJavaScript(MEASURE);
    const shot = `${file.replace(/\.html$/, "")}-${label}.png`;
    writeFileSync(join(OUT, shot), (await win.webContents.capturePage()).toPNG());
    positions.push({ label, requested: y, ...m, screenshot: shot });
    if (!m.mark || !m.bar || m.position !== "fixed" || !m.centreOnScreen) docFailures.push(`${label}: mark not visible`);
  }
  win.destroy();

  let pdfPages = null;
  if (paper === "a4" && !control) {
    const pager = new BrowserWindow({ show: false, width: size.width, height: size.height, webPreferences: { sandbox: true, contextIsolation: true } });
    await load(pager, url);
    const pdf = await pager.webContents.printToPDF({ pageSize: "A4", printBackground: true }); // in memory only
    pdfPages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    pager.destroy();
    if (file.includes("D-multipage") && !(pdfPages >= 2)) docFailures.push(`expected >= 2 A4 pages, got ${pdfPages}`);
  }

  results.push({ file, paper, control, window: size, loadRetries: retries, docHeight: first.docHeight, viewHeight: first.viewHeight, scrolls: maxScroll > 0, positions, pdfPages, docFailures });
  if (control) {
    if (docFailures.length === 0) failures.push(`${file}: NEGATIVE CONTROL passed — the instrument cannot see a missing mark`);
  } else {
    for (const f of docFailures) failures.push(`${file}: ${f}`);
  }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|blob|devtools):/i.test(d.url) }));
  const files = readdirSync(IN).filter((f) => f.endsWith(".html")).sort();
  if (!files.some((f) => !f.startsWith("control-"))) return finish("no input documents");
  if (!files.some((f) => f.startsWith("control-"))) failures.push("no negative control supplied");
  for (const file of files) await checkDocument(file);
  finish();
});
