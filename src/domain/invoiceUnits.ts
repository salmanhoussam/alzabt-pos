/**
 * Unit labels on an invoice, and the explicit map from them to catalog base units.
 *
 * 🔴 TWO DIFFERENT THINGS, DELIBERATELY NOT ONE FIELD.
 *
 *   `unit_label`     what the operator wrote and what the paper invoice prints, verbatim:
 *                    "حبة", "كيلو", "كيس (50PCS)". Free text. Historical truth. Never rewritten.
 *   `canonical_unit` a member of BASE_UNITS, present ONLY when a known mapping exists or the
 *                    operator chose one. It is what the catalog can act on.
 *
 * A real invoice carries "كيس (50PCS)" — a bag containing fifty pieces. `BASE_UNITS` cannot express
 * that, and inventing a unit so the invoice fits would be exactly the silent normalisation this
 * whole feature forbids. So the invoice keeps the words; the catalog keeps the unit; reconciliation
 * is where a human joins them.
 *
 * The map is DATA, reviewed by eye, not an algorithm. A label that is not in it does not get
 * guessed — it gets asked about.
 */
import { BASE_UNITS } from "./catalog";
import { normalizeForSearch } from "./arabic";

/**
 * Known labels, Arabic and English, mapped to a catalog base unit. Keys are already normalised the
 * way `normalizeForSearch` normalises, so a hamza or a stray space cannot miss a mapping.
 *
 * Deliberately short. Every entry here is a claim that two words mean the same thing, and each one
 * should be defensible on its own; a long map assembled by guesswork is worse than no map.
 */
const KNOWN_LABELS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  // piece
  ["حبة", "piece"],
  ["حبه", "piece"],
  ["قطعة", "piece"],
  ["عدد", "piece"],
  ["piece", "piece"],
  ["pcs", "piece"],
  ["pc", "piece"],
  // kilogram
  ["كيلو", "kg"],
  ["كغ", "kg"],
  ["كيلوغرام", "kg"],
  ["كيلوجرام", "kg"],
  ["kg", "kg"],
  ["kilo", "kg"],
  // metre
  ["متر", "meter"],
  ["م", "meter"],
  ["meter", "meter"],
  ["metre", "meter"],
  ["m", "meter"],
  // box
  ["علبة", "box"],
  ["علبه", "box"],
  ["صندوق", "box"],
  ["box", "box"],
  // pack
  ["باكيت", "pack"],
  ["طقم", "pack"],
  ["pack", "pack"],
]);

const LABEL_MAP: ReadonlyMap<string, string> = new Map(
  KNOWN_LABELS.map(([label, unit]) => [normalizeForSearch(label), unit]),
);

/** The longest a printed unit label may be. Long enough for "كيس (50PCS)", short enough to bound. */
export const MAX_UNIT_LABEL = 40;

/**
 * The canonical unit a printed label maps to, or null when nothing is known about it.
 *
 * 🔴 null is a RESULT, not a failure. "كيس (50PCS)" returns null, and the invoice stores it happily;
 * only a catalog mutation needs a canonical unit, and that is where the operator is asked.
 */
export function canonicalUnitFor(label: string): string | null {
  if (typeof label !== "string") return null;
  return LABEL_MAP.get(normalizeForSearch(label)) ?? null;
}

/** True when the operator typed something that is already a catalog base unit, e.g. "kg". */
export function isCanonicalUnit(unit: string): boolean {
  return BASE_UNITS.includes(unit);
}

/**
 * Every label this build knows, for the "choose a catalog unit" panel — shown next to the base
 * units themselves so the operator sees what is already understood.
 */
export function knownLabelsFor(baseUnit: string): string[] {
  return KNOWN_LABELS.filter(([, unit]) => unit === baseUnit).map(([label]) => label);
}
