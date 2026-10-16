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
  /**
   * THE ONE NAMED OPERATION THIS SURFACE MAY PERFORM. Slice H2.
   *
   * 🔴 IT IS A SINGLE CALLBACK, NOT A SERVICE AND NOT A DISPATCHER, and that is the whole
   * containment story. The listener cannot name a method, cannot reach a repository and cannot be
   * made to call anything else by what arrives in a request: the only thing it can do with a POST
   * body is hand those bytes to `save`. A `(channel, payload)` seam here would have turned an HTTP
   * endpoint into a remote IPC proxy, which the approved design forbids explicitly.
   *
   * It takes the RAW body. Parsing, validation, authorization and persistence all happen behind
   * it, in the domain and the service. Absent means saving is unavailable and a POST is refused —
   * which is what every H1-era test gets, so none of them can write a product by accident.
   */
  readonly save?: (body: Buffer) => PhoneSaveOutcome;
  /**
   * Slice I1. Stage a product photo for this session. NOTHING DURABLE HAPPENS HERE — the bytes are
   * validated and normalized through F's pipeline and held against the session until Save.
   */
  readonly stagePhoto?: (body: Buffer) => PhoneMediaOutcome;
  /** Slice I1. Read a barcode out of a photograph. Stores nothing at all. */
  readonly scanBarcode?: (body: Buffer) => Promise<PhoneMediaOutcome>;
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

/**
 * What a save attempt produced.
 *
 * 🔴 A REFUSAL CARRIES A MESSAGE FOR THE MERCHANT AND NOTHING ELSE. No stack, no SQL, no column
 * name, no internal code beyond the DomainError code the UI already shows at the till. An
 * unexpected fault becomes a generic sentence, exactly as `wrap` does for the IPC bridge.
 */
export type PhoneSaveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * What a media endpoint answers. `data` is the small contract the form reads back — never bytes,
 * never a path, never a filename.
 */
export type PhoneMediaOutcome =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string };

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

/**
 * The Arabic sentences the phone sees when a save cannot proceed.
 *
 * 🔴 EACH ONE BELONGS TO ITS OWN SITUATION, which this project learned the hard way: a text written
 * for one operation and reused because it is "close" reads to the merchant as a fault. "The code
 * expired" and "this was already saved" are different facts and must not share a sentence. None of
 * them names an internal code, a table or a path.
 */
