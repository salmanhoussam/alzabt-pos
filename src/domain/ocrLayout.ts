/**
 * PHOTO-INVOICE-TO-ITEMS — WHERE each reading sits on the page (pure; no engine, no Electron).
 *
 * One invoice is read more than once (the photo as taken, a straightened copy) and each reading yields
 * its lines twice (the engine's own line, and a line rebuilt from word positions). Before DEC-35v these
 * copies were told apart by their words only, and a name read slightly differently survived as a second
 * row: 35 duplicate rows on the shop's 19 invoices. Numbers alone are no identity either — a paint
 * invoice has 11 different colours at 1 × 12.50.
 *
 * So every line now carries its POSITION in the ORIGINAL photo (a straightened reading is mapped back
 * through the same rotation) and its SOURCE. Grouping happens in invoiceOcrRows.ts:
 *   same numbers + same place on the page → one row (alternative readings kept);
 *   same numbers + different place          → different rows (the 11 paints stay 11);
 *   different numbers + same place          → kept apart, both flagged CONFLICT — never merged.
 */

export type OcrSource = "original" | "deskewed";

export interface PositionedLine {
  readonly text: string;
  /** Vertical centre in ORIGINAL-photo pixels. */
  readonly y: number;
  /** Line height in pixels (for the "same row" tolerance). */
  readonly h: number;
  readonly x0: number;
  readonly x1: number;
  readonly source: OcrSource;
  readonly kind: "engine" | "geometry";
}

interface BBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}
interface TWord {
  readonly text: string;
  readonly bbox: BBox;
}
interface TLine {
  readonly text: string;
  readonly bbox: BBox;
  readonly words?: readonly TWord[];
}
export interface TesseractLikeData {
  readonly blocks?: ReadonlyArray<{ readonly paragraphs?: ReadonlyArray<{ readonly lines?: readonly TLine[] }> }> | null;
}

/**
 * Maps a point of the straightened copy back to the original photo. The copy was produced by sampling
 * the original at  xs = cx + (x−cx)·cos − (y−cy)·sin,  ys = cy + (x−cx)·sin + (y−cy)·cos  (rotation by
 * the measured skew), so this is exactly that sampling formula.
 */
export function toOriginal(x: number, y: number, skewDegrees: number, w: number, h: number): { x: number; y: number } {
  if (skewDegrees === 0) return { x, y };
  const a = (skewDegrees * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a), cx = (w - 1) / 2, cy = (h - 1) / 2;
  return { x: cx + (x - cx) * c - (y - cy) * s, y: cy + (x - cx) * s + (y - cy) * c };
}

/** The engine's lines AND word-geometry lines of one reading, each placed on the ORIGINAL photo. */
export function positionedLines(
  data: TesseractLikeData,
  source: OcrSource,
  map: { readonly skewDegrees: number; readonly width: number; readonly height: number } = { skewDegrees: 0, width: 0, height: 0 },
): PositionedLine[] {
  const out: PositionedLine[] = [];
  const words: Array<{ text: string; x: number; y: number; h: number; x0: number; x1: number }> = [];
  const place = (b: BBox) => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return source === "deskewed" ? toOriginal(cx, cy, map.skewDegrees, map.width, map.height) : { x: cx, y: cy };
  };
  for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) {
    if (l.text.trim()) {
      const c = place(l.bbox);
      out.push({ text: l.text.replace(/\n$/, ""), y: c.y, h: l.bbox.y1 - l.bbox.y0, x0: l.bbox.x0, x1: l.bbox.x1, source, kind: "engine" });
    }
    for (const w of l.words ?? []) {
      if (!w.text.trim()) continue;
      const c = place(w.bbox);
      words.push({ text: w.text, x: c.x, y: c.y, h: w.bbox.y1 - w.bbox.y0, x0: w.bbox.x0, x1: w.bbox.x1 });
    }
  }
  const hs = words.map((w) => w.h).sort((a, b) => a - b);
  const tol = (hs[Math.floor(hs.length / 2)] ?? 20) * 0.6;
  const groups: Array<{ y: number; w: typeof words }> = [];
  for (const w of [...words].sort((a, b) => a.y - b.y)) {
    const g = groups.find((x) => Math.abs(x.y - w.y) <= tol);
    if (g) {
      g.w.push(w);
      g.y = g.w.reduce((s, q) => s + q.y, 0) / g.w.length;
    } else groups.push({ y: w.y, w: [w] });
  }
  for (const g of groups) {
    const ws = g.w.sort((a, b) => b.x - a.x);
    const hh = ws.map((w) => w.h).sort((a, b) => a - b);
    out.push({
      text: ws.map((w) => w.text).join(" "),
      y: g.y,
      h: hh[Math.floor(hh.length / 2)] ?? 20,
      x0: Math.min(...ws.map((w) => w.x0)),
      x1: Math.max(...ws.map((w) => w.x1)),
      source,
      kind: "geometry",
    });
  }
  return out;
}
