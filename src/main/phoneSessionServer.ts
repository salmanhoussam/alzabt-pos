/**
 * This product's FIRST inbound network surface. Temporary, scoped to one session, owner-opened.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS LISTENER CAN REACH, STATED AS A WHITELIST RATHER THAN A PROMISE.
 *
 * It holds a `PhoneSession` and a `renderPage` callback. That is the whole of its access. It has
 * NO database handle, NO `PosService`, NO `ipcMain`, NO filesystem path derived from a request, and
 * no way to name an operation — the two routes it answers are `/m/<token>` and nothing. There is
 * deliberately no dispatcher that takes a channel or method name from a request body, because that
 * is how an HTTP bridge becomes a remote IPC proxy with extra steps.
 *
 * Slice H2 will add the form POST. When it does, it calls NAMED service methods through an
 * explicit, enumerated handler — never a generic one — and the session's own `authorizes()` gates
 * the product it may touch.
 *
 * 🔴 IT BINDS ONE ADDRESS, NOT 0.0.0.0. `server.listen(port, host)` with the chosen LAN IPv4 means
 * the socket is not offered on every adapter the machine happens to have — including a VPN tunnel
 * that might carry it somewhere the shop did not intend.
 *
 * 🔴 EVERY EXIT PATH CLOSES THE SOCKET. Completion, cancellation, expiry, a second phone, the
 * malformed budget, and the app quitting all route through `stop()`. The timer is unref'd so it
 * can never by itself hold the process open, and `closeAllConnections()` is called so a phone
 * holding a keep-alive socket cannot keep the surface alive after the session is gone.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "./logger";
import {
  checkAccess,
  claim,
  end,
  parseRoute,
  recordMalformed,
  type PhoneSession,
  type PhoneSessionEndReason,
} from "../domain/phoneSession";

/** Everything the listener needs. Note the absence of a database, a service and an IPC handle. */
export interface PhoneSessionServerDeps {
  readonly session: PhoneSession;
  /** The LAN IPv4 to bind. Never 0.0.0.0, never loopback — the caller has already chosen. */
  readonly host: string;
  /**
   * The HTML served to the bound phone. H1 serves a minimal "session established" page; H2
   * replaces the body with the real form. It is handed NO session internals — only the action and
   * whether a product is being edited — so a template cannot leak the token or the operator.
   */
  readonly renderPage: (view: PhonePageView) => string;
  readonly now?: () => number;
  readonly logger?: Logger;
  /** Called once, when the session ends for any reason. The desktop refreshes on this. */
  readonly onEnded?: (reason: PhoneSessionEndReason) => void;
  /** 0 asks the OS for a free ephemeral port, which is what production does. */
  readonly port?: number;
}

/** The only thing a page template is allowed to know. */
export interface PhonePageView {
  readonly action: "NEW_PRODUCT" | "EDIT_PRODUCT";
  readonly editing: boolean;
}

export interface RunningPhoneSessionServer {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Ends the session and closes the socket. Safe to call repeatedly. */
  stop: (reason: PhoneSessionEndReason) => Promise<void>;
  readonly ended: () => PhoneSessionEndReason | null;
}

/**
 * A body cap, enforced on H1's GET surface too.
 *
 * H1 has no endpoint that WANTS a body, so any body at all is already wrong — but the cap is here
 * rather than in H2 because an unbounded request can exhaust memory before a handler ever runs.
 * 🔴 It counts bytes as they arrive and destroys the socket; it never trusts `Content-Length`,
 * which a hostile client simply lies about.
 */
export const PHONE_REQUEST_BODY_CAP_BYTES = 12 * 1024 * 1024;

