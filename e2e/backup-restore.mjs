/**
 * Track 2 phase 4 — full backup and restore against the INSTALLED app.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS REAL HERE, AND WHAT IS SIMULATED — said once, at the top, because it is the whole value
 * of the evidence:
 *
 *   REAL      the installed executable; the real renderer bridge (`window.pos`) and channel policy;
 *             the real folder picker call (only its RESULT is supplied, by replacing
 *             `dialog.showOpenDialogSync` in main from Playwright — main looks it up at call time
 *             for exactly this); a real `app.relaunch()` that starts a new process the test did
 *             not launch; real Windows file locks held by another process; real paths with spaces
 *             and Arabic.
 *   SIMULATED an interruption in the MIDDLE of the restore engine. It cannot be timed from
 *             outside (the engine finishes in milliseconds at startup), and the owner forbade a
 *             production hook. So this harness runs the SAME compiled engine (dist/) through its
 *             existing injectable file port and makes every file operation fail after the k-th —
 *             the on-disk state a dead process leaves — then the installed app is started on it.
 *             That is a simulated process death, NOT a power cut: no disk cache is lost here.
 *   NOT TESTED a real power cut, antivirus, a USB drive pulled mid-write.
 *
 * Synthetic data only, in a temp folder whose name carries spaces and Arabic. No product code is
 * changed by this file and nothing it needs exists only for tests inside the app.
 *
 * Run: node e2e/backup-restore.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 *      locally (better-sqlite3 is built against Electron's ABI; a Wayland desktop needs flags):
 *        E2E_EXTRA_ARGS="--disable-gpu --ozone-platform=x11" env -u ELECTRON_RUN_AS_NODE \
 *          ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron e2e/backup-restore.mjs
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { E2E_PIN, signIn } from "./_signin.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? require("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const EXTRA_ARGS = [
  ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
  ...(process.env.E2E_EXTRA_ARGS ? process.env.E2E_EXTRA_ARGS.split(" ").filter(Boolean) : []),
];
const WINDOWS = process.platform === "win32";
const SHOTS = join(APP, "e2e-output");
mkdirSync(SHOTS, { recursive: true });

const Database = require("better-sqlite3");
// The SAME compiled engine the app ships (CI builds dist/ before these steps).
const engine = require(join(APP, "dist", "main", "persistence", "restoreEngine.js"));
const pkgLib = require(join(APP, "dist", "main", "persistence", "backupPackage.js"));

const HOME = mkdtempSync(join(tmpdir(), "pos-e2e-restore-"));
const ROOT = join(HOME, "مجلد اختبار alzabt");
const USB = join(ROOT, "ذاكرة USB", "نسخ احتياطية");
mkdirSync(USB, { recursive: true });
const DIAG = join(HOME, "diag.jsonl");
const LEDGER_FILE = "alzabt-pos-ledger.sqlite";
const profile = (name) => join(ROOT, name, "userData");

const log = (...a) => console.log("•", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const shaFile = (p) => sha(readFileSync(p));

// ── Evidence: written after EVERY assertion, so a failure never loses what was measured ─────────
const evidence = { startedAt: new Date().toISOString(), platform: process.platform, packaged: Boolean(PACKAGED), checks: [], facts: {} };
const EVIDENCE = join(SHOTS, "P4-backup-restore-evidence.json");
const persist = () => writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
const fact = (k, v) => {
  evidence.facts[k] = v;
  persist();
};
let passed = 0;
function check(cond, msg, data) {
  evidence.checks.push({ ok: Boolean(cond), msg, ...(data === undefined ? {} : { data }) });
  persist();
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${data === undefined ? "" : ` — ${JSON.stringify(data)}`}`);
  passed += 1;
  log("PASS", msg);
}
function skip(msg) {
  evidence.checks.push({ ok: null, skipped: true, msg });
  persist();
  log("SKIP", msg);
}

async function until(what, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`TIMED OUT waiting for ${what} after ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ── A synthetic PNG (a flat rectangle; no real logo) ─────────────────────────────────────────────
function png(width, height, [r, g, b]) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const LOGO_ONE = join(HOME, "شعار واحد.png");
const LOGO_TWO = join(HOME, "شعار اثنان.png");
writeFileSync(LOGO_ONE, png(240, 120, [204, 0, 0]));
writeFileSync(LOGO_TWO, png(60, 30, [0, 0, 204]));
const FROZEN_ONE = `${shaFile(LOGO_ONE).slice(0, 32)}.png`;
const FROZEN_TWO = `${shaFile(LOGO_TWO).slice(0, 32)}.png`;

// ── The app ──────────────────────────────────────────────────────────────────────────────────────
const envFor = (userData) => {
  const env = { ...process.env, ALZABT_POS_USER_DATA: userData, ALZABT_POS_DISABLE_AUTOSTART: "1", ALZABT_POS_DIAG_LOG: DIAG };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

async function launch(userData) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env: envFor(userData) });
  const page = await app.firstWindow();
  return { app, page };
}
const asOwner = async (l) => (await signIn(l.page, "Cashier One", "1111"), l);

/** One bridge call, through the REAL preload. Returns the IpcResult as the renderer sees it. */
const pos = (page, method, arg) => page.evaluate(([m, a]) => window.pos[m](a), [method, arg]);
async function ok(page, method, arg) {
  const r = await pos(page, method, arg);
  if (!r.ok) throw new Error(`${method} refused: ${JSON.stringify(r.error)}`);
  return r.data;
}
const errCode = (r) => (r.ok ? null : r.error.code);

