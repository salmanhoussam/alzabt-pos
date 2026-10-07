# Alzabt Store POS v1 — Product Definition

| Field | Value |
|---|---|
| Status | **Revision 3, 2026-10-07.** Product Management is implemented and accepted in principle; everything else here is still a proposal. |
| Written | 2026-10-06, by أبو حسين |
| Evidence basis | `alzabt-pos` `main` = `65137e4`, version `0.1.1`, clean clone; local handoff materials of 2026-10-05; one real store invoice read as a structural reference |
| Scope | The local Windows POS only. No cloud, no sync, no Lia. |
| Session | `docs/sessions/2026-10-06.md` |

**Evidence labels used throughout:** `VERIFIED IN CURRENT POS CODE` · `VERIFIED IN FIELD BY SALMAN`
· `DOCUMENTED PREVIOUS DECISION` · `PROPOSAL` · `OPEN QUESTION` · `DEFERRED TO CLOUD`.
**Priority tags:** `MUST V1` · `SHOULD V1` · `LATER`.

> This repository is **public**. The reference invoice is described structurally only; no merchant
> name, number, address or price list appears here, and the source PDF stays outside the repo.

---

## 1. Current baseline

`VERIFIED IN CURRENT POS CODE`

```
repo      salmanhoussam/alzabt-pos (public)   ·   main = 65137e4   ·   23 commits   ·   clean
version   0.1.1                                ·   no tags
stack     Electron ^44.5.1 · React 19 · TypeScript 5.9 · better-sqlite3 ^13 · Vite 8 · vitest 5
tests     130 test() calls under tests/        ·   5 E2E scripts   ·   Windows CI with 2 upgrade paths
runtime   one process, one window, one SQLite ledger in the per-user app-data folder
deps      exactly ONE runtime dependency: better-sqlite3
```

That last line matters for everything printed or scanned: there is no PDF library, no QR library,
no printing library, and no i18n library in the project today.

## 2. Verified existing features

`VERIFIED IN CURRENT POS CODE` — each row names where it was read.

| Area | State | Evidence |
|---|---|---|
| Electron hardening | **EXISTS** — `contextIsolation`, `sandbox`, no `nodeIntegration`, menu removed, new windows denied, navigation pinned to one URL, every permission request refused, every IPC call checked to come from our own window's main frame | `src/main/main.ts` |
| IPC surface | **EXISTS** — exactly 13 business channels, no SQL, no file and no generic invoke channel | `src/shared/ipcContract.ts` `CHANNELS` |
| Money | **EXISTS** — integer minor units end to end; `bigint` in memory, `INTEGER` in STRICT tables, decimal string over IPC | `src/domain/money.ts`, migrations |
| Ledger | **EXISTS** — `sales` + `sale_lines` + `voids`; immutability enforced by SQLite triggers, plus a trigger refusing a line beyond the sale's declared `line_count` | migration 1 |
| Atomicity | **EXISTS** — one `BEGIN IMMEDIATE` transaction, lines verified to add up before commit, WAL + `synchronous=FULL`, idempotency key per checkout | `src/persistence/saleRepository.ts`, README |
| Migrations | **EXISTS** — versioned, append-only, SHA-256 recorded on apply and re-checked on every open; a newer database is refused | `src/persistence/migrations.ts` |
| Cashier auth | **EXISTS** — fixture cashiers, scrypt PINs, 5 failures ⇒ 5-minute lock, checked before the PIN, survives restart | migration 2, `src/domain/pinLockout.ts` |
| Local catalog | **EXISTS** — `catalog_products` + `catalog_imports`; `name_ar` required, `name_en` optional, prices integer minor units, identity is the merchant's own key, rows deactivated never deleted | migration 3 |
| Catalog CSV | **EXISTS** — strict UTF-8 import, all-or-nothing, idempotent, per-line rejection reasons; export in the same format with a BOM so Excel shows Arabic | `src/domain/catalogImport.ts` |
| Backups | **EXISTS** — `VACUUM INTO` with verification, once before any migration and once per business day, pruned; a failed daily backup is logged and never fatal | `src/persistence/backup.ts`, `main.ts` |
| Ledger guard | **EXISTS** — refuses to open the wrong ledger file before any write | `src/main/ledgerGuard.ts` |
| Startup failure | **EXISTS** — classified, logged, shown in a message box with our own window caption, and no window is opened on a ledger that failed to open | `src/main/startupFailure.ts`, `main.ts` |
| Logging | **EXISTS** — file logger under the profile's `logs/`, with `app-start` recording version, build, Electron version and platform | `src/main/logger.ts` |
| Diagnostics | **EXISTS** — opt-in, one JSON line per lifecycle event, only when `ALZABT_POS_DIAG_LOG` names a file | `src/main/diagnostics.ts` |
| Release identity | **EXISTS** — version + build SHA embedded at build time and shown on every screen | `scripts/write-build-info.mjs`, `src/renderer/BuildLine.tsx` |
| Installer | **EXISTS** — NSIS per-user, no admin, build-named artifact; uninstall removes the auto-start entry but never the ledger | `package.json` build block, `build/installer.nsh` |
| Auto-start | **EXISTS** — one per-user login item, registered once per installation profile, packaged Windows only, opt-out by env | `src/main/autoStart.ts` |
| UI | **EXISTS** — six screens, 712 lines total: Login, Sell, Today, History, Tools, Receipt | `src/renderer/` |
| Windows CI | **EXISTS** — typecheck, tests, build, package, silent install, crash recovery, smoke, catalog import, startup failure, auto-start, silent uninstall, **two upgrade-over-previous-release paths**, screenshots, and the installer uploaded only after every check passes | `.github/workflows/windows-delivery.yml` |

**Do not rebuild any of the above.** `DOCUMENTED PREVIOUS DECISION`

## 3. Current limitations

`VERIFIED IN CURRENT POS CODE`. Classification per the brief's §6 vocabulary.

