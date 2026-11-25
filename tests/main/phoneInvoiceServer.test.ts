/**
 * DEC-35z16 (PILOT): the invoice routes over the REAL listener on loopback (see phoneSessionServer.test.ts
 * for why loopback is correct in a test and forbidden in a QR).
 */
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, type PhoneSession } from "../../src/domain/phoneSession";
import { renderPairedPage, startPhoneSessionServer } from "../../src/main/phoneSessionServer";
import { renderPhoneInvoicePage } from "../../src/main/phoneInvoicePage";
import { PhoneInvoiceStaging } from "../../src/main/phoneInvoiceStaging";

const HOST = "127.0.0.1";
const TOKEN = "e".repeat(64);
const KEY1 = "1".repeat(32);
const KEY2 = "2".repeat(32);
const JPEG = (s: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(s)]);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function raw(port: number, head: string, body: Buffer = Buffer.alloc(0)): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port }, () => socket.end(Buffer.concat([Buffer.from(head), body])));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const split = data.indexOf("\r\n\r\n");
      resolve({ status: Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0), headers: data.slice(0, split), body: data.slice(split + 4) });
    });
  });
}
const get = (port: number, path: string) => raw(port, `GET ${path} HTTP/1.1\r\nHost: x\r\nUser-Agent: phone\r\nConnection: close\r\n\r\n`);
const post = (port: number, path: string, body = Buffer.alloc(0), key?: string) =>
  raw(
    port,
    `POST ${path} HTTP/1.1\r\nHost: x\r\nUser-Agent: phone\r\nConnection: close\r\nContent-Length: ${body.length}\r\n${key ? `X-Capture-Key: ${key}\r\n` : ""}\r\n`,
    body,
  );
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host: HOST, port });
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });

async function invoiceServer() {
  const root = mkdtempSync(join(tmpdir(), "pos-phone-inv-srv-"));
  dirs.push(root);
  const staging = new PhoneInvoiceStaging(root, { decodes: () => true });
  const batchId = staging.openBatch();
  const session: PhoneSession = createSession({ action: "INVOICE_BATCH", productId: null, operatorId: "op" }, Date.now(), () => TOKEN);
  const running = await startPhoneSessionServer({
    session,
    host: HOST,
    renderPage: () => renderPhoneInvoicePage({ items: staging.items(batchId), maxPerBatch: 20 }),
    receiveInvoice: (b, k) => {
      const r = staging.add(batchId, b, k);
      return r.ok ? { ok: true, data: { id: r.id, count: r.count } } : r;
    },
    deleteInvoice: (id) => {
      const r = staging.removeFromOpen(batchId, id);
      return r.ok ? { ok: true, data: { count: r.count } } : r;
    },
    finishBatch: () => ({ ok: true, data: { count: staging.finish(batchId) } }),
  });
  return { running, staging, batchId, session };
}

describe("invoice routes on an INVOICE_BATCH session", () => {
  it("serves the invoice page with blob: thumbnails allowed (and nothing else added)", async () => {
    const { running } = await invoiceServer();
    try {
      const page = await get(running.port, `/m/${TOKEN}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain("تصوير فواتير المورّدين");
      expect(page.headers).toMatch(/img-src 'self' data: blob:;/);
      expect(page.headers).toMatch(/connect-src 'self';/);
    } finally {
      await running.stop("cancelled");
    }
  });
  it("several uploads, a retry, a duplicate, a delete, then finish spends the token and closes the port", async () => {
    const { running, staging, batchId } = await invoiceServer();
    const a = await post(running.port, `/m/${TOKEN}/invoice`, JPEG("one"), KEY1);
    expect(a.status).toBe(200);
    const idA = JSON.parse(a.body).id as string;
    expect((await post(running.port, `/m/${TOKEN}/invoice`, JPEG("one"), KEY1)).status).toBe(200); // retry → same id
    expect(JSON.parse((await post(running.port, `/m/${TOKEN}/invoice`, JPEG("one"), KEY1)).body).id).toBe(idA);
    expect((await post(running.port, `/m/${TOKEN}/invoice`, JPEG("one"), KEY2)).status).toBe(409); // same bytes → refused
    const b = await post(running.port, `/m/${TOKEN}/invoice`, JPEG("two"), KEY2);
    expect(JSON.parse(b.body)).toMatchObject({ ok: true, count: 2 });
    expect((await post(running.port, `/m/${TOKEN}/invoice/${idA}/delete`)).status).toBe(200);
    expect(staging.items(batchId)).toHaveLength(1);
    const fin = await post(running.port, `/m/${TOKEN}/finish`);
    expect(JSON.parse(fin.body)).toMatchObject({ ok: true, count: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(await listening(running.port)).toBe(false);
    expect(staging.pending()).toHaveLength(1);
  });
  it("🔴 an upload without a valid capture key is refused and stores nothing", async () => {
    const { running, staging, batchId } = await invoiceServer();
    try {
      expect((await post(running.port, `/m/${TOKEN}/invoice`, JPEG("x"))).status).toBe(400);
      expect((await post(running.port, `/m/${TOKEN}/invoice`, JPEG("x"), "../../etc")).status).toBe(400);
      expect(staging.items(batchId)).toHaveLength(0);
    } finally {
      await running.stop("cancelled");
    }
  });
  it("🔴 the product routes do not exist for an invoice token (save, photo, barcode)", async () => {
    const { running } = await invoiceServer();
    try {
      expect((await post(running.port, `/m/${TOKEN}`, Buffer.from("{}"))).status).toBe(404);
      expect((await post(running.port, `/m/${TOKEN}/photo`, JPEG("p"))).status).toBe(404);
    } finally {
      await running.stop("cancelled");
    }
  });
  it("🔴 a second phone is refused and a wrong token learns nothing", async () => {
    const { running } = await invoiceServer();
    try {
      expect((await get(running.port, `/m/${TOKEN}`)).status).toBe(200);
      const other = await raw(running.port, `POST /m/${TOKEN}/invoice HTTP/1.1\r\nHost: x\r\nUser-Agent: other-phone\r\nConnection: close\r\nContent-Length: 4\r\nX-Capture-Key: ${KEY1}\r\n\r\n`, JPEG(""));
      expect(other.status).toBe(404);
      expect((await post(running.port, `/m/${"f".repeat(64)}/invoice`, JPEG("z"), KEY1)).status).toBe(404);
    } finally {
      await running.stop("cancelled");
    }
  });
});

describe("🔴 a PRODUCT session never reaches the invoice routes", () => {
  it("invoice, delete and finish answer 404 and spend malformed budget", async () => {
    const session = createSession({ action: "NEW_PRODUCT", productId: null, operatorId: "op" }, Date.now(), () => TOKEN);
    const running = await startPhoneSessionServer({ session, host: HOST, renderPage: renderPairedPage });
    try {
      expect((await post(running.port, `/m/${TOKEN}/invoice`, JPEG("q"), KEY1)).status).toBe(404);
      expect((await post(running.port, `/m/${TOKEN}/finish`)).status).toBe(404);
      expect(session.malformedCount).toBe(2);
      // and the product page's own policy is unchanged — no blob:
      const page = await get(running.port, `/m/${TOKEN}`);
      expect(page.headers).toMatch(/img-src 'self' data:;/);
    } finally {
      await running.stop("cancelled");
    }
  });
});
