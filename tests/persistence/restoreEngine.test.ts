/**
 * Restore engine (Track 2, phase 2): stage → apply at startup, with a journal that survives a
 * crash at ANY file operation and rolls back on any failure.
 *
 * Synthetic data only, in temp folders. Built once per file:
 *   - a SOURCE shop (sales, a frozen-logo invoice, a legacy invoice, a customer with debts, a direct
 *     collection, a Whish receipt over two debts) and two packages of it — complete, and missing
 *     its frozen logo;
 *   - a TARGET profile: a different ledger copied WHILE OPEN, so it carries a real -wal/-shm whose
 *     committed sales exist nowhere else, plus its own branding, settings and ledger.json.
 * Every test restores into a fresh copy of the target.
 */
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvoiceService, type LogoVault } from "../../src/application/invoiceService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { resolveInvoiceLogo } from "../../src/main/invoiceLogo";
import { type BackupFs, type BackupManifest, createFullBackup, nodeBackupFs } from "../../src/persistence/backupPackage";
import { openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import {
  type ApplyOutcome,
  LIVE_LEDGER_FILE,
  type RestoreConsent,
  RestoreError,
  type RestoreErrorCode,
  applyPendingRestore,
  inspectRestorePackage,
  stageRestore,
} from "../../src/persistence/restoreEngine";
import { type Harness, makeHarness, newKey } from "../helpers/harness";

const NOW = new Date("2026-10-28T10:00:00.000Z");
const LATER = new Date("2026-10-28T10:05:00.000Z");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let root: string;
let pkg: string; // complete
let pkgIncomplete: string; // frozen logo missing at the source
let template: string; // the target profile, never modified
let originalTemplateSales: number;

// ── Source shop ───────────────────────────────────────────────────────────────────────────────

function seedSource(h: Harness, userData: string): void {
  const vault = (fail: boolean): LogoVault => ({
    freeze(storedName) {
      if (fail) return null;
      const bytes = readFileSync(join(userData, "branding", storedName));
      const name = `${sha(bytes).slice(0, 32)}.png`;
      mkdirSync(join(userData, "branding", "frozen"), { recursive: true });
      writeFileSync(join(userData, "branding", "frozen", name), bytes);
      return name;
    },
  });
  const finalize = (fail: boolean) => {
    const svc = new InvoiceService({
      invoices: new InvoiceRepository(h.db),
      reconciliation: new ReconciliationRepository(h.db),
      company: h.companyStore,
      catalogStore: new CatalogRepository(h.db),
      products: h.service,
      sales: new SaleRepository(h.db),
      logoVault: vault(fail),
      transact: (fn) => h.db.transaction(fn).immediate(),
      terminal: FIXTURE_TERMINAL,
      now: h.clock.now,
    });
    const { invoice } = svc.createDraft();
    svc.addLine(invoice.id, { description: "صنف", unitLabel: "حبة", quantity: "1", unitPrice: "10.00", productId: null });
    svc.finalizeInvoice(invoice.id);
  };
  mkdirSync(join(userData, "branding"), { recursive: true });
  writeFileSync(join(userData, "branding", "old-logo.png"), "SOURCE OLD LOGO");
  writeFileSync(join(userData, "branding", "shop-logo.png"), "SOURCE CURRENT LOGO");
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ language: "ar" }));
  for (let i = 0; i < 3; i++) {
    h.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
  }
  h.invoices.saveCompanyProfile({ nameAr: "متجر المصدر", logoPath: "old-logo.png" });
  finalize(true); // legacy: no archived logo, prints none (`unverified`); old-logo.png is not packaged
  h.invoices.saveCompanyProfile({ nameAr: "متجر المصدر", logoPath: "shop-logo.png" });
  finalize(false); // frozen
  const c = h.parties.create({ kind: "customer", displayName: "محمد علي" }).party;
  const owe = (ref: string, minor: bigint) =>
    h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: ref, currency: "USD", amountMinor: minor }).record;
  const a = owe("A", 6000n);
  const b = owe("B", 4000n);
  const d = owe("D", 2500n);
  h.ledger.settle({ obligationId: d.id, partyId: c.id, idempotencyKey: "pay-direct-0001", amountMinor: 1000n, method: "cash" });
  h.ledger.recordAllocatedReceipt(receiptRequest(c.id, a.id, b.id));
}

