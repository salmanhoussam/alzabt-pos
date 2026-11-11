// Windows crash-recovery CHECK against the INSTALLED app (gating in CI).
//
// Every scenario starts the app, acts on its main process, then relaunches it the way a merchant
// does — a plain process start of the .exe, no Playwright, no debugging flags — and reads the
// relaunched process's own lifecycle log (ALZABT_POS_DIAG_LOG): did it start, what did
// app.requestSingleInstanceLock() return, did the ledger open with integrity "ok", did the window
// appear. It also records every 'Alzabt POS.exe' process (PID, parent, --type, command line) and
// how long each survives.
//
//   A  graceful   normal close (WM_CLOSE), relaunch after it exited          → must recover
//   B  kill-main  TerminateProcess on the main process only, relaunch 0.5 s  → must recover
//   C  kill-tree  TerminateProcess on the whole tree, relaunch 0.5 s         → must recover
//   D  ledger     sale via the UI, kill the REAL main only, relaunch          → must recover with
//                 integrity ok and the sale present, and every old process gone with no cleanup
//   N  NEGATIVE CONTROL — the old broken test: Playwright starts Electron through `cmd.exe /c`
//                 on Windows; killing app.process() kills only that wrapper. The POS keeps
//                 running, so a relaunch MUST be refused by the single-instance lock. If this
//                 check ever "recovers", the detector above can no longer tell a dead app from a
//                 live one.
//
// Usage (Windows):  E2E_EXECUTABLE="...\Alzabt POS.exe" node e2e/crash-recovery.mjs
// Output: e2e-output/crash-recovery.json, one line per scenario, exit code 1 on any failure.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { createOwned, endOwned, identifyStartedNear, identifyTree, stillRunning } from "./_owned.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.E2E_EXECUTABLE;
if (process.platform !== "win32" || !EXE) {
  console.log("crash-recovery: Windows + E2E_EXECUTABLE (installed app) required — skipped");
  process.exit(0);
}
const IMAGE = basename(EXE);
const OUT = join(APP, "e2e-output");
const failures = [];
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures.push(msg);
};
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 🔴 This check ENDS processes on purpose (graceful close, kill-main, kill-tree, kill-wrapper). Every
// one it ends is a process IT started, recorded BY IDENTITY (pid + executable + OS creation time) and
// ended ONLY through _owned.mjs, which proves that identity while holding a handle. It never ends a
// process by pid alone and never by image name (the old `taskkill /F /IM` cleanup is gone: it would
// have ended every 'Alzabt POS.exe' on the machine, including a shop's real one).
const owned = createOwned();
process.on("exit", () => owned.endAll());
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function listProcesses() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${IMAGE}'" | Select-Object ProcessId,ParentProcessId,SessionId,CommandLine | ConvertTo-Json -Compress`;
  const raw = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => {
    const cmd = p.CommandLine ?? "";
    return {
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      session: p.SessionId,
      type: /--type=(\S+)/.exec(cmd)?.[1] ?? "browser(main)",
      subType: /--utility-sub-type=(\S+)/.exec(cmd)?.[1] ?? null,
      cmd: cmd.length > 600 ? cmd.slice(0, 600) + "…" : cmd,
    };
  });
}

