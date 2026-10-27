/**
 * Full backup package (Track 2, phase 1): build, verify, refuse.
 *
 * Synthetic data only, in a temp folder per test. The "shop" below is a live WAL ledger with cash
 * sales, two finalized invoices (one with a frozen logo, one legacy whose freeze failed), a
 * customer with debts, a direct collection and a Whish receipt allocated across two debts — plus
 * a userData folder holding the branding files and settings.json those rows refer to.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceService, type LogoVault } from "../../src/application/invoiceService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { COUNTED_TABLES } from "../../src/persistence/backup";
import {
  type BackupFs,
  type BackupManifest,
  BackupPackageError,
  type BackupPackageErrorCode,
  LIMITS,
  type ManifestFile,
  type MissingAsset,
  LOGO_EXTENSIONS,
  SOURCE_BRANDING_DIR,
  SOURCE_FROZEN_DIR,
  SOURCE_SETTINGS_FILE,
  classifyEntryPath,
  createFullBackup,
  fullBackupFolderName,
  isLiveLogoName,
  nodeBackupFs,
  verifyBackupPackage,
} from "../../src/persistence/backupPackage";
import { type Db, openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { type Harness, type TempDir, makeHarness, newKey, tempDir } from "../helpers/harness";

const NOW = new Date("2026-10-28T09:15:00.000Z");
const PNG_A = Buffer.from("fake-png-bytes-current-logo");
const PNG_OLD = Buffer.from("fake-png-bytes-older-logo");

let t: TempDir;
let h: Harness;
let userData: string;
let out: string;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const rel = (...p: string[]) => join(...p);

/** The real freezing rule from main.ts `freezeLogo`, writing real files into the temp userData. */
function realVault(fail = false): LogoVault {
  return {
    freeze(storedName) {
      if (fail) return null;
      const bytes = readFileSync(join(userData, SOURCE_BRANDING_DIR, storedName));
      const name = `${sha(bytes).slice(0, 32)}${storedName.slice(storedName.lastIndexOf(".")).toLowerCase()}`;
      const dir = join(userData, SOURCE_BRANDING_DIR, SOURCE_FROZEN_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), bytes);
      return name;
    },
  };
}

function invoiceService(vault: LogoVault): InvoiceService {
  return new InvoiceService({
    invoices: new InvoiceRepository(h.db),
    reconciliation: new ReconciliationRepository(h.db),
    company: h.companyStore,
    catalogStore: new CatalogRepository(h.db),
    products: h.service,
    sales: new SaleRepository(h.db),
    logoVault: vault,
    transact: (fn) => h.db.transaction(fn).immediate(),
    terminal: FIXTURE_TERMINAL,
    now: h.clock.now,
  });
}

function finalizeInvoice(vault: LogoVault): void {
  const svc = invoiceService(vault);
  const { invoice } = svc.createDraft();
  svc.addLine(invoice.id, { description: "صنف اختباري", unitLabel: "حبة", quantity: "1", unitPrice: "10.00", productId: null });
  svc.finalizeInvoice(invoice.id);
}