| # | Capability | Class | The measured reason |
|---|---|---|---|
| L-1 | Add / edit / deactivate a product on the till | **MISSING** | No IPC channel exists for it. The catalog is import-only: the 13 channels include `importCatalog` and `exportCatalog` and nothing else that writes a product. |
| L-2 | Fractional quantity (34 kg, 2.5 m) | **MISSING — and blocked** | `assertQuantity` requires `Number.isSafeInteger`, 1…9999 (`src/domain/cart.ts`). Worse, migration 1 declares `quantity INTEGER NOT NULL CHECK (quantity > 0)` **and** `CHECK (line_total_minor = quantity * unit_price_minor)`. Migration 1 is shipped and checksummed, so neither check can be edited. See §15. |
| L-3 | Unit-aware quantity | **PARTIAL** | `BASE_UNITS` is frozen to `["piece","box"]` (`src/domain/catalog.ts`), with the code's own comment: fractional units need fractional quantities first. `base_unit` is a free-text column validated in code, so adding units needs **no** table change. |
| L-4 | Stock quantity | **MISSING** | No stock, quantity-on-hand, or movement column or table anywhere in migrations 1–3. |
| L-5 | Customer | **MISSING** | `sales` has no customer column; no customer table exists. |
| L-6 | Partial payment / balance due | **MISSING** | `sales` holds `payment_method` as a single enum of `cash`/`card`/`external`/`other` and has **no** paid or balance column. 🔴 A credit sale — nothing paid, full amount outstanding — **cannot be represented at all today**, and that is exactly the shape of the shop's first real invoice. |
| L-7 | A4 PDF invoice | **MISSING** | `Receipt.tsx` is 46 lines of on-screen receipt. Zero print code, zero PDF dependency. |
| L-8 | 4×6 QR label | **MISSING** | No QR dependency; the only runtime dependency is the SQLite driver. |
| L-9 | Arabic operator UI | **PARTIAL** | Arabic **data** works end to end (`name_ar` required, round-tripped through SQLite → IPC → cart → receipt, proven in CI). The **operator UI is English**: there is no language channel among the 13, no RTL handling, no message catalogue, and no Arabic search normalisation. |
| L-10 | Cashier administration | **PARTIAL** | Authentication and lockout are real; cashiers are a **fixture** with published PINs, there is no admin screen, and no permission model — any cashier may void a sale and import a catalog. |
| L-11 | Barcode scanner | **MISSING** | No barcode column, no scanner code. A standalone measurement page exists in the field kit and has never been run. |
| L-12 | Printer | **MISSING** | No printer code of any kind. |
| L-13 | Discounts, tax, refunds, split payments, shifts, cash drawer, multi-terminal, auto-update, code signing | **MISSING, deliberately** | README "Out of scope for this gate". |

## 4. Store POS v1 — product definition

A merchant with one PC runs the whole shop locally: he keeps his own product list, sells by piece
and by weight, knows what he has in stock, sells to a named customer on credit, prints an A4
invoice and a carton label, and does all of it in Arabic. Offline, on one machine, with the
financial record immutable.

Everything below is **`PROPOSAL`** unless labelled otherwise.

## 5. Product / catalog management

| Capability | Tag | Note |
|---|---|---|
| Add a product on the till | **MUST V1** | `catalog_products` already carries `id`, `source`, `source_key`, `sku`, `name_ar`, `name_en`, `selling_price_minor`, `currency`, `base_unit`, `price_needs_review`, `is_active`, timestamps. 🟢 **A product editor needs no schema change** — only new IPC channels and a screen. This is far cheaper than it looks. |
| Edit name / price / unit | **MUST V1** | Same table. A price edit must never alter a past sale — already structurally true, because `sale_lines` snapshots name, SKU and unit price and no sale references the catalog. `VERIFIED IN CURRENT POS CODE` |
| Deactivate (never delete) | **MUST V1** | `is_active` exists and import already deactivates rather than deletes. |
| Arabic name required, English optional | **MUST V1** | Already enforced by the column constraints. `VERIFIED IN CURRENT POS CODE` |
| Keep the Excel export→edit→import round-trip | **MUST V1** | It works and the merchant may prefer it for bulk work. Keeping both paths means the editor must write through the same repository, so the two cannot diverge. |
| Opening stock on the product form | **SHOULD V1** | Depends on §7. |
| Barcode field | **LATER** | Needs a scanner measured first, and the field survey is empty. |
| A price of zero | **not offered** | `selling_price_minor > 0` is a shipped constraint; a product with no price is represented by `price_needs_review`, which stays sellable. `VERIFIED IN CURRENT POS CODE` |

## 6. Quantity and units

`DECISION — SALMAN 2026-10-06`: **units are never inferred.** Not from a CSV column, not from a
product name, not from a price. A real unit comes from field data or it does not exist.

| Rule | Consequence in the build |
|---|---|
| A product whose real unit is unknown is **explicitly marked as needing review** | A new `unit_needs_review` flag beside the existing `price_needs_review`, which already proves the pattern works: such a product stays **sellable** |
| An unverified unit gets **no authoritative inventory arithmetic** | Stock for that product is shown as *unverified* and is never used in a stock-based refusal, reorder figure or valuation |
| No invention anywhere | The same rule `name_en` already follows: never translated, never guessed `VERIFIED IN CURRENT POS CODE` |

Three separate things, and only the first exists today:

```
sale-line quantity   EXISTS   integer 1…9999, per line
stock quantity       MISSING  no column anywhere
unit-aware quantity  PARTIAL  base_unit exists; only "piece" and "box" are allowed
fractional quantity  BLOCKED  by two CHECK constraints in migration 1 — see §15
```

| Capability | Tag | Note |
|---|---|---|
| More whole units (pack, box-of-N) | **MUST V1** | `BASE_UNITS` is validated in code, so no migration is needed `VERIFIED IN CURRENT POS CODE` |
| Fractional quantity (kg, m, l) | **MUST V1** | Exact scaled integers, never a float — §15 |
| `unit_needs_review` flag | **MUST V1** | The enforcement point for the decision above |
| Unit displayed in Arabic | **MUST V1** | The reference invoice prints its unit column in Arabic |
| Purchase unit vs selling unit | **SHOULD V1** | The field survey asks for it and is empty `OPEN QUESTION` |

🔴 **Precision is still unanswered.** Three decimals for weight is an engineering default, not
evidence. The scaling factor is a one-way decision once sales exist, so it is Q-2.

## 7. Local inventory

