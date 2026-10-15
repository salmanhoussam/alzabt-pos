/**
 * The real listener, over a real socket, on loopback.
 *
 * 🔴 WHY THESE TESTS BIND 127.0.0.1 WHEN PRODUCTION MUST NOT. The rule that forbids loopback is
 * about what goes in a QR — a phone resolving 127.0.0.1 reaches itself. A TEST is on the same host
 * as the listener, so loopback is the correct and only portable way to reach it: binding a real LAN
 * address would make the suite depend on this machine's adapters and fail in CI.
 *
 * The QR builder refuses loopback independently (`sessionUrl`, proven in
 * `tests/domain/phoneSession.test.ts`), and the bridge never asks for it — so nothing here weakens
 * that rule. These tests exercise the SERVER; that one guards the URL.
 *
 * 🔴 AND THE POINT OF TESTING THE SOCKET AT ALL: the domain tests prove the decisions are right,
 * and these prove the listener OBEYS them — including the one thing a pure test cannot see, which
 * is whether the port is actually closed afterwards.
 */
import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import {
  PHONE_SESSION_TTL_MS,
  createSession,
  type PhoneSession,
} from "../../src/domain/phoneSession";
import {
  renderPairedPage,
  startPhoneSessionServer,
  type RunningPhoneSessionServer,
} from "../../src/main/phoneSessionServer";

const HOST = "127.0.0.1";
const TOKEN = "c".repeat(64);
const OTHER = "d".repeat(64);

function session(
  over: Partial<{ action: "NEW_PRODUCT" | "EDIT_PRODUCT"; productId: string | null; nowMs: number }> = {},
): PhoneSession {
  const action = over.action ?? "NEW_PRODUCT";
  return createSession(
    {
      action,
      productId: over.productId ?? (action === "EDIT_PRODUCT" ? "manual:000001" : null),
      operatorId: "op-1",
    },
    over.nowMs ?? Date.now(),
    () => TOKEN,
  );
}

/** A bare HTTP/1.1 request, so the test controls the exact bytes — method, path and headers. */
async function raw(
  port: number,
  request: string,
): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port }, () => socket.write(request));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0);
      const split = data.indexOf("\r\n\r\n");
      resolve({
        status,
        headers: split >= 0 ? data.slice(0, split) : data,
        body: split >= 0 ? data.slice(split + 4) : "",
      });
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timed out talking to the phone listener"));
    });
  });
}

const get = (port: number, path: string, ua = "iPhone") =>
  raw(port, `GET ${path} HTTP/1.1\r\nHost: ${HOST}:${port}\r\nUser-Agent: ${ua}\r\nConnection: close\r\n\r\n`);

/** Is anything still listening? A connection refused is the proof a port is shut. */
async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function withServer(
  s: PhoneSession,
  body: (r: RunningPhoneSessionServer) => Promise<void>,
  nowMs?: () => number,
): Promise<void> {
  const running = await startPhoneSessionServer({
    session: s,
    host: HOST,
    renderPage: renderPairedPage,
    now: nowMs,
  });
  try {
    await body(running);
  } finally {
    await running.stop("cancelled");
  }
}

