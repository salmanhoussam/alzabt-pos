/**
 * Renders the invoice document to real PDFs and PNGs, for VISUAL review before anything ships.
 *
 * 🔴 WHY THIS EXISTS. A CSS assertion proves a rule is present in a stylesheet; it cannot tell you
 * the one-line invoice looks empty, the table proportions are wrong, or the totals block collides
 * with the footer. Visual acceptance needs a picture, so this makes pictures.
 *
 * 🔴 SYNTHETIC DATA ONLY. Every company, customer, item, unit and amount below is invented for this
 * script. No real shop, customer or product value appears here or in the artifacts it writes.
 *
 * Usage:  npx tsx scripts/invoice-pdf-samples.ts [outDir]
 * Needs a Chrome/Chromium binary; CHROME_PATH overrides the search.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderInvoiceDocument } from "../src/main/invoiceDocument";
import { SAMPLES } from "./invoiceSampleFixtures";

const OUT = resolve(process.argv[2] ?? "invoice-pdf-samples");

function chrome(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome/Chromium found; set CHROME_PATH");
}

mkdirSync(OUT, { recursive: true });

/**
 * A SYNTHETIC logo, drawn here in a few lines of SVG.
 *
 * 🔴 NOT A REAL SHOP'S MARK. The centred header must be proven WITH a logo present and WITHOUT one,
 * because the two produce different layouts, and no real brand asset may enter this repository.
 */
const LOGO = join(OUT, "sample-logo.svg");
writeFileSync(
  LOGO,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
     <rect x="2" y="2" width="116" height="76" fill="#fff" stroke="#c1121f" stroke-width="4"/>
     <rect x="18" y="20" width="26" height="40" fill="#111"/>
     <rect x="50" y="34" width="52" height="12" fill="#c1121f"/>
     <text x="60" y="70" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#111">SAMPLE</text>
   </svg>`,
  "utf8",
);
const bin = chrome();
// A4 at 96 dpi, so a screenshot is one page at the real printed proportions.
const A4 = "794,1123";
const flags = ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"];

for (const { name, v } of SAMPLES) {
  // A is rendered WITHOUT a logo on purpose; the rest carry the synthetic one, so both header
  // layouts are in the artifact and can be compared side by side.
  const html = renderInvoiceDocument(v, { logoUrl: name.startsWith("A-") ? null : `file://${LOGO}` });
  // 🔴 THE HTML IS WRITTEN TO A FILE AND LOADED AS `file://`, and from 2026-10-10 the PRODUCT does
  // the same (`stagePrintable` in src/main/main.ts). Until then the product loaded a `data:` URL
  // instead, which has an opaque origin — so Chromium refused the `file://` logo and every shipped
  // invoice printed without one, while THIS artifact showed the logo correctly. The two paths had
  // diverged, and that divergence is exactly why the defect reached a shop. Do not change this
  // scheme without changing the product's, or these samples stop being evidence about the product.
  const htmlPath = join(OUT, `${name}.html`);
  writeFileSync(htmlPath, html, "utf8");
  const url = `file://${htmlPath}`;
  execFileSync(bin, [...flags, `--print-to-pdf=${join(OUT, `${name}.pdf`)}`, "--no-pdf-header-footer", url], {
    stdio: "pipe",
  });
  execFileSync(bin, [...flags, `--screenshot=${join(OUT, `${name}.png`)}`, `--window-size=${A4}`, url], {
    stdio: "pipe",
  });
  const inv = v.invoice;
  console.log(
    `${name}: ${v.lines.length} lines · subtotal ${inv.subtotal.minor} · tax ${inv.tax.minor} ` +
      `· total ${inv.total.minor} · paid ${inv.paid.minor} · balance ${inv.balanceDue.minor}`,
  );
}
console.log(`\nwrote ${SAMPLES.length} samples (html + pdf + png) to ${OUT}`);
