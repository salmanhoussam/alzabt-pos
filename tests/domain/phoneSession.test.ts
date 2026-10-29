/**
 * The phone session's security rules, as unit tests over the pure state machine.
 *
 * 🔴 WHY THESE ARE NOT SERVER TESTS. Every assertion here is a security decision — expiry, the
 * one-phone rule, replay, the product binding. Driving them through a real socket would make each
 * one a timing-dependent integration test, and a flaky security test gets skipped. The listener's
 * own tests (`tests/main/phoneSessionServer.test.ts`) prove it OBEYS these decisions; this file
 * proves the decisions are right.
 *
 * Time is always explicit. No test here sleeps.
 */
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import {
  PHONE_SESSION_MALFORMED_BUDGET,
  PHONE_SESSION_TOKEN_BYTES,
  PHONE_SESSION_TTL_MS,
  authorizes,
  checkAccess,
  claim,
  createSession,
  end,
  isExpired,
  isLive,
  isLoopbackHost,
  parseRoute,
  recordMalformed,
  sessionUrl,
  type PhoneSession,
} from "../../src/domain/phoneSession";

const T0 = 1_760_000_000_000;
/** A token of exactly the right shape: 32 bytes as 64 lower-case hex characters. */
const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const phone = { remoteAddress: "192.168.1.55", userAgent: "iPhone" };
const otherPhone = { remoteAddress: "192.168.1.77", userAgent: "Android" };

function newSession(
  over: Partial<{ action: "NEW_PRODUCT" | "EDIT_PRODUCT"; productId: string | null; token: string }> = {},
): PhoneSession {
  const action = over.action ?? "NEW_PRODUCT";
  return createSession(
    { action, productId: over.productId ?? (action === "EDIT_PRODUCT" ? "manual:000001" : null), operatorId: "op-1" },
    T0,
    () => over.token ?? TOKEN,
  );
}

describe("minting a session", () => {
  it("carries the scope it was given and expires ten minutes later", () => {
    const s = newSession();
    expect(s.token).toBe(TOKEN);
    expect(s.action).toBe("NEW_PRODUCT");
    expect(s.productId).toBeNull();
    expect(s.operatorId).toBe("op-1");
    expect(s.createdAtMs).toBe(T0);
    expect(s.expiresAtMs).toBe(T0 + PHONE_SESSION_TTL_MS);
    expect(PHONE_SESSION_TTL_MS).toBe(10 * 60 * 1000);
    // Nothing is claimed or spent at birth.
    expect(s.boundClient).toBeNull();
    expect(s.malformedCount).toBe(0);
    expect(s.endedBy).toBeNull();
  });

  it("EDIT_PRODUCT must name a product, and NEW_PRODUCT must not", () => {
    expect(() => createSession({ action: "EDIT_PRODUCT", productId: null, operatorId: "op-1" }, T0, () => TOKEN))
      .toThrow(DomainError);
    expect(() =>
      createSession({ action: "NEW_PRODUCT", productId: "manual:000001", operatorId: "op-1" }, T0, () => TOKEN),
    ).toThrow(DomainError);
  });

  /**
   * 🔴 THE DISCRIMINATING TEST FOR THE TOKEN'S STRENGTH. The token is the only credential on the
   * LAN surface, so a caller that supplied a short or non-random-looking one would silently reduce
   * 256 bits to whatever it felt like — and every other test in this file would still pass, because
   * none of them care how long the token is.
   *
   * CONTROL below: a token of exactly the right length IS accepted, so this is not matching
   * nothing.
   */
  it("🔴 refuses a token shorter than 32 bytes, or not lower-case hex — and ACCEPTS a correct one", () => {
    expect(PHONE_SESSION_TOKEN_BYTES).toBe(32);
    const refuse = (t: string) =>
      expect(
        () => createSession({ action: "NEW_PRODUCT", productId: null, operatorId: "op-1" }, T0, () => t),
        `token '${t.slice(0, 12)}…' (${t.length} chars) should be refused`,
      ).toThrow(DomainError);

    refuse("");
    refuse("a".repeat(63)); // one hex character short of 32 bytes
    refuse("A".repeat(64)); // upper-case: not the canonical form
    refuse("g".repeat(64)); // not hex at all
    refuse("deadbeef"); // a plausible-looking but tiny token
    refuse("550e8400-e29b-41d4-a716-446655440000"); // a UUID — 122 bits, with a known layout

    // CONTROL: exactly 64 lower-case hex characters is accepted.
    expect(newSession().token).toHaveLength(64);
  });
});

describe("expiry", () => {
  it("is live up to the boundary and dead on it", () => {
    const s = newSession();
    expect(isLive(s, T0)).toBe(true);
    expect(isLive(s, T0 + PHONE_SESSION_TTL_MS - 1)).toBe(true);
    // 🔴 The boundary itself is EXPIRED, not live. Stated as a test because an off-by-one here
    // means a session that outlives its own stated lifetime.
    expect(isExpired(s, T0 + PHONE_SESSION_TTL_MS)).toBe(true);
    expect(isLive(s, T0 + PHONE_SESSION_TTL_MS)).toBe(false);
  });

  it("an expired token is refused even though it is the RIGHT token", () => {
    const s = newSession();
    const late = checkAccess(s, TOKEN, phone, T0 + PHONE_SESSION_TTL_MS + 1);
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.refusal).toBe("expired");
  });
});