| Capability | Tag | Note |
|---|---|---|
| Movement ledger, not a mutable counter | **MUST V1** | `PROPOSAL`: one append-only `stock_movements` table with a reason — `opening`, `sale`, `purchase`, `adjustment`, `waste`, `return`, `count` — and quantity on hand derived by summing it. This matches how the sales ledger already works, so the shop's two records behave the same way, and it answers "why is the number what it is", which a counter never can. |
| A sale writes its movement in the same transaction | **MUST V1** | Otherwise stock drifts from sales on any crash, and crash behaviour is already proven for sales. |
| On-hand shown on the till | **MUST V1** | |
| Selling below zero | **SHOULD V1** | Warn, do not block: a hardware shop sells what is physically there regardless of the count. |
| 🔴 **An unverified unit gets NO authoritative arithmetic** | **MUST V1** | `DECISION — SALMAN 2026-10-06`. Stock for a product whose unit is unverified is shown **as unverified** and never used in a refusal, a reorder figure or a valuation. The projection carries that state rather than hiding it. See §6. |
| Stock count / stocktake screen | **SHOULD V1** | |
| Supplier invoice intake | **LATER** | The ground-truth CSVs are empty; nothing to build against. |

## 8. Customer, payments and balance due

`DECISION — SALMAN 2026-10-06`, adopted verbatim:

> A sale with an unpaid balance **is still a completed Sale.**
> Sale + append-only payment records = derived outstanding balance.
> The original sale total is **never mutated**. A later debt payment is a **new record**, not an
> edit of the old sale. If outstanding balance > 0, **customer identity is required.**
> Kept intentionally small — this is not accounting.

This settles what was Q-4, and it fits the ledger that already exists: `sales` stays immutable,
and payments become a second append-only table alongside `voids`. Nothing about the current
immutability design has to bend.

| Capability | Tag | Note |
|---|---|---|
| `payments` append-only, one row per money event | **MUST V1** | Mirrors `voids`: insert-only, triggers refusing UPDATE and DELETE |
| Outstanding balance **derived**, never stored | **MUST V1** | `total − sum(payments)`. A stored copy would eventually disagree with the rows |
| A sale may complete with zero paid | **MUST V1** | Exactly the shape of the shop's first real invoice |
| Customer required when the balance is positive | **MUST V1** | Enforced in the service, and expressible in SQL as a partial constraint |
| Customer with optional phone and address | **MUST V1** | Name only must be valid — the reference invoice has blank phone and address |
| A later payment against an open balance | **MUST V1** | A new `payments` row. The sale is settled when the rows sum to its total |
| Customer statement: what this customer owes | **SHOULD V1** | Falls out of the same table |
| Split payment across methods | **SHOULD V1** | Also falls out of it; the current single enum cannot express it |
| Credit limits, ageing, interest, journals | **LATER** | Out of the stated scope |

**One consequence to name:** `sales.payment_method` is a single enum and keeps its meaning for a
simple paid-in-full sale. Once `payments` exists, the enum becomes a convenience snapshot and the
rows are the truth. Both must not be allowed to disagree — the service writes them in the same
transaction, as it already does for a sale and its lines. `PROPOSAL`

## 9. A4 PDF invoice

Structural requirements, read off the reference document.

| Element | Tag |
|---|---|
| Store branding block: logo, Arabic and English trading name, trade line, contact line | **MUST V1** |
| Bilingual field labels throughout, Arabic beside English | **MUST V1** |
| Invoice number — **`receipt_number`, and only that** | **MUST V1** · `DECISION — SALMAN 2026-10-07`: one merchant-facing number. **No second sequence is invented.** The sale UUID stays internal technical identity and may later be encoded in the QR. This answers Q-5. |
| Date, document type | **MUST V1** |
| Customer block: name, address, phone, notes — each printable when blank | **MUST V1** |
| Line table: no., description, quantity, **unit**, unit price, line total | **MUST V1** |
| Totals block: subtotal, paid, **balance due emphasised** | **MUST V1** |
| The total written out in **Arabic words** | **SHOULD / LATER** · `DECISION — SALMAN 2026-10-07`: not a MUST. The numeric exact total is authoritative, and the first correct invoice PDF is **not** delayed for it. This answers Q-6. |
| Footer thank-you line, bilingual | **SHOULD V1** |
| Generated from sale data automatically, never typed | **MUST V1** |
| Produced as a PDF file the merchant can save and reprint | **MUST V1** |
| Sent to a Windows printer | **LATER** — §13 |

The spreadsheet is a **reference for the output**, not a data model. `DOCUMENTED PREVIOUS DECISION`

**Engineering note.** Electron can print a page to PDF with no new dependency, which keeps the
one-dependency property. Arabic shaping in a PDF needs a bundled Arabic font; the previous handoff
had already planned one for L1-B, so the two should share it.

## 10. 4×6 QR label

| Element | Tag |
|---|---|
| 100 × 150 mm page, portrait | **MUST V1** |
| Store branding, invoice number, customer, package information | **MUST V1** |
| A QR encoding a **stable local sale identity** | **MUST V1** — the sale id and receipt number already exist and are stable. **No cloud URL is to be invented.** `DEFERRED TO CLOUD` |
| Package n-of-m for a multi-carton order | **SHOULD V1** |
| Thermal printer output | **LATER** — needs the real printer model |

## 11. Arabic UX

`DECISION — SALMAN 2026-10-06`. This **replaces** the previous session's recommendation to put
Arabic at PR 8, and it is better than either earlier option:

> Create the i18n/RTL **foundation early**. Then every NEW Store POS screen is bilingual from its
> first implementation. Do not build new English-only screens and translate them later — and do
> not fully polish every existing screen before the Store core either.

So Arabic is neither first nor last: the *foundation* is second, and every later PR pays its own
translation cost as it goes. The failure mode my earlier ordering would have caused — translating a
UI twice — is avoided without delaying the Store core.

### The foundation (PR 2 in §20)

| Piece | Tag | Note |
|---|---|---|
| `terminal_language` and `receipt_language`, kept **separate** | **MUST V1** | `DOCUMENTED PREVIOUS DECISION` |
| Translation registry / files | **MUST V1** | One place a new screen registers its strings |
| `html dir` and `lang` driven by terminal language | **MUST V1** | |
| **Logical** CSS direction throughout (`inline-start`/`inline-end`, never `left`/`right`) | **MUST V1** | A new screen then needs no RTL work of its own |
| Localised mapping of the existing `DomainError` codes | **MUST V1** | The codes already exist, so this is a catalogue, not new logic `VERIFIED IN CURRENT POS CODE` |
| Arabic search normalisation: alef forms, ى/ي, tashkeel, tatweel, Arabic-Indic digits — **and no ة→ه** | **MUST V1** | `DOCUMENTED PREVIOUS DECISION`; the exclusion is deliberate and must survive |
| Display digits stay 0–9 | **MUST V1** | `DOCUMENTED PREVIOUS DECISION` |
| Bundled Arabic font, **if still required** | **MUST V1 (verify first)** | Windows ships Arabic-capable faces; whether a bundled font is needed is measured on the shop PC, not assumed. Shared with §9 and §10 |
| Arabic-safe sale snapshot | **MUST V1** | Already true for product names `VERIFIED IN CURRENT POS CODE` |

