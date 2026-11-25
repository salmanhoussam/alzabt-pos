/**
 * DEC-35z17 (owner: ONE «من الهاتف» button): the two-stage Phone Companion session.
 * Domain rules (pure) + the real listener on loopback (see phoneSessionServer.test.ts for why loopback).
 */
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHONE_INVOICE_SESSION_TTL_MS,
  PHONE_SESSION_TTL_MS,
  authorizes,
  createSession,
  effectiveAction,
  lockPurpose,
  parseRoute,
  type PhonePurpose,
} from "../../src/domain/phoneSession";
import { startPhoneSessionServer } from "../../src/main/phoneSessionServer";
import { PhoneInvoiceStaging } from "../../src/main/phoneInvoiceStaging";

const TOKEN = "b".repeat(64);
const HOST = "127.0.0.1";
const companion = (now = 1_000) => createSession({ action: "COMPANION", productId: null, operatorId: "op" }, now, () => TOKEN);

describe("domain: selection-only, then locked", () => {
  it("a COMPANION starts with NO purpose (selection only), 10-minute cap, no product", () => {
    const s = companion();
    expect(effectiveAction(s)).toBeNull();
    expect(s.expiresAtMs - s.createdAtMs).toBe(PHONE_SESSION_TTL_MS);
    expect(authorizes(s, "NEW_PRODUCT", null)).toBe(false);
    expect(() => createSession({ action: "COMPANION", productId: "p1", operatorId: "op" }, 1, () => TOKEN)).toThrow();
  });
  it("🔴 the first choice locks; the same choice again changes nothing; the OTHER is refused", () => {
    const s = companion();
    expect(lockPurpose(s, "NEW_PRODUCT")).toBe("locked");
    expect(effectiveAction(s)).toBe("NEW_PRODUCT");
    expect(authorizes(s, "NEW_PRODUCT", null)).toBe(true);
    expect(lockPurpose(s, "NEW_PRODUCT")).toBe("same");
    expect(lockPurpose(s, "INVOICE_BATCH")).toBe("refused");
    expect(effectiveAction(s)).toBe("NEW_PRODUCT");
  });
  it("an invoice choice gets the 30-minute cap counted from CREATION (choosing late does not extend it)", () => {
    const s = companion(5_000);
    expect(lockPurpose(s, "INVOICE_BATCH")).toBe("locked");
    expect(s.expiresAtMs).toBe(5_000 + PHONE_INVOICE_SESSION_TTL_MS);
  });
  it("a single-purpose session can never be re-purposed by a choice", () => {
    const p = createSession({ action: "NEW_PRODUCT", productId: null, operatorId: "op" }, 1, () => TOKEN);
    expect(lockPurpose(p, "INVOICE_BATCH")).toBe("refused");
    expect(lockPurpose(p, "NEW_PRODUCT")).toBe("same");
    const e = createSession({ action: "EDIT_PRODUCT", productId: "p1", operatorId: "op" }, 1, () => TOKEN);
    expect(lockPurpose(e, "NEW_PRODUCT")).toBe("refused");
  });
  it("routes: /choose/product and /choose/invoice only", () => {
    expect(parseRoute(`/m/${TOKEN}/choose/product`)).toEqual({ kind: "choose", token: TOKEN, purpose: "NEW_PRODUCT" });
    expect(parseRoute(`/m/${TOKEN}/choose/invoice`)).toEqual({ kind: "choose", token: TOKEN, purpose: "INVOICE_BATCH" });
    expect(parseRoute(`/m/${TOKEN}/choose/edit`)).toEqual({ kind: "unknown" });
    expect(parseRoute(`/m/${TOKEN}/choose`)).toEqual({ kind: "unknown" });
  });
});

// ── the real listener ──────────────────────────────────────────────────────────────────────────────
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function raw(port: number, head: string, body: Buffer = Buffer.alloc(0)): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port }, () => socket.end(Buffer.concat([Buffer.from(head), body])));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0), body: data.slice(data.indexOf("\r\n\r\n") + 4) }));
  });
}
const req = (port: number, method: string, path: string, ua = "phone", body = Buffer.alloc(0), key?: string) =>
  raw(port, `${method} ${path} HTTP/1.1\r\nHost: x\r\nUser-Agent: ${ua}\r\nConnection: close\r\nContent-Length: ${body.length}\r\n${key ? `X-Capture-Key: ${key}\r\n` : ""}\r\n`, body);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic")]);

