# Alzabt POS

An installable Windows point of sale for a merchant who has a PC and no existing POS software.
Offline-first: completed sales live in a local SQLite ledger on the PC.

**Status: L1-A — Field Release 0.1.1.** One PC, one terminal, no network of any kind. Gate 1 built
the local ledger; Gate 2 added the Windows installer pipeline, auto-start and cashier PIN lockout;
the field pilot added a local catalog import; 0.1.1 makes field updates identifiable, upgrade-safe,
backed up and diagnosable. Cloud sync, device enrolment and Lia come in later gates and are
deliberately absent.

> **Not approved for real-money daily use.** The test cashier PINs below are public. Real-money use
> waits for local cashier management (L2).

## What Gate 1 proves

A cashier logs in with a PIN, rings up products from a bundled test catalog, records how the sale
was paid, and completes it. The sale is written atomically to SQLite, survives restarts and hard
kills, can be voided with a separate void record, and is reflected in Today's Sales.

## Run it

```bash
npm install
npm test            # kernel, persistence, IPC, lockout and auto-start tests (no Electron needed)
npm start           # build, then launch the Electron app
npm run e2e         # build, then drive the real app end-to-end (Linux without display: xvfb-run -a npm run e2e)
npm run dist:win    # Windows installer (NSIS) — run on Windows
```

Test cashiers (fixture only): **Cashier One / PIN 1111**, **Cashier Two / PIN 2222**.

**Windows installer:** built by `.github/workflows/windows-delivery.yml` on every push to `main` or
`claude/**`. The workflow installs it silently, runs the E2E tests against the installed app
(smoke, crash recovery, catalog import/export/backup, startup failure), checks auto-start,
uninstalls, proves an **upgrade over the previous releases** keeps all data (below), and only then
uploads `alzabt-pos-windows-installer` as a workflow artifact (14 days). The installer is **unsigned** in this gate — Windows SmartScreen will show
"Windows protected your PC" (More info → Run anyway) until a code-signing certificate exists.

The ledger file is `alzabt-pos-ledger.sqlite` in the per-user app-data folder
(`%APPDATA%\Alzabt POS` on Windows). `ALZABT_POS_USER_DATA` overrides the folder (tests/support).

## Release identity (field support)

- **Version:** `package.json` `version` is the single source of truth (0.1.1). Every installer that
  goes to a real PC gets a new version — never two different builds with the same number.
- **Build:** the git commit the installer was built from, embedded at build time in
  `dist/build-info.json` by `scripts/write-build-info.mjs` (CI sets `ALZABT_BUILD_SHA`; a local build
  from uncommitted changes shows `-dirty`). The merchant PC never needs git.
- **Where to see it:** the bottom line of every screen shows `Alzabt POS 0.1.1 · Build 1a2b3c4`;
  **Tools → About** shows the same. The log records it at every start.
- **Installer name:** `Alzabt-POS-Setup-<version>-<build>.exe` (CI). A local `npm run dist:win`
  produces `Alzabt-POS-Setup-<version>.exe`.

## Upgrades, backups and recovery

**Upgrade:** run the new installer over the installed app (no uninstall needed). The ledger lives in
`%APPDATA%\Alzabt POS` (outside the install folder) and is kept; auto-start is kept. If the new
version has schema migrations, a verified backup is taken **before** they run; if that backup
cannot be made, the migration does not run and the app says so. CI proves this on the real
`%APPDATA%` profile: Gate 2.1 (schema v2, the build verified at the shop) → 0.1.1, and the
field-pilot build (schema v3, imported catalog) → 0.1.1 — every sale, void, receipt number and
catalog row survives, a new sale continues the receipt sequence, and everything survives a restart.

**Uninstall** removes the app and its auto-start entry but **never** the ledger or backups.

**Backups** (`%APPDATA%\Alzabt POS\backups`), all made with SQLite `VACUUM INTO` — one consistent
snapshot of the database *including the WAL*, never a raw copy of the live file — and verified
(`integrity_check` + row counts) before they are kept:

| Kind | When | Kept |
|---|---|---|
| `pre-migration-v<from>-to-v<to>-<UTC>.sqlite` | before any schema migration | always (never pruned) |
| `daily-<business date>.sqlite` | at most once per business day (at start-up, or the first sale after midnight) | newest **14** |
| Exported backup | **Tools → Export backup**, saved wherever chosen (e.g. a USB drive) | yours |

**Manual restore** (support procedure — there is no in-app restore):
1. Close Alzabt POS.
2. In `%APPDATA%\Alzabt POS`, rename `alzabt-pos-ledger.sqlite` to `alzabt-pos-ledger.broken.sqlite`
   and delete `alzabt-pos-ledger.sqlite-wal` / `-shm` if present.
3. Copy the chosen backup to `%APPDATA%\Alzabt POS\alzabt-pos-ledger.sqlite`.
4. Start Alzabt POS. (A backup from an older version is migrated on start, after its own
   pre-migration backup.)

**If the app cannot open its database** it does not start the till: it shows
"Alzabt POS could not open its local database. Your sales data was not modified. Please contact
support." (English + Arabic) with a short code (`DB_NEWER_THAN_APP`, `DB_CORRUPT`,
`LEDGER_MISSING`, `BACKUP_FAILED`, …) and the build. A refused ledger is left byte-for-byte
unchanged, and a missing ledger is **never** replaced by a new empty one (`ledger.json` records
that this profile had one).

