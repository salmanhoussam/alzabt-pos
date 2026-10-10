/**
 * The invoice line's unit control, and the two derivations it is built on.
 *
 * 🔴 WHAT THESE PROTECT. `unit_label` is what the paper invoice prints and is historical truth;
 * `canonical_unit` is what the catalog can act on. A control that offers a dropdown has to decide,
 * for a line it did not create, WHICH entry to show — and the one unacceptable answer is "show a
 * unit, then quietly write it back", because that rewrites a label a real invoice printed.
 *
 * So the rule under test is: the selector may only show a base unit when the stored label LITERALLY
 * is that unit, either as this build's localised label or as the bare key. Everything else is Other
 * with the label prefilled, byte for byte.
 *
 * Synthetic throughout. «كيس (50PCS)» is the real SHAPE of a merchant unit — a bag of fifty — and
 * carries no merchant's data.
 */
import { describe, expect, it } from "vitest";
import { BASE_UNITS } from "../../src/domain/catalog";
import { DEFAULT_UNIT, OTHER_UNIT, unitChoiceFor, unitSelection } from "../../src/renderer/components/UnitCell";
import { unitLabel } from "../../src/shared/i18n";

const ar = (u: string) => unitLabel("ar", u);
const en = (u: string) => unitLabel("en", u);

describe("the unit list itself", () => {
  it("🔴 'other' is ALREADY a BASE_UNITS member — the escape hatch is not a seventh option", () => {
    // If this ever stops being true, the control would need its own extra entry, and an operator
    // would see two things both called "other".
    expect(BASE_UNITS).toContain(OTHER_UNIT);
  });

  it("the default a new line opens on is a real unit, and is not the escape hatch", () => {
    expect(BASE_UNITS).toContain(DEFAULT_UNIT);
    expect(DEFAULT_UNIT).not.toBe(OTHER_UNIT);
  });
});

describe("which entry a stored line shows", () => {
  it("recognises this build's own localised label", () => {
    expect(unitSelection(ar("piece"), "piece", ar)).toEqual({ base: "piece", custom: "" });
    expect(unitSelection(ar("kg"), null, ar)).toEqual({ base: "kg", custom: "" });
  });

  it("recognises a bare base-unit key — what the catalog prefill and older drafts store", () => {
    // `prefill()` writes the product's base unit straight into unitLabel, so real rows carry this.
    expect(unitSelection("piece", "piece", ar)).toEqual({ base: "piece", custom: "" });
    expect(unitSelection("meter", null, en)).toEqual({ base: "meter", custom: "" });
  });

  it("🔴 a unit this build cannot match becomes Other, PREFILLED, byte for byte", () => {
    expect(unitSelection("كيس (50PCS)", null, ar)).toEqual({ base: OTHER_UNIT, custom: "كيس (50PCS)" });
    expect(unitSelection("drum", null, en)).toEqual({ base: OTHER_UNIT, custom: "drum" });
  });

  it("🔴 does NOT match through the known-label map, however well it would work", () => {
    // canonicalUnitFor("حبه") maps to piece, and showing "piece" for a line that says «حبه» would
    // mean the selector disagrees with the stored text — and one careless save would rewrite it.
    // Under an ENGLISH UI «حبة» is not a label this build spells, so it stays Other, untouched.
    expect(unitSelection("حبة", null, en)).toEqual({ base: OTHER_UNIT, custom: "حبة" });
    expect(unitSelection("حبه", null, ar)).toEqual({ base: OTHER_UNIT, custom: "حبه" });
  });

  it("an empty label falls back to the canonical unit when there is one", () => {
    expect(unitSelection(null, "box", ar)).toEqual({ base: "box", custom: "" });
    expect(unitSelection("   ", "kg", ar)).toEqual({ base: "kg", custom: "" });
  });

  it("an empty label with no canonical unit is Other, waiting — not a silent 'piece'", () => {
    expect(unitSelection(null, null, ar)).toEqual({ base: OTHER_UNIT, custom: "" });
  });

  it("a canonical unit that is not a real base unit is not trusted", () => {
    expect(unitSelection(null, "furlong", ar)).toEqual({ base: OTHER_UNIT, custom: "" });
  });
});

describe("what a selection resolves to", () => {
  it("🔴 a known unit prints the LOCALISED label and records the key", () => {
    // Writing the key into both would print "piece" on an Arabic invoice.
    expect(unitChoiceFor("piece", "", ar)).toEqual({ unitLabel: "حبة", canonicalUnit: "piece", incomplete: false });
    expect(unitChoiceFor("piece", "", en)).toEqual({ unitLabel: "piece", canonicalUnit: "piece", incomplete: false });
  });

  it("ignores leftover custom text once a real unit is chosen", () => {
    expect(unitChoiceFor("kg", "كيس (50PCS)", ar)).toEqual({
      unitLabel: "كيلو",
      canonicalUnit: "kg",
      incomplete: false,
    });
  });

  it("Other with text keeps the text verbatim and claims NO canonical unit", () => {
    // Null, not a guess: the service's own label map gets its turn, and it honestly refuses this.
    expect(unitChoiceFor(OTHER_UNIT, "كيس (50PCS)", ar)).toEqual({
      unitLabel: "كيس (50PCS)",
      canonicalUnit: null,
      incomplete: false,
    });
  });

  it("trims the typed unit", () => {
    expect(unitChoiceFor(OTHER_UNIT, "  صفيحة  ", ar)).toEqual({
      unitLabel: "صفيحة",
      canonicalUnit: null,
      incomplete: false,
    });
  });

  it("🔴 Other with nothing typed is INCOMPLETE and writes no label", () => {
    expect(unitChoiceFor(OTHER_UNIT, "", ar)).toEqual({ unitLabel: null, canonicalUnit: null, incomplete: true });
    expect(unitChoiceFor(OTHER_UNIT, "   ", ar)).toEqual({ unitLabel: null, canonicalUnit: null, incomplete: true });
  });
});

describe("a line survives a round trip through the control", () => {
  it("every base unit shows itself again, in both languages", () => {
    for (const localise of [ar, en]) {
      for (const u of BASE_UNITS.filter((x) => x !== OTHER_UNIT)) {
        const choice = unitChoiceFor(u, "", localise);
        expect(unitSelection(choice.unitLabel, choice.canonicalUnit, localise)).toEqual({ base: u, custom: "" });
      }
    }
  });

  it("🔴 a custom unit comes back out unchanged, not normalised into something near it", () => {
    for (const custom of ["كيس (50PCS)", "drum", "صفيحة 20 لتر", "box of 12"]) {
      const choice = unitChoiceFor(OTHER_UNIT, custom, ar);
      expect(choice.unitLabel).toBe(custom);
      expect(unitSelection(choice.unitLabel, choice.canonicalUnit, ar)).toEqual({
        base: OTHER_UNIT,
        custom,
      });
    }
  });
});
