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
    return execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((b) => Buffer.from(b.trim(), "base64").toString("utf8"));
  } catch {
    return [];
  }
}

/**
 * Wait — bounded and declared — for a window titled `title` to be visible in process `pid`.
 * Returns { found, ms, titles } where `titles` is the last read. Never throws.
 */
export async function waitForTitle(pid, title, timeoutMs) {
  const t0 = Date.now();
  let titles = [];
  while (Date.now() - t0 <= timeoutMs) {
    titles = windowTitlesOf(pid) ?? [];
    if (titles.includes(title)) return { found: true, ms: Date.now() - t0, titles };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { found: false, ms: Date.now() - t0, titles };
}

/** The error-box titles in `titles` that the caller did not explicitly expect. */
export const unexpectedErrors = (titles, expected = []) => (titles ?? []).filter((t) => ERROR_TITLES.includes(t) && !expected.includes(t));

// Process ownership (identify / end only proven-own processes) lives in ./_owned.mjs.
