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
import { type InvoiceLogoFs, logoWarningFor, resolveInvoiceLogo } from "../../src/main/invoiceLogo";

/** A filesystem where only the named files exist. Paths are the identity, so assertions read plainly. */
function fsWith(present: { frozen?: readonly string[]; live?: readonly string[] }): InvoiceLogoFs {
  const frozen = new Set(present.frozen ?? []);
  const live = new Set(present.live ?? []);
  return {
    frozen: (name) => (frozen.has(name) ? `/userData/branding/frozen/${name}` : null),
    live: (name) => (name !== null && live.has(name) ? `/userData/branding/${name}` : null),
  };
}

const FROZEN_NAME = "a1b2c3d4e5f60718293a4b5c6d7e8f90.png";
const LIVE_NAME = "invoice-logo.png";

describe("the logo a finalized invoice prints", () => {
  it("1 · uses exactly the frozen asset when the invoice named one and it is on disk", () => {
    const r = resolveInvoiceLogo(
      { logoAsset: FROZEN_NAME, logoPath: LIVE_NAME },
      fsWith({ frozen: [FROZEN_NAME], live: [LIVE_NAME] }),
    );
    expect(r).toEqual({ kind: "frozen", path: `/userData/branding/frozen/${FROZEN_NAME}` });
    expect(logoWarningFor(r)).toBe(false);
  });

  it("🔴 2 · a NAMED but MISSING frozen asset prints NO logo — it never substitutes the current one", () => {
    // The live logo is present and would have been chosen by the old resolver. It must not be.
    const r = resolveInvoiceLogo(
      { logoAsset: FROZEN_NAME, logoPath: LIVE_NAME },
      fsWith({ frozen: [], live: [LIVE_NAME] }),
    );
    expect(r).toEqual({ kind: "missing" });
    expect(logoWarningFor(r)).toBe(true);
    // Said once more as the property, not the shape: no path at all comes back.
    expect(JSON.stringify(r)).not.toContain(LIVE_NAME);
  });

  it("3 · logoAsset === null keeps the legacy behaviour: the live branding file", () => {
    const r = resolveInvoiceLogo({ logoAsset: null, logoPath: LIVE_NAME }, fsWith({ live: [LIVE_NAME] }));
    expect(r).toEqual({ kind: "legacy", path: `/userData/branding/${LIVE_NAME}` });
    expect(logoWarningFor(r)).toBe(false);
  });

  it("4 · a shop with no logo at all resolves to none, and warns about nothing", () => {
    const r = resolveInvoiceLogo({ logoAsset: null, logoPath: null }, fsWith({}));
    expect(r).toEqual({ kind: "none" });
    expect(logoWarningFor(r)).toBe(false);
  });

  it("5 · a legacy invoice whose live file has since gone is 'none', NOT a warning", () => {
    // Nothing was ever archived for this document, so nothing was lost. Printing without a logo is
    // what that build always did; telling the operator an asset is missing would be false.
    const r = resolveInvoiceLogo({ logoAsset: null, logoPath: LIVE_NAME }, fsWith({ live: [] }));
    expect(r).toEqual({ kind: "none" });
    expect(logoWarningFor(r)).toBe(false);
  });

  it("6 · no issuer snapshot at all is 'none' rather than a crash", () => {
    expect(resolveInvoiceLogo(null, fsWith({ live: [LIVE_NAME] }))).toEqual({ kind: "none" });
  });

  it("7 · the frozen asset is asked for BY ITS OWN NAME, and the live file is never consulted for it", () => {
    const asked: string[] = [];
    const spy: InvoiceLogoFs = {
      frozen: (name) => {
        asked.push(`frozen:${name}`);
        return `/f/${name}`;
      },
      live: (name) => {
        asked.push(`live:${String(name)}`);
        return null;
      },
    };
    resolveInvoiceLogo({ logoAsset: FROZEN_NAME, logoPath: LIVE_NAME }, spy);
    expect(asked).toEqual([`frozen:${FROZEN_NAME}`]);
  });

  it("8 · and a MISSING frozen asset still does not consult the live file", () => {
    const asked: string[] = [];
    const spy: InvoiceLogoFs = {
      frozen: (name) => {
        asked.push(`frozen:${name}`);
        return null;
      },
      live: (name) => {
        asked.push(`live:${String(name)}`);
        return `/live/${String(name)}`;
      },
    };
    const r = resolveInvoiceLogo({ logoAsset: FROZEN_NAME, logoPath: LIVE_NAME }, spy);
    expect(r).toEqual({ kind: "missing" });
    // 🔴 The whole fix, as a call trace: the live file is not even LOOKED UP, so it cannot leak in.
    expect(asked).toEqual([`frozen:${FROZEN_NAME}`]);
  });
});
