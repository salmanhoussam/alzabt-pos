/**
 * The unit control on an invoice line: the SAME list the Add/Edit Product form uses, plus a free
 * text field reached only through «أخرى / Other».
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS. An invoice row let the operator type the unit freely, so the same thing got
 * written five ways and nothing connected it to the catalog's own units. The list comes from
 * `BASE_UNITS` — the one authoritative list, imported, never copied — so a unit added there appears
 * here with no second place to edit.
 *
 * 🔴 «أخرى / Other» IS NOT A SEVENTH OPTION. `BASE_UNITS` already ends in `"other"`, so offering a
 * separate "Other" beside it would show the operator two of them. The existing member IS the
 * escape hatch, and selecting it reveals the text field.
 *
 * 🔴 THE TWO FIELDS STAY TWO FIELDS, which is the whole reason `invoiceUnits.ts` exists:
 *
 *     unit_label      what the paper invoice PRINTS, verbatim, forever. Historical truth.
 *     canonical_unit  a BASE_UNITS member, only when it is actually known.
 *
 * So a known unit writes the LOCALISED label («حبة») into `unit_label` and the key (`piece`) into
 * `canonical_unit`. Writing the key into both would print "piece" on an Arabic invoice, which is
 * precisely the sort of thing the field reports next.
 *
 * `other` + typed text writes the text verbatim and leaves `canonical_unit` NULL — the service then
 * tries its own known-label map, which answers «كيلو» and honestly refuses «كيس (50PCS)». Nothing
 * guesses, and nothing rewrites what the operator wrote.
 *
 * 🔴 IT WRITES ON CHANGE, NEVER ON MOUNT. Reopening a draft must not rewrite its stored unit just
 * because this control would have spelled it differently. A line whose label this build cannot
 * match renders as Other with the label prefilled, and stays byte-for-byte that label unless the
 * operator themselves changes it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { useState } from "react";
import { BASE_UNITS } from "../../domain/catalog";
import { useT } from "../i18n";

/** The escape-hatch member of BASE_UNITS. Named once so no call site spells it as a literal. */
export const OTHER_UNIT = "other";

/** What a new line starts on — the same default the Add/Edit Product form uses. */
export const DEFAULT_UNIT = "piece";

export type UnitChoice = {
  /** What the invoice prints. Null only while «Other» has nothing typed into it yet. */
  readonly unitLabel: string | null;
  /** A BASE_UNITS member when known, else null — the service may still map the label itself. */
  readonly canonicalUnit: string | null;
  /** True when «Other» is selected and no unit has been typed. Blocks saving THIS row only. */
  readonly incomplete: boolean;
};

/**
 * Which dropdown entry a stored line shows, and what belongs in the free-text field.
 *
 * Exported because the draft-row state needs the same answer the cell shows, and two independent
 * derivations of "which unit is this" is how they drift apart.
 *
 * Deliberately only two ways to match, both exact:
 *   1. the label IS this build's localised label for a base unit  — «حبة» in Arabic
 *   2. the label IS a bare base-unit key                          — "piece", which the catalog
 *                                                                   prefill and older drafts store
 * Anything else is Other, prefilled. A label is never matched through the known-label map, because
 * that would let the selector display a unit the stored text does not literally say.
 */
export function unitSelection(
  unitLabel: string | null,
  canonicalUnit: string | null,
  localise: (baseUnit: string) => string,
): { readonly base: string; readonly custom: string } {
  const label = (unitLabel ?? "").trim();
  if (label === "") {
    // No label at all. A canonical unit is still a real answer; otherwise the operator must choose.
    return canonicalUnit && BASE_UNITS.includes(canonicalUnit)
      ? { base: canonicalUnit, custom: "" }
      : { base: OTHER_UNIT, custom: "" };
  }
  const localised = BASE_UNITS.find((u) => u !== OTHER_UNIT && localise(u) === label);
  if (localised) return { base: localised, custom: "" };
  if (BASE_UNITS.includes(label)) return { base: label, custom: "" };
  return { base: OTHER_UNIT, custom: label };
}

/** What a selection resolves to, in the two fields the invoice actually stores. */
export function unitChoiceFor(base: string, custom: string, localise: (baseUnit: string) => string): UnitChoice {
  if (base !== OTHER_UNIT) return { unitLabel: localise(base), canonicalUnit: base, incomplete: false };
  const typed = custom.trim();
  if (typed === "") return { unitLabel: null, canonicalUnit: null, incomplete: true };
  return { unitLabel: typed, canonicalUnit: null, incomplete: false };
}

type Props = {
  readonly unitLabel: string | null;
  readonly canonicalUnit: string | null;
  readonly disabled?: boolean;
  /** Suffix for this cell's testids, so two cells on one row are addressable apart. */
  readonly idSuffix: string;
  readonly onChange: (choice: UnitChoice) => void;
};

export function UnitCell({ unitLabel, canonicalUnit, disabled, idSuffix, onChange }: Props) {
  const { t, unit } = useT();

  /**
   * 🔴 CONTROLLED BY PROPS, with local state for the ONE state props cannot express.
   *
   * The first version held `base` and `custom` in `useState` initialised from the props, and that
   * is wrong in a way worth recording: picking a catalog product rewrites the line's unit from
   * OUTSIDE this cell, and an initialised-once state would keep showing the previous unit for ever.
   * Deriving from the props instead means the picker, an undo, or any other outside write simply
   * appears.
   *
   * The exception is «Other» with nothing typed yet. That resolves to `unitLabel: null`, which the
   * parent does not persist — so the props would snap back to the stored unit while the operator is
   * still deciding. `pending` holds exactly that transient and nothing else, and the first real
   * character clears it.
   */
  const [pending, setPending] = useState<{ readonly base: string; readonly custom: string } | null>(null);
  const derived = unitSelection(unitLabel, canonicalUnit, unit);
  const { base, custom } = pending ?? derived;

  const emit = (nextBase: string, nextCustom: string) => {
    const choice = unitChoiceFor(nextBase, nextCustom, unit);
    setPending(choice.incomplete ? { base: nextBase, custom: nextCustom } : null);
    onChange(choice);
  };

  const missing = base === OTHER_UNIT && custom.trim() === "";

  return (
    <>
      <select
        value={base}
        disabled={disabled}
        onChange={(e) => emit(e.target.value, custom)}
        data-testid={`unit-select-${idSuffix}`}
        aria-label={t("inv.sheet.colUnit")}
      >
        {BASE_UNITS.map((u) => (
          <option key={u} value={u}>
            {unit(u)}
          </option>
        ))}
      </select>
      {base === OTHER_UNIT && (
        <>
          <input
            value={custom}
            disabled={disabled}
            placeholder={t("inv.sheet.unitCustom")}
            onChange={(e) => emit(OTHER_UNIT, e.target.value)}
            data-testid={`unit-custom-${idSuffix}`}
            aria-label={t("inv.sheet.unitCustom")}
          />
          {missing && !disabled && (
            <span className="error small" data-testid={`unit-missing-${idSuffix}`}>
              {t("inv.sheet.missing.unit")}
            </span>
          )}
        </>
      )}
    </>
  );
}
