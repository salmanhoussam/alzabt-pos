/**
 * The synthetic invoices the PDF sample generator renders — fixture data ONLY, no rendering.
 *
 * 🔴 WHY THIS IS ITS OWN MODULE. The generator shells out to Chrome at import time, so a test that
 * imported it would try to render PDFs. Splitting the fixtures out lets a test assert what the
 * samples actually CONTAIN without producing a single file — which is what makes the
 * amount-in-words positive control possible at all.
 *
 * 🔴 SYNTHETIC DATA ONLY. Every company, customer, item, unit and amount below is invented. No real
 * shop, customer or product value appears here or in the artifacts the generator writes.
 */
import { amountInWordsAr } from "../src/domain/amountInWords";
import type { InvoiceLineDto, InvoiceViewDto, MoneyDto } from "../src/shared/ipcContract";

export const CURRENCY = "USD";

export const money = (minor: number): MoneyDto => ({ minor: String(minor), currency: CURRENCY });

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

export function view(opts: {
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
      amountInWords: amountInWordsAr({ minor: BigInt(total), currency: CURRENCY }),
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

export const SAMPLES = [
  { name: "A-one-line-tax-off", v: view({ lines: 1, taxBasisPoints: null, paidMinor: 0, number: 101 }) },
  { name: "B-fifteen-lines-tax-off", v: view({ lines: 15, taxBasisPoints: null, paidMinor: 5_000, number: 102 }) },
  { name: "C-tax-on", v: view({ lines: 8, taxBasisPoints: 1_100, paidMinor: 0, number: 103 }) },
  { name: "D-multipage", v: view({ lines: 45, taxBasisPoints: null, paidMinor: 20_000, number: 104 }) },
] as const;
