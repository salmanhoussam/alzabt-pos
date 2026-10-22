/**
 * Electron main process. Owns the database and the PosService; the renderer only ever reaches them
 * through the fixed channels in src/shared/ipcContract.ts.
 *
 * Window hardening: contextIsolation on, nodeIntegration off, sandbox on, no navigation, no new
 * windows, every permission request denied, and every IPC call checked to come from our own
 * window's top frame.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, nativeImage, session } from "electron";
import { PosService, startupCatalog } from "../application/posService";
import { PHOTO_EXTENSIONS, createProductPhotoPicker, electronCodec } from "./productPhoto";
import { writeOnlineCatalogPackage, type PackageFs } from "./onlineCatalogPackage";
import { PhoneSessionBridge } from "./phoneSessionBridge";
import { decodeBarcodePhoto } from "./phoneBarcode";
import { assertStorable, normalizeProductPhoto } from "./photoNormalize";
import type { OnlineCatalogSnapshot } from "../application/posService";
import type { OnlineCatalogExportDto } from "../shared/ipcContract";
import { InvoiceService } from "../application/invoiceService";
import { PartyService } from "../application/partyService";
import { LedgerService } from "../application/ledgerService";
import { PartyRepository } from "../persistence/partyRepository";
import { LedgerRepository } from "../persistence/ledgerRepository";
import { businessDateOf } from "../domain/businessDay";
import { MAX_IMPORT_BYTES } from "../domain/catalogImport";
import { DomainError } from "../domain/errors";
import { loadCatalog } from "../domain/catalog";
import { FIXTURE_CASHIERS } from "../fixtures/cashiers";
import { FIXTURE_CATALOG } from "../fixtures/catalog";
import { FIXTURE_TERMINAL } from "../fixtures/terminal";
import { BACKUP_DIR_NAME, createPreMigrationBackup, ensureDailyBackup, snapshotDatabase } from "../persistence/backup";
import { CatalogRepository } from "../persistence/catalogRepository";
import { CategoryRepository } from "../persistence/categoryRepository";
import { ProductImageRepository } from "../persistence/productImageRepository";
import { type Db, openDatabase, schemaVersion } from "../persistence/db";
import { MIGRATIONS } from "../persistence/migrations";
import { AuditRepository } from "../persistence/auditRepository";
import { CompanyProfileRepository } from "../persistence/companyProfileRepository";
import { InvoiceRepository } from "../persistence/invoiceRepository";
import { ReconciliationRepository } from "../persistence/reconciliationRepository";
import { PinStateRepository } from "../persistence/pinStateRepository";
import { OperatorRepository } from "../persistence/operatorRepository";
import { OperatorService } from "../application/operatorService";
import { SaleRepository } from "../persistence/saleRepository";
import { CHANNELS } from "../shared/ipcContract";
import { toInvoiceViewDto } from "../shared/dto";
import { renderInvoiceDocument } from "./invoiceDocument";
import {
  type InvoiceIssuerLogo,
  type InvoiceLogoFs,
  logoWarningFor,
  resolveInvoiceLogo,
} from "./invoiceLogo";
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
let parties: PartyService | null = null;
let ledgerService: LedgerService | null = null;
let log: Logger = nullLogger;

/**
 * The temporary phone-entry LAN bridge (slice H1).
 *
 * 🔴 MODULE SCOPE, AND ONE INSTANCE, because two different parts of the lifecycle must reach the
 * SAME object: `registerIpc` hands it to the channels, and `will-quit` closes it. A bridge created
 * inside `startTill` would be invisible to the quit hook, and the listener would then outlive the
 * window it belongs to — which is the exact failure the shutdown contract exists to prevent.
 *
 * It holds no database handle and no service: opening a session is authorized by the SERVICE, and
 * the bridge is only the mechanism. Constructing it costs nothing until a session is started — the
 * 647 KB of WebAssembly for the QR is read lazily on first use.
 *
 * 🔴 The logger FORWARDS to `log` rather than capturing it. `log` is reassigned once the real file
 * logger exists (`startTill`), and a bridge that had captured the value would spend the whole
 * session writing to `nullLogger` — so every diagnostic about the one network surface in the
 * product would be silently discarded.
 */