/** Supplies the RESULT of the native folder picker, and counts how often main asked for one. */
const stubFolder = (app, path) =>
  app.evaluate(({ dialog }, p) => {
    globalThis.__e2ePickers = globalThis.__e2ePickers ?? 0;
    dialog.showOpenDialogSync = () => {
      globalThis.__e2ePickers += 1;
      return p === null ? undefined : [p];
    };
  }, path);
const stubFile = (app, path) => stubFolder(app, path);
const stubSave = (app, path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialogSync = () => p;
  }, path);
const pickerCalls = (app) => app.evaluate(() => globalThis.__e2ePickers ?? 0);

const testid = (page, id) => page.locator(`[data-testid="${id}"]`);
async function shot(page, name) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))).catch(() => undefined);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  fact(`screenshot:${name}`, `${name}.png`);
}

/** The whole Windows desktop — the only way to see a native message box the test did not open. */
function desktopShot(name) {
  if (!WINDOWS) return skip(`desktop screenshot ${name} (Windows only)`);
  const out = join(SHOTS, `${name}.png`);
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${out.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
  ]);
  fact(`screenshot:${name}`, `${name}.png`);
}

/** Every visible top-level window title of a process, read as UTF-8 through Base64 (Arabic-safe). */
function windowTitlesOf(pid) {
  if (!WINDOWS) return null;
  const ps = `
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
"@
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

function killTree(pid) {
  try {
    if (WINDOWS) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const appLog = (userData) => {
  const f = join(userData, "logs", "alzabt-pos.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const diagEvents = () => (existsSync(DIAG) ? readFileSync(DIAG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastRestore = (userData) => JSON.parse(readFileSync(join(userData, "restore", "last-restore.json"), "utf8"));
const journalExists = (userData) => existsSync(join(userData, "restore", "journal.json"));

/** Reads a ledger through a COPY of its files, so the -wal is honoured and the original is untouched. */
function readLedger(dir, file, fn) {
  const scratch = mkdtempSync(join(HOME, "read-"));
  for (const f of readdirSync(dir).filter((n) => n.startsWith(file))) copyFileSync(join(dir, f), join(scratch, f.replace(file, "ledger.sqlite")));
  const db = new Database(join(scratch, "ledger.sqlite"), { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
const MONEY = ["sales", "sale_lines", "voids", "invoices", "invoice_lines", "parties", "obligations", "settlements", "receipts", "receipt_attempts", "receipt_attempt_lines", "collection_attempts"];
const moneyRows = (db) => Object.fromEntries(MONEY.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
const count = (db, t, where = "1=1") => db.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${where}`).get().n;

const sale = (key) => ({ idempotencyKey: key, lines: [{ productId: "prod-0003", quantityMilli: 1000 }], paymentMethod: "cash", expectedTotalMinor: "199" });
const PROFILE = { nameAr: "متجر اختبار النسخ", nameEn: "Backup Test Store", legalName: null, tagline: null, address: null, phone1: null, phone2: null, email: null, logoPath: null, taxpayerNumber: null, commercialRegister: null, vatNumber: null, taxEnabled: false, taxRatePercent: null, taxLabel: null };
const LINE = { description: "صنف اختباري", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "10.00" };

async function finalizeInvoice(page) {
  const id = (await ok(page, "createInvoiceDraft", undefined)).invoice.id;
  await ok(page, "addInvoiceLine", { invoiceId: id, line: LINE });
  await ok(page, "finalizeInvoice", { invoiceId: id });
  return id;
}

/** Stages a restore of `pkg` into a CLOSED profile through the shipped engine, as the app would. */
function stageWithEngine(userData, pkg) {
  const p = engine.inspectRestorePackage(pkg);
  engine.stageRestore({ userDataDir: userData, packageDir: pkg, consent: { manifestSha256: p.manifestSha256, acceptedMissingAssets: [] }, now: new Date() });
  return p;
}

/** A file port that "dies" at its k-th mutating operation: every operation after that fails too. */
function dyingFs(k) {
  let n = 0;
  let dead = false;
  const fs = {};
  for (const [name, fn] of Object.entries(pkgLib.nodeBackupFs)) {
    fs[name] = (...args) => {
      if (dead) throw new Error("the process is dead");
      if (["mkdir", "copyFile", "writeFile", "rename", "removeTree"].includes(name) && ++n === k) {
        dead = true;
        throw new Error(`simulated process death at operation ${k}`);
      }
      return fn(...args);
    };
  }
  return { fs, ops: () => n };
}

