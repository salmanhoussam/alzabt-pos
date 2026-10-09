# Alzabt POS — UI Unification Track

**Status:** design specification only. No redesign code is authorised by this document.
**Baseline build:** `f090ad9` · **Evidence:** artifact `alzabt-ui-ux-audit` (id `11640027919`,
expires 2027-01-07) and `docs/UI-UX-AUDIT.md`.

## Context

The stable offline build is merged and green. The 49 installed-app screenshots are published and
openable, and Salman has judged the product from the real images rather than from the written
audit. The verdict: **no redesign from scratch.** The structure suits a local POS; the product has
drifted into **two generations of UI**, and the work is to unify them.

Measured, not impressions:

| | `t()` calls | bidi isolation |
|---|---|---|
| `SellScreen` `TodayScreen` `HistoryScreen` `LoginScreen` `ToolsScreen` `Receipt` | **0** | **0** |
| `ProductsScreen` `CompanyProfileForm` `InvoiceSheet` `ReconciliationQueue` `InvoiceHistory` | 35–81 | 3–34 |

The six untranslated, bidi-unsafe files are the cashier's entire daily path. The newer
invoice/products work is already bilingual and bidi-safe, so most fixes apply an existing in-repo
pattern rather than inventing one.

**Outcome:** an agreed UI specification — foundation first, then screen group by screen group —
merged with field-test observations **before any redesign code is written.**

## Decisions taken (not to be re-litigated)

- Sell screen **structure stays**: cart one side, products the other. The problem is language,
  hierarchy and buttons — not layout.
- Invoice actions collapse to **4 roles**: primary `إصدار الفاتورة` · secondary `حفظ` ·
  secondary `خروج` · danger/overflow `حذف المسودّة`. `حفظ` saves only; no two near-identical save
  buttons. **Open:** whether `خروج` saves silently or asks when there are unsaved changes — the one
  behaviour deliberately left undecided, since "save silently" and "ask" are different products
  for a cashier in a hurry.
- Invoice sheet gets a **sticky bottom action bar** and a **collapsible customer header**.
- Product form keeps its modal spirit, becomes **3 sections**, «معلومات إضافية» collapsed.
- Drafts list becomes a **real record row**, fully clickable: رقم/تاريخ — العميل — المبلغ —
  آخر تعديل — الحالة.
- Reconciliation readable in two seconds; **`PENDING` disappears as a raw enum.**
- **`بيانات المتجر` moves out of الفواتير into أدوات/الإعدادات.** الفواتير becomes documents only:
  `السجل | المسودّات | المراجعة | + فاتورة جديدة`.
- Top nav kept as-is.
- Login gets light Arabic branding and a **language toggle before login** — no heavy splash.
- **Deliverable form:** visual mockup + short spec, group by group.
- **Foundation is its own spec, approved before the Sell screen is drawn.**

## Findings that make this cheaper than it looks

Verified read-only in `f090ad9`:

1. **A token layer already exists** — `styles.css` `:root` has 9 custom properties. Foundation
   extends it; nothing is renamed.
2. **A sticky action bar already exists**: `.inv-actions.inv-keep` (`styles.css:161`), commented
   *"The safe way out stays in view while the panel's own content scrolls past it."* Used only by
   `ReconciliationQueue.tsx`. `InvoiceSheet.tsx` uses plain `.inv-actions` in 5 places including
   its main action row (`:676`).
   🔴 **Reuse `.inv-keep` only if its existing behaviour matches the approved InvoiceSheet design.
   Do not force reuse merely because the class exists** — the two screens may have different
   scroll containers, and that must be checked, not assumed.
3. **Control sizes are already generous and should be codified, not shrunk**: `.btn` 48px,
   `.btn.big` 64px, `.btn.key` 56px, `.tab` 48px, `.search` 48px.
4. **Five duplicated selectors** in 263 lines: `.badge`, `.field.inline`, `.small`,
   `table.inv-lines`, `table.inv-lines td.row-actions`. `.small` is defined twice with different
   values (`12px` at `:122`, `.85rem` at `:249`), so some font sizes already depend on source order.
5. **No focus styling at all.** The only `outline` rule is `.btn.selected`; the gold ring in the
   screenshots is Chromium's default and vanishes the moment anyone writes `outline: none`.
6. **14 distinct `btn` class combinations** against 8 defined modifiers; `btn key` and `btn ghost`
   render near-identically, which is why `+`/`−`/`✕` carry the same weight.
7. **Keyboard work is half done**: the quantity input already commits on `Enter`
   (`SellScreen.tsx:165`). The payment modal is what lacks a default.
8. `Clear cart` is already `btn ghost` — it is the **`wide`** modifier under `btn primary big wide`
   that makes it a near-twin of the primary (`SellScreen.tsx:188-192`).
9. **No global `line-height`** is set anywhere, and the stack is `"Segoe UI", system-ui,
   sans-serif` — too tight for Arabic, which needs room for diacritics and descenders.

## Sequence

