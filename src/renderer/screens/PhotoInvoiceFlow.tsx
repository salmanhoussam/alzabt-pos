/**
 * PHOTO-INVOICE-TO-ITEMS — the workflow: Photo → OFFLINE OCR (main) → Review rows → Product match →
 * CONFIRM → catalog write. Nothing reaches the catalog before «تأكيد الإضافة», and then ONLY through the
 * existing `createProduct` channel (its own validation, permission and durable PRODUCT_CREATED audit).
 *
 *   · a NEW product is created with the name and the SALE price the operator typed — the supplier price
 *     is a cost and is never written as the sale price; no SKU or barcode is invented (null);
 *   · a LINK writes nothing today (there is no cost / stock field to update — DEC-35r: no inventory);
 *   · re-processing the same invoice cannot duplicate a product: an existing name must be linked;
 *   · lines the reader could not explain are listed for manual entry from the photo, never guessed.
 */
import { useState } from "react";
import { ApiError, call, errorText, pos } from "../api";
import { formatDecimal } from "../../domain/money";
import type { ExtractedRow, ReviewPlan } from "../../domain/photoInvoiceReview";
import type { AdminProductDto, ReadInvoicePhotoResponse } from "../../shared/ipcContract";
import { PhotoInvoiceReview } from "./PhotoInvoiceReview";

type Read = Extract<ReadInvoicePhotoResponse, { status: "read" }>;

/** The operator-facing sentence for a failed reading — never a stack, never the text read. */
function readFailureText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "";
  if (code === "OCR_FAILED") return "تعذّرت قراءة الصورة على هذا الجهاز. جرّب صورة أوضح، أو أدخل الأصناف يدوياً. (Reading failed — try a clearer photo or enter the items by hand.)";
  if (code === "INVALID_INPUT") return "هذا الملف ليس صورة قابلة للقراءة. اختر صورة JPG أو PNG. (Not a readable image.)";
  if (code === "NOT_AVAILABLE") return "القراءة غير متاحة على هذا الجهاز. أدخل الأصناف يدوياً. (Reading is not available here.)";
  return errorText(e);
}

export function PhotoInvoiceFlow({ products, onClose, onManual }: { products: readonly AdminProductDto[]; onClose: (created: number) => void; onManual?: () => void }) {
  const [stage, setStage] = useState<"start" | "reading" | "review" | "confirm" | "writing" | "done">("start");
  const [read, setRead] = useState<Read | null>(null);
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string[]>([]);

  const start = async () => {
    setStage("reading");
    setError(null);
    try {
      const r = await call(pos().readInvoicePhoto());
      if (r.status !== "read") return setStage("start");
      setRead(r);
      setStage("review");
    } catch (e) {
      // A failed reading is an ordinary refusal on screen: the POS keeps running, nothing was written.
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

  const write = async () => {
    if (!plan || !read) return;
    setStage("writing");
    setError(null);
    const done: string[] = [];
    for (const c of plan.create) {
      try {
        await call(
          pos().createProduct({
            draft: { nameAr: c.name, nameEn: null, sku: null, price: formatDecimal({ minor: c.salePriceMinor, currency: read.currency }), baseUnit: "piece" },
          }),
        );
        done.push(c.name);
      } catch (e) {
        // Stop at the first refusal: what was created is listed; re-processing will LINK those (duplicate rule).
        setError(`${c.name}: ${errorText(e)}`);
        break;
      }
    }
    setCreated(done);
    setStage("done");
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="photo-flow">
      <div className="panel" style={{ maxWidth: "min(1100px, 96vw)", maxHeight: "92vh", overflow: "auto" }}>
        {stage === "start" || stage === "reading" ? (
          <div dir="rtl">
            <h2>إضافة أصناف من صورة فاتورة مورّد</h2>
            <p className="muted small">القراءة على هذا الجهاز فقط، بلا إنترنت. الفواتير المكتوبة بخط اليد لا تُقرأ آلياً — أدخل أصنافها يدوياً من الصورة.</p>
            {error && <p className="error" data-testid="photo-flow-error">{error}</p>}
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
        ) : stage === "review" && read ? (
          <>
            {read.unexplained.length > 0 && (
              <div className="warn small" dir="rtl" data-testid="photo-flow-unexplained">
                أسطر فيها مبالغ لم يُفهم ترتيبها — أدخلها يدوياً إن كانت أصنافاً:
                <ul>{read.unexplained.map((l) => <li key={l}><bdi>{l}</bdi></li>)}</ul>
              </div>
            )}
            {rows.length === 0 ? (
              <p dir="rtl">لم يُقرأ أيّ سطر بثقة. أدخل الأصناف يدوياً من الصورة.</p>
            ) : (
              <PhotoInvoiceReview
                rows={rows}
                currency={read.currency}
                products={products.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.nameAr }))}
                onPlan={(p) => {
                  setPlan(p);
                  setStage("confirm");
                }}
                onCancel={() => onClose(0)}
              />
            )}
          </>
        ) : stage === "confirm" && plan && read ? (
          <div dir="rtl" data-testid="photo-flow-confirm">
            <h2>تأكيد قبل الإضافة</h2>
            <p>سيُضاف {plan.create.length} صنفاً جديداً · {plan.link.length} مربوطة بأصناف موجودة (لا تغيير عليها) · {plan.skipped.length} متخطّاة.</p>
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
              <button className="btn ghost" onClick={() => setStage("review")}>
                رجوع للمراجعة
              </button>
            </div>
          </div>
        ) : (
          <div dir="rtl" data-testid="photo-flow-done">
            <h2>{stage === "writing" ? "جارٍ الإضافة…" : "انتهى"}</h2>
            {created.length > 0 && <p>أُضيف: {created.join("، ")}</p>}
            {error && <p className="error">{error}</p>}
            {stage === "done" && (
              <button className="btn primary" onClick={() => onClose(created.length)}>
                إغلاق
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