/** Populates the shop described in the header. Leaves the newest commits in the -wal on purpose. */
function seedShop(): { frozenName: string } {
  h.db.pragma("wal_autocheckpoint = 0");
  mkdirSync(join(userData, SOURCE_BRANDING_DIR), { recursive: true });
  writeFileSync(join(userData, SOURCE_BRANDING_DIR, "old-logo.png"), PNG_OLD);
  writeFileSync(join(userData, SOURCE_BRANDING_DIR, "shop-logo.png"), PNG_A);
  writeFileSync(join(userData, SOURCE_SETTINGS_FILE), JSON.stringify({ language: "ar" }));

  for (let i = 0; i < 3; i++) {
    h.service.createSale({
      idempotencyKey: newKey(),
      paymentMethod: "cash",
      lines: [{ productId: "prod-0003", quantityMilli: 1000 }],
      expectedTotalMinor: 199n,
    });
  }

  // Legacy invoice: the profile named old-logo.png and the freeze FAILED, so it resolves the live file.
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "old-logo.png" });
  finalizeInvoice(realVault(true));
  // Current invoice: frozen.
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "shop-logo.png" });
  finalizeInvoice(realVault());

  const c = h.parties.create({ kind: "customer", displayName: "محمد علي" }).party;
  const owe = (ref: string, minor: bigint) =>
    h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
  const a = owe("A", 6000n);
  const b = owe("B", 4000n);
  const d = owe("D", 2500n);
  h.ledger.settle({ obligationId: d.id, partyId: c.id, idempotencyKey: "pay-direct-0001", amountMinor: 1000n, method: "cash" });
  h.ledger.recordAllocatedReceipt({
    customerId: c.id,
    idempotencyKey: "receipt-key-0001",
    channel: "whish",
    reference: "WH-123",
    fundsConfirmed: true,
    currency: "USD",
    totalMinor: 10000n,
    allocations: [
      { obligationId: a.id, amountMinor: 6000n },
      { obligationId: b.id, amountMinor: 4000n },
    ],
  });
  return { frozenName: `${sha(PNG_A).slice(0, 32)}.png` };
}

const backup = (over: Partial<Parameters<typeof createFullBackup>[1]> = {}) =>
  createFullBackup(h.db, { userDataDir: userData, destDir: join(out, "pkg"), appVersion: "0.1.1", now: NOW, ...over });

const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
const writeManifest = (dir: string, m: unknown) => writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));

/** Re-signs every listed file, so a test can tamper with CONTENT and still pass the checksum step. */
type EditableManifest = Omit<BackupManifest, "schemaVersion" | "tableCounts" | "files" | "missingAssets"> & {
  schemaVersion: number;
  tableCounts: Record<string, number>;
  files: ManifestFile[];
  missingAssets: MissingAsset[];
};
function resign(dir: string, edit: (m: EditableManifest) => void = () => {}): void {
  const m = manifestOf(dir) as EditableManifest;
  edit(m);
  const files = m.files.map((f) => {
    const abs = join(dir, ...f.path.split("/"));
    const bytes = readFileSync(abs);
    return { ...f, size: bytes.length, sha256: sha(bytes) };
  });
  writeManifest(dir, { ...m, files });
}

function refusal(fn: () => unknown): BackupPackageErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof BackupPackageError) return e.code;
    throw e;
  }
  throw new Error("expected a BackupPackageError, nothing was thrown");
}

/** Every file under a folder with its SHA-256, to prove a verifier wrote nothing. */
function fingerprint(dir: string): Record<string, string> {
  const outMap: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), p);
      else outMap[p] = sha(readFileSync(join(d, e.name)));
    }
  };
  walk(dir, "");
  return outMap;
}

