/**
 * DEC-35z16 (owner, PILOT): where phone invoice photos wait until the till reviews them.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 ON DISK, NOT IN MEMORY, AND THE REASON IS MEASURED, NOT STYLISTIC. A batch may hold 20 photos of
 * up to 12 MB; held in the main process that is ~240 MB on an 8 GB shop PC, and an app crash or a
 * restart would lose invoices the phone was already told were received. So each accepted photo is
 * written to `<userData>/phone-invoices/<batchId>/<invoiceId>.<ext>` the moment it arrives, and a
 * `manifest.json` beside it (ids, sizes, hashes, times — NO image bytes, NO OCR text) is replaced
 * atomically (write a temp file, then rename) after every change.
 *
 * 🔴 PROTECTION AT REST = THE POS PROFILE'S OWN: the same per-user folder that already holds the
 * ledger with every cost price. Not encrypted separately in this pilot; recorded as such.
 *
 * 🔴 NEVER IN A BACKUP. `backupPackage.ts` copies the ledger and `branding/` by name, so this folder
 * is not packaged and a restore does not bring pending invoices back. Intended: they are transient.
 *
 * 🔴 NO SILENT LOSS. A batch the phone never finished (timeout, cancel, app quit, crash) becomes
 * `incomplete` and its photos stay in the queue. A photo leaves only when its review was confirmed
 * or an operator discarded it. Old ones are FLAGGED (`PHONE_INVOICE_STALE_AFTER_MS`), never deleted.
 *
 * 🔴 LOGS CARRY COUNTS AND SIZES ONLY — never bytes, never a phone file name, never OCR text.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "../domain/errors";
import {
  INVOICE_REFUSAL_AR,
  PHONE_INVOICE_STALE_AFTER_MS,
  decideUpload,
  isInvoiceId,
  type BatchInvoice,
} from "../domain/phoneInvoiceBatch";
import type { Logger } from "./logger";

export type BatchStatus = "open" | "ready" | "incomplete";

interface Manifest {
  readonly version: 1;
  readonly batchId: string;
  status: BatchStatus;
  readonly createdAtMs: number;
  items: BatchInvoice[];
}

export interface PendingPhoneInvoice {
  readonly batchId: string;
  readonly id: string;
  readonly mime: "image/jpeg" | "image/png";
  readonly bytes: number;
  readonly receivedAtMs: number;
  readonly batchStatus: "ready" | "incomplete";
  readonly stale: boolean;
  /** PHONE-INVOICE-ORIENTATION-01: this invoice's saved quarter-turns (0..3). */
  readonly quarterTurns: number;
}

