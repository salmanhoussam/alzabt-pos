/**
 * Electron main process. Owns the database and the PosService; the renderer only ever reaches them
 * through the fixed channels in src/shared/ipcContract.ts.
 *
 * Window hardening: contextIsolation on, nodeIntegration off, sandbox on, no navigation, no new
 * windows, every permission request denied, and every IPC call checked to come from our own
 * window's top frame.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, ipcMain, session } from "electron";
import { PosService } from "../application/posService";
import { loadCatalog } from "../domain/catalog";
import { FIXTURE_CASHIERS } from "../fixtures/cashiers";
import { FIXTURE_CATALOG } from "../fixtures/catalog";
import { FIXTURE_TERMINAL } from "../fixtures/terminal";
import { type Db, openDatabase } from "../persistence/db";
import { PinStateRepository } from "../persistence/pinStateRepository";
import { SaleRepository } from "../persistence/saleRepository";
import { CHANNELS } from "../shared/ipcContract";
import { AUTO_START_MARKER_FILE, applyAutoStart } from "./autoStart";
import { CHANNEL_NAMES, createIpcHandlers } from "./ipcHandlers";

const RENDERER_INDEX = join(__dirname, "..", "..", "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).toString();

let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;

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
  win.once("ready-to-show", () => win.show());
  void win.loadFile(RENDERER_INDEX);
  return win;
}

function registerIpc(service: PosService): void {
  const handlers = createIpcHandlers(service);
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

if (!app.requestSingleInstanceLock()) {
  // One terminal, one process, one writer.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    db = openDatabase(join(app.getPath("userData"), "alzabt-pos-ledger.sqlite"));
    const service = new PosService({
      repository: new SaleRepository(db),
      pinStates: new PinStateRepository(db),
      catalog: loadCatalog(FIXTURE_CATALOG),
      cashiers: FIXTURE_CASHIERS,
      terminal: FIXTURE_TERMINAL,
    });
    registerIpc(service);
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
  });

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    db?.close();
    db = null;
  });
}
