/**
 * Track 2 phase 3 — full backup and restore through the REAL IPC handlers, the real channel policy
 * and the real backup/restore actions, on temp folders whose names carry spaces and Arabic.
 *
 * Only the native folder picker and the restart are replaced (they are Electron), each by a
 * function that records being called — so "no picker opened for a cashier" and "restarted exactly
 * once, and only after staging" are assertions, not assumptions. The restart itself is simulated
 * by closing the ledger and running the startup half (restoreStartup.ts), exactly as main.ts does.
 */
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BackupFs, nodeBackupFs } from "../../src/persistence/backupPackage";
import { InvoiceService, type LogoVault } from "../../src/application/invoiceService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { createBackupRestoreActions } from "../../src/main/backupRestore";
import { CHANNEL_NAMES, RESTORE_LOCK_READS, createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { RestoreLock } from "../../src/main/restoreLock";
import { planLedgerOpen } from "../../src/main/ledgerGuard";
import { nullLogger } from "../../src/main/logger";
import { runPendingRestore } from "../../src/main/restoreStartup";
import { verifyBackupPackage } from "../../src/persistence/backupPackage";
import { openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { LIVE_LEDGER_FILE } from "../../src/persistence/restoreEngine";
import type {
  ApplyRestoreResponse,
  FullBackupExportResponse,
  InspectRestoreResponse,
} from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

const NOW = new Date("2026-10-28T11:00:00.000Z");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let t: TempDir;
let tick = 0;

// ── A shop, its profile folder, its pickers ───────────────────────────────────────────────────

interface Shop {
  readonly userData: string;
  h: Harness;
  readonly picked: { "export-backup": string | null; "restore-backup": string | null };
  readonly calls: { pickers: number; relaunches: number };
  ipc: ReturnType<typeof syncHandlers>;
  /** The raw handlers, for channels that answer asynchronously. */
  raw: ReturnType<typeof createIpcHandlers>;
  migrations: typeof MIGRATIONS;
  lock: RestoreLock;
  relaunchThrows: boolean;
}

function shop(name: string): Shop {
  const userData = join(t.dir, name);
  mkdirSync(userData, { recursive: true });
  const s: Shop = {
    userData,
    h: makeHarness(join(userData, LIVE_LEDGER_FILE)),
    picked: { "export-backup": null, "restore-backup": null },
    calls: { pickers: 0, relaunches: 0 },
    ipc: undefined as never,
    raw: undefined as never,
    migrations: MIGRATIONS,
    lock: undefined as never,
    relaunchThrows: false,
  };
  wire(s);
  return s;
}

/** The handlers main.ts registers, with only the picker and the restart replaced. */
function wire(s: Shop): void {
  // Exactly as main.ts builds it: engaged on staging, and by a journal on disk.
  s.lock = new RestoreLock(() => existsSync(join(s.userData, "restore", "journal.json")));
  const actions = createBackupRestoreActions({
    userDataDir: s.userData,
    ledger: () => s.h.db,
    appVersion: "0.1.1",
    // One second per call: two exports in the same second would (correctly) be refused as
    // DESTINATION_EXISTS, since a package folder is named after its time and never overwritten.
    now: () => new Date(NOW.getTime() + 1000 * tick++),
    chooseFolder: (purpose) => {
      s.calls.pickers++;
      return s.picked[purpose];
    },
    relaunch: () => {
      s.calls.relaunches++;
      if (s.relaunchThrows) throw new Error("relaunch refused by the OS");
    },
    lock: s.lock,
    log: nullLogger,
    migrations: s.migrations,
  });
  s.raw = createIpcHandlers(s.h.service, {
    backupRestore: actions,
    restoreLock: s.lock,
    invoices: s.h.invoices,
    parties: s.h.parties,
    ledger: s.h.ledger,
  });
  s.ipc = syncHandlers(s.raw);
}

function seed(s: Shop): void {
  const vault: LogoVault = {
    freeze(storedName) {
      const bytes = readFileSync(join(s.userData, "branding", storedName));
      const name = `${sha(bytes).slice(0, 32)}.png`;
      mkdirSync(join(s.userData, "branding", "frozen"), { recursive: true });
      writeFileSync(join(s.userData, "branding", "frozen", name), bytes);
      return name;
    },
  };
  mkdirSync(join(s.userData, "branding"), { recursive: true });
  writeFileSync(join(s.userData, "branding", "invoice-logo.png"), "SHOP A LOGO");
  writeFileSync(join(s.userData, "settings.json"), JSON.stringify({ terminalLanguage: "ar" }));
  for (let i = 0; i < 3; i++) {
    s.h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
  }
  s.h.invoices.saveCompanyProfile({ nameAr: "متجر أ", logoPath: "invoice-logo.png" });
  const svc = new InvoiceService({
    invoices: new InvoiceRepository(s.h.db),
    reconciliation: new ReconciliationRepository(s.h.db),
    company: s.h.companyStore,
    catalogStore: new CatalogRepository(s.h.db),
    products: s.h.service,
    sales: new SaleRepository(s.h.db),
    logoVault: vault,
    transact: (fn) => s.h.db.transaction(fn).immediate(),
    terminal: FIXTURE_TERMINAL,
    now: s.h.clock.now,
  });
  const { invoice } = svc.createDraft();
  svc.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", quantity: "1", unitPrice: "10.00", productId: null });
  svc.finalizeInvoice(invoice.id);
  const c = s.h.parties.create({ kind: "customer", displayName: "محمد علي" }).party;
  const owe = (ref: string, minor: bigint) =>
    s.h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
  const a = owe("A", 6000n);
  const b = owe("B", 4000n);
  s.h.ledger.recordAllocatedReceipt(receiptReq(c.id, a.id, b.id));
}

function receiptReq(customerId: string, a: string, b: string) {
  return {
    customerId,
    idempotencyKey: "receipt-key-0001",
    channel: "whish",
    reference: "WH-123",
    fundsConfirmed: true,
    currency: "USD",
    totalMinor: 10000n,
    allocations: [
      { obligationId: a, amountMinor: 6000n },
      { obligationId: b, amountMinor: 4000n },
    ],
  };
}

const data = <T>(r: unknown): T => {
  const res = r as { ok: boolean; data?: T; error?: unknown };
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res.error)}`);
  return res.data as T;
};
const code = (r: unknown) => ((r as { ok: boolean; error?: { code: string } }).ok ? null : (r as { error: { code: string } }).error.code);

/** Exports shop `s` to a USB-like folder and returns the package folder. */
function exportPackage(s: Shop): string {
  const usb = join(t.dir, "ذاكرة USB", "نسخ احتياطية");
  mkdirSync(usb, { recursive: true });
  s.picked["export-backup"] = usb;
  const r = data<FullBackupExportResponse>(s.ipc.exportFullBackup(undefined));
  if (r.status !== "saved") throw new Error(`export failed: ${JSON.stringify(r)}`);
  return join(r.location, r.folderName);
}

const MONEY = ["sales", "sale_lines", "invoices", "invoice_lines", "parties", "obligations", "settlements", "receipts", "receipt_attempts", "receipt_attempt_lines"];

/** The ledger file and whichever of its companions exist RIGHT NOW. */
const ledgerFiles = (path: string) => ["", "-wal", "-shm", "-journal"].map((s) => `${path}${s}`).filter((f) => existsSync(f));
const fingerprintOf = (path: string) => ledgerFiles(path).map((f) => [basename(f), createHash("sha256").update(readFileSync(f)).digest("hex")]);

/**
 * Reads a ledger through an ISOLATED COPY — never by opening the original.
 *
 * 🔴 WHY (Windows run 40733299552). This file's worker died natively (0xC0000409) inside the test
 * that opened a WAL-mode ledger with `readonly: true` and no `-shm` beside it — twice. That is a
 * HYPOTHESIS for the crash, not a proven cause, and this helper does not depend on it being right:
 * it is simply the reading pattern the installed E2E already uses (`readLedger`).
 *
 *   - the ledger is copied WITH whichever `-wal` / `-shm` / `-journal` exist, so transactions not
 *     yet checkpointed into the main file are read, not silently dropped;
 *   - the copy is opened WRITABLE, so SQLite can read (and, if needed, recover) the WAL — on the
 *     copy; nothing is checkpointed or written on the original;
 *   - the original files are hashed before and after, and the read FAILS if any of them changed.
 */
function withLedgerCopy<T>(path: string, fn: (db: Database.Database) => T): T {
  const before = fingerprintOf(path);
  expect(before.length, `${path} does not exist`).toBeGreaterThan(0);
  const scratch = mkdtempSync(join(t.dir, "read-"));
  for (const f of ledgerFiles(path)) copyFileSync(f, join(scratch, basename(f)));
  const db = new Database(join(scratch, basename(path)), { fileMustExist: true });
  db.defaultSafeIntegers(true);
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
    expect(fingerprintOf(path), "reading must not modify the original ledger").toEqual(before);
  }
}

function rows(path: string) {
  return withLedgerCopy(path, (db) => {
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    return Object.fromEntries(MONEY.map((tb) => [tb, db.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all()]));
  });
}

const journal = (s: Shop) => existsSync(join(s.userData, "restore", "journal.json"));
const realLedgerFs = { exists: existsSync, writeAtomic: (p: string, c: string) => writeFileSync(p, c) };

// ── TEMPORARY DIAGNOSTICS (Windows runs 40733299552 / 40737989211: native 0xC0000409) ─────────
//
// When BR_MARKERS names a file, each marker is appended, fsync'd and closed before the next
// statement runs — so the LAST line written is the last step that completed even if the worker
// dies natively before stdout is flushed. Labels only: no paths, no data. Off when unset, and it
// changes nothing the test does.
const MARKERS = process.env.BR_MARKERS;
let markSeq = 0;
function mark(label: string): void {
  if (!MARKERS) return;
  const fd = openSync(MARKERS, "a");
  try {
    writeSync(fd, `${String(++markSeq).padStart(4, "0")} ${new Date().toISOString()} pid=${process.pid} ${label}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** The engine's own file port, passed through unchanged, marking each operation by file NAME only. */
function markedFs(): BackupFs | undefined {
  if (!MARKERS) return undefined;
  const fs: Record<string, unknown> = {};
  for (const [k, fn] of Object.entries(nodeBackupFs)) {
    fs[k] = (...args: string[]) => {
      // File NAMES only. writeFile's second argument is the data written — never logged.
      const names = (k === "writeFile" ? args.slice(0, 1) : args).map((a) => basename(String(a))).join(" -> ");
      mark(`  fs.${k} ${names} BEGIN`);
      const r = (fn as (...a: string[]) => unknown)(...args);
      mark(`  fs.${k} ${names} END`);
      return r;
    };
  }
  return fs as unknown as BackupFs;
}

const opened: Shop[] = [];
beforeEach(() => {
  mark(`TEST BEGIN ${expect.getState().currentTestName ?? "?"}`);
  t = tempDir();
});
afterEach(() => {
  mark("afterEach BEGIN");
  for (const s of opened.splice(0)) {
    try {
      mark("afterEach close a shop's ledger");
      s.h.db.close();
    } catch {
      // already closed by a simulated restart
    }
  }
  mark("afterEach temp cleanup");
  t.cleanup();
  mark("afterEach END");
});
const open = (name: string) => {
  const s = shop(name);
  opened.push(s);
  return s;
};

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe("full backup — owner, through the real channel", () => {
  it("writes a complete, verifiable package into the chosen folder (Arabic and spaces in every path)", () => {
    const a = open("بيانات المحل أ");
    seed(a);
    const dir = exportPackage(a);
    expect(dir).toContain("ذاكرة USB");
    const verified = verifyBackupPackage(dir);
    expect(verified.complete).toBe(true);
    expect(verified.manifest.tableCounts.receipts).toBe(1);
    const r = data<FullBackupExportResponse>(a.ipc.exportFullBackup(undefined));
    expect(r).toMatchObject({ status: "saved", complete: true, missingAssets: [], settings: "included" });
  });

  it("the owner cancelling the picker writes nothing and is not an error", () => {
    const a = open("shop a");
    a.picked["export-backup"] = null;
    expect(data(a.ipc.exportFullBackup(undefined))).toEqual({ status: "cancelled" });
  });

  it("a folder inside the program's own data folder is refused, and nothing is written there", () => {
    const a = open("shop a");
    a.picked["export-backup"] = a.userData;
    expect(data(a.ipc.exportFullBackup(undefined))).toEqual({ status: "failed", reason: "IN_APP_FOLDER" });
    expect(readdirSync(a.userData).some((n) => n.startsWith("alzabt-pos-fullbackup-"))).toBe(false);
  });
});

describe("🔴 a cashier is refused on all three channels — before any picker opens", () => {
  it("exportFullBackup, inspectRestoreBackup and applyRestore answer NOT_AUTHORIZED", () => {
    const a = open("shop a");
    seed(a);
    a.picked["export-backup"] = join(t.dir, "usb");
    a.picked["restore-backup"] = join(t.dir, "usb");
    a.ipc.login({ cashierId: "cashier-02", pin: "2222" });
    expect(code(a.ipc.exportFullBackup(undefined))).toBe("NOT_AUTHORIZED");
    expect(code(a.ipc.inspectRestoreBackup(undefined))).toBe("NOT_AUTHORIZED");
    expect(code(a.ipc.applyRestore({ manifestSha256: "0".repeat(64), acceptMissingAssets: false }))).toBe("NOT_AUTHORIZED");
    expect(a.calls.pickers).toBe(0);
    expect(a.calls.relaunches).toBe(0);
    expect(existsSync(join(t.dir, "usb"))).toBe(false);
  });

  it("the second lock: PosService.assertOwner refuses a cashier on its own", () => {
    const a = open("shop a");
    a.ipc.login({ cashierId: "cashier-02", pin: "2222" });
    expect(() => a.h.service.assertOwner()).toThrow(/Only the shop owner/);
  });

  it("a malformed applyRestore payload is refused before anything is looked at", () => {
    const a = open("shop a");
    expect(code(a.ipc.applyRestore({ manifestSha256: "0".repeat(64), acceptMissingAssets: false, packageDir: "/tmp" }))).toBe("INVALID_INPUT");
    expect(code(a.ipc.applyRestore({ manifestSha256: "not-a-hash", acceptMissingAssets: false }))).toBe("INVALID_INPUT");
    expect(code(a.ipc.applyRestore({ manifestSha256: "0".repeat(64), acceptMissingAssets: "yes" }))).toBe("INVALID_INPUT");
    expect(a.calls.relaunches).toBe(0);
  });
});

describe("🔴 restore — preview, consent, stage, restart, open", () => {
  it("previewing stages NOTHING; confirming stages and restarts once; the next start restores; the ledger opens with the backup's money", () => {
    mark("T7 01 open shop A (live harness, first connection)");
    const a = open("بيانات المحل أ");
    mark("T7 02 seed shop A");
    seed(a);
    mark("T7 03 export package from A");
    const pkg = exportPackage(a);
    mark("T7 04 read package ledger rows (copy)");
    const aLedger = rows(join(pkg, "ledger.sqlite"));

    mark("T7 05 open shop B (live harness)");
    const b = open("بيانات المحل ب");
    mark("T7 06 B createSale");
    b.h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
    writeFileSync(join(b.userData, "ledger.json"), JSON.stringify({ ledgerFile: LIVE_LEDGER_FILE }));
    const markerBefore = readFileSync(join(b.userData, "ledger.json"));
    b.picked["restore-backup"] = pkg;

    mark("T7 07 inspectRestoreBackup (preview)");
    const inspected = data<InspectRestoreResponse>(b.ipc.inspectRestoreBackup(undefined));
    mark("T7 08 preview returned");
    expect(inspected.status).toBe("ready");
    if (inspected.status !== "ready") return;
    expect(inspected.preview).toMatchObject({
      complete: true,
      missingAssets: [],
      schemaVersion: MIGRATIONS.length,
      appSchemaVersion: MIGRATIONS.length,
      settings: "included",
      counts: { sales: 4, invoices: 1, receipts: 1, obligations: 2, settlements: 2 },
    });
    expect(journal(b)).toBe(false); // a preview is not a restore
    expect(b.calls.relaunches).toBe(0);

    mark("T7 09 applyRestore (stage)");
    expect(data<ApplyRestoreResponse>(b.ipc.applyRestore({ manifestSha256: inspected.preview.manifestSha256, acceptMissingAssets: false }))).toEqual({ status: "staged" });
    mark("T7 10 staged");
    expect(b.calls.relaunches).toBe(1);
    expect(journal(b)).toBe(true);

    // ── The restart: main closes the ledger, and the next start runs the engine first. ──
    mark("T7 11 close B's first SQLite connection");
    b.h.db.close();
    mark("T7 12 runPendingRestore BEGIN (engine file operations follow)");
    const engineFs = markedFs();
    const outcome = runPendingRestore({ userDataDir: b.userData, now: NOW, log: nullLogger, ...(engineFs ? { fs: engineFs } : {}) });
    mark(`T7 13 runPendingRestore END outcome=${outcome.kind}`);
    expect(outcome.kind).toBe("restored");
    mark("T7 14 planLedgerOpen");
    const plan = planLedgerOpen(b.userData, realLedgerFs);
    expect(plan.existing).toBe(true);
    expect(readFileSync(join(b.userData, "ledger.json"))).toEqual(markerBefore); // marker untouched
    mark("T7 15 openDatabase on the restored ledger");
    const db = openDatabase(plan.ledgerPath, MIGRATIONS, { fileMustExist: true });
    mark("T7 16 close that connection");
    db.close();
    mark("T7 17 read restored rows (copy)");
    expect(rows(plan.ledgerPath)).toEqual(aLedger);

    // The same receipt key on the restored ledger is a duplicate — no second receipt.
    mark("T7 18 makeHarness #2 on the SAME path");
    b.h = makeHarness(plan.ledgerPath);
    mark("T7 19 harness #2 open; querying");
    const c = b.h.db.prepare("SELECT id FROM parties").get() as { id: string };
    const [oa, ob] = b.h.db.prepare("SELECT id FROM obligations ORDER BY source_ref").all() as Array<{ id: string }>;
    const before = Number((b.h.db.prepare("SELECT count(*) AS n FROM receipts").get() as { n: bigint }).n);
    mark("T7 20 replay the receipt key");
    expect(b.h.ledger.recordAllocatedReceipt(receiptReq(c.id, oa!.id, ob!.id)).duplicate).toBe(true);
    expect(Number((b.h.db.prepare("SELECT count(*) AS n FROM receipts").get() as { n: bigint }).n)).toBe(before);

    // The pre-restore copy is kept, and it is shop B's own ledger.
    mark("T7 21 read the pre-restore copy (copy)");
    const kept = readdirSync(join(b.userData, "restore")).find((n) => n.startsWith("pre-restore-"))!;
    const old = withLedgerCopy(join(b.userData, "restore", kept, LIVE_LEDGER_FILE), (db) => ({
      integrity: db.pragma("integrity_check", { simple: true }),
      sales: Number((db.prepare("SELECT count(*) AS n FROM sales").get() as { n: bigint }).n),
    }));
    expect(old).toEqual({ integrity: "ok", sales: 1 });
    mark("T7 22 body END");
  });

  it("refusals: no preview, a different hash, a package REPLACED after preview — nothing staged, no restart", () => {
    const a = open("shop a");
    seed(a);
    const pkg = exportPackage(a);
    const b = open("shop b");
    expect(data(b.ipc.applyRestore({ manifestSha256: "0".repeat(64), acceptMissingAssets: false }))).toEqual({
      status: "refused",
      reason: "NO_PREVIEW",
      detail: null,
    });
    b.picked["restore-backup"] = pkg;
    const p = data<InspectRestoreResponse>(b.ipc.inspectRestoreBackup(undefined));
    if (p.status !== "ready") throw new Error("not ready");
    expect(data(b.ipc.applyRestore({ manifestSha256: "f".repeat(64), acceptMissingAssets: false }))).toMatchObject({ reason: "PREVIEW_MISMATCH" });

    // Swap the folder's contents for ANOTHER valid backup, same path, after the preview.
    a.h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
    const other = exportPackage(a);
    rmSync(pkg, { recursive: true });
    cpSync(other, pkg, { recursive: true });
    expect(data(b.ipc.applyRestore({ manifestSha256: p.preview.manifestSha256, acceptMissingAssets: false }))).toMatchObject({ status: "refused", reason: "CHANGED" });
    expect(journal(b)).toBe(false);
    expect(b.calls.relaunches).toBe(0);
  });

  it("refusals at preview: damaged, unpublished, newer than this build", () => {
    const a = open("shop a");
    seed(a);
    const pkg = exportPackage(a);
    const b = open("shop b");

    const damaged = join(t.dir, "damaged copy");
    cpSync(pkg, damaged, { recursive: true });
    writeFileSync(join(damaged, "settings.json"), "{}");
    b.picked["restore-backup"] = damaged;
    expect(data(b.ipc.inspectRestoreBackup(undefined))).toEqual({ status: "refused", reason: "DAMAGED", detail: "CHECKSUM_MISMATCH" });

    const partial = join(t.dir, `pkg.partial-${"a".repeat(12)}`);
    cpSync(pkg, partial, { recursive: true });
    b.picked["restore-backup"] = partial;
    expect(data(b.ipc.inspectRestoreBackup(undefined))).toMatchObject({ status: "refused", reason: "UNPUBLISHED" });

    b.migrations = MIGRATIONS.slice(0, -1);
    wire(b);
    b.picked["restore-backup"] = pkg;
    expect(data(b.ipc.inspectRestoreBackup(undefined))).toEqual({ status: "refused", reason: "NEWER_THAN_APP", detail: "SCHEMA_NEWER" });
    expect(journal(b)).toBe(false);
  });

  it("🔴 an INCOMPLETE backup: refused without explicit acceptance, staged with it", () => {
    const a = open("shop a");
    seed(a);
    for (const f of readdirSync(join(a.userData, "branding", "frozen"))) rmSync(join(a.userData, "branding", "frozen", f));
    const pkg = exportPackage(a);
    const b = open("shop b");
    b.picked["restore-backup"] = pkg;
    const p = data<InspectRestoreResponse>(b.ipc.inspectRestoreBackup(undefined));
    if (p.status !== "ready") throw new Error("not ready");
    expect(p.preview.complete).toBe(false);
    expect(p.preview.missingAssets).toEqual([expect.objectContaining({ kind: "frozen-logo", reason: "absent-at-source" })]);

    expect(data(b.ipc.applyRestore({ manifestSha256: p.preview.manifestSha256, acceptMissingAssets: false }))).toMatchObject({ reason: "MISSING_NOT_ACCEPTED" });
    expect(journal(b)).toBe(false);
    expect(data(b.ipc.applyRestore({ manifestSha256: p.preview.manifestSha256, acceptMissingAssets: true }))).toEqual({ status: "staged" });
    expect(journal(b)).toBe(true);
    // 🔴 TRANSITION (P0 lock). This used to inspect AGAIN and expect `RESTORE_PENDING` from apply.
    // Once staged, the lock now refuses even the inspection — no second restore can begin at all.
    b.picked["restore-backup"] = pkg;
    expect(code(b.ipc.inspectRestoreBackup(undefined))).toBe("NOT_AVAILABLE");
    expect(code(b.ipc.applyRestore({ manifestSha256: p.preview.manifestSha256, acceptMissingAssets: true }))).toBe("NOT_AVAILABLE");
    expect(b.calls.relaunches).toBe(1);
  });

  it("a restore folder chosen INSIDE the program's data folder is refused with its own reason", () => {
    const b = open("shop b");
    mkdirSync(join(b.userData, "some folder"));
    b.picked["restore-backup"] = join(b.userData, "some folder");
    expect(data(b.ipc.inspectRestoreBackup(undefined))).toEqual({ status: "refused", reason: "IN_APP_FOLDER", detail: null });
  });
});

describe("🔴 P0 — after a restore is staged, nothing can change the data until the restart", () => {
  const n = (s: Shop, table: string) => Number((s.h.db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);
  const MONEY_COUNTS = ["sales", "voids", "invoices", "obligations", "settlements", "receipts", "parties", "catalog_products", "operators"];
  const snapshot = (s: Shop) => Object.fromEntries(MONEY_COUNTS.map((tb) => [tb, n(s, tb)]));

  function stagedShop(): Shop {
    const a = open("shop a");
    seed(a);
    const pkg = exportPackage(a);
    const b = open("بيانات المحل ب");
    seed(b);
    b.picked["restore-backup"] = pkg;
    const p = data<InspectRestoreResponse>(b.ipc.inspectRestoreBackup(undefined));
    if (p.status !== "ready") throw new Error("not ready");
    expect(data(b.ipc.applyRestore({ manifestSha256: p.preview.manifestSha256, acceptMissingAssets: false }))).toEqual({ status: "staged" });
    return b;
  }

  it("🔴 EVERY channel except three reads is refused — derived from the whole contract, not a hand list", async () => {
    const b = stagedShop();
    const before = snapshot(b);
    const answered: string[] = [];
    for (const name of CHANNEL_NAMES) {
      const r = await (b.raw[name] as (p: unknown) => unknown)(undefined);
      if (RESTORE_LOCK_READS.has(name)) {
        expect((r as { ok: boolean }).ok, name).toBe(true);
        answered.push(name);
      } else {
        expect(code(r), name).toBe("NOT_AVAILABLE");
      }
    }
    expect(answered.sort()).toEqual(["currentCashier", "getAppInfo", "getSettings"]);
    expect(snapshot(b)).toEqual(before);
  });

  it("🔴 real, well-formed money writes are refused too — a sale, a collection, a shared receipt", () => {
    const b = stagedShop();
    const before = snapshot(b);
    const c = b.h.db.prepare("SELECT id FROM parties LIMIT 1").get() as { id: string };
    const ob = b.h.db.prepare("SELECT id FROM obligations LIMIT 1").get() as { id: string };
    expect(code(b.ipc.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: "199" }))).toBe("NOT_AVAILABLE");
    expect(code(b.ipc.recordCustomerPayment({ customerId: c.id, obligationId: ob.id, idempotencyKey: newKey(), amountMinor: "100", channel: "cash", reference: null, fundsConfirmed: true }))).toBe("NOT_AVAILABLE");
    expect(code(b.ipc.recordAllocatedReceipt({ customerId: c.id, idempotencyKey: "receipt-key-0099", channel: "whish", reference: "WH-9", fundsConfirmed: true, currency: "USD", totalMinor: "100", allocations: [] }))).toBe("NOT_AVAILABLE");
    expect(snapshot(b)).toEqual(before);
  });

  /**
   * 🔴 MEASURED, AND IT CORRECTED THE FIRST VERSION OF THIS TEST. Cash sales, voids, catalog imports
   * and PIN state commit through their REPOSITORIES' own transactions, not main's providers — so
   * the provider guard does NOT cover them, and a test that used `createSale` here failed. Those
   * writes are reachable only through IPC, where the IPC gate refuses them (tests above). The phone
   * server, the one caller that bypasses IPC, writes only through `savePhoneProduct`, whose
   * transaction IS the provider (`requireAuditedStack().transact`) — represented here by a product
   * write on that same provider.
   */
  it("🔴 the phone path writes through the service's transaction provider — guarded the same way, no IPC involved", () => {
    const u = join(t.dir, "phone path");
    mkdirSync(u);
    const lock = new RestoreLock(() => false);
    const h = makeHarness(join(u, LIVE_LEDGER_FILE), {
      // main.ts's provider, verbatim in shape: check the lock, then BEGIN IMMEDIATE.
      serviceTransact: (db, fn) => {
        lock.assertOpen();
        return db.transaction(fn).immediate();
      },
    });
    try {
      let i = 0;
      const product = () => h.service.createProduct({ nameAr: "صنف", nameEn: "Item", sku: `SYN-${++i}`, price: "4.00", baseUnit: "piece" });
      const count = () => Number((h.db.prepare("SELECT count(*) AS c FROM catalog_products").get() as { c: bigint }).c);
      product(); // normal before staging
      const before = count();
      lock.engage();
      expect(product).toThrow(/restore is waiting/);
      expect(count()).toBe(before);
    } finally {
      h.db.close();
    }
  });

  it("🔴 the phone surface reaches the service through exactly two calls — one read, and savePhoneProduct on the provider", () => {
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const phone = ["src/main/phoneSessionBridge.ts", "src/main/phoneSessionServer.ts"].map((f) => strip(readFileSync(f, "utf8"))).join("\n");
    const calls = [...new Set([...phone.matchAll(/\bservice\.([a-zA-Z]+)\(/g)].map((m) => m[1]))].sort();
    expect(calls).toEqual(["phoneSessionForm", "savePhoneProduct"]);
    const pos = strip(readFileSync("src/application/posService.ts", "utf8"));
    const save = pos.slice(pos.indexOf("savePhoneProduct("), pos.indexOf("savePhoneProduct(") + 3000);
    expect(save).toContain("this.requireAuditedStack()");
  });

  it("🔴 main.ts checks the lock in EVERY transaction provider it hands out", () => {
    const main = readFileSync("src/main/main.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const providers = main.match(/transact: \(fn\) => \{[^}]*\}/g) ?? [];
    expect(providers.length).toBe(5);
    for (const p of providers) expect(p).toMatch(/restoreLock\.assertOpen\(\);[\s\S]*\.transaction\(fn\)\.immediate\(\)/);
    expect(main.match(/\.transaction\(fn\)\.immediate\(\)/g)).toHaveLength(5);
  });

  it("normal operation is untouched while nothing is staged — including after a REFUSED restore", () => {
    const b = open("shop b");
    const sale = () => b.ipc.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: "199" });
    expect(code(sale())).toBeNull();
    expect(data(b.ipc.applyRestore({ manifestSha256: "0".repeat(64), acceptMissingAssets: false }))).toMatchObject({ reason: "NO_PREVIEW" });
    expect(b.lock.engaged).toBe(false);
    expect(code(sale())).toBeNull();
    expect(n(b, "sales")).toBe(2);
  });

  it("🔴 a FAILED restart: still staged, still locked, and the next start restores", () => {
    const a = open("shop a");
    seed(a);
    const pkg = exportPackage(a);
    const b = open("shop b");
    b.relaunchThrows = true;
    b.picked["restore-backup"] = pkg;
    const p = data<InspectRestoreResponse>(b.ipc.inspectRestoreBackup(undefined));
    if (p.status !== "ready") throw new Error("not ready");
    expect(data(b.ipc.applyRestore({ manifestSha256: p.preview.manifestSha256, acceptMissingAssets: false }))).toEqual({ status: "staged" });
    expect(b.calls.relaunches).toBe(1);
    expect(b.lock.engaged).toBe(true);
    expect(code(b.ipc.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: "199" }))).toBe("NOT_AVAILABLE");
    // A brand-new lock in the same profile (another process) is engaged by the journal alone.
    expect(new RestoreLock(() => existsSync(join(b.userData, "restore", "journal.json"))).engaged).toBe(true);
    // The owner closes the program by hand; the next start runs the restore first.
    b.h.db.close();
    expect(runPendingRestore({ userDataDir: b.userData, now: NOW, log: nullLogger }).kind).toBe("restored");
  });

  it("the restart is never asked for before staging has SUCCEEDED (every refusal leaves it at zero)", () => {
    const b = open("shop b");
    b.picked["restore-backup"] = join(t.dir, "nothing here");
    mkdirSync(join(t.dir, "nothing here"));
    expect(data(b.ipc.inspectRestoreBackup(undefined))).toMatchObject({ status: "refused" });
    expect(data(b.ipc.applyRestore({ manifestSha256: "0".repeat(64), acceptMissingAssets: true }))).toMatchObject({ status: "refused" });
    expect(b.calls.relaunches).toBe(0);
    expect(b.lock.engaged).toBe(false);
  });
});

