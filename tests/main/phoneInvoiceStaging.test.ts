/**
 * DEC-35z16 (PILOT): the on-disk staging of phone invoice photos — writes before "received", keeps
 * unfinished batches, recovers after a crash, never lists or serves an open batch, and holds no
 * image bytes in its manifest.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHONE_INVOICE_STALE_AFTER_MS } from "../../src/domain/phoneInvoiceBatch";
import { PhoneInvoiceStaging, sniffInvoiceImage } from "../../src/main/phoneInvoiceStaging";

const JPEG = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic-invoice-${n}`)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]);
const key = (n: number) => n.toString(16).padStart(32, "0");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function staging(now = { t: 1_000 }) {
  const root = mkdtempSync(join(tmpdir(), "pos-phone-inv-"));
  dirs.push(root);
  let seq = 0;
  const s = new PhoneInvoiceStaging(root, {
    decodes: (b) => !b.toString().includes("broken"),
    now: () => now.t,
    randomId: () => (++seq).toString(16).padStart(32, "0"),
  });
  return { s, root, now };
}

describe("sniffInvoiceImage", () => {
  it("knows JPEG and PNG by their first bytes, nothing else", () => {
    expect(sniffInvoiceImage(JPEG(1))).toBe("image/jpeg");
    expect(sniffInvoiceImage(PNG)).toBe("image/png");
    expect(sniffInvoiceImage(Buffer.from("GIF89a"))).toBeNull();
  });
});

describe("PhoneInvoiceStaging", () => {
  it("🔴 writes the photo to disk BEFORE answering, and the manifest holds no image bytes", () => {
    const { s, root } = staging();
    const b = s.openBatch();
    const r = s.add(b, JPEG(1), key(1));
    expect(r).toMatchObject({ ok: true, replay: false, count: 1 });
    const files = readdirSync(join(root, b)).sort();
    expect(files).toEqual([`${(r as { id: string }).id}.jpg`, "manifest.json"]);
    const manifest = readFileSync(join(root, b, "manifest.json"), "utf8");
    expect(manifest).not.toContain("synthetic-invoice");
    expect(manifest).not.toMatch(/base64|data:/);
  });
  it("🔴 a retry with the same key returns the same id and stores nothing new; same bytes, new key → refused", () => {
    const { s, root } = staging();
    const b = s.openBatch();
    const first = s.add(b, JPEG(1), key(1));
    const again = s.add(b, JPEG(1), key(1));
    expect(again).toEqual({ ok: true, id: (first as { id: string }).id, replay: true, count: 1 });
    expect(s.add(b, JPEG(1), key(2))).toMatchObject({ ok: false, code: "DUPLICATE" });
    expect(readdirSync(join(root, b)).filter((n) => n.endsWith(".jpg"))).toHaveLength(1);
  });
  it("refuses an unreadable or non-image photo without touching the batch", () => {
    const { s } = staging();
    const b = s.openBatch();
    expect(s.add(b, Buffer.from("not an image"), key(1))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(s.add(b, Buffer.concat([JPEG(1), Buffer.from("broken")]), key(2))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(s.items(b)).toHaveLength(0);
  });
  it("several separate invoices; one removed before finishing; an open batch is NOT in the queue", () => {
    const { s } = staging();
    const b = s.openBatch();
    const ids = [1, 2, 3].map((n) => (s.add(b, JPEG(n), key(n)) as { id: string }).id);
    expect(s.pending()).toHaveLength(0);
    expect(() => s.pathOf(b, ids[0]!)).toThrow();
    expect(s.removeFromOpen(b, ids[1]!)).toMatchObject({ ok: true, count: 2 });
    expect(s.finish(b)).toBe(2);
    expect(s.pending().map((p) => p.id)).toEqual([ids[0], ids[2]]);
    expect(s.pending().every((p) => p.batchStatus === "ready")).toBe(true);
    // a finished batch takes no more uploads and no more phone deletes
    expect(s.add(b, JPEG(9), key(9))).toMatchObject({ ok: false, code: "SESSION_CLOSED" });
    expect(s.removeFromOpen(b, ids[0]!)).toMatchObject({ ok: false, code: "SESSION_CLOSED" });
  });
  it("🔴 NO SILENT LOSS: a batch abandoned with photos is kept as incomplete; an empty one simply goes", () => {
    const { s, root } = staging();
    const kept = s.openBatch();
    s.add(kept, JPEG(1), key(1));
    expect(s.abandon(kept)).toBe(1);
    expect(s.pending()).toMatchObject([{ batchId: kept, batchStatus: "incomplete" }]);
    const empty = s.openBatch();
    expect(s.abandon(empty)).toBe(0);
    expect(existsSync(join(root, empty))).toBe(false);
  });
  it("🔴 crash recovery: an OPEN batch becomes incomplete; temp files and unrecorded photos go", () => {
    const { s, root } = staging();
    const b = s.openBatch();
    const id = (s.add(b, JPEG(1), key(1)) as { id: string }).id;
    writeFileSync(join(root, b, "manifest.json.tmp"), "half");
    writeFileSync(join(root, b, `${key(77)}.jpg`), "orphan of an interrupted write");
    const r = s.recover();
    expect(r).toEqual({ recovered: 1, pending: 1 });
    expect(readdirSync(join(root, b)).sort()).toEqual([`${id}.jpg`, "manifest.json"]);
    expect(s.pending()[0]).toMatchObject({ id, batchStatus: "incomplete" });
  });
  it("release after review (or discard) removes the file, then the empty batch folder", () => {
    const { s, root } = staging();
    const b = s.openBatch();
    const a = (s.add(b, JPEG(1), key(1)) as { id: string }).id;
    const c = (s.add(b, PNG, key(2)) as { id: string }).id;
    s.finish(b);
    expect(s.pathOf(b, c)).toMatch(/\.png$/);
    expect(s.release(b, a, "reviewed")).toBe(true);
    expect(s.release(b, a, "reviewed")).toBe(false);
    expect(s.release(b, c, "discarded")).toBe(true);
    expect(existsSync(join(root, b))).toBe(false);
    expect(s.pending()).toHaveLength(0);
  });
  it("old photos are FLAGGED stale, never deleted", () => {
    const clock = { t: 1_000 };
    const { s } = staging(clock);
    const b = s.openBatch();
    s.add(b, JPEG(1), key(1));
    s.finish(b);
    clock.t += PHONE_INVOICE_STALE_AFTER_MS + 1;
    s.recover();
    expect(s.pending()).toMatchObject([{ stale: true }]);
  });
  it("refuses ids that are not the server's shape before they can name a file", () => {
    const { s } = staging();
    expect(() => s.pathOf("../x", key(1))).toThrow();
    expect(s.release(key(1), "../../ledger", "discarded")).toBe(false);
  });
});

describe("PHONE-INVOICE-ORIENTATION-01: each invoice keeps its OWN rotation, across a restart", () => {
  it("setTurns persists per invoice in the manifest; another invoice is untouched; a new instance reads it", () => {
    const { s, root } = staging();
    const b = s.openBatch();
    const a = (s.add(b, JPEG(1), key(1)) as { id: string }).id;
    const c = (s.add(b, JPEG(2), key(2)) as { id: string }).id;
    expect(() => s.setTurns(b, a, 1)).toThrow(); // an OPEN batch is not reviewable yet
    s.finish(b);
    s.setTurns(b, a, 1);
    s.setTurns(b, c, -1);
    const again = new PhoneInvoiceStaging(root, { decodes: () => true });
    expect(again.turnsOf(b, a)).toBe(1);
    expect(again.turnsOf(b, c)).toBe(3);
    expect(again.pending().map((p) => p.quarterTurns)).toEqual([1, 3]);
    expect(readFileSync(join(root, b, "manifest.json"), "utf8")).not.toContain("synthetic-invoice");
  });
});