### The standing rule after that

**Every new screen is bilingual on its first commit.** A PR that adds an English-only screen is not
complete. The existing six screens are retrofitted opportunistically — whenever a PR touches one —
rather than in one big translation pass.

## 12. Cashiers and permissions

`DECISION — SALMAN 2026-10-06`. The v1 boundary, adopted as given:

| Action | OWNER / ADMIN | CASHIER |
|---|:---:|:---:|
| Sell | ✅ | ✅ |
| Reprint an invoice | ✅ | ✅ |
| View the sale history needed to work | ✅ | ✅ (scoped) |
| **Void a sale** | ✅ | ❌ — **requires Owner/Admin authority** |
| Product add / edit / deactivate | ✅ | ❌ |
| Price change | ✅ | ❌ |
| Catalog import / export | ✅ | ❌ |
| Stock adjustment / count | ✅ | ❌ |
| Backup / export | ✅ | ❌ |

| Capability | Tag |
|---|---|
| Real cashier records replacing the fixture; the published PINs retired | **MUST V1** |
| The two roles above, enforced in the service — not only hidden in the UI | **MUST V1** |
| Void gated behind Owner/Admin authority | **MUST V1** |
| Who did what, recorded | **SHOULD V1** — cashier id and name are already snapshotted on every sale and void `VERIFIED IN CURRENT POS CODE` |
| Shifts, tills, cash counts | **LATER** |

🔴 Until this lands, **two published PINs can void sales and replace the catalog.**
`VERIFIED IN CURRENT POS CODE`

**"NO unrestricted void" needs one clarification**: does a cashier get *no* void at all, or a void
that an Owner/Admin authorises on the spot (an override PIN at the till)? The second is what a real
shop usually needs, and it is more work. Q-8.

## 13. Printer and scanner boundaries

Firm rule, inherited and kept: **no hardware code before the hardware is measured.**
`DOCUMENTED PREVIOUS DECISION`

| Step | Tag |
|---|---|
| Run the existing scanner probe at the shop and record the real model's behaviour | **MUST V1 (field, not code)** |
| Record the real printer model, driver and paper handling | **MUST V1 (field, not code)** |
| A4 printing through the Windows print dialog | **SHOULD V1** |
| Direct thermal label printing | **LATER** |
| Scanner as keyboard-wedge input into the sell screen | **LATER** — needs a barcode column first, which needs the empty survey |

## 14. Black-screen investigation — read-only first

`VERIFIED IN FIELD BY SALMAN`: the shop PC was found black-screened or apparently frozen, after
0.1.1 had been installed. **No causal claim is made. The POS may be entirely innocent.**

### 🔴 A correction to this document's previous version

The earlier draft called the absence of `powerSaveBlocker` a *product gap for a till*. That framing
was wrong and is withdrawn, on Salman's correction: **normal Windows applications commonly allow
the display to sleep.** Letting the screen sleep is default, correct behaviour — not a defect, and
not evidence of anything. The grep result stands as a fact about the code; the judgement attached
to it does not.

### What the code says — measured by grep across `src/`, `e2e/`, `build/`, `scripts/`

These are facts about the code, deliberately **not** ranked as causes:

| Fact | Occurrences | What it does and does not mean |
|---|---|---|
| `powerSaveBlocker` | **0** | The app does not hold the display awake. This is ordinary application behaviour and says nothing about the incident. |
| `disableHardwareAcceleration` · `disable-gpu` | **0** | There is no GPU fallback **and no switch to test one**. A diagnostic switch is worth having; **global disabling is not proposed.** |
| `render-process-gone` · `unresponsive` | **0** | If the renderer died or hung, **nothing would have logged it.** This is a genuine observability gap whatever caused the incident — and it is the reason this incident may be undiagnosable after the fact. |
| `setInterval` · `setTimeout` in `src/` | **0** | There is no timer loop in the application, so a CPU spin or unbounded growth driven by app timers is **not plausible**. This narrows the field. |
| Window background | `#f4f5f7` | Light grey. A window that showed but failed to paint would read **grey, not black** — so "black" points away from the renderer. |

### Evidence to collect on the real PC, before any hypothesis

Read-only. A backup is exported first, from Tools, and the shop ledger is never modified. No
safeguard is disabled.

1. POS logs from `%APPDATA%\Alzabt POS\logs\` **around the incident timestamp** — `app-start`
   (version, build, Electron version, platform), `startup-failure`, `uncaught-exception`,
   `single-instance-lock-refused`, `backup-daily-failed`.
2. **Reliability Monitor** for that window.
3. **Event Viewer** — Application log (application-error, application-hang) and System log
   (`Kernel-Power 41`, display-driver reset, `BugCheck`).
4. **Windows power and display-sleep settings**, plus Fast Startup.
5. **Did keyboard or mouse wake the screen?**
6. **Was Windows itself responsive** — Ctrl+Alt+Del, Caps-Lock light, network reachable?
7. **Task Manager** — processes, duplicate *Alzabt POS* instances, CPU and RAM.
8. Display-driver, `BugCheck` and `Kernel-Power` evidence, and whether Windows is still unactivated.

### The next incident is classified before anything is proposed

`DECISION — SALMAN 2026-10-06`:

```
A   display sleep
B   whole-OS hang
C   only the Alzabt window black or unresponsive
D   GPU / display-driver reset
E   unknown
```

**Only after a classification is a product change proposed.** Items 5, 6 and 7 above are what
separate A from B from C, and they cost nothing but attention at the moment it happens.

### Observability — proposed separately, and it changes no behaviour

`PROPOSAL`, **MUST V1**, and deliberately inert: log `render-process-gone` and `unresponsive`, and
add a **supported command-line switch** to run once without GPU acceleration for comparison.
Logging an event that is currently unlogged does not change what the app does; it only means the
next incident leaves a trace. **No recovery action, no automatic restart, no global GPU change, and
no display-wake decision** is proposed until a classification exists.

## 15. Required SQLite changes

### The constraint that forces a decision

`VERIFIED IN CURRENT POS CODE`

1. Migrations 1–3 are shipped; each one's SHA-256 is recorded on apply and re-checked on every
   open, and a mismatch stops the app (`src/persistence/db.ts` `verifyAppliedMigrations`).
   **Their text is never edited.**
2. `sale_lines` declares `quantity INTEGER NOT NULL CHECK (quantity > 0)` **and**
   `CHECK (line_total_minor = quantity * unit_price_minor)`.
3. Triggers abort every `UPDATE` and `DELETE` on `sales`, `sale_lines` and `voids`.

A fractional line cannot live in that table as it stands: the column is an integer, and the
cross-field check forbids the rounding any fractional price needs. **Adding a column cannot repair
a `CHECK` that is already in the table.** So either a second table is introduced, or the table is
rebuilt.

### Two measured facts that decide the question

```
grep "REFERENCES sale_lines"  src/persistence/migrations.ts   →  ZERO
  ⇒ sale_lines is a LEAF table. Nothing in the schema points at it.

