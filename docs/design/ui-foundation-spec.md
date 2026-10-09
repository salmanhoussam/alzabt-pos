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
exists to stop new screens from growing the page instead of a region.

**Acceptance:** every screen keeps its primary action reachable without scrolling the page shell;
long forms may scroll inside their designated content region while their action bar remains
visible.

---

## 2 · Typography

Current state: `font-family: "Segoe UI", system-ui, sans-serif` and **no `line-height` anywhere**,
so Arabic renders at the browser default (~1.2) — too tight for diacritics and descenders.

```
--font-ui        "Segoe UI", Tahoma, system-ui, sans-serif
--leading-body   1.50     /* default UI body text */
--leading-ar     1.62     /* Arabic text / Arabic container */
--leading-tight  1.25     /* headings, single-line numerics */
```

Which applies where:

| Context | Token |
|---|---|
| default UI body | `--leading-body` |
| Arabic text or an Arabic container | `--leading-ar` |
| headings, single-line numerics | `--leading-tight` |

1.65 across all body text is too generous for a 681px-tall POS, so English body sits at 1.50 and
only Arabic gets the extra room it actually needs.

🔴 **This is only correct if the language is declared, not implied.** The root or container must
carry **`lang="ar"` / `lang="en"` together with `dir`** — setting direction alone is cosmetic and
leaves the browser guessing at font selection and line breaking. `--leading-ar` applies via
`:lang(ar)`, not via a class someone remembers to add.

```
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

Add semantic status, four meanings only. **Colour must not lie about business state:**

| Status | Means |
|---|---|
| `neutral` | informational · draft · ordinary state |
| `success` | active · completed · paid |
| `warning` | pending · needs attention · partial · **unpaid where payment is legitimately outstanding** |
| `danger` | failed · destructive · voided · irreversible error |

🔴 **`unpaid` is NOT danger.** On an invoice an unpaid balance is frequently a perfectly correct
commercial state, not an error. Painting it red tells the operator something false.

**Why this is needed now:** `.badge` is one hardcoded amber (`#fff3cd` / `#8a5a00`), which is why
"manual", "Active", "0.001", "صادرة", "فاتورة" and `PENDING` all read as the same kind of thing.

### The palette already exists — it is just anonymous

Nothing below is invented. Every value is either already shipped in `styles.css` or derived from a
shipped value by tinting it toward `--surface`. The stylesheet already contains **three** warning
text colours (`#8a5a00`, `#b54708`, `#7c2d12`) and **three** warning surfaces (`#fff3cd`,
`#fffbe6`, `#fde68a`); naming them is what collapses that.

It also references **five tokens that are never declared** — `--card`, `--line`, `--ink`,
`--thead`, `--hl` — so every use silently falls back to a hardcoded literal, and
`var(--line, #d9dce1)` duplicates `--border`'s exact value **11 times**. Declaring them as aliases
makes the vocabulary real without rewriting a single reference.

```css
:root {
  /* ── the 9 shipped tokens, unchanged ─────────────────────────────── */
  --bg: #f4f5f7;
  --surface: #ffffff;
  --text: #1c1f24;
  --muted: #6b7280;
  --border: #d9dce1;
  --primary: #1f5eff;
  --primary-text: #ffffff;
  --danger: #c62828;
  --radius: 10px;

  /* ── two real surfaces, lifted from existing fallback literals ───── */
  --surface-sunken:    #f1f3f5;   /* was var(--thead, #f1f3f5) — table head, inset panel */
  --surface-highlight: #fffbe6;   /* was var(--hl,    #fffbe6) — the row being entered */

  /* ── the 5 phantom tokens, now declared as aliases ───────────────── */
  --card:  var(--surface);        /* was var(--card, #fff) */
  --line:  var(--border);         /* was var(--line, #d9dce1), 11 hardcoded copies */
  --ink:   var(--text);           /* was var(--ink,  #111) */
  --thead: var(--surface-sunken);
  --hl:    var(--surface-highlight);

  /* ── semantic status ─────────────────────────────────────────────── */
  --status-neutral:      var(--surface-sunken);
  --status-neutral-text: var(--text);        /* NOT --muted — see the contrast table */

  --status-success:      #eef5ef;            /* derived: #2e7d32 at 8% over --surface */
  --status-success-text: #2e7d32;            /* shipped today in .badge.ok */

  --status-warning:      #fff3cd;            /* shipped today in .badge */
  --status-warning-text: #8a5a00;            /* shipped today in .badge */

  --status-danger:       #faeeee;            /* derived: #c62828 at 8% over --surface */
  --status-danger-text:  var(--danger);      /* #c62828 */

  /* ── muted text on anything other than --surface ─────────────────── */
  --muted-strong: #656c79;        /* --muted fails AA off white — see the contrast table */

  /* ── elevation ───────────────────────────────────────────────────── */
  --shadow-dialog: 0 12px 32px rgba(28, 31, 36, 0.18);   /* --text's hue, not pure black */
}
```

