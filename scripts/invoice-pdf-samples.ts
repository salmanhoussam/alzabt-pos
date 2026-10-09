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
import type { InvoiceLineDto, InvoiceViewDto, MoneyDto } from "../src/shared/ipcContract";

const OUT = resolve(process.argv[2] ?? "invoice-pdf-samples");
const CURRENCY = "USD";

const money = (minor: number): MoneyDto => ({ minor: String(minor), currency: CURRENCY });

/** Exact half-up, the same rule the ledger uses. Integer arithmetic only. */
const lineTotal = (quantityMilli: number, unitPriceMinor: number) =>
  Math.trunc((quantityMilli * unitPriceMinor + 500) / 1000);

function line(no: number, description: string, unitLabel: string, quantityMilli: number, unitPriceMinor: number): InvoiceLineDto {
  const whole = quantityMilli % 1000 === 0;
  return {
    id: `line-${no}`,
    lineNo: no,
    description,
    unitLabel,
    canonicalUnit: null,
    productId: null,
    quantityMilli,
    quantityText: whole ? String(quantityMilli / 1000) : (quantityMilli / 1000).toFixed(3).replace(/0+$/, ""),
    unitPrice: money(unitPriceMinor),
    lineTotal: money(lineTotal(quantityMilli, unitPriceMinor)),
  };
}

/** A deliberately varied set: short and long descriptions, fractional quantities, a free-text unit. */
const CATALOGUE: ReadonlyArray<readonly [string, string, number, number]> = [
  ["مفك براغي صليبي متوسط", "حبة", 12_000, 150],
  ["شريط لاصق شفاف عريض", "حبة", 6_000, 275],
  ["مسامير فولاذية 6 مم", "كيس (50PCS)", 4_000, 1_250],
  ["خرطوم ماء مرن 10 متر", "متر", 2_500, 400],
  ["دهان أبيض لامع 1 لتر", "علبة", 3_000, 1_950],
  ["قفل باب نحاسي", "حبة", 1_000, 4_500],
  ["شاكوش خفيف", "حبة", 2_000, 1_100],
  ["منشار يدوي صغير", "حبة", 1_000, 2_250],
  ["لاصق خشب قوي", "علبة", 5_000, 650],
  ["صنفرة ناعمة", "باكيت", 8_000, 125],
  ["مفتاح إنجليزي قابل للتعديل", "حبة", 1_000, 3_750],
  ["كماشة متوسطة", "حبة", 2_000, 1_600],
  ["شريط قياس 5 متر", "حبة", 3_000, 900],
  ["براغي خشب 4 سم", "كيس (50PCS)", 10_000, 325],
  ["مسطرة معدنية 60 سم", "حبة", 1_500, 700],
];

function view(opts: {
  readonly lines: number;
  readonly taxBasisPoints: number | null;
  readonly paidMinor: number;
  readonly number: number;
}): InvoiceViewDto {
  const lines = Array.from({ length: opts.lines }, (_, i) => {
    const [desc, unit, qty, price] = CATALOGUE[i % CATALOGUE.length]!;
    // Vary long runs so a multipage sample is not fifteen identical rows.
    return line(i + 1, opts.lines > 20 ? `${desc} — ${i + 1}` : desc, unit, qty, price);
  });
  const subtotal = lines.reduce((sum, l) => sum + Number(l.lineTotal.minor), 0);
  const tax = opts.taxBasisPoints === null ? 0 : Math.trunc((subtotal * opts.taxBasisPoints + 5_000) / 10_000);
  const total = subtotal + tax;
  const paid = Math.min(opts.paidMinor, total);
  return {
    invoice: {
      id: "sample",
      status: "final",
      invoiceNumber: opts.number,
      invoiceDate: "2026-10-09",
      currency: CURRENCY,
      customerName: "شركة المقاولات النموذجية",
      customerAddress: "شارع الاختبار، بناية رقم ١٢، الطابق الثاني",
      customerPhone: "70-000000",
      notes: opts.lines === 1 ? null : "التسليم خلال ثلاثة أيام عمل",
      subtotal: money(subtotal),
      tax: money(tax),
      total: money(total),
      paid: money(paid),
      balanceDue: money(total - paid),
      amountInWords: "فقط المبلغ المذكور أعلاه لا غير",
      issuer: {
        nameAr: "متجر العدة النموذجي",
        nameEn: "Sample Hardware Store",
        legalName: null,
        tagline: "عدد كهربائية ● أدوات بناء ● دهانات",
        address: "منطقة الاختبار — الشارع الرئيسي",
        phone1: "+961 00 000 000",
        phone2: "+961 11 111 111",
        email: null,
        logoPath: null,
        logoAsset: null,
        taxpayerNumber: "TP-SAMPLE-1",
        commercialRegister: "CR-SAMPLE-2",
        vatNumber: null,
      },
      taxSnapshot:
        opts.taxBasisPoints === null
          ? { enabled: false, rateBasisPoints: 0, label: null }
          : { enabled: true, rateBasisPoints: opts.taxBasisPoints, label: "ض.ق.م" },
      createdByName: "أمين الصندوق",
      createdAt: "2026-10-09T09:00:00.000Z",
      updatedAt: "2026-10-09T09:00:00.000Z",
      finalizedAt: "2026-10-09T09:00:00.000Z",
    },
    lines,
  };
}

const SAMPLES = [
  { name: "A-one-line-tax-off", v: view({ lines: 1, taxBasisPoints: null, paidMinor: 0, number: 101 }) },
  { name: "B-fifteen-lines-tax-off", v: view({ lines: 15, taxBasisPoints: null, paidMinor: 5_000, number: 102 }) },
  { name: "C-tax-on", v: view({ lines: 8, taxBasisPoints: 1_100, paidMinor: 0, number: 103 }) },
  { name: "D-multipage", v: view({ lines: 45, taxBasisPoints: null, paidMinor: 20_000, number: 104 }) },
] as const;

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