describe("the token itself", () => {
  it("a wrong token is refused, and is refused BEFORE expiry is even considered", () => {
    const s = newSession();
    // Expired AND wrong: the answer must be `unknown_token`, so a prober cannot learn that a
    // session once existed at this moment in time.
    const r = checkAccess(s, OTHER_TOKEN, phone, T0 + PHONE_SESSION_TTL_MS + 1);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.refusal).toBe("unknown_token");
  });

  it("a missing session refuses without dereferencing anything", () => {
    const r = checkAccess(null, TOKEN, phone, T0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.refusal).toBe("no_session");
  });

  it("a token of the right length but one character different is refused", () => {
    const s = newSession();
    const nearly = TOKEN.slice(0, 63) + "b";
    expect(checkAccess(s, nearly, phone, T0).ok).toBe(false);
  });
});

describe("one phone, and only one", () => {
  it("the first request claims it; the same phone keeps it", () => {
    const s = newSession();
    const first = checkAccess(s, TOKEN, phone, T0);
    expect(first.ok && first.firstClaim).toBe(true);
    claim(s, { ...phone, claimedAtMs: T0 });

    const again = checkAccess(s, TOKEN, phone, T0 + 1000);
    expect(again.ok).toBe(true);
    expect(again.ok && again.firstClaim).toBe(false);
  });

  it("🔴 a SECOND phone is refused — the first is not displaced", () => {
    const s = newSession();
    claim(s, { ...phone, claimedAtMs: T0 });

    const intruder = checkAccess(s, TOKEN, otherPhone, T0 + 5);
    expect(intruder.ok).toBe(false);
    expect(intruder.ok === false && intruder.refusal).toBe("other_client");

    // The binding is UNCHANGED. This is the half that would be missing if `claim` overwrote: a
    // "last phone wins" implementation also refuses nothing, and the first phone would keep typing
    // into a session that had silently moved.
    expect(s.boundClient?.remoteAddress).toBe(phone.remoteAddress);
    expect(s.boundClient?.userAgent).toBe(phone.userAgent);
    // And the original phone still works.
    expect(checkAccess(s, TOKEN, phone, T0 + 10).ok).toBe(true);
  });

  it("claiming twice throws rather than overwriting", () => {
    const s = newSession();
    claim(s, { ...phone, claimedAtMs: T0 });
    expect(() => claim(s, { ...otherPhone, claimedAtMs: T0 + 1 })).toThrow(DomainError);
  });
});

describe("replay", () => {
  /**
   * 🔴 THE REPLAY CASE, WHICH IS THE WHOLE POINT OF ENDING A SESSION. A merchant saves, or cancels,
   * and the URL is still sitting in the phone's browser history and in whatever photographed the
   * QR. Re-presenting it must fail.
   */
  it("a completed session refuses its own token afterwards — from the SAME phone", () => {
    const s = newSession();
    claim(s, { ...phone, claimedAtMs: T0 });
    expect(checkAccess(s, TOKEN, phone, T0 + 10).ok).toBe(true);

    end(s, "completed");

    const replay = checkAccess(s, TOKEN, phone, T0 + 20);
    expect(replay.ok).toBe(false);
    expect(replay.ok === false && replay.refusal).toBe("ended");
  });

  it("a cancelled session refuses, and the FIRST reason is what sticks", () => {
    const s = newSession();
    end(s, "expired");
    end(s, "cancelled");
    // It really did expire; being cancelled afterwards does not rewrite what happened to it.
    expect(s.endedBy).toBe("expired");
  });

  it("every end reason refuses equally", () => {
    for (const reason of [
      "completed",
      "cancelled",
      "expired",
      "navigated_away",
      "app_closed",
      "second_client",
      "malformed_budget",
    ] as const) {
      const s = newSession();
      end(s, reason);
      expect(checkAccess(s, TOKEN, phone, T0 + 1).ok, reason).toBe(false);
    }
  });
});

describe("the malformed budget", () => {
  it("spends three, then ends the session", () => {
    expect(PHONE_SESSION_MALFORMED_BUDGET).toBe(3);
    const s = newSession();
    expect(recordMalformed(s)).toBe(false);
    expect(recordMalformed(s)).toBe(false);
    // The third is the one that tears it down.
    expect(recordMalformed(s)).toBe(true);
    expect(s.malformedCount).toBe(3);
    expect(s.endedBy).toBe("malformed_budget");
    expect(isLive(s, T0)).toBe(false);
  });
});

