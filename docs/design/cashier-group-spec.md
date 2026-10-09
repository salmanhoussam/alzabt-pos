# Today + History + Receipt — group spec

**Status:** design only. No product code. **Baseline:** `f090ad9`
**Proofs:** `proposed-today.png` · `proposed-today-empty.png` · `proposed-history.png` ·
`proposed-void.png` · `proposed-receipt.png` — all exactly 1008×681.
**Current:** `05-today.png` · `07-history.png` · `04-receipt.png` · `06-void-dialog.png`

Throughout: **APPROVED EXISTING PRODUCT BEHAVIOUR** = already true in `f090ad9`.
**NEW UI PROPOSAL** = added here, to validate in the field test.

---

## Terminology decision needing confirmation

«إلغاء» was doing two jobs: *void the sale* and *cancel the dialog* — the same word on both buttons
of a destructive flow. Split:

| Meaning | Word |
|---|---|
| void a receipt | **إبطال** · status **مُبطَلة** · confirm **تأكيد الإبطال** |
| dismiss a dialog | **تراجع** |

**NEW UI PROPOSAL** (a translation choice, not a behaviour change). The English stays `Void`.

---

## A · Today's Sales

**CURRENT PROBLEM.** Entirely English in an Arabic shell. Five figures as an undifferentiated
`<dl>`, so nothing leads. Voids render `USD 0.00 −` — minus trailing. `Refresh` is the only
control and carries as much weight as the data. ~70% of the window unused.

**PROPOSED CHANGE.** Net sales is the hero (40px). Gross and voids become its two supporting
figures. Counts drop to a quiet footer row. Date is an unambiguous `2026-10-10` chip. Refresh is a
small ghost at the end of the header. The card is vertically centred so the whitespace reads
composed rather than dumped.

**WHY.** The owner asks one question — *how did today go* — and the answer is net. The other four
numbers explain it; they should not compete with it.

**KEYBOARD.** None beyond focus order. *(No shortcut invented.)*

**BIDI.** Every amount is one isolated run: `20.77 USD`, `− 0.00 USD` with the minus **leading**.
Fixes acceptance defect #5. Date `2026-10-10` isolated LTR.

**STATUS/BUTTON ROLES.** Refresh = ghost. No primary on this screen — it is a read-only summary.
Voids use `--status-warning-text`, **not danger**: a void total is a fact, not an error.

**UNCHANGED.** All five metrics and their source. Every figure is still read from the ledger by the
main process; nothing is computed in the UI.

**OPEN — NOT DESIGNED.** Previous/next-day navigation. Deliberately **omitted from the mockup**:
"Today's Sales" is a today summary, and adding day navigation turns it into a report browser, which
is reporting behaviour this track must not invent. Available as a proposal if you want it.

**EMPTY STATE** (`proposed-today-empty.png`): net shown as a muted `0.00 USD`, with
«لم تُسجَّل أيّ بيعة اليوم بعد» and where the first sale will come from. No unexplained blank.

---

## B · Sales History

**CURRENT PROBLEM.** Two filled dark-red `Void` blocks are the strongest objects on a screen whose
job is lookup. Timestamps render `PM 6:25:23 ,10/9/2026` — acceptance defect #3, and it appears
inside the destructive dialog. All English.

**PROPOSED CHANGE.** Lookup first: `عرض` is the neutral row action, `إبطال` is demoted to
ghost-danger beside it. Status and payment become labelled badges. Voided rows are struck through
and muted. Filled danger appears **only** in the confirmation.

**WHY.** A history screen is read far more often than it is acted on. The destructive action must
be reachable, not dominant.

**KEYBOARD.** Tab reaches row actions in row order. *(No shortcut invented.)*

**BIDI.** `2026-10-10 18:25` as one isolated LTR run — **acceptance defect #3 visibly gone**.
Receipt numbers `#4`, amounts `14.80 USD`, invoice refs `فاتورة 61` all isolated.

