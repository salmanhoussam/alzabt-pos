/**
 * readInvoicePhoto through the REAL handlers with a FAKE reader (invented lines — no real invoice text in
 * the repository). It returns candidate rows and writes NOTHING; access = the product-create capability.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { accessFor } from "../../src/main/channelPolicy";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import type { IpcResult, ReadInvoicePhotoResponse } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});
const tables = () =>
  (h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
const footprint = () => tables().map((n) => `${n}:${String((h.db.prepare(`SELECT count(*) AS c FROM "${n}"`).get() as { c: bigint }).c)}`).join(",");

describe("readInvoicePhoto", () => {
  it("is classified with product creation", () => {
    expect(accessFor("readInvoicePhoto")).toBe("create-products");
  });

  it("returns explained rows + unexplained lines and writes NOTHING", async () => {
    const before = footprint();
    const handlers = createIpcHandlers(h.service, {
      readInvoicePhoto: async () => ({
        lines: ["1 مسامير تجريبية PCS 12 0.75 9.00", "سطر غامض 21.00 63.00", "عنوان بلا أرقام"].map((text, i) => ({ text, y: 100 + i * 50, h: 30, x0: 0, x1: 1000, source: "original" as const, kind: "engine" as const })),
        ms: 1234,
        preview: null,
        crop: () => "data:image/jpeg;base64,AAAA",
      }),
    });
    const r = (await handlers.readInvoicePhoto(undefined)) as IpcResult<ReadInvoicePhotoResponse>;
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data.status).toBe("read");
    if (r.data.status !== "read") return;
    expect(r.data.rows).toEqual([expect.objectContaining({ relation: "R1", quantityMilli: 12000, supplierPriceMinor: "75", lineTotalMinor: "900" })]);
    // TRANSITION (Stage A, 2026-11-16): an unexplained line also carries the NAME read at its place (was: text, y, crop).
    expect(r.data.unexplained).toEqual([{ text: "سطر غامض 21.00 63.00", name: "سطر غامض", y: 150, crop: "data:image/jpeg;base64,AAAA" }]);
    expect(r.data.rows[0]).toMatchObject({ y: 100, crop: "data:image/jpeg;base64,AAAA", readings: 1 });
    expect(footprint()).toBe(before);
  });

  // OCR-REVIEW-UX (handwritten invoices): an optional { mode }. Absent = "read" (unchanged); "photo-only" reaches the
  // reader as such (main shows the photo and runs NO OCR); anything else is refused BEFORE any picker opens.
  it("mode: absent = read, photo-only is passed through and echoed, nothing written; a wrong mode is refused unread", async () => {
    const before = footprint();
    const seen: string[] = [];
    const handlers = createIpcHandlers(h.service, {
      readInvoicePhoto: async (mode) => {
        seen.push(mode);
        return { lines: [], ms: 3, preview: "data:image/jpeg;base64,AAAA", crop: () => null };
      },
    });
    const plain = (await handlers.readInvoicePhoto(undefined)) as IpcResult<ReadInvoicePhotoResponse>;
    const photo = (await handlers.readInvoicePhoto({ mode: "photo-only" })) as IpcResult<ReadInvoicePhotoResponse>;
    const explicit = (await handlers.readInvoicePhoto({ mode: "read" })) as IpcResult<ReadInvoicePhotoResponse>;
    expect(seen).toEqual(["read", "photo-only", "read"]);
    if (!plain.ok || !photo.ok || !explicit.ok) throw new Error("refused");
    expect(plain.data).toMatchObject({ status: "read", mode: "read" });
    expect(photo.data).toMatchObject({ status: "read", mode: "photo-only", rows: [], unexplained: [], preview: "data:image/jpeg;base64,AAAA" });
    for (const bad of [{ mode: "ocr" }, { mode: true }, { mode: "photo-only", path: "C:/x.jpg" }, "photo-only"]) {
      const r = (await handlers.readInvoicePhoto(bad)) as IpcResult<unknown>;
      expect(r.ok).toBe(false);
    }
    expect(seen).toHaveLength(3); // no refused request ever reached the picker
    expect(footprint()).toBe(before);
  });

  // DEC-35zzzz: a REFUSED reading is logged in main (code + the engine's short reason, never the invoice text) and
  // still answered as a refusal with its code — the screen turns the code into a bilingual sentence.
  it("a refused reading is logged with its code and still refused; nothing written", async () => {
    const before = footprint();
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger = { info() {}, error() {}, warn: (event: string, fields?: Record<string, unknown>) => void logged.push({ event, fields }), file: null };
    const handlers = createIpcHandlers(h.service, {
      logger,
      readInvoicePhoto: async () => {
        throw new DomainError("OCR_FAILED", "Invoice reading failed: worker timed out");
      },
    });
    const r = (await handlers.readInvoicePhoto({ mode: "read" })) as IpcResult<unknown>;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("OCR_FAILED");
    expect(logged).toEqual([{ event: "invoice-photo-refused", fields: { mode: "read", code: "OCR_FAILED", detail: "Invoice reading failed: worker timed out" } }]);
    expect(footprint()).toBe(before);
  });

  it("cancelled picker → cancelled; no reader wired → unavailable; a payload is refused", async () => {
    const cancelled = await createIpcHandlers(h.service, { readInvoicePhoto: async () => null }).readInvoicePhoto(undefined);
    expect(cancelled).toEqual({ ok: true, data: { status: "cancelled" } });
    expect(await createIpcHandlers(h.service).readInvoicePhoto(undefined)).toEqual({ ok: true, data: { status: "unavailable" } });
    const bad = (await createIpcHandlers(h.service).readInvoicePhoto({ path: "C:/x.jpg" })) as IpcResult<unknown>;
    expect(bad.ok).toBe(false);
  });
});