function allTableCounts(db: Database.Database | Db): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, Number((db.prepare(`SELECT count(*) AS c FROM "${n}"`).get() as { c: bigint | number }).c)]));
}

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  userData = join(t.dir, "userdata");
  out = join(t.dir, "usb");
  mkdirSync(userData);
  mkdirSync(out);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("createFullBackup — a complete package of a live shop", () => {
  it("writes ledger + frozen logo + live logos + settings, and the manifest describes exactly that", () => {
    const { frozenName } = seedShop();
    expect(existsSync(`${t.dbPath}-wal`)).toBe(true);
    const created = backup();

    expect(created.complete).toBe(true);
    expect(created.path).toBe(join(out, "pkg"));
    const m = created.manifest;
    expect(m).toMatchObject({
      format: "alzabt-pos-full-backup",
      formatVersion: 1,
      createdAt: NOW.toISOString(),
      appVersion: "0.1.1",
      schemaVersion: MIGRATIONS.length,
      liveLogo: "shop-logo.png",
      settings: "included",
      missingAssets: [],
    });
    expect(m.files.map((f) => `${f.role}:${f.path}`).sort()).toEqual(
      [
        "ledger:ledger.sqlite",
        `frozen-logo:branding/frozen/${frozenName}`,
        "live-logo:branding/live/old-logo.png",
        "live-logo:branding/live/shop-logo.png",
        "settings:settings.json",
      ].sort(),
    );
    expect(readFileSync(join(out, "pkg", "branding", "frozen", frozenName))).toEqual(PNG_A);
    expect(readFileSync(join(out, "pkg", "branding", "live", "old-logo.png"))).toEqual(PNG_OLD);
    // Nothing but the package itself in the destination's parent: no partial folder left behind.
    expect(readdirSync(out)).toEqual(["pkg"]);
    // And it verifies from disk, independently of the object that created it.
    expect(verifyBackupPackage(join(out, "pkg")).complete).toBe(true);
  });

  it("counts EVERY table in the snapshot — not only COUNTED_TABLES — and equals the live ledger", () => {
    seedShop();
    const m = backup().manifest;
    const live = allTableCounts(h.db);
    expect(m.tableCounts).toEqual(live);
    for (const tname of COUNTED_TABLES) expect(Object.keys(m.tableCounts)).toContain(tname);
    expect(m.tableCounts.sales).toBe(5); // 3 cash sales + the sale each of the 2 finalized invoices records
    expect(m.tableCounts.invoices).toBe(2);
    expect(m.tableCounts.receipts).toBe(1);
  });

  it("🔴 the packaged ledger holds the money exactly: rows, idempotency keys, FKs and integrity", () => {
    seedShop();
    backup();
    const copy = new Database(join(out, "pkg", "ledger.sqlite"), { readonly: true, fileMustExist: true });
    copy.defaultSafeIntegers(true);
    try {
      for (const table of [
        "sales",
        "sale_lines",
        "invoices",
        "invoice_lines",
        "parties",
        "obligations",
        "settlements",
        "receipts",
        "receipt_attempts",
        "receipt_attempt_lines",
        "collection_attempts",
      ]) {
        const q = `SELECT * FROM ${table} ORDER BY rowid`;
        expect(copy.prepare(q).all(), table).toEqual(h.db.prepare(q).all());
      }
      const keys = (db: Database.Database | Db) =>
        db.prepare("SELECT idempotency_key, request_fingerprint, receipt_id FROM settlements ORDER BY idempotency_key").all();
      expect(keys(copy)).toEqual(keys(h.db));
      expect((copy.prepare("SELECT count(*) AS n FROM settlements WHERE receipt_id IS NOT NULL").get() as { n: bigint }).n).toBe(2n);
      expect(copy.prepare("SELECT idempotency_key FROM receipts").all()).toEqual([{ idempotency_key: "receipt-key-0001" }]);
      expect(copy.pragma("foreign_key_check")).toEqual([]);
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      copy.close();
    }
  });

  it("🔴 a ledger opened from the package recognises the SAME receipt key as a duplicate — no second receipt", () => {
    seedShop();
    backup();
    h.db.close();
    const replayPath = join(t.dir, "replay.sqlite");
    copyFileSync(join(out, "pkg", "ledger.sqlite"), replayPath);
    h = makeHarness(replayPath);
    const c = h.db.prepare("SELECT id FROM parties").get() as { id: string };
    const [a, b] = h.db.prepare("SELECT id FROM obligations WHERE source_ref IN ('A','B') ORDER BY source_ref").all() as Array<{ id: string }>;
    const before = allTableCounts(h.db);
    const again = h.ledger.recordAllocatedReceipt({
      customerId: c.id,
      idempotencyKey: "receipt-key-0001",
      channel: "whish",
      reference: "WH-123",
      fundsConfirmed: true,
      currency: "USD",
      totalMinor: 10000n,
      allocations: [
        { obligationId: a!.id, amountMinor: 6000n },
        { obligationId: b!.id, amountMinor: 4000n },
      ],
    });
    expect(again.duplicate).toBe(true);
    expect(allTableCounts(h.db).receipts).toBe(before.receipts);
    expect(allTableCounts(h.db).settlements).toBe(before.settlements);
  });

  it("verifying writes nothing: every file's bytes and the folder listing are unchanged", () => {
    seedShop();
    backup();
    const before = fingerprint(join(out, "pkg"));
    verifyBackupPackage(join(out, "pkg"));
    verifyBackupPackage(join(out, "pkg"));
    expect(fingerprint(join(out, "pkg"))).toEqual(before);
  });

  it("a ledger at an OLDER schema is packaged and verifies, with its own schema version", () => {
    h.db.close();
    const oldPath = join(t.dir, "v17.sqlite");
    const old = openDatabase(oldPath, MIGRATIONS.slice(0, 17));
    try {
      const created = createFullBackup(old, { userDataDir: userData, destDir: join(out, "old"), appVersion: "0.1.1", now: NOW });
      expect(created.manifest.schemaVersion).toBe(17);
      expect(verifyBackupPackage(join(out, "old")).manifest.schemaVersion).toBe(17);
    } finally {
      old.close();
    }
    h = makeHarness(t.dbPath);
  });
});

