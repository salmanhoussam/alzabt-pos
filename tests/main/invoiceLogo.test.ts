/**
 * WHICH logo a finalized invoice prints — the four answers, and the one that used to lie.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS. `invoiceLogoUrl` lived in `src/main/main.ts`, which exports NOTHING and
 * which no unit test imports, so the decision that chooses the branding on a commercial document
 * had ZERO coverage. The resolver moved to `src/main/invoiceLogo.ts` for exactly this: the
 * filesystem arrives as two functions, so every case below is a few lines rather than an installed
 * application.
 *
 * 🔴 THE CASE THAT MATTERS IS THE THIRD ONE. The shop's live logo is stored under a FIXED name, so
 * the old "frozen, else live" fallback meant a historical invoice whose archived asset had been
 * lost would reprint carrying the shop's CURRENT logo. Not blank — WRONG, and wrong in a way that
 * looks right. That is the assertion this file is really here to hold.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { type InvoiceLogoFs, logoUnverifiedFor, logoWarningFor, resolveInvoiceLogo } from "../../src/main/invoiceLogo";

/**
 * A filesystem where only the named frozen assets exist — plus a live branding folder the resolver
 * must NEVER be able to reach. `liveFolder` is here only so a test can put today's logo on disk
 * and prove it is not used: the port has no way to ask for it.
 */
function fsWith(present: { frozen?: readonly string[] }): InvoiceLogoFs {
  const frozen = new Set(present.frozen ?? []);
  return { frozen: (name) => (frozen.has(name) ? `/userData/branding/frozen/${name}` : null) };
}

const FROZEN_NAME = "a1b2c3d4e5f60718293a4b5c6d7e8f90.png";
const LIVE_NAME = "invoice-logo.png";

describe("the logo a finalized invoice prints", () => {
  it("1 · uses exactly the frozen asset when the invoice named one and it is on disk", () => {
    const r = resolveInvoiceLogo({ logoAsset: FROZEN_NAME, logoPath: LIVE_NAME }, fsWith({ frozen: [FROZEN_NAME] }));
    expect(r).toEqual({ kind: "frozen", path: `/userData/branding/frozen/${FROZEN_NAME}` });
    expect(logoWarningFor(r)).toBe(false);
    expect(logoUnverifiedFor(r)).toBe(false);
  });

  it("🔴 2 · a NAMED but MISSING frozen asset prints NO logo — it never substitutes the current one", () => {
    const r = resolveInvoiceLogo({ logoAsset: FROZEN_NAME, logoPath: LIVE_NAME }, fsWith({ frozen: [] }));
    expect(r).toEqual({ kind: "missing" });
    expect(logoWarningFor(r)).toBe(true);
    expect(logoUnverifiedFor(r)).toBe(false);
    expect(JSON.stringify(r)).not.toContain(LIVE_NAME);
  });

  // 🔴 TRANSITION (Track 2 phase 3, owner decision 2026-10-28). Cases 3 and 5 used to read
  // "logoAsset === null keeps the legacy behaviour: the live branding file" → { kind: "legacy" },
  // and "a legacy invoice whose live file has since gone is 'none', NOT a warning". Both are
  // replaced: nothing proves today's file under that name is the logo the invoice was issued with.
  it("🔴 3 · an invoice that named a logo but never archived it prints NO logo, and says why", () => {
    const r = resolveInvoiceLogo({ logoAsset: null, logoPath: LIVE_NAME }, fsWith({}));
    expect(r).toEqual({ kind: "unverified" });
    expect(logoUnverifiedFor(r)).toBe(true);
    // Not the "archived file is missing" warning: nothing was ever archived for it.
    expect(logoWarningFor(r)).toBe(false);
  });

  it("4 · a shop with no logo at all resolves to none, and warns about nothing", () => {
    const r = resolveInvoiceLogo({ logoAsset: null, logoPath: null }, fsWith({}));
    expect(r).toEqual({ kind: "none" });
    expect(logoWarningFor(r)).toBe(false);
    expect(logoUnverifiedFor(r)).toBe(false);
  });

  it("6 · no issuer snapshot at all is 'none' rather than a crash", () => {
    expect(resolveInvoiceLogo(null, fsWith({}))).toEqual({ kind: "none" });
  });

  it("7 · the frozen asset is asked for BY ITS OWN NAME — and that is the only thing ever asked", () => {
    const asked: string[] = [];
    const spy: InvoiceLogoFs = {
      frozen: (name) => {
        asked.push(name);
        return null;
      },
    };
    expect(resolveInvoiceLogo({ logoAsset: FROZEN_NAME, logoPath: LIVE_NAME }, spy)).toEqual({ kind: "missing" });
    expect(resolveInvoiceLogo({ logoAsset: null, logoPath: LIVE_NAME }, spy)).toEqual({ kind: "unverified" });
    expect(asked).toEqual([FROZEN_NAME]);
  });
});

describe("🔴 an old invoice across a logo change — the substitution the owner ruled out", () => {
  // A legacy invoice, issued when the shop's logo was saved as invoice-logo.png and never archived.
  const legacy = { logoAsset: null, logoPath: LIVE_NAME } as const;
  // An invoice issued after freezing existed, with its own archived asset.
  const archived = { logoAsset: FROZEN_NAME, logoPath: LIVE_NAME } as const;

  it("before the shop changes its logo: the archived invoice prints its asset; the legacy one prints none", () => {
    const fs = fsWith({ frozen: [FROZEN_NAME] });
    expect(resolveInvoiceLogo(archived, fs).kind).toBe("frozen");
    expect(resolveInvoiceLogo(legacy, fs).kind).toBe("unverified");
  });

  it("after the shop saves a NEW logo under the same name: neither invoice changes", () => {
    // The live file was overwritten in place (pickInvoiceLogo copies over invoice-logo.png). The
    // port cannot even see it — which is the point.
    const fs = fsWith({ frozen: [FROZEN_NAME] });
    expect(resolveInvoiceLogo(archived, fs)).toEqual({ kind: "frozen", path: `/userData/branding/frozen/${FROZEN_NAME}` });
    expect(resolveInvoiceLogo(legacy, fs)).toEqual({ kind: "unverified" });
  });

  it("archived asset lost (e.g. an incomplete restore), then a new file appears under the same name: still no logo, still warned", () => {
    const lost = fsWith({ frozen: [] });
    expect(resolveInvoiceLogo(archived, lost)).toEqual({ kind: "missing" });
    // A new logo saved afterwards changes nothing for this invoice: it is not its asset.
    expect(resolveInvoiceLogo(archived, lost)).toEqual({ kind: "missing" });
    expect(resolveInvoiceLogo(legacy, lost)).toEqual({ kind: "unverified" });
  });
});
