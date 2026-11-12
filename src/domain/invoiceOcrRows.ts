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
import type { OcrSource, PositionedLine } from "./ocrLayout";

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
    // Leftover MONEY-format numbers of other columns (a 0.00 discount, a repeated net price) are not part
    // of a product name (seen on the installed build: «4.00 0.00 تنر غلون COBRA»). Integers — sizes such as
    // 500, 1007 — are kept.
    .replace(/(^|\s)\d+[.,]\d{2,3}(?=\s|$)/g, " ")
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DEC-35v — rows from POSITIONED readings (ocrLayout.ts). Identity = numbers AND place on the page.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type RowWarning =
  /** Another reading at the SAME place gives different numbers: both are shown, neither is trusted. */
  | "CONFLICT"
  /** Only one of several readings found this row. */
  | "SINGLE_READING"
  /** Explained by a discount / box / pack relation, not by plain qty × price. */
  | "NOT_PLAIN_ARITHMETIC";

export interface PlacedRow extends OcrRow {
  /** Vertical centre on the ORIGINAL photo, and the row height — for the crop shown in the review. */
  readonly y: number;
  readonly h: number;
  readonly readings: number;
  readonly sources: readonly OcrSource[];
  /** Other names read for the same row (distinct), for the operator to pick from. */
  readonly alternativeNames: readonly string[];
  readonly warnings: readonly RowWarning[];
}

export interface PlacedUnexplained {
  readonly text: string;
  readonly y: number;
  readonly h: number;
}

export interface PlacedRowsResult {
  readonly rows: readonly PlacedRow[];
  readonly unexplained: readonly PlacedUnexplained[];
}

const letters = (s: string) => (s.match(/[A-Za-z؀-ۿ]/g) ?? []).length;

export function rowsFromPositioned(lines: readonly PositionedLine[], exponent = 2): PlacedRowsResult {
  const sourcesPresent = new Set(lines.map((l) => l.source));
  // ONE tolerance for "same row": 60 % of the page's TYPICAL line height (median of the word-geometry lines),
  // never of one oversized engine box (which once merged two paints) nor of one thin box (which once kept the
  // same line twice after the straightened reading was mapped back).
  const hs = lines.filter((l) => l.kind === "geometry").map((l) => l.h).sort((a, b) => a - b);
  const typical = hs[Math.floor(hs.length / 2)] ?? 20;
  const tol = Math.max(6, typical * 0.6);
  interface Cand { k: string; e: Candidate; line: PositionedLine; name: string }
  const cands: Cand[] = [];
  const unexplainedRaw: PositionedLine[] = [];
  for (const line of lines) {
    const e = explain(line.text);
    if (!e) {
      // NO SILENT LOSS (DEC-35v, measured on the paint invoice: 12.50 read as «1250» on 6 lines): a ROW-LIKE
      // line — letters, two or more numbers, at least one printed with decimals — that no relation explains
      // is listed for manual entry with its strip of the photo. Its digits are never repaired or guessed.
      const nums = numbersOf(line.text);
      if (nums.length >= 2 && nums.some((x) => x.dec) && letters(line.text) >= 2) unexplainedRaw.push(line);
      continue;
    }
    cands.push({ k: `${e.qty}|${e.price}|${e.total}`, e, line, name: nameOf(line.text, e.used) });
  }
  // Group: SAME numbers AND same place (|Δy| within 60 % of the SHORTER line — an engine line box can span
  // two printed rows, and the taller height once merged two different paints). Different place = different row.
  interface Group { k: string; y: number; h: number; members: Cand[] }
  const groups: Group[] = [];
  for (const c of [...cands].sort((a, b) => a.line.y - b.line.y)) {
    const g = groups.find((x) => x.k === c.k && Math.abs(x.y - c.line.y) <= tol);
    if (g) {
      g.members.push(c);
      g.y = g.members.reduce((s, m) => s + m.line.y, 0) / g.members.length;
      g.h = Math.min(g.h, c.line.h);
    } else groups.push({ k: c.k, y: c.line.y, h: c.line.h, members: [c] });
  }
  const rows: PlacedRow[] = groups.map((g, i) => {
    // The name: the engine's own line of the ORIGINAL photo first, then the one with most letters.
    const ranked = [...g.members].sort(
      (a, b) =>
        Number(b.line.kind === "engine") - Number(a.line.kind === "engine") ||
        Number(b.line.source === "original") - Number(a.line.source === "original") ||
        letters(b.name) - letters(a.name),
    );
    const best = ranked[0]!;
    const names = [...new Set(g.members.map((m) => m.name.trim()).filter((n) => n && n !== best.name.trim()))];
    const sources = [...new Set(g.members.map((m) => m.line.source))];
    const warnings: RowWarning[] = [];
    // CONFLICT: another group at the same place with DIFFERENT numbers.
    if (groups.some((o) => o !== g && o.k !== g.k && Math.abs(o.y - g.y) <= tol)) warnings.push("CONFLICT");
    if (sourcesPresent.size > 1 && sources.length < sourcesPresent.size) warnings.push("SINGLE_READING");
    if (best.e.rel !== "R1") warnings.push("NOT_PLAIN_ARITHMETIC");
    return {
      id: `row-${i + 1}`,
      rawText: best.line.text.trim(),
      name: best.name,
      quantityMilli: Math.round(best.e.qty * 1000),
      supplierPriceMinor: toMinor(best.e.price, exponent),
      lineTotalMinor: toMinor(best.e.total, exponent),
      arithmeticOk: best.e.rel === "R1",
      relation: best.e.rel,
      discountPercent: best.e.disc,
      y: Math.round(g.y),
      h: Math.round(g.h),
      readings: g.members.length,
      sources,
      alternativeNames: names.slice(0, 3),
      warnings,
    };
  });
  // Unexplained lines: one per place, and none where a row was already found (the same line read badly).
  const unexplained: PlacedUnexplained[] = [];
  for (const l of [...unexplainedRaw].sort((a, b) => a.y - b.y)) {
    if (rows.some((r) => Math.abs(r.y - l.y) <= tol)) continue;
    if (unexplained.some((u) => Math.abs(u.y - l.y) <= tol)) continue;
    unexplained.push({ text: l.text.trim(), y: Math.round(l.y), h: Math.round(l.h) });
  }
  return { rows, unexplained };
}
