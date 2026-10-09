# Alzabt POS — UI/UX Audit of the Current Product

**Build audited:** `f090ad9` (main) · **Screenshot source:** CI run `37972553077`
**Method:** 49 installed-app Windows screenshots at a consistent 1008×681, produced by the delivery
workflow against the INSTALLED application. No local rendering, no shop access, synthetic data only.
13 screens examined in depth; the remainder inventoried.

> **Evidence rule applied throughout:** a screen is called "reviewed" only where a real screenshot
> was examined. Where a conclusion comes from source instead, it is labelled
> **SOURCE-DERIVED — NOT VISUALLY VERIFIED**. Nothing here is inferred from code and reported as
> if it had been seen.

Read this file beside `ui-ux-audit-current/`, which holds the screenshots named below.

---

## Screenshot inventory → screen map

| File | Screen / state | Examined |
|---|---|---|
| `01-login.png` | Cashier select (first screen after launch) | ✅ depth |
| `02-cart.png` | POS checkout, cart populated | ✅ depth |
| `03-payment.png` | Payment method modal | ✅ depth |
| `04-receipt.png` | Receipt after sale | inventoried |
| `05-today.png` | Today's sales summary | ✅ depth |
| `06-void-dialog.png` | Void confirmation (destructive modal) | ✅ depth |
| `07-history.png` | Sales history | ✅ via `06` |
| `08-today-after-kill.png` | Today's sales after a forced kill (crash recovery) | inventoried |
| `catalog-01-imported.png` | Excel catalog import, imported state | inventoried |
| `catalog-02-receipt.png` | Receipt from imported catalog | inventoried |
| `P1-products-arabic-empty.png` | Products list, EMPTY state, Arabic/RTL | ✅ depth |
| `P2-add-product-arabic.png` | Add product form, Arabic | ✅ depth |
| `P3-search-normalised.png` | Product search, Arabic normalisation | inventoried |
| `P4-edit-product.png` | Edit product form | inventoried |
| `P5-products-english-ltr.png` | Products list, English/LTR | ✅ depth |
| `P6-deactivated.png` | Product deactivated state | inventoried |
| `P7-fractional-sale.png` | Fractional-quantity sale (kg) | inventoried |
| `I1-invoices-company-required.png` | Invoices tab with no shop details yet | inventoried |
| `I2-company-profile.png` | Company profile / settings | ✅ depth |
| `I3-invoice-draft.png` | Outgoing invoice draft | inventoried |
| `I4-finalize-confirm.png` | Finalize confirmation (normal modal) | inventoried |
| `I5-finalized-notice.png` | Post-finalize notice | inventoried |
| `I6-review-queue.png` | Reconciliation queue | ✅ depth |
| `I7-finalized-readonly.png` | Finalized invoice, read-only | ✅ depth |
| `I8-resolve-price.png` | Reconciliation: resolve price difference | inventoried |
| `I9-resolve-not-found.png` | Reconciliation: product not found | inventoried |
| `I10-frozen-reopened.png` | Finalized invoice reopened (frozen snapshot) | inventoried |
| `D1-draft-filled.png` | Invoice draft, header + 2 rows filled | inventoried |
| `D2-draft-saved.png` | Draft saved, full action row visible | ✅ depth |
| `D3-drafts-list.png` | Drafts list, populated | ✅ depth |
| `D4-draft-reopened.png` | Saved draft reopened, values persisted | inventoried |
| `D5-discard-confirm.png` | Discard confirmation (destructive modal) | inventoried |
| `D6-drafts-empty.png` | Drafts list, EMPTY state | inventoried |
| `upgrade-a1-old-v2.png` … `upgrade-f-two-rows.png` (16 files) | Upgrade provenance, schema v2 → v6 → this build | inventoried |

**Total: 49 states.**

### States NOT captured

No screenshot exists for these, and local Electron rendering is unavailable in the audit
environment (the renderer segfaults there), so they were **not reviewed**:

- input-mode chooser (outgoing vs incoming) — SOURCE-DERIVED analysis only, see §11
- incoming-invoice / catalog-intake placeholder
- Tools screen (Catalog / Backup / About)
- Backup & recovery UI
- startup-failure / error / recovery states
- validation-error states
- tax-ON invoice UI (tax-on exists only in the PDF samples, not the app UI)
- disabled-state gallery

---

## The single structural finding: two generations of UI

Measured, not impressions — counted across `src/renderer/screens/`:

| Screen | `t()` calls | `<bdi>` / `dir="ltr"` |
|---|---|---|
| `SellScreen` `TodayScreen` `HistoryScreen` `LoginScreen` `ToolsScreen` `Receipt` | **0** | **0** |
| `ProductsScreen` | 35 | 3 |
| `CompanyProfileForm` | 51 | 11 |
| `InvoiceSheet` | 81 | 34 |
| `ReconciliationQueue` | 49 | 9 |
| `InvoiceHistory` | 18 | 9 |

The six files with zero translation are the same six with zero bidi isolation, and they are the
cashier's entire daily path: Login → Sell → Today → History → Tools (which holds Backup) → Receipt.
**The least finished screens are the most used ones.** The newer invoice/products work is fully
bilingual and bidi-safe, so the fix is to apply an existing in-repo pattern, not to invent one.

---

## Top 10 UX problems

| # | Severity | Problem | Evidence |
|---|---|---|---|
| 1 | **P0** | Cashier's daily path is English-only in an Arabic shop ("Current sale", "Net sales", "Enter PIN") while the nav renders Arabic. Violates the standing rule in `i18n.ts`: *"a new screen is bilingual on its first commit."* | `01-login.png` `02-cart.png` `05-today.png` `06-void-dialog.png` |
| 2 | **P0** | Bidi corruption on those same screens — 7 visible instances: `.Record how the customer paid` · `.The sale stays in the ledger` · `PM 6:25:23 ,10/9/2026` · `61#` · `USD 0.00 −` · `0 صنفاً ٠٠ معروض` · `للفحص· E2E Test Store`. A mangled timestamp inside a **void** dialog is the worst case. | `03-payment.png` `06-void-dialog.png` `05-today.png` `I6-review-queue.png` `P1-products-arabic-empty.png` `I7-finalized-readonly.png` |
| 3 | **P0** | Company profile has two independent saves that look like one (`company-save` primary, `company-numbering-save` secondary and gated on the first). The E2E's own comment records this fooled the test author and left the sequence at 1. | `I2-company-profile.png` |
| 4 | P1 | Invoice action row = 5 buttons + a status text, with "حُفظت المسودّة" wedged between buttons where it reads as a disabled one. Save-draft and Save-and-leave look identical; Discard sits beside a save at equal size. | `D2-draft-saved.png` |
| 5 | P1 | The invoice sheet does not fit the 1008×681 window — the operator scrolls between the customer header and the totals/actions. | `D2-draft-saved.png` `I2-company-profile.png` `I7-finalized-readonly.png` |
| 6 | P1 | Destructive actions carry equal or greater weight than primary ones: `Clear cart` full-width under `Complete sale`; two filled dark-red `Void` blocks dominate a lookup screen; cart line-delete `×` identical to `+`/`−`. | `02-cart.png` `06-void-dialog.png` |
| 7 | P1 | Payment has no default and no keyboard path — four identical buttons, though cash is most of a shop's volume. | `03-payment.png` |
| 8 | P1 | Login offers no language toggle; the control lives in the post-login shell, so an Arabic-only cashier's first screen is English with no way to change it. | `01-login.png` |
| 9 | P2 | Empty states name the action but don't offer it ("أضف أوّل صنف" while the button sits at the opposite corner). | `P1-products-arabic-empty.png` `D6-drafts-empty.png` |
| 10 | P2 | Finalized invoices still look editable — every field is a bordered input; the only cue is a banner that scrolls away. | `I7-finalized-readonly.png` |

