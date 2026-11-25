/**
 * TRY DEMO — the PREVIEW-ONLY document mark (joint C2; O-5 "preview only, no printer, no PDF save").
 *
 * 🔴 PURE FUNCTIONS, NO AUTHORITY. This module imports nothing, opens no window, prints nothing and
 * writes no file. Main (Codex, X2) decides when a document is staged for the demo's on-screen preview
 * and calls `withDemoWatermark` on it there; the real process never calls anything in this file.
 *
 * The preview shows the exact document the real till would produce — the same renderer and layout
 * (80 mm roll, A5 receipt, A4 invoice) and the same logo — with a «نسخة تجريبية — DEMO» bar at the
 * top and a fixed diagonal mark. `position: fixed` keeps the mark in view at every scroll position of
 * the on-screen preview (and Chromium repeats a fixed element on every printed page, should a later,
 * separately approved decision ever allow output). Inline styles only: every document's own CSP allows
 * `style-src 'unsafe-inline'` and nothing else, so the mark needs no script and no external resource.
 */

const MARK_STYLE =
  "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2147483647;" +
  "font:700 42px/1.2 Tahoma,Arial,sans-serif;color:rgba(200,30,30,.18);transform:rotate(-28deg);text-align:center;white-space:pre";
const BAR_STYLE =
  "display:block;margin:0 0 8px;padding:6px 8px;border:2px dashed #c81e1e;color:#c81e1e;background:#fff;" +
  "font:700 12px/1.4 Tahoma,Arial,sans-serif;text-align:center";

export const DEMO_MARK_TEXT = "نسخة تجريبية\nDEMO";
export const DEMO_BAR_TEXT = "نسخة تجريبية — ليست مستنداً حقيقياً · DEMO — not a real document";
/** The attribute a test (and a support check) looks for to prove a document carries the mark. */
export const DEMO_MARK_ATTR = "data-alzabt-demo-mark";

/**
 * Adds the demo bar at the top of the body and the fixed diagonal mark over the page. A document
 * without a <body> tag gets both appended. IDEMPOTENT: a document that already carries the mark is
 * returned unchanged, so a re-staged preview never stacks two marks.
 */
export function withDemoWatermark(html: string): string {
  if (html.includes(`${DEMO_MARK_ATTR}="mark"`)) return html;
  const bar = `<div ${DEMO_MARK_ATTR}="bar" style="${BAR_STYLE}">${DEMO_BAR_TEXT}</div>`;
  const mark = `<div ${DEMO_MARK_ATTR}="mark" aria-hidden="true" style="${MARK_STYLE}">${DEMO_MARK_TEXT}</div>`;
  const open = /<body\b[^>]*>/i.exec(html);
  const withBar = open ? html.slice(0, open.index + open[0].length) + bar + html.slice(open.index + open[0].length) : html + bar;
  const close = withBar.toLowerCase().lastIndexOf("</body>");
  return close >= 0 ? withBar.slice(0, close) + mark + withBar.slice(close) : withBar + mark;
}

/** Which paper a staged document is laid out for. */
export type PreviewPaper = "thermal80" | "a5" | "a4";

/**
 * The on-screen preview window size matching the paper the real document is laid out for. Callers
 * pass the layout they rendered; anything unknown falls back to A4 (the widest, never clipping).
 */
export function previewSizeFor(paper: PreviewPaper | string): { readonly width: number; readonly height: number } {
  if (paper === "thermal80") return { width: 420, height: 860 };
  if (paper === "a5") return { width: 640, height: 860 };
  return { width: 860, height: 1000 };
}