const tcpOpen = (host, port) =>
  new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3000 });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });

// ═════════════════════════════════════════════════════════════════════════════════════════════════
try {
  log("home:", HOME);
  fact("paths", { ROOT, USB });

  // ── A · the source shop: smoke surface, logos, money, full backup, old export, cashier ──────────
  const A = profile("بيانات المحل أ");
  let pkgComplete;
  let pkgIncomplete;
  {
    const l = await asOwner(await launch(A));
    const { app, page } = l;
    const keys = await page.evaluate(() => Object.keys(window.pos).sort());
    check(keys.length === 79, "window.pos exposes exactly 79 business methods", { got: keys.length });
    for (const k of ["exportFullBackup", "inspectRestoreBackup", "applyRestore"]) check(keys.includes(k), `window.pos has ${k}`);
    // settings.json is written only once a language is CHOSEN; choose one, so the package has it.
    await ok(page, "setTerminalLanguage", { language: "ar" });
    check(existsSync(join(A, "settings.json")), "the profile now has a settings.json");

    // Logos: ONE frozen on invoice 1; invoice 2 finalized while the live file is GONE (freeze fails →
    // a legacy, never-archived invoice); TWO chosen under the SAME stored name for invoice 3.
    await stubFile(app, LOGO_ONE);
    const logoPath = (await ok(page, "pickInvoiceLogo", undefined)).logoPath;
    await ok(page, "saveCompanyProfile", { ...PROFILE, logoPath });
    const inv1 = await finalizeInvoice(page);
    rmSync(join(A, "branding", logoPath));
    const inv2 = await finalizeInvoice(page);
    await stubFile(app, LOGO_TWO);
    const logoPath2 = (await ok(page, "pickInvoiceLogo", undefined)).logoPath;
    check(logoPath2 === logoPath, "the new shop logo is stored under the SAME name as the old one", { logoPath, logoPath2 });
    await ok(page, "saveCompanyProfile", { ...PROFILE, logoPath });
    const inv3 = await finalizeInvoice(page);
    const issuers = new Database(join(A, LEDGER_FILE), { readonly: true });
    const issuerOf = (id) => JSON.parse(issuers.prepare("SELECT issuer_snapshot_json AS j FROM invoices WHERE id = ?").get(id).j);
    check(issuerOf(inv1).logo_asset === FROZEN_ONE, "invoice 1 recorded logo ONE's content-addressed asset");
    check(issuerOf(inv2).logo_asset === null && issuerOf(inv2).logo_path === logoPath, "invoice 2 is legacy: a logo name, no archived asset");
    check(issuerOf(inv3).logo_asset === FROZEN_TWO, "invoice 3 recorded logo TWO's asset");
    issuers.close();

    // F · historical logos, measured on the documents the app produces.
    const pdfFlags = async (id, name) => {
      await stubSave(app, join(HOME, `${name}.pdf`));
      const r = await ok(page, "saveInvoicePdf", { invoiceId: id });
      return { missing: r.logoMissing === true, unverified: r.logoUnverified === true };
    };
    check(JSON.stringify(await pdfFlags(inv1, "inv1")) === JSON.stringify({ missing: false, unverified: false }), "F · invoice 1 prints its OWN frozen logo (ONE) after the shop changed to TWO");
    check(readFileSync(join(A, "branding", "frozen", FROZEN_ONE)).equals(readFileSync(LOGO_ONE)), "F · invoice 1's asset on disk is still logo ONE's bytes");
    check(
      JSON.stringify(await pdfFlags(inv2, "inv2")) === JSON.stringify({ missing: false, unverified: true }),
      "F · 🔴 the legacy invoice prints NO logo (unverified) although a live file with its exact name exists",
    );
    check(JSON.stringify(await pdfFlags(inv3, "inv3")) === JSON.stringify({ missing: false, unverified: false }), "F · invoice 3 prints logo TWO");

    // Money: a customer, three debts, a direct collection, a Whish receipt over two debts, sales.
    const customer = (await ok(page, "createCustomer", { displayName: "زبون اختبار النسخ", phone: null, address: null, note: null })).customer.id;
    const w = new Database(join(A, LEDGER_FILE));
    const op = w.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get().id;
    const ins = w.prepare(
      `INSERT INTO obligations (id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency, amount_minor, posted_by, posted_at, business_date)
       VALUES (?, ?, 'customer', 'receivable', 'manual', ?, NULL, 'USD', ?, ?, '2026-10-28T08:00:00.000Z', '2026-10-28')`,
    );
    for (const [id, minor] of [["o-A", 6000], ["o-B", 4000], ["o-C", 2500]]) ins.run(id, customer, `REF-${id}`, minor, op);
    w.close();
    await ok(page, "recordCustomerPayment", { customerId: customer, obligationId: "o-C", idempotencyKey: "e2e-pay-000001", amountMinor: "1000", method: "cash" });
    const receipt = { customerId: customer, idempotencyKey: "e2e-receipt-0001", channel: "whish", reference: "WH-E2E-1", fundsConfirmed: true, currency: "USD", totalMinor: "10000", allocations: [{ obligationId: "o-A", amountMinor: "6000" }, { obligationId: "o-B", amountMinor: "4000" }] };
    check((await ok(page, "recordAllocatedReceipt", receipt)).duplicate === false, "a Whish receipt is allocated over two debts");
    for (let i = 1; i <= 3; i++) await ok(page, "createSale", sale(`e2e-a-sale-000${i}`));
    fact("receiptRequest", receipt);

    // B · full backup through the REAL screen, into a path with spaces and Arabic.
    await page.locator('[data-testid="tab-tools"]').click();
    await stubFolder(app, USB);
    await testid(page, "full-backup-create").click();
    await testid(page, "full-backup-result").waitFor({ timeout: 60000 });
    check((await testid(page, "full-backup-complete").count()) === 1, "B · the screen says the full backup is complete");
    await shot(page, "P4-B1-full-backup-complete");
    const folder = (await testid(page, "full-backup-folder").innerText()).trim();
    pkgComplete = join(USB, folder);
    check(existsSync(join(pkgComplete, "manifest.json")), "B · the package folder exists on the 'USB' path", { pkgComplete });

    const m = JSON.parse(readFileSync(join(pkgComplete, "manifest.json"), "utf8"));
    for (const f of m.files) {
      const abs = join(pkgComplete, ...f.path.split("/"));
      check(statSync(abs).size === f.size && shaFile(abs) === f.sha256, `B · ${f.path}: size and SHA-256 match the manifest`);
    }
    check(m.complete === undefined && m.missingAssets.length === 0, "B · no missing assets, and completeness is not a stored claim");
    check(m.files.some((f) => f.path === `branding/frozen/${FROZEN_ONE}`) && m.files.some((f) => f.path === `branding/frozen/${FROZEN_TWO}`), "B · both frozen logos are in the package");
    check(readFileSync(join(pkgComplete, "branding", "live", logoPath)).equals(readFileSync(LOGO_TWO)), "B · the shop's CURRENT logo (TWO) is in the package");
    check(m.settings === "included", "B · settings are included");
    const pdb = new Database(join(pkgComplete, "ledger.sqlite"), { readonly: true });
    check(pdb.pragma("integrity_check", { simple: true }) === "ok", "B · the packaged ledger passes integrity_check");
    check(pdb.pragma("foreign_key_check").length === 0, "B · and foreign_key_check");
    check(count(pdb, "receipts") === 1 && count(pdb, "settlements", "receipt_id IS NOT NULL") === 2, "B · the receipt and its two allocations are in it");
    check(Object.entries(m.tableCounts).every(([t, n]) => count(pdb, `"${t}"`) === n), "B · every table count in the manifest matches the packaged ledger");
    pdb.close();
    check(pkgLib.verifyBackupPackage(pkgComplete).complete === true, "B · the shipped verifier accepts the package as complete");

    // The OLD database-only export is unchanged: one .sqlite file where the owner chose.
    await stubSave(app, join(USB, "legacy export.sqlite"));
    const legacy = await ok(page, "exportBackup", undefined);
    check(legacy.status === "saved" && legacy.fileName === "legacy export.sqlite", "B · the old exportBackup still saves one database file", legacy);
    check(readFileSync(join(USB, "legacy export.sqlite")).subarray(0, 15).toString() === "SQLite format 3", "B · and it is a plain SQLite file, not a package");

    // An INCOMPLETE backup because a real archived logo is gone from the disk.
    rmSync(join(A, "branding", "frozen", FROZEN_ONE));
    await sleep(1100); // a package folder is named by the second; never overwrite the last one
    await testid(page, "full-backup-create").click();
    await testid(page, "full-backup-incomplete").waitFor({ timeout: 60000 });
    check((await testid(page, "full-backup-missing").locator("li").count()) === 1, "B · the screen lists the ONE missing file");
    await shot(page, "P4-B2-full-backup-incomplete");
    pkgIncomplete = join(USB, (await testid(page, "full-backup-folder").innerText()).trim());
    const mi = JSON.parse(readFileSync(join(pkgIncomplete, "manifest.json"), "utf8"));
    check(JSON.stringify(mi.missingAssets) === JSON.stringify([{ kind: "frozen-logo", name: FROZEN_ONE, reason: "absent-at-source" }]), "B · the incomplete package names the missing frozen logo");
    check(pkgLib.verifyBackupPackage(pkgIncomplete).complete === false, "B · and the verifier reports it incomplete");

    // A · a cashier is refused on all three channels, and no picker ever opens.
    await page.locator('[data-testid="logout"]').click();
    await signIn(page, "Cashier Two", "2222");
    const pickersBefore = await pickerCalls(app);
    check(errCode(await pos(page, "exportFullBackup", undefined)) === "NOT_AUTHORIZED", "A · cashier: exportFullBackup refused");
    check(errCode(await pos(page, "inspectRestoreBackup", undefined)) === "NOT_AUTHORIZED", "A · cashier: inspectRestoreBackup refused");
    check(errCode(await pos(page, "applyRestore", { manifestSha256: "0".repeat(64), acceptMissingAssets: false })) === "NOT_AUTHORIZED", "A · cashier: applyRestore refused");
    check((await pickerCalls(app)) === pickersBefore, "A · no folder picker was opened for the cashier");
    await page.locator('[data-testid="tab-tools"]').click();
    check((await testid(page, "full-backup-section").count()) === 0 && (await testid(page, "restore-section").count()) === 0, "A · the cashier's Tools screen has no backup/restore section");
    await app.close();
  }

  const packageLedger = new Database(join(pkgComplete, "ledger.sqlite"), { readonly: true });
  const expectedMoney = moneyRows(packageLedger);
  const expectedSales = count(packageLedger, "sales");
  packageLedger.close();
  fact("packageSales", expectedSales);

  // ── C · preview and consent (screen), then D · a REAL relaunch on the installed app ─────────────
  const B = profile("بيانات المحل ب");
  {
    const { app, page } = await asOwner(await launch(B));
    await ok(page, "createSale", sale("e2e-b-sale-0001"));
    await page.locator('[data-testid="tab-tools"]').click();

    // Choosing a folder previews; it stages nothing.
    await stubFolder(app, pkgComplete);
    await testid(page, "restore-choose").click();
    await testid(page, "restore-preview").waitFor({ timeout: 60000 });
    await shot(page, "P4-C1-restore-preview");
    check((await testid(page, "restore-count-sales").innerText()).trim() === String(expectedSales), "C · the preview shows the backup's sales count", { expectedSales });
    check((await testid(page, "restore-complete").count()) === 1, "C · the preview says the backup is complete");
    check(!journalExists(B), "C · 🔴 previewing staged NOTHING (no journal)");
    check(await testid(page, "restore-apply").isDisabled(), "C · restore is disabled until the owner confirms");
    await testid(page, "restore-confirm").check();
    check(!(await testid(page, "restore-apply").isDisabled()), "C · confirming enables it");
    await testid(page, "restore-cancel").click();
    check(!journalExists(B), "C · cancelling stages nothing");

    // The package changes between preview and confirmation → refused, nothing staged.
    const swap = join(ROOT, "نسخة مبدلة");
    cpSync(pkgComplete, swap, { recursive: true });
    await stubFolder(app, swap);
    await testid(page, "restore-choose").click();
    await testid(page, "restore-preview").waitFor();
    rmSync(swap, { recursive: true });
    cpSync(pkgIncomplete, swap, { recursive: true });
    await testid(page, "restore-confirm").check();
    await testid(page, "restore-apply").click();
    await testid(page, "restore-refused").waitFor({ timeout: 30000 });
    check((await testid(page, "restore-refused").innerText()).includes("تغيّرت النسخة بعد معاينتها"), "C · 🔴 a package replaced after preview is refused as CHANGED");
    check(!journalExists(B), "C · and nothing was staged");
    await shot(page, "P4-C2-restore-changed-refused");

    // An incomplete backup needs the second, explicit acceptance.
    await stubFolder(app, pkgIncomplete);
    await testid(page, "restore-choose").click();
    await testid(page, "restore-incomplete").waitFor();
    check((await testid(page, "restore-missing").locator("li").count()) === 1, "C · the incomplete preview lists its missing file");
    await testid(page, "restore-confirm").check();
    check(await testid(page, "restore-apply").isDisabled(), "C · 🔴 the main confirmation alone does NOT enable an incomplete restore");
    await testid(page, "restore-accept-missing").check();
    check(!(await testid(page, "restore-apply").isDisabled()), "C · accepting the missing files enables it");
    await shot(page, "P4-C3-restore-incomplete-consent");
    await testid(page, "restore-cancel").click();
    check(!journalExists(B), "C · still nothing staged");

    // D · the real thing: confirm, the app restarts ITSELF, the new process restores before it opens.
    await stubFolder(app, pkgComplete);
    await testid(page, "restore-choose").click();
    await testid(page, "restore-preview").waitFor();
    await testid(page, "restore-confirm").check();
    const oldPid = await app.evaluate(() => process.pid);
    const t0 = Date.now();
    const closed = app.waitForEvent("close", { timeout: 60000 });
    await testid(page, "restore-apply").click();
    await testid(page, "restore-staged").waitFor({ timeout: 10000 });
    await shot(page, "P4-D1-restore-staged");
    await closed;
    check(true, "D · the app closed itself after staging");
    const newPid = await until(
      "the relaunched process to show its window",
      () => diagEvents().find((e) => e.t >= t0 && e.pid !== oldPid && e.event === "window-ready")?.pid,
      90000,
    );
    fact("relaunch", { oldPid, newPid });
    check(newPid !== oldPid, "D · 🔴 a NEW process was started by app.relaunch() — not by this test", { oldPid, newPid });
    check(appLog(B).includes('"event":"restore-applied"'), "D · the relaunched process applied the restore");
    check(lastRestore(B).outcome === "restored", "D · last-restore.json says restored");
    const logLines = appLog(B).split("\n");
    const applied = logLines.findIndex((l) => l.includes('"event":"restore-applied"'));
    const opened = logLines.findIndex((l, i) => i > applied && l.includes('"event":"db-open"'));
    check(applied >= 0 && opened > applied, "D · 🔴 the restore ran BEFORE the ledger was opened in that process");
    await sleep(2500);
    if (WINDOWS) {
      const titles = windowTitlesOf(newPid);
      fact("relaunchWindowTitles", titles);
      desktopShot("P4-D2-after-relaunch-notice");
      check(titles.includes("تمّت استعادة النسخة الاحتياطيّة"), "D · the owner is shown the 'restored' notice", { titles });
    } else {
      skip("D · native notice window (enumerating windows is Windows-only)");
    }
    killTree(newPid);
    await until("the relaunched process to end", () => !alive(newPid), 30000);
  }
  {
    // The restored money, read from the real profile.
    const live = readLedger(B, LEDGER_FILE, (db) => ({ money: moneyRows(db), integrity: db.pragma("integrity_check", { simple: true }), fk: db.pragma("foreign_key_check").length }));
    check(live.integrity === "ok" && live.fk === 0, "D · the restored ledger passes integrity and foreign-key checks");
    check(JSON.stringify(live.money) === JSON.stringify(expectedMoney), "D · 🔴 sales, invoices, debts, payments, receipts and allocations equal the backup exactly");
    const kept = readdirSync(join(B, "restore")).find((n) => n.startsWith("pre-restore-"));
    check(Boolean(kept), "D · the pre-restore copy is kept", { kept });
    const oldSales = readLedger(join(B, "restore", kept), LEDGER_FILE, (db) => ({ sales: count(db, "sales"), integrity: db.pragma("integrity_check", { simple: true }) }));
    check(oldSales.integrity === "ok" && oldSales.sales === 1, "D · and it opens: shop B's own ledger with its one sale", oldSales);

    // The same receipt key on the restored till is a duplicate — no second receipt.
    const { app, page } = await asOwner(await launch(B));
    const again = await ok(page, "recordAllocatedReceipt", evidence.facts.receiptRequest);
    check(again.duplicate === true, "D · 🔴 replaying the receipt's idempotency key is a DUPLICATE");
    await app.close();
    const after = readLedger(B, LEDGER_FILE, (db) => ({ receipts: count(db, "receipts"), allocations: count(db, "settlements", "receipt_id IS NOT NULL") }));
    check(after.receipts === 1 && after.allocations === 2, "D · still one receipt and two allocations", after);
  }

  // ── G · the lock after staging: in-flight burst, failed restart, phone surface, next start ──────
  const C = profile("بيانات المحل ج");
  {
    const { app, page } = await asOwner(await launch(C));
    for (let i = 1; i <= 2; i++) await ok(page, "createSale", sale(`e2e-c-base-000${i}`));
    let phone = null;
    try {
      phone = await ok(page, "startPhoneSession", { action: "NEW_PRODUCT" });
    } catch (e) {
      fact("phoneSessionUnavailable", String(e));
    }
    if (phone) check(await tcpOpen(phone.host, phone.port), "G · before staging the phone surface accepts connections", { host: phone.host, port: phone.port });
    else skip("G · phone surface (no LAN address on this runner)");

    // The restart FAILS: relaunch and quit do nothing (replaced from Playwright, originals kept).
    await app.evaluate(({ app: a }) => {
      globalThis.__relaunches = 0;
      globalThis.__quit = a.quit.bind(a);
      a.relaunch = () => {
        globalThis.__relaunches += 1;
      };
      a.quit = () => undefined;
    });
    await stubFolder(app, pkgComplete);
    const preview = await ok(page, "inspectRestoreBackup", undefined);
    check(preview.status === "ready", "G · preview ready");

    // 🔴 THE IN-FLIGHT BURST: 10 sales sent, the confirmation, 10 more sales — all in flight at
    // once over the real bridge. Whatever the order main processes them in, no write may be
    // ACCEPTED after the restore was staged.
    const burst = await page.evaluate(async (hash) => {
      const mk = (k) => ({ idempotencyKey: k, lines: [{ productId: "prod-0003", quantityMilli: 1000 }], paymentMethod: "cash", expectedTotalMinor: "199" });
      const before = Array.from({ length: 10 }, (_, i) => window.pos.createSale(mk(`e2e-c-pre-${String(i).padStart(4, "0")}`)));
      const apply = window.pos.applyRestore({ manifestSha256: hash, acceptMissingAssets: false });
      const after = Array.from({ length: 10 }, (_, i) => window.pos.createSale(mk(`e2e-c-post-${String(i).padStart(4, "0")}`)));
      return { before: await Promise.all(before), apply: await apply, after: await Promise.all(after) };
    }, preview.preview.manifestSha256);
    fact("inFlightBurst", { before: burst.before.map(errCode), apply: burst.apply, after: burst.after.map(errCode) });
    check(burst.apply.ok && burst.apply.data.status === "staged", "G · the restore was staged in the middle of the burst");
    const accepted = [...burst.before, ...burst.after].filter((r) => r.ok).map((r) => r.data.sale.idempotencyKey ?? r.data.sale.id);
    const refused = [...burst.before, ...burst.after].filter((r) => !r.ok);
    check(refused.every((r) => r.error.code === "NOT_AVAILABLE"), "G · every refused sale was refused BY THE LOCK (no other error)");
    check(burst.after.every((r) => !r.ok), "G · 🔴 every sale sent AFTER the confirmation was refused");
    const liveC = readLedger(C, LEDGER_FILE, (db) => ({ sales: count(db, "sales"), keys: db.prepare("SELECT idempotency_key AS k FROM sales").all().map((r) => r.k) }));
    check(liveC.sales === 2 + accepted.length, "G · 🔴 the ledger holds exactly the base sales plus the ACCEPTED ones — no write slipped in unaccounted", { liveSales: liveC.sales, accepted: accepted.length });
    check(liveC.keys.every((k) => !k.startsWith("e2e-c-post-")), "G · no sale sent after the confirmation reached the ledger");
    fact("acceptedBeforeLock", accepted.length);

    // The restart did not happen; the lock holds anyway.
    await sleep(3000);
    check((await app.evaluate(() => globalThis.__relaunches)) === 1, "G · the restart was asked for exactly once");
    check(errCode(await pos(page, "createSale", sale("e2e-c-late-0001"))) === "NOT_AVAILABLE", "G · 🔴 with the restart FAILED, a sale is still refused");
    check(errCode(await pos(page, "recordCustomerPayment", { customerId: "x", obligationId: "y", idempotencyKey: "e2e-pay-000099", amountMinor: "1", method: "cash" })) === "NOT_AVAILABLE", "G · a collection is refused");
    check(errCode(await pos(page, "recordAllocatedReceipt", evidence.facts.receiptRequest)) === "NOT_AVAILABLE", "G · a shared receipt is refused");
    check(errCode(await pos(page, "inspectRestoreBackup", undefined)) === "NOT_AVAILABLE", "G · a second restore cannot begin");
    check((await pos(page, "getSettings", undefined)).ok, "G · the screen's own reads still answer");
    if (phone) check(!(await tcpOpen(phone.host, phone.port)), "G · 🔴 the phone surface was CLOSED by staging (no connection accepted)");
    check(journalExists(C), "G · the restore is still staged on disk");

    // The owner closes the program by hand; the next start restores before anything opens.
    await app.evaluate(() => {
      globalThis.__quit();
    }).catch(() => undefined);
    await sleep(1000);
  }
  {
    const { app, page } = await launch(C);
    const pid = await app.evaluate(() => process.pid);
    await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 60000 });
    check(lastRestore(C).outcome === "restored", "G · 🔴 after a FAILED restart, the next start completed the restore");
    if (WINDOWS) {
      await sleep(1500);
      const titles = windowTitlesOf(pid);
      desktopShot("P4-G1-next-start-notice");
      check(titles.includes("تمّت استعادة النسخة الاحتياطيّة"), "G · and showed the 'restored' notice", { titles });
    }
    await app.close();
    const restored = readLedger(C, LEDGER_FILE, (db) => count(db, "sales"));
    check(restored === expectedSales, "G · the till now holds the backup's sales");
    const kept = readdirSync(join(C, "restore")).find((n) => n.startsWith("pre-restore-"));
    const keptSales = readLedger(join(C, "restore", kept), LEDGER_FILE, (db) => count(db, "sales"));
    check(keptSales === 2 + evidence.facts.acceptedBeforeLock, "G · 🔴 every sale ACCEPTED before the lock is preserved in the pre-restore copy — nothing vanished");
  }

  // ── E · a SIMULATED interruption in the middle of the engine, then the installed app resumes ────
  async function preparedProfile(name, sales) {
    const dir = profile(name);
    const { app, page } = await asOwner(await launch(dir));
    await ok(page, "setTerminalLanguage", { language: "ar" }); // writes settings.json
    for (let i = 1; i <= sales; i++) await ok(page, "createSale", sale(`e2e-${name.length}-sale-000${i}`));
    await app.close();
    return dir;
  }
  {
    // Count the operations of a clean apply on a throwaway copy, then die half way on the real one.
    const D = await preparedProfile("بيانات المحل د", 1);
    const probe = join(ROOT, "probe copy", "userData");
    cpSync(D, probe, { recursive: true });
    stageWithEngine(probe, pkgComplete);
    const counter = dyingFs(Number.MAX_SAFE_INTEGER);
    check(engine.applyPendingRestore({ userDataDir: probe, now: new Date(), fs: counter.fs }).kind === "restored", "E · probe: a clean apply restores");
    const k = Math.max(2, Math.floor(counter.ops() / 2));
    fact("interruption", { totalOps: counter.ops(), diesAt: k });

    stageWithEngine(D, pkgComplete);
    const dying = dyingFs(k);
    check(engine.applyPendingRestore({ userDataDir: D, now: new Date(), fs: dying.fs }).kind === "halted", `E · SIMULATED process death at operation ${k} of ${counter.ops()} leaves the restore undecided`);
    const state = JSON.parse(readFileSync(join(D, "restore", "journal.json"), "utf8")).state;
    fact("interruptedState", state);
    check(["preserving", "installing"].includes(state), "E · the interruption really fell in the middle (journal past 'staged')", { state });

    const { app, page } = await launch(D);
    await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 60000 });
    await app.close();
    check(lastRestore(D).outcome === "restored", "E · 🔴 the installed app resumed the interrupted restore at start and finished it");
    const money = readLedger(D, LEDGER_FILE, (db) => moneyRows(db));
    check(JSON.stringify(money) === JSON.stringify(expectedMoney), "E · the resumed ledger equals the backup exactly — not a mixture");
  }

  // ── E · halted: a damaged journal keeps the till shut ───────────────────────────────────────────
  {
    const H = await preparedProfile("بيانات المحل هـ", 1);
    stageWithEngine(H, pkgComplete);
    writeFileSync(join(H, "restore", "journal.json"), "{ half a journal");
    const ledgerSha = shaFile(join(H, LEDGER_FILE));
    // The log is cumulative per profile, and the profile was prepared by a NORMAL start: only what
    // THIS start writes counts.
    const logStart = appLog(H).length;
    const thisStart = () => appLog(H).slice(logStart);
    const child = spawn(ELECTRON, [...EXTRA_ARGS, ...APP_ARGS], { env: envFor(H), stdio: "ignore" });
    const line = await until(
      "the startup failure to be logged",
      () => thisStart().split("\n").find((l) => l.includes('"event":"startup-failure"')),
      60000,
    );
    let title = null;
    if (WINDOWS) {
      title = await until("the error box", () => windowTitlesOf(child.pid).find((t) => t === "Alzabt POS — cannot start"), 20000).catch(() => null);
      desktopShot("P4-E2-halted-error-box");
    }
    killTree(child.pid);
    check(JSON.parse(line).code === "RESTORE_INCOMPLETE", "E · 🔴 a damaged journal stops startup as RESTORE_INCOMPLETE");
    check(!thisStart().includes('"event":"catalog"'), "E · the till never started");
    check(!thisStart().includes('"event":"db-open"'), "E · no ledger was opened");
    check(shaFile(join(H, LEDGER_FILE)) === ledgerSha, "E · the ledger file is byte-for-byte unchanged");
    if (WINDOWS) check(title === "Alzabt POS — cannot start", "E · the operator sees the error box");
  }

  // ── E · a REAL Windows file lock during the restore → rolled back to the exact original ─────────
  if (WINDOWS) {
    const L = await preparedProfile("بيانات المحل و", 2);
    stageWithEngine(L, pkgComplete);
    const before = shaFile(join(L, LEDGER_FILE));
    const settings = join(L, "settings.json");
    check(existsSync(settings), "E · the profile has a settings.json to lock");
    const ready = join(HOME, "lock-held.txt");
    // Another process opens settings.json WITHOUT FILE_SHARE_DELETE: Windows refuses to rename it.
    const holder = spawn(
      "powershell",
      ["-NoProfile", "-Command", `$f=[IO.File]::Open('${settings.replace(/'/g, "''")}','Open','Read','Read'); Set-Content -Path '${ready.replace(/'/g, "''")}' -Value held; Start-Sleep -Seconds 90; $f.Close()`],
      { stdio: "ignore" },
    );
    await until("the lock to be held", () => existsSync(ready), 30000);
    const { app, page } = await launch(L);
    await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 60000 });
    const outcome = lastRestore(L);
    fact("fileLockOutcome", outcome);
    await app.close();
    killTree(holder.pid);
    check(outcome.outcome === "rolled-back", "E · 🔴 a real Windows lock on settings.json made the restore ROLL BACK", outcome);
    check(!journalExists(L), "E · the journal is closed");
    check(shaFile(join(L, LEDGER_FILE)) === before, "E · the original ledger is back byte-for-byte");
    check(readLedger(L, LEDGER_FILE, (db) => count(db, "sales")) === 2, "E · and it opens with its own two sales");
  } else {
    skip("E · real Windows file lock (Windows only: other platforms do not refuse a rename of an open file)");
  }

  evidence.result = "PASS";
  evidence.passed = passed;
  persist();
  log(`ALL BACKUP/RESTORE CHECKS PASSED (${passed})`);
} catch (e) {
  evidence.result = "FAIL";
  evidence.error = String(e?.stack ?? e);
  evidence.passed = passed;
  persist();
  console.error(e);
  process.exitCode = 1;
}
