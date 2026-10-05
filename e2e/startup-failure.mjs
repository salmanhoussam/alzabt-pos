// Startup-failure E2E: the installed app must NOT open a till on a ledger it cannot open correctly,
// must NOT replace a missing ledger with an empty one, must leave the ledger byte-for-byte unchanged,
// and must tell the operator (native error box) and the log (startup-failure + code).
//
//   E2E_EXECUTABLE="...\Alzabt POS.exe" node e2e/startup-failure.mjs
//
// Uses throw-away profiles (ALZABT_POS_USER_DATA): this proves the failure path, the upgrade E2E
// proves the real default profile. The error box is modal, so the process stays alive showing it;
// the test reads the log, checks the window title on Windows, then kills the process tree.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const Database = createRequire(import.meta.url)("better-sqlite3");
const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function windowTitle(pid) {
  if (process.platform !== "win32") return null;
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).MainWindowTitle`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function runFailing(profile, expectedCode) {
  const logFile = join(profile, "logs", "alzabt-pos.log");
  const child = spawn(ELECTRON, [...EXTRA_ARGS, ...APP_ARGS], {
    env: { ...process.env, ALZABT_POS_USER_DATA: profile, ALZABT_POS_DISABLE_AUTOSTART: "1" },
    stdio: "ignore",
  });
  let exited = null;
  child.on("exit", (code) => (exited = code));
  let line = null;
  let title = null;
  for (let i = 0; i < 120 && !line; i++) {
    await sleep(250);
    if (existsSync(logFile)) {
      line = readFileSync(logFile, "utf8").split("\n").find((l) => l.includes('"event":"startup-failure"')) ?? null;
    }
  }
  for (let i = 0; i < 40 && process.platform === "win32" && !title; i++) {
    title = windowTitle(child.pid);
    if (!title) await sleep(250);
  }
  killTree(child.pid);
  assert(line !== null, `${expectedCode}: the log records a startup failure`);
  const entry = JSON.parse(line);
  assert(entry.code === expectedCode, `${expectedCode}: the failure is classified as ${expectedCode}`);
  assert(!readFileSync(logFile, "utf8").includes('"event":"catalog"'), `${expectedCode}: the till never started`);
  if (process.platform === "win32") {
    log("error box window title:", JSON.stringify(title), "process exited early:", exited);
    assert(title === "Alzabt POS — cannot start", `${expectedCode}: the operator sees the error box`);
  }
}

// 1. A ledger written by a NEWER build (more migrations than this build knows).
const p1 = mkdtempSync(join(tmpdir(), "pos-fail-newer-"));
const ledger1 = join(p1, "alzabt-pos-ledger.sqlite");
const db = new Database(ledger1);
db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
const ins = db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)");
for (let v = 1; v <= 99; v++) ins.run(v, `future_${v}`, "x".repeat(64), "2030-01-01T00:00:00Z");
db.exec("CREATE TABLE sales (id TEXT PRIMARY KEY)");
db.prepare("INSERT INTO sales VALUES ('kept')").run();
db.close();
const before = sha(ledger1);
await runFailing(p1, "DB_NEWER_THAN_APP");
assert(sha(ledger1) === before, "DB_NEWER_THAN_APP: the ledger file is byte-for-byte unchanged");

// 2. The ledger is gone but this profile had one: refuse, create nothing.
const p2 = mkdtempSync(join(tmpdir(), "pos-fail-missing-"));
mkdirSync(p2, { recursive: true });
writeFileSync(join(p2, "ledger.json"), JSON.stringify({ ledgerFile: "alzabt-pos-ledger.sqlite" }));
await runFailing(p2, "LEDGER_MISSING");
assert(!existsSync(join(p2, "alzabt-pos-ledger.sqlite")), "LEDGER_MISSING: no new empty ledger was created");

log("ALL STARTUP FAILURE CHECKS PASSED");