async function companionServer() {
  const root = mkdtempSync(join(tmpdir(), "pos-companion-"));
  dirs.push(root);
  const staging = new PhoneInvoiceStaging(root, { decodes: () => true });
  const session = companion(Date.now());
  let batch: string | null = null;
  const chosen: PhonePurpose[] = [];
  const running = await startPhoneSessionServer({
    session,
    host: HOST,
    renderPage: (v) => `<html>${v.action}</html>`,
    save: () => ({ ok: true }),
    choosePurpose: (p) => {
      chosen.push(p);
      if (p === "INVOICE_BATCH") batch = staging.openBatch();
      return { ok: true, data: { purpose: p } };
    },
    receiveInvoice: (b, k) => {
      if (!batch) return { ok: false, code: "SESSION_CLOSED", message: "x" };
      const r = staging.add(batch, b, k);
      return r.ok ? { ok: true, data: { id: r.id } } : r;
    },
  });
  return { running, session, chosen };
}

describe("listener: the selection-only stage and the lock", () => {
  it("🔴 before a choice: only the landing page; a product save, an upload or a finish is a probe", async () => {
    const { running, session } = await companionServer();
    try {
      const page = await req(running.port, "GET", `/m/${TOKEN}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain("COMPANION");
      expect((await req(running.port, "POST", `/m/${TOKEN}`, "phone", Buffer.from("{}"))).status).toBe(404);
      expect((await req(running.port, "POST", `/m/${TOKEN}/invoice`, "phone", JPEG, "1".repeat(32))).status).toBe(404);
      expect(session.malformedCount).toBe(2);
      expect((await req(running.port, "GET", `/m/${TOKEN}/choose/invoice`)).status).toBe(404); // GET is not a choice
    } finally {
      await running.stop("cancelled");
    }
  });
  it("🔴 choose invoice → locked; then uploads work, the product save does not, and the other choice is refused", async () => {
    const { running, session, chosen } = await companionServer();
    try {
      const c = await req(running.port, "POST", `/m/${TOKEN}/choose/invoice`);
      expect(c.status).toBe(200);
      expect(session.purpose).toBe("INVOICE_BATCH");
      expect((await req(running.port, "GET", `/m/${TOKEN}`)).body).toContain("INVOICE_BATCH");
      expect((await req(running.port, "POST", `/m/${TOKEN}/invoice`, "phone", JPEG, "1".repeat(32))).status).toBe(200);
      expect((await req(running.port, "POST", `/m/${TOKEN}`, "phone", Buffer.from("{}"))).status).toBe(404);
      const again = await req(running.port, "POST", `/m/${TOKEN}/choose/invoice`);
      expect(again.status).toBe(200); // a double tap: no-op
      const other = await req(running.port, "POST", `/m/${TOKEN}/choose/product`);
      expect(other.status).toBe(409);
      expect(JSON.parse(other.body).code).toBe("PURPOSE_LOCKED");
      expect(chosen).toEqual(["INVOICE_BATCH"]); // prepared exactly once
    } finally {
      await running.stop("cancelled");
    }
  });
  it("🔴 a competing phone cannot choose (the first phone is bound)", async () => {
    const { running, session } = await companionServer();
    try {
      expect((await req(running.port, "GET", `/m/${TOKEN}`, "phone-A")).status).toBe(200);
      expect((await req(running.port, "POST", `/m/${TOKEN}/choose/product`, "phone-B")).status).toBe(404);
      expect(session.purpose).toBeNull();
      expect((await req(running.port, "POST", `/m/${TOKEN}/choose/product`, "phone-A")).status).toBe(200);
      expect(session.purpose).toBe("NEW_PRODUCT");
    } finally {
      await running.stop("cancelled");
    }
  });
  it("a single-purpose token cannot use the choice route at all", async () => {
    const session = createSession({ action: "NEW_PRODUCT", productId: null, operatorId: "op" }, Date.now(), () => TOKEN);
    const running = await startPhoneSessionServer({ session, host: HOST, renderPage: () => "<html></html>" });
    try {
      expect((await req(running.port, "POST", `/m/${TOKEN}/choose/invoice`)).status).toBe(404);
      expect(session.purpose).toBe("NEW_PRODUCT");
      expect(session.malformedCount).toBe(1);
    } finally {
      await running.stop("cancelled");
    }
  });
});

// 🔴 Found 2026-11-13: the landing script was served as `replace(//$/,"")` — a template literal ate a
// backslash — so it never ran and the choice buttons did nothing. Every HTTP-level test still passed,
// because none of them executes the page. These parse the scripts EXACTLY as served.
describe("the served phone pages' scripts are valid JavaScript", () => {
  const scriptOf = (html: string) => html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  it("landing page", async () => {
    const { renderPhoneLandingPage } = await import("../../src/main/phoneInvoicePage");
    expect(() => new Function(scriptOf(renderPhoneLandingPage()))).not.toThrow();
    expect(scriptOf(renderPhoneLandingPage())).toContain("replace(/\\/$/");
  });
  it("invoice page", async () => {
    const { renderPhoneInvoicePage } = await import("../../src/main/phoneInvoicePage");
    expect(() => new Function(scriptOf(renderPhoneInvoicePage({ items: [{ id: "a".repeat(32), bytes: 10 }], maxPerBatch: 20 })))).not.toThrow();
  });
});