function receiptRequest(customerId: string, a: string, b: string) {
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

const MONEY_TABLES = ["sales", "sale_lines", "invoices", "invoice_lines", "parties", "obligations", "settlements", "receipts", "receipt_attempts", "receipt_attempt_lines", "collection_attempts"];

function rowsOf(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  try {
    return Object.fromEntries(MONEY_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

/** Sales in a ledger, read through a COPY of its folder so the -wal is honoured and nothing is written. */
function salesIn(dir: string): number {
  const scratch = mkdtempSync(join(root, "read-"));
  for (const f of readdirSync(dir).filter((n) => n.startsWith(LIVE_LEDGER_FILE))) copyFileSync(join(dir, f), join(scratch, f));
  const db = new Database(join(scratch, LIVE_LEDGER_FILE), { fileMustExist: true });
  try {
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    return Number((db.prepare("SELECT count(*) AS n FROM sales").get() as { n: number }).n);
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "alzabt-pos-restore-"));

  const srcUser = join(root, "source-userdata");
  mkdirSync(srcUser);
  const h = makeHarness(join(root, "source.sqlite"));
  try {
    seedSource(h, srcUser);
    pkg = createFullBackup(h.db, { userDataDir: srcUser, destDir: join(root, "pkg"), appVersion: "0.1.1", now: NOW }).path;
    for (const f of readdirSync(join(srcUser, "branding", "frozen"))) rmSync(join(srcUser, "branding", "frozen", f));
    const inc = createFullBackup(h.db, { userDataDir: srcUser, destDir: join(root, "pkg-incomplete"), appVersion: "0.1.1", now: NOW });
    expect(inc.complete).toBe(false);
    pkgIncomplete = inc.path;
  } finally {
    h.db.close();
  }

  // The target: a ledger copied while open → its -wal holds committed sales the main file lacks.
  template = join(root, "target-template");
  mkdirSync(join(template, "branding", "frozen"), { recursive: true });
  const live = join(root, "target-live");
  mkdirSync(live);
  const t = makeHarness(join(live, LIVE_LEDGER_FILE));
  try {
    t.db.pragma("wal_autocheckpoint = 0");
    for (let i = 0; i < 2; i++) {
      t.service.createSale({ idempotencyKey: newKey(), paymentMethod: "cash", lines: [{ productId: "prod-0003", quantityMilli: 1000 }], expectedTotalMinor: 199n });
    }
    for (const f of readdirSync(live)) copyFileSync(join(live, f), join(template, f));
  } finally {
    t.db.close();
  }
  expect(existsSync(join(template, `${LIVE_LEDGER_FILE}-wal`))).toBe(true);
  writeFileSync(join(template, "branding", "invoice-logo.png"), "TARGET LIVE LOGO");
  writeFileSync(join(template, "branding", "frozen", `${"a".repeat(32)}.png`), "TARGET FROZEN");
  writeFileSync(join(template, "settings.json"), JSON.stringify({ language: "en" }));
  writeFileSync(join(template, "ledger.json"), JSON.stringify({ ledgerFile: LIVE_LEDGER_FILE }));
  originalTemplateSales = salesIn(template);
  expect(originalTemplateSales).toBe(2);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

let envSeq = 0;
/** A fresh copy of the target profile. */
function env(): string {
  const dir = join(root, `user-${++envSeq}`);
  cpSync(template, dir, { recursive: true });
  return dir;
}

/** Every file under a profile except the restore/ folder, with its SHA-256. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (p === "restore") continue;
      if (e.isDirectory()) walk(join(d, e.name), p);
      else out[p] = sha(readFileSync(join(d, e.name)));
    }
  };
  walk(dir, "");
  return out;
}

const ORIGINAL = () => fingerprint(template);

/** What a profile must hold after restoring `packageDir`: the package's files, plus the untouched marker. */
function restoredFingerprint(packageDir: string): Record<string, string> {
  const m = JSON.parse(readFileSync(join(packageDir, "manifest.json"), "utf8")) as BackupManifest;
  const out: Record<string, string> = { "ledger.json": ORIGINAL()["ledger.json"]! };
  for (const f of m.files) {
    const target =
      f.role === "ledger" ? LIVE_LEDGER_FILE
      : f.role === "settings" ? "settings.json"
      : f.role === "frozen-logo" ? f.path
      : `branding/${f.path.slice("branding/live/".length)}`;
    out[target] = f.sha256;
  }
  return out;
}

function consentFor(packageDir: string, acceptMissing = false): RestoreConsent {
  const p = inspectRestorePackage(packageDir);
  return { manifestSha256: p.manifestSha256, acceptedMissingAssets: acceptMissing ? p.missingAssets : [] };
}

const stage = (userDataDir: string, packageDir = pkg, consent = consentFor(packageDir), fs?: BackupFs) =>
  stageRestore({ userDataDir, packageDir, consent, now: NOW, ...(fs ? { fs } : {}) });

const apply = (userDataDir: string, fs?: BackupFs): ApplyOutcome => applyPendingRestore({ userDataDir, now: LATER, ...(fs ? { fs } : {}) });

function refusal(fn: () => unknown): RestoreErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof RestoreError) return e.code;
    throw e;
  }
  throw new Error("expected a RestoreError, nothing was thrown");
}

const journalExists = (u: string) => existsSync(join(u, "restore", "journal.json"));

// ── Fault injection ───────────────────────────────────────────────────────────────────────────

/**
 * The STAGED ledger (…/staging-<id>/ledger.sqlite) — not the live `alzabt-pos-ledger.sqlite`,
 * which also ends in "ledger.sqlite" and is moved first, while the original state is preserved.
 */
const isStagedLedger = (p: string) => /[\\/]staging-[^\\/]+[\\/]ledger\.sqlite$/.test(p);

const MUTATING: ReadonlyArray<keyof BackupFs> =["mkdir", "copyFile", "writeFile", "rename", "removeTree"];

/** nodeBackupFs with hooks around every MUTATING call, and a "process is dead" switch. */
function instrumented(hooks: {
  before?: (op: keyof BackupFs, args: string[]) => void;
  after?: (op: keyof BackupFs, args: string[]) => void;
  dead?: () => boolean;
}): BackupFs {
  const fs: Record<string, unknown> = {};
  for (const key of Object.keys(nodeBackupFs) as Array<keyof BackupFs>) {
    fs[key] = (...args: string[]) => {
      if (hooks.dead?.()) throw new Error("the process is dead");
      const mutating = MUTATING.includes(key);
      if (mutating) hooks.before?.(key, args);
      const r = (nodeBackupFs[key] as (...a: string[]) => unknown)(...args);
      if (mutating) hooks.after?.(key, args);
      return r;
    };
  }
  return fs as unknown as BackupFs;
}

/** Kills the "process" just before (or just after) its k-th mutating file operation. */
function crashAt(k: number, when: "before" | "after"): BackupFs {
  let n = 0;
  let dead = false;
  const hit = () => {
    if (++n === k) {
      dead = true;
      throw new Error(`power cut at operation ${k} (${when})`);
    }
  };
  return instrumented(when === "before" ? { before: hit, dead: () => dead } : { after: hit, dead: () => dead });
}

/** One real, non-fatal failure at the k-th mutating operation (the process keeps running). */
function failOnceAt(k: number): BackupFs {
  let n = 0;
  return instrumented({
    before: () => {
      if (++n === k) throw new Error(`injected failure at operation ${k}`);
    },
  });
}

/** How many mutating operations a clean apply performs. */
function cleanApplyOps(): number {
  const u = env();
  stage(u);
  let n = 0;
  const outcome = apply(u, instrumented({ before: () => void n++ }));
  expect(outcome.kind).toBe("restored");
  return n;
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe("a complete restore", () => {
  it("🔴 swaps ledger, branding and settings for the package's; keeps ledger.json; keeps the pre-restore copy", () => {
    const u = env();
    const before = fingerprint(u);
    const staged = stage(u);
    expect(fingerprint(u)).toEqual(before); // staging touches nothing the till uses
    expect(journalExists(u)).toBe(true);

    const outcome = apply(u);
    expect(outcome).toMatchObject({ kind: "restored", id: staged.id, complete: true, missingAssets: [] });
    expect(fingerprint(u)).toEqual(restoredFingerprint(pkg));
    expect(existsSync(join(u, `${LIVE_LEDGER_FILE}-wal`))).toBe(false); // no stale WAL beside it
    expect(journalExists(u)).toBe(false);
    expect(readdirSync(join(u, "restore")).sort()).toEqual(["last-restore.json", `pre-restore-${staged.id}`]);
    expect(JSON.parse(readFileSync(join(u, "restore", "last-restore.json"), "utf8"))).toMatchObject({ outcome: "restored", complete: true });
    expect(apply(u)).toEqual({ kind: "none" }); // and it does not run twice
  });

  it("🔴 the pre-restore copy is a WORKING copy of the old state — its -wal included", () => {
    const u = env();
    const { id } = stage(u);
    apply(u);
    const kept = join(u, "restore", `pre-restore-${id}`);
    expect(salesIn(kept)).toBe(originalTemplateSales);
    const original = ORIGINAL();
    const keptPrint = fingerprint(kept);
    for (const [p, h] of Object.entries(original)) if (p !== "ledger.json") expect(keptPrint[p], p).toBe(h);
  });

  it("🔴 the restored ledger opens, migrates nothing, and holds the money exactly", () => {
    const u = env();
    stage(u);
    apply(u);
    expect(rowsOf(join(u, LIVE_LEDGER_FILE))).toEqual(rowsOf(join(pkg, "ledger.sqlite")));
    const db = openDatabase(join(u, LIVE_LEDGER_FILE), MIGRATIONS, { fileMustExist: true });
    try {
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(Number((db.prepare("SELECT count(*) AS n FROM settlements WHERE receipt_id IS NOT NULL").get() as { n: bigint }).n)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("🔴 replaying the same receipt key on the restored ledger is a duplicate — no second receipt", () => {
    const u = env();
    stage(u);
    apply(u);
    const h = makeHarness(join(u, LIVE_LEDGER_FILE));
    try {
      const c = h.db.prepare("SELECT id FROM parties").get() as { id: string };
      const [a, b] = h.db.prepare("SELECT id FROM obligations WHERE source_ref IN ('A','B') ORDER BY source_ref").all() as Array<{ id: string }>;
      const n = (t: string) => Number((h.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: bigint }).n);
      const before = { receipts: n("receipts"), settlements: n("settlements") };
      const again = h.ledger.recordAllocatedReceipt(receiptRequest(c.id, a!.id, b!.id));
      expect(again.duplicate).toBe(true);
      expect({ receipts: n("receipts"), settlements: n("settlements") }).toEqual(before);
    } finally {
      h.db.close();
    }
  });

  it("restores into a fresh profile with no ledger, no branding and no marker", () => {
    const u = join(root, `fresh-${++envSeq}`);
    mkdirSync(u);
    stage(u);
    expect(apply(u).kind).toBe("restored");
    const expected = restoredFingerprint(pkg);
    delete expected["ledger.json"];
    expect(fingerprint(u)).toEqual(expected);
  });
});

describe("staging refuses — and touches nothing", () => {
  const untouched = (u: string) => {
    expect(fingerprint(u)).toEqual(ORIGINAL());
    expect(journalExists(u)).toBe(false);
  };

  it("an unpublished `.partial-` folder, even though its content verifies", () => {
    const u = env();
    const partial = join(root, `pkg.partial-${"0".repeat(12)}`);
    cpSync(pkg, partial, { recursive: true });
    expect(refusal(() => stage(u, partial, { manifestSha256: "0".repeat(64), acceptedMissingAssets: [] }))).toBe("PACKAGE_UNPUBLISHED");
    untouched(u);
  });

  it("a corrupt package → PACKAGE_INVALID (with the verifier's own code)", () => {
    const u = env();
    const bad = join(root, `pkg-bad-${++envSeq}`);
    cpSync(pkg, bad, { recursive: true });
    const p = join(bad, "ledger.sqlite");
    const bytes = readFileSync(p);
    bytes[200] = bytes[200]! ^ 0xff;
    writeFileSync(p, bytes);
    try {
      stage(u, bad, { manifestSha256: "0".repeat(64), acceptedMissingAssets: [] });
      throw new Error("not refused");
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreError);
      expect((e as RestoreError).code).toBe("PACKAGE_INVALID");
      expect((e as RestoreError).packageCode).toBe("CHECKSUM_MISMATCH");
    }
    untouched(u);
  });

  it("a package newer than this build → PACKAGE_INVALID / SCHEMA_NEWER", () => {
    const u = env();
    try {
      stageRestore({ userDataDir: u, packageDir: pkg, consent: consentFor(pkg), now: NOW, migrations: MIGRATIONS.slice(0, -1) });
      throw new Error("not refused");
    } catch (e) {
      expect((e as RestoreError).packageCode).toBe("SCHEMA_NEWER");
    }
    untouched(u);
  });

  it("a consent for a different package → CONSENT_MISMATCH", () => {
    const u = env();
    expect(refusal(() => stage(u, pkg, consentFor(pkgIncomplete, true)))).toBe("CONSENT_MISMATCH");
    untouched(u);
  });

  it("🔴 an incomplete package is refused by default → INCOMPLETE_NOT_ACCEPTED", () => {
    const u = env();
    expect(refusal(() => stage(u, pkgIncomplete, consentFor(pkgIncomplete, false)))).toBe("INCOMPLETE_NOT_ACCEPTED");
    untouched(u);
  });

  it("an incomplete package with a DIFFERENT accepted list → CONSENT_MISMATCH", () => {
    const u = env();
    const c = consentFor(pkgIncomplete, true);
    const wrong = { ...c, acceptedMissingAssets: [{ ...c.acceptedMissingAssets[0]!, reason: "unsafe-name" as const }] };
    expect(refusal(() => stage(u, pkgIncomplete, wrong))).toBe("CONSENT_MISMATCH");
    untouched(u);
  });

  it("a complete package with something 'accepted' as missing → CONSENT_MISMATCH", () => {
    const u = env();
    const c = consentFor(pkgIncomplete, true);
    expect(refusal(() => stage(u, pkg, { manifestSha256: consentFor(pkg).manifestSha256, acceptedMissingAssets: c.acceptedMissingAssets }))).toBe("CONSENT_MISMATCH");
    untouched(u);
  });

  it("a second restore while one is pending → RESTORE_PENDING", () => {
    const u = env();
    stage(u);
    expect(refusal(() => stage(u))).toBe("RESTORE_PENDING");
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("a power cut during staging (op %i) leaves the till's state untouched", (k) => {
    const u = env();
    try {
      stage(u, pkg, consentFor(pkg), crashAt(k, "before"));
    } catch {
      // the "process" died
    }
    expect(fingerprint(u)).toEqual(ORIGINAL());
    // Either no journal (nothing to do) or a complete `staged` one: the next start agrees.
    const outcome = apply(u);
    expect(["none", "restored"]).toContain(outcome.kind);
    expect(fingerprint(u)).toEqual(outcome.kind === "none" ? ORIGINAL() : restoredFingerprint(pkg));
  });
});

describe("🔴 an INCOMPLETE restore, with explicit consent", () => {
  it("restores the money, reports what is missing, and never substitutes another logo", () => {
    const u = env();
    stage(u, pkgIncomplete, consentFor(pkgIncomplete, true));
    const outcome = apply(u);
    expect(outcome.kind).toBe("restored");
    if (outcome.kind !== "restored") return;
    expect(outcome.complete).toBe(false);
    expect(outcome.missingAssets).toHaveLength(1);
    expect(outcome.missingAssets[0]!.kind).toBe("frozen-logo");
    expect(fingerprint(u)).toEqual(restoredFingerprint(pkgIncomplete));
    // The target's own frozen logo did NOT survive into the restored profile, so nothing can stand in.
    expect(existsSync(join(u, "branding", "frozen"))).toBe(false);

    const db = new Database(join(u, LIVE_LEDGER_FILE), { readonly: true });
    const issuers = (db.prepare("SELECT issuer_snapshot_json AS j FROM invoices WHERE issuer_snapshot_json IS NOT NULL").all() as Array<{ j: string }>).map((r) => JSON.parse(r.j));
    db.close();
    const at = (dir: string, name: string | null) => (name && existsSync(join(u, "branding", dir, name)) ? join(u, "branding", dir, name) : null);
    const resolutions = issuers.map((i) =>
      resolveInvoiceLogo({ logoAsset: i.logo_asset ?? null, logoPath: i.logo_path ?? null }, { frozen: (n: string) => at("frozen", n) }).kind,
    );
    // The frozen invoice prints NO logo and warns ("missing"). 🔴 TRANSITION (phase 3): the legacy
    // invoice used to resolve "legacy" — today's live file by name. It is now "unverified": no logo,
    // its own warning, because nothing proves the restored live file is the one it was issued with.
    expect(resolutions.sort()).toEqual(["missing", "unverified"]);
  });
});

describe("🔴 a power cut at EVERY file operation of apply, then restart", () => {
  let total = 0;
  beforeAll(() => {
    total = cleanApplyOps();
    expect(total).toBeGreaterThan(10);
  });

  for (const when of ["before", "after"] as const) {
    it(`cut ${when} each operation → the next start ends RESTORED, never mixed; a third start does nothing`, () => {
      for (let k = 1; k <= total; k++) {
        const u = env();
        stage(u);
        let first: ApplyOutcome | "died";
        try {
          first = apply(u, crashAt(k, when));
        } catch {
          first = "died";
        }
        // A cut in the best-effort tidying after the journal is gone does not stop a finished restore.
        expect(first === "died" || first.kind === "halted" || first.kind === "restored", `op ${k}`).toBe(true);
        const second = apply(u);
        // A cut after the journal was removed leaves only tidying undone: already restored.
        expect(["restored", "none"], `op ${k}: ${JSON.stringify(second)}`).toContain(second.kind);
        expect(fingerprint(u), `op ${k}`).toEqual(restoredFingerprint(pkg));
        expect(journalExists(u), `op ${k}`).toBe(false);
        expect(apply(u), `op ${k}`).toEqual({ kind: "none" });
      }
    });
  }

  it("two cuts in a row (during apply, then during the recovery) still end whole", () => {
    for (let k = 1; k <= total; k += 3) {
      for (const j of [1, 2, 4]) {
        const u = env();
        stage(u);
        try {
          apply(u, crashAt(k, "before"));
        } catch {
          // died
        }
        try {
          apply(u, crashAt(j, "after"));
        } catch {
          // died again
        }
        const last = apply(u);
        expect(["restored", "none"], `k=${k} j=${j}: ${JSON.stringify(last)}`).toContain(last.kind);
        expect(fingerprint(u), `k=${k} j=${j}`).toEqual(restoredFingerprint(pkg));
      }
    }
  });
});

describe("🔴 a real FAILURE at every file operation → rolled back to the exact original", () => {
  it("each failure ends in the original state (rolled-back/aborted) or, if only tidying failed, restored", () => {
    const total = cleanApplyOps();
    for (let k = 1; k <= total; k++) {
      const u = env();
      stage(u);
      const outcome = apply(u, failOnceAt(k));
      expect(["rolled-back", "aborted", "restored"], `op ${k}: ${JSON.stringify(outcome)}`).toContain(outcome.kind);
      const want = outcome.kind === "restored" ? restoredFingerprint(pkg) : ORIGINAL();
      expect(fingerprint(u), `op ${k} (${outcome.kind})`).toEqual(want);
      expect(journalExists(u), `op ${k}`).toBe(false);
      if (outcome.kind !== "restored") {
        // The original state is not merely present: it WORKS, -wal and all.
        expect(salesIn(u), `op ${k}`).toBe(originalTemplateSales);
        expect(JSON.parse(readFileSync(join(u, "restore", "last-restore.json"), "utf8")).outcome).toBe(outcome.kind);
      }
    }
  });

  it("a failure, then a power cut DURING the rollback, then a restart → the rollback finishes", () => {
    const u = env();
    stage(u);
    let n = 0;
    let dead = false;
    const fs = instrumented({
      before: (op, args) => {
        n++;
        if (op === "rename" && isStagedLedger(args[0]!)) throw new Error("installing the ledger was refused");
        if (n > 0 && op === "rename" && args[0]!.includes("quarantine") === false && args[1]!.includes("quarantine")) {
          dead = true;
          throw new Error("power cut while quarantining");
        }
      },
      dead: () => dead,
    });
    const first = apply(u, fs);
    expect(first.kind).toBe("halted");
    expect(journalExists(u)).toBe(true);
    const second = apply(u);
    expect(second.kind).toBe("rolled-back");
    expect(fingerprint(u)).toEqual(ORIGINAL());
    expect(salesIn(u)).toBe(originalTemplateSales);
  });

  it("a rollback that cannot finish → HALTED, journal kept; once the fault clears → original", () => {
    const u = env();
    stage(u);
    let failing = false;
    const fs = instrumented({
      before: (op, args) => {
        if (op === "rename" && isStagedLedger(args[0]!)) failing = true;
        // From the first failure on, every move back is refused too (a locked folder).
        if (failing && op === "rename" && !args[0]!.endsWith(".tmp")) throw new Error("rename refused (locked)");
      },
    });
    const first = apply(u, fs);
    expect(first.kind).toBe("halted");
    expect(journalExists(u)).toBe(true);
    const second = apply(u);
    expect(second.kind).toBe("rolled-back");
    expect(fingerprint(u)).toEqual(ORIGINAL());
  });
});

describe("conflicts, lost entries and a damaged journal", () => {
  /** Runs apply until the "process" dies just before moving `match`, leaving the journal mid-way. */
  function cutBefore(u: string, match: (op: keyof BackupFs, args: string[]) => boolean): void {
    let dead = false;
    const fs = instrumented({
      before: (op, args) => {
        if (match(op, args)) {
          dead = true;
          throw new Error("power cut");
        }
      },
      dead: () => dead,
    });
    try {
      apply(u, fs);
    } catch {
      // died
    }
  }

  it("a stray -wal beside the ledger before it is installed → CONFLICT → rolled back, original intact", () => {
    const u = env();
    stage(u);
    cutBefore(u, (op, args) => op === "rename" && isStagedLedger(args[0]!));
    writeFileSync(join(u, `${LIVE_LEDGER_FILE}-wal`), "a stray write-ahead log");
    const outcome = apply(u);
    expect(outcome.kind).toBe("rolled-back");
    expect(outcome.kind === "rolled-back" && outcome.reason).toMatch(/appeared beside the ledger/);
    expect(fingerprint(u)).toEqual(ORIGINAL());
  });

  it("a DIFFERENT file already at an install target → CONFLICT (decided by content) → rolled back", () => {
    const u = env();
    stage(u);
    cutBefore(u, (op, args) => op === "rename" && args[0]!.endsWith(join("live", "shop-logo.png")));
    writeFileSync(join(u, "branding", "shop-logo.png"), "not the backed-up bytes");
    const outcome = apply(u);
    expect(outcome.kind).toBe("rolled-back");
    // Refused AT the move, by content — not only by the final whole-result check behind it.
    expect(outcome.kind === "rolled-back" && outcome.reason).toMatch(/already exists with different content/);
    expect(fingerprint(u)).toEqual(ORIGINAL());
  });

  it("the SAME bytes already at an install target are accepted (a move that already happened)", () => {
    const u = env();
    stage(u);
    cutBefore(u, (op, args) => op === "rename" && args[0]!.endsWith(join("live", "shop-logo.png")));
    const id = readdirSync(join(u, "restore")).find((n) => n.startsWith("staging-"))!;
    copyFileSync(join(u, "restore", id, "branding", "live", "shop-logo.png"), join(u, "branding", "shop-logo.png"));
    expect(apply(u).kind).toBe("restored");
    expect(fingerprint(u)).toEqual(restoredFingerprint(pkg));
  });

  it("🔴 a preserved entry that vanished (lost -wal) → HALTED: no state is claimed whole", () => {
    const u = env();
    const { id } = stage(u);
    cutBefore(u, (op, args) => op === "rename" && args[0]!.endsWith("-shm"));
    rmSync(join(u, "restore", `pre-restore-${id}`, `${LIVE_LEDGER_FILE}-wal`));
    const outcome = apply(u);
    expect(outcome.kind).toBe("halted");
    expect(journalExists(u)).toBe(true);
    expect(apply(u).kind).toBe("halted"); // and it keeps refusing
  });

  it("a staged copy damaged between stage and start → ABORTED, nothing touched", () => {
    const u = env();
    const { id } = stage(u);
    writeFileSync(join(u, "restore", `staging-${id}`, "branding", "live", "shop-logo.png"), "damaged");
    const outcome = apply(u);
    expect(outcome.kind).toBe("aborted");
    expect(fingerprint(u)).toEqual(ORIGINAL());
    expect(journalExists(u)).toBe(false);
  });

  it.each([
    ["installing with no inventory", { state: "installing", inventory: null }],
    ["rolling-back with no starting point", { state: "rolling-back", rollbackFrom: null }],
    ["staged that claims an inventory", { state: "staged", inventory: [] }],
  ])("🔴 a journal whose fields contradict its state (%s) → HALTED, never a claimed rollback", (_label, patch) => {
    const u = env();
    const { id } = stage(u);
    cutBefore(u, (op, args) => op === "rename" && args[0]!.endsWith(`${LIVE_LEDGER_FILE}-shm`));
    const path = join(u, "restore", "journal.json");
    const j = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...j, ...patch }));
    const before = fingerprint(u);
    const outcome = apply(u);
    expect(outcome.kind).toBe("halted");
    expect(fingerprint(u)).toEqual(before); // nothing moved on a journal it cannot trust
    expect(existsSync(join(u, "restore", `pre-restore-${id}`, LIVE_LEDGER_FILE))).toBe(true);
  });

  it("a damaged journal → HALTED and nothing touched", () => {
    const u = env();
    stage(u);
    writeFileSync(join(u, "restore", "journal.json"), "{ half a journal");
    expect(apply(u).kind).toBe("halted");
    expect(fingerprint(u)).toEqual(ORIGINAL());
  });
});

describe("contract pin", () => {
  it("the live ledger name matches src/main/ledgerGuard.ts", () => {
    const guard = readFileSync(join(__dirname, "../../src/main/ledgerGuard.ts"), "utf8");
    expect(guard).toContain(`export const LEDGER_FILE_NAME = "${LIVE_LEDGER_FILE}";`);
    expect(guard).toContain('export const LEDGER_MARKER_FILE_NAME = "ledger.json";');
  });
});
