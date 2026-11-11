// PROVEN process ownership for E2E cleanup — the ONLY way an E2E script may end a process.
//
// 🔴 Why (owner review, 2026-11-11): a cleanup ended "a pid from the test's own log that was still
// alive" — but Windows reuses pids within seconds, so that number may already have belonged to
// someone else's process (VS Code, Chrome, a game). A pid alone proves nothing. Here a process is
// the test's own only when ALL of these hold, checked at the moment of ending it:
//   • the same pid,
//   • the same executable path, and
//   • the same creation time, as the OS reports it (100 ns ticks) — recorded when the test started
//     or first saw the process, never an estimate.
// The check and the kill happen inside ONE PowerShell process that holds an open HANDLE to the
// process between them; Windows never reuses a pid while a handle to it is open, so the process
// verified is the process ended (no check-then-kill race). A tree is walked from a verified root;
// a child counts only if it started after its parent (a stale parent-pid match is refused).
// Anything not proven — gone, different identity, no handle (access denied) — is left alone and
// reported: "gone", "not-ours", "unknown".
import { execFileSync } from "node:child_process";

const WIN = process.platform === "win32";
const run = (script) =>
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
const jsonLines = (out) =>
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));

const PS_LIB = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Pin([int]$id) { try { $p = Get-Process -Id $id -ErrorAction Stop; [void]$p.Handle; return $p } catch { return $null } }
function StartOf($p) { try { return [string]$p.StartTime.ToUniversalTime().Ticks } catch { return $null } }
function PathOf($p) { try { return [string]$p.Path } catch { return $null } }
function Emit($h) { [Console]::Out.WriteLine(($h | ConvertTo-Json -Compress)) }
function Tree($root) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $own = @{}; $own[[int]$root.Id] = $root
  $order = New-Object System.Collections.ArrayList; [void]$order.Add($root)
  $queue = New-Object System.Collections.Queue; $queue.Enqueue([int]$root.Id)
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue(); $parentStart = $own[$id].StartTime
    foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $id })) {
      $cid = [int]$c.ProcessId
      if ($own.ContainsKey($cid)) { continue }
      $cp = Pin $cid
      if ($cp -and $cp.StartTime -ge $parentStart) { $own[$cid] = $cp; [void]$order.Add($cp); $queue.Enqueue($cid) }
    }
  }
  return ,$order
}
`;

/** { pid, path, start } of a live process (start = OS creation time in ticks), or null. */
export function identify(pid) {
  if (!WIN) return identifyPosix(pid);
  try {
    const [r] = jsonLines(run(`${PS_LIB}
$p = Pin ${Number(pid)}
if ($p) { Emit @{ pid = [int]$p.Id; path = (PathOf $p); start = (StartOf $p) } }`));
    return r && r.path && r.start ? { pid: r.pid, path: r.path, start: r.start } : null;
  } catch {
    return null;
  }
}

/** The identities of a live root process and of every descendant that started after its parent. */
export function identifyTree(pid) {
  if (!WIN) {
    const id = identifyPosix(pid);
    return id ? [id] : [];
  }
  try {
    return jsonLines(
      run(`${PS_LIB}
$p = Pin ${Number(pid)}
if ($p) { foreach ($t in (Tree $p)) { Emit @{ pid = [int]$t.Id; path = (PathOf $t); start = (StartOf $t) } } }`),
    ).filter((r) => r.path && r.start);
  } catch {
    return [];
  }
}

/** OS creation time of an identity, in Unix ms (Windows ticks → ms); null elsewhere. */
export const startMs = (identity) => (WIN && identity ? Number((BigInt(identity.start) - 621355968000000000n) / 10000n) : null);

/**
 * identify(pid), accepted ONLY if the process was created inside [sinceMs − 2 s, untilMs + 2 s] —
 * i.e. it is the process the test just started (or its log just recorded), not an older or newer
 * holder of the same number. Returns null when that cannot be proven.
 */
export function identifyStartedNear(pid, sinceMs, untilMs = Date.now()) {
  const id = identify(pid);
  if (!id || !WIN) return id;
  const s = startMs(id);
  return s >= sinceMs - 2000 && s <= untilMs + 2000 ? id : null;
}

/** Is this exact process (pid + path + creation time) still running? */
export function stillRunning(identity) {
  if (!identity) return false;
  const now = identify(identity.pid);
  return !!now && now.path.toLowerCase() === identity.path.toLowerCase() && now.start === identity.start;
}

/**
 * End processes PROVEN to be the given identities.
 *   mode "kill"     — TerminateProcess through the verified handle (children first when tree).
 *   mode "graceful" — a normal close request (taskkill without /F) to the verified root, sent WHILE
 *                     its handle is held, so the pid cannot change hands in between.
 * Returns one row per process: { pid, outcome: ended|asked-to-close|gone|not-ours|unknown, ... }.
 */
export function endOwned(identities, { mode = "kill", tree = true } = {}) {
  const items = (identities ?? []).filter(Boolean).map((i) => ({ pid: Number(i.pid), path: String(i.path), start: String(i.start) }));
  if (!items.length) return [];
  if (!WIN) return endOwnedPosix(items, mode);
  const payload = Buffer.from(JSON.stringify(items), "utf8").toString("base64");
  const script = `${PS_LIB}