/**
 * The live service, so the phone bridge can reach it.
 *
 * 🔴 A MODULE-LEVEL BINDING READ THROUGH A GETTER, not a constructor argument, because the two
 * have different lifetimes: the bridge must exist before `will-quit` is registered, and the
 * service cannot exist until the ledger has opened. The getter is read when a session STARTS, by
 * which point `startTill` has long since run — and if it somehow has not, `service` is undefined
 * and the phone can pair but not save, which fails closed rather than crashing.
 */
let posService: PosService | null = null;

const phoneSessions = new PhoneSessionBridge({
  get service() {
    return posService ?? undefined;
  },
  /**
   * 🔴 SLICE F'S PIPELINE, VERBATIM — the same two calls `createProductPhotoPicker` makes for a
   * desktop photo. The decode, the EXIF orientation fix, the 1600px long edge, the 80→72→64 JPEG
   * ladder, the transparent-PNG rule, the 1.2 MB output cap and the decode-RESULT validation are
   * all F's, and a phone photo is held to every one of them. There is no second image path.
   */
  normalizePhoto: (bytes) => assertStorable(normalizeProductPhoto(bytes, electronCodec(nativeImage))),
  decodeBarcode: (bytes) => decodeBarcodePhoto(bytes),
  logger: {
    info: (event, fields) => log.info(event, fields),
    warn: (event, fields) => log.warn(event, fields),
    error: (event, fields) => log.error(event, fields),
    get file() {
      return log.file;
    },
  },
});

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

// ── The product photo producer (slice F) ───────────────────────────────────────────────────────
//
// 🔴 THE SAME SHAPE AS THE LOGO PICKER, FOR THE SAME REASON: the dialog runs in THIS process, the
// renderer never names a path, and nothing but bytes crosses back. The difference is that a
// product photo is DECODED and normalized before it is stored, because unlike the logo it goes
// into the ledger itself and into every backup. See src/main/photoNormalize.ts for the measured
// policy behind every number.

/** Native image picker for a product photo. Returns the chosen path, or null when cancelled. */
function chooseProductPhotoFile(): string | null {
  if (!mainWindow) return null;
  // Looked up on `dialog` at call time (not destructured) so the E2E test can stub it, exactly as
  // `pickCatalogFile` does.
  const picked = dialog.showOpenDialogSync(mainWindow, {
    title: "Choose a product photo",
    properties: ["openFile"],
    filters: [{ name: "Image (JPEG, PNG)", extensions: [...PHOTO_EXTENSIONS] }],
  });
  return picked?.[0] ?? null;
}

const pickProductPhoto = createProductPhotoPicker({
  chooseFile: chooseProductPhotoFile,
  fileSize: (path) => statSync(path).size,
  readFile: (path) => readFileSync(path),
  codec: electronCodec(nativeImage),
  // 🔴 FORWARDED, NOT CAPTURED. `log` is a `let` that starts as the null logger and is reassigned
  // once the real file logger exists. Passing `log` here would bind the null one at module load,
  // and every normalization line would vanish — the kind of silence that reads as "it worked".
  log: {
    info: (event, fields) => log.info(event, fields),
    warn: (event, fields) => log.warn(event, fields),
    error: (event, fields) => log.error(event, fields),
    get file() {
      return log.file;
    },
  },
});

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
 * The two filesystem questions the logo decision asks. Both refuse anything that is not a plain
 * file name inside their own directory, because `logoPathFor` does.
 */
const invoiceLogoFs: InvoiceLogoFs = {
  frozen: (assetName) => logoPathFor(assetName, join(BRANDING_DIR, FROZEN_DIR)),
  live: (storedName) => logoPathFor(storedName, BRANDING_DIR),
};

/**
 * The logo a FINALIZED invoice prints, and whether the operator must be told something is wrong.
 *
 * 🔴 THE DECISION IS NOT HERE. `resolveInvoiceLogo` owns it and is unit-tested; this function is
 * the filesystem seam and the URL conversion, nothing more. A recorded asset that is absent
 * resolves to NO logo plus a warning — never to the shop's current branding, which is a different
 * image under a fixed name. See src/main/invoiceLogo.ts for why that mattered.
 */