describe("missing and optional files — recorded, never hidden", () => {
  it("a frozen logo absent at the source: package written, complete=false, the absence named", () => {
    const { frozenName } = seedShop();
    rmSync(join(userData, "branding", "frozen", frozenName));
    const created = backup();
    expect(created.complete).toBe(false);
    expect(created.manifest.missingAssets).toEqual([{ kind: "frozen-logo", name: frozenName, reason: "absent-at-source" }]);
    expect(verifyBackupPackage(join(out, "pkg")).complete).toBe(false);
  });

  it("a frozen logo whose bytes no longer match its name is NOT packaged: content-mismatch", () => {
    const { frozenName } = seedShop();
    writeFileSync(join(userData, "branding", "frozen", frozenName), Buffer.from("tampered"));
    const created = backup();
    expect(created.manifest.missingAssets).toEqual([{ kind: "frozen-logo", name: frozenName, reason: "content-mismatch" }]);
    expect(existsSync(join(out, "pkg", "branding", "frozen", frozenName))).toBe(false);
  });

  it("a legacy invoice's live logo absent at the source is recorded as a missing live-logo", () => {
    seedShop();
    rmSync(join(userData, "branding", "old-logo.png"));
    const created = backup();
    expect(created.manifest.missingAssets).toEqual([{ kind: "live-logo", name: "old-logo.png", reason: "absent-at-source" }]);
  });

  it("a referenced name that is not a safe file name is never joined to a path: unsafe-name", () => {
    seedShop();
    h.db.prepare("UPDATE company_profile SET logo_path = '../../etc/passwd.png'").run();
    const created = backup();
    expect(created.manifest.missingAssets).toContainEqual({ kind: "live-logo", name: "../../etc/passwd.png", reason: "unsafe-name" });
    expect(verifyBackupPackage(join(out, "pkg")).complete).toBe(false);
  });

  it("settings.json is optional: absent → 'absent', invalid → 'invalid-at-source'; completeness unaffected", () => {
    seedShop();
    rmSync(join(userData, "settings.json"));
    const absent = backup({ destDir: join(out, "a") });
    expect(absent.manifest.settings).toBe("absent");
    expect(absent.complete).toBe(true);
    expect(existsSync(join(out, "a", "settings.json"))).toBe(false);

    writeFileSync(join(userData, "settings.json"), "{not json");
    const bad = backup({ destDir: join(out, "b") });
    expect(bad.manifest.settings).toBe("invalid-at-source");
    expect(bad.complete).toBe(true);
    expect(existsSync(join(out, "b", "settings.json"))).toBe(false);
  });

  it("a shop with no logo and no invoices packages just the ledger (and settings)", () => {
    const created = backup();
    expect(created.manifest.files.map((f) => f.path)).toEqual(["ledger.sqlite"]);
    expect(created.complete).toBe(true);
    expect(existsSync(join(out, "pkg", "branding"))).toBe(false);
  });

  it("🔴 an incomplete package cannot be made to look complete by editing its manifest", () => {
    const { frozenName } = seedShop();
    rmSync(join(userData, "branding", "frozen", frozenName));
    const pkg = backup().path;
    // Drop the declared absence: the ledger still references the asset, so the lie is visible.
    resign(pkg, (m) => {
      m.missingAssets = [];
    });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("REFERENCE_MISMATCH");
  });

  it("an asset that is present cannot also be declared missing", () => {
    const { frozenName } = seedShop();
    const pkg = backup().path;
    resign(pkg, (m) => {
      m.missingAssets = [{ kind: "frozen-logo", name: frozenName, reason: "absent-at-source" }];
    });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("REFERENCE_MISMATCH");
  });
});

