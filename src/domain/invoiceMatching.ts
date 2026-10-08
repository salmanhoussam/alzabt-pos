/**
 * Matching an invoice line to the local catalog, and naming exactly how the two disagree.
 *
 * 🔴 THIS MODULE MUTATES NOTHING AND DECIDES NOTHING. It reads an invoice line and a catalog and
 * returns a classification. Every catalog change that follows is a separate, explicit, human act
 * through `PosService`. Nothing here may be wired to a write.
 *
 * 🔴 AND FUZZY SIMILARITY NEVER LINKS. It produces SUGGESTIONS for a person to look at. A score is
 * not evidence, and a catalog edited from a score is a catalog nobody can trust afterwards.
 */
import { normalizeForSearch } from "./arabic";
import { canonicalUnitFor } from "./invoiceUnits";

export const RECONCILIATION_CLASSIFICATIONS = [
  "MATCHED",
  "PRICE_DIFFERENCE",
  "UNIT_DIFFERENCE",
  "DESCRIPTION_DIFFERENCE",
  "MULTIPLE_DIFFERENCES",
  "PRODUCT_NOT_FOUND",
  "AMBIGUOUS_MATCH",
] as const;
export type ReconciliationClassification = (typeof RECONCILIATION_CLASSIFICATIONS)[number];

export const RESOLUTION_STATES = [
  "PENDING",
  "KEPT_CATALOG",
  "UPDATED_CATALOG",
  "CREATED_PRODUCT",
  "LINKED_PRODUCT",
  "KEPT_INVOICE_ONLY",
  "FAILED",
] as const;
export type ResolutionState = (typeof RESOLUTION_STATES)[number];

/** A resolved item has left the queue. PENDING and FAILED are the two that still need a person. */
export function isUnresolved(state: ResolutionState): boolean {
  return state === "PENDING" || state === "FAILED";
}

/** How a line was matched. `explicit` is the operator's own choice during entry. */
export const MATCH_TIERS = ["explicit", "sku", "name_ar", "name_en", "none"] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

/** The catalog fields matching and comparison need — a narrowing of the real product row. */
export interface CatalogCandidate {
  readonly id: string;
  readonly sku: string | null;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sellingPriceMinor: bigint;
  readonly baseUnit: string;
  readonly isActive: boolean;
}

/** What one invoice line says about a product. */
export interface InvoiceLineObservation {
  readonly description: string;
  /** Exactly as printed: "حبة", "كيس (50PCS)". */
  readonly unitLabel: string | null;
  readonly unitPriceMinor: bigint;
  /** Set only when the operator picked an existing product during entry. */
  readonly productId: string | null;
}

export type DifferenceField = "selling_price_minor" | "base_unit" | "name_ar" | "name_en";

export interface Difference {
  readonly field: DifferenceField;
  /** What the invoice says. For `base_unit` this is the PRINTED LABEL, not a canonical unit. */
  readonly invoice: string;
  /** What the catalog says now. */
  readonly catalog: string | null;
  /**
   * False when the two cannot honestly be compared — an unmapped unit label such as
   * "كيس (50PCS)". The difference is then "we do not know", not "they differ", and the operator is
   * asked for a canonical unit rather than told the catalog is wrong.
   */
  readonly comparable: boolean;
}

export interface MatchResult {
  readonly tier: MatchTier;
  readonly product: CatalogCandidate | null;
  /** For AMBIGUOUS_MATCH, the real contenders. For PRODUCT_NOT_FOUND, fuzzy suggestions only. */
  readonly candidates: ReadonlyArray<CatalogCandidate>;
}

export interface Classification {
  readonly classification: ReconciliationClassification;
  readonly match: MatchResult;
  readonly differences: ReadonlyArray<Difference>;
}

