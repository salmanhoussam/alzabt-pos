/**
 * The temporary phone-entry session. Pure: no I/O, no HTTP, no database, no clock of its own.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A PURE STATE MACHINE AND NOT PART OF THE LISTENER.
 *
 * Slice H1 opens this product's FIRST inbound network surface. Every refusal it makes — an expired
 * token, a second phone, a replay, a wrong product — is a security decision, and a security
 * decision buried inside a `node:http` request handler can only be tested by standing up a real
 * server and racing it. Here each one is a function call with an explicit `now`, so the tests that
 * hold them are ordinary, deterministic unit tests that cannot pass for the wrong reason.
 *
 * The listener (`src/main/phoneSessionServer.ts`) owns sockets and nothing else: it parses a
 * request, asks this module what is allowed, and obeys.
 *
 * 🔴 TIME IS INJECTED, NEVER READ. A test for "expired" that has to sleep for ten minutes is a
 * test nobody runs. Every function that cares about expiry takes `now` as an argument.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { DomainError } from "./errors";

/**
 * What the phone is allowed to do with this session. The action is fixed when the owner creates
 * the session and is NEVER taken from a request: a token minted for EDIT_PRODUCT cannot create a
 * new product, and a token minted for NEW_PRODUCT cannot touch an existing one.
 */
export type PhoneSessionAction = "NEW_PRODUCT" | "EDIT_PRODUCT";

/**
 * Ten minutes, per the approved study. Long enough to walk to the shelf, photograph a label and
 * type a name; short enough that a QR photographed over someone's shoulder is worthless by the
 * time it is used.
 */
export const PHONE_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * 🔴 THIRTY-TWO BYTES, AND THE REASON IS NOT "LONG ENOUGH". The token is the ONLY credential on
 * the LAN surface — there is no PIN, no cookie and no operator name in the URL — so its entropy is
 * the entire authentication story. 256 bits is not guessable by any number of attempts a shop
 * network could carry, and the session dies after three malformed requests anyway.
 *
 * It is also deliberately NOT a UUID and NOT derived from the product id: a v4 UUID carries 122
 * bits with a known layout, and anything derived from the product id would let a phone that knows
 * one product's id compute another's token.
 */
export const PHONE_SESSION_TOKEN_BYTES = 32;

/**
 * How many requests a session may get WRONG before it is destroyed. Three, because a legitimate
 * phone makes zero: the only client that ever sees this surface arrived by scanning a QR that
 * carried the exact URL. A malformed request is therefore either a bug or a probe, and either way
 * the session has nothing to gain by staying open.
 */
export const PHONE_SESSION_MALFORMED_BUDGET = 3;

/** Why a session is no longer live. Reported so a desktop can say the true thing. */
export type PhoneSessionEndReason =
  | "completed"
  | "cancelled"
  | "expired"
  | "navigated_away"
  | "app_closed"
  | "second_client"
  | "malformed_budget";

/**
 * The session as the POS holds it. `token` is the secret; everything else is scope.
 *
 * 🔴 `boundClient` is the one-phone rule, and it is set by the FIRST successful GET rather than at
 * creation — the owner creates a session before any phone exists, so there is nobody to bind yet.
 */
export interface PhoneSession {
  readonly token: string;
  readonly action: PhoneSessionAction;
  /** The exact product for EDIT_PRODUCT. Always null for NEW_PRODUCT — there is no product yet. */
  readonly productId: string | null;
  readonly operatorId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** Set by the first claimant. A second client is refused rather than taking over. */
  boundClient: PhoneClient | null;
  /** Counts only genuinely malformed requests, never an honest 404 on an unknown path. */
  malformedCount: number;
  /** Set once the session is finished. A live session has `endedBy === null`. */
  endedBy: PhoneSessionEndReason | null;
}

/** Enough to tell one phone from another, and deliberately nothing more. */
export interface PhoneClient {
  readonly remoteAddress: string;
  readonly userAgent: string;
  readonly claimedAtMs: number;
}

/** What a session creation needs. The token's RANDOMNESS is the caller's job — see `createSession`. */
export interface PhoneSessionSpec {
  readonly action: PhoneSessionAction;
  readonly productId: string | null;
  readonly operatorId: string;
}