**Log:** `%APPDATA%\Alzabt POS\logs\alzabt-pos.log` (JSON lines: start-up, version/build, database
open, migrations, backups, imports/exports, unexpected errors). Rotated at 1 MB, 5 files kept.
Secret-looking fields (PIN, password, token, …) are redacted; no sale lines or catalog rows are
logged. Nothing is uploaded.

## Structure

```
src/
  domain/        Pure TypeScript, no Node/Electron: money, catalog, cart, sale types,
                 business day, report. Shared by main (authoritative) and renderer (display).
  application/   PosService (the business operations) + cashier PIN verification.
  persistence/   SQLite: db open + pragmas, versioned migrations, Sale/Catalog/PinState repositories
                 (fixed SQL only), verified backups (backup.ts).
  fixtures/      Bundled test catalog, test cashiers, terminal config (replaced by cloud data later).
  shared/        IPC contract (channels, DTOs) and domain↔DTO conversion.
  main/          Electron main process + pure IPC handlers (validated, testable without Electron),
                 field log, ledger guard, startup-failure messages, build identity.
  preload/       Sandboxed preload exposing exactly the PosApi as `window.pos`.
  renderer/      React UI. Talks only to `window.pos`.
scripts/         write-build-info.mjs (version + git commit embedded at build time).
tests/           Vitest: domain, persistence (atomicity, crash, schema, backup), application, IPC, startup.
e2e/             Playwright-driven tests of the built/installed app: smoke, crash-recovery,
                 catalog-import (+ export/backup), startup-failure, upgrade (real profile).
```

## Contracts

**Money.** Integer minor units: `bigint` in memory, `INTEGER` in STRICT SQLite tables, a decimal
string of minor units across IPC. Never a JS `number`, never SQL `REAL`. Currency is explicit on
every amount and every sale; unknown currencies are rejected; no exchange rates exist.
See `src/domain/money.ts`.

**Ledger.** `sales` + `sale_lines` (name, SKU and unit price snapshotted at sale time) + `voids`.
Completed sales are immutable and undeletable — enforced by SQLite triggers, not by convention.
A correction is a new `voids` row (same business day only; refunds are out of scope).
See `src/persistence/migrations.ts`.

**Atomicity.** Header and lines are written in one `BEGIN IMMEDIATE` transaction that verifies the
lines add up before `COMMIT`. WAL + `synchronous=FULL`. Each checkout carries an idempotency key; a
replay returns the original sale and never writes a second one.

**Business day.** Defined once, in `src/domain/businessDay.ts` (calendar date in the terminal's
IANA zone), and stored on each sale and void at write time.

**PIN lockout.** Per cashier: 5 consecutive wrong PINs lock that cashier for 5 minutes; the lock
is checked before the PIN (a correct PIN cannot bypass it), attempts during a lock do not extend
it, it expires on its own, and it survives restarts (SQLite). Policy: `src/domain/pinLockout.ts`.

**Auto-start.** Packaged Windows builds register one per-user login item (`AlzabtPOS`, HKCU Run)
via Electron's `app.setLoginItemSettings`, once per installation — if the merchant turns it off in
Windows Settings it stays off. Development runs never register. Opt out with
`ALZABT_POS_DISABLE_AUTOSTART=1`. The uninstaller removes the entry but never the sales ledger.
See `src/main/autoStart.ts`, `build/installer.nsh`.

**Electron boundary.** `contextIsolation`, no `nodeIntegration`, `sandbox`, a CSP with no network,
no navigation or new windows, all permissions denied, IPC accepted only from our own window. The
renderer gets thirteen business methods and nothing else — no SQL, no files, no generic invoke. The
renderer never supplies a price, cashier, time or receipt number; the main process decides them and
refuses a displayed total that no longer matches the catalog.

## Field pilot: local catalog import

A terminal can replace the bundled demo catalog with the merchant's own products: **Tools → Import
catalog** opens a native file dialog in the main process — the renderer never names a
path — and imports a strict UTF-8 CSV (`src/domain/catalogImport.ts` documents the format) into the
`catalog_products` table (migration 3).

- **All or nothing.** One rejected row refuses the whole file; the reasons are shown per line.
- **Exact money.** Prices are parsed to integer minor units; `$5`, `5,00`, `1.001` are rejected.
- **Idempotent.** Identity is the merchant's own `source_id`; re-importing the same file changes
  nothing, a changed file updates rows, and rows no longer listed are hidden, never deleted.
- **Names.** `name_ar` is required and stored as written; `name_en` is optional and never invented;
  display falls back to `name_ar`.
- **Placeholder prices** (`price_needs_review=1`) stay sellable and are marked `price?` on the till.
- **History is untouched.** Sale lines keep their own name/price snapshot; no sale references the
  catalog table. A fresh install (no local products) starts on the demo fixture.

**Export → edit → re-import.** **Tools → Export catalog** writes the imported catalog back in the
same import format (UTF-8 with BOM so Excel shows Arabic; `source_id` is the stable identity;
`name_en` empty when absent; prices as exact decimals; placeholders marked `price_needs_review=1`).
Edit prices in Excel, save as **"CSV UTF-8"**, then import: unchanged rows stay unchanged, edited
rows are updated. Excel caveats: a locale that saves with `;` separators, or a legacy encoding, is
refused with a clear message; never let Excel reformat `source_id` (e.g. drop leading zeros).

Merchant files never enter this repository (`*.csv` is git-ignored); tests use synthetic data.

## Out of scope for this gate

Cloud API, sync, device enrolment, Lia, networking, inventory, customers, discounts, tax, refunds,
split payments, shifts, printing, cash drawer, multi-terminal, auto-update, code signing, tray /
background mode.