`.notice`'s existing blue pair (`#eef6ff` surface, `#bcd8f7` border) stays as its own **info
banner** component. It is deliberately **not** folded into the badge statuses — a banner and a badge
are different objects, and collapsing them would invent a fifth status.

### Contrast, measured (WCAG 2.1; normal text needs ≥ 4.5:1)

| Pair | Ratio | |
|---|---|---|
| `--status-warning-text` on `--status-warning` (both shipped) | **5.35** | ✅ |
| `--status-success-text` on `--status-success` (derived 8%) | **4.63** | ✅ |
| `--status-danger-text` on `--status-danger` (derived 8%) | **4.96** | ✅ |
| `--status-neutral-text` on `--status-neutral` | **14.86** | ✅ |
| `--text` on `--surface` | 16.52 | ✅ |
| `--muted` on `--surface` | 4.83 | ✅ |
| 🔴 `--muted` on `--bg` | **4.43** | ❌ below AA |
| 🔴 `--muted` on `--surface-sunken` | **4.35** | ❌ below AA |
| `--muted-strong` on `--surface-sunken` | **4.75** | ✅ |

The 8% tint was chosen by measurement, not taste: at 10% the success pair falls to 4.49 — on the
line — while 6% is barely a tint. 8% clears AA on both derived surfaces with headroom.

🔴 **A real defect this check found, needing Salman's decision.** `--muted: #6b7280` passes AA only
on white. Muted hints render on `--bg` today (the products search hint, the item count, empty
states), where it measures **4.43:1 — below AA**. Two ways out:

| Option | Effect |
|---|---|
| **A — add `--muted-strong: #656c79`** (as written above) | Non-breaking; `--muted` keeps its shipped value; but it leaves a rule to remember — muted text on anything other than `--surface` must use `--muted-strong`. |
| **B — change `--muted` itself to `#656c79`** | One value, no rule to remember, fixes every existing use at once, visually near-identical. **But it edits one of the 9 shipped tokens**, which the brief said to leave exactly as shipped. |

**Recommendation: B.** A rule that depends on knowing which ground you are standing on is exactly
the kind that gets forgotten on the next screen — the failure this foundation exists to prevent.
Flagged rather than taken, because it contradicts a stated constraint.

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
| `btn selected` | state, not a role — keep, but move its `outline` to the focus token (§9) |

**One dominant primary action per visible interaction context.** A screen has one; a modal opened
over it has its own, independent of the screen behind it. The invoice sheet currently has two blue
primaries in the same context (`+ أضف سطراً` and `إصدار الفاتورة`); `+ أضف سطراً` becomes `default`.

**`ghost-danger` is a variant of `danger`, not a fifth role.** The system stays at 4 roles.

---

## 7 · Badge roles — 3

```
state       neutral or success — what something IS (Active, Completed, صادرة)
warning     amber — what needs attention (price?, pending, needs review)
identity    solid — what KIND of document this is (صادرة / واردة once intake exists)
```

Every badge carries a **label or a title**, never a bare value. `0.001` next to `kg` is the current
counter-example: it is the fractional step with no indication of that.

Per §5, **`partial` and `unpaid` are `warning`, never `danger`** — an outstanding balance is a
commercial state, not a failure.

---

## 8 · Dialogs

The app deliberately uses in-app overlays, never `window.confirm` — a native dialog carries no
`data-testid`, and in some embeddings `window.confirm` returns false immediately, which would make
a destructive action silently do nothing. That decision stands and is not revisited here.

**Confirm dialog** — one shape for every destructive confirmation:

```
title      names the OBJECT, not the verb alone   («حذف المسودّة» + which draft)
body       states the CONSEQUENCE in one line     (what survives, what does not)
actions    [ danger-filled confirm ]  [ default cancel ]     cancel is never danger
reason     a required field where the ledger records one (void already does this)
```

`06-void-dialog.png` is the reference implementation: red filled confirm, neutral cancel, required
reason, visible focus. It is the pattern to copy.

**Unsaved-changes dialog** — decided by Salman, 2026-10-09, and standardised here because the
invoice sheet is not the only screen that needs it (the product form will too):

```
no unsaved changes  →  exit immediately, no dialog, no pause
unsaved changes     →  حفظ والخروج   (primary)
                       الخروج بدون حفظ   (ghost-danger — it discards work)
                       إلغاء          (default, returns to the screen)
```

🔴 **Never an always-silent save on exit.** A silent save is fast but it hides a decision the
operator did not make; an unconditional prompt is honest but punishes the common case, which is
leaving a screen that has not changed. Branching on dirty state gives both.

