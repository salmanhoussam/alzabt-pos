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
 *
 * OCR-REVIEW-UX (2026-11-12): a full-height desktop window with ONE scroller per step; three explicit starts —
 * read a printed invoice · a HANDWRITTEN invoice (the photo beside rows typed by hand, no OCR) · manual entry
 * without a photo; every refusal in Arabic AND English on separate lines (never one mixed sentence); the
 * confirmation is a clean table of what will happen — no engine text in it.
 */
import { useState } from "react";
import { ApiError, call, errorText, pos } from "../api";
import { formatDecimal } from "../../domain/money";
import type { ExtractedRow, ReviewPlan } from "../../domain/photoInvoiceReview";
import type { AdminProductDto, ReadInvoicePhotoResponse } from "../../shared/ipcContract";
import { PhotoInvoiceReview, type RowMeta } from "./PhotoInvoiceReview";

type Read = Extract<ReadInvoicePhotoResponse, { status: "read" }>;
type Mode = "read" | "photo-only";

/** A refusal for the operator: one Arabic sentence and its English twin — never a stack, never the text read. */
export interface Bilingual {
  readonly ar: string;
  readonly en: string;
}

export function readFailureText(e: unknown): Bilingual {
  const code = e instanceof ApiError ? e.code : "";
  if (code === "OCR_FAILED") return { ar: "تعذّرت قراءة الصورة على هذا الجهاز. جرّب صورة أوضح، أو أدخل الأصناف يدوياً بجانب الصورة.", en: "The photo could not be read on this computer. Try a clearer photo, or type the items beside the photo." };
  if (code === "INVALID_INPUT") return { ar: "هذا الملف ليس صورة قابلة للقراءة. اختر صورة JPG أو PNG.", en: "This file is not a readable image. Choose a JPG or PNG photo." };
  if (code === "NOT_AVAILABLE") return { ar: "القراءة غير متاحة على هذا الجهاز. أدخل الأصناف يدوياً.", en: "Reading is not available on this computer. Enter the items by hand." };
  if (code === "NOT_AUTHORIZED" || code === "NOT_LOGGED_IN") return { ar: "هذا الحساب لا يملك صلاحية إضافة الأصناف من صورة فاتورة.", en: "This account may not add products from an invoice photo." };
  // GENERIC (DEC-35zzzz): any other failure — both languages, the error CODE as a reference for support, and
  // nothing else: never the message, a stack or anything read from the supplier's paper. The technical detail is
  // in the main-process log (`invoice-photo-refused` / `ipc-internal-error`).
  const ref = /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "UNEXPECTED";
  return {
    ar: `تعذّر إكمال العملية على صورة الفاتورة. جرّب مرة أخرى، أو أدخل الأصناف يدوياً. (رمز الخطأ: ${ref})`,
    en: `The invoice photo could not be processed. Try again, or enter the items by hand. (error code: ${ref})`,
  };
}

function BilingualText({ text, testid }: { text: Bilingual; testid?: string }) {
  return (
    <div className="error bilingual" role="alert" data-testid={testid}>
      <p dir="rtl" lang="ar">
        {text.ar}
      </p>
      {text.en && (
        <p dir="ltr" lang="en">
          {text.en}
        </p>
      )}
    </div>
  );
}

interface Outcome {
  readonly added: string[];
  readonly linked: number;
  readonly skipped: number;
  readonly notDone: Array<{ name: string; why: string }>;
}

/**
 * DEC-35z16 (PILOT): `phoneInvoice` = one photo from the phone-invoice queue instead of the file picker.
 * The review, the Decision Buttons and the confirmation are the SAME; only the photo's source differs.
 * After a confirmed write with no refusal, the photo leaves the queue (`onPhoneReviewed`).
 */
