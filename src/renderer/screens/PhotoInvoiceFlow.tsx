/**
 * PHOTO-INVOICE-TO-ITEMS — the workflow: Photo → OFFLINE OCR (main) → Review rows (photo beside them) →
 * Product match → CONFIRM summary → catalog write → RESULT (added / linked / not executed).
 *
 *   · nothing reaches the catalog before «تأكيد الإضافة», and then ONLY through the existing
 *     `createProduct` channel (its own validation, permission and durable PRODUCT_CREATED audit);
 *   · a NEW product gets the name and the SALE price the operator typed — the supplier price is a cost
 *     and is never written as the sale price; no SKU or barcode is invented (null);
 *   · a LINK writes nothing today (no cost / stock field exists — DEC-35r: no inventory);
 *   · re-processing the same invoice cannot duplicate a product: an existing name must be linked;
 *   · a failed reading is an on-screen refusal with retry and manual entry; the POS keeps running.
 *   Handwritten invoices are NOT read: they are entered by hand beside the photo (manual fallback).
 */
import { useState } from "react";
import { ApiError, call, errorText, pos } from "../api";
import { formatDecimal } from "../../domain/money";
import type { ExtractedRow, ReviewPlan } from "../../domain/photoInvoiceReview";
import type { AdminProductDto, ReadInvoicePhotoResponse } from "../../shared/ipcContract";
import { PhotoInvoiceReview, type RowMeta } from "./PhotoInvoiceReview";

type Read = Extract<ReadInvoicePhotoResponse, { status: "read" }>;

/** The operator-facing sentence for a failed reading — never a stack, never the text read. */
function readFailureText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "";
  if (code === "OCR_FAILED") return "تعذّرت قراءة الصورة على هذا الجهاز. جرّب صورة أوضح، أو أدخل الأصناف يدوياً. (Reading failed — try a clearer photo or enter the items by hand.)";
  if (code === "INVALID_INPUT") return "هذا الملف ليس صورة قابلة للقراءة. اختر صورة JPG أو PNG. (Not a readable image.)";
  if (code === "NOT_AVAILABLE") return "القراءة غير متاحة على هذا الجهاز. أدخل الأصناف يدوياً. (Reading is not available here.)";
  return errorText(e);
}

interface Outcome {
  readonly added: string[];
  readonly linked: number;
  readonly skipped: number;
  readonly notDone: Array<{ name: string; why: string }>;
}

