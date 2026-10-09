# UI Foundation Spec — Alzabt POS

**Status:** specification awaiting review. **No code written against it yet.**
**Baseline:** `f090ad9` · `src/renderer/styles.css` (263 lines) · `src/shared/i18n.ts`
**Purpose:** settle the decisions every screen would otherwise invent for itself, so screen designs
are drawn on a known base rather than negotiating spacing and button weight five more times.

**Principle:** this is an **extension of what exists**, not a replacement. All 9 current tokens keep
their names. Control sizes that already work are codified, not shrunk. This is a desktop POS used
quickly by one operator — not a web dashboard.

---

## 1 · Minimum viewport and overflow

The audited window is **1008×681**, which is what the installed app actually opens at.

```
MINIMUM REVIEW VIEWPORT   1008 × 681
HORIZONTAL PAGE SCROLL    never — the page body must not scroll sideways at any width ≥ 1008
VERTICAL SCROLL           only inside designated containers, never the page shell
```

Designated scroll regions, and nothing else:

| Region | Already scrolls today |
|---|---|
| product grid (`.products`) | ✅ `overflow: auto` |
| main content area (`.content`) | ✅ `overflow: auto` |
| invoice lines table | — to be defined per screen |
| modal body | — to be defined per screen |

`.app` is `height: 100vh` and `.content` owns the scroll, so the shell is already correct; the rule
exists to stop new screens from growing the page instead of a region. **Acceptance:** at 1008×681
every screen shows its primary action without scrolling to find it.

---

## 2 · Typography

Current state: `font-family: "Segoe UI", system-ui, sans-serif` and **no `line-height` anywhere**,
so Arabic renders at the browser default (~1.2) — too tight for diacritics and descenders.

```
--font-ui      "Segoe UI", Tahoma, system-ui, sans-serif
--leading-ar   1.65     /* body text, both languages */
--leading-tight 1.25    /* headings and single-line numerics only */
```

🔴 **Offline only — no web fonts, ever.** This is an offline-first POS; a Google Fonts link would
be a blocked request and a silent fallback. `Tahoma` is added after `Segoe UI` because it is
present on every Windows install and has sturdier Arabic metrics as a fallback.

Type scale — three sizes, no others:

```
--text-h      24px   screen titles, dialog titles
--text-body   15px   everything the operator reads
--text-small  13px   hints, captions, muted notes
```

Numerics that line up in a column use `font-variant-numeric: tabular-nums` (totals, price columns,
quantity fields). Digits stay 0-9 in both languages — already the standing rule in `i18n.ts`.

**This replaces** the two conflicting `.small` definitions (§10).

---

## 3 · Spacing

```
--space-1  4px    inside a control, icon-to-label
--space-2  8px    between related controls, button gaps
--space-3  16px   between groups, page gutter, card padding
--space-4  24px   between sections, dialog padding
```

One page gutter everywhere: `--space-3`. Existing `gap: 12px` / `padding: 14px` / `gap: 6px` values
are rounded onto the scale during implementation; no screen invents a fifth value.

---

## 4 · Control height and hit target

Codified from what already works — **do not shrink these**:

```
--control-h        48px   buttons, tabs, inputs, selects          (today: .btn, .tab, .search)
--control-h-big    64px   the one primary action on a screen      (today: .btn.big)
--control-h-key    56px   keypad / qty steppers                   (today: .btn.key)
--control-h-small  36px   row actions inside a dense table        (NEW — the only addition)
```

Minimum hit target is **36×36**; anything smaller is not allowed, including icon-only buttons. A
cashier works fast with a mouse, and 48px default is deliberate.

`--control-h-small` exists because row actions in the invoice lines table and the products table
currently use full 48px buttons, which is what makes those rows ~90px tall.

---

## 5 · Colour and semantic status

Keep all 9 existing tokens unchanged: `--bg --surface --text --muted --border --primary
--primary-text --danger --radius`.

Add semantic status, four meanings only, each with a surface and a text tone so a badge or a notice
can be built from the pair:

```
--status-neutral      / --status-neutral-text      informational, no judgement
--status-success      / --status-success-text      done, active, paid
--status-warning      / --status-warning-text      needs attention, pending, placeholder
--status-danger       / --status-danger-text       destructive, failed, unpaid   (reuses --danger)
```

Plus two support tokens:

```
--surface-sunken   table header / inset panel ground
--shadow-dialog    the single elevation used by modals
```

**Why this is needed now:** `.badge` is currently one hardcoded amber (`#fff3cd` / `#8a5a00`), which
is why "manual", "Active", "0.001", "صادرة", "فاتورة" and `PENDING` all read as the same kind of
thing. Without named statuses, each new screen picks a colour by eye.

---

## 6 · Button roles — 4, and only 4

```
primary     one per screen. The thing the operator came to do.
default     ordinary actions.
ghost       low-emphasis, repeated, or in-row actions.
danger      destructive.
```

**The danger rule:** `danger` is **filled only inside a confirm dialog**. In a row, a toolbar or an
action bar it is **ghost-danger** (danger text/border, no fill). This is what stops two large red
`Void` blocks from dominating a lookup screen, and what separates `حذف المسودّة` from a save.

Mapping of the 14 combinations found in the renderer:

| Today | Becomes |
|---|---|
| `btn primary`, `btn primary wide`, `btn primary big wide` | `primary` (+ size/width modifier) |
| `btn`, `btn wide`, `btn big` | `default` |
| `btn ghost`, `btn ghost wide`, `btn ghost small` | `ghost` |
| `btn danger` | `danger` **only in a dialog**; otherwise `ghost-danger` |
| `btn danger ghost` | `ghost-danger` (already correct) |
| `btn key` | keypad/stepper variant of `ghost`, at `--control-h-key` |
| `btn primary small`, `btn small` | `--control-h-small` variants |
| `btn selected` | state, not a role — keep, but move its `outline` to the focus token (§8) |

**One primary per screen.** The invoice sheet currently has two blue primaries (`+ أضف سطراً` and
`إصدار الفاتورة`); `+ أضف سطراً` becomes `default`.

---

## 7 · Badge roles — 3

```
state       neutral or success — what something IS (Active, Completed, صادرة)
warning     amber — what needs attention (price?, pending, needs review)
identity    solid — what KIND of document this is (صادرة / واردة once intake exists)
```

Every badge carries a **label or a title**, never a bare value. `0.001` next to `kg` is the current
counter-example: it is the fractional step with no indication of that.

---

## 8 · Focus

There is **no focus styling today**; the ring seen in the screenshots is Chromium's default and
would disappear the moment anyone writes `outline: none`.

```
--focus-ring   2px solid var(--primary)
--focus-offset 2px
```

Applied via `:focus-visible` to **every** interactive element — button, input, select, tab, table
row action, product card. A control that cannot show focus cannot be used from the keyboard, and
the cashier path is keyboard-heavy.

`.btn.selected`'s `3px solid var(--primary)` outline is a **selection** state and must stop using
`outline`, so selection and focus remain distinguishable.

---

## 9 · Bidi isolation — the rule

> **Bidi isolation is mandatory for every number, date, code, SKU and currency. Use `<bdi>` for
> rendered text; use `dir="ltr"` / appropriate bidi CSS for form controls and editable values.**

Stated this way because `<bdi>` cannot live inside an `<input>`, a `<select>` or any other control
whose value is not a text node — a blanket "`<bdi>` everywhere" rule would be impossible to
satisfy in exactly the places that already fail.

The pattern already exists in-repo: `invoiceDocument.ts` (23 `<bdi>`, 29 `dir="ltr"`) and
`InvoiceSheet.tsx` (8 / 26). Copy it; do not invent one.

**Acceptance set — all 7 must be re-shot and visibly correct:**

| # | Corruption | Where | Screenshot |
|---|---|---|---|
| 1 | `.Record how the customer paid…` — period moved to front | payment modal | `03-payment.png` |
| 2 | `.The sale stays in the ledger…` | void dialog | `06-void-dialog.png` |
| 3 | `PM 6:25:23 ,10/9/2026` — timestamp scrambled | sale history | `06-void-dialog.png` |
| 4 | `61#` instead of `#61` | reconciliation | `I6-review-queue.png` |
| 5 | `USD 0.00 −` — minus trailing | today's sales | `05-today.png` |
| 6 | `0 صنفاً ٠٠ معروض` — count unreadable | products | `P1-products-arabic-empty.png` |
| 7 | `للفحص· E2E Test Store` — separator collapsed | finalized invoice | `I7-finalized-readonly.png` |