describe("🔴 P0 — a write already IN FLIGHT when the owner confirms the restore", () => {
  const n = (s: Shop, table: string) => Number((s.h.db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);

  function previewed(): { b: Shop; hash: string } {
    const a = open("shop a");
    seed(a);
    const pkg = exportPackage(a);
    const b = open("shop b");
    b.picked["restore-backup"] = pkg;
    const p = data<InspectRestoreResponse>(b.ipc.inspectRestoreBackup(undefined));
    if (p.status !== "ready") throw new Error("not ready");
    return { b, hash: p.preview.manifestSha256 };
  }

  it("🔴 a transaction can never be paused across an await — better-sqlite3 refuses an async body", () => {
    const b = open("shop b");
    expect(() => b.h.db.transaction(async () => undefined)()).toThrow(/promise/i);
  });

  it("🔴 the restore confirmed from INSIDE an open write is refused (BUSY): nothing staged, nothing locked, the write commits", () => {
    const { b, hash } = previewed();
    const before = n(b, "sales");
    let answer: unknown;
    // A sale that has reached the point just before COMMIT, and the owner's confirmation landing
    // in exactly that gap — the interleaving the event loop cannot produce, forced here.
    b.h.db.transaction(() => {
      b.h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
      answer = data(b.ipc.applyRestore({ manifestSha256: hash, acceptMissingAssets: false }));
    }).immediate();
    expect(answer).toEqual({ status: "refused", reason: "BUSY", detail: null });
    expect(journal(b)).toBe(false);
    expect(b.lock.engaged).toBe(false);
    expect(b.calls.relaunches).toBe(0);
    expect(n(b, "sales")).toBe(before + 1); // the in-flight write finished, counted, not lost
    // And once it has finished, the same confirmation stages normally.
    expect(data(b.ipc.applyRestore({ manifestSha256: hash, acceptMissingAssets: false }))).toEqual({ status: "staged" });
  });

  it("🔴 a MULTI-STEP operation started before staging is cut at its next write: a draft cannot be finalized afterwards", () => {
    const { b, hash } = previewed();
    data(b.ipc.saveCompanyProfile({ nameAr: "متجر ب", nameEn: null, legalName: null, tagline: null, address: null, phone1: null, phone2: null, email: null, logoPath: null, taxpayerNumber: null, commercialRegister: null, vatNumber: null, taxEnabled: false, taxRatePercent: null, taxLabel: null }));
    const draft = data<{ invoice: { id: string } }>(b.ipc.createInvoiceDraft(undefined)).invoice.id;
    data(b.ipc.addInvoiceLine({ invoiceId: draft, line: { description: "صنف", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "10.00" } }));
    const salesBefore = n(b, "sales");
    expect(data(b.ipc.applyRestore({ manifestSha256: hash, acceptMissingAssets: false }))).toEqual({ status: "staged" });
    expect(code(b.ipc.finalizeInvoice({ invoiceId: draft }))).toBe("NOT_AVAILABLE");
    expect(n(b, "sales")).toBe(salesBefore);
    expect(Number((b.h.db.prepare("SELECT count(*) AS c FROM invoices WHERE status = 'finalized'").get() as { c: bigint }).c)).toBe(0);
  });

  it("🔴 the phone's two-step save (photo staged BEFORE, save AFTER staging) is refused at its transaction", () => {
    const u = join(t.dir, "phone in flight");
    mkdirSync(u);
    const lock = new RestoreLock(() => false);
    const h = makeHarness(join(u, LIVE_LEDGER_FILE), {
      serviceTransact: (db, fn) => {
        lock.assertOpen();
        return db.transaction(fn).immediate();
      },
    });
    try {
      // Step one happened before staging (the photo is held in memory, nothing written); staging
      // then engages the lock; step two is the write, and it goes through the provider.
      lock.engage();
      expect(() => h.service.createProduct({ nameAr: "صنف", nameEn: "Item", sku: "SYN-PHONE", price: "4.00", baseUnit: "piece" })).toThrow(/restore is waiting/);
      expect(Number((h.db.prepare("SELECT count(*) AS c FROM catalog_products WHERE sku = 'SYN-PHONE'").get() as { c: bigint }).c)).toBe(0);
    } finally {
      h.db.close();
    }
  });
});

describe("the ledger-reading helper itself — it must not hide WAL-only transactions", () => {
  it("🔴 committed rows that live ONLY in the -wal are read; the main file alone would miss them; the original is untouched", () => {
    const u = join(t.dir, "wal only");
    mkdirSync(u);
    const path = join(u, LIVE_LEDGER_FILE);
    const h = makeHarness(path);
    try {
      h.db.pragma("wal_autocheckpoint = 0"); // keep every commit in the -wal
      for (let i = 0; i < 3; i++) {
        h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
      }
      expect(existsSync(`${path}-wal`)).toBe(true);
      const viaHelper = withLedgerCopy(path, (db) => Number((db.prepare("SELECT count(*) AS n FROM sales").get() as { n: bigint }).n));
      expect(viaHelper).toBe(3);
      // The negative control: the main file WITHOUT its -wal does not hold them — so a helper that
      // dropped the WAL would fail the assertion above instead of passing on an incomplete ledger.
      const mainOnly = join(t.dir, "main only");
      mkdirSync(mainOnly);
      copyFileSync(path, join(mainOnly, LIVE_LEDGER_FILE));
      const db = new Database(join(mainOnly, LIVE_LEDGER_FILE), { fileMustExist: true });
      let fromMain: number;
      try {
        fromMain = Number((db.prepare("SELECT count(*) AS n FROM sales").get() as { n: number }).n);
      } catch (e) {
        // Even the schema may still be only in the -wal: then the main file holds no sales at all.
        if (!/no such table/.test(String(e))) throw e;
        fromMain = 0;
      } finally {
        db.close();
      }
      expect(fromMain).toBeLessThan(3);
    } finally {
      h.db.close();
    }
  });
});
