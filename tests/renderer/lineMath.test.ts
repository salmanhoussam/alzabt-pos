/**
 * The sale line's arithmetic must read `quantity → unit → × → price → currency`, in that order,
 * inside an Arabic RTL document.
 *
 * 🔴 The defect this guards: with no bidi isolation, the installed app printed
 *
 *     2.5 USD 4.00 × kg          instead of          2.5 kg × 4.00 USD
 *
 * on an RTL terminal. The amounts were exact — it was a display defect only — and it was caught by
 * a screenshot from Windows CI run 37616948728, which is far too late and too expensive a place to
 * catch it. So the order is asserted here, from the real rendered markup.
 *
 * Rendered with react-dom/server, which needs no DOM, so this stays inside the node test project.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { money } from "../../src/domain/money";
import { LineMath } from "../../src/renderer/components/LineMath";

const render = (props: Parameters<typeof LineMath>[0]) => renderToStaticMarkup(createElement(LineMath, props));

/** The order the five parts appear in the markup, by their own class names. */
function partOrder(html: string): string[] {
  return [...html.matchAll(/class="line-math-(qty|unit|price|currency)"/g)].map((m) => m[1]!);
}

/** Where the multiplication sign sits relative to those parts. */
function indexOfTimes(html: string): number {
  return html.indexOf("×");
}

describe("the sale line's arithmetic, on an RTL terminal", () => {
  const props = { quantityMilli: 2500, saleUnit: "kg", unitPrice: money(400n, "USD") };

  it("renders 2.5 kg × 4.00 USD in that logical order", () => {
    const html = render(props);
    expect(partOrder(html)).toEqual(["qty", "unit", "price", "currency"]);
    const plain = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    expect(plain).toBe("2.5 kg × 4.00 USD");
  });

  it("the × sits between the unit and the price, not after the currency", () => {
    const html = render(props);
    const times = indexOfTimes(html);
    expect(times).toBeGreaterThan(html.indexOf('class="line-math-unit"'));
    expect(times).toBeLessThan(html.indexOf('class="line-math-price"'));
  });

  it("🔴 isolates the run from the surrounding direction, which is the whole fix", () => {
    const html = render(props);
    // <bdi> carries unicode-bidi: isolate by default; dir="ltr" pins the base direction of the
    // arithmetic. Lose either and the segments are free to be reordered by the RTL paragraph.
    expect(html).toMatch(/^<bdi\b/);
    expect(html).toContain('dir="ltr"');
  });

  it("stays correct when the unit label is LOCALIZED — no English unit is hard-coded", () => {
    // كيلو is an RTL word; it must appear in the unit's position, and the five parts must keep
    // their order. This is why the fix is isolation rather than an English string.
    const html = render({ ...props, unitLabel: () => "كيلو" });
    expect(partOrder(html)).toEqual(["qty", "unit", "price", "currency"]);
    const plain = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    expect(plain).toBe("2.5 كيلو × 4.00 USD");
    expect(html).toContain('dir="ltr"');
  });

  it("works for meter, and for a whole quantity", () => {
    expect(
      render({ quantityMilli: 3125, saleUnit: "meter", unitPrice: money(320n, "USD") })
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("3.125 meter × 3.20 USD");
    expect(
      render({ quantityMilli: 12000, saleUnit: "piece", unitPrice: money(75n, "USD") })
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("12 piece × 0.75 USD");
  });

  it("a legacy line shows its quantity with NO unit, never a guessed one", () => {
    const html = render({ quantityMilli: 2000, saleUnit: null, unitPrice: money(300n, "USD") });
    expect(partOrder(html)).toEqual(["qty", "price", "currency"]);
    expect(html).not.toContain("line-math-unit");
    const plain = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    expect(plain).toBe("2 × 3.00 USD");
  });
});