`الخروج بدون حفظ` is **ghost-danger, not filled** — per §6 it sits in an action row, not as the
confirm of a destructive dialog, and it must not out-weigh `حفظ والخروج`.

**Keyboard mechanics — not accessibility luxury.** The cashier path is keyboard-heavy, and a dialog
that opens with the destructive button focused will eventually destroy something because the
operator was still pressing Enter.

```
Destructive confirm
  initial focus   = Cancel / the safe action
  Enter           = must NOT trigger destruction merely because the dialog opened
  Esc             = Cancel

Unsaved changes
  initial focus   = حفظ والخروج
  Esc             = إلغاء

Every modal
  focus is TRAPPED inside the dialog while it is open
  focus is RESTORED to the invoking control after it closes
```

**Dialog mechanics:** max width 560px, body scrolls while the action row stays visible, and the
title is a real `<h2>` so the dialog is announced.

---

## 9 · Focus

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

🔴 **Semantic controls, not styled divs.** Anything that behaves like a button, card or row must be
keyboard-focusable using the correct semantic element wherever possible; focus styling must never be
used to disguise a non-interactive `<div>` as an interactive control. A product card should be a
`<button>` — not a `<div>` with `tabindex` — unless there is a real reason it cannot be.

---

## 10 · Bidi isolation — the rule

> **Bidi isolation is mandatory for every structured LTR run: number, amount, currency, date/time,
> phone number, invoice number, SKU/barcode/code, percentage, and identifier. Use `<bdi>` for
> rendered text; use `dir="ltr"` / appropriate bidi CSS for form controls and editable values.**

**Isolate the whole run, not each fragment.** `#61` and `15.50 USD` are each one run and get wrapped
once; wrapping the digits while leaving the `#` or the currency outside is what produced `61#` and
`USD 0.00 −` in the first place.

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

## 11 · Strings to translate

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

- **Brand — decided (Salman, 2026-10-09).** `Alzabt POS` is the **product/brand name** and stays
  fixed in login, footer, About, the installer and every identity surface — it is not translated.
  `صندوق الزبط` is the **Arabic label/translation inside the interface**. There are not two
  competing identities. Practically: the brand string is a constant, NOT an i18n key; the in-app
  Arabic label IS a key.
- **`PENDING`** is a raw enum reaching the UI. It becomes a translated status badge; the enum value
  in the ledger does not change.

---

## 12 · Duplicated selectors to resolve

Five selectors are defined twice in 263 lines:

| Selector | Problem |
|---|---|
| `.small` | `font-size: 12px` (`:122`) **and** `.85rem` (`:249`) — later wins, so sizes depend on source order. Resolve to `--text-small`. |
| `.badge` | two definitions; resolve to the 3 badge roles (§7) |
| `.field.inline` | two definitions; keep one |
| `table.inv-lines` | two definitions; keep one |
| `table.inv-lines td.row-actions` | two definitions; keep one, at `--control-h-small` |

Developer sanity check:
`grep -oE "^[.#a-zA-Z][^{]*\{" src/renderer/styles.css | sed 's/ *{$//;s/ *$//' | sort | uniq -d`

🔴 **The grep is a developer check, not release evidence.** It is a regex, not a CSS parser: it will
miss a multiline selector, a selector inside a media rule, and a duplicate differing only in
whitespace. If duplicate-selector detection ever becomes a CI gate, implement it with a CSS
parser/test **and a positive control proving the check detects a known duplicate** — this project
has already shipped two blind probes that passed while measuring nothing.

---

## 13 · What this spec does NOT do

- It does not redesign any screen. Layout decisions belong to the per-group specs.
- It does not touch the invoice **PDF** — stabilised and separately approved.
- It does not add a component library, a CSS framework, or a build step.
- It does not rename an existing token or shrink an existing control.
- This specification changes no runtime code or schema by itself. Its eventual implementation is
  limited to the explicitly approved presentation and interaction behaviour described here.

## Acceptance for this spec

1. Salman reviews and approves, or amends, **before the Sell + Payment mockup is drawn.**
2. On implementation: `npm run typecheck` and the full suite stay green; the duplicate-selector
   grep prints nothing; the 7 bidi corruptions are re-shot and visibly correct; no screen scrolls
   horizontally at 1008×681.
3. Acceptance is **visual/checklist based, not a pixel-perfect diff** — the design is changing on
   purpose.
4. **Status/background/text combinations must meet readable contrast, and no status may rely on
   colour alone** — every status carries a label or a title as well.
5. **A keyboard review of the cashier path must prove visible focus and a logical tab order**,
   including dialog initial focus, focus trap and focus restoration.
