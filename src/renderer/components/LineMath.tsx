/**
 * The arithmetic of one sale line: `2.5 kg × 4.00 USD`.
 *
 * 🔴 Why this is a component and not an inline fragment. The terminal's default language is Arabic,
 * so this run sits inside an RTL document, and it mixes a number, a unit word that may be Arabic
 * ("كيلو"), a multiplication sign and a currency code. Left to the surrounding direction, the
 * bidirectional algorithm reorders the segments: the installed app printed
 *
 *     2.5 USD 4.00 × kg          instead of          2.5 kg × 4.00 USD
 *
 * The amounts were exact — this was only ever a display defect — but a receipt line a shopkeeper
 * cannot read is still a defect. Found on Windows, run 37616948728.
 *
 * The fix is bidi ISOLATION at BOTH levels — the whole run, and the unit word within it: `<bdi>` isolates the
 * run from its surroundings (`unicode-bidi: isolate`), and `dir="ltr"` fixes the base direction of
 * the arithmetic itself. An Arabic unit label still renders right-to-left WITHIN its own word, which
 * is correct — only the order of the five parts is pinned. So this stays right when units are
 * localized.
 *
 * The DOM order is the logical one, deliberately: quantity → unit → × → price → currency.
 */
import type { Money } from "../../domain/money";
import { formatQuantity } from "../../domain/quantity";
import { formatDecimal } from "../../domain/money";

export interface LineMathProps {
  readonly quantityMilli: number;
  /** null on a sale line written before migration 4: the unit is unknown and is never guessed. */
  readonly saleUnit: string | null;
  readonly unitPrice: Money;
  /** How the unit is spelled for the reader. Defaults to the stored code. */
  readonly unitLabel?: (saleUnit: string) => string;
}

export function LineMath({ quantityMilli, saleUnit, unitPrice, unitLabel }: LineMathProps) {
  const label = saleUnit === null ? null : (unitLabel?.(saleUnit) ?? saleUnit);
  return (
    <bdi className="line-math" dir="ltr" data-testid="line-math">
      <span className="line-math-qty">{formatQuantity(quantityMilli)}</span>
      {label !== null && (
        <>
          {" "}
          {/* 🔴 THE UNIT IS ISOLATED TOO, and this is not belt-and-braces. Once the label is
              localized it is an RTL run inside this LTR one, and an un-isolated RTL span absorbs
              the neutral characters that follow it: the installed app printed
                  1 2.50 × USD حبة        instead of        1 حبة × 2.50 USD
              The outer bdi pins this run against the PAGE; it cannot stop a child run from
              reordering its own siblings. Only a screenshot shows this — innerText returns DOM
              order, so an assertion on the text passes while the operator reads it backwards. */}
          <bdi className="line-math-unit">{label}</bdi>
        </>
      )}{" "}
      ×{" "}
      <span className="line-math-price">{formatDecimal(unitPrice)}</span>{" "}
      <span className="line-math-currency">{unitPrice.currency}</span>
    </bdi>
  );
}
