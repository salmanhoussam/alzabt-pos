// Windows crash-recovery MEASUREMENT (not a pass/fail test).
//
// For each scenario it launches the INSTALLED app, waits for its window, acts on the main
// process, then relaunches it the way a merchant does (a plain process start of the .exe — no
// Playwright, no debugging flags) and records:
//   - every 'Alzabt POS.exe' process before the action: PID, parent PID, --type, command line
//   - how long each of those processes stays alive after the action
//   - the relaunched process's own lifecycle log (ALZABT_POS_DIAG_LOG): did it start, what did
//     app.requestSingleInstanceLock() return, did it reach ready / window-ready, did it exit
//
// Scenarios:
//   A  graceful   normal close (WM_CLOSE via taskkill without /F), relaunch after it exited
//   B  kill-main  TerminateProcess on the main process only, relaunch 0.5 s later
//   C  kill-tree  TerminateProcess on the whole process tree, relaunch 0.5 s later
//   B' kill-main  as B, but the FIRST launch goes through Playwright (is it a test artifact?)
//
// Usage (Windows):  E2E_EXECUTABLE="...\Alzabt POS.exe" node e2e/crash-diagnostics.mjs
// Output: e2e-output/crash-diagnostics.json and one summary line per scenario.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.E2E_EXECUTABLE;
if (process.platform !== "win32" || !EXE) {
  console.log("crash-diagnostics: Windows + E2E_EXECUTABLE (installed app) required — skipped");
  process.exit(0);
}
const IMAGE = basename(EXE);
const OUT = join(APP, "e2e-output");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const child = spawn(EXE, [], { env, detached: true, stdio: "ignore" });
  const info = { pid: child.pid, startedAt: Date.now(), exit: null };
  child.on("exit", (code, signal) => {
    info.exit = { code, signal, afterMs: Date.now() - info.startedAt };
  });
  child.unref();
  return info;
}

function killAll() {
  // Test-harness cleanup between scenarios, AFTER measurement. (The product must never do this.)
  try {
    execFileSync("taskkill", ["/F", "/IM", IMAGE], { stdio: "ignore" });
  } catch {}
}

async function scenario(name, launcher, action) {
  const profile = mkdtempSync(join(tmpdir(), `pos-crash-${name}-`));
  const diagFile = join(profile, "diag.log");
  const env = {
    ...process.env,
    ALZABT_POS_USER_DATA: join(profile, "userData"),
    ALZABT_POS_DIAG_LOG: diagFile,
    ALZABT_POS_DISABLE_AUTOSTART: "1",
  };

  let mainPid;
  let pw = null;
  if (launcher === "spawn") {
    mainPid = startLikeAMerchant(env).pid;
  } else {
    pw = await electron.launch({ executablePath: EXE, env });
    await pw.firstWindow();
    mainPid = pw.process().pid;
  }
  const firstReady = await waitFor(
    () => readDiag(diagFile).some((e) => e.pid === mainPid && e.event === "window-ready"),
    30000,
  );
  await sleep(1000); // let helper processes settle
  const before = listProcesses();

  const tAction = Date.now();
  const args = { graceful: ["/PID", String(mainPid)], "kill-main": ["/F", "/PID", String(mainPid)], "kill-tree": ["/F", "/T", "/PID", String(mainPid)] }[action];
  let actionOutput;
  try {
    actionOutput = execFileSync("taskkill", args, { encoding: "utf8" }).trim();
  } catch (e) {
    actionOutput = `taskkill failed: ${String(e.stderr || e.message).trim()}`;
  }
  if (action === "graceful") await waitFor(() => !alive(mainPid), 15000);
  else await sleep(500);

  const relaunch = startLikeAMerchant(env);
  const goneAfterMs = Object.fromEntries(before.map((p) => [p.pid, alive(p.pid) ? null : Date.now() - tAction]));
  while (Date.now() - tAction < 30000) {
    for (const p of before) if (goneAfterMs[p.pid] === null && !alive(p.pid)) goneAfterMs[p.pid] = Date.now() - tAction;
    await sleep(250);
  }
  const after = listProcesses();
  const events = readDiag(diagFile);
  const rel = (e) => ({ ...e, msAfterRelaunch: e.t - relaunch.startedAt });

  const result = {
    name,
    launcher,
    action,
    actionOutput,
    firstLaunch: { pid: mainPid, reachedWindow: firstReady, events: events.filter((e) => e.pid === mainPid).map((e) => e.event) },
    before: before.map((p) => ({ ...p, goneAfterMs: goneAfterMs[p.pid] })),
    relaunch: {
      pid: relaunch.pid,
      exit: relaunch.exit,
      events: events.filter((e) => e.pid === relaunch.pid).map(rel),
    },
    after: after.map((p) => ({ pid: p.pid, ppid: p.ppid, type: p.type, subType: p.subType })),
  };

  if (pw) await pw.close().catch(() => {});
  killAll();
  await sleep(2000);
  return result;
}

const results = [];
for (const [name, launcher, action] of [
  ["A-graceful", "spawn", "graceful"],
  ["B-kill-main", "spawn", "kill-main"],
  ["C-kill-tree", "spawn", "kill-tree"],
  ["B2-kill-main-playwright-launch", "playwright", "kill-main"],
]) {
  const r = await scenario(name, launcher, action);
  results.push(r);
  const lock = r.relaunch.events.find((e) => e.event === "single-instance-lock");
  const win = r.relaunch.events.find((e) => e.event === "window-ready");
  const survivors = r.before.filter((p) => p.goneAfterMs === null);
  console.log(
    `SCENARIO ${name}: before=${r.before.length} [${r.before.map((p) => `${p.pid}<${p.ppid}:${p.type}${p.subType ? "/" + p.subType : ""}`).join(", ")}]` +
      ` | survivors>30s=${survivors.length} [${survivors.map((p) => p.type + (p.subType ? "/" + p.subType : "")).join(", ")}]` +
      ` | gone(ms)=${JSON.stringify(Object.fromEntries(r.before.map((p) => [p.type + (p.subType ? "/" + p.subType : "") + "#" + p.pid, p.goneAfterMs])))}` +
      ` | relaunch: started=${r.relaunch.events.some((e) => e.event === "main-start")} lock=${lock ? lock.acquired : "n/a"}` +
      ` window=${win ? Math.round(win.msAfterRelaunch) + "ms" : "NO"} exit=${JSON.stringify(r.relaunch.exit)}` +
      ` events=[${r.relaunch.events.map((e) => e.event).join(",")}]`,
  );
}
writeFileSync(join(OUT, "crash-diagnostics.json"), JSON.stringify(results, null, 2));
console.log(`wrote ${join(OUT, "crash-diagnostics.json")}`);