/**
 * Mint a session.
 *
 * `randomToken` is injected so a test can make the token predictable WITHOUT making production
 * predictable. 🔴 It must return at least `PHONE_SESSION_TOKEN_BYTES` worth of hex, and that is
 * CHECKED rather than trusted: a caller that quietly supplied a short token would weaken the only
 * credential on the surface, and nothing else in the system would notice.
 */
export function createSession(
  spec: PhoneSessionSpec,
  nowMs: number,
  randomToken: () => string,
): PhoneSession {
  if (spec.action === "EDIT_PRODUCT" && !spec.productId) {
    throw new DomainError("INVALID_INPUT", "Editing on the phone needs the product it is editing");
  }
  if (spec.action === "NEW_PRODUCT" && spec.productId) {
    throw new DomainError("INVALID_INPUT", "A new product cannot name an existing product");
  }
  const token = randomToken();
  if (typeof token !== "string" || !/^[0-9a-f]+$/.test(token) || token.length < PHONE_SESSION_TOKEN_BYTES * 2) {
    throw new DomainError(
      "INVALID_INPUT",
      `A phone session token must be at least ${PHONE_SESSION_TOKEN_BYTES} random bytes as lower-case hex`,
    );
  }
  return {
    token,
    action: spec.action,
    productId: spec.productId,
    operatorId: spec.operatorId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + PHONE_SESSION_TTL_MS,
    boundClient: null,
    malformedCount: 0,
    endedBy: null,
  };
}

/** Expiry is a comparison, stated once so no caller invents its own off-by-one. */
export function isExpired(session: PhoneSession, nowMs: number): boolean {
  return nowMs >= session.expiresAtMs;
}

/** Live means: not ended, and not expired. Both halves, every time. */
export function isLive(session: PhoneSession, nowMs: number): boolean {
  return session.endedBy === null && !isExpired(session, nowMs);
}

/**
 * Why a token presented to the listener was refused, or `null` when it is good.
 *
 * 🔴 EVERY REFUSAL RETURNS THE SAME SHAPE AND THE CALLER MUST NOT LEAK WHICH ONE. The listener
 * answers 404 for all of them. A surface that said "expired" for a real token and "unknown" for a
 * wrong one would confirm which tokens had ever existed.
 */
export type PhoneAccessRefusal =
  | "no_session"
  | "unknown_token"
  | "expired"
  | "ended"
  | "other_client";

export interface PhoneAccessOk {
  readonly ok: true;
  readonly session: PhoneSession;
  /** True when THIS call is the one that bound the phone. The caller persists the binding. */
  readonly firstClaim: boolean;
}

export interface PhoneAccessDenied {
  readonly ok: false;
  readonly refusal: PhoneAccessRefusal;
}

export type PhoneAccessResult = PhoneAccessOk | PhoneAccessDenied;

/**
 * May this request touch this session?
 *
 * The one place the token, the clock and the one-phone rule meet. Pure — it decides, it does not
 * mutate; `claim` performs the binding the result authorises.
 */
export function checkAccess(
  session: PhoneSession | null,
  token: string,
  client: { readonly remoteAddress: string; readonly userAgent: string },
  nowMs: number,
): PhoneAccessResult {
  if (!session) return { ok: false, refusal: "no_session" };

  // 🔴 CONSTANT-TIME-ISH, AND ORDER MATTERS. The token is compared BEFORE expiry and before the
  // client check, so a wrong token learns nothing about whether a session exists or who holds it.
  if (!tokensEqual(session.token, token)) return { ok: false, refusal: "unknown_token" };

  if (session.endedBy !== null) return { ok: false, refusal: "ended" };
  if (isExpired(session, nowMs)) return { ok: false, refusal: "expired" };

  if (session.boundClient === null) return { ok: true, session, firstClaim: true };

  if (!sameClient(session.boundClient, client)) return { ok: false, refusal: "other_client" };
  return { ok: true, session, firstClaim: false };
}

/**
 * Bind the session to this phone. Called only after `checkAccess` returned `firstClaim`.
 *
 * 🔴 IT REFUSES A SECOND BINDING rather than overwriting one. Overwriting would be the "last phone
 * wins" behaviour the study explicitly rejected, and it would be invisible: the first phone would
 * keep typing into a session that had silently moved.
 */
export function claim(session: PhoneSession, client: PhoneClient): void {
  if (session.boundClient !== null) {
    throw new DomainError("NOT_AUTHORIZED", "This code is already open on another phone");
  }
  session.boundClient = client;
}

