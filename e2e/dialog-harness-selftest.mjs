// NEGATIVE self-test of the E2E safety harness (e2e/_dialogs.mjs + e2e/_owned.mjs): proves it CATCHES
// failure and NEVER ends a process it cannot prove is its own.
//   node e2e/dialog-harness-selftest.mjs            (Windows only; elsewhere it skips)
// No app is launched. Real Windows message boxes come from throw-away PowerShell processes and real
// processes from throw-away Node sleepers, so the harness reads and ends them exactly as it would the
// app's. Every process this script starts is recorded by identity and ended ONLY through _owned.mjs.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_TITLES, RESTORED_TITLES, WINDOWS, unexpectedErrors, waitForTitle } from "./_dialogs.mjs";
import { createOwned, endOwned, identify, identifyTree, stillRunning } from "./_owned.mjs";

if (!WINDOWS) {
  console.log("SKIP E2E safety harness self-test (Windows only)");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNED_URL = pathToFileURL(join(HERE, "_owned.mjs")).href;
const DIALOGS_URL = pathToFileURL(join(HERE, "_dialogs.mjs")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (cond, msg, detail) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg} ${detail ? JSON.stringify(detail) : ""}`);
  passed++;
  console.log(`• PASS ${msg}`);
};

// Everything this script starts is registered BY IDENTITY at start; cleanup (also on failure) ends
// only those identities, through _owned.mjs.
const owned = createOwned();
process.on("exit", () => owned.endAll());
const track = (child) => {
  const id = owned.addPid(child.pid);
  if (!id) throw new Error(`could not record the identity of a process this test just started (pid ${child.pid})`);
  return id;
};
const sleeper = () => track(spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" }));
function messageBox(title, delayMs = 0) {
  const script = `Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds ${delayMs}; [System.Windows.Forms.MessageBox]::Show('self-test body', '${title.replace(/'/g, "''")}') | Out-Null`;
  return track(spawn("powershell", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "ignore" }));
}
/** Run a child Node script; resolve { code, out } when it exits. */
function runChild(source) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ code, out }));
  });
}

