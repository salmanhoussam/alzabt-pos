/**
 * THE business-day rule — the only place it is defined. The report, the void rule and the UI all
 * call this function; none of them may compute "today" on their own.
 *
 * Rule (Gate 1): the business day is the calendar date of the instant in the terminal's
 * configured IANA time zone, from 00:00 inclusive to the next 00:00 exclusive. A sale and a void
 * each store the business date computed here AT WRITE TIME, so a later change of rule or zone can
 * never move an already-recorded sale to a different day.
 *
 * A business day that ends after midnight (bars, late restaurants) is a later product decision;
 * it would change only this function.
 */
export function businessDateOf(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid instant");
  // en-CA formats as YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`Could not derive a business date: ${date}`);
  return date;
}

/** Throws early if the configured zone is not a real IANA zone. */
export function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat("en-CA", { timeZone }); // RangeError on an invalid zone
}