export function PhotoInvoiceFlow({ products, onClose, onManual }: { products: readonly AdminProductDto[]; onClose: (created: number) => void; onManual?: () => void }) {
  const [stage, setStage] = useState<"start" | "reading" | "review" | "confirm" | "writing" | "done">("start");
  const [read, setRead] = useState<Read | null>(null);
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const start = async () => {
    setStage("reading");
    setError(null);
    try {
      const r = await call(pos().readInvoicePhoto());
      if (r.status !== "read") return setStage("start");
      setRead(r);
      setStage("review");
    } catch (e) {
      setError(readFailureText(e));
      setStage("start");
    }
  };

  const rows: ExtractedRow[] = (read?.rows ?? []).map((r) => ({
    id: r.id,
    rawText: r.rawText,
    name: r.name,
    quantityMilli: r.quantityMilli,
    supplierPriceMinor: r.supplierPriceMinor === null ? null : BigInt(r.supplierPriceMinor),
    lineTotalMinor: r.lineTotalMinor === null ? null : BigInt(r.lineTotalMinor),
    arithmeticOk: r.arithmeticOk,
  }));
  const meta: Record<string, RowMeta> = Object.fromEntries((read?.rows ?? []).map((r) => [r.id, { crop: r.crop, warnings: r.warnings, alternativeNames: r.alternativeNames }]));

  const write = async () => {
    if (!plan || !read) return;
    setStage("writing");
    const added: string[] = [];
    const notDone: Array<{ name: string; why: string }> = [];
    for (const c of plan.create) {
      try {
        await call(
          pos().createProduct({
            draft: { nameAr: c.name, nameEn: null, sku: null, price: formatDecimal({ minor: c.salePriceMinor, currency: read.currency }), baseUnit: "piece" },
          }),
        );
        added.push(c.name);
      } catch (e) {
        // Each refusal is reported; the others still run (each create is its own audited transaction).
        notDone.push({ name: c.name, why: errorText(e) });
      }
    }
    setOutcome({ added, linked: plan.link.length, skipped: plan.skipped.length, notDone });
    setStage("done");
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="photo-flow">
      {/* An explicit WIDTH: the base .panel rule caps panels at a dialog width, which squeezed the photo and
          the row strips into unreadable slivers (seen on the installed build, DEC-35v). */}
      <div className="panel" style={{ width: "min(1400px, 96vw)", maxWidth: "96vw", maxHeight: "94vh", overflow: "auto" }}>
        {stage === "start" || stage === "reading" ? (
          <div dir="rtl">
            <h2>إضافة أصناف من صورة فاتورة مورّد</h2>
            <p className="muted small">القراءة على هذا الجهاز فقط، بلا إنترنت. الفواتير المكتوبة بخط اليد لا تُقرأ آلياً — أدخل أصنافها يدوياً من الصورة.</p>
            {error && (
              <p className="error" data-testid="photo-flow-error">
                {error}
              </p>
            )}
            <div className="panel-actions">
              <button className="btn primary" disabled={stage === "reading"} onClick={() => void start()} data-testid="photo-flow-pick">
                {stage === "reading" ? "جارٍ القراءة…" : error ? "إعادة المحاولة بصورة" : "اختيار صورة الفاتورة"}
              </button>
              {onManual && (
                <button className="btn" disabled={stage === "reading"} onClick={onManual} data-testid="photo-flow-manual">
                  إدخال يدوي
                </button>
              )}
              <button className="btn ghost" disabled={stage === "reading"} onClick={() => onClose(0)}>
                إغلاق
              </button>
            </div>
          </div>
        ) : (stage === "review" || stage === "confirm") && read ? (
          <>
            <div style={{ display: stage === "review" ? "block" : "none" }}>
            {rows.length === 0 && (
              <p dir="rtl" data-testid="photo-flow-none">
                لم يُقرأ أيّ سطر بثقة. أدخل الأصناف يدوياً من الصورة («+ سطر يدوي»).
              </p>
            )}
            {/* Kept MOUNTED while confirming, so going back keeps every decision the operator made. */}
            <PhotoInvoiceReview
              rows={rows}
              meta={meta}
              currency={read.currency}
              preview={read.preview}
              unexplained={read.unexplained}
              products={products.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.nameAr }))}
              onPlan={(p) => {
                setPlan(p);
                setStage("confirm");
              }}
              onCancel={() => onClose(0)}
            />
            </div>
            {stage === "confirm" && plan && (
          <div dir="rtl" data-testid="photo-flow-confirm">
            <h2>تأكيد قبل الإضافة</h2>
            <p>
              سيُضاف <strong>{plan.create.length}</strong> صنفاً جديداً · <strong>{plan.link.length}</strong> مربوطة بأصناف موجودة (لا تغيير عليها) ·{" "}
              <strong>{plan.skipped.length}</strong> متخطّاة.
            </p>
            <ul>
              {plan.create.map((c) => (
                <li key={c.rowId}>
                  <bdi>{c.name}</bdi> — سعر البيع <bdi dir="ltr">{formatDecimal({ minor: c.salePriceMinor, currency: read.currency })}</bdi> (كلفة المورّد{" "}
                  <bdi dir="ltr">{formatDecimal({ minor: c.supplierPriceMinor, currency: read.currency })}</bdi> لا تُحفظ كسعر بيع)
                </li>
              ))}
            </ul>
            <div className="panel-actions">
              <button className="btn primary" onClick={() => void write()} data-testid="photo-flow-write">
                تأكيد الإضافة
              </button>
              <button className="btn ghost" onClick={() => setStage("review")} data-testid="photo-flow-back">
                رجوع للمراجعة
              </button>
            </div>
          </div>
            )}
          </>
        ) : (
          <div dir="rtl" data-testid="photo-flow-done">
            <h2>{stage === "writing" ? "جارٍ الإضافة…" : "النتيجة"}</h2>
            {outcome && (
              <>
                <p data-testid="photo-flow-result">
                  أُضيف {outcome.added.length} · رُبط {outcome.linked} · تُخطّي {outcome.skipped} · لم يُنفَّذ {outcome.notDone.length}
                </p>
                {outcome.added.length > 0 && <p>أُضيف: {outcome.added.join("، ")}</p>}
                {outcome.notDone.map((n) => (
                  <p key={n.name} className="error">
                    لم يُضف <bdi>{n.name}</bdi>: {n.why}
                  </p>
                ))}
                <button className="btn primary" onClick={() => onClose(outcome.added.length)}>
                  إغلاق
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
