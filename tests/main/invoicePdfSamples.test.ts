import { describe, expect, it } from "vitest";
import { amountInWordsAr } from "../../src/domain/amountInWords";
import { renderInvoiceDocument } from "../../src/main/invoiceDocument";
import { CURRENCY, SAMPLES } from "../../scripts/invoiceSampleFixtures";

/**
 * 🔴 THE POSITIVE CONTROL FOR THE PDF REVIEW MATERIAL.
 *
 * The samples existed so a human could LOOK at the invoice before it shipped. For one release they
 * showed an amount-in-words the shop will never see: the fixture carried the constant
 * "فقط المبلغ المذكور أعلاه لا غير" while production calls amountInWordsAr(). The field whose
 * LENGTH varies with the total was the one field frozen to a short constant — so the review was
 * blind to exactly the property that box can fail on.
 *
 * These tests exist so that cannot silently happen again. Every one of them FAILS if the fixture
 * goes back to a constant, which is what makes them a control rather than a restatement.
 */
describe("the PDF samples carry production amount-in-words", () => {
  it("each sample's words are exactly what production would print for its own total", () => {
    for (const { name, v } of SAMPLES) {
      const expected = amountInWordsAr({ minor: BigInt(v.invoice.total.minor), currency: CURRENCY });
      expect(v.invoice.amountInWords, `${name} must spell its OWN total, not a stand-in`).toBe(expected);
    }
  });

  it("the four samples spell four DIFFERENT amounts", () => {
    // A constant placeholder collapses these to one value. Distinctness is the cheapest proof that
    // the string is computed from the total rather than typed into the fixture.
    const spelled = SAMPLES.map((s) => s.v.invoice.amountInWords);
    expect(new Set(spelled).size).toBe(SAMPLES.length);
  });

  it("the words actually name the number — they are not a phrase that points elsewhere", () => {
    // The placeholder's failure mode was semantic, not structural: it was well-formed Arabic that
    // referred to the amount instead of stating it. A sample whose words never change with the
    // total would pass any check that only looks at the shape of the string.
    const a = SAMPLES.find((s) => s.name.startsWith("A-"))!;
    const d = SAMPLES.find((s) => s.name.startsWith("D-"))!;
    expect(a.v.invoice.amountInWords).toContain("ثمانية عشر"); // 18.00
    expect(d.v.invoice.amountInWords).toContain("ألف"); // 1,273.50
    expect(d.v.invoice.amountInWords).not.toBe(a.v.invoice.amountInWords);
  });

  it("the longest words reach the rendered document in full, uncut", () => {
    // Clipping is visual and belongs to the artifact, but TRUNCATION would happen here, in the
    // document, and is checkable: the whole string must survive into the HTML the printer sees.
    const longest = SAMPLES.reduce((a, b) =>
      b.v.invoice.amountInWords!.length > a.v.invoice.amountInWords!.length ? b : a,
    );
    const words = longest.v.invoice.amountInWords!;
    expect(words.length).toBeGreaterThan(40); // a real spelled amount, not a short constant
    const html = renderInvoiceDocument(longest.v, { logoUrl: null });
    expect(html).toContain(words);
  });

  it("no sample carries the retired placeholder", () => {
    for (const { name, v } of SAMPLES) {
      expect(v.invoice.amountInWords, `${name}`).not.toContain("المبلغ المذكور أعلاه");
    }
  });
});