src/persistence/db.ts  migrate()   →  db.transaction(() => { db.exec(m.sql); record.run(...) }).immediate()
  ⇒ a migration and its own schema_migrations row run in ONE immediate transaction.
```

Those two together are why Salman's option is viable, and the experiment below proves it rather
than arguing it.

### Option A — second table + VIEW (this document's previous proposal)

A new measured-line table; old rows never touched; a VIEW unions both for reading.

### Option B — rebuild `sale_lines` in migration 4 `RECOMMENDED`

Salman's option. One long-term line model. The statement order **is** the design:

```sql
-- migration 4, inside the runner's single immediate transaction
DROP TRIGGER sale_lines_immutable_update;
DROP TRIGGER sale_lines_immutable_delete;
CREATE TABLE sale_lines_new (
  id                TEXT    PRIMARY KEY,
  sale_id           TEXT    NOT NULL REFERENCES sales (id),
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  product_id        TEXT    NOT NULL,
  sku               TEXT    NOT NULL,
  product_name      TEXT    NOT NULL,
  quantity_milli    INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor  INTEGER NOT NULL
    CHECK (abs(line_total_minor * 1000 - quantity_milli * unit_price_minor) <= 500),
  UNIQUE (sale_id, line_no)
) STRICT;
-- the closed_sale trigger is recreated on the NEW table BEFORE the copy, on purpose: see below
INSERT INTO sale_lines_new (...)
  SELECT id, sale_id, line_no, product_id, sku, product_name,
         quantity * 1000, unit_price_minor, line_total_minor
  FROM sale_lines;