describe("files that change while they are being copied", () => {
  /** nodeBackupFs that rewrites `source` right after copying it, `times` times. */
  function churning(match: (from: string) => boolean, times: number): BackupFs {
    let left = times;
    let version = 0;
    return {
      ...nodeBackupFs,
      copyFile(from, to) {
        nodeBackupFs.copyFile(from, to);
        if (match(from) && left > 0) {
          left -= 1;
          writeFileSync(from, Buffer.from(`replaced-while-copying-${++version}`));
        }
      },
    };
  }
  const isLive = (p: string) => p === join(userData, "branding", "old-logo.png");

  it("a live logo replaced once mid-copy is copied again, and the package holds the settled bytes", () => {
    seedShop();
    const created = backup({ fs: churning(isLive, 1) });
    expect(created.complete).toBe(true);
    expect(readFileSync(join(out, "pkg", "branding", "live", "old-logo.png")).toString()).toBe("replaced-while-copying-1");
    expect(verifyBackupPackage(join(out, "pkg")).complete).toBe(true);
  });

  it("🔴 a live logo that never settles is NOT packaged as whole: changed-during-backup, complete=false", () => {
    seedShop();
    const created = backup({ fs: churning(isLive, Number.POSITIVE_INFINITY) });
    expect(created.complete).toBe(false);
    expect(created.manifest.missingAssets).toEqual([{ kind: "live-logo", name: "old-logo.png", reason: "changed-during-backup" }]);
    expect(existsSync(join(out, "pkg", "branding", "live", "old-logo.png"))).toBe(false);
    expect(verifyBackupPackage(join(out, "pkg")).complete).toBe(false);
  });

  it("a frozen asset that never settles is recorded the same way", () => {
    const { frozenName } = seedShop();
    const created = backup({ fs: churning((p) => p.endsWith(frozenName), Number.POSITIVE_INFINITY) });
    expect(created.manifest.missingAssets).toEqual([{ kind: "frozen-logo", name: frozenName, reason: "changed-during-backup" }]);
  });

  it("settings.json that never settles is left out, named, and does not make the package incomplete", () => {
    seedShop();
    const created = backup({ fs: churning((p) => p === join(userData, "settings.json"), Number.POSITIVE_INFINITY) });
    expect(created.manifest.settings).toBe("changed-during-backup");
    expect(created.complete).toBe(true);
    expect(existsSync(join(out, "pkg", "settings.json"))).toBe(false);
  });
});

