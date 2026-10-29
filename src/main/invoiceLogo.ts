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
 * 🔴 AND THE LEGACY FALLBACK IS GONE TOO (Track 2 phase 3, owner decision 2026-10-28). An invoice
 * with NO frozen asset (`logoAsset === null` with a `logoPath`) used to print today's live file by
 * that name. Nothing proves that file is the logo the invoice was issued with: the live logo is
 * stored under a FIXED name (`invoice-logo.<ext>`), so replacing it — or restoring a backup and
 * then choosing a new one — made old invoices reprint with a NEW logo, looking exactly right. The
 * owner's rule: never print a different logo in place of a historical one just because the file
 * name matches. With no fingerprint recorded at issue time there is no way to tell, so such an
 * invoice now prints WITHOUT a logo and the operator is told why (`unverified`).
 *
 * WHO THIS AFFECTS: invoices finalized before freezing existed, and invoices whose freeze failed at
 * finalization (which still records null and still issues the invoice — a tested, intentional
 * contract, tests/application/invoiceLogoFreeze.test.ts). Their content is untouched; only the
 * decorative logo is withheld. A finalized invoice is immutable and is NOT rewritten to fix this.
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
 * What to print. Only `frozen` carries a path: it is the one answer that is evidence about the
 * document itself.
 */
export type InvoiceLogoResolution =
  /** The archived asset for THIS invoice. The only answer that proves the branding. */
  | { readonly kind: "frozen"; readonly path: string }
  /** An asset was recorded and is NOT on disk. Print no logo and tell the operator. */
  | { readonly kind: "missing" }
  /**
   * The invoice named a logo but never archived it, so its original cannot be confirmed. Print no
   * logo and tell the operator — never today's file under the same name.
   */
  | { readonly kind: "unverified" }
  /** No logo was ever recorded for this invoice. Print no logo; nothing is wrong. */
  | { readonly kind: "none" };

/**
 * The filesystem, as the one question this decision asks: an absolute path or null, and null must
 * mean "not there". The implementation refuses anything that is not a plain file name inside its
 * own directory, which is what `logoPathFor` in main.ts does.
 *
 * 🔴 THERE IS NO LONGER A WAY TO ASK FOR THE LIVE FILE. The `live` port existed only for the legacy
 * fallback; removing it makes "print today's logo for an old invoice" impossible to express here.
 */
export interface InvoiceLogoFs {
  /** The frozen, content-addressed asset by its recorded name. */
  readonly frozen: (assetName: string) => string | null;
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

  // A logo was named and never archived: nothing can show which bytes it was.
  return issuer.logoPath !== null ? { kind: "unverified" } : { kind: "none" };
}

/** Whether the operator must be warned that this document's ARCHIVED logo is missing. */
export function logoWarningFor(resolution: InvoiceLogoResolution): boolean {
  return resolution.kind === "missing";
}

/** Whether the operator must be told this document's original logo could not be confirmed. */
export function logoUnverifiedFor(resolution: InvoiceLogoResolution): boolean {
  return resolution.kind === "unverified";
}
