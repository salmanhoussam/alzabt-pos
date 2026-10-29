/**
 * Dirty detection for an unblurred invoice tax-rate field.
 *
 * Mirror InvoiceService.parseTaxPercent's accepted decimal grammar and basis-point precision.
 * Number() alone is unsafe: "11.000" and "11e0" are numerically 11, but the service refuses both.
 * This function does not authorize a write; the service remains the sole source of validation.
 */
export function isTypedTaxRateUnsaved(typed: string, storedBasisPoints: number): boolean {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(typed.trim());
  if (!match) return true;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return basisPoints > 10_000 || basisPoints !== storedBasisPoints;
}