/**
 * End a session. Idempotent in the sense that the FIRST reason sticks: a session that expired and
 * is then cancelled is still reported as expired, because that is what actually happened to it.
 */
export function end(session: PhoneSession, reason: PhoneSessionEndReason): void {
  if (session.endedBy === null) session.endedBy = reason;
}

/**
 * Record a malformed request and say whether the session has now spent its budget.
 *
 * Returns true when the caller must tear the session down.
 */
export function recordMalformed(session: PhoneSession): boolean {
  session.malformedCount += 1;
  if (session.malformedCount >= PHONE_SESSION_MALFORMED_BUDGET) {
    end(session, "malformed_budget");
    return true;
  }
  return false;
}

/**
 * Does this session authorise this action on this product?
 *
 * 🔴 THE TOKEN *IS* THE PRODUCT BINDING. The phone never names a product id and this function is
 * what makes that true: an EDIT session answers only for the one product it was minted for, and a
 * NEW session answers for no product at all. A future H2 handler calls this before any write.
 */
export function authorizes(
  session: PhoneSession,
  action: PhoneSessionAction,
  productId: string | null,
): boolean {
  if (session.action !== action) return false;
  if (action === "EDIT_PRODUCT") return productId !== null && productId === session.productId;
  return productId === null;
}

/**
 * The URL the QR encodes, and the ONLY thing it encodes.
 *
 * 🔴 WHAT IS NOT IN HERE IS THE POINT: no PIN, no operator name, no operator id, no product id, no
 * product name, no database path, no schema version, no session metadata. A photographed QR is an
 * opaque token on a private address, worth nothing once the session ends.
 *
 * 🔴 AND IT REFUSES LOOPBACK. `127.0.0.1` in a QR is a URL that resolves, on the phone, to the
 * PHONE — so it would fail in the most confusing way possible: a page that loads nothing with no
 * error to explain it. Loopback is a programming mistake here, not a configuration choice, so it
 * throws rather than being filtered out somewhere quieter.
 */
export function sessionUrl(host: string, port: number, token: string): string {
  if (isLoopbackHost(host)) {
    throw new DomainError("INVALID_INPUT", "A phone cannot reach the till over a loopback address");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DomainError("INVALID_INPUT", "A phone session needs a real TCP port");
  }
  if (!/^[0-9a-f]+$/.test(token)) {
    throw new DomainError("INVALID_INPUT", "A phone session token must be lower-case hex");
  }
  return `http://${host}:${port}/m/${token}`;
}

/** Loopback in every spelling a careless caller might reach for, IPv4 and IPv6. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "::") return true;
  if (h === "0.0.0.0") return true;
  return /^127\./.test(h);
}

/**
 * The path a request addresses, parsed into the only two shapes that exist.
 *
 * 🔴 NO PATH FROM A REQUEST EVER REACHES THE FILESYSTEM. This returns a token and a kind, not a
 * path fragment — there is nothing here for a `..` to traverse, because nothing downstream joins
 * request text onto a directory.
 */
export type PhoneRoute =
  | { readonly kind: "page"; readonly token: string }
  | { readonly kind: "unknown" };

export function parseRoute(rawUrl: string): PhoneRoute {
  // Only the path matters; a query string is ignored rather than parsed, since no route takes one.
  const path = rawUrl.split("?")[0] ?? "";
  const m = /^\/m\/([0-9a-f]{64,})$/.exec(path);
  if (m) return { kind: "page", token: m[1]! };
  return { kind: "unknown" };
}

/**
 * Token comparison that does not return early on the first differing byte.
 *
 * A LAN attacker cannot realistically time this, and 256 bits is not brute-forcible regardless —
 * but a token comparison written with `===` is the kind of thing a later reader copies into
 * somewhere it does matter, so it is written correctly once, here.
 */
function tokensEqual(a: string, b: string): boolean {
  if (typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Is this the phone we bound?
 *
 * Address AND user agent. Neither alone is sound: a phone switching from Wi-Fi to cellular and
 * back can change address, and every iPhone on the network shares a user-agent string. Together
 * they are enough to refuse the SECOND phone, which is all this rule has to do — it is a
 * one-session lock, not an authentication mechanism, and the token remains the credential.
 */
function sameClient(
  bound: PhoneClient,
  client: { readonly remoteAddress: string; readonly userAgent: string },
): boolean {
  return bound.remoteAddress === client.remoteAddress && bound.userAgent === client.userAgent;
}