$items = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
foreach ($it in $items) {
  $p = Pin ([int]$it.pid)
  if (-not $p) { Emit @{ pid = [int]$it.pid; outcome = 'gone' }; continue }
  $path = PathOf $p; $start = StartOf $p
  if ($path -eq $null -or $start -eq $null) { Emit @{ pid = [int]$it.pid; outcome = 'unknown'; reason = 'identity unreadable' }; continue }
  if ($path -ne $it.path -or $start -ne $it.start) { Emit @{ pid = [int]$it.pid; outcome = 'not-ours'; seenPath = $path; seenStart = $start }; continue }
  if ('${mode}' -eq 'graceful') {
    & taskkill.exe /PID $p.Id 2>&1 | Out-Null
    Emit @{ pid = [int]$p.Id; outcome = 'asked-to-close' }
    continue
  }
  $targets = if (${tree ? "$true" : "$false"}) { Tree $p } else { ,@($p) }
  for ($i = $targets.Count - 1; $i -ge 0; $i--) {
    $t = $targets[$i]
    try { if (-not $t.HasExited) { $t.Kill(); Emit @{ pid = [int]$t.Id; outcome = 'ended'; root = [int]$p.Id } } else { Emit @{ pid = [int]$t.Id; outcome = 'gone' } } }
    catch { Emit @{ pid = [int]$t.Id; outcome = 'unknown'; reason = [string]$_.Exception.Message } }
  }
}`;
  try {
    return jsonLines(run(script));
  } catch (e) {
    return items.map((i) => ({ pid: i.pid, outcome: "unknown", reason: String(e?.message ?? e).slice(0, 200) }));
  }
}

/** A registry of the processes a test started; endAll() is synchronous, so it is safe in an exit handler. */
export function createOwned() {
  const ids = [];
  const reg = {
    add(identity) {
      if (identity && !ids.some((i) => i.pid === identity.pid && i.start === identity.start)) ids.push(identity);
      return identity ?? null;
    },
    addPid(pid) {
      return reg.add(identify(pid));
    },
    addStartedNear(pid, sinceMs, untilMs) {
      return reg.add(identifyStartedNear(pid, sinceMs, untilMs));
    },
    addTree(pid) {
      const tree = identifyTree(pid);
      for (const i of tree) reg.add(i);
      return tree;
    },
    list: () => [...ids],
    endAll() {
      const live = ids.filter(stillRunning);
      return live.length ? endOwned(live, { mode: "kill", tree: true }) : [];
    },
  };
  return reg;
}

// ── non-Windows (CI on Linux/macOS): same rule, `ps` start time + executable name ────────────────
function identifyPosix(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-o", "comm=", "-p", String(Number(pid))], { encoding: "utf8" }).trim();
    if (!out) return null;
    const m = /^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(out);
    return m ? { pid: Number(pid), path: m[2], start: m[1] } : null;
  } catch {
    return null;
  }
}
function endOwnedPosix(items, mode) {
  return items.map((it) => {
    const now = identifyPosix(it.pid);
    if (!now) return { pid: it.pid, outcome: "gone" };
    if (now.path !== it.path || now.start !== it.start) return { pid: it.pid, outcome: "not-ours" };
    try {
      process.kill(it.pid, mode === "graceful" ? "SIGTERM" : "SIGKILL");
      return { pid: it.pid, outcome: mode === "graceful" ? "asked-to-close" : "ended" };
    } catch (e) {
      return { pid: it.pid, outcome: "unknown", reason: String(e?.message ?? e) };
    }
  });
}
