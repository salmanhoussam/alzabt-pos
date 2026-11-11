/**
 * PHOTO-INVOICE-TO-ITEMS — the OCR engine adapter (main process). OFFLINE: Tesseract (WASM) with the
 * LOCAL ara + eng `4.0.0_best_int` data shipped in node_modules (@tesseract.js-data, MIT packaging of
 * Apache-2.0 models). No network, no cloud, no subscription. Nothing is written anywhere.
 *
 * Measured on the shop's 19 real invoices (DEC-35t, local corpus outside the repository): two readings —
 * the photo as taken and a STRAIGHTENED copy (skew from the page's own lines) — gave 30/62 printed lines
 * with every number right, 3 false rows, 3–10 s and ≤ 190 MB per page. Handwriting is NOT read: those
 * invoices go to manual entry beside the photo. Every row this returns starts PENDING in the review.
 *
 * 🔴 RELEASE GATE (not yet verified): inside the packaged app the WASM core and the language files must
 * be reachable outside the asar (asarUnpack / extraResources). Verified here in the dev build only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { nativeImage } from "electron";
import { DomainError } from "../domain/errors";

export interface OcrReading {
  readonly lines: readonly string[];
  readonly ms: number;
  readonly skewDegrees: number;
}

const req = createRequire(__filename);
const LANGS = ["ara", "eng"] as const;
const OCR_TIMEOUT_MS = 120_000;

/**
 * 🔴 ROOT CAUSE OF "Only absolute URLs are supported" (DEC-35u, proven by a focused Electron-main test):
 * tesseract.js 5.1.1 classifies its environment with `is-electron`. Inside Electron the type is
 * 'electron', not 'node', and its language loader then treats ANY `langPath` — even a local folder — as
 * a URL and calls node-fetch, which refuses a Windows path. In plain Node the same call reads the file.
 * The loader ALWAYS reads its CACHE (`cachePath`) from disk first, in every environment. So the
 * language files are placed, uncompressed, in a private cache folder and the worker runs with
 * cacheMethod 'readOnly': no fetch, no network, no Electron or Node security setting touched.
 * If a file is missing the call is refused HERE — the library would otherwise fall back to a CDN URL.
 */
function languageCache(userData: string): string {
  const dir = join(userData, "ocr-lang-cache");
  mkdirSync(dir, { recursive: true });
  for (const l of LANGS) {
    const dst = join(dir, `${l}.traineddata`);
    if (existsSync(dst) && statSync(dst).size > 100_000) continue;
    const pkg = dirname(req.resolve(`@tesseract.js-data/${l}/package.json`));
    const src = join(pkg, "4.0.0_best_int", `${l}.traineddata.gz`);
    if (!existsSync(src)) throw new DomainError("NOT_AVAILABLE", "The offline reading data is missing from this installation");
    writeFileSync(`${dst}.partial`, gunzipSync(readFileSync(src)));
    renameSync(`${dst}.partial`, dst);
  }
  for (const l of LANGS) {
    if (!existsSync(join(dir, `${l}.traineddata`))) throw new DomainError("NOT_AVAILABLE", "The offline reading data is missing from this installation");
  }
  return dir;
}

/** Skew (degrees) from dark points on a ~1000 px copy, by projection profile — no binarised output. */
export function estimateSkew(gray: Float32Array, w: number, h: number): number {
  const s = Math.max(1, Math.round(w / 1000));
  const sw = Math.floor(w / s), sh = Math.floor(h / s);
  let sum = 0;
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const v = gray[(y * s) * w + x * s] ?? 255; small[y * sw + x] = v; sum += v; }
  const thr = (sum / small.length) * 0.6;
  const xs: number[] = [], ys: number[] = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if ((small[y * sw + x] ?? 255) < thr) { xs.push(x); ys.push(y); }
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const bins = new Float64Array(sh + 2 * sw);
    for (let i = 0; i < xs.length; i++) bins[Math.round((ys[i] ?? 0) * c - (xs[i] ?? 0) * sn) + sw]! += 1;
    let e = 0;
    for (const b of bins) e += b * b;
    return e;
  };
  let best = 0, bestE = -1;
  for (let d = -8; d <= 8.0001; d += 0.2) { const e = score(d); if (e > bestE) { bestE = e; best = d; } }
  const coarse = best;
  for (let d = coarse - 0.2; d <= coarse + 0.2001; d += 0.02) { const e = score(d); if (e > bestE) { bestE = e; best = d; } }
  return Math.round(best * 100) / 100;
}