const NOT_RESTORED = "لم تتمّ الاستعادة";
const RESTORED = RESTORED_TITLES[0];
try {
  check(ERROR_TITLES.includes(NOT_RESTORED) && ERROR_TITLES.includes("Alzabt POS — cannot start"), "the harness knows the app's error-box titles");

  // ── OWNERSHIP ──────────────────────────────────────────────────────────────────────────────
  // O1 · a process the test started is ended, and only it.
  const a = sleeper();
  check(/^\d{15,}$/.test(a.start) && a.path.toLowerCase() === process.execPath.toLowerCase(), "O1 · identity = exact executable + OS creation time (ticks), recorded at start", a);
  const r1 = endOwned([a], { tree: false });
  check(r1.length === 1 && r1[0].outcome === "ended", "O1 · a PROVEN own process is ended", r1);
  await sleep(500);
  check(!stillRunning(a), "O1 · …and is gone");

  // O2 · a REUSED pid: same pid, same executable, different creation time → never touched.
  const b = sleeper();
  const reused = { ...b, start: String(BigInt(b.start) + 1n) };
  const r2 = endOwned([reused]);
  check(r2.length === 1 && r2[0].outcome === "not-ours", "O2 · 🔴 a pid whose creation time differs (a reused pid) is refused", r2);
  check(stillRunning(b), "O2 · …and that process is still running, untouched");

  // O3 · same pid and creation time but a DIFFERENT executable → never touched.
  const r3 = endOwned([{ ...b, path: "C:\\Some\\Other\\node.exe" }]);
  check(r3.length === 1 && r3[0].outcome === "not-ours", "O3 · 🔴 a different executable path is refused", r3);
  check(stillRunning(b), "O3 · …and that process is still running, untouched");

  // O4 · same IMAGE NAME (two node.exe): ending one leaves the other.
  const c = sleeper();
  const d = sleeper();
  const r4 = endOwned([c], { tree: true });
  await sleep(500);
  check(r4.some((r) => r.pid === c.pid && r.outcome === "ended") && !r4.some((r) => r.pid === d.pid), "O4 · only the identified process is ended", r4);
  check(!stillRunning(c) && stillRunning(d), "O4 · 🔴 another process with the same name is untouched");

  // O5 · a process that already ended → reported gone; nothing is ended in its place.
  const r5 = endOwned([a]);
  check(r5.length === 1 && r5[0].outcome === "gone", "O5 · an ended process is reported GONE, nothing else is touched", r5);

  // O6 · a tree: the root's own child is ended with it; an unrelated process is not.
  const parent = spawn(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore" }); setTimeout(() => {}, 120000);`], { stdio: "ignore" });
  const pId = track(parent);
  await sleep(1500);
  const tree = identifyTree(parent.pid);
  for (const t of tree) owned.add(t);
  check(tree.length === 2 && tree[0].pid === parent.pid, "O6 · the tree holds the root and its child", tree);
  const r6 = endOwned([pId], { tree: true });
  await sleep(500);
  check(tree.every((t) => !stillRunning(t)) && stillRunning(d), "O6 · root + child ended; the unrelated process untouched", r6);

  // O7 · a FAILING test still ends its processes (a child script registers a sleeper, then throws).
  const failing = await runChild(`
    import { spawn } from "node:child_process";
    const { createOwned } = await import(${JSON.stringify(OWNED_URL)});
    const owned = createOwned();
    process.on("exit", () => owned.endAll());
    const s = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    const id = owned.addPid(s.pid);
    console.log("SLEEPER " + JSON.stringify(id));
    throw new Error("simulated assertion failure");`);
  const leftId = JSON.parse(/SLEEPER (\{.*\})/.exec(failing.out)?.[1] ?? "null");
  await sleep(800);
  check(failing.code !== 0 && leftId, "O7 · the simulated test FAILED (non-zero exit) after starting a process", { code: failing.code });
  check(!stillRunning(leftId), "O7 · 🔴 …and its process was ended by its own exit cleanup — nothing left running", leftId);

  // ── DIALOGS ────────────────────────────────────────────────────────────────────────────────
  // D1 · an UNEXPECTED error box makes a test FAIL (exit 1) — run as a real child test.
  const dialogTest = (expected) => `
    import { spawn } from "node:child_process";
    const { createOwned } = await import(${JSON.stringify(OWNED_URL)});
    const { waitForTitle, unexpectedErrors } = await import(${JSON.stringify(DIALOGS_URL)});
    const owned = createOwned();
    process.on("exit", () => owned.endAll());
    const script = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('x', '${NOT_RESTORED}') | Out-Null";
    const box = spawn("powershell", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "ignore" });
    owned.addPid(box.pid);
    const seen = await waitForTitle(box.pid, ${JSON.stringify(NOT_RESTORED)}, 20000);
    if (!seen.found) { console.log("BOX NOT SEEN"); process.exit(2); }
    const bad = unexpectedErrors(seen.titles, ${JSON.stringify(expected)});
    console.log("UNEXPECTED " + JSON.stringify(bad));
    process.exit(bad.length ? 1 : 0);`;
  const unexpected = await runChild(dialogTest([]));
  check(unexpected.code === 1 && /UNEXPECTED \["/.test(unexpected.out), "D1 · 🔴 an error box nobody expected makes the test FAIL", unexpected);

  // D2 · the SAME box, provoked on purpose and asserted, passes — and only because it was SEEN.
  const intended = await runChild(dialogTest([NOT_RESTORED]));
  check(intended.code === 0 && /UNEXPECTED \[\]/.test(intended.out), "D2 · an intended, asserted error box passes (it was seen, not missed)", intended);

  // D3 · a notice that never comes FAILS inside its declared bound.
  const errBox = messageBox(NOT_RESTORED);
  const missing = await waitForTitle(errBox.pid, RESTORED, 3000);
  check(!missing.found && missing.ms >= 3000 && missing.ms < 8000, "D3 · 🔴 a missing notice fails within its declared bound", missing);
  endOwned([errBox]);

  // D4 · a LATE notice (4 s) is still found — the old fixed 2.5 s sleep would have failed it.
  const lateBox = messageBox(RESTORED, 4000);
  const late = await waitForTitle(lateBox.pid, RESTORED, 20000);
  check(late.found && late.ms >= 3500, "D4 · a notice that appears after 4 s is found by the bounded wait", late);
  endOwned([lateBox]);

  console.log(`E2E SAFETY HARNESS SELF-TEST PASSED — ${passed} checks`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  const ended = owned.endAll();
  const notProven = ended.filter((r) => r.outcome !== "ended" && r.outcome !== "gone");
  if (notProven.length) console.log(`[cleanup] left alone (not proven own): ${JSON.stringify(notProven)}`);
}
