// Native windows of the app, read from Windows itself — shared by the E2E scripts that must SEE a
// message box the test did not open (a restore notice, a startup error).
//
// 🔴 Why this exists (owner-observed finding, 2026-11-11): backup-restore provokes real error boxes on
// purpose (a damaged journal, a locked file) and then closed the app under them, so a watching owner
// saw Arabic error dialogs flash and vanish while the run went green. A test may provoke an error box
// only if it then ASSERTS that box; any other error box is a failure. And a notice is waited for with
// a declared, bounded timeout — never a fixed sleep.
import { execFileSync } from "node:child_process";

export const WINDOWS = process.platform === "win32";

/** Titles of the app's error / warning boxes (src/main/startupFailure.ts, restore.notice.* in i18n.ts). */
export const ERROR_TITLES = Object.freeze([
  "Alzabt POS — cannot start",
  "لم تتمّ الاستعادة",
  "The backup was not restored",
]);
export const RESTORED_TITLES = Object.freeze(["تمّت استعادة النسخة الاحتياطيّة", "Backup restored"]);

const ENUM = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Of(uint pid) { var r = new List<string>(); EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h, out p);
    if (p == pid && IsWindowVisible(h)) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.Length > 0) r.Add(sb.ToString()); } return true; }, IntPtr.Zero); return r; }
}
"@`;

/** Every visible top-level window title of a process, read as UTF-8 through Base64 (Arabic-safe). */
export function windowTitlesOf(pid) {
  if (!WINDOWS) return null;
  const ps = `${ENUM}
[W]::Of(${pid}) | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }`;
  try {
    const titles = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((b) => Buffer.from(b.trim(), "base64").toString("utf8"));
    if (titles.length === 0) readStats.empty += 1;
    else readStats.ok += 1;
    return titles;
  } catch (err) {
    readStats.failed += 1;
    readStats.lastError = String(err && err.message ? err.message : err).slice(0, 300);
    return [];
  }
}

/**
 * DEC-35zz+ investigation (evidence only): how each read went. A FAILED PowerShell read used to look
 * exactly like "no window at all", which is the one thing a missing-notice investigation must tell apart.
 */
export const readStats = { ok: 0, empty: 0, failed: 0, lastError: null };

/**
 * DEC-35zz+ investigation (evidence only): who holds the desktop right now — the foreground window's
 * process and title — and how long ago the LAST REAL keyboard/mouse input reached Windows. A notice
 * answered by a person (or by keystrokes aimed at another window) shows up here; the test sends none.
 */
export function desktopProbe() {
  if (!WINDOWS) return null;
  const ps = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class D {
  [StructLayout(LayoutKind.Sequential)] public struct L { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref L l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Probe() { var l = new L(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l);
    uint idle = (uint)Environment.TickCount - l.dwTime; var h = GetForegroundWindow(); uint p; GetWindowThreadProcessId(h, out p);
    var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
    return idle + "|" + p + "|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.ToString())); }
}
"@
[D]::Probe()`;
  try {
    const [idle, pid, title] = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split("|");
    return { at: Date.now(), idleMs: Number(idle), foregroundPid: Number(pid), foregroundTitle: Buffer.from(title ?? "", "base64").toString("utf8") };
  } catch (err) {
    return { at: Date.now(), error: String(err && err.message ? err.message : err).slice(0, 300) };
  }
}

/**
 * Wait — bounded and declared — for a window titled `title` to be visible in process `pid`.
 * Returns { found, ms, titles } where `titles` is the last read. Never throws.
 */
export async function waitForTitle(pid, title, timeoutMs) {
  const t0 = Date.now();
  const before = { ...readStats };
  const reads = () => ({ ok: readStats.ok - before.ok, empty: readStats.empty - before.empty, failed: readStats.failed - before.failed, lastError: readStats.lastError });
  let titles = [];
  while (Date.now() - t0 <= timeoutMs) {
    titles = windowTitlesOf(pid) ?? [];
    if (titles.includes(title)) return { found: true, ms: Date.now() - t0, titles, reads: reads() };
    await new Promise((r) => setTimeout(r, 250));
  }
  // Evidence only (the verdict and the timeout are unchanged): what the desktop looked like when the wait gave up.
  return { found: false, ms: Date.now() - t0, titles, reads: reads(), desktop: desktopProbe() };
}

/** The error-box titles in `titles` that the caller did not explicitly expect. */
export const unexpectedErrors = (titles, expected = []) => (titles ?? []).filter((t) => ERROR_TITLES.includes(t) && !expected.includes(t));

// Process ownership (identify / end only proven-own processes) lives in ./_owned.mjs.
