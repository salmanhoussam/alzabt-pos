/**
 * Electron main process. Owns the database and the PosService; the renderer only ever reaches them
 * through the fixed channels in src/shared/ipcContract.ts.
 *
 * Window hardening: contextIsolation on, nodeIntegration off, sandbox on, no navigation, no new
 * windows, every permission request denied, and every IPC call checked to come from our own
 * window's top frame.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, session } from "electron";
import { PosService, startupCatalog } from "../application/posService";
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
import { PinStateRepository } from "../persistence/pinStateRepository";
import { SaleRepository } from "../persistence/saleRepository";
import { CHANNELS } from "../shared/ipcContract";
import { AUTO_START_MARKER_FILE, applyAutoStart } from "./autoStart";
import { diag, diagEnabled } from "./diagnostics";
import { buildLabel, readBuildInfo } from "./buildInfo";
import { CHANNEL_NAMES, type IpcHandlerOptions, type PickedFile, type SavedFile, createIpcHandlers } from "./ipcHandlers";
import { type LedgerFs, planLedgerOpen, recordLedger } from "./ledgerGuard";
import { type Logger, createFileLogger, nullLogger } from "./logger";
import { classifyStartupError, startupFailureMessage } from "./startupFailure";

const RENDERER_INDEX = join(__dirname, "..", "..", "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).toString();

let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;
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
  const service = new PosService({
    repository: new SaleRepository(db),
    pinStates: new PinStateRepository(db),
    catalog: start.catalog,
    catalogStore,
    cashiers: FIXTURE_CASHIERS,
    terminal: FIXTURE_TERMINAL,
  });
  registerIpc(service, {
    saveCatalogExport,
    exportBackup: () => exportBackup(plan.ledgerPath),
    appInfo: () => ({ version: BUILD_INFO.version, build: BUILD_INFO.build }),
    afterSale: maybeDailyBackup,
    logger: log,
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