#3 is the most serious: the operator is confirming a **destructive** act against an unreadable time.

---

## 10 · Strings to translate

Enumerated from the six files with zero `t()` calls. **60 user-visible literals**, collapsing to
roughly 50 distinct keys since `Total`, `Loading…` and `Cancel` recur.

🔴 **This corrects the audit's estimate of "~25".** The audit counted JSX text nodes; this count
includes `aria-label`, `title` and `placeholder` attributes, which are user-visible too — an
`aria-label="Remove"` is what an Arabic screen-reader user hears.

| Screen | Count | Literals |
|---|---|---|
| `LoginScreen` | 4 | `Alzabt POS` · `Select cashier` · `Enter PIN` · aria `PIN` |
| `SellScreen` | 18 | `Current sale` · `Total` · `Tap a product to add it.` · `Complete sale` · `Clear cart` · `No product matches “{query}”.` · `Payment — {total} {currency}` · `Record how the customer paid. No payment is processed here.` · `Back to cart` · `Cash` · `Card (external terminal)` · `External transfer` · `Other` · aria `Decrease`/`Increase`/`Remove` · title `Placeholder price — set the real price` · badge `price?` |
| `TodayScreen` | 8 | `Today's Sales — {date}` · `Completed sales` · `Voided sales` · `Gross sales` · `Voids` · `Net sales` · `Refresh` · `Loading…` |
| `HistoryScreen` | 22 | `Sale history` · `Time` · `Cashier` · `Payment` · `Total` · `Balance due` · `Status` · `No sales yet.` · `Loading…` · `Void` · `View` · `Void receipt #{n} — {amt}` · `The sale stays in the ledger; a separate void record is added` · `Reason` · placeholder `e.g. wrong item rung up` · `Confirm void` · `Cancel` · `Completed` · `Voided` · `Unpaid` · `Paid — {method}` · title `Invoice cancellation / credit-note workflow is not implemented yet` |
| `ToolsScreen` | 5 | `Catalog` · `Backup` · `About` · `Version` · `Build` |
| `Receipt` | 3 | `Sale completed` · `Total` · `Paid by` |

Both `AR` and `EN` blocks already exist in `i18n.ts` (lines 46 and 255). Per the file's own standing
rule, **a key with no Arabic is a missing text, not a neutral default** — `t()` returns the key
itself, so an untranslated key is loudly visible in review.

Two naming decisions to settle while doing this:

- **Brand:** the app is `Alzabt POS` on login and in the footer, `صندوق الزبط` in the title bar.
  One of these is the name; the other is a translation of it. **Needs Salman's answer** — it is a
  branding call, not a UI one.
- **`PENDING`** is a raw enum reaching the UI. It becomes a translated status badge; the enum value
  in the ledger does not change.

---

## 11 · Duplicated selectors to resolve

Five selectors are defined twice in 263 lines:

| Selector | Problem |
|---|---|
| `.small` | `font-size: 12px` (`:122`) **and** `.85rem` (`:249`) — later wins, so sizes depend on source order. Resolve to `--text-small`. |
| `.badge` | two definitions; resolve to the 3 badge roles (§7) |
| `.field.inline` | two definitions; keep one |
| `table.inv-lines` | two definitions; keep one |
| `table.inv-lines td.row-actions` | two definitions; keep one, at `--control-h-small` |

Mechanical check to keep it fixed:
`grep -oE "^[.#a-zA-Z][^{]*\{" src/renderer/styles.css | sed 's/ *{$//;s/ *$//' | sort | uniq -d`
must print nothing.

---

## 12 · What this spec does NOT do

- It does not redesign any screen. Layout decisions belong to the per-group specs.
- It does not touch the invoice **PDF** — stabilised and separately approved.
- It does not add a component library, a CSS framework, or a build step.
- It does not rename an existing token or shrink an existing control.
- It changes no schema and no behaviour.

## Acceptance for this spec

1. Salman reviews and approves, or amends, **before the Sell + Payment mockup is drawn.**
2. On implementation: `npm run typecheck` and the full suite stay green; the duplicate-selector
   grep prints nothing; the 7 bidi corruptions are re-shot and visibly correct; no screen scrolls
   horizontally at 1008×681.
3. Acceptance is **visual/checklist based, not a pixel-perfect diff** — the design is changing on
   purpose.