DROP TABLE sale_lines;
ALTER TABLE sale_lines_new RENAME TO sale_lines;
CREATE INDEX sale_lines_sale_id ON sale_lines (sale_id);
-- recreate the two immutability triggers last
```

**No float appears anywhere.** `quantity_milli` is an exact integer count of thousandths, money
stays integer minor units, and `defaultSafeIntegers(true)` already returns every INTEGER as a
`bigint` `VERIFIED IN CURRENT POS CODE`.

#### The cross-field invariant is not lost — it becomes a bounded integer check

`line_total_minor = round(quantity_milli × unit_price_minor ÷ 1000)` cannot be written as an
equality. It **can** be written as a bound, in pure integer arithmetic:

```
CHECK (abs(line_total_minor * 1000 - quantity_milli * unit_price_minor) <= 500)
```

### Measured evidence — a real SQLite experiment, not reasoning

Run against the real migration-1 shapes with Arabic data and three historical lines.
`sqlite3 3.45.1` (Python stdlib). Scripts kept under the session's scratch area.

| # | Question | Result |
|---|---|---|
| **T1** | **Crash safety.** Run the whole rebuild in one transaction, then `ROLLBACK` — a crash is a rollback. | ✅ Columns, **all three triggers**, the index, the row count and the data fingerprint were **restored exactly**. SQLite DDL is transactional. |
| **T2** | **History preservation.** Commit, then compare a SHA-256 fingerprint of every non-quantity column across all rows. | ✅ **Identical.** `PRAGMA foreign_key_check` clean, `integrity_check` ok. Mapping exact: 1→1000, 2→2000, 34→34000, totals untouched. |
| **T3** | **The bounded check on fractional lines.** 0.333 kg × $2.99 (= 99.567 minor). | ✅ 100 accepted; **99, 101 and 0 all rejected.** The check pins the correctly-rounded total. |
| **T4** | **Whole-unit lines keep the OLD exact invariant.** 3 × $4.00. | ✅ 1200 accepted; **1201 and 1199 rejected.** Exact equality is preserved for every whole-unit line, including every historical one. |
| **T5** | **Do the guards still bite after the rebuild?** | ✅ All five: `UPDATE` → *immutable*; `DELETE` → *cannot be deleted*; `quantity_milli = 0` → CHECK; a line beyond `line_count` → *sale already holds all of its lines*; an unknown `sale_id` → FOREIGN KEY. |
| **T8** | **The tie case.** 0.500 × $2.01 = exactly 100.5 minor. | Two totals admissible (100 and 101), everything else refused. The application's round-half-up rule picks one. |
| **T9** | **Overflow headroom** for the check's multiplication. | 9,999 units × $1,000,000 ⇒ 9.999 × 10¹⁴, against an int64 ceiling of 9.22 × 10¹⁸ — **9,224× headroom.** |
| **Q1** | Can a migration turn foreign keys off? | ❌ **`PRAGMA foreign_keys=OFF` is silently ignored inside a transaction** (it still read `1`). **It does not matter here** — `sale_lines` is a leaf, and T2 proved `foreign_key_check` clean with FK enforcement ON throughout. |

#### 🔴 And one finding that corrects this document's previous version

The earlier draft stated, as CONFIRMED, that the `closed_sale` trigger **must** be created after
the copy or "the migration cannot run at all". **That is false.** It came from a test with one line
per sale — a case too weak to exercise the trigger. Re-run with **two lines on one sale**, which is
what real data looks like, the copy succeeded in **both** orders: the trigger fires only on a line
*beyond* the declared `line_count`, and the copy inserts exactly as many lines as were declared.

The corrected test changes the recommendation in the opposite direction: create the `closed_sale`
trigger on the new table **before** the copy, deliberately — then a ledger that somehow holds more
lines than a sale declares **aborts the migration** instead of being copied forward silently. The
trigger becomes a corruption detector for free.

### Comparison

| | Option A — second table + VIEW | Option B — rebuild `RECOMMENDED` |
|---|---|---|
| Long-term model | **Two** line tables, permanently | **One** |
| Historical rows | Never touched | Copied, and proven byte-identical outside the quantity column (T2) |
| Crash behaviour | Nothing to roll back | Full rollback, **proven** (T1) |
| Cross-field DB invariant | Old table keeps it; new table needs its own | One bounded check that is **exact for whole units** (T4) and pins the rounded value for fractional ones (T3) |
| `backup.ts` `COUNTED_TABLES` | 🔴 Must gain the new table, or every backup is verified **without counting the new lines** — a silent hole in the backup guarantee | **Unchanged** — the table name is preserved `VERIFIED IN CURRENT POS CODE` |
| `saleRepository` | Insert path, join path and read path must handle both shapes, plus a VIEW to maintain | 3 call sites changed once (`:142` insert, `:156` join, `:221` read) |
| Existing tests | Keep passing; new ones added | `tests/persistence/schema.test.ts:101,120,134` name `quantity` and **must be updated** — a visible, one-time cost |
| Reporting / future readers | Every future query must know both tables | One table |
| Performance | No migration cost | One copy of the whole table. The shop's ledger is in the thousands of rows; even a million copies in about a second |
| Complexity | Low once, **permanent** | Moderate once, **then gone** |

**Recommendation: Option B.** It is what Salman asked for — one long-term sale-line model — and
every safety property he asked about is now measured rather than argued.

### The one real loss, stated plainly

After migration 4, the live `sale_lines` no longer matches what migration 1's text describes. The
checksum mechanism keeps doing its actual job — detecting an **edited migration** or a foreign
database — because it hashes migration *text*, not the live schema `VERIFIED IN CURRENT POS CODE`.
What is lost is that the migration log stops being a literal replay description of the current
schema. That is inherent to any rebuild, and it is the price of one model instead of two.

### The boundary this creates for future migrations

Option B works **because `sale_lines` is a leaf**. Rebuilding `sales` — which `sale_lines` and
`voids` both reference — would require foreign keys off, and Q1 proves a migration **cannot** turn
them off from inside its transaction. So: **`sales` must never need a rebuild**, or the migration
runner itself has to change first. Worth knowing before a later migration discovers it.

### Proposed new migrations — 🔴 UNNUMBERED, on Salman's instruction

`DECISION — SALMAN 2026-10-07`: **a migration number is assigned only when the implementation ORDER
is approved.** Two changes compete for the next number — the `sale_lines` quantity rebuild and the
durable audit table — so neither is called "migration 4" anywhere any more.

| Change | Contents | Contract |
|---|---|---|
| Quantity rebuild | Rebuild `sale_lines` to `quantity_milli`, one long-term table | `docs/plans/exact-quantity-contract.md` |
| Durable audit | `audit_events`, append-only, in the SAME transaction as the mutation it records | `docs/plans/durable-local-audit-proposal.md` |
| Units flag | `catalog_products.unit_needs_review` | §6 |
| Inventory | `stock_movements`, append-only, with its reason vocabulary | §7 |
| Customer & payments | `customers`, a customer reference on a sale, `payments` append-only | §8 |
| Cashiers | Real cashier records and the two-role permission model | §12 |
| Settings | Terminal language, receipt language, store identity for printed documents | §9, §11 |

Nothing above is written until Salman approves both the contract and the order.

### The line-total check, superseded

Revision 2 proposed a **tolerance** — `abs(line_total_minor * 1000 - quantity_milli *
unit_price_minor) <= 500`. Revision 3 replaces it with an **exact equality**:

```sql
CHECK (line_total_minor = (quantity_milli * unit_price_minor + 500) / 1000)
```

Measured: SQLite's `/` is integer division on integers, and this form admits **exactly one** total in
every case — the exact tie included, where the tolerance admitted two and left rounding to the
application. The schema now pins the rounding rule, so the app and the database cannot disagree.
Evidence: `docs/evidence/quantity-exact-check-experiment.py`.

## 16. Migration strategy

- One concern per migration, in the order of §15, each with its own tests and its own CI run.
- Every migration is **additive** — new tables, new indexes, new columns with defaults — with
  **exactly one deliberate exception**: migration 4 under Option B rebuilds `sale_lines`. That
  exception is bounded by three measured facts (§15): the table is a leaf, the runner wraps each
  migration in one immediate transaction, and a rollback restores schema, triggers, indexes and
  data exactly (T1). **No further rebuild is sanctioned by this document**, and `sales` in
  particular must never need one — a migration cannot turn foreign keys off (Q1).
- No constraint is relaxed. Migration 4's bounded check is **stricter** than nothing and exactly as
  strict as the old one for every whole-unit line (T4).
- The existing pre-migration verified backup already covers each step. `VERIFIED IN CURRENT POS CODE`
- The existing upgrade CI must be extended with a path from **0.1.1 with real data** to each new
  schema, because that is precisely the upgrade the shop will perform.
- A database newer than the build is already refused, so a downgrade cannot silently corrupt.

## 17. Backward compatibility

| Invariant | Must still hold after V1 |
|---|---|
| Sales, lines and voids written by 0.1.x stay readable and unchanged | **Yes** |
| Receipt numbers stay unique and monotonic | **Yes** |
| Idempotent checkout keeps returning the original sale | **Yes** |
| The catalog CSV format keeps importing files the merchant already has | **Yes** — new columns must be optional |
| A product price change never alters a past sale | **Yes** — structurally true today |
| The shop's existing ledger survives every upgrade with its data | **Yes** — and it is the one thing CI must prove before any release |

## 18. Test strategy

Mirror what already works rather than inventing a second style. 130 tests and 5 E2E scripts exist;
the new work extends them.

### The v3 → v4 upgrade test — the one that must exist before migration 4 ships

This is the test the shop's ledger depends on, so it is specified rather than described:

1. **Build a v3 database the way the field did**: apply migrations 1–3, insert sales with lines,
   including whole-unit lines **and** a void, with Arabic product names, through the real repository
   — not hand-written SQL, so the fixture cannot be kinder than reality.
2. **Fingerprint before**: SHA-256 over every column of every row of `sales`, `sale_lines`
   (excluding `quantity`) and `voids`, plus the row counts and `PRAGMA integrity_check`.
3. **Apply migration 4 through `openDatabase`** — the real runner, so the pre-migration backup, the
   checksum verification and the single immediate transaction are all exercised.
4. **Assert, after**: the fingerprint is unchanged · `quantity_milli = old quantity × 1000` for
   every historical row · all three triggers exist again · the index exists again ·
   `foreign_key_check` is clean · `integrity_check` is `ok` · `schema_migrations` holds 4 rows with
   migration 1–3's checksums **unchanged**.
5. **Assert the pre-migration backup was created** and that **its** row counts match the source.

### Existing-sale verification

Every sale written before the migration must still read back **identically through the IPC layer**,
not only through SQL: same receipt number, same lines, same names, same unit prices, same totals.
A schema change that is invisible in a table dump but changes what the renderer receives is exactly
the class of bug that gets found in the field instead of in CI.

### Negative tests — mandatory, because most of V1 is about refusing things

| Must be refused | Enforced by |
|---|---|
| `quantity_milli = 0` or negative | CHECK — proven T5 |
| A line total more than half a minor unit from the exact product | the bounded CHECK — proven T3 |
| A whole-unit line total off by one minor unit | the same CHECK — proven T4 |
| `UPDATE` or `DELETE` on a sale line | triggers — proven T5 |
| A line beyond the sale's declared `line_count` | trigger — proven T5 |
| A line whose `sale_id` does not exist | FOREIGN KEY — proven T5 |
| A payment that exceeds the sale's outstanding balance | service (§8) |
| A positive outstanding balance with no customer | service (§8) |
| A stock movement with no reason | CHECK (§7) |
| A cashier voiding a sale | permissions (§12) |
| A catalog import by a cashier | permissions (§12) |
| **A migration edited after it shipped** | already enforced — `MigrationMismatchError` |

### Crash and rollback

A crash during migration 4 must leave a v3 database that opens normally. T1 proves the rollback at
the SQLite level; the E2E equivalent belongs in `crash-recovery.mjs`, which already kills the real
installed app — it is extended to kill it **during** a migration.

### The standing rules

- One test per bug found in the field, written before the fix.
- A test that proves a constraint is still enforced by the **database**, not only by code.
- Every new screen's bilingual rendering is asserted, per §11's standing rule.

## 19. Real-PC test strategy

CI proves Windows behaviour; it does not prove the shop. On the real machine, with a backup taken
first:

1. Hash-verify the installer before installing. `DOCUMENTED PREVIOUS DECISION`
2. Install over the running version; confirm the build line, then confirm **old sales and the old
   void are still present**.
3. Confirm a pre-migration backup appeared.
4. Import the real catalog; export it again and compare.
5. Ring a real sale in Arabic, print the invoice, and read it as the merchant would.
6. Restart the PC and confirm the till returns by itself.
7. Run the scanner probe, if a scanner exists.
8. Record everything in the field checklist that already exists, and fill in the empty survey CSVs.

## 20. PR sequence — locked

`DECISION — SALMAN 2026-10-07`. This replaces revision 3's A–L. **The one structural change:
cashier/permission hardening moved AHEAD of inventory and the customer/payment features**, because
the published fixture PINs cannot still be able to perform administrative Store actions when money
features reach a field release.

| # | PR | State |
|---|---|---|
| **1** | Product Management **Draft PR** + Windows CI evidence | 🟡 **blocked on a push credential** — see the session, Addendum 4 |
| **2** | Node 22 runtime contract | 🟡 prepared, 4 lines, branch `chore/node22-runtime-contract` |
| **3** | **Migration 4** — exact / fractional quantity | ✅ contract approved · ⚪ not implemented, waits on PR 1's evidence |
| **4** | **Migration 5** — durable local audit | ✅ principle approved · ⚪ not implemented, **a separate PR from 3** |
| **5** | **Local cashier / role hardening** | ⚪ **moved up.** Owner/Admin vs Cashier; a cashier may *request* a void, an Owner/Admin PIN override authorises it on the till |
| **6** | Inventory movement ledger + stock projection | ⚪ |
| **7** | Customer + payments + balance due | ⚪ |
| **8** | A4 PDF invoice | ⚪ |
| **9** | 4×6 QR label | ⚪ |
| **10** | Barcode / categories / search enhancements | ⚪ |
| **11** | Physical scanner / printer verification | ⚪ |
| **12** | Field release | ⚪ |
| — | Cloud | `DEFERRED TO CLOUD` |

## 21. V1 acceptance criteria

V1 is done when, on the shop's own PC, offline:

1. The merchant adds, edits and deactivates his own products on the till, in Arabic.
2. He sells by piece and by weight, and the printed line shows the right unit.
3. Stock on hand is visible and changes correctly with each sale, with its history explainable.
4. He sells to a named customer, records part payment or none, and sees the balance due.
5. An A4 PDF invoice is generated from the sale, bilingual, and it matches the reference layout.
6. A 4×6 label prints with a QR that resolves to that sale locally.
7. The entire operator experience is Arabic, RTL, with Arabic-safe search.
8. Cashiers are real, and only the owner may void, import or change a price.
9. The upgrade from 0.1.1 preserves every existing sale and void, proven in CI **and** on the PC.
10. No completed sale can be altered — still enforced by the database.
11. The black-screen incident has a diagnosis or a documented, evidence-based dead end.

## 22. Explicitly deferred

Discounts · tax · refunds (a void is still the only correction) · shifts and cash counts · cash
drawer · multi-terminal · auto-update · code signing · supplier-invoice intake · OCR · credit
limits and ageing · tray or background mode · touch-optimised layout.

## 23. Future cloud integration — preserved, not implemented

`DEFERRED TO CLOUD`. Recorded so it is not rediscovered later.

| Requirement | Boundary that must hold |
|---|---|
| Device identity and enrolment | Comes after local stabilisation |
| One canonical catalog, synced down | The cloud catalog is canonical; the local table is a projection |
| POS sales synced up | The POS keeps its own immutable ledger regardless |
| Lia reading POS data | **Lia never writes to SQLite** |
| Invoice intake over WhatsApp | Cloud side |
| Cloud inventory consolidation | Cloud side; the local movement ledger stays the local truth |
| Online StoreOrder integration | **A StoreOrder is not a POS sale.** Never merge them. |
| Tenant identity | The canonical tenant is the existing `Client.id`. **No `store_id`.** |
| Capability | POS is a `pos` capability on the existing tenant, not a separate tenant system |
| Transport | **The POS never writes to Supabase directly.** |

All ten are `DOCUMENTED PREVIOUS DECISION`. The architecture study behind them is **not reopened**.

## 24. Questions requiring Salman's approval

### Answered by the review of 2026-10-06 — now decisions, not questions

| Was | Now |
|---|---|
| Q-4 Is an unpaid invoice a sale? | **A completed Sale**, plus append-only payments, balance derived, customer required when the balance is positive. §8 |
| Q-7 May a sale go below zero stock? | Superseded by a firmer rule: **an unverified unit gets no authoritative inventory arithmetic at all.** §6 |
| Q-9 Should the till keep the display awake? | **Not decided and not proposed** — it waits for an A–E classification. The earlier framing of this as a product gap is withdrawn. §14 |
| Q-10 May a diagnostic session run on the shop PC? | **Approved, read-only first**, backup exported first, no safeguard disabled. §14 |
| Q-11 Arabic at PR 8 or first? | **Neither** — the i18n/RTL foundation is PR 1, then every new screen is bilingual from its first commit. §11 |
| Q-13 May the redundant export folders be deleted? | **Later, at Salman's choosing.** They are not used for work; the only working repository is the clone. §2 |
| — | The permission boundary is set: Owner/Admin versus Cashier, void behind Owner/Admin. §12 |

### Still open — and these block code, not scheduling

| # | Question | Blocks |
|---|---|---|
| **Q-1** | The field survey CSVs are **empty**. Will they be filled at the shop in PR 0's visit, or do we proceed on your spoken answers — recorded as `VERIFIED IN FIELD BY SALMAN` rather than measured? | PRs 2, 4, 8 |
| **Q-2** | **The scaling factor.** `quantity_milli` means thousandths. Is three decimals right for every fractional unit the shop sells — grams on a scale, centimetres on a roll? This is effectively one-way once sales exist. | Migration 4 |
| **Q-3** | **Option A or Option B** for the sale-line model. §15 recommends **B** (rebuild) with measured evidence for every safety property you asked about. | Migration 4 |
| **Q-5** | One invoice number or two — the merchant's own sequence, or the POS receipt number? The reference document carries a small plain integer of the merchant's own. | §9 |
| **Q-6** | Is the total written out in **Arabic words** required for V1? The reference document prints it twice. | §9 |
| **Q-8** | "NO unrestricted void": does a cashier get **no** void at all, or a void that an Owner/Admin authorises at the till with an override? The second is what a shop usually needs and is more work. | Migration 8 |
| **Q-12** | Has the 430-item catalog been imported at the shop yet? | §19 |
| **Q-14** | PRs E, F and G each add a dangerous action while the published fixture PINs are still live. Do permissions stay at **J**, or move ahead of **E**? | The sequence |
| **Q-Q1…Q-Q6** | The six quantity decisions — field name and scale, the exact CHECK, a zero-total line, `MAX_QUANTITY`, refusing a fractional entry on a whole-only unit, and the migration order | `docs/plans/exact-quantity-contract.md` §14 |
| **Q-A1** | Approve the audit DDL as written, including **one transaction with the mutation** — which means a price change that cannot be recorded **does not happen** | `docs/plans/durable-local-audit-proposal.md` §12 |
| **Q-A2** | **Migration order:** quantity rebuild first, or audit first? §9 of the audit proposal argues audit first (purely additive, no rollback risk); the counter-argument is that quantity is what the invoice needs | Both contracts |

---

## Revision record

### Revision 2 — 2026-10-06, after Salman's review

| Area | Change |
|---|---|
| §6 Units | Units are never inferred; unknown units are explicitly marked for review; an unverified unit gets no authoritative inventory arithmetic. |
| §8 Debt | Settled: an unpaid sale is a completed Sale; append-only payments; derived balance; the total is never mutated; a positive balance requires a customer. |
| §11 Arabic | The i18n/RTL **foundation moves early**, and every new screen is bilingual on its first commit. Revision 1's "Arabic at PR 8" is **withdrawn**. |
| §12 Permissions | The Owner/Admin versus Cashier boundary is set; void sits behind Owner/Admin. |
| §14 Black screen | Read-only evidence first; an A–E classification before any product change; no global GPU disabling; observability logs only, changing no runtime behaviour. |
| §15 Migration | Salman's **rebuild** option investigated and **recommended**, with a real SQLite experiment: crash rollback, history fingerprint, the bounded integer check, the guards, the tie case and overflow headroom. |
| §16 | The additive-only rule gains one bounded, named exception. |
| §18 Tests | The v3 → v4 upgrade test specified step by step, plus a negative-test table tied to the evidence. |
| §20 Sequence | Replaced with Salman's order, evaluated against the code. |
| §24 | Seven questions became decisions; one new question (Q-14) was created by the new sequence. |

### Two claims from Revision 1 that were wrong, and are withdrawn

1. **"No `powerSaveBlocker` is arguably a product gap for a till."** Withdrawn on Salman's
   correction: allowing the display to sleep is ordinary application behaviour and is not evidence
   of anything. The grep fact stands; the judgement does not. §14
2. **"The `closed_sale` trigger must be created after the copy or the migration cannot run at
   all."** Withdrawn as **false**. It rested on a test with one line per sale — too weak to
   exercise the trigger. Re-run with two lines on one sale, the copy succeeds in **either** order.
   The corrected test pointed the opposite way: create that trigger **before** the copy on purpose,
   so a malformed ledger aborts the migration instead of being copied forward. §15

Both were found by strengthening a test rather than by re-reading the code.

### Revision 3 — 2026-10-07, after Salman's review of the Product PR

| Area | Change |
|---|---|
| §15 | Migration numbers **unassigned** until the order is approved; no document says "migration 4" any more. |
| §15 | The line-total check became an **exact equality** instead of a tolerance — measured to admit exactly one total, the tie included. |
| §20 | Replaced with the approved **A–L** roadmap. Barcode and categories moved down to **I**; exact quantity is **C**. |
| §24 | Nine new decisions: six on quantity, two on audit, plus the permission-position question. |
| — | Two contracts written and **not implemented**: `exact-quantity-contract.md`, `durable-local-audit-proposal.md`. |

### A third claim from an earlier revision, withdrawn

**"`abs(…) <= 500` is the best the schema can do for a fractional line total."** Withdrawn. An exact
integer equality using SQLite's integer division pins round-half-up uniquely, including on an exact
tie. The tolerance was not wrong; it was weaker than necessary, and it left the rounding rule in the
application where the schema could hold it.
