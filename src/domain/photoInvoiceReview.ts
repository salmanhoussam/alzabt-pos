/**
 * PHOTO-INVOICE-TO-ITEMS — the REVIEW rules (pure; no OCR, no database, no Electron).
 *
 * A supplier invoice photographed offline is read by OCR into candidate rows. Nothing read by OCR ever
 * reaches the catalog by itself: every row waits for an explicit decision by the operator, and these
 * rules decide when the review may finish. They are the release blocker's safety, written once:
 *
 *   🔴 NO AUTOMATIC CATALOG WRITE. A row starts `pending`; finishing is impossible while one is pending.
 *   🔴 SUPPLIER PRICE ≠ SALE PRICE. The price on a supplier invoice is a COST. A new product needs a
 *      sale price the operator TYPED; it is never defaulted from the cost. Equal to the cost is allowed
 *      but flagged; below the cost is flagged louder (selling at a loss is the owner's call, not ours).
 *   🔴 NOTHING INVENTED. The engine's original text stays on every row (`rawText`) for the operator to
 *      read; a row whose arithmetic does not hold (qty × price ≠ total) is shown as such, never "fixed".
 *   🔴 NO STOCK. This feature records what an invoice SAYS; it does not manage inventory (DEC-35r).
 *   🔴 NO HIDDEN CATALOG. A review can only ADD (new) or POINT AT (link) products; it never replaces
 *      the catalog the way a full CSV import would.
 *
 * Money is exact minor units (bigint). Quantity is milli-units (integer), as everywhere in this app.
 */

export interface ExtractedRow {
  readonly id: string;
  /** What the engine read for the whole row, exactly — shown for review, never parsed again here. */
  readonly rawText: string;
  readonly name: string;
  readonly quantityMilli: number | null;
  readonly supplierPriceMinor: bigint | null;
  readonly lineTotalMinor: bigint | null;
  /** True when the engine's own numbers satisfied qty × price = total. */
  readonly arithmeticOk: boolean;
}

export type RowDecision =
  | { readonly kind: "pending" }
  | { readonly kind: "skip" }
  | { readonly kind: "link"; readonly productId: string }
  | { readonly kind: "new"; readonly salePriceMinor: bigint | null };

export interface ReviewRow {
  readonly extracted: ExtractedRow;
  /** The operator's corrections; start as the extracted values. */
  readonly name: string;
  readonly quantityMilli: number | null;
  readonly supplierPriceMinor: bigint | null;
  readonly lineTotalMinor: bigint | null;
  readonly decision: RowDecision;
}

export type IssueCode =
  | "DECISION_PENDING"
  | "NAME_REQUIRED"
  | "QUANTITY_INVALID"
  | "SUPPLIER_PRICE_INVALID"
  | "TOTAL_MISMATCH"
  | "SALE_PRICE_REQUIRED"
  | "SALE_PRICE_EQUALS_COST"
  | "SALE_PRICE_BELOW_COST"
  | "PRODUCT_REQUIRED"
  /** A NEW product whose name already exists in the catalog (re-processing the same invoice): link it. */
  | "DUPLICATE_PRODUCT_NAME"
  /** Two rows of this review would create the same product name. */
  | "DUPLICATE_IN_REVIEW";

export interface Issue {
  readonly code: IssueCode;
  /** Blocking issues stop the review from finishing; warnings are shown and allowed. */
  readonly blocking: boolean;
}

export function startReview(rows: readonly ExtractedRow[]): ReviewRow[] {
  return rows.map((r) => ({
    extracted: r,
    name: r.name,
    quantityMilli: r.quantityMilli,
    supplierPriceMinor: r.supplierPriceMinor,
    lineTotalMinor: r.lineTotalMinor,
    decision: { kind: "pending" },
  }));
}

/** qty (milli) × unit price (minor) = total (minor), exactly, rounding half-up at the milli step. */
export function lineTotalOf(quantityMilli: number, unitPriceMinor: bigint): bigint {
  const raw = BigInt(quantityMilli) * unitPriceMinor; // minor × 1000
  return (raw + 500n) / 1000n;
}