const byId = (a: CatalogCandidate, b: CatalogCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The match, strongest identifier first.
 *
 *   1  the product the operator explicitly chose while typing the invoice
 *   2  an exact SKU — unique by a partial index, so it can never be ambiguous
 *   3  an exact normalized Arabic name
 *   4  an exact normalized English name
 *   5  (suggestions only — never a match)
 *
 * Several products sharing an exact name is a real possibility, and it is reported as ambiguity
 * rather than resolved by picking one.
 */
export function matchInvoiceLine(
  observation: InvoiceLineObservation,
  catalog: ReadonlyArray<CatalogCandidate>,
): MatchResult {
  if (observation.productId) {
    const chosen = catalog.find((p) => p.id === observation.productId);
    if (chosen) return { tier: "explicit", product: chosen, candidates: [] };
    // The operator chose a product that is no longer in the catalog. Do not fall through to a
    // weaker tier and pretend: that would silently re-point the line at a different product.
    return { tier: "none", product: null, candidates: [] };
  }

  const needle = normalizeForSearch(observation.description);
  if (needle === "") return { tier: "none", product: null, candidates: [] };

  const bySku = catalog.filter((p) => p.sku !== null && normalizeForSearch(p.sku) === needle);
  if (bySku.length === 1) return { tier: "sku", product: bySku[0]!, candidates: [] };
  if (bySku.length > 1) return { tier: "none", product: null, candidates: [...bySku].sort(byId) };

  for (const [tier, pick] of [
    ["name_ar", (p: CatalogCandidate) => p.nameAr],
    ["name_en", (p: CatalogCandidate) => p.nameEn],
  ] as const) {
    const hits = catalog.filter((p) => {
      const value = pick(p);
      return value !== null && normalizeForSearch(value) === needle;
    });
    if (hits.length === 1) return { tier, product: hits[0]!, candidates: [] };
    if (hits.length > 1) return { tier: "none", product: null, candidates: [...hits].sort(byId) };
  }

  return { tier: "none", product: null, candidates: suggest(needle, catalog) };
}

/**
 * Suggestions, by shared word count on the normalized strings. Deterministic, explainable, and
 * deliberately crude — it exists to put three plausible rows in front of a person, not to decide.
 */
export function suggest(
  normalizedNeedle: string,
  catalog: ReadonlyArray<CatalogCandidate>,
  limit = 5,
): CatalogCandidate[] {
  const words = new Set(normalizedNeedle.split(" ").filter((w) => w.length > 1));
  if (words.size === 0) return [];
  const scored = catalog
    .map((p) => {
      const haystack = new Set(
        `${normalizeForSearch(p.nameAr)} ${normalizeForSearch(p.nameEn ?? "")}`
          .split(" ")
          .filter((w) => w.length > 1),
      );
      let shared = 0;
      for (const w of words) if (haystack.has(w)) shared += 1;
      return { product: p, shared };
    })
    .filter((s) => s.shared > 0);
  scored.sort((a, b) => b.shared - a.shared || byId(a.product, b.product));
  return scored.slice(0, limit).map((s) => s.product);
}

/** Every way an invoice line and its matched product disagree. Empty means they agree. */
export function differencesFor(
  observation: InvoiceLineObservation,
  product: CatalogCandidate,
): Difference[] {
  const out: Difference[] = [];

  if (observation.unitPriceMinor !== product.sellingPriceMinor) {
    out.push({
      field: "selling_price_minor",
      invoice: observation.unitPriceMinor.toString(),
      catalog: product.sellingPriceMinor.toString(),
      comparable: true,
    });
  }

  const label = observation.unitLabel;
  if (label !== null && label.trim() !== "") {
    const canonical = canonicalUnitFor(label);
    if (canonical === null) {
      // 🔴 Not "they differ" — "we cannot tell". The operator is asked, never guessed at.
      out.push({ field: "base_unit", invoice: label, catalog: product.baseUnit, comparable: false });
    } else if (canonical !== product.baseUnit) {
      out.push({ field: "base_unit", invoice: label, catalog: product.baseUnit, comparable: true });
    }
  }

  const needle = normalizeForSearch(observation.description);
  const matchesAr = normalizeForSearch(product.nameAr) === needle;
  const matchesEn = product.nameEn !== null && normalizeForSearch(product.nameEn) === needle;
  if (!matchesAr && !matchesEn) {
    // Only the ARABIC name is offered as the thing that differs. An English name is never inferred
    // from a free-text invoice description — see §22 of the contract.
    out.push({
      field: "name_ar",
      invoice: observation.description,
      catalog: product.nameAr,
      comparable: true,
    });
  }
  return out;
}

/** The whole judgement for one line: how it matched, and what that means. */
export function classifyInvoiceLine(
  observation: InvoiceLineObservation,
  catalog: ReadonlyArray<CatalogCandidate>,
): Classification {
  const match = matchInvoiceLine(observation, catalog);
  if (match.product === null) {
    return {
      classification: match.candidates.length > 1 ? "AMBIGUOUS_MATCH" : "PRODUCT_NOT_FOUND",
      match,
      differences: [],
    };
  }
  const differences = differencesFor(observation, match.product);
  if (differences.length === 0) return { classification: "MATCHED", match, differences };
  if (differences.length > 1) return { classification: "MULTIPLE_DIFFERENCES", match, differences };
  const only = differences[0]!;
  const single: ReconciliationClassification =
    only.field === "selling_price_minor"
      ? "PRICE_DIFFERENCE"
      : only.field === "base_unit"
        ? "UNIT_DIFFERENCE"
        : "DESCRIPTION_DIFFERENCE";
  return { classification: single, match, differences };
}
