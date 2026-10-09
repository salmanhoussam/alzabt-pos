/**
 * One date/time representation for the whole terminal.
 *
 * 🔴 NOT `toLocaleString()`. That is what produced `PM 6:25:23 ,10/9/2026` — an RTL-reordered
 * locale string that the operator had to decode, inside the VOID dialog of all places. A fixed
 * `YYYY-MM-DD HH:mm` is unambiguous in both languages, sorts the way it reads, and matches the
 * date already used in the drafts list. Rendered inside <bdi dir="ltr"> at every call site.
 */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Date only, same contract. */
export function stampDate(iso: string): string {
  return stamp(iso).slice(0, 10);
}