export function rowIssues(row: ReviewRow): Issue[] {
  const out: Issue[] = [];
  const d = row.decision;
  if (d.kind === "pending") out.push({ code: "DECISION_PENDING", blocking: true });
  if (d.kind === "skip") return out; // a skipped row is not recorded anywhere: nothing else to check
  if (row.quantityMilli === null || !Number.isInteger(row.quantityMilli) || row.quantityMilli <= 0) {
    out.push({ code: "QUANTITY_INVALID", blocking: d.kind !== "pending" });
  }
  if (row.supplierPriceMinor === null || row.supplierPriceMinor <= 0n) {
    out.push({ code: "SUPPLIER_PRICE_INVALID", blocking: d.kind !== "pending" });
  }
  if (
    row.quantityMilli !== null &&
    row.quantityMilli > 0 &&
    row.supplierPriceMinor !== null &&
    row.lineTotalMinor !== null &&
    lineTotalOf(row.quantityMilli, row.supplierPriceMinor) !== row.lineTotalMinor
  ) {
    // Shown, never silently "fixed": the operator corrects the field that is wrong, or keeps it.
    out.push({ code: "TOTAL_MISMATCH", blocking: false });
  }
  if (d.kind === "link" && d.productId.trim() === "") out.push({ code: "PRODUCT_REQUIRED", blocking: true });
  if (d.kind === "new") {
    if (row.name.trim().length === 0) out.push({ code: "NAME_REQUIRED", blocking: true });
    if (d.salePriceMinor === null || d.salePriceMinor <= 0n) out.push({ code: "SALE_PRICE_REQUIRED", blocking: true });
    else if (row.supplierPriceMinor !== null && row.supplierPriceMinor > 0n) {
      if (d.salePriceMinor === row.supplierPriceMinor) out.push({ code: "SALE_PRICE_EQUALS_COST", blocking: false });
      else if (d.salePriceMinor < row.supplierPriceMinor) out.push({ code: "SALE_PRICE_BELOW_COST", blocking: false });
    }
  }
  return out;
}

/** Name equality for duplicate detection: Arabic letter variants, case and spacing folded. */
export function productNameKey(name: string): string {
  return name
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * NO DUPLICATE ON RE-PROCESSING (no schema needed): a NEW row whose name already names a catalog
 * product is BLOCKED — the operator links it instead; two NEW rows with one name block each other.
 */
export function reviewIssues(rows: readonly ReviewRow[], catalogNames: readonly string[]): Map<string, Issue[]> {
  const existing = new Set(catalogNames.map(productNameKey));
  const counts = new Map<string, number>();
  for (const r of rows) if (r.decision.kind === "new") counts.set(productNameKey(r.name), (counts.get(productNameKey(r.name)) ?? 0) + 1);
  const out = new Map<string, Issue[]>();
  for (const r of rows) {
    const issues = rowIssues(r);
    if (r.decision.kind === "new" && r.name.trim() !== "") {
      const k = productNameKey(r.name);
      if (existing.has(k)) issues.push({ code: "DUPLICATE_PRODUCT_NAME", blocking: true });
      else if ((counts.get(k) ?? 0) > 1) issues.push({ code: "DUPLICATE_IN_REVIEW", blocking: true });
    }
    out.set(r.extracted.id, issues);
  }
  return out;
}

export function canFinish(rows: readonly ReviewRow[], catalogNames: readonly string[] = []): boolean {
  if (rows.length === 0) return false;
  const all = reviewIssues(rows, catalogNames);
  return rows.every((r) => (all.get(r.extracted.id) ?? []).every((i) => !i.blocking));
}

/** The decision for a NEW row starts with NO sale price — never the supplier's. */
export function decideNew(row: ReviewRow): ReviewRow {
  return { ...row, decision: { kind: "new", salePriceMinor: null } };
}

export interface ReviewPlan {
  readonly create: ReadonlyArray<{ readonly rowId: string; readonly name: string; readonly salePriceMinor: bigint; readonly supplierPriceMinor: bigint }>;
  readonly link: ReadonlyArray<{ readonly rowId: string; readonly productId: string; readonly supplierPriceMinor: bigint }>;
  readonly skipped: readonly string[];
  /** Σ line totals of the rows kept (create + link), for the operator to compare with the paper. */
  readonly keptTotalMinor: bigint;
}

/**
 * What finishing WOULD do, for the operator to confirm. Refuses (throws) while any row blocks — the UI
 * cannot produce a plan the rules have not passed.
 */
export function planOf(rows: readonly ReviewRow[], catalogNames: readonly string[] = []): ReviewPlan {
  if (!canFinish(rows, catalogNames)) throw new Error("review is not finished");
  const create: Array<ReviewPlan["create"][number]> = [];
  const link: Array<ReviewPlan["link"][number]> = [];
  const skipped: string[] = [];
  let kept = 0n;
  for (const r of rows) {
    const d = r.decision;
    if (d.kind === "skip") {
      skipped.push(r.extracted.id);
      continue;
    }
    const cost = r.supplierPriceMinor as bigint;
    kept += r.lineTotalMinor ?? lineTotalOf(r.quantityMilli as number, cost);
    if (d.kind === "new") create.push({ rowId: r.extracted.id, name: r.name.trim(), salePriceMinor: d.salePriceMinor as bigint, supplierPriceMinor: cost });
    else if (d.kind === "link") link.push({ rowId: r.extracted.id, productId: d.productId, supplierPriceMinor: cost });
  }
  return { create, link, skipped, keptTotalMinor: kept };
}