describe("the product binding — the token IS the scope", () => {
  it("an EDIT session authorizes ONLY its own product", () => {
    const s = newSession({ action: "EDIT_PRODUCT", productId: "manual:000001" });
    expect(authorizes(s, "EDIT_PRODUCT", "manual:000001")).toBe(true);
    // 🔴 The wrong product, which is the case a phone could only reach by inventing an id.
    expect(authorizes(s, "EDIT_PRODUCT", "manual:000002")).toBe(false);
    expect(authorizes(s, "EDIT_PRODUCT", null)).toBe(false);
  });

  it("🔴 the WRONG ACTION is refused in both directions", () => {
    const edit = newSession({ action: "EDIT_PRODUCT", productId: "manual:000001" });
    // An edit token cannot create.
    expect(authorizes(edit, "NEW_PRODUCT", null)).toBe(false);

    const create = newSession({ action: "NEW_PRODUCT" });
    // A create token cannot touch an existing product — not even by naming one.
    expect(authorizes(create, "EDIT_PRODUCT", "manual:000001")).toBe(false);
    expect(authorizes(create, "NEW_PRODUCT", null)).toBe(true);
    // And a create token authorizes no product at all.
    expect(authorizes(create, "NEW_PRODUCT", "manual:000001")).toBe(false);
  });
});

describe("the URL in the QR", () => {
  it("is the token on a LAN address, and nothing else", () => {
    const url = sessionUrl("192.168.1.20", 7311, TOKEN);
    expect(url).toBe(`http://192.168.1.20:7311/m/${TOKEN}`);
  });

  /**
   * 🔴 THE SECRECY ASSERTION, WRITTEN AS "WHAT IS ABSENT". A QR that carried an operator name or a
   * product id would put shop data on a surface anyone in the room can photograph, and the leak
   * would be invisible — the QR still scans, the session still works.
   */
  it("🔴 contains no operator, no product, no PIN, no path and no private state", () => {
    const url = sessionUrl("192.168.1.20", 7311, TOKEN);
    for (const secret of [
      "op-1",
      "manual:000001",
      "owner",
      "cashier",
      "1234",
      "pin",
      "ledger",
      ".sqlite",
      "Documents",
      "C:\\",
      "/home/",
    ]) {
      expect(url.toLowerCase(), `the QR URL must not mention '${secret}'`).not.toContain(secret.toLowerCase());
    }
    // The whole URL is four segments: scheme, authority, the literal "m", and the token. There is
    // no room in that shape for anything else to be smuggled in.
    expect(url.split("/").filter(Boolean)).toEqual(["http:", "192.168.1.20:7311", "m", TOKEN]);
  });

  /**
   * 🔴 LOCALHOST IN A QR IS UNRECOVERABLE AND MUST THROW. On the phone, `127.0.0.1` is the PHONE —
   * so the page silently fails to load with nothing to explain why. A filter that quietly skipped
   * loopback would leave the caller to produce some other wrong address; throwing makes it a
   * programming error at the point it is made.
   */
  it("🔴 REFUSES every spelling of loopback rather than producing an unreachable QR", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]", "0.0.0.0", "::"]) {
      expect(() => sessionUrl(host, 7311, TOKEN), `${host} must be refused`).toThrow(DomainError);
      expect(isLoopbackHost(host), `${host} is loopback`).toBe(true);
    }
    // CONTROL: a real private address is NOT loopback and does not throw.
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(() => sessionUrl("192.168.1.20", 7311, TOKEN)).not.toThrow();
  });

  it("refuses an impossible port and a non-hex token", () => {
    expect(() => sessionUrl("192.168.1.20", 0, TOKEN)).toThrow(DomainError);
    expect(() => sessionUrl("192.168.1.20", 70000, TOKEN)).toThrow(DomainError);
    expect(() => sessionUrl("192.168.1.20", 7311, "not-hex")).toThrow(DomainError);
  });
});

describe("routing", () => {
  it("recognises only /m/<token>", () => {
    expect(parseRoute(`/m/${TOKEN}`)).toEqual({ kind: "page", token: TOKEN });
    // A query string is ignored rather than parsed — no route takes one.
    expect(parseRoute(`/m/${TOKEN}?x=1`)).toEqual({ kind: "page", token: TOKEN });
  });

  /**
   * 🔴 NOTHING HERE CAN BECOME A FILESYSTEM PATH. The parser returns a token or "unknown" — never a
   * path fragment — so there is no downstream join for a `..` to escape through. These inputs are
   * the ones that would matter if there were.
   */
  it("🔴 refuses traversal, absolute paths, and every other shape", () => {
    for (const path of [
      "/",
      "/m",
      "/m/",
      "/m/../../etc/passwd",
      "/m/..%2f..%2fetc%2fpasswd",
      `/m/${TOKEN}/../../secret`,
      "/../m/" + TOKEN,
      "/M/" + TOKEN, // the route is case-sensitive
      "/m/" + TOKEN.toUpperCase(), // tokens are lower-case hex
      "/m/" + "a".repeat(63), // too short to be a 32-byte token
      "/m/zz" + "a".repeat(62), // not hex
      "/favicon.ico",
      "/index.html",
      "/api/sales",
      "/..%5c..%5cwindows",
      "//m/" + TOKEN,
      "/m//" + TOKEN,
    ]) {
      expect(parseRoute(path), `'${path}' must not route`).toEqual({ kind: "unknown" });
    }
  });
});
