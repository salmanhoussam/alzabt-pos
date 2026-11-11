/**
 * PHOTO-INVOICE-TO-ITEMS — the REVIEW form. The photo is shown BESIDE the rows; every row shows the
 * strip of the ORIGINAL photo it was read from, the engine's original text, its warnings and the other
 * names read for it. The operator decides each row: skip · link to an existing product (SUGGESTIONS
 * by name similarity are offered, never forced) · new product (sale price TYPED; the supplier price is
 * a cost and is never copied). Lines the reader could not explain are shown with their strip and can
 * be added as a MANUAL row. «إنهاء المراجعة» stays disabled while any row blocks; finishing only
 * produces a PLAN for confirmation — this component writes nothing. Rules: src/domain/photoInvoiceReview.ts.
 */
import { useMemo, useState } from "react";
import { formatDecimal, parseDecimal } from "../../domain/money";
import {
  type ExtractedRow,
  type IssueCode,
  type ReviewPlan,
  type ReviewRow,
  canFinish,
  decideNew,
  planOf,
  productNameKey,
  reviewIssues,
  startReview,
} from "../../domain/photoInvoiceReview";

const ISSUE_AR: Record<IssueCode, string> = {
  DECISION_PENDING: "اختر: تخطٍّ، أو ربط بصنف موجود، أو صنف جديد.",
  NAME_REQUIRED: "اكتب اسم الصنف.",
  QUANTITY_INVALID: "الكمية غير مقروءة أو غير صحيحة.",
  SUPPLIER_PRICE_INVALID: "سعر المورّد غير مقروء أو غير صحيح.",
  TOTAL_MISMATCH: "الكمية × السعر لا تساوي المجموع المقروء — راجع الورقة.",
  SALE_PRICE_REQUIRED: "اكتب سعر البيع بنفسك (سعر المورّد كلفة، لا سعر بيع).",
  SALE_PRICE_EQUALS_COST: "سعر البيع يساوي الكلفة.",
  SALE_PRICE_BELOW_COST: "سعر البيع أقلّ من الكلفة.",
  PRODUCT_REQUIRED: "اختر الصنف الموجود.",
  DUPLICATE_PRODUCT_NAME: "هذا الاسم موجود في الأصناف — اربطه بالصنف الموجود بدل إنشاء نسخة ثانية.",
  DUPLICATE_IN_REVIEW: "سطران بهذه المراجعة سيُنشئان الاسم نفسه.",
};

export const WARNING_AR: Record<string, string> = {
  CONFLICT: "⚠ قراءة أخرى لنفس المكان أعطت أرقاماً مختلفة — قارن بالصورة.",
  SINGLE_READING: "⚠ قرأته قراءة واحدة فقط — تحقّق من الأرقام.",
  NOT_PLAIN_ARITHMETIC: "ℹ فُسّر بحسم أو صناديق أو عبوة — تحقّق من الكمية والسعر.",
};

export interface RowMeta {
  readonly crop: string | null;
  readonly warnings: readonly string[];
  readonly alternativeNames: readonly string[];
}

const toMinor = (text: string, currency: string): bigint | null => {
  if (text.trim() === "") return null;
  try {
    return parseDecimal(text.trim(), currency).minor;
  } catch {
    return null;
  }
};
const show = (minor: bigint | null, currency: string) => (minor === null ? "" : formatDecimal({ minor, currency }));
const words = (s: string) => new Set(productNameKey(s).split(" ").filter((w) => w.length >= 2));
/** Share of the row's words found in a product name — a SUGGESTION score, never a decision. */
export function similarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.max(A.size, B.size);
}

let manualSeq = 0;