export function PhotoInvoiceFlow({
  products,
  onClose,
  onManual,
  phoneInvoice,
  onPhoneReviewed,
}: {
  products: readonly AdminProductDto[];
  onClose: (created: number) => void;
  onManual?: () => void;
  phoneInvoice?: { readonly batchId: string; readonly id: string };
  onPhoneReviewed?: () => void;
}) {
  const [stage, setStage] = useState<"start" | "reading" | "review" | "confirm" | "writing" | "done">("start");
  const [read, setRead] = useState<Read | null>(null);
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [error, setError] = useState<Bilingual | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [lastMode, setLastMode] = useState<Mode>("read");
  // PHONE-INVOICE-ORIENTATION-01: the photo's current clockwise quarter-turns, whether the operator has
  // edited the rows (a re-read must not silently replace them), and a key that remounts the review on a re-read.
  const [turns, setTurns] = useState(0);
  const [edited, setEdited] = useState(false);
  const [reviewKey, setReviewKey] = useState(0);
  const [askReread, setAskReread] = useState(false);
  const [rotating, setRotating] = useState(false);
  /** The same photo again: the queued phone invoice, or the desktop file just read (no picker). */
  const again = phoneInvoice ? { phoneInvoice } : { reuseLast: true };

  const start = async (mode: Mode) => {
    setStage("reading");
    setLastMode(mode);
    setError(null);
    try {
      const r = await call(pos().readInvoicePhoto(phoneInvoice ? { mode, phoneInvoice } : mode === "read" ? undefined : { mode }));
      if (r.status !== "read") return setStage("start");
      setRead(r);
      setTurns(r.orientation?.quarterTurns ?? 0);
      setEdited(false);
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
  const active = products.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.nameAr }));
  const productName = new Map(products.map((p) => [p.id, p.nameAr]));

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
    // DEC-35z16: a phone photo whose review was confirmed with nothing refused leaves the queue. If any
    // create was refused it STAYS, so the operator can review it again; nothing is lost silently.
    if (phoneInvoice && notDone.length === 0) {
      try {
        await call(pos().releasePhoneInvoice({ ...phoneInvoice, why: "reviewed" }));
      } catch {
        // The products are written; a photo left in the queue is visible and can be deleted there.
      }
      onPhoneReviewed?.();
    }
    setStage("done");
  };

  /**
   * «تدوير يمين/يسار»: the PHOTO turns (main re-orients the real image, and remembers it for a phone
   * invoice); the rows the operator typed stay exactly as they are. Reading the text again is a
   * separate, explicit step («إعادة القراءة»).
   */
  const rotate = async (delta: 1 | -1) => {
    if (!read || rotating) return;
    const next = (turns + delta + 4) % 4;
    setRotating(true);
    setError(null);
    try {
      const r = await call(pos().readInvoicePhoto({ mode: "photo-only", ...again, quarterTurns: next }));
      if (r.status === "read") {
        setRead({ ...read, preview: r.preview, orientation: r.orientation });
        setTurns(next);
      }
    } catch (e) {
      setError(readFailureText(e));
    } finally {
      setRotating(false);
    }
  };
  /** «إعادة القراءة»: OCR again on the photo as it is turned now. Asks first when rows were edited. */
  const reread = async (confirmed: boolean) => {
    if (!read) return;
    if (edited && !confirmed) return setAskReread(true);
    setAskReread(false);
    setRotating(true);
    setError(null);
    try {
      const r = await call(pos().readInvoicePhoto({ mode: "read", ...again, quarterTurns: turns }));
      if (r.status === "read") {
        setRead(r);
        setEdited(false);
        setReviewKey((k) => k + 1);
      }
    } catch (e) {
      setError(readFailureText(e));
    } finally {
      setRotating(false);
    }
  };

  const money = (minor: bigint) => (read ? formatDecimal({ minor, currency: read.currency }) : "");
  const busy = stage === "reading";

  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="photo-flow">
      <div className="panel photo-flow">
        {stage === "start" || stage === "reading" ? (
          <div className="photo-flow-step" dir="rtl">
            <h2>{phoneInvoice ? "مراجعة فاتورة مورّد من الهاتف" : "إضافة أصناف من صورة فاتورة مورّد"}</h2>
            <p className="muted small">القراءة على هذا الجهاز فقط، بلا إنترنت. لا يُضاف أيّ صنف قبل مراجعتك وتأكيدك.</p>
            {error && <BilingualText text={error} testid="photo-flow-error" />}
            <div className="photo-flow-starts">
              <button className="photo-flow-start primary" disabled={busy} onClick={() => void start("read")} data-testid="photo-flow-pick">
                <b>{busy && lastMode === "read" ? "جارٍ القراءة…" : error && lastMode === "read" ? "إعادة المحاولة بصورة" : "فاتورة مطبوعة — اقرأها آلياً"}</b>
                <span className="small">يقرأ البرنامج الأسطر، وتراجع أنت كل سطر بجانب الصورة.</span>
              </button>
              <button className="photo-flow-start" disabled={busy} onClick={() => void start("photo-only")} data-testid="photo-flow-handwritten">
                <b>{busy && lastMode === "photo-only" ? "جارٍ فتح الصورة…" : "فاتورة بخط اليد — أدخلها بنفسي بجانب الصورة"}</b>
                <span className="small">لا قراءة آلية: الصورة أمامك وتكتب الأسطر بسرعة (Enter للسطر التالي).</span>
              </button>
              {onManual && !phoneInvoice && (
                <button className="photo-flow-start" disabled={busy} onClick={onManual} data-testid="photo-flow-manual">
                  <b>إدخال يدوي</b>
                  <span className="small">صنف واحد بلا صورة.</span>
                </button>
              )}
            </div>
            <div className="panel-actions">
              <button className="btn ghost" disabled={busy} onClick={() => onClose(0)}>
                إغلاق
              </button>
            </div>
          </div>
        ) : (stage === "review" || stage === "confirm") && read ? (
          <>
            {/* Kept MOUNTED while confirming, so going back keeps every decision the operator made. */}
            {stage === "review" && (
              <div className="photo-rotate-bar" dir="rtl" data-testid="photo-rotate-bar" data-turns={turns}>
                <button className="btn small" disabled={rotating} onClick={() => void rotate(-1)} data-testid="photo-rotate-left" title="تدوير الصورة ربع دورة إلى اليسار">
                  ↺ تدوير يسار
                </button>
                <button className="btn small" disabled={rotating} onClick={() => void rotate(1)} data-testid="photo-rotate-right" title="تدوير الصورة ربع دورة إلى اليمين">
                  ↻ تدوير يمين
                </button>
                {read.mode !== "photo-only" && (
                  <button className="btn small" disabled={rotating} onClick={() => void reread(false)} data-testid="photo-reread">
                    {rotating ? "جارٍ…" : "إعادة القراءة"}
                  </button>
                )}
                {askReread && (
                  <span className="photo-reread-ask" data-testid="photo-reread-confirm">
                    <span className="small">إعادة القراءة تستبدل الأسطر الحالية — ستضيع تعديلاتك عليها.</span>{" "}
                    <button className="btn small danger" onClick={() => void reread(true)} data-testid="photo-reread-yes">
                      استبدل الأسطر
                    </button>{" "}
                    <button className="btn small" onClick={() => setAskReread(false)} data-testid="photo-reread-no">
                      أبقِ تعديلاتي
                    </button>
                  </span>
                )}
                {error && <BilingualText text={error} testid="photo-rotate-error" />}
              </div>
            )}
            <div className="photo-flow-body" style={{ display: stage === "review" ? "flex" : "none" }}>
              {rows.length === 0 && read.mode !== "photo-only" && (
                <p dir="rtl" className="pir-none" data-testid="photo-flow-none">
                  لم يُقرأ أيّ سطر بثقة. أدخل الأصناف يدوياً من الصورة («+ سطر يدوي»).
                </p>
              )}
              <PhotoInvoiceReview
                key={reviewKey}
                onEdit={() => setEdited(true)}
                rows={rows}
                meta={meta}
                currency={read.currency}
                preview={read.preview}
                unexplained={read.unexplained}
                mode={read.mode ?? "read"}
                products={active}
                onPlan={(p) => {
                  setPlan(p);
                  setStage("confirm");
                }}
                onCancel={() => onClose(0)}
              />
            </div>
            {stage === "confirm" && plan && (
              <div className="photo-flow-step" dir="rtl" data-testid="photo-flow-confirm">
                <h2>تأكيد قبل الإضافة</h2>
                <p data-testid="photo-flow-confirm-counts">
                  صنف جديد <strong>{plan.create.length}</strong> · ربط بصنف موجود <strong>{plan.link.length}</strong> · متخطّى <strong>{plan.skipped.length}</strong>
                </p>
                {plan.create.length > 0 && (
                  <table className="pf-table" data-testid="photo-flow-confirm-new">
                    <caption>أصناف جديدة ستُضاف</caption>
                    <thead>
                      <tr>
                        <th>الاسم</th>
                        <th>سعر البيع</th>
                        <th>كلفة المورّد (لا تُحفظ كسعر بيع)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.create.map((c) => (
                        <tr key={c.rowId}>
                          <td>
                            <bdi dir="auto">{c.name}</bdi>
                          </td>
                          <td className="pf-num">
                            <bdi dir="ltr">{money(c.salePriceMinor)}</bdi>
                          </td>
                          <td className="pf-num muted">
                            <bdi dir="ltr">{money(c.supplierPriceMinor)}</bdi>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {plan.link.length > 0 && (
                  <table className="pf-table" data-testid="photo-flow-confirm-link">
                    <caption>مربوطة بأصناف موجودة — لا يتغيّر فيها شيء</caption>
                    <thead>
                      <tr>
                        <th>الصنف الموجود</th>
                        <th>كلفة المورّد</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.link.map((l) => (
                        <tr key={l.rowId}>
                          <td>
                            <bdi dir="auto">{productName.get(l.productId) ?? "؟"}</bdi>
                          </td>
                          <td className="pf-num muted">
                            <bdi dir="ltr">{money(l.supplierPriceMinor)}</bdi>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="small">
                  مجموع الأسطر المحفوظة:{" "}
                  <bdi dir="ltr" className="pir-num">
                    {money(plan.keptTotalMinor)}
                  </bdi>{" "}
                  <span className="muted">— قارنه بمجموع الورقة قبل التأكيد.</span>
                </p>
                <div className="panel-actions">
                  <button className="btn primary" onClick={() => void write()} data-testid="photo-flow-write">
                    تأكيد الإضافة
                  </button>
                  <button className="btn ghost" onClick={() => setStage("review")} data-testid="photo-flow-back">
                    رجوع للمراجعة
                  </button>
                  {plan.create.length === 0 && <span className="small muted">لا صنف جديد — الربط لا يكتب شيئاً.</span>}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="photo-flow-step" dir="rtl" data-testid="photo-flow-done">
            <h2>{stage === "writing" ? "جارٍ الإضافة…" : "النتيجة"}</h2>
            {outcome && (
              <>
                <p data-testid="photo-flow-result">
                  أُضيف {outcome.added.length} · رُبط {outcome.linked} · تُخطّي {outcome.skipped} · لم يُنفَّذ {outcome.notDone.length}
                </p>
                {outcome.added.length > 0 && (
                  <ul>
                    {outcome.added.map((n) => (
                      <li key={n}>
                        <bdi dir="auto">{n}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
                {outcome.notDone.map((n) => (
                  <p key={n.name} className="error">
                    لم يُضف <bdi dir="auto">{n.name}</bdi>: {n.why}
                  </p>
                ))}
                <div className="panel-actions">
                  <button className="btn primary" onClick={() => onClose(outcome.added.length)}>
                    إغلاق
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