function invoiceLogo(issuer: InvoiceIssuerLogo | null): { readonly url: string | null; readonly missing: boolean } {
  const resolution = resolveInvoiceLogo(issuer, invoiceLogoFs);
  const url =
    resolution.kind === "frozen" || resolution.kind === "legacy"
      ? pathToFileURL(resolution.path).toString()
      : null;
  return { url, missing: logoWarningFor(resolution) };
}

/** Where a document being printed is staged. One file, overwritten per render, removed after. */
const PRINT_DIR = "print";

/**
 * Loads a printable document into an offscreen window AS A FILE, and returns how to clean up.
 *
 * 🔴 WHY NOT A `data:` URL, WHICH IS WHAT THIS DID UNTIL 2026-10-10. A `data:` document has an
 * OPAQUE origin, and Chromium refuses to load a `file://` subresource into one. The invoice's logo
 * is a `file://` image, so it never loaded — and because the `<img>` carries `alt=""`, nothing
 * broken appeared either. Every finalized invoice printed from the installed build showed the
 * issuer's names, phones, customer, items and totals, and NO LOGO. That is the field defect.
 *
 * MEASURED, not reasoned, with a positive control: the same HTML, the same image and the same
 * Chromium render the logo when the document is loaded as `file://` (20,000 logo pixels) and not at
 * all when it is loaded as `data:` (zero — a blank slot).
 *
 * This is also why CI never caught it. `scripts/invoice-pdf-samples.ts` writes its HTML to a real
 * file and loads `file://` — so the sample artifact showed the logo correctly while the product did
 * not. The two paths had quietly diverged; the samples now use this same function.
 *
 * Inlining the logo as a `data:` URI was the alternative and was REJECTED: it grows the top-level
 * URL by the whole image, and that ceiling could only be measured at 64KB here, so a large logo
 * could stop the entire document from loading. A file has no such ceiling.
 *
 * Written temp-then-rename like every other write in this app, and removed in a `finally`, so a
 * crash mid-render can leave a stale document but never a truncated one.
 */