export type UploadResult =
  | { readonly ok: true; readonly id: string; readonly replay: boolean; readonly count: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** JPEG and PNG by their first bytes. The decoder check that follows is injected (main uses nativeImage). */
export function sniffInvoiceImage(bytes: Buffer): "image/jpeg" | "image/png" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

const BATCH_ID = /^[0-9a-f]{32}$/;

export class PhoneInvoiceStaging {
  constructor(
    private readonly root: string,
    private readonly deps: {
      /** True when the bytes decode as a real image of sane dimensions. Main passes a nativeImage check. */
      readonly decodes: (bytes: Buffer) => boolean;
      readonly now?: () => number;
      readonly logger?: Logger;
      readonly randomId?: () => string;
    },
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private newId(): string {
    return (this.deps.randomId ?? (() => randomBytes(16).toString("hex")))();
  }

  private dir(batchId: string): string {
    if (!BATCH_ID.test(batchId)) throw new DomainError("INVALID_INPUT", "Unknown invoice batch");
    return join(this.root, batchId);
  }

  private read(batchId: string): Manifest | null {
    const file = join(this.dir(batchId), "manifest.json");
    if (!existsSync(file)) return null;
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
      return m && m.version === 1 && m.batchId === batchId && Array.isArray(m.items) ? m : null;
    } catch {
      return null;
    }
  }

  private write(m: Manifest): void {
    writeDurably(join(this.dir(m.batchId), "manifest.json"), Buffer.from(JSON.stringify(m), "utf8"));
  }

  private fileOf(batchId: string, item: BatchInvoice): string {
    return join(this.dir(batchId), `${item.id}.${item.mime === "image/png" ? "png" : "jpg"}`);
  }

  private batchIds(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((n) => BATCH_ID.test(n));
  }

  /** Bytes waiting across every batch except `exceptBatchId`. */
  stagedBytes(exceptBatchId?: string): number {
    let total = 0;
    for (const id of this.batchIds()) {
      if (id === exceptBatchId) continue;
      for (const i of this.read(id)?.items ?? []) total += i.bytes;
    }
    return total;
  }

  /** A new, empty, open batch. */
  openBatch(): string {
    const batchId = this.newId();
    mkdirSync(this.dir(batchId), { recursive: true });
    this.write({ version: 1, batchId, status: "open", createdAtMs: this.now, items: [] });
    this.deps.logger?.info("phone-invoice-batch-opened", {});
    return batchId;
  }

  /** The batch's items, for the phone page (ids and sizes only). */
  items(batchId: string): readonly BatchInvoice[] {
    return this.read(batchId)?.items ?? [];
  }

  /** One upload. Validated, hashed, de-duplicated, bounded, then written BEFORE the phone hears "received". */
  add(batchId: string, body: Buffer, captureKey: string): UploadResult {
    const m = this.read(batchId);
    if (!m || m.status !== "open") return { ok: false, code: "SESSION_CLOSED", message: "انتهت هذه الدفعة. ابدأ دفعة جديدة من الكمبيوتر." };
    const mime = sniffInvoiceImage(body);
    if (!mime || !this.deps.decodes(body)) {
      return { ok: false, code: "INVALID_INPUT", message: "الصورة غير مقروءة. التقط صورة JPEG أو PNG للفاتورة." };
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    const decision = decideUpload(m.items, { bytes: body.length, sha256, captureKey }, this.stagedBytes(batchId));
    if (decision.kind === "replay") return { ok: true, id: decision.id, replay: true, count: m.items.length };
    if (decision.kind === "duplicate") return { ok: false, code: "DUPLICATE", message: INVOICE_REFUSAL_AR.duplicate };
    if (decision.kind === "limit") return { ok: false, code: "LIMIT", message: INVOICE_REFUSAL_AR[decision.which] };
    const item: BatchInvoice = { id: this.newId(), mime, bytes: body.length, sha256, captureKey, receivedAtMs: this.now };
    const file = this.fileOf(batchId, item);
    writeDurably(file, body);
    m.items.push(item);
    this.write(m);
    this.deps.logger?.info("phone-invoice-received", { count: m.items.length, bytes: body.length });
    return { ok: true, id: item.id, replay: false, count: m.items.length };
  }

  /** Remove one of an OPEN batch's own uploads (the phone's «حذف»). */
  removeFromOpen(batchId: string, invoiceId: string): UploadResult {
    const m = this.read(batchId);
    if (!m || m.status !== "open") return { ok: false, code: "SESSION_CLOSED", message: "انتهت هذه الدفعة." };
    const item = isInvoiceId(invoiceId) ? m.items.find((i) => i.id === invoiceId) : undefined;
    if (!item) return { ok: false, code: "NOT_FOUND", message: "هذه الصورة ليست في الدفعة." };
    rmSync(this.fileOf(batchId, item), { force: true });
    m.items = m.items.filter((i) => i.id !== invoiceId);
    this.write(m);
    this.deps.logger?.info("phone-invoice-removed-by-phone", { count: m.items.length });
    return { ok: true, id: invoiceId, replay: false, count: m.items.length };
  }

  /** The phone pressed «إنهاء». An empty batch is simply removed. */
  finish(batchId: string): number {
    return this.close(batchId, "ready");
  }

  /** The session ended without «إنهاء» (timeout, cancel, quit). Photos are KEPT as `incomplete`. */
  abandon(batchId: string): number {
    return this.close(batchId, "incomplete");
  }

  private close(batchId: string, to: "ready" | "incomplete"): number {
    const m = this.read(batchId);
    if (!m) return 0;
    if (m.status !== "open") return m.items.length;
    if (m.items.length === 0) {
      rmSync(this.dir(batchId), { recursive: true, force: true });
      return 0;
    }
    m.status = to;
    this.write(m);
    this.deps.logger?.info("phone-invoice-batch-closed", { status: to, count: m.items.length });
    return m.items.length;
  }

  /**
   * At startup: a batch still `open` belongs to a session the app no longer has (crash, power loss),
   * so it becomes `incomplete` — kept, never dropped. Leftover temp files of an interrupted write go.
   */
  recover(): { readonly recovered: number; readonly pending: number } {
    let recovered = 0;
    for (const id of this.batchIds()) {
      const d = this.dir(id);
      for (const n of readdirSync(d)) if (n.endsWith(".tmp")) rmSync(join(d, n), { force: true });
      const m = this.read(id);
      if (!m) continue; // an unreadable manifest is left on disk for a human, never deleted
      // A photo written but not yet recorded is an orphan of an interrupted add: dropped (the phone was never told "received").
      const known = new Set(m.items.map((i) => `${i.id}.${i.mime === "image/png" ? "png" : "jpg"}`));
      for (const n of readdirSync(d)) if (n !== "manifest.json" && !known.has(n)) rmSync(join(d, n), { force: true });
      if (m.status === "open") {
        recovered += 1;
        this.close(id, "incomplete");
      } else if (m.items.length === 0) {
        rmSync(d, { recursive: true, force: true });
      }
    }
    const pending = this.pending().length;
    if (recovered || pending) this.deps.logger?.info("phone-invoice-recovered", { recovered, pending });
    return { recovered, pending };
  }

  /** Every invoice waiting for review, oldest first. */
  pending(): PendingPhoneInvoice[] {
    const out: PendingPhoneInvoice[] = [];
    for (const id of this.batchIds()) {
      const m = this.read(id);
      if (!m || m.status === "open") continue;
      for (const i of m.items) {
        out.push({
          batchId: id,
          id: i.id,
          mime: i.mime,
          bytes: i.bytes,
          receivedAtMs: i.receivedAtMs,
          batchStatus: m.status,
          stale: this.now - i.receivedAtMs > PHONE_INVOICE_STALE_AFTER_MS,
          quarterTurns: i.quarterTurns ?? 0,
        });
      }
    }
    return out.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  }

  /** The file of one PENDING invoice, for the existing reader. Refuses an open batch or an unknown id. */
  pathOf(batchId: string, invoiceId: string): string {
    const m = this.read(batchId);
    const item = m && m.status !== "open" && isInvoiceId(invoiceId) ? m.items.find((i) => i.id === invoiceId) : undefined;
    if (!m || !item) throw new DomainError("NOT_AVAILABLE", "That phone invoice is no longer waiting");
    const file = this.fileOf(batchId, item);
    if (!existsSync(file) || statSync(file).size !== item.bytes) throw new DomainError("NOT_AVAILABLE", "That phone invoice is no longer readable");
    return file;
  }

  /**
   * PHONE-INVOICE-ORIENTATION-01: remember the operator's rotation of ONE pending invoice, so reopening
   * its review (or restarting the app) shows it the way it was left. Other invoices are untouched.
   */
  setTurns(batchId: string, invoiceId: string, quarterTurns: number): void {
    const m = this.read(batchId);
    const item = m && m.status !== "open" && isInvoiceId(invoiceId) ? m.items.find((i) => i.id === invoiceId) : undefined;
    if (!m || !item) throw new DomainError("NOT_AVAILABLE", "That phone invoice is no longer waiting");
    const turns = (((Math.trunc(quarterTurns) % 4) + 4) % 4);
    if ((item.quarterTurns ?? 0) === turns) return;
    item.quarterTurns = turns;
    this.write(m);
  }

  /** The saved quarter-turns of one pending invoice (0 when never rotated). */
  turnsOf(batchId: string, invoiceId: string): number {
    const m = this.read(batchId);
    const item = m && isInvoiceId(invoiceId) ? m.items.find((i) => i.id === invoiceId) : undefined;
    return item?.quarterTurns ?? 0;
  }

  /** Reviewed-and-confirmed, or discarded by an operator: the photo leaves the disk. */
  release(batchId: string, invoiceId: string, why: "reviewed" | "discarded"): boolean {
    const m = this.read(batchId);
    if (!m || m.status === "open" || !isInvoiceId(invoiceId)) return false;
    const item = m.items.find((i) => i.id === invoiceId);
    if (!item) return false;
    rmSync(this.fileOf(batchId, item), { force: true });
    m.items = m.items.filter((i) => i.id !== invoiceId);
    if (m.items.length === 0) rmSync(this.dir(batchId), { recursive: true, force: true });
    else this.write(m);
    this.deps.logger?.info("phone-invoice-released", { why });
    return true;
  }
}

/**
 * Stage A (owner UAT 2026-11-16, multi-select): the phone shows «استُلمت» only after this returns, so
 * the bytes are flushed to the disk (fsync) BEFORE the atomic rename — a power cut right after the
 * phone's tick cannot leave a renamed-but-empty file. A process kill was already safe without it.
 */
function writeDurably(path: string, data: Buffer): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
