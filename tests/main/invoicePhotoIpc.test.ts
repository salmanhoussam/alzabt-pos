/**
 * readInvoicePhoto through the REAL handlers with a FAKE reader (invented lines — no real invoice text in
 * the repository). It returns candidate rows and writes NOTHING; access = the product-create capability.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(r.data.unexplained).toEqual([{ text: "سطر غامض 21.00 63.00", y: 150, crop: "data:image/jpeg;base64,AAAA" }]);
    expect(r.data.rows[0]).toMatchObject({ y: 100, crop: "data:image/jpeg;base64,AAAA", readings: 1 });
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