### Step 1 — Foundation spec · `docs/design/ui-foundation-spec.md`

Approved and reviewed **before** any screen is drawn. Scope: viewport/overflow rule, typography and
Arabic line-height, spacing scale, control height and hit target, semantic status colours, button
roles, badge roles, focus, the bidi isolation rule, the enumerated strings, and the duplicated
selectors.

### Step 2 — Screen groups, each stopping for visual review

```
1  Sell + Payment
2  Login
3  Today + History + Receipt
4  Products  (current UI only)
5  Invoices
```

This order unifies the **whole cashier path first** — exactly the set the audit proved is
English-only and bidi-unsafe — instead of leaving Today/History/Receipt behind while newer screens
get attention.

Each group delivers an HTML mockup at the real **1008×681**, Arabic/RTL, built on the Step 1
tokens, published so it opens beside its `f090ad9` screenshot; plus a one-page spec. 🔴 A mockup is
a **design surface, not product code**: it imports nothing from `src/`, and no file under
`src/renderer/` is touched while designing.

**Sell + Payment specifics:** `Clear cart` loses `wide` and moves away from the primary; the qty row
becomes `− [n] +` with remove demoted. **Prototype Cash as the default/emphasised payment method and
Enter as confirm; validate this against the real shop workflow before freezing it** — this is
precisely the kind of decision a field test can overturn.

**Products specifics — two scopes, deliberately separated so nothing leaks:**

| Scope | Status |
|---|---|
| **Current Products UI** | Redesign of the fields that exist today (Arabic name, English name, SKU, selling price, unit). Mockup may be implemented. |
| **Future Product Master form** | Barcode · Category · Brand · image · configurable fields. **Specification only, until the Product Master data model is approved.** |

🔴 A Products mockup must not suggest to an implementer that barcode or category may be added to a
product from a UI PR. No schema, no migration, no new columns.

### Step 3 — Field test merge

The shop test is **not** a UI review from scratch. The stable build is used as a real product.
Observations are recorded on a sheet per task rather than as free notes, so "the invoice felt long"
becomes evidence:

```
Task:
Start screen:
End screen:
Clicks:
Scrolls:
Hesitation / wrong click:
Unreadable/confusing text:
Time/rough effort:
Operator comment:
```

This is not a timing laboratory. It exists so that a felt impression arrives with its cause
attached — two scrolls and a hesitation at Save/Leave, rather than a feeling.

Those sheets plus the screenshots plus the per-group specs produce the **final UI specification**.
Only then is redesign code authorised.

### Step 4 — Implementation phases (after sign-off)

1. **UI Foundation**
2. **Cashier flow** — Login, Sell, Payment, Today, History, Receipt
3. **Invoice UX** — sticky actions, customer collapse, drafts/review cleanup
4. **Tools / Backup / Recovery** — after they are actually seen, since no screenshot exists
5. **Product Master UI** — only once the Product Master data model is approved

Product Master is last on purpose: it is not a UI-only phase, it depends on a new business/data
stage, and it must not block improvements to Tools and Backup that already exist.

## Files this track will eventually touch (not in the spec steps)

- `src/renderer/styles.css` — token extension, button/badge roles, focus, dedupe
- `src/shared/i18n.ts` — the enumerated keys in both `AR` and `EN`
- `src/renderer/screens/{Sell,Today,History,Login,Tools}Screen.tsx`, `Receipt.tsx` — `t()` plus
  bidi isolation, the same pattern applied per file
- `src/renderer/screens/invoices/InvoiceSheet.tsx` — action roles, sticky bar, collapsible header
- `src/renderer/screens/invoices/InvoiceHistory.tsx` — drafts record rows
- `src/renderer/screens/invoices/ReconciliationQueue.tsx` — status legibility
- `src/renderer/screens/InvoicesScreen.tsx` — move `بيانات المتجر` to أدوات

## Non-goals

- No product code until the final spec is signed off.
- **No migration. No Product Master schema.** Product work is layout only.
- **The printed PDF is out of scope** — stabilised and separately approved. Application UX and
  printed-document design stay apart.
- No shop PC access, no installing the final EXE.
- Top navigation is not restructured beyond moving `بيانات المتجر`.

## Verification

- `npm run typecheck` (authoritative — never root `tsc --noEmit`), and the full suite under
  Electron's node:
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run --pool=threads`
- **Visual proof, not CSS assertions.** Every changed screen is re-captured by the Windows delivery
  workflow and compared against its `f090ad9` baseline. A CSS assertion cannot show that a screen
  reads correctly — that already cost this project a whole-document mirroring bug which 22 passing
  CSS tests missed.
- 🔴 **Mockup-to-product acceptance is visual/checklist based, not a pixel-perfect screenshot
  diff.** The design is changing on purpose; a pixel diff would score every intended improvement as
  a failure.
- The 7 known bidi corruptions are the acceptance set: each must be re-shot and visibly correct.
- Local E2E cannot run in the dev container (the renderer segfaults), so **CI is the only proof**
  for anything driving the installed app.
