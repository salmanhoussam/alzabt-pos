/**
 * WHICH logo a FINALIZED invoice prints — as a pure decision, separated from the filesystem.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE main.ts.
 *
 * `src/main/main.ts` exports NOTHING and no unit test imports it, so every decision that lives
 * there is reachable only through a packaged application. This one decides what branding a
 * commercial document carries, and it had no test at all. The answer is the one this repository
 * already takes twice — `ledgerGuard.planLedgerOpen` with its injected `LedgerFs`, and
 * `renderer/thumbnails.ts`: the decision becomes a pure exported function, the filesystem arrives
 * as a narrow interface, and main keeps nothing but wiring.
 *
 * 🔴 THE DEFECT THIS FIXES, AND WHY IT WAS WORSE THAN A MISSING LOGO.
 *
 * The shop's live logo is stored under a FIXED name (`invoice-logo.<ext>`, see `pickInvoiceLogo`),
 * and the previous resolver was:
 *
 *     const frozen = issuer.logoAsset ? logoPathFor(issuer.logoAsset, FROZEN) : null;
 *     if (frozen) return url(frozen);
 *     return logoUrlFor(issuer.logoPath);        // ← branding/invoice-logo.<ext> — TODAY's logo
 *
 * `logoPathFor` ends in an `existsSync`, so it answers null when the frozen file is GONE. That made
 * "the archived asset was lost" indistinguishable from "this invoice was issued before freezing
 * existed", and both fell through to the live branding file. After restoring a database-only backup
 * onto a machine whose `branding/frozen/` is empty, a historical invoice could therefore reprint
 * carrying the shop's NEW logo — a document that looks correct and is not. A reprint with no logo
 * is an obvious gap; a reprint with the wrong logo is a quiet lie.
 *
 * So "named but absent" is now its own answer — `missing` — and it NEVER resolves to a path.
 *
 * 🔴 WHAT DELIBERATELY DID NOT CHANGE. `logoAsset === null` keeps the legacy fallback exactly as it
 * was: those invoices were finalized before freezing existed, they cannot be backfilled, and a
 * finalized invoice is immutable. And this module has nothing to do with freeze time — a freeze
 * failure during finalization still records null and still issues the invoice, which is a tested,
 * intentional contract (tests/application/invoiceLogoFreeze.test.ts). A till must not refuse to
 * issue a document because a decorative asset could not be copied.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The frozen issuer snapshot's two logo fields, and nothing else this decision could use. */
export interface InvoiceIssuerLogo {
  /** The content-addressed frozen asset's bare name, recorded at finalization. */
  readonly logoAsset: string | null;
  /** The live branding file's bare name as it was at finalization. */
  readonly logoPath: string | null;
}

/**
 * What to print.
 *
 * `frozen` and `legacy` both carry a real path; they are kept apart because only one of them is
 * evidence about the document itself — the other is today's file, shown only for invoices that
 * never had a frozen asset.
 */
export type InvoiceLogoResolution =
  /** The archived asset for THIS invoice. The only answer that proves the branding. */
  | { readonly kind: "frozen"; readonly path: string }
  /** Issued before freezing existed: the live branding file, as that build always did. */
  | { readonly kind: "legacy"; readonly path: string }
  /** An asset was recorded and is NOT on disk. Print no logo and tell the operator. */
  | { readonly kind: "missing" }
  /** No logo was ever recorded for this invoice. Print no logo; nothing is wrong. */
  | { readonly kind: "none" };

/**
 * The filesystem, as the two questions this decision asks.
 *
 * Each returns an absolute path or null, and null must mean "not there" — the implementation is
 * expected to refuse anything that is not a plain file name inside its own directory, which is what
 * `logoPathFor` in main.ts already does.
 */
export interface InvoiceLogoFs {
  /** The frozen, content-addressed asset by its recorded name. */
  readonly frozen: (assetName: string) => string | null;
  /** The shop's CURRENT branding file by its stored name. */
  readonly live: (storedName: string | null) => string | null;
}

/**
 * Decides which logo a finalized invoice prints.
 *
 * 🔴 A RECORDED-BUT-ABSENT ASSET NEVER FALLS BACK. That single branch is the whole fix.
 */
export function resolveInvoiceLogo(
  issuer: InvoiceIssuerLogo | null,
  fs: InvoiceLogoFs,
): InvoiceLogoResolution {
  if (!issuer) return { kind: "none" };

  if (issuer.logoAsset !== null) {
    const frozen = fs.frozen(issuer.logoAsset);
    // The document named its own archived branding. Either we print exactly that, or we print
    // nothing and say so — today's live file is not this invoice's logo and must not stand in.
    return frozen ? { kind: "frozen", path: frozen } : { kind: "missing" };
  }

  const legacy = fs.live(issuer.logoPath);
  return legacy ? { kind: "legacy", path: legacy } : { kind: "none" };
}

/** Whether the operator must be warned that this document printed without its own branding. */
export function logoWarningFor(resolution: InvoiceLogoResolution): boolean {
  return resolution.kind === "missing";
}