---

## Top 10 visual inconsistencies

| # | Inconsistency | Evidence |
|---|---|---|
| 1 | Two UI generations with a hard boundary (see table above) | measured in source |
| 2 | Two brand names: **"Alzabt POS"** vs **"صندوق الزبط"** | `01-login.png` vs `02-cart.png` |
| 3 | Two date formats in one feature: `2026-10-09` vs locale-ambiguous `10/08/2026` | `D3-drafts-list.png` vs `I7-finalized-readonly.png` |
| 4 | Two blue primaries on one screen (`+ أضف سطراً` and `إصدار الفاتورة`) | `D2-draft-saved.png` |
| 5 | Ad-hoc badges — grey `manual`, green `Active`, amber `0.001`, black `صادرة`, amber `فاتورة`; `0.001` is unlabelled and cryptic | `P5-products-english-ltr.png` `I7-finalized-readonly.png` |
| 6 | Raw enum leakage: uppercase English `PENDING` in a fully-Arabic table | `I6-review-queue.png` |
| 7 | Navigation pills and filter pills share one style, so "where am I" and "what am I filtering" look identical | `I6-review-queue.png` `D3-drafts-list.png` |
| 8 | Double borders — bordered table cells containing bordered inputs | `D2-draft-saved.png` `I7-finalized-readonly.png` |
| 9 | Primary actions land at the far-left (last-read) edge in RTL; the review count badge is stranded from its heading | `P1-products-arabic-empty.png` `D3-drafts-list.png` `I6-review-queue.png` |
| 10 | Density is wildly uneven — Today's Sales uses ~30% of the window; the invoice sheet overflows it | `05-today.png` vs `D2-draft-saved.png` |

---

## Top 5 quick wins

1. Wrap every number, date, SKU and currency in `<bdi>` on the six older screens. The pattern already exists in `invoiceDocument.ts` (23 uses) — copy it. Kills all 7 corruption instances.
2. Move the ~25 hardcoded strings into `i18n.ts`; the dictionary and `t()` already exist.
3. Separate `Clear cart` from `Complete sale` — demote to a text button away from the primary.
4. Make the two company saves honest — one save, or label the numbering one and give it its own section.
5. Give the payment modal a default: emphasise Cash, bind Enter.

## Needs deeper redesign

Invoice sheet layout (sticky actions, collapsible customer header) · Sales History as lookup-first with void demoted to a row menu · Today's Sales as a glanceable day with date navigation · Product form sections · Invoices IA (two pill rows doing different jobs).

---

## Proposed navigation

Keep the six tabs — they map to real jobs. Two changes:
- Move **بيانات المتجر** out of الفواتير into **أدوات**; it is configuration, not a document.
- Give **أدوات** a real, translated screen. It holds Backup & Recovery, the highest-stakes unreviewed surface in the product.

## Design-system primitives (desktop POS, offline — NOT a SaaS dashboard)

```
Type      3 sizes: 24 heading · 15 body · 13 muted. One family, Arabic-first metrics.
Space     4/8/16/24. One gutter (16) everywhere.
Buttons   4 roles only: primary (one per screen) · default · ghost · danger.
          danger is FILLED only inside a confirm dialog; in rows/toolbars it is ghost-danger.
Inputs    one bordered style; read-only = borderless text, never a greyed input.
Tables    single-border grid, no inner input borders, row actions in a trailing menu.
Badges    3 only: state · warning · identity. Always labelled.
Modals    max 560px, body scrolls, actions pinned; confirm dialogs name the object.
Bidi      <bdi> mandatory for every number/date/code/currency. Lint it.
Focus     one visible ring token (the gold ring already in use) on every control.
```

## Future Product Form — SPEC ONLY, NOT IMPLEMENTED

The current form is 5 flat fields and already fills the window (`P2-add-product-arabic.png`).
With Product Master's fields it must become sectioned, inside a fixed modal whose body scrolls:

```
┌ معلومات أساسية ─────────────────┐   always open
│ الاسم بالعربية* │ الاسم بالإنجليزية │
│ الباركود        │ SKU              │
│ الفئة           │ العلامة          │
├ البيع ──────────────────────────┤   always open
│ الوحدة*         │ سعر البيع*       │
│ سلوك الضريبة                     │
├ إضافي ▾ ────────────────────────┤   collapsed by default
│ صورة · ملاحظات · حقول المتجر     │
└─────────────────────────────────┘
        [ إلغاء ]            [ حفظ ]
```

Requiredness stays **in the label** — `(مطلوب)`/`(اختياري)` — which the current form already does
well. Visibility/requiredness come from settings. **No dynamic database columns**, per the recorded
decision.

## Outgoing invoice UX

| Control | Verdict |
|---|---|
| Add Row | ✅ Keep — explicit, large, with a row count. The field complaint is genuinely fixed. |
| Save Draft / Leave Draft | Merge into one `حفظ` plus a separate `خروج`. |
| Discard | Out of the save cluster; ghost-danger at the far edge. |
| Customer fields | Collapse to a one-line summary once filled, to buy vertical space. |
| Invoice date | Replace the locale-ambiguous native picker with the `YYYY-MM-DD` used in the drafts list. |
| Tax controls | Move beside the totals, where the effect appears. |
| Totals | Hide the duplicate subtotal row when tax is off (today it shows the same number twice). |
| Amount-in-words | Hide the empty panel on drafts (~80px of dead space). |
| Finalize | ✅ Keep — the confirm dialog is correct. |
| Reconciliation | Translate `PENDING`; attach the count badge to its heading. |
| Print / reprint | ✅ Keep. |

**The printed PDF is out of scope and was not re-reviewed** — it is stabilised and separately
approved. Application UX and printed-document design are kept apart deliberately.

---

## §11 · Incoming vs outgoing differentiation

⚠️ **SOURCE-DERIVED — NOT VISUALLY VERIFIED.** No screenshot of the chooser exists.

From `InvoicesScreen.tsx:119-142` and `i18n.ts:178-184`: the chooser is modal and unskippable, and
names each mode by its **consequence** rather than its label —

- outgoing: *"فاتورة للزبون. تُنشئ عمليّةَ بيعٍ وتظهر في السجلّ، وتُطبَع للزبون."*
- incoming: *"نسخُ فاتورةِ مورّدٍ لتحديث الأصناف. ليست عمليّةَ بيع، ولا تدخل مبيعاتِ اليوم."*

Incoming is `disabled` and carries an explicit "not built in this release" notice. The choice then
**persists on the document as a badge**, which IS visually verified (`I7-finalized-readonly.png`
shows `صادرة`, and the draft E2E asserts *"the sheet names its mode on screen (صادرة)"*).

**Verdict: strong.** One risk — the badge is a single word. When intake ships, give the two modes
different **colour and icon**, not just text, and keep the consequence line on the sheet rather than
only in the chooser.

---

## Phased roadmap

| Phase | Scope |
|---|---|
| 1 | Quick wins 1–5. Removes all 7 bidi corruptions and the English leakage on the cashier's path. |
| 2 | Button-role system + destructive demotion across cart, history, invoice actions. |
| 3 | Invoice sheet layout: sticky actions, collapsible header, tax beside totals. |
| 4 | Tools/Backup screen + Today's Sales redesign. |
| 5 | Product form sections, as Product Master lands. |

## Requires a real shop field test

- Whether the invoice sheet's scrolling actually costs time at the counter, or operators adapt.
- Whether the five-button action row causes a real mis-click (Discard beside Save).
- Whether cash-by-default and an Enter binding match the shop's rhythm.
- Whether `صادرة` alone is enough once intake exists.
- **Tools/Backup and all error/recovery states** — unreviewed here, unreachable without the
  installed app.
