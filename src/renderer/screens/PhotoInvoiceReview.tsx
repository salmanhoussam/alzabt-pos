/**
 * PHOTO-INVOICE-TO-ITEMS — the REVIEW form (isolated slice; not yet wired to OCR, IPC or navigation).
 *
 * Every row read from a supplier invoice photo is shown with the engine's ORIGINAL text beside the
 * editable fields. The operator decides each row: skip · link to an existing product · new product
 * (with a sale price the operator TYPES — the supplier price is a cost and is never copied into it).
 * «إنهاء المراجعة» stays disabled while any row blocks, and finishing only produces a PLAN for the
 * operator to confirm: this component writes nothing anywhere. All rules: src/domain/photoInvoiceReview.ts.
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

const toMinor = (text: string, currency: string): bigint | null => {
  if (text.trim() === "") return null;
  try {
    return parseDecimal(text.trim(), currency).minor;
  } catch {
    return null;
  }
};
const show = (minor: bigint | null, currency: string) => (minor === null ? "" : formatDecimal({ minor, currency }));

export function PhotoInvoiceReview({
  rows: extracted,
  currency,
  products,
  onPlan,
  onCancel,
}: {
  rows: readonly ExtractedRow[];
  currency: string;
  /** Existing products the operator may link a row to (id + name only). */
  products: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onPlan: (plan: ReviewPlan) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<ReviewRow[]>(() => startReview(extracted));
  const [saleText, setSaleText] = useState<Record<string, string>>({});
  const set = (id: string, f: (r: ReviewRow) => ReviewRow) => setRows((rs) => rs.map((r) => (r.extracted.id === id ? f(r) : r)));
  const names = useMemo(() => products.map((p) => p.name), [products]);
  const issuesById = useMemo(() => reviewIssues(rows, names), [rows, names]);
  const ready = useMemo(() => canFinish(rows, names), [rows, names]);

  return (
    <div className="panel photo-review" data-testid="photo-review" dir="rtl">
      <h2>مراجعة أصناف فاتورة المورّد</h2>
      <p className="muted small">
        ما قرأه البرنامج من الصورة اقتراح فقط. لا يُضاف شيء إلى الأصناف قبل قرارك على كل سطر. سعر المورّد كلفة، وسعر البيع تكتبه أنت.
      </p>
      <table className="statement-table" data-testid="photo-review-table">
        <thead>
          <tr>
            <th>النصّ المقروء</th>
            <th>الاسم</th>
            <th>الكمية</th>
            <th>سعر المورّد</th>
            <th>المجموع</th>
            <th>القرار</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const id = r.extracted.id;
            const issues = issuesById.get(id) ?? [];
            return (
              <tr key={id} data-testid="photo-review-row" data-row={id} data-decision={r.decision.kind}>
                <td className="small muted">
                  <bdi data-testid="photo-review-raw">{r.extracted.rawText}</bdi>
                  {!r.extracted.arithmeticOk && <div className="warn">الحساب غير مطابق في القراءة</div>}
                </td>
                <td>
                  <input value={r.name} onChange={(e) => set(id, (x) => ({ ...x, name: e.target.value }))} data-testid="photo-review-name" />
                </td>
                <td>
                  <input
                    dir="ltr"
                    value={r.quantityMilli === null ? "" : String(r.quantityMilli / 1000)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      set(id, (x) => ({ ...x, quantityMilli: e.target.value.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 1000) }));
                    }}
                  />
                </td>
                <td>
                  <input
                    dir="ltr"
                    defaultValue={show(r.supplierPriceMinor, currency)}
                    onChange={(e) => set(id, (x) => ({ ...x, supplierPriceMinor: toMinor(e.target.value, currency) }))}
                  />
                </td>
                <td>
                  <input
                    dir="ltr"
                    defaultValue={show(r.lineTotalMinor, currency)}
                    onChange={(e) => set(id, (x) => ({ ...x, lineTotalMinor: toMinor(e.target.value, currency) }))}
                  />
                </td>
                <td>
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
                    {products.map((p) => (
                      <option key={p.id} value={`link:${p.id}`}>
                        ربط: {p.name}
                      </option>
                    ))}
                  </select>
                  {r.decision.kind === "new" && (
                    <label className="small">
                      سعر البيع
                      <input
                        dir="ltr"
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
      <div className="panel-actions">
        <button className="btn primary" disabled={!ready} onClick={() => onPlan(planOf(rows, names))} data-testid="photo-review-finish">
          إنهاء المراجعة
        </button>
        <button className="btn ghost" onClick={onCancel}>
          إلغاء
        </button>
      </div>
    </div>
  );
}