function stagePrintable(html: string, name: string): { readonly url: string; readonly cleanup: () => void } {
  const dir = join(app.getPath("userData"), PRINT_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.html`);
  writeFileSync(`${path}.partial`, html, "utf8");
  renameSync(`${path}.partial`, path);
  return {
    url: pathToFileURL(path).toString(),
    cleanup: () => {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        log.warn("printable cleanup failed", { error: String(err) });
      }
    },
  };
}

/**
 * Renders a FINALIZED invoice to A4 PDF bytes in an offscreen window.
 *
 * The window runs with JavaScript DISABLED: the document is static HTML and needs none, and a print
 * surface that cannot execute script is one less thing to reason about. The HTML comes from
 * `renderInvoiceDocument`, which takes the frozen DTO and nothing else.
 */
async function renderInvoicePdf(invoiceId: string): Promise<{ pdf: Buffer; logoMissing: boolean }> {
  if (!invoices) throw new DomainError("NOT_AVAILABLE", "Invoices are not available");
  const view = toInvoiceViewDto(invoices.getInvoice(invoiceId));
  const logo = invoiceLogo(view.invoice.issuer ?? null);
  const html = renderInvoiceDocument(view, { logoUrl: logo.url });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  const staged = stagePrintable(html, "invoice-pdf");
  try {
    await win.loadURL(staged.url);
    const pdf = await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      // 🔴 Zero margins HERE on purpose: the document's own `@page { margin: 14mm 12mm }` is what
      // positions the invoice on the sheet, and it is what the unit tests assert. Electron's own
      // default of ~1cm would be added on top of it, silently narrowing the page the tests measured.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return { pdf, logoMissing: logo.missing };
  } finally {
    win.destroy();
    staged.cleanup();
  }
}

async function printInvoiceDocument(
  invoiceId: string,
): Promise<{ status: "printed" | "cancelled"; logoMissing: boolean }> {
  if (!invoices) throw new DomainError("NOT_AVAILABLE", "Invoices are not available");
  const view = toInvoiceViewDto(invoices.getInvoice(invoiceId));
  const logo = invoiceLogo(view.invoice.issuer ?? null);
  const html = renderInvoiceDocument(view, { logoUrl: logo.url });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  const staged = stagePrintable(html, "invoice-print");
  try {
    await win.loadURL(staged.url);
    const printed = await new Promise<boolean>((done) => {
      win.webContents.print({ silent: false, printBackground: true }, (success) => done(success));
    });
    log.info("invoice-printed", {
      id: invoiceId,
      number: view.invoice.invoiceNumber,
      printed,
      logoMissing: logo.missing,
    });
    return { status: printed ? "printed" : "cancelled", logoMissing: logo.missing };
  } finally {
    win.destroy();
    staged.cleanup();
  }
}

/** Native "save as" + the A4 PDF of the frozen invoice. */
async function saveInvoicePdfFile(invoiceId: string): Promise<(SavedFile & { logoMissing: boolean }) | null> {
  if (!mainWindow || !invoices) return null;
  const view = toInvoiceViewDto(invoices.getInvoice(invoiceId));
  const suggested = `invoice-${view.invoice.invoiceNumber ?? "draft"}.pdf`;
  const path = dialog.showSaveDialogSync(mainWindow, {
    title: "Save invoice PDF",
    defaultPath: join(app.getPath("documents"), suggested),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return null;
  const { pdf, logoMissing } = await renderInvoicePdf(invoiceId);
  writeFileSync(path, pdf);
  log.info("invoice-pdf-saved", {
    id: invoiceId,
    number: view.invoice.invoiceNumber,
    bytes: pdf.length,
    logoMissing,
  });
  return { fileName: basename(path), logoMissing };
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

// ── The Online Catalog export (slice G3) ───────────────────────────────────────────────────────
//
// 🔴 THE RENDERER NAMES NOTHING. It asks for an export; this chooses the folder, writes the
// package and answers with a summary. The same shape as every other file operation in this
// process, and for the same reason: a renderer that can name a destination can write anywhere.

/** The real filesystem, as the package writer's narrow interface. */
const packageFs: PackageFs = {
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  writeFile: (p, d) => writeFileSync(p, d),
  readFile: (p) => readFileSync(p),
  rename: (from, to) => renameSync(from, to),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  exists: (p) => existsSync(p),
  readdir: (p) => readdirSync(p),
  join: (...parts) => join(...parts),
};

/**
 * Chooses a destination folder and writes the package into it.
 *
 * Returns null when the owner dismissed the picker — nothing is created and nothing is reported as
 * an error, the same contract `pickCatalogFile` and `pickProductPhoto` already use.
 */
function exportOnlineCatalogPackage(
  service: PosService,
  snapshot: OnlineCatalogSnapshot,
): OnlineCatalogExportDto | null {
  if (!mainWindow) return null;
  // Looked up on `dialog` at call time so the E2E can stub it, like every other picker here.
  const picked = dialog.showOpenDialogSync(mainWindow, {
    title: "Choose where to save the online catalogue",
    properties: ["openDirectory", "createDirectory"],
  });
  const parentDir = picked?.[0];
  if (!parentDir) return null;

  const result = writeOnlineCatalogPackage({
    parentDir,
    document: snapshot.document,
    images: snapshot.images,
    // 🔴 THROUGH THE VERIFYING READ PATH. `productImageBytes` re-hashes what it read and refuses a
    // mismatch, so a corrupt row fails the export instead of being published.
    readImage: (imageId) => {
      const { meta, bytes } = service.productImageBytes(imageId);
      return { bytes, mime: meta.mime };
    },
    fs: packageFs,
    suffix: () => `${stampNow()}-${randomBytes(3).toString("hex")}`,
    log,
  });

  // Counted here rather than in the document: it is advice for the owner, not part of the
  // published contract, and the website has no use for it.
  const incomplete = snapshot.document.products.filter(
    (p) =>
      p.image === null ||
      p.name_en === null ||
      p.category === null ||
      p.brand === null ||
      (p.description_ar === null && p.description_en === null),
  ).length;

  return {
    folderName: result.folderName,
    products: result.products,
    images: result.images,
    incomplete,
  };
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
    // 🔴 THE PHONE SURFACE CLOSES BEFORE THE LEDGER DOES, and explicitly rather than by the process
    // dying. `appClosing()` ends the session and closes the socket; `void` because `will-quit`
    // cannot await, and the close is synchronous enough that the listener is already shut by the
    // time the event loop drains. The session is also ended in memory the instant this runs, so a
    // request arriving in the gap is refused by `checkAccess`, not served by a dying server.
    void phoneSessions.appClosing();
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
  // 🔴 MIGRATION 9'S TWO NEW TABLES, WIRED HERE — and until this line existed they were not.
  // Both dependencies are optional on PosService and both fail CLOSED, so a terminal without
  // them refused every category assignment with NOT_AVAILABLE rather than corrupting anything:
  // safe, and completely unusable. ON THE SAME `db` and the same transaction provider as
  // everything else, because a second connection would not be atomic with the product write.
  const categoryStore = new CategoryRepository(db);
  const productImageStore = new ProductImageRepository(db);
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
  // ONE audit repository, shared by PosService and the operator service. Two instances would be two
  // `nextSeq()` readers on the same table, which is safe only because they run inside the same
  // BEGIN IMMEDIATE — sharing it removes the need to rely on that at all.
  const auditStore = new AuditRepository(db, {
    appVersion: BUILD_INFO.version,
    schemaVersion: MIGRATIONS.length,
  });
  const ledger = db;
  const service = new PosService({
    repository: saleStore,
    pinStates: new PinStateRepository(db),
    catalog: start.catalog,
    catalogStore,
    categories: categoryStore,
    productImages: productImageStore,
    // 🔴 THE FIXTURE IS NO LONGER THE AUTHORITY. Migration 8 created real `operators` rows — both
    // fixture accounts preserved BY ID so every historical sales.cashier_id still resolves — and
    // `operators` below is what `login` and `listCashiers` read. The array stays only because a
    // terminal whose database predates the table would otherwise have no accounts at all; the
    // service ignores it whenever `operators` is present.
    cashiers: FIXTURE_CASHIERS,
    operators: new OperatorService({
      operators: new OperatorRepository(db),
      audit: auditStore,
      transact: (fn) => ledger.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
    }),
    terminal: FIXTURE_TERMINAL,
    // The durable audit trail (migration 5) and the transaction that binds it to the business
    // mutation. Both use THIS connection — there is no second database handle anywhere, because
    // atomicity across two connections would not be atomicity.
    auditStore,
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

  // The customer/supplier directory (migration 12), on THIS connection and THIS transaction
  // provider. Its actor comes from `service`, which owns the session and re-reads the live role —
  // so the directory has no session of its own to drift out of step with the till's.
  parties = new PartyService({
    parties: new PartyRepository(db),
    actor: () => {
      const cashier = service.currentCashier();
      if (!cashier) return null;
      const role = service.currentRole();
      return role === null ? null : { id: cashier.id, name: cashier.name, role };
    },
    transact: (fn) => {
      if (!db) throw new Error("ledger is not open");
      return db.transaction(fn).immediate();
    },
  });

  // The ledger (migration 13), on the SAME connection, the SAME transaction provider and the SAME
  // actor as the directory above — so "who is acting" cannot drift between the two, and a
  // statement is read inside the same database session that wrote the rows.
  ledgerService = new LedgerService({
    ledger: new LedgerRepository(db),
    parties: new PartyRepository(db),
    actor: () => {
      const cashier = service.currentCashier();
      if (!cashier) return null;
      const role = service.currentRole();
      return role === null ? null : { id: cashier.id, name: cashier.name, role };
    },
    transact: (fn) => {
      if (!db) throw new Error("ledger is not open");
      return db.transaction(fn).immediate();
    },
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone },
    saleCurrency: (saleId) => {
      if (!db) return null;
      const row = db.prepare("SELECT currency FROM sales WHERE id = ?").get(saleId) as
        | { currency: string }
        | undefined;
      return row?.currency ?? null;
    },
  });

  // The phone bridge reads this through its getter when a session starts.
  posService = service;

  registerIpc(service, {
    invoices,
    parties,
    ledger: ledgerService,
    pickInvoiceLogo,
    pickProductPhoto,
    printInvoice: printInvoiceDocument,
    saveInvoicePdf: saveInvoicePdfFile,
    saveCatalogExport,
    exportBackup: () => exportBackup(plan.ledgerPath),
    exportOnlineCatalog: (snapshot) => exportOnlineCatalogPackage(service, snapshot),
    // Slice H1. The bridge owns the listener, the port and the QR; the SERVICE owns who may open
    // one. Created unconditionally because a till with a window can always serve a phone — the
    // refusal, when there is no network, comes from the address selection with a real sentence.
    phoneSessions: phoneSessions,
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