describe("the happy path", () => {
  it("serves the page to the first phone that presents the token", async () => {
    const s = session();
    await withServer(s, async (r) => {
      expect(r.port).toBeGreaterThan(0);
      const res = await get(r.port, `/m/${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.headers).toMatch(/text\/html/);
      expect(res.body).toContain("تم ربط الهاتف بالصندوق بنجاح");
      // The session is now bound to that phone.
      expect(s.boundClient).not.toBeNull();
      expect(s.boundClient?.userAgent).toBe("iPhone");
    });
  });

  it("the page is self-contained: no external URL of any kind", async () => {
    const s = session();
    await withServer(s, async (r) => {
      const res = await get(r.port, `/m/${TOKEN}`);
      // 🔴 An offline till may not reach a CDN, a font service or an analytics endpoint. Asserted
      // on the served bytes rather than on intent.
      expect(res.body).not.toMatch(/https?:\/\//);
      expect(res.body).not.toMatch(/\/\/(cdn|fonts|unpkg|jsdelivr)/i);
      expect(res.headers).toMatch(/Content-Security-Policy/);
      expect(res.headers).toMatch(/default-src 'none'/);
      // Nothing about this page should sit in a phone's cache — the token is in the URL.
      expect(res.headers).toMatch(/no-store/);
    });
  });

  /**
   * 🔴 THE TOKEN MUST NOT COME BACK OUT. The phone already has it, so echoing it costs nothing to
   * that phone — but it would put the live credential into the page source, where a screenshot, a
   * shoulder, or a later "share this page" would carry it.
   */
  it("🔴 the served page never echoes the token, the operator or the product", async () => {
    const s = session({ action: "EDIT_PRODUCT", productId: "manual:000001" });
    await withServer(s, async (r) => {
      const res = await get(r.port, `/m/${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(TOKEN);
      expect(res.body).not.toContain("op-1");
      expect(res.body).not.toContain("manual:000001");
      // CONTROL: it really is the EDIT page, so this is not matching an empty response.
      expect(res.body).toContain("تعديل صنف");
    });
  });
});

describe("refusals", () => {
  it("a wrong token gets 404 and no detail", async () => {
    const s = session();
    await withServer(s, async (r) => {
      const res = await get(r.port, `/m/${OTHER}`);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain(TOKEN);
      // 🔴 The body must not distinguish "wrong" from "expired" from "finished": that would tell a
      // prober which tokens had ever existed.
      expect(res.body.toLowerCase()).not.toMatch(/expire|unknown|ended|cancel/);
    });
  });

  it("an expired session refuses its own real token", async () => {
    const t0 = 1_760_000_000_000;
    let clock = t0;
    const s = session({ nowMs: t0 });
    await withServer(
      s,
      async (r) => {
        expect((await get(r.port, `/m/${TOKEN}`)).status).toBe(200);
        clock = t0 + PHONE_SESSION_TTL_MS + 1;
        expect((await get(r.port, `/m/${TOKEN}`)).status).toBe(404);
      },
      () => clock,
    );
  });

  /**
   * 🔴 THE SECOND PHONE. Same token, different user agent: refused, and the FIRST phone keeps
   * working afterwards. The second half is what distinguishes this from a listener that simply
   * broke.
   */
  it("🔴 a second phone is refused and the first still works", async () => {
    const s = session();
    await withServer(s, async (r) => {
      expect((await get(r.port, `/m/${TOKEN}`, "iPhone")).status).toBe(200);
      expect((await get(r.port, `/m/${TOKEN}`, "Android")).status).toBe(404);
      expect((await get(r.port, `/m/${TOKEN}`, "iPhone")).status).toBe(200);
    });
  });

  it("🔴 replay after completion is refused from the SAME phone", async () => {
    const s = session();
    const running = await startPhoneSessionServer({ session: s, host: HOST, renderPage: renderPairedPage });
    try {
      expect((await get(running.port, `/m/${TOKEN}`)).status).toBe(200);
      // The merchant saved. H2 will call this; H1 proves the consequence.
      await running.stop("completed");
      // The socket is gone, so the replay cannot even connect — which is the strongest possible
      // form of "refused".
      expect(await isListening(running.port)).toBe(false);
      expect(s.endedBy).toBe("completed");
    } finally {
      await running.stop("cancelled");
    }
  });

  /**
   * 🔴 AN UNKNOWN PATH IS NOT A STRIKE, AND THIS IS A REAL BEHAVIOUR NOT A DETAIL. Phones request
   * /favicon.ico unasked. If that spent the three-strike budget, a session would die before the
   * merchant finished reading the page — and the cause would look like a network fault.
   */
  it("🔴 /favicon.ico and other unknown paths cost NOTHING from the budget", async () => {
    const s = session();
    await withServer(s, async (r) => {
      for (const p of ["/favicon.ico", "/", "/apple-touch-icon.png", "/robots.txt", "/index.html"]) {
        expect((await get(r.port, p)).status, p).toBe(404);
      }
      expect(s.malformedCount).toBe(0);
      expect(s.endedBy).toBeNull();
      // CONTROL: the session is still fully usable after all that.
      expect((await get(r.port, `/m/${TOKEN}`)).status).toBe(200);
    });
  });

  it("🔴 three malformed requests on a REAL route tear the session down", async () => {
    const s = session();
    const running = await startPhoneSessionServer({ session: s, host: HOST, renderPage: renderPairedPage });
    try {
      // A wrong token on a well-formed route is a probe, and spends budget.
      await get(running.port, `/m/${OTHER}`);
      expect(s.malformedCount).toBe(1);
      await get(running.port, `/m/${OTHER}`);
      expect(s.malformedCount).toBe(2);
      await get(running.port, `/m/${OTHER}`);
      expect(s.malformedCount).toBe(3);
      expect(s.endedBy).toBe("malformed_budget");

      // And the surface is actually gone, not merely marked dead.
      await new Promise((res) => setTimeout(res, 50));
      expect(await isListening(running.port)).toBe(false);
    } finally {
      await running.stop("cancelled");
    }
  });

  /**
   * 🔴 THIS TEST'S MEANING CHANGED IN H2, AND THE OLD VALUE IS NAMED. In H1 a POST was a protocol
   * violation: there was no write surface, so it answered **404 and spent one malformed strike**.
   * H2 makes POST the save route, so a POST is now a legitimate request — and on a server wired
   * WITHOUT a `save` callback (every pairing-only test, and a mis-wired terminal) the honest answer
   * is 503 NOT_AVAILABLE, costing nothing from the budget.
   *
   * The assertion that matters is unchanged in spirit: a POST still cannot write anything here.
   * What changed is that it is refused as unavailable rather than as malformed.
   */
  it("a POST without a save callback is NOT_AVAILABLE — and costs no malformed strike", async () => {
    const s = session();
    await withServer(s, async (r) => {
      const res = await raw(
        r.port,
        `POST /m/${TOKEN} HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body).code).toBe("NOT_AVAILABLE");
      // Was 1 in H1, when a POST was treated as a protocol violation.
      expect(s.malformedCount).toBe(0);
      expect(s.savedCount).toBe(0);
    });
  });

  it("a method that is neither GET, HEAD nor POST is still malformed", async () => {
    const s = session();
    await withServer(s, async (r) => {
      const res = await raw(
        r.port,
        `DELETE /m/${TOKEN} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
      );
      expect(res.status).toBe(404);
      expect(s.malformedCount).toBe(1);
    });
  });
});

describe("what the listener cannot reach", () => {
  /**
   * 🔴 THE "NO UNINTENDED POS API" TEST, ASSERTED AS BEHAVIOUR RATHER THAN AS A PROMISE.
   *
   * The listener is constructed with a session and a render function — it is handed no service, no
   * database and no dispatcher. So the strongest available proof is that every URL shaped like an
   * API, an export, a file or an IPC channel answers 404 and returns no data. A future edit that
   * added a generic handler would fail this.
   */
  it("🔴 exposes NOTHING but /m/<token> — not sales, operators, backups, SQLite or IPC", async () => {
    const s = session();
    await withServer(s, async (r) => {
      const forbidden = [
        "/api/sales",
        "/sales",
        "/history",
        "/invoices",
        "/operators",
        "/settings",
        "/backup",
        "/export",
        "/pos.sqlite",
        "/ledger.sqlite",
        "/db",
        "/sql?q=select+1",
        "/ipc/listProducts",
        "/pos:listProducts",
        "/invoke?channel=exportBackup",
        "/m/" + TOKEN + "/save",
        "/m/" + TOKEN + "/image",
        "/m/" + TOKEN + "/../../etc/passwd",
        "/../package.json",
        "/node_modules/better-sqlite3/package.json",
      ];
      for (const path of forbidden) {
        const res = await get(r.port, path);
        expect(res.status, `${path} must not be served`).toBe(404);
        // Nothing resembling data came back.
        expect(res.body, path).not.toMatch(/\{|\[|SQLite|operator|cashier/i);
      }
      // CONTROL: the one real route still answers 200, so the loop above is not passing because
      // the server stopped working.
      expect((await get(r.port, `/m/${TOKEN}`)).status).toBe(200);
    });
  });
});

describe("shutdown", () => {
  it("🔴 cancel closes the socket, not just the session", async () => {
    const s = session();
    const running = await startPhoneSessionServer({ session: s, host: HOST, renderPage: renderPairedPage });
    expect(await isListening(running.port)).toBe(true);
    await running.stop("cancelled");
    expect(s.endedBy).toBe("cancelled");
    // The assertion that matters: a marked-dead session with a live port is still an open surface.
    expect(await isListening(running.port)).toBe(false);
  });

  it("🔴 expiry closes the socket with no request and no desktop action", async () => {
    // A two-millisecond TTL, by placing creation in the past — so the timer fires on its own.
    const t0 = Date.now();
    const s = createSession({ action: "NEW_PRODUCT", productId: null, operatorId: "op-1" }, t0 - PHONE_SESSION_TTL_MS + 20, () => TOKEN);
    const ended: string[] = [];
    const running = await startPhoneSessionServer({
      session: s,
      host: HOST,
      renderPage: renderPairedPage,
      onEnded: (reason) => ended.push(reason),
    });
    await new Promise((res) => setTimeout(res, 250));
    expect(s.endedBy).toBe("expired");
    expect(await isListening(running.port)).toBe(false);
    expect(ended).toEqual(["expired"]);
  });

  it("stopping twice is safe and keeps the first reason", async () => {
    const s = session();
    const running = await startPhoneSessionServer({ session: s, host: HOST, renderPage: renderPairedPage });
    await running.stop("completed");
    await running.stop("cancelled");
    expect(s.endedBy).toBe("completed");
    expect(await isListening(running.port)).toBe(false);
  });

  /**
   * 🔴 A KEEP-ALIVE SOCKET MUST NOT HOLD THE SURFACE OPEN. `server.close()` alone waits for idle
   * connections to end; a phone that fetched the page and kept its socket would keep the listener
   * alive after the session was over. `closeAllConnections()` is what makes the close real, and
   * this test is the only thing that would notice if it were removed.
   */
  it("🔴 closes even while a phone holds an idle keep-alive connection", async () => {
    const s = session();
    const running = await startPhoneSessionServer({ session: s, host: HOST, renderPage: renderPairedPage });
    const held = connect({ host: HOST, port: running.port });
    await new Promise((res) => held.on("connect", res));
    // Use it, then leave it open — exactly what a browser does.
    held.write(`GET /m/${TOKEN} HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: iPhone\r\n\r\n`);
    await new Promise((res) => setTimeout(res, 80));

    await Promise.race([
      running.stop("completed"),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("stop() hung on a keep-alive socket")), 3000)),
    ]);
    held.destroy();
    expect(await isListening(running.port)).toBe(false);
  });

  it("reports the end reason exactly once", async () => {
    const s = session();
    const ended: string[] = [];
    const running = await startPhoneSessionServer({
      session: s,
      host: HOST,
      renderPage: renderPairedPage,
      onEnded: (r) => ended.push(r),
    });
    await running.stop("cancelled");
    await running.stop("cancelled");
    expect(ended).toEqual(["cancelled"]);
  });
});
