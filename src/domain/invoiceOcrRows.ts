/**
 * PHOTO-INVOICE-TO-ITEMS — from OCR TEXT LINES to candidate review rows (pure; no OCR engine here).
 *
 * Each line's numbers are explained by ONE named relation, or the line is reported UNEXPLAINED:
 *   R1  qty × price = total
 *   R2  qty × price × (1 − d/100) = total                      (a discount column)
 *   R3  boxes × boxPrice = total and (total) pieces × piecePrice = total   (box invoices)
 *   R4  qty × perPack × price = total                            (pack conversion)
 *
 * 🔴 PRECISION OVER RECALL (measured on the shop's real invoices, DEC-35t): money must be printed WITH
 *    decimals — a lost decimal point (2.35 read as 235) made "1 × 235 = 235" rows; a factor of 1 is
 *    accepted only between two decimal money values. Nothing is repaired, nothing is guessed: a line
 *    that no relation explains is returned as UNEXPLAINED for the operator, never as a row.
 * 🔴 A relation is an explanation, not a proof (discounts, taxes, units differ by supplier): every row
 *    starts PENDING in the review (photoInvoiceReview.ts) with its original text beside it.
 */
import type { ExtractedRow } from "./photoInvoiceReview";

export type Relation = "R1" | "R2" | "R3" | "R4";

export interface OcrRow extends ExtractedRow {
  readonly relation: Relation;
  readonly discountPercent: number | null;
}

export interface OcrRowsResult {
  readonly rows: readonly OcrRow[];
  /** Lines carrying two or more decimal amounts that no relation explained — shown for manual entry. */
  readonly unexplained: readonly string[];
}

const AR = "٠١٢٣٤٥٦٧٨٩";
const FA = "۰۱۲۳۴۵۶۷۸۹";
const DIR_MARKS = /[‎‏‪-‮]/g;
const normDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(AR.indexOf(d))).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/٫/g, ".");
const near = (a: number, b: number) => Math.abs(a - b) <= 0.011;

interface Num {
  readonly v: number;
  readonly s: string;
  readonly i: number;
  readonly dec: boolean;
}

function numbersOf(line: string): Num[] {
  const text = normDigits(line).replace(DIR_MARKS, "").replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  return [...text.matchAll(/\d+(?:[.,]\d{1,3})?/g)].map((m) => {
    const s = m[0].replace(",", ".");
    return { v: Number(s), s, i: m.index ?? 0, dec: s.includes(".") };
  });
}

interface Candidate {
  readonly rel: Relation;
  readonly qty: number;
  readonly price: number;
  readonly total: number;
  readonly disc: number | null;
  readonly used: readonly Num[];
  readonly score: number;
}

function explain(line: string): Candidate | null {
  const n = numbersOf(line);
  if (n.length < 3) return null;
  const c: Candidate[] = [];
  for (const t of n) {
    if (t.v <= 0 || !t.dec) continue;
    for (const q of n) for (const p of n) {
      if (q === t || p === t || q === p) continue;
      if (q.v <= 0 || q.v > 100000 || p.v <= 0 || !p.dec) continue;
      if (near(q.v * p.v, t.v)) c.push({ rel: "R1", qty: q.v, price: p.v, total: t.v, disc: null, used: [q, p, t], score: 5 });
      for (const d of n) {
        if (d === q || d === p || d === t || d.v <= 0 || d.v > 100) continue;
        if (near(q.v * p.v * (1 - d.v / 100), t.v)) c.push({ rel: "R2", qty: q.v, price: p.v, total: t.v, disc: d.v, used: [q, p, t, d], score: 3 });
        if (Number.isInteger(d.v) && d.v > 1 && near(q.v * d.v * p.v, t.v)) c.push({ rel: "R4", qty: q.v * d.v, price: p.v, total: t.v, disc: null, used: [q, p, t, d], score: 2 });
      }
      for (const pcs of n) for (const pp of n) {
        if ([q, p, t, pcs].includes(pp) || [q, p, t].includes(pcs)) continue;
        // As printed by the shop's box suppliers: boxes × boxPrice = total AND (total) pieces × piecePrice = total.
        if (near(q.v * p.v, t.v) && near(pcs.v * pp.v, t.v) && Number.isInteger(pcs.v) && pcs.v > q.v && p.v > pp.v && pp.dec)
          c.push({ rel: "R3", qty: pcs.v, price: pp.v, total: t.v, disc: null, used: [q, p, t, pcs, pp], score: 6 });
      }
    }
  }
  if (!c.length) return null;
  c.sort((a, b) => b.score - a.score || b.used.length - a.used.length || b.total - a.total);
  return c[0] ?? null;
}

function nameOf(line: string, used: readonly Num[]): string {
  let s = normDigits(line.replace(DIR_MARKS, ""));
  for (const u of [...used].sort((a, b) => b.i - a.i)) s = s.slice(0, u.i) + " " + s.slice(u.i + u.s.length);
  return s
    .replace(/[|[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(\d{1,2}\s+)+/, "")
    .replace(/(\s+\d{1,2}(\.\d+)?)+$/, "")
    .trim();
}

/** Minor units from a decimal number with up to 3 decimals; currencies with 2 decimals round half-up. */
function toMinor(v: number, exponent: number): bigint {
  return BigInt(Math.round(v * 10 ** exponent));
}

export function rowsFromLines(lines: readonly string[], exponent = 2): OcrRowsResult {
  const rows: OcrRow[] = [];
  const unexplained: string[] = [];
  // DEDUP (DEC-35u): the same printed line is read twice (text line + geometric line). Two DIFFERENT
  // items can share every number (1 × 12.50 = 12.50 on a paint invoice), so numbers alone are not an
  // identity: a candidate is a duplicate only when its numbers match AND its name is mostly the same words.
  const kept: Array<{ k: string; words: Set<string> }> = [];
  const wordsOf = (t: string) => new Set(t.toLowerCase().split(/s+/).filter((w) => w.length >= 2));
  const sameWords = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 || b.size === 0) return a.size === b.size;
    let n = 0;
    for (const w of a) if (b.has(w)) n += 1;
    return n / Math.min(a.size, b.size) >= 0.6;
  };
  for (const raw of lines) {
    const e = explain(raw);
    if (!e) {
      if (numbersOf(raw).filter((x) => x.dec).length >= 2) unexplained.push(raw.trim());
      continue;
    }
    const k = `${e.qty}|${e.price}|${e.total}`;
    const name = nameOf(raw, e.used);
    const words = wordsOf(name);
    if (kept.some((x) => x.k === k && sameWords(x.words, words))) continue;
    kept.push({ k, words });
    rows.push({
      id: `row-${rows.length + 1}`,
      rawText: raw.trim(),
      name,
      quantityMilli: Math.round(e.qty * 1000),
      supplierPriceMinor: toMinor(e.price, exponent),
      lineTotalMinor: toMinor(e.total, exponent),
      arithmeticOk: e.rel === "R1",
      relation: e.rel,
      discountPercent: e.disc,
    });
  }
  return { rows, unexplained: [...new Set(unexplained)] };
}