**STATUS/BUTTON ROLES.** `مدفوعة` → success · `جزئيّة` and `غير مدفوعة` → **warning, never danger**
(an outstanding balance is a commercial state) · `مُبطَلة` → danger · `مكتملة` → neutral. No status
relies on colour alone; each carries its word.

**UNCHANGED — product truth preserved exactly.**
- Columns and their meanings, including `الرصيد المستحق` showing `—` when zero.
- `paymentText` semantics: unpaid → «غير مدفوعة»; partial → «جزئيّة — <method>»; paid →
  «مدفوعة — <method>»; and when no method was recorded it says so rather than inventing «نقداً».
- 🔴 **Void is offered only for `sourceType === "pos"` and only when not already voided.** An
  invoice-origin sale shows «من فاتورة — لا يُبطَل» with no button, exactly as today. Voiding one
  would leave an immutable invoice looking valid while its sale was cancelled; the honest
  correction is a credit note, which is not built. **Invoice cancellation is not solved here.**

**EMPTY / LOADING.** «لا مبيعات بعد» and a loading line — both already exist in the product and are
translated, not redesigned.

---

## C · Void confirmation

**CURRENT.** `06-void-dialog.png` is already close to right: filled red confirm, neutral cancel,
required reason, visible focus.

**PROPOSED CHANGE.** The dialog now names the object *and* the consequence, and carries a context
line — `2026-10-10 18:25 · الكاشير الأوّل · مدفوعة — بطاقة` — so the operator can tell one receipt
from another before destroying it. `تراجع` sits in the first (rightmost) position; `تأكيد الإبطال`
is second and is the only filled danger in the group.

**KEYBOARD.** `Esc` = تراجع, labelled on the button.

🔴 **Initial focus — a flagged deviation from Foundation §8.** §8 says focus the safe action. The
product today `autoFocus`es the **reason field**, and the mockup keeps that, because:
`Confirm` is disabled until `reason.trim().length >= 3`, so **opening the dialog and pressing Enter
cannot void anything** — the §8 hazard is already closed by the disabled rule, and focusing the
required field saves the operator a Tab on the real workflow. The focus ring in the PNG is on
`تراجع` to show the safe-action treatment; **tell me which you want** — this is the one place the
group departs from an approved rule.

**UNCHANGED.** Reason required, `maxLength` 200, minimum 3 characters, the ledger semantics
("the sale stays in the ledger; a separate void record is added"), and the service-side refusal.

---

## D · Receipt

**CURRENT PROBLEM.** All English. `{sale.paymentMethod}` prints the **raw enum** (`cash`) — the same
class of leak as `PENDING`. Timestamp via `toLocaleString()`, the source of the scrambled format.

**PROPOSED CHANGE.** A success state that reads at a glance: green check + «تمّت البيعة», then
receipt number, time and cashier on one quiet meta line. Lines keep their SKU. Total is 24px —
prominent, not oversized. Payment method gets its own labelled strip and is **translated**.
`بيع جديد` is the single primary.

**WHY.** The cashier needs four answers in under a second: did it go through, how much, how paid,
what next.

**KEYBOARD.** `Enter` → `بيع جديد`. **NEW UI PROPOSAL** — the button exists (`onNewSale`), the
shortcut does not.

**BIDI.** `#4`, `2026-10-10 18:41`, `1 × 2.50 USD`, `14.80 USD` each one isolated run.

**STATUS/BUTTON ROLES.** Success badge for the completed state; one primary; no other action.

**UNCHANGED.** Line data, the quantity × unit-price presentation, the total, and the fact that
**no printing happens in this gate**. No printer or accounting behaviour is invented.

---

## Field-test questions this group raises

1. Is net-as-hero the right lead on Today, or does the owner look for gross first?
2. On History, is `إبطال` discoverable enough once demoted — or did the red blocks serve a purpose?
3. Does «إبطال» vs «تراجع» read correctly to the operator, or is «إلغاء» expected for void?
4. On Receipt, does the cashier want `Enter` → new sale, or is that too easy to trigger?
5. Does Today need day navigation in practice, or is today genuinely enough?