describe("verifyBackupPackage — refusals", () => {
  let pkg: string;
  let frozen: string;
  beforeEach(() => {
    frozen = seedShop().frozenName;
    pkg = backup().path;
  });

  it("no manifest (an assembly that stopped early) → NOT_A_PACKAGE; missing folder → NOT_A_PACKAGE", () => {
    rmSync(join(pkg, "manifest.json"));
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("NOT_A_PACKAGE");
    expect(refusal(() => verifyBackupPackage(join(out, "nope")))).toBe("NOT_A_PACKAGE");
  });

  it("truncated or foreign manifest → MANIFEST_INVALID / UNSUPPORTED_FORMAT", () => {
    const text = readFileSync(join(pkg, "manifest.json"), "utf8");
    writeFileSync(join(pkg, "manifest.json"), text.slice(0, text.length / 2));
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("MANIFEST_INVALID");
    writeManifest(pkg, { ...JSON.parse(text), formatVersion: 2 });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("UNSUPPORTED_FORMAT");
  });

  it("one flipped byte in the ledger → CHECKSUM_MISMATCH", () => {
    const p = join(pkg, "ledger.sqlite");
    const bytes = readFileSync(p);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(p, bytes);
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("CHECKSUM_MISMATCH");
  });

  it("a missing listed file → MISSING_FILE", () => {
    rmSync(join(pkg, "branding", "live", "old-logo.png"));
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("MISSING_FILE");
  });

  it("a frozen logo whose content was swapped AND re-signed → CONTENT_ADDRESS_MISMATCH", () => {
    writeFileSync(join(pkg, "branding", "frozen", frozen), Buffer.from("other bytes"));
    resign(pkg);
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("CONTENT_ADDRESS_MISMATCH");
  });

  it("a manifest table count that differs from the ledger → COUNT_MISMATCH", () => {
    resign(pkg, (m) => {
      m.tableCounts.receipts = 2;
    });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("COUNT_MISMATCH");
  });

  it("a manifest schema version that differs from the ledger → SCHEMA_MISMATCH", () => {
    resign(pkg, (m) => {
      m.schemaVersion = 17;
    });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("SCHEMA_MISMATCH");
  });

  it("🔴 a ledger NEWER than this build → SCHEMA_NEWER (decided from the ledger, not appVersion)", () => {
    expect(refusal(() => verifyBackupPackage(pkg, { migrations: MIGRATIONS.slice(0, MIGRATIONS.length - 1) }))).toBe("SCHEMA_NEWER");
  });

  it("a re-signed ledger with a foreign-key violation → FOREIGN_KEY_VIOLATION", () => {
    const p = join(pkg, "ledger.sqlite");
    const db = new Database(p);
    db.pragma("foreign_keys = OFF");
    db.exec("CREATE TABLE zz_orphan (party_id TEXT REFERENCES parties(id)); INSERT INTO zz_orphan VALUES ('nobody');");
    db.close();
    resign(pkg, (m) => {
      m.tableCounts.zz_orphan = 1;
    });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("FOREIGN_KEY_VIOLATION");
  });

  it("a WAL-mode ledger (not a standalone snapshot) → LEDGER_NOT_STANDALONE", () => {
    h.db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(t.dbPath, join(pkg, "ledger.sqlite"));
    resign(pkg);
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("LEDGER_NOT_STANDALONE");
  });

  it("a non-SQLite ledger → LEDGER_CORRUPT", () => {
    writeFileSync(join(pkg, "ledger.sqlite"), Buffer.alloc(4096, 7));
    resign(pkg);
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("LEDGER_CORRUPT");
  });

  it.each([
    ["../evil.png"],
    ["/etc/passwd"],
    ["C:/Windows/evil.png"],
    ["branding\\live\\x.png"],
    ["branding/live/../../x.png"],
    ["branding/frozen/not-a-hash.png"],
    ["branding/live/x.exe"],
    ["branding/live/con.png"],
    ["branding/live/.hidden.png"],
    ["branding/other/x.png"],
  ])("manifest path %j → UNSAFE_PATH, refused before any file is opened", (path) => {
    const m = manifestOf(pkg);
    writeManifest(pkg, { ...m, files: [...m.files, { path, role: "live-logo", size: 1, sha256: "0".repeat(64) }] });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("UNSAFE_PATH");
  });

  it("the same file listed twice, differing only in case → DUPLICATE_ENTRY", () => {
    const m = manifestOf(pkg);
    const live = m.files.find((f) => f.path === "branding/live/old-logo.png")!;
    writeManifest(pkg, { ...m, files: [...m.files, { ...live, path: "branding/live/OLD-logo.png" }] });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("DUPLICATE_ENTRY");
  });

  it("an undeclared file → UNDECLARED_ENTRY; OS litter (Thumbs.db, ._x, .DS_Store) is ignored", () => {
    writeFileSync(join(pkg, "branding", "live", "Thumbs.db"), "x");
    writeFileSync(join(pkg, "._ledger.sqlite"), "x");
    writeFileSync(join(pkg, ".DS_Store"), "x");
    expect(verifyBackupPackage(pkg).complete).toBe(true);
    writeFileSync(join(pkg, "branding", "live", "extra.png"), "x");
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("UNDECLARED_ENTRY");
  });

  it("an unexpected folder → UNDECLARED_ENTRY", () => {
    mkdirSync(join(pkg, "branding", "frozen", "nested"));
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("UNDECLARED_ENTRY");
  });

  it("a symlink anywhere in the package — or the package itself — → SYMLINK", () => {
    const target = join(userData, "branding", "shop-logo.png");
    rmSync(join(pkg, "branding", "live", "old-logo.png"));
    symlinkSync(target, join(pkg, "branding", "live", "old-logo.png"));
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("SYMLINK");
    const link = join(out, "link-to-pkg");
    symlinkSync(pkg, link);
    expect(refusal(() => verifyBackupPackage(link))).toBe("SYMLINK");
  });

  it("an oversized logo → TOO_LARGE, decided from its size before it is hashed", () => {
    writeFileSync(join(pkg, "branding", "live", "old-logo.png"), Buffer.alloc(LIMITS.assetBytes + 1));
    resign(pkg);
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("TOO_LARGE");
  });

  it("a referenced asset neither included nor declared missing → REFERENCE_MISMATCH", () => {
    rmSync(join(pkg, "branding", "frozen", frozen));
    resign(pkg, (m) => {
      m.files = m.files.filter((f) => f.role !== "frozen-logo");
    });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("REFERENCE_MISMATCH");
  });

  it("a missing asset the ledger does not reference → REFERENCE_MISMATCH", () => {
    resign(pkg, (m) => {
      m.missingAssets = [{ kind: "live-logo", name: "ghost.png", reason: "absent-at-source" }];
    });
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("REFERENCE_MISMATCH");
  });

  it("an invalid settings.json, re-signed → SETTINGS_INVALID", () => {
    writeFileSync(join(pkg, "settings.json"), "[1,2");
    resign(pkg);
    expect(refusal(() => verifyBackupPackage(pkg))).toBe("SETTINGS_INVALID");
  });
});

