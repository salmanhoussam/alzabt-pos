/**
 * The synthetic gate's refusal REASON codes (after hosted run 45698905020 refused silently). The decision is unchanged —
 * `permitsSyntheticIdentity` is «no refusal» — and every invalid identity is still refused, now with a short code that
 * carries no name, SID or path.
 */
import { describe, expect, it } from "vitest";
import { permitsSyntheticIdentity, syntheticIdentityRefusal, type SyntheticGateIdentity } from "../../src/main/demoDevGate";

const ok: SyntheticGateIdentity = {
  platform: "win32", packaged: false, requested: true, user: "alzabt-test",
  qualified: "FV-AZ123-456\\alzabt-test", host: "fv-az123-456", sid: "S-1-5-21-1-2-3-1003", adminGroup: false,
};

describe("syntheticIdentityRefusal", () => {
  it("the intended standard account passes (and only then)", () => {
    expect(syntheticIdentityRefusal(ok)).toBeNull();
    expect(permitsSyntheticIdentity(ok)).toBe(true);
  });

  it.each<[string, Partial<SyntheticGateIdentity>, string]>([
    ["another platform", { platform: "linux" }, "gate:build"],
    ["packaged without the preview path (callers pass packaged=false only for an allowed build)", { packaged: true }, "gate:build"],
    ["not requested", { requested: false }, "gate:build"],
    ["another user (e.g. salma)", { user: "salma", qualified: "FV-AZ123-456\\salma" }, "gate:identity"],
    ["the runner administrator", { user: "runneradmin", qualified: "FV-AZ123-456\\runneradmin" }, "gate:identity"],
    ["a domain or other machine's alzabt-test", { qualified: "OTHERPC\\alzabt-test" }, "gate:hostname"],
    ["a non-local SID", { sid: "S-1-5-18" }, "gate:identity"],
    ["an administrator token", { adminGroup: true }, "gate:admin"],
  ])("🔴 %s → refused with %s", (_n, patch, code) => {
    const identity = { ...ok, ...patch };
    expect(syntheticIdentityRefusal(identity)).toBe(code);
    expect(permitsSyntheticIdentity(identity)).toBe(false);
  });

  it("codes are short tokens only — never a name, SID or path", () => {
    for (const patch of [{ user: "salma" }, { adminGroup: true }, { qualified: "X\\alzabt-test" }, { sid: "bad" }]) {
      expect(syntheticIdentityRefusal({ ...ok, ...patch })).toMatch(/^gate:[a-z-]+$/);
    }
  });
});