const SESSION_CLOSED_AR = "انتهت صلاحية هذا الرمز. اطلب رمزاً جديداً من الصندوق.";
const ALREADY_SAVED_AR = "تم حفظ هذا الصنف مسبقاً. لا حاجة لإعادة الحفظ.";
const SAVE_UNAVAILABLE_AR = "الحفظ من الهاتف غير متاح على هذا الصندوق.";
const SAVE_FAILED_AR = "تعذّر الحفظ. حاول مرة أخرى أو أكمل من الصندوق.";
const TOO_LARGE_AR = "الصورة كبيرة جداً. جرّب صورة أصغر.";
const MEDIA_UNAVAILABLE_AR = "رفع الصور من الهاتف غير متاح على هذا الصندوق.";
const MEDIA_FAILED_AR = "تعذّرت معالجة الصورة. حاول مرة أخرى.";

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

  /** A JSON answer for the form's own fetch. Only ever `{ok}` or `{ok,code,message}`. */
  function json(res: ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.byteLength),
    });
    res.end(body);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const route = parseRoute(req.url ?? "");
    const client = {
      remoteAddress: req.socket.remoteAddress ?? "",
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    };

    // 🔴 AN UNKNOWN PATH IS NOT "MALFORMED". A phone requests /favicon.ico unprompted, and a
    // browser's speculative fetches would otherwise spend the session's three-strike budget before
    // the merchant typed anything. Unknown paths get a plain 404 and cost nothing.
    //
    // The body is still drained so the socket can close cleanly.
    if (route.kind === "unknown") {
      drain(req);
      refuse(res);
      return;
    }

    const method = req.method ?? "";
    // GET/HEAD serve the form; POST saves. Anything else against a REAL route is a genuine
    // protocol violation and spends budget — this is where a probe that found the path lands.
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      drain(req);
      spendMalformed(res, "method");
      return;
    }

    const verdict = checkAccess(session, route.token, client, now());
    if (!verdict.ok) {
      // A wrong token on a real-looking path is a probe. An "other_client" or stale attempt is
      // not: the second phone and the replay-after-end cases are honest refusals that must NOT
      // let an attacker burn down a live session by replaying a URL they photographed.
      drain(req);
      if (verdict.refusal === "unknown_token") {
        spendMalformed(res, "token");
        return;
      }
      // 🔴 A POST gets JSON, not HTML, because the form's own handler parses the answer — and an
      // expired session must produce a sentence the merchant can read rather than a silent 404
      // that looks like a network fault. The STATUS is still 404 and the body still says nothing
      // about which refusal it was.
      if (method === "POST") json(res, 404, { ok: false, code: "SESSION_CLOSED", message: SESSION_CLOSED_AR });
      else refuse(res);
      return;
    }

    if (verdict.firstClaim) {
      claim(session, { ...client, claimedAtMs: now() });
      log?.info("phone-session-claimed", { action: session.action, editing: session.productId !== null });
    }

    if (method === "POST") {
      if (route.kind === "photo") {
        handleMedia(req, res, deps.stagePhoto ? (b) => deps.stagePhoto!(b) : undefined, "photo");
        return;
      }
      if (route.kind === "barcode") {
        handleMedia(req, res, deps.scanBarcode, "barcode");
        return;
      }
      handleSave(req, res);
      return;
    }

    // 🔴 THE MEDIA ROUTES ARE POST-ONLY. A GET on them is not a page and must not fall through to
    // serving the form, which would make `/m/<token>/photo` a second way to reach it.
    if (route.kind !== "page") {
      drain(req);
      spendMalformed(res, "method");
      return;
    }

    drain(req);
    const html = deps.renderPage({ action: session.action, editing: session.productId !== null });
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(body.byteLength),
    });
    if (method === "HEAD") res.end();
    else res.end(body);
  }

  /**
   * Read the body, hand it to `save`, and report.
   *
   * 🔴 BYTES ARE COUNTED AS THEY ARRIVE AND THE SOCKET IS DESTROYED PAST THE CAP. `Content-Length`
   * is never trusted — a hostile client simply lies about it — so the limit is enforced against
   * what actually turned up.
   *
   * 🔴 THE SESSION IS SPENT ON SUCCESS, BEFORE ANYTHING ELSE CAN ARRIVE. `savedCount` is
   * incremented and the session ended, so a retry, a double-tap or a replayed request is refused
   * by `checkAccess` on the way in rather than by a database constraint on the way out.
   */
  function handleSave(req: IncomingMessage, res: ServerResponse): void {
    const save = deps.save;
    if (!save) {
      drain(req);
      json(res, 503, { ok: false, code: "NOT_AVAILABLE", message: SAVE_UNAVAILABLE_AR });
      return;
    }

    // 🔴 ONE SAVE PER SESSION, CHECKED BEFORE THE BODY IS EVEN READ. The session is ended on the
    // first success, so this is belt-and-braces for a request that was already in flight when
    // that happened — two taps on a slow connection genuinely produce this race.
    if (session.savedCount > 0) {
      drain(req);
      json(res, 409, { ok: false, code: "ALREADY_SAVED", message: ALREADY_SAVED_AR });
      return;
    }

    // 🔴 THE SAME CAPPED READER THE MEDIA ROUTES USE. This used to hand-roll its own counting
    // loop; one implementation means one place where `Content-Length` is distrusted.
    readCappedBody(req, res, (body) => {
      let outcome: PhoneSaveOutcome;
      try {
        outcome = save(body);
      } catch (err) {
        // `save` is written to return a refusal rather than throw; this is the backstop, and it
        // deliberately tells the phone nothing about what went wrong internally.
        log?.error("phone-session-save-fault", { error: err });
        json(res, 500, { ok: false, code: "INTERNAL", message: SAVE_FAILED_AR });
        return;
      }

      if (!outcome.ok) {
        // 🔴 A REFUSED SAVE LEAVES THE SESSION LIVE. The merchant fixes the price and saves again;
        // ending the session on a validation error would force them back to the till for a new QR
        // and lose everything they typed — including a staged photo. Nothing durable was written,
        // which is the invariant that makes keeping it open safe.
        log?.info("phone-session-save-refused", { code: outcome.code });
        json(res, 422, { ok: false, code: outcome.code, message: outcome.message });
        return;
      }

      session.savedCount += 1;
      log?.info("phone-session-saved", { action: session.action, editing: session.productId !== null });
      json(res, 200, { ok: true });
      // The surface closes behind a successful save: the token is spent, the listener shuts, and a
      // replay cannot even connect.
      void stop("completed");
    });
  }

  /**
   * Read a request body with a hard cap, or destroy the socket.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * 🔴 TWO CHECKS, AND THE SECOND IS THE REAL ONE. `Content-Length` is consulted first so an
   * obviously oversized upload is refused before a byte of it is read — but a hostile client
   * simply lies about that header, so the bytes are ALSO counted as they arrive and the socket is
   * destroyed the moment the real total passes the cap. Trusting the declaration alone is how an
   * "unlimited" upload gets through a limit that looks enforced.
   *
   * 🔴 THE CAP IS THE TRANSPORT CAP, NOT F's SOURCE CAP. F allows a 32 MB source because a desktop
   * picker reads a trusted local file. This is an untrusted LAN socket, so it keeps the 12 MB the
   * phone surface has had since H1 — tighter, deliberately, and not a contradictory second limit:
   * a body that passes here is then held to every one of F's own limits unchanged.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  function readCappedBody(
    req: IncomingMessage,
    res: ServerResponse,
    then: (body: Buffer) => void,
  ): void {
    const declared = Number(req.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > PHONE_REQUEST_BODY_CAP_BYTES) {
      log?.warn("phone-session-body-declared-too-large", { declared });
      drain(req);
      json(res, 413, { ok: false, code: "TOO_LARGE", message: TOO_LARGE_AR });
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      received += chunk.length;
      if (received > PHONE_REQUEST_BODY_CAP_BYTES) {
        aborted = true;
        log?.warn("phone-session-body-cap", { received });
        // Answer before destroying, so the phone gets a sentence rather than a dead socket.
        try {
          json(res, 413, { ok: false, code: "TOO_LARGE", message: TOO_LARGE_AR });
        } catch {
          // The socket may already be gone; the destroy below is what matters.
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("aborted", () => {
      aborted = true;
    });
    req.on("end", () => {
      if (aborted) return;
      then(Buffer.concat(chunks));
    });
  }

  /**
   * One shape for both media endpoints.
   *
   * 🔴 NEITHER OF THEM ENDS THE SESSION, on success OR on failure. A merchant photographs a label,
   * the decoder misses (roughly one difficult photo in three does), and they take another — losing
   * the session there would cost them everything they had already typed. Only a successful SAVE
   * spends the session.
   */
  function handleMedia(
    req: IncomingMessage,
    res: ServerResponse,
    run: ((body: Buffer) => PhoneMediaOutcome | Promise<PhoneMediaOutcome>) | undefined,
    kind: string,
  ): void {
    if (!run) {
      drain(req);
      json(res, 503, { ok: false, code: "NOT_AVAILABLE", message: MEDIA_UNAVAILABLE_AR });
      return;
    }
    // A session that has already saved is finished; its media routes close with it.
    if (session.savedCount > 0) {
      drain(req);
      json(res, 409, { ok: false, code: "ALREADY_SAVED", message: ALREADY_SAVED_AR });
      return;
    }

    readCappedBody(req, res, (body) => {
      void (async () => {
        let outcome: PhoneMediaOutcome;
        try {
          outcome = await run(body);
        } catch (err) {
          log?.error("phone-session-media-fault", { kind, error: err });
          json(res, 500, { ok: false, code: "INTERNAL", message: MEDIA_FAILED_AR });
          return;
        }
        if (!outcome.ok) {
          log?.info("phone-session-media-refused", { kind, code: outcome.code });
          json(res, 422, { ok: false, code: outcome.code, message: outcome.message });
          return;
        }
        log?.info("phone-session-media-ok", { kind });
        json(res, 200, { ok: true, ...outcome.data });
      })();
    });
  }

  /** Consume a body we are not going to use, so the socket closes instead of stalling. */
  function drain(req: IncomingMessage): void {
    req.resume();
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