function straightened(path: string): { png: Buffer; skew: number } | null {
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return null;
  const { width: w, height: h } = img.getSize();
  const bgra = img.toBitmap();
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.114 * (bgra[i * 4] ?? 0) + 0.587 * (bgra[i * 4 + 1] ?? 0) + 0.299 * (bgra[i * 4 + 2] ?? 0);
  const skew = estimateSkew(g, w, h);
  if (Math.abs(skew) < 0.1) return { png: img.toPNG(), skew };
  const a = (skew * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), cx = (w - 1) / 2, cy = (h - 1) / 2;
  const out = Buffer.alloc(w * h * 4, 255);
  for (let yo = 0; yo < h; yo++) for (let xo = 0; xo < w; xo++) {
    const xs = cx + (xo - cx) * c - (yo - cy) * s, ys = cy + (xo - cx) * s + (yo - cy) * c;
    const x0 = Math.floor(xs), y0 = Math.floor(ys);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
    const fx = xs - x0, fy = ys - y0, i = y0 * w + x0;
    const v = ((g[i] ?? 255) * (1 - fx) + (g[i + 1] ?? 255) * fx) * (1 - fy) + ((g[i + w] ?? 255) * (1 - fx) + (g[i + w + 1] ?? 255) * fx) * fy;
    const o = (yo * w + xo) * 4;
    out[o] = out[o + 1] = out[o + 2] = v | 0;
  }
  return { png: nativeImage.createFromBitmap(out, { width: w, height: h }).toPNG(), skew };
}

interface TWord { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface TData { text: string; blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ words?: TWord[] }> }> }> | null }

/** The engine's own lines, plus lines rebuilt from word geometry (a table row is one height). */
function linesOf(data: TData): string[] {
  const words: Array<{ text: string; x: number; y: number; h: number }> = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? [])
    if (w.text.trim()) words.push({ text: w.text, x: (w.bbox.x0 + w.bbox.x1) / 2, y: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 });
  const hs = words.map((w) => w.h).sort((a, b) => a - b);
  const tol = (hs[Math.floor(hs.length / 2)] ?? 20) * 0.6;
  const groups: Array<{ y: number; w: typeof words }> = [];
  for (const w of [...words].sort((a, b) => a.y - b.y)) {
    const g = groups.find((x) => Math.abs(x.y - w.y) <= tol);
    if (g) { g.w.push(w); g.y = g.w.reduce((s, q) => s + q.y, 0) / g.w.length; } else groups.push({ y: w.y, w: [w] });
  }
  return [...data.text.split(/\r?\n/).filter((l) => l.trim()), ...groups.map((g) => g.w.sort((a, b) => b.x - a.x).map((w) => w.text).join(" "))];
}

/** Reads one invoice photo: the photo as taken, then a straightened copy. */
export async function readInvoiceImage(path: string, userData: string): Promise<OcrReading> {
  const t0 = performance.now();
  // 🔴 THE PHOTO IS CHECKED FIRST: a file that is not an image never reaches the worker.
  if (nativeImage.createFromPath(path).isEmpty()) throw new DomainError("INVALID_INPUT", "That file is not a readable image");
  const cachePath = languageCache(userData);
  const { createWorker } = req("tesseract.js") as typeof import("tesseract.js");
  // 🔴 NO UNCAUGHT EXCEPTION: tesseract.js's default worker error handler THROWS inside its message
  // callback — outside any await — which Electron reports as "A JavaScript error occurred in the main
  // process". This handler captures it, and the race below turns it into a normal refusal.
  let workerError: unknown = null;
  let failNow: ((e: unknown) => void) | null = null;
  const failed = new Promise<never>((_, reject) => {
    failNow = reject;
  });
  failed.catch(() => undefined);
  const fail = (e: unknown) => {
    workerError = workerError ?? e;
    failNow?.(e);
  };
  const timer = setTimeout(() => fail(new Error("OCR timed out")), OCR_TIMEOUT_MS);
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  const guarded = <T>(p: Promise<T>) => Promise.race([p, failed]);
  try {
    worker = await guarded(createWorker(["ara", "eng"], 1, { cachePath, cacheMethod: "readOnly", logger: () => undefined, errorHandler: fail }));
    await guarded(worker.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: "4" as never }));
    const a = await guarded(worker.recognize(path, { rotateAuto: true }, { text: true, blocks: true }));
    const st = straightened(path);
    const lines = linesOf(a.data as unknown as TData);
    if (st && Math.abs(st.skew) >= 0.1) {
      const b = await guarded(worker.recognize(st.png, { rotateAuto: true }, { text: true, blocks: true }));
      lines.push(...linesOf(b.data as unknown as TData));
    }
    return { lines, ms: Math.round(performance.now() - t0), skewDegrees: st?.skew ?? 0 };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    // The technical cause is for the log (no supplier data in it: never the text read); the operator
    // gets one stable code with a retry / manual-entry path.
    throw new DomainError("OCR_FAILED", `Invoice reading failed: ${String((workerError ?? e) instanceof Error ? ((workerError ?? e) as Error).message : workerError ?? e).slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}