export function PhotoInvoiceReview({
  rows: extracted,
  meta = {},
  currency,
  products,
  preview = null,
  unexplained = [],
  onPlan,
  onCancel,
}: {
  rows: readonly ExtractedRow[];
  meta?: Readonly<Record<string, RowMeta>>;
  currency: string;
  products: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  preview?: string | null;
  unexplained?: ReadonlyArray<{ readonly text: string; readonly crop: string | null }>;
  onPlan: (plan: ReviewPlan) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<ReviewRow[]>(() => startReview(extracted));
  const [saleText, setSaleText] = useState<Record<string, string>>({});
  const [manualCrops, setManualCrops] = useState<Record<string, string | null>>({});
  const set = (id: string, f: (r: ReviewRow) => ReviewRow) => setRows((rs) => rs.map((r) => (r.extracted.id === id ? f(r) : r)));
  const names = useMemo(() => products.map((p) => p.name), [products]);
  const issuesById = useMemo(() => reviewIssues(rows, names), [rows, names]);
  const ready = useMemo(() => canFinish(rows, names), [rows, names]);

  const addManual = (crop: string | null, text: string) => {
    manualSeq += 1;
    const id = `manual-${manualSeq}`;
    setRows((rs) => [
      ...rs,
      ...startReview([{ id, rawText: text || "(إدخال يدوي)", name: "", quantityMilli: null, supplierPriceMinor: null, lineTotalMinor: null, arithmeticOk: false }]),
    ]);
    setManualCrops((m) => ({ ...m, [id]: crop }));
  };

  return (
    <div className="photo-review-wrap" dir="rtl" data-testid="photo-review" style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      {preview && (
        <div style={{ flex: "0 0 32%", position: "sticky", top: 0, maxHeight: "80vh", overflow: "auto" }} data-testid="photo-review-preview">
          <img src={preview} alt="صورة الفاتورة" style={{ width: "100%", border: "1px solid var(--border)" }} />
        </div>
      )}
      <div className="panel photo-review" style={{ flex: 1, minWidth: 0, width: "auto", maxHeight: "none" }}>
        <h2>مراجعة أصناف فاتورة المورّد</h2>
        <p className="muted small">
          ما قرأه البرنامج اقتراح فقط. لا يُضاف شيء قبل قرارك على كل سطر وتأكيدك. سعر المورّد كلفة، وسعر البيع تكتبه أنت.
        </p>
        <table className="statement-table" data-testid="photo-review-table">
          <tbody>
            {rows.map((r) => {
              const id = r.extracted.id;
              const m = meta[id];
              const crop = m?.crop ?? manualCrops[id] ?? null;
              const issues = issuesById.get(id) ?? [];
              const suggestions = [...products]
                .map((p) => ({ p, s: similarity(r.name, p.name) }))
                .filter((x) => x.s >= 0.5)
                .sort((a, b) => b.s - a.s)
                .slice(0, 3);
              return (
                <tr key={id} data-testid="photo-review-row" data-row={id} data-decision={r.decision.kind} data-warnings={(m?.warnings ?? []).join(",")}>
                  <td style={{ width: "100%" }}>
                    {crop && <img src={crop} alt="" style={{ width: "100%", maxHeight: 140, objectFit: "contain", objectPosition: "right center", display: "block", border: "1px solid var(--border)" }} data-testid="photo-review-crop" />}
                    <div className="small muted">
                      <bdi data-testid="photo-review-raw">{r.extracted.rawText}</bdi>
                    </div>
                    {(m?.warnings ?? []).map((w) => (
                      <div key={w} className="warn small" data-warning={w}>
                        {WARNING_AR[w] ?? w}
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                      <label className="small">
                        الاسم
                        <input value={r.name} onChange={(e) => set(id, (x) => ({ ...x, name: e.target.value }))} data-testid="photo-review-name" style={{ minWidth: 260 }} />
                      </label>
                      {(m?.alternativeNames ?? []).map((n) => (
                        <button key={n} type="button" className="btn ghost small" onClick={() => set(id, (x) => ({ ...x, name: n }))} title="قراءة أخرى للاسم">
                          <bdi>{n}</bdi>
                        </button>
                      ))}
                      <label className="small">
                        الكمية
                        <input
                          dir="ltr"
                          size={6}
                          defaultValue={r.quantityMilli === null ? "" : String(r.quantityMilli / 1000)}
                          data-testid="photo-review-qty"
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            set(id, (x) => ({ ...x, quantityMilli: e.target.value.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 1000) }));
                          }}
                        />
                      </label>
                      <label className="small">
                        سعر المورّد
                        <input dir="ltr" size={8} defaultValue={show(r.supplierPriceMinor, currency)} data-testid="photo-review-cost" onChange={(e) => set(id, (x) => ({ ...x, supplierPriceMinor: toMinor(e.target.value, currency) }))} />
                      </label>
                      <label className="small">
                        المجموع
                        <input dir="ltr" size={8} defaultValue={show(r.lineTotalMinor, currency)} data-testid="photo-review-total" onChange={(e) => set(id, (x) => ({ ...x, lineTotalMinor: toMinor(e.target.value, currency) }))} />
                      </label>
                      <label className="small">
                        القرار
                        <select
                          value={r.decision.kind === "link" ? `link:${r.decision.productId}` : r.decision.kind}
                          data-testid="photo-review-decision"
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "new") set(id, decideNew);
                            else if (v === "skip") set(id, (x) => ({ ...x, decision: { kind: "skip" } }));
                            else if (v === "pending") set(id, (x) => ({ ...x, decision: { kind: "pending" } }));
                            else if (v.startsWith("link:")) set(id, (x) => ({ ...x, decision: { kind: "link", productId: v.slice(5) } }));
                          }}
                        >
                          <option value="pending">— اختر —</option>
                          <option value="skip">تخطٍّ</option>
                          <option value="new">صنف جديد</option>
                          {suggestions.length > 0 && (
                            <optgroup label="مقترح (تحقّق قبل الربط)">
                              {suggestions.map(({ p }) => (
                                <option key={`s-${p.id}`} value={`link:${p.id}`}>
                                  ربط: {p.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="كل الأصناف">
                            {products.map((p) => (
                              <option key={p.id} value={`link:${p.id}`}>
                                ربط: {p.name}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      </label>
                      {r.decision.kind === "new" && (
                        <label className="small">
                          سعر البيع
                          <input
                            dir="ltr"
                            size={8}
                            data-testid="photo-review-sale-price"
                            value={saleText[id] ?? ""}
                            onChange={(e) => {
                              const text = e.target.value;
                              setSaleText((s) => ({ ...s, [id]: text }));
                              set(id, (x) => ({ ...x, decision: { kind: "new", salePriceMinor: toMinor(text, currency) } }));
                            }}
                          />
                        </label>
                      )}
                    </div>
                    {issues.map((i) => (
                      <div key={i.code} className={i.blocking ? "error small" : "warn small"} data-issue={i.code}>
                        {ISSUE_AR[i.code]}
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {unexplained.length > 0 && (
          <div className="warn small" data-testid="photo-flow-unexplained">
            <strong>أسطر لم تُفهم أرقامها — أضفها يدوياً إن كانت أصنافاً:</strong>
            {unexplained.map((u, i) => (
              <div key={`${i}-${u.text}`} style={{ marginTop: 6 }} data-testid="photo-unexplained-line">
                {u.crop && <img src={u.crop} alt="" style={{ width: "100%", maxHeight: 80, objectFit: "contain", display: "block" }} />}
                <bdi>{u.text}</bdi>{" "}
                <button type="button" className="btn ghost small" onClick={() => addManual(u.crop, u.text)} data-testid="photo-unexplained-add">
                  أضِف كسطر يدوي
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="panel-actions">
          <button className="btn" type="button" onClick={() => addManual(null, "")} data-testid="photo-review-add-manual">
            + سطر يدوي
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => onPlan(planOf(rows, names))} data-testid="photo-review-finish">
            إنهاء المراجعة
          </button>
          <button className="btn ghost" onClick={onCancel}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