/** Headers on every response. The phone page is self-contained; nothing external may load. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // 🔴 The served page must be as offline as the till. `default-src 'none'` with inline style/script
  // only: no CDN, no font service, no analytics, and no way for a future edit to add one quietly.
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // Nothing here should ever be cached on a phone — the token is in the URL.
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  // The session is the authority; a framed page has no legitimate use here.
  "X-Frame-Options": "DENY",
});

export async function startPhoneSessionServer(
  deps: PhoneSessionServerDeps,
): Promise<RunningPhoneSessionServer> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.logger;
  const session = deps.session;

  let stopping: Promise<void> | null = null;
  let expiryTimer: NodeJS.Timeout | null = null;

  const server: Server = createServer((req, res) => handle(req, res));

  /**
   * One refusal shape for every reason a token is not good.
   *
   * 🔴 404 WITH NO BODY DETAIL, DELIBERATELY. An "expired" reply distinguishes a token that once
   * existed from one that never did, which tells a prober that they have the right shop and the
   * wrong moment. The desktop knows the real reason; the network does not.
   */
  function refuse(res: ServerResponse): void {
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // Drain-and-cap first. A request with a body is already outside H1's surface, but it must be
    // read or destroyed rather than left to buffer.
    let received = 0;
    let destroyed = false;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > PHONE_REQUEST_BODY_CAP_BYTES && !destroyed) {
        destroyed = true;
        log?.warn("phone-session-body-cap", { received });
        req.destroy();
        res.destroy();
      }
    });

    const route = parseRoute(req.url ?? "");
    const client = {
      remoteAddress: req.socket.remoteAddress ?? "",
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    };

    // 🔴 AN UNKNOWN PATH IS NOT "MALFORMED". A phone requests /favicon.ico unprompted, and a
    // browser's speculative fetches would otherwise spend the session's three-strike budget before
    // the merchant typed anything. Unknown paths get a plain 404 and cost nothing.
    if (route.kind === "unknown") {
      refuse(res);
      return;
    }

    // Only GET exists in H1. Anything else against a REAL route is a genuine protocol violation
    // and spends budget — this is where a probe that found the path lands.
    if (req.method !== "GET" && req.method !== "HEAD") {
      spendMalformed(res, "method");
      return;
    }

    const verdict = checkAccess(session, route.token, client, now());
    if (!verdict.ok) {
      // A wrong token on a real-looking path is a probe. An "other_client" or stale attempt is
      // not: the second phone and the replay-after-end cases are honest refusals that must NOT
      // let an attacker burn down a live session by replaying a URL they photographed.
      if (verdict.refusal === "unknown_token") {
        spendMalformed(res, "token");
        return;
      }
      refuse(res);
      return;
    }

    if (verdict.firstClaim) {
      claim(session, { ...client, claimedAtMs: now() });
      log?.info("phone-session-claimed", { action: session.action, editing: session.productId !== null });
    }

    const html = deps.renderPage({ action: session.action, editing: session.productId !== null });
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(body.byteLength),
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  }

  function spendMalformed(res: ServerResponse, kind: string): void {
    const exhausted = recordMalformed(session);
    log?.warn("phone-session-malformed", { kind, count: session.malformedCount });
    refuse(res);
    if (exhausted) {
      log?.warn("phone-session-torn-down", { reason: "malformed_budget" });
      void stop("malformed_budget");
    }
  }

  async function stop(reason: PhoneSessionEndReason): Promise<void> {
    // 🔴 THE FIRST CALL WINS AND THE REST AWAIT IT. `stop` is reachable from a request handler, a
    // timer and the app's quit hook at once; without this a second caller could return while the
    // socket was still open, and a test asserting "closed" would pass against a live listener.
    if (stopping) return stopping;
    end(session, reason);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    stopping = new Promise<void>((resolve) => {
      // A phone holding a keep-alive socket would otherwise keep `close`'s callback waiting.
      server.closeAllConnections?.();
      server.close(() => resolve());
    }).then(() => {
      deps.onEnded?.(session.endedBy ?? reason);
    });
    return stopping;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 🔴 ONE HOST, and a backlog of 1: this surface serves exactly one phone, so there is no
    // reason to let a queue of connections build up behind it.
    server.listen(deps.port ?? 0, deps.host, 1, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  // Expiry closes the surface on its own, with no desktop interaction and no phone request needed.
  // 🔴 unref() so this timer can never be the reason the app stays alive on quit.
  const msLeft = Math.max(0, session.expiresAtMs - now());
  expiryTimer = setTimeout(() => {
    // 🔴 THE GUARD ASKS `endedBy`, NOT `isLive`, AND THE DIFFERENCE IS A REAL DEFECT THIS CODE HAD.
    //
    // The first version read `if (!isLive(session, now())) return;`, meaning to skip the teardown
    // when something else had already ended the session. But `isLive` is false for an EXPIRED
    // session — which is precisely the state this timer exists to handle — so it returned early
    // every single time and the socket was never closed. The session was correctly refused by
    // `checkAccess`, so every request-level test still passed; the LISTENER stayed bound
    // indefinitely with nothing to reveal it.
    //
    // Caught by "expiry closes the socket with no request and no desktop action", which is the one
    // test that asserts the PORT rather than the answer. An open port is the whole risk here, so
    // the condition has to be "has anything already ended it", not "is it still usable".
    if (session.endedBy !== null) return;
    log?.info("phone-session-expired", {});
    void stop("expired");
  }, msLeft);
  expiryTimer.unref?.();

  log?.info("phone-session-listening", { host: deps.host, port });

  return {
    host: deps.host,
    port,
    token: session.token,
    stop,
    ended: () => session.endedBy,
  };
}

/**
 * H1's placeholder page.
 *
 * 🔴 IT IS NOT THE FORM, BY INSTRUCTION. H1 proves pairing: that a phone on the shop LAN can scan
 * the QR, reach the till with no Internet, and be told the session is live. The Product Master
 * form, the photo capture and the barcode capture are H2/I and are deliberately absent.
 *
 * Arabic-first and RTL, matching the approved mobile UI direction, and entirely self-contained —
 * no external stylesheet, no font service, no script with any work to do.
 */
export function renderPairedPage(view: PhonePageView): string {
  const heading = view.editing ? "تعديل صنف" : "إضافة صنف";
  return `<!doctype html>
<html lang="ar" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>الزبط — ${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:24px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background:#faf9f7; color:#1a1a1a; line-height:1.6; }
  @media (prefers-color-scheme: dark) { body { background:#16181c; color:#f3f3f3; } }
  .card { max-width:34rem; margin:0 auto; padding:24px; border-radius:16px;
          background:rgba(127,127,127,.08); }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  .ok { font-weight:600; }
  .muted { opacity:.75; font-size:.95rem; }
</style>
<div class="card">
  <h1>${heading}</h1>
  <p class="ok">تم ربط الهاتف بالصندوق بنجاح.</p>
  <p class="muted">هذه الصفحة مؤقتة وتُغلق تلقائياً. لا تحتاج إلى إنترنت — الصندوق هو الذي يخدمها.</p>
  <p class="muted">نموذج إدخال الصنف سيصبح متاحاً في الخطوة التالية.</p>
</div>
</html>
`;
}
