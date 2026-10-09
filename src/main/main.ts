/**
 * Electron main process. Owns the database and the PosService; the renderer only ever reaches them
 * through the fixed channels in src/shared/ipcContract.ts.
 *
 * Window hardening: contextIsolation on, nodeIntegration off, sandbox on, no navigation, no new
 * windows, every permission request denied, and every IPC call checked to come from our own
 * window's top frame.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, session } from "electron";
import { PosService, startupCatalog } from "../application/posService";
import { InvoiceService } from "../application/invoiceService";
import { businessDateOf } from "../domain/businessDay";
import { MAX_IMPORT_BYTES } from "../domain/catalogImport";
import { DomainError } from "../domain/errors";
import { loadCatalog } from "../domain/catalog";
import { FIXTURE_CASHIERS } from "../fixtures/cashiers";
import { FIXTURE_CATALOG } from "../fixtures/catalog";
import { FIXTURE_TERMINAL } from "../fixtures/terminal";
import { BACKUP_DIR_NAME, createPreMigrationBackup, ensureDailyBackup, snapshotDatabase } from "../persistence/backup";
import { CatalogRepository } from "../persistence/catalogRepository";
import { type Db, openDatabase, schemaVersion } from "../persistence/db";
import { MIGRATIONS } from "../persistence/migrations";
import { AuditRepository } from "../persistence/auditRepository";
import { CompanyProfileRepository } from "../persistence/companyProfileRepository";
import { InvoiceRepository } from "../persistence/invoiceRepository";
import { ReconciliationRepository } from "../persistence/reconciliationRepository";
import { PinStateRepository } from "../persistence/pinStateRepository";
import { SaleRepository } from "../persistence/saleRepository";
import { CHANNELS } from "../shared/ipcContract";
import { toInvoiceViewDto } from "../shared/dto";
import { renderInvoiceDocument } from "./invoiceDocument";
import { AUTO_START_MARKER_FILE, applyAutoStart } from "./autoStart";
import { diag, diagEnabled } from "./diagnostics";
import { buildLabel, readBuildInfo } from "./buildInfo";
import { CHANNEL_NAMES, type IpcHandlerOptions, type PickedFile, type SavedFile, createIpcHandlers } from "./ipcHandlers";
import { type LedgerFs, planLedgerOpen, recordLedger } from "./ledgerGuard";
import { type Logger, createFileLogger, nullLogger } from "./logger";
import { SettingsStore } from "./settingsStore";
import { classifyStartupError, startupFailureMessage } from "./startupFailure";

const RENDERER_INDEX = join(__dirname, "..", "..", "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).toString();

let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;
let invoices: InvoiceService | null = null;
let log: Logger = nullLogger;

// dist/main/main/main.js → dist/build-info.json (written at build time by scripts/write-build-info.mjs).
const BUILD_INFO = readBuildInfo(join(__dirname, "..", "..", "build-info.json"), app.getVersion());

const ledgerFs: LedgerFs = {
  exists: existsSync,
  writeAtomic: (path, contents) => {
    writeFileSync(`${path}.tmp`, contents, "utf8");
    renameSync(`${path}.tmp`, path);
  },
};

function writeAtomic(path: string, contents: string): void {
  writeFileSync(`${path}.partial`, contents, "utf8");
  renameSync(`${path}.partial`, path);
}

function stampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: "Alzabt POS",
    backgroundColor: "#f4f5f7",
    show: false,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== RENDERER_URL) event.preventDefault();
  });
  win.once("ready-to-show", () => {
    win.show();
    diag("window-ready");
  });
  void win.loadFile(RENDERER_INDEX);
  return win;
}

/** Native file dialog, run in the main process: the renderer never sees or chooses a path. */
function pickCatalogFile(): PickedFile | null {
  if (!mainWindow) return null;
  // Looked up on `dialog` at call time (not destructured) so the E2E test can stub it.
  const picked = dialog.showOpenDialogSync(mainWindow, {
    title: "Import catalog (CSV, UTF-8)",
    properties: ["openFile"],
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  const path = picked?.[0];
  if (!path) return null;
  if (statSync(path).size > MAX_IMPORT_BYTES) return { name: basename(path), bytes: new Uint8Array(MAX_IMPORT_BYTES + 1) };
  return { name: basename(path), bytes: readFileSync(path) };
}

/** Native "save as" for the catalog export; the renderer never names a path. */
function saveCatalogExport(suggestedName: string, contents: string): SavedFile | null {
  if (!mainWindow) return null;
  const path = dialog.showSaveDialogSync(mainWindow, {
    title: "Export catalog (CSV, UTF-8)",
    defaultPath: join(app.getPath("documents"), suggestedName),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return null;
  writeAtomic(path, contents);
  return { fileName: basename(path) };
}

// ── The invoice logo, and printing a finalized invoice ─────────────────────────────────────────
//
// 🔴 THE RENDERER NEVER NAMES A PATH AND NEVER SUPPLIES HTML. It sends an invoice id; everything
// below loads the FROZEN document from the database and renders it here. The logo is the one file
// an operator chooses, and it is chosen in a native dialog in THIS process, copied into the app's
// own branding folder, and stored as a bare file name — so a stored profile can never point at an
// arbitrary location on disk, and a later render cannot be redirected anywhere else.

const BRANDING_DIR = "branding";
const LOGO_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

function brandingDir(): string {
  const dir = join(app.getPath("userData"), BRANDING_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Native image picker. Returns the BARE file name it stored, or null when cancelled.
 *
 * The extension is checked against a fixed list before the copy, and the stored name is built here
 * rather than taken from the chosen file, so neither a path separator nor a `..` can survive.
 */
function pickInvoiceLogo(): string | null {
  if (!mainWindow) return null;
  const picked = dialog.showOpenDialogSync(mainWindow, {
    title: "Choose the invoice logo",
    properties: ["openFile"],
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  const path = picked?.[0];
  if (!path) return null;
  const ext = extname(path).toLowerCase();
  if (!LOGO_EXTENSIONS.includes(ext)) {
    throw new DomainError("INVALID_INPUT", "Choose a PNG, JPG or WEBP image");
  }
  if (statSync(path).size > 4 * 1024 * 1024) {
    throw new DomainError("INVALID_INPUT", "Choose an image smaller than 4 MB");
  }
  // The name is OURS, not the chosen file's: one logo, one known name, no traversal possible.
  const stored = `invoice-logo${ext}`;
  copyFileSync(path, join(brandingDir(), stored));
  log.info("invoice-logo-chosen", { stored, bytes: statSync(path).size });
  return stored;
}

/**
 * A stored logo name turned into a file URL, or null.
 *
 * Anything that is not a plain file name living in the branding folder is refused rather than
 * resolved — a profile row edited outside the application must not become a way to read an
 * arbitrary file into a printed document.
 */
/** Where frozen, content-addressed logo copies live, beside the live branding file. */
const FROZEN_DIR = "frozen";

/**
 * Copies the shop's current logo into an immutable, content-addressed asset and returns its name.
 *
 * 🔴 CONTENT-ADDRESSED ON PURPOSE. The name is the SHA-256 of the bytes, so re-finalizing with the
 * same logo writes nothing new, and replacing the shop's logo cannot overwrite the copy an older
 * invoice points at — two different images cannot collide on one name. Returns null when there is
 * no logo or the file has gone, which prints no logo, exactly as today.
 *
 * Written temp-then-rename like every other write in this app, so a crash mid-copy can leave the
 * old file or the new one, never a truncated image on a commercial document.
 */
function freezeLogo(storedName: string): string | null {
  try {
    const source = logoPathFor(storedName, BRANDING_DIR);
    if (!source) return null;
    const bytes = readFileSync(source);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    const name = `${hash}${extname(storedName).toLowerCase()}`;
    const dir = join(app.getPath("userData"), BRANDING_DIR, FROZEN_DIR);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, name);
    if (!existsSync(target)) {
      writeFileSync(`${target}.partial`, bytes);
      renameSync(`${target}.partial`, target);
    }
    return name;
  } catch (err) {
    log.warn("logo freeze failed", { error: String(err) });
    return null;
  }
}

/** Resolves a bare filename inside one directory under userData, refusing anything else. */
function logoPathFor(stored: string | null, dir: string): string | null {
  if (!stored || stored.includes("/") || stored.includes("\\") || stored.includes("..")) return null;
  if (!LOGO_EXTENSIONS.includes(extname(stored).toLowerCase())) return null;
  const base = join(app.getPath("userData"), dir);
  const path = join(base, stored);
  if (resolve(path) !== resolve(join(base, basename(stored)))) return null;
  if (!existsSync(path)) return null;
  return path;
}

/**
 * The logo a FINALIZED invoice prints.
 *
 * Prefers the frozen asset, which cannot change after the document was issued. Falls back to the
 * live branding file only for invoices finalized before freezing existed — those keep the old
 * behaviour, because a finalized invoice is immutable and cannot be backfilled.
 */
function invoiceLogoUrl(issuer: { logoAsset: string | null; logoPath: string | null } | null): string | null {
  if (!issuer) return null;
  const frozen = issuer.logoAsset ? logoPathFor(issuer.logoAsset, join(BRANDING_DIR, FROZEN_DIR)) : null;
  if (frozen) return pathToFileURL(frozen).toString();
  return logoUrlFor(issuer.logoPath);
}

function logoUrlFor(stored: string | null): string | null {
  if (!stored || stored.includes("/") || stored.includes("\\") || stored.includes("..")) return null;
  if (!LOGO_EXTENSIONS.includes(extname(stored).toLowerCase())) return null;
  const path = join(app.getPath("userData"), BRANDING_DIR, stored);
  if (resolve(path) !== resolve(join(app.getPath("userData"), BRANDING_DIR, basename(stored)))) return null;
  if (!existsSync(path)) return null;
  return pathToFileURL(path).toString();
}

/**
 * Renders a FINALIZED invoice to A4 PDF bytes in an offscreen window.
 *
 * The window runs with JavaScript DISABLED: the document is static HTML and needs none, and a print
 * surface that cannot execute script is one less thing to reason about. The HTML comes from
 * `renderInvoiceDocument`, which takes the frozen DTO and nothing else.
 */
async function renderInvoicePdf(invoiceId: string): Promise<Buffer> {
  if (!invoices) throw new DomainError("NOT_AVAILABLE", "Invoices are not available");
  const view = toInvoiceViewDto(invoices.getInvoice(invoiceId));
  const html = renderInvoiceDocument(view, { logoUrl: invoiceLogoUrl(view.invoice.issuer ?? null) });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      // 🔴 Zero margins HERE on purpose: the document's own `@page { margin: 14mm 12mm }` is what
      // positions the invoice on the sheet, and it is what the unit tests assert. Electron's own
      // default of ~1cm would be added on top of it, silently narrowing the page the tests measured.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  } finally {
    win.destroy();
  }
}

async function printInvoiceDocument(invoiceId: string): Promise<"printed" | "cancelled"> {
  if (!invoices) throw new DomainError("NOT_AVAILABLE", "Invoices are not available");
  const view = toInvoiceViewDto(invoices.getInvoice(invoiceId));
  const html = renderInvoiceDocument(view, { logoUrl: invoiceLogoUrl(view.invoice.issuer ?? null) });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const printed = await new Promise<boolean>((done) => {
      win.webContents.print({ silent: false, printBackground: true }, (success) => done(success));
    });
    log.info("invoice-printed", { id: invoiceId, number: view.invoice.invoiceNumber, printed });
    return printed ? "printed" : "cancelled";
  } finally {
    win.destroy();
  }
}

/** Native "save as" + the A4 PDF of the frozen invoice. */
async function saveInvoicePdfFile(invoiceId: string): Promise<SavedFile | null> {
  if (!mainWindow || !invoices) return null;
  const view = toInvoiceViewDto(invoices.getInvoice(invoiceId));
  const suggested = `invoice-${view.invoice.invoiceNumber ?? "draft"}.pdf`;
  const path = dialog.showSaveDialogSync(mainWindow, {
    title: "Save invoice PDF",
    defaultPath: join(app.getPath("documents"), suggested),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return null;
  const pdf = await renderInvoicePdf(invoiceId);
  writeFileSync(path, pdf);
  log.info("invoice-pdf-saved", { id: invoiceId, number: view.invoice.invoiceNumber, bytes: pdf.length });
  return { fileName: basename(path) };
}

/** Native "save as" + a verified consistent snapshot of the live ledger (never a raw file copy). */
function exportBackup(ledgerPath: string): SavedFile | null {
  if (!mainWindow || !db) return null;
  const path = dialog.showSaveDialogSync(mainWindow, {
    title: "Export backup",
    defaultPath: join(app.getPath("documents"), `alzabt-pos-backup-${stampNow()}.sqlite`),
    filters: [{ name: "Alzabt POS backup", extensions: ["sqlite"] }],
  });
  if (!path) return null;
  if (resolve(path).toLowerCase() === resolve(ledgerPath).toLowerCase()) {
    throw new DomainError("INVALID_INPUT", "Choose a different file — this is the live sales database");
  }
  const snap = snapshotDatabase(db, path);
  log.info("backup-export", { bytes: snap.bytes, counts: snap.counts });
  return { fileName: basename(path) };
}

function registerIpc(service: PosService, extra: IpcHandlerOptions): void {
  const handlers = createIpcHandlers(service, { pickCatalogFile, ...extra });
  for (const name of CHANNEL_NAMES) {
    ipcMain.handle(CHANNELS[name], (event, payload: unknown) => {
      const fromOurWindow =
        mainWindow !== null &&
        event.sender === mainWindow.webContents &&
        event.senderFrame?.url === RENDERER_URL &&
        event.senderFrame === mainWindow.webContents.mainFrame;
      if (!fromOurWindow) {
        return { ok: false, error: { code: "FORBIDDEN", message: "Unknown sender" } };
      }
      return handlers[name](payload);
    });
  }
}

// Optional profile override (tests and support only). Must run before the single-instance lock and
// before `ready`. Without it, the ledger lives in the OS per-user app-data folder.
const userDataOverride = process.env.ALZABT_POS_USER_DATA;
if (userDataOverride) app.setPath("userData", userDataOverride);

log = createFileLogger(join(app.getPath("userData"), "logs"));
log.info("app-start", {
  version: BUILD_INFO.version,
  build: BUILD_INFO.build,
  packaged: app.isPackaged,
  platform: process.platform,
  electron: process.versions.electron,
  userDataOverride: Boolean(userDataOverride),
});

diag("main-start", { argv: process.argv, execPath: process.execPath, userData: app.getPath("userData") });
process.on("uncaughtExceptionMonitor", (err) => {
  diag("uncaught-exception", { message: String(err) });
  log.error("uncaught-exception", { error: err });
});
process.on("exit", (code) => diag("exit", { code }));
app.on("child-process-gone", (_e, details) => diag("child-process-gone", { ...details }));

const gotSingleInstanceLock = app.requestSingleInstanceLock();
diag("single-instance-lock", { acquired: gotSingleInstanceLock });

if (!gotSingleInstanceLock) {
  // One terminal, one process, one writer. Logged, because on Windows leftover helper processes
  // from a crashed instance can hold the lock and this exit would otherwise be silent.
  console.error("[pos] single-instance lock not acquired — another Alzabt POS process holds it; exiting");
  log.warn("single-instance-lock-refused");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(() => {
      diag("ready");
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      startTill();
    })
    .catch((err: unknown) => failStartup(err));

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    db?.close();
    db = null;
  });
}

/**
 * Opens the ledger (backing it up first if a migration is pending) and starts the till. Any failure
 * goes to failStartup: a clear message, a log line, and NO window on a ledger we could not open.
 */
function startTill(): void {
  const userData = app.getPath("userData");
  const backupDir = join(userData, BACKUP_DIR_NAME);
  const plan = planLedgerOpen(userData, ledgerFs);
  log.info("db-open-start", { existingLedger: plan.existing, schemaVersionOfBuild: MIGRATIONS.length });

  db = openDatabase(plan.ledgerPath, MIGRATIONS, {
    fileMustExist: plan.existing,
    beforeMigrations: (openDb, pending) => {
      log.info("migration-start", { ...pending });
      const snap = createPreMigrationBackup(openDb, backupDir, pending, new Date());
      log.info("backup-pre-migration", { file: basename(snap.path), bytes: snap.bytes, counts: snap.counts });
    },
  });
  const version = schemaVersion(db);
  log.info("db-open", { schemaVersion: version, created: !plan.existing });
  recordLedger(plan, ledgerFs, { appVersion: BUILD_INFO.version, now: new Date() });

  if (diagEnabled) {
    const sales = db.prepare("SELECT count(*) AS n FROM sales").get() as { n: bigint };
    diag("ledger-open", { integrity: db.pragma("quick_check", { simple: true }), sales: Number(sales.n) });
  }

  // At most one automatic backup per business day: at startup, and again after a sale if the app was
  // left running across midnight. A failed daily backup is logged, never fatal — the till keeps selling.
  let lastDailyDate: string | null = null;
  const maybeDailyBackup = () => {
    if (!db) return;
    const today = businessDateOf(new Date(), FIXTURE_TERMINAL.timeZone);
    if (today === lastDailyDate) return;
    try {
      const result = ensureDailyBackup(db, backupDir, today);
      lastDailyDate = today;
      log.info("backup-daily", {
        date: today,
        created: result.created ? basename(result.created.path) : null,
        pruned: result.pruned,
      });
    } catch (err) {
      log.error("backup-daily-failed", { date: today, error: err });
    }
  };
  maybeDailyBackup();

  const catalogStore = new CatalogRepository(db);
  const start = startupCatalog(catalogStore, loadCatalog(FIXTURE_CATALOG), FIXTURE_TERMINAL.currency);
  console.info(`[pos] catalog: ${start.origin}, ${start.catalog.products.length} products`);
  diag("catalog", { origin: start.origin, products: start.catalog.products.length });
  log.info("catalog", { origin: start.origin, products: start.catalog.products.length });
  // Operator settings (language) live in a small JSON file beside the ledger, not in it.
  const settings = new SettingsStore(userData);
  log.info("settings", { ...settings.get() });

  // Named rather than inlined, because the invoice stack below must share THIS object: one
  // repository, one connection, one transaction (migration 7).
  const saleStore = new SaleRepository(db);
  const service = new PosService({
    repository: saleStore,
    pinStates: new PinStateRepository(db),
    catalog: start.catalog,
    catalogStore,
    cashiers: FIXTURE_CASHIERS,
    terminal: FIXTURE_TERMINAL,
    // The durable audit trail (migration 5) and the transaction that binds it to the business
    // mutation. Both use THIS connection — there is no second database handle anywhere, because
    // atomicity across two connections would not be atomicity.
    auditStore: new AuditRepository(db, {
      appVersion: BUILD_INFO.version,
      schemaVersion: MIGRATIONS.length,
    }),
    transact: (fn) => {
      if (!db) throw new Error("ledger is not open");
      return db.transaction(fn).immediate();
    },
    // The rotating logfile now MIRRORS committed audit rows, for field support. It is no longer the
    // record — audit_events is — and it rotates, so it must never be treated as one.
    audit: (row) => log.info("audit", { ...row }),
  });
  // The manual-invoice stack (migrations 6 and 7), on THIS connection and THIS transaction provider, with
  // `service` as its only route to the catalog — so an invoice can never write a product except
  // through PosService and its migration-5 audit row.
  invoices = new InvoiceService({
    invoices: new InvoiceRepository(db),
    reconciliation: new ReconciliationRepository(db),
    company: new CompanyProfileRepository(db),
    catalogStore,
    products: service,
    logoVault: { freeze: freezeLogo },
    // The SAME repository object the till uses, on the same connection: a finalized invoice's sale
    // goes through the one module that is allowed to write the ledger (migration 7).
    sales: saleStore,
    transact: (fn) => {
      if (!db) throw new Error("ledger is not open");
      return db.transaction(fn).immediate();
    },
    terminal: FIXTURE_TERMINAL,
  });

  registerIpc(service, {
    invoices,
    pickInvoiceLogo,
    printInvoice: printInvoiceDocument,
    saveInvoicePdf: saveInvoicePdfFile,
    saveCatalogExport,
    exportBackup: () => exportBackup(plan.ledgerPath),
    appInfo: () => ({ version: BUILD_INFO.version, build: BUILD_INFO.build }),
    afterSale: maybeDailyBackup,
    logger: log,
    settings: {
      get: () => settings.get(),
      setTerminalLanguage: (lang) => settings.setTerminalLanguage(lang),
    },
  });
  mainWindow = createWindow();

  // Best-effort, after the till is already up: a failure here is logged, never fatal.
  const autoStart = applyAutoStart({
    app: { setLoginItemSettings: (settings) => app.setLoginItemSettings(settings) },
    store: { exists: existsSync, write: (path, contents) => writeFileSync(path, contents, "utf8") },
    markerPath: join(app.getPath("userData"), AUTO_START_MARKER_FILE),
    executablePath: process.execPath,
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env,
    now: () => new Date(),
  });
  console.info("[pos] auto-start:", JSON.stringify(autoStart));
  log.info("auto-start", { ...autoStart });
}

function failStartup(err: unknown): void {
  const code = classifyStartupError(err);
  log.error("startup-failure", { code, error: err });
  console.error("[pos] startup failure", code, err);
  try {
    db?.close();
  } catch {
    // already failing; nothing more to do with the handle
  }
  db = null;
  const message = startupFailureMessage(code, buildLabel(BUILD_INFO));
  // showMessageBoxSync rather than showErrorBox: on Windows showErrorBox captions the window just
  // "Error" (measured on Windows CI); here the caption is ours, so support can recognise it.
  dialog.showMessageBoxSync({
    type: "error",
    title: message.title,
    message: message.title,
    detail: message.body,
    buttons: ["Close"],
    defaultId: 0,
    noLink: true,
  });
  app.exit(1);
}