function processName(pid) {
  const ps = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`;
  const raw = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  return raw ? JSON.parse(raw) : null;
}

function readDiag(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { event: "unparseable", raw: l };
      }
    });
}

async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(200);
  }
  return false;
}

function startLikeAMerchant(env) {
  const t = Date.now();
  const child = spawn(EXE, [], { env, detached: true, stdio: "ignore" });
  const info = { pid: child.pid, startedAt: Date.now(), exit: null, identity: null };
  info.identity = owned.addStartedNear(child.pid, t);
  child.on("exit", (code, signal) => {
    info.exit = { code, signal, afterMs: Date.now() - info.startedAt };
  });
  child.unref();
  return info;
}

function killAll() {
  // Test-harness cleanup between scenarios, AFTER measurement: ONLY processes this check started
  // (recorded by identity). Anything not proven is left alone and reported. (The product never does this.)
  const rows = owned.endAll();
  const notProven = rows.filter((r) => r.outcome === "not-ours" || r.outcome === "unknown");
  if (notProven.length) console.log(`cleanup LEFT ALONE (not proven this check's): ${JSON.stringify(notProven)}`);
  return rows;
}
/** The instance's OWN processes (root + descendants), recorded for cleanup; the report lists only these. */
function instanceProcesses(rootPid) {
  const tree = identifyTree(rootPid);
  for (const i of tree) owned.add(i);
  const pids = new Set(tree.map((i) => i.pid));
  return listProcesses().filter((p) => pids.has(p.pid));
}
/** The deliberate action, applied to the PROVEN process only; fails the check if it did not reach it. */
function act(identity, mode, tree, label) {
  const rows = endOwned([identity], { mode, tree });
  const reached = rows.some((r) => r.pid === identity?.pid && (r.outcome === "ended" || r.outcome === "asked-to-close"));
  check(reached, `${label}: the ${mode}${tree ? " (tree)" : ""} reached the proven process (${JSON.stringify(rows)})`);
  return JSON.stringify(rows);
}

function newProfile(name) {
  const profile = mkdtempSync(join(tmpdir(), `pos-crash-${name}-`));
  const diagFile = join(profile, "diag.log");
  const env = {
    ...process.env,
    ALZABT_POS_USER_DATA: join(profile, "userData"),
    ALZABT_POS_DIAG_LOG: diagFile,
    ALZABT_POS_DISABLE_AUTOSTART: "1",
    // TRANSITION (DEMO-FALLBACK, D-DF1): sells the bundled sample on a fresh profile, which the merchant
    // default no longer serves; the explicit demo switch keeps that coverage. Old value: no switch.
    ALZABT_POS_DEMO_CATALOG: "1",
  };
  return { env, diagFile };
}


/** Relaunch like a merchant and wait until the new process shows a window or exits. */
async function merchantRelaunch(env, diagFile) {
  const relaunch = startLikeAMerchant(env);
  await waitFor(
    () =>
      relaunch.exit !== null ||
      readDiag(diagFile).some((e) => e.pid === relaunch.pid && e.event === "window-ready"),
    30000,
  );
  const events = readDiag(diagFile)
    .filter((e) => e.pid === relaunch.pid)
    .map((e) => ({ ...e, msAfterRelaunch: e.t - relaunch.startedAt }));
  const ev = (name) => events.find((e) => e.event === name);
  return {
    pid: relaunch.pid,
    identity: relaunch.identity,
    exit: relaunch.exit,
    events,
    lockAcquired: ev("single-instance-lock")?.acquired ?? null,
    ledger: ev("ledger-open") ?? null,
    windowMs: ev("window-ready") ? Math.round(ev("window-ready").msAfterRelaunch) : null,
  };
}

/** Wait (no cleanup) until every given PID has exited; returns {pid: msAfterAction|null}. */
async function survivalTimes(pids, since, limitMs) {
  const gone = Object.fromEntries(pids.map((p) => [p, null]));
  while (Date.now() - since < limitMs) {
    for (const p of pids) if (gone[p] === null && !alive(p)) gone[p] = Date.now() - since;
    if (Object.values(gone).every((v) => v !== null)) break;
    await sleep(100);
  }
  return gone;
}

const results = [];
function report(r) {
  results.push(r);
  const survivors = Object.values(r.goneAfterMs ?? {}).filter((v) => v === null).length;
  console.log(
    `SCENARIO ${r.name}: processes=${r.before.length} [${r.before.map((p) => `${p.pid}<${p.ppid}:${p.type}${p.subType ? "/" + p.subType : ""}`).join(", ")}]` +
      ` | gone(ms)=${JSON.stringify(r.goneAfterMs)} survivors=${survivors}` +
      ` | relaunch lock=${r.relaunch.lockAcquired} ledger=${JSON.stringify(r.relaunch.ledger && { integrity: r.relaunch.ledger.integrity, sales: r.relaunch.ledger.sales })}` +
      ` window=${r.relaunch.windowMs ?? "NO"}ms exit=${JSON.stringify(r.relaunch.exit)} events=[${r.relaunch.events.map((e) => e.event).join(",")}]`,
  );
}

function expectRecovered(r) {
  const survivors = Object.entries(r.goneAfterMs).filter(([, v]) => v === null).map(([p]) => p);
  check(survivors.length === 0, `${r.name}: every process of the old instance exited by itself (survivors: ${survivors.join(",") || "none"})`);
  check(r.relaunch.lockAcquired === true, `${r.name}: relaunch acquired the single-instance lock`);
  check(r.relaunch.ledger?.integrity === "ok", `${r.name}: relaunch opened the ledger with integrity "ok"`);
  check(r.relaunch.windowMs !== null, `${r.name}: relaunch showed the POS window (${r.relaunch.windowMs} ms)`);
}

async function closeGracefully(identity) {
  if (!identity) return console.log("closeGracefully: no proven identity — nothing ended");
  endOwned([identity], { mode: "graceful", tree: false });
  if (!(await waitFor(() => !stillRunning(identity), 15000))) endOwned([identity], { mode: "kill", tree: true });
}

process.on("exit", () => {
  try {
    writeFileSync(join(OUT, "crash-recovery.json"), JSON.stringify(results, null, 2));
  } catch {}
});

// ── A / B / C: started like a merchant ─────────────────────────────────────────────────────────
for (const [name, action] of [
  ["A-graceful", "graceful"],
  ["B-kill-main", "kill-main"],
  ["C-kill-tree", "kill-tree"],
]) {
  const { env, diagFile } = newProfile(name);
  const first = startLikeAMerchant(env);
  await waitFor(() => readDiag(diagFile).some((e) => e.pid === first.pid && e.event === "window-ready"), 30000);
  await sleep(1000);
  const before = instanceProcesses(first.pid);
  const tAction = Date.now();
  const actionOutput = act(first.identity, action === "graceful" ? "graceful" : "kill", action === "kill-tree", name);
  const goneAfterMs = await survivalTimes(before.map((p) => p.pid), tAction, action === "graceful" ? 15000 : 10000);
  const relaunch = await merchantRelaunch(env, diagFile);
  const r = { name, action, actionOutput, mainPid: first.pid, before, goneAfterMs, relaunch };
  report(r);
  expectRecovered(r);
  await closeGracefully(relaunch.identity);
  killAll();
  await sleep(1500);
}

// ── D: a real sale, then a crash of the REAL main process, then a merchant relaunch ─────────────
{
  const { env, diagFile } = newProfile("D-ledger");
  const tD = Date.now();
  const app = await electron.launch({ executablePath: EXE, env });
  owned.addStartedNear(app.process().pid, tD);
  const page = await app.firstWindow();

  // 🔴 THIS WAIT USED TO BE MUTE, and that cost two CI rounds. When it timed out it reported only
  // `waiting for locator('text=Select cashier')` — nothing about whether the app had started, whether
  // the window was ready, or what the page actually contained. Phases A/B/C above wait for the
  // app's OWN window-ready diagnostic; D did not, so a failure here could not be told apart from a
  // renderer that never mounted. It now waits for the diagnostic FIRST and, on timeout, writes the
  // DOM and a screenshot before failing. Nothing is weakened: the selector assertion still has to
  // pass, and two new facts are recorded on the way to it.
  const ready = await waitFor(
    () => readDiag(diagFile).some((e) => e.event === "window-ready"),
    30000,
  );
  try {
    await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  } catch (err) {
    const dom = await page.evaluate(() => document.getElementById("root")?.innerHTML?.slice(0, 2000) ?? "NO ROOT");
    const url = page.url();
    writeFileSync(join(OUT, "D-ledger-stuck.html"), dom, "utf8");
    await page.screenshot({ path: join(OUT, "D-ledger-stuck.png") }).catch(() => {});
    // This file logs with console.log — there is no log() helper here, and assuming one would have
    // thrown a ReferenceError INSIDE the error path, hiding the very failure it exists to explain.
    console.log(
      "D-ledger STUCK:",
      JSON.stringify({ windowReadyDiag: ready, url, rootLength: dom.length, diagEvents: readDiag(diagFile).map((e) => e.event) }),
    );
    throw err;
  }
  await signIn(page, "Cashier One", "1111");
  await page.locator("button.product", { hasText: "Espresso" }).click();
  await page.locator('[data-testid="complete-sale"]').click();
  await page.locator('[data-testid="pay-cash"]').click();
  await page.waitForSelector('[data-testid="receipt-number"]:has-text("#1")');
  const mainPid = await app.evaluate(() => process.pid);
  const launcherPid = app.process().pid; // read BEFORE the kill: the handle is disposed afterwards
  const mainId = owned.addStartedNear(mainPid, tD);
  const before = instanceProcesses(mainPid);
  const tAction = Date.now();
  const actionOutput = act(mainId, "kill", false, "D"); // the PROVEN main process only
  const goneAfterMs = await survivalTimes(before.map((p) => p.pid), tAction, 10000);
  const relaunch = await merchantRelaunch(env, diagFile);
  const r = { name: "D-ledger-kill-real-main", action: "kill-main", actionOutput, mainPid, launcherPid, before, goneAfterMs, relaunch };
  report(r);
  expectRecovered(r);
  check(r.relaunch.ledger?.sales === 1, `D: the sale committed before the crash is in the reopened ledger (sales=${r.relaunch.ledger?.sales})`);
  await closeGracefully(relaunch.identity);
  killAll();
  await sleep(1500);
}

// ── N: NEGATIVE CONTROL — kill only Playwright's cmd.exe wrapper (the old broken E2E kill) ──────
{
  const { env, diagFile } = newProfile("N-control");
  const tN = Date.now();
  const app = await electron.launch({ executablePath: EXE, env });
  await app.firstWindow();
  const mainPid = await app.evaluate(() => process.pid);
  const launcherPid = app.process().pid;
  const launcherId = owned.addStartedNear(launcherPid, tN);
  owned.addStartedNear(mainPid, tN);
  const mainInfo = listProcesses().find((p) => p.pid === mainPid);
  const parent = mainInfo ? processName(mainInfo.ppid) : null;
  const launcher = processName(launcherPid);
  console.log(`CONTROL launcher pid ${launcherPid} = ${launcher?.Name} ; real main pid ${mainPid}, parent ${mainInfo?.ppid} = ${parent?.Name}`);
  const before = instanceProcesses(mainPid);
  const actionOutput = act(launcherId, "kill", false, "N"); // the PROVEN wrapper only
  await sleep(2000);
  const relaunch = await merchantRelaunch(env, diagFile);
  const r = { name: "N-negative-control-kill-wrapper-only", action: "kill-launcher", actionOutput, mainPid, launcherPid, launcherName: launcher?.Name, mainParentName: parent?.Name, before, goneAfterMs: {}, relaunch, mainStillAlive: alive(mainPid) };
  report(r);
  check(launcherPid !== mainPid, `N: on Windows Playwright's app.process() (${launcherPid}, ${launcher?.Name}) is not the Electron main (${mainPid})`);
  check(r.mainStillAlive, "N: killing only the wrapper leaves the POS running (not a crash)");
  check(r.relaunch.lockAcquired === false && r.relaunch.windowMs === null, "N: the detector reports NOT recovered — relaunch is refused by the lock while the POS still runs");
  await Promise.race([app.close().catch(() => {}), sleep(10000)]);
  killAll();
}

writeFileSync(join(OUT, "crash-recovery.json"), JSON.stringify(results, null, 2));
console.log(`wrote ${join(OUT, "crash-recovery.json")}`);
if (failures.length) {
  console.log(`CRASH RECOVERY: ${failures.length} FAILED CHECK(S)`);
  process.exit(1);
}
console.log("CRASH RECOVERY: ALL CHECKS PASSED");