describe("createFullBackup — failure never publishes a package", () => {
  /** nodeBackupFs with one operation failing on its n-th call. */
  function failing(op: keyof BackupFs, when: (args: string[]) => boolean): BackupFs {
    return {
      ...nodeBackupFs,
      [op]: (...args: string[]) => {
        if (when(args)) throw new Error(`injected ${op} failure`);
        return (nodeBackupFs[op] as (...a: string[]) => unknown)(...args);
      },
    } as BackupFs;
  }

  it.each<[string, keyof BackupFs, (a: string[]) => boolean]>([
    ["copying a logo", "copyFile", (a) => a[1]!.includes(rel("branding", "frozen"))],
    ["hashing the ledger", "sha256", (a) => a[0]!.endsWith("ledger.sqlite")],
    ["writing the manifest", "writeFile", (a) => a[0]!.endsWith("manifest.json.tmp")],
    ["publishing (final rename)", "rename", (a) => a[1] === join(out, "pkg")],
  ])("a failure while %s → CREATE_FAILED, no package, no partial folder", (_label, op, when) => {
    seedShop();
    expect(refusal(() => backup({ fs: failing(op, when) }))).toBe("CREATE_FAILED");
    expect(existsSync(join(out, "pkg"))).toBe(false);
    expect(readdirSync(out)).toEqual([]);
  });

  it("publish AND cleanup both failing leaves a `.partial-` folder that verifies — content is not publication", () => {
    seedShop();
    const stuck: BackupFs = {
      ...nodeBackupFs,
      rename(from, to) {
        if (to === join(out, "pkg")) throw new Error("injected publish failure");
        nodeBackupFs.rename(from, to);
      },
      removeTree(p) {
        if (p.includes(".partial-") && !p.includes("branding")) throw new Error("injected cleanup failure (drive pulled)");
        nodeBackupFs.removeTree(p);
      },
    };
    expect(refusal(() => backup({ fs: stuck }))).toBe("CREATE_FAILED");
    const left = readdirSync(out);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^pkg\.partial-[0-9a-f]{12}$/);
    // 🔴 It passes the CONTENT check. Only its name marks it unpublished — the restore phase must
    // refuse it by that name (backupPackage.ts, restore requirement 8).
    expect(verifyBackupPackage(join(out, left[0]!)).complete).toBe(true);
  });

  it("an existing destination is never replaced → DESTINATION_EXISTS, its contents untouched", () => {
    seedShop();
    mkdirSync(join(out, "pkg"));
    writeFileSync(join(out, "pkg", "keep.txt"), "older backup");
    expect(refusal(() => backup())).toBe("DESTINATION_EXISTS");
    expect(readdirSync(join(out, "pkg"))).toEqual(["keep.txt"]);
    expect(readdirSync(out)).toEqual(["pkg"]);
  });

  it("a destination that appears while the package is being built is not overwritten", () => {
    seedShop();
    let destChecks = 0;
    const racing: BackupFs = {
      ...nodeBackupFs,
      stat(p) {
        if (p === join(out, "pkg") && ++destChecks === 2) mkdirSync(join(out, "pkg"));
        return nodeBackupFs.stat(p);
      },
    };
    expect(refusal(() => backup({ fs: racing }))).toBe("DESTINATION_EXISTS");
    expect(readdirSync(join(out, "pkg"))).toEqual([]);
    expect(readdirSync(out)).toEqual(["pkg"]);
  });

  it("a package that fails its own verification is not published", () => {
    seedShop();
    // Corrupt the packaged copy of the live logo AFTER the manifest has recorded it (hash #1 is the
    // stable-copy check, hash #2 is the manifest's) and before the self-verification reads it.
    let copyHashes = 0;
    const sneaky: BackupFs = {
      ...nodeBackupFs,
      sha256(p) {
        const r = nodeBackupFs.sha256(p);
        if (p.endsWith(rel("live", "old-logo.png")) && p.includes(".partial-") && ++copyHashes === 2) {
          writeFileSync(p, "changed after hashing");
        }
        return r;
      },
    };
    expect(refusal(() => backup({ fs: sneaky }))).toBe("CHECKSUM_MISMATCH");
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("contract pins — the names this module mirrors from main/", () => {
  const mainTs = readFileSync(join(__dirname, "../../src/main/main.ts"), "utf8");
  const settingsTs = readFileSync(join(__dirname, "../../src/main/settingsStore.ts"), "utf8");

  it("userData layout and logo extensions match main.ts and settingsStore.ts", () => {
    expect(mainTs).toContain(`const BRANDING_DIR = "${SOURCE_BRANDING_DIR}";`);
    expect(mainTs).toContain(`const FROZEN_DIR = "${SOURCE_FROZEN_DIR}";`);
    expect(mainTs).toContain(`const LOGO_EXTENSIONS = ${JSON.stringify(LOGO_EXTENSIONS).replace(/,/g, ", ")};`);
    expect(settingsTs).toContain(`export const SETTINGS_FILE = "${SOURCE_SETTINGS_FILE}";`);
  });

  it("the content-address rule matches freezeLogo: sha256 hex cut to 32 + the lowercased extension", () => {
    expect(mainTs).toContain('const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);');
    expect(mainTs).toContain("const name = `${hash}${extname(storedName).toLowerCase()}`;");
  });

  it("names and folder names", () => {
    expect(fullBackupFolderName(NOW)).toBe("alzabt-pos-fullbackup-20261028T091500Z");
    expect(isLiveLogoName("invoice-logo.png")).toBe(true);
    expect(isLiveLogoName("invoice-logo.PNG")).toBe(true);
    expect(isLiveLogoName("nul.jpg")).toBe(false);
    expect(classifyEntryPath("ledger.sqlite")).toEqual({ role: "ledger", name: "ledger.sqlite" });
    expect(classifyEntryPath("./ledger.sqlite")).toBeNull();
  });
});
