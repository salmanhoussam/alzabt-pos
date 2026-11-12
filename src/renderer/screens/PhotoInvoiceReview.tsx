/**
 * PHOTO-INVOICE-TO-ITEMS — the REVIEW form (OCR-REVIEW-UX, 2026-11-12: the owner's eight findings).
 *
 * LAYOUT (desktop first): the photo on one side at full height, the rows on the other. ONE scroller — the row
 * list; the header (counts) and the footer (actions) stay in view. The photo pane only scrolls when the operator
 * zooms in (a viewer, by choice). No nested panel, no dialog-width cap.
 *
 * Each row is a card: its strip of the ORIGINAL photo, «قرأ البرنامج» (the engine's text, isolated so Arabic,
 * English and digits never reorder each other), warnings in their own coloured lines, then the fields (numbers
 * always left-to-right) and the decision as BUTTONS: تخطٍّ · صنف جديد · ربط. Suggested products are shown as
 * visible choices with their match share — a suggestion, never a decision.
 *
 * Rules unchanged (src/domain/photoInvoiceReview.ts): every row starts PENDING; a new product's sale price starts
 * EMPTY (the supplier price is a cost); a duplicate name blocks; «إنهاء المراجعة» only produces a PLAN for
 * confirmation — this component writes nothing.
 *
 * MANUAL ENTRY FROM THE PHOTO (handwritten invoices): «+ سطر يدوي», and Enter in the last field of the last row
 * adds the next row and puts the cursor in its name — typing a whole invoice needs no mouse.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDecimal, parseDecimal } from "../../domain/money";
import {
  type ExtractedRow,
  type IssueCode,
  type ReviewPlan,
  type ReviewRow,
  canFinish,
  decideNew,
  lineTotalOf,
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
  CONFLICT: "قراءة أخرى لنفس المكان أعطت أرقاماً مختلفة — قارن بالصورة.",
  SINGLE_READING: "قرأته قراءة واحدة فقط — تحقّق من الأرقام.",
  NOT_PLAIN_ARITHMETIC: "فُسّر بحسم أو صناديق أو عبوة — تحقّق من الكمية والسعر.",
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

const MANUAL_TEXT = "(إدخال يدوي)";
let manualSeq = 0;
const manualRow = (text = ""): ExtractedRow => {
  manualSeq += 1;
  return { id: `manual-${manualSeq}`, rawText: text || MANUAL_TEXT, name: "", quantityMilli: null, supplierPriceMinor: null, lineTotalMinor: null, arithmeticOk: false };
};

const ZOOMS = [
  { z: 1, label: "ملاءمة" },
  { z: 1.5, label: "×1.5" },
  { z: 2.5, label: "×2.5" },
] as const;

export function PhotoInvoiceReview({
  rows: extracted,
  meta = {},
  currency,
  products,
  preview = null,
  unexplained = [],
  mode = "read",
  onPlan,
  onCancel,
}: {
  rows: readonly ExtractedRow[];
  meta?: Readonly<Record<string, RowMeta>>;
  currency: string;
  products: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  preview?: string | null;
  unexplained?: ReadonlyArray<{ readonly text: string; readonly crop: string | null }>;
  /** "photo-only": nothing was read (handwritten) — start with one empty row to type into. */
  mode?: "read" | "photo-only";
  onPlan: (plan: ReviewPlan) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<ReviewRow[]>(() => startReview(mode === "photo-only" && extracted.length === 0 ? [manualRow()] : extracted));
  const [saleText, setSaleText] = useState<Record<string, string>>({});
  const [manualCrops, setManualCrops] = useState<Record<string, string | null>>({});
  const [zoom, setZoom] = useState(1);
  const [focusId, setFocusId] = useState<string | null>(() => (mode === "photo-only" ? rows[0]?.extracted.id ?? null : null));
  const listRef = useRef<HTMLDivElement>(null);
  const set = (id: string, f: (r: ReviewRow) => ReviewRow) => setRows((rs) => rs.map((r) => (r.extracted.id === id ? f(r) : r)));
  const names = useMemo(() => products.map((p) => p.name), [products]);
  const nameOf = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const issuesById = useMemo(() => reviewIssues(rows, names), [rows, names]);
  const ready = useMemo(() => canFinish(rows, names), [rows, names]);

  // Live counts for the header: what is decided, what still blocks, and the kept total to compare with the paper.
  const counts = useMemo(() => {
    let pending = 0, blocking = 0, kept = 0n, keptKnown = true;
    for (const r of rows) {
      if (r.decision.kind === "pending") pending += 1;
      if ((issuesById.get(r.extracted.id) ?? []).some((i) => i.blocking)) blocking += 1;
      if (r.decision.kind === "skip") continue;
      if (r.lineTotalMinor !== null) kept += r.lineTotalMinor;
      else if (r.quantityMilli !== null && r.supplierPriceMinor !== null) kept += lineTotalOf(r.quantityMilli, r.supplierPriceMinor);
      else keptKnown = false;
    }
    return { pending, blocking, kept, keptKnown };
  }, [rows, issuesById]);

  // A new manual row takes the cursor (block body: an effect must never return a value React would call).
  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLInputElement>(`[data-row="${focusId}"] [data-testid="photo-review-name"]`);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusId]);

  const addManual = (crop: string | null, text: string) => {
    const x = manualRow(text);
    setRows((rs) => [...rs, ...startReview([x])]);
    setManualCrops((m) => ({ ...m, [x.id]: crop }));
    setFocusId(x.id);
  };
  /** Enter in the last field of a row = the next row; on the LAST row it opens a new one (no mouse needed). */
  const enterNext = (e: React.KeyboardEvent, id: string) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.extracted.id === id);
    if (at === rows.length - 1) addManual(null, "");
    else setFocusId(rows[at + 1]?.extracted.id ?? null);
  };

  return (
    <div className={`photo-review${preview ? "" : " no-photo"}`} dir="rtl" data-testid="photo-review" data-mode={mode}>
      {preview && (
        <section className="pir-photo" data-testid="photo-review-preview" aria-label="صورة الفاتورة">
          <div className="pir-photo-tools">
            <span className="small muted">صورة الفاتورة</span>
            {ZOOMS.map((o) => (
              <button key={o.z} type="button" className={`btn small${zoom === o.z ? " primary" : " ghost"}`} onClick={() => setZoom(o.z)} data-testid={`photo-zoom-${o.z}`}>
                {o.label}
              </button>
            ))}
          </div>
          <div className={`pir-photo-view${zoom === 1 ? " fit" : ""}`}>
            <img src={preview} alt="صورة الفاتورة" style={zoom === 1 ? undefined : { width: `${zoom * 100}%` }} />
          </div>
        </section>
      )}

      <section className="pir-main">
        <header className="pir-head">
          <h2>{mode === "photo-only" ? "إدخال أصناف الفاتورة يدوياً من الصورة" : "مراجعة أصناف فاتورة المورّد"}</h2>
          <p className="small muted">
            {mode === "photo-only"
              ? "لم تُقرأ الصورة آلياً. اكتب كل سطر كما في الورقة؛ Enter في آخر خانة يفتح السطر التالي. لا يُضاف شيء قبل تأكيدك."
              : "ما قرأه البرنامج اقتراح فقط. لا يُضاف شيء قبل قرارك على كل سطر وتأكيدك. سعر المورّد كلفة، وسعر البيع تكتبه أنت."}
          </p>
          <div className="pir-counts" data-testid="photo-review-counts">
            <span>
              الأسطر <b>{rows.length}</b>
            </span>
            <span className={counts.pending ? "pir-count-warn" : ""}>
              بلا قرار <b data-testid="photo-review-pending">{counts.pending}</b>
            </span>
            <span className={counts.blocking ? "pir-count-bad" : ""}>
              تحتاج تصحيحاً <b>{counts.blocking}</b>
            </span>
            <span>
              مجموع الأسطر المحفوظة{" "}
              <bdi dir="ltr" className="pir-num" data-testid="photo-review-kept">
                {counts.keptKnown ? formatDecimal({ minor: counts.kept, currency }) : "—"}
              </bdi>{" "}
              <span className="muted">(قارنه بمجموع الورقة)</span>
            </span>
          </div>
        </header>

        <div className="pir-rows" ref={listRef} data-testid="photo-review-table">
          {rows.map((r, index) => {
            const id = r.extracted.id;
            const m = meta[id];
            const crop = m?.crop ?? manualCrops[id] ?? null;
            const manual = id.startsWith("manual-");
            const issues = issuesById.get(id) ?? [];
            const suggestions =
              r.decision.kind === "link"
                ? []
                : [...products]
                    .map((p) => ({ p, s: similarity(r.name, p.name) }))
                    .filter((x) => x.s >= 0.5)
                    .sort((a, b) => b.s - a.s)
                    .slice(0, 3);
            return (
              <article
                key={id}
                className={`pir-row d-${r.decision.kind}${issues.some((i) => i.blocking) ? " has-block" : ""}`}
                data-testid="photo-review-row"
                data-row={id}
                data-decision={r.decision.kind}
                data-warnings={(m?.warnings ?? []).join(",")}
              >
                <div className="pir-row-top">
                  <span className="pir-no">{index + 1}</span>
                  {manual && <span className="pir-tag">سطر يدوي</span>}
                  {(!manual || r.extracted.rawText !== MANUAL_TEXT) && (
                    <span className="small pir-raw">
                      <span className="muted">{manual ? "من الصورة: " : "قرأ البرنامج: "}</span>
                      <bdi dir="auto" data-testid="photo-review-raw">
                        {r.extracted.rawText}
                      </bdi>
                    </span>
                  )}
                </div>
                {crop && <img className="pir-crop" src={crop} alt="" data-testid="photo-review-crop" />}
                {(m?.warnings ?? []).map((w) => (
                  <div key={w} className="pir-note warn small" data-warning={w}>
                    ⚠ {WARNING_AR[w] ?? w}
                  </div>
                ))}

                <div className="pir-fields">
                  <label className="pir-name">
                    <span>الاسم</span>
                    <input dir="auto" value={r.name} onChange={(e) => set(id, (x) => ({ ...x, name: e.target.value }))} data-testid="photo-review-name" />
                  </label>
                  <label>
                    <span>الكمية</span>
                    <input
                      dir="ltr"
                      inputMode="decimal"
                      className="pir-num"
                      defaultValue={r.quantityMilli === null ? "" : String(r.quantityMilli / 1000)}
                      data-testid="photo-review-qty"
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        set(id, (x) => ({ ...x, quantityMilli: e.target.value.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 1000) }));
                      }}
                    />
                  </label>
                  <label>
                    <span>سعر المورّد (كلفة)</span>
                    <input dir="ltr" inputMode="decimal" className="pir-num" defaultValue={show(r.supplierPriceMinor, currency)} data-testid="photo-review-cost" onChange={(e) => set(id, (x) => ({ ...x, supplierPriceMinor: toMinor(e.target.value, currency) }))} />
                  </label>
                  <label>
                    <span>المجموع</span>
                    <input
                      dir="ltr"
                      inputMode="decimal"
                      className="pir-num"
                      defaultValue={show(r.lineTotalMinor, currency)}
                      data-testid="photo-review-total"
                      onChange={(e) => set(id, (x) => ({ ...x, lineTotalMinor: toMinor(e.target.value, currency) }))}
                      onKeyDown={(e) => {
                        if (r.decision.kind !== "new") enterNext(e, id);
                      }}
                    />
                  </label>
                </div>
                {(m?.alternativeNames ?? []).length > 0 && (
                  <div className="pir-chips small">
                    <span className="muted">قراءات أخرى للاسم:</span>
                    {(m?.alternativeNames ?? []).map((n) => (
                      <button key={n} type="button" className="btn ghost small" onClick={() => set(id, (x) => ({ ...x, name: n }))}>
                        <bdi dir="auto">{n}</bdi>
                      </button>
                    ))}
                  </div>
                )}

                <div className="pir-decide">
                  <span className="small muted">القرار:</span>
                  <button type="button" className={`btn small${r.decision.kind === "skip" ? " primary" : ""}`} aria-pressed={r.decision.kind === "skip"} onClick={() => set(id, (x) => ({ ...x, decision: { kind: "skip" } }))} data-testid="photo-review-skip">
                    تخطٍّ
                  </button>
                  <button type="button" className={`btn small${r.decision.kind === "new" ? " primary" : ""}`} aria-pressed={r.decision.kind === "new"} onClick={() => r.decision.kind !== "new" && set(id, decideNew)} data-testid="photo-review-new">
                    صنف جديد
                  </button>
                  <select
                    aria-label="ربط بصنف موجود"
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
                    <option value="pending">— بلا قرار —</option>
                    <option value="skip">تخطٍّ</option>
                    <option value="new">صنف جديد</option>
                    <optgroup label="ربط بصنف موجود">
                      {products.map((p) => (
                        <option key={p.id} value={`link:${p.id}`}>
                          ربط: {p.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  {r.decision.kind === "new" && (
                    <label className="pir-sale">
                      <span>سعر البيع</span>
                      <input
                        dir="ltr"
                        inputMode="decimal"
                        className="pir-num"
                        data-testid="photo-review-sale-price"
                        value={saleText[id] ?? ""}
                        onChange={(e) => {
                          const text = e.target.value;
                          setSaleText((s) => ({ ...s, [id]: text }));
                          set(id, (x) => ({ ...x, decision: { kind: "new", salePriceMinor: toMinor(text, currency) } }));
                        }}
                        onKeyDown={(e) => enterNext(e, id)}
                      />
                    </label>
                  )}
                </div>
                {r.decision.kind === "link" && (
                  <div className="pir-note ok small" data-testid="photo-review-linked">
                    سيُربط بالصنف الموجود «<bdi dir="auto">{nameOf.get(r.decision.productId) ?? "؟"}</bdi>» — لا تغيير على الصنف.
                  </div>
                )}
                {suggestions.length > 0 && (
                  <div className="pir-chips small" data-testid="photo-review-suggestions">
                    <span className="muted">أصناف موجودة تشبهه (تحقّق قبل الربط):</span>
                    {suggestions.map(({ p, s }) => (
                      <button key={p.id} type="button" className="btn ghost small" onClick={() => set(id, (x) => ({ ...x, decision: { kind: "link", productId: p.id } }))} data-testid="photo-review-suggest">
                        ربط بـ «<bdi dir="auto">{p.name}</bdi>» · {Math.round(s * 100)}٪
                      </button>
                    ))}
                  </div>
                )}
                {issues.map((i) => (
                  <div key={i.code} className={`pir-note small ${i.blocking ? "bad" : "warn"}`} data-issue={i.code}>
                    {ISSUE_AR[i.code]}
                  </div>
                ))}
              </article>
            );
          })}

          {unexplained.length > 0 && (
            <div className="pir-unexplained small" data-testid="photo-flow-unexplained">
              <strong>أسطر لم تُفهم أرقامها — أضفها يدوياً إن كانت أصنافاً:</strong>
              {unexplained.map((u, i) => (
                <div key={`${i}-${u.text}`} className="pir-unexplained-line" data-testid="photo-unexplained-line">
                  {u.crop && <img className="pir-crop" src={u.crop} alt="" />}
                  <bdi dir="auto">{u.text}</bdi>{" "}
                  <button type="button" className="btn ghost small" onClick={() => addManual(u.crop, u.text)} data-testid="photo-unexplained-add">
                    أضِف كسطر يدوي
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="pir-foot">
          <button className="btn" type="button" onClick={() => addManual(null, "")} data-testid="photo-review-add-manual">
            + سطر يدوي
          </button>
          <span className="pir-spacer" />
          {!ready && <span className="small muted">{counts.pending ? `${counts.pending} بلا قرار` : "صحّح الأسطر المعلَّمة بالأحمر"}</span>}
          <button className="btn ghost" onClick={onCancel}>
            إلغاء
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => onPlan(planOf(rows, names))} data-testid="photo-review-finish">
            إنهاء المراجعة
          </button>
        </footer>
      </section>
    </div>
  );
}
