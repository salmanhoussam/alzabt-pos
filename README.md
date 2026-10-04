# Alzabt POS

An installable Windows point of sale for a merchant who has a PC and no existing POS software.
Offline-first: completed sales live in a local SQLite ledger on the PC.

**Status: Gate 1 — local pilot.** One PC, one terminal, no network of any kind. Cloud sync, device
enrolment and Lia come in later gates and are deliberately absent here.

## What Gate 1 proves

A cashier logs in with a PIN, rings up products from a bundled test catalog, records how the sale
was paid, and completes it. The sale is written atomically to SQLite, survives restarts and hard
kills, can be voided with a separate void record, and is reflected in Today's Sales.

## Run it

```bash
npm install
npm test            # 55 kernel + IPC tests (no Electron needed)
npm start           # build, then launch the Electron app
npm run e2e         # build, then drive the real app end-to-end (Linux without display: xvfb-run -a npm run e2e)
npm run dist:win    # Windows installer (NSIS) — run on Windows
```

Test cashiers (fixture only): **Cashier One / PIN 1111**, **Cashier Two / PIN 2222**.

The ledger file is `alzabt-pos-ledger.sqlite` in the per-user app-data folder
(`%APPDATA%\Alzabt POS` on Windows). `ALZABT_POS_USER_DATA` overrides the folder (tests/support).

## Structure

```
src/
  domain/        Pure TypeScript, no Node/Electron: money, catalog, cart, sale types,
                 business day, report. Shared by main (authoritative) and renderer (display).
  application/   PosService (the business operations) + cashier PIN verification.
  persistence/   SQLite: db open + pragmas, versioned migrations, SaleRepository (fixed SQL only).
  fixtures/      Bundled test catalog, test cashiers, terminal config (replaced by cloud data later).
  shared/        IPC contract (channels, DTOs) and domain↔DTO conversion.
  main/          Electron main process + pure IPC handlers (validated, testable without Electron).
  preload/       Sandboxed preload exposing exactly the PosApi as `window.pos`.
  renderer/      React UI. Talks only to `window.pos`.
tests/           Vitest: domain, persistence (atomicity, crash, schema), application, IPC.
e2e/             Playwright-driven smoke test of the built app.
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

**Electron boundary.** `contextIsolation`, no `nodeIntegration`, `sandbox`, a CSP with no network,
no navigation or new windows, all permissions denied, IPC accepted only from our own window. The
renderer gets nine business methods and nothing else — no SQL, no files, no generic invoke. The
renderer never supplies a price, cashier, time or receipt number; the main process decides them and
refuses a displayed total that no longer matches the catalog.

## Out of scope for this gate

Cloud API, sync, device enrolment, Lia, networking, inventory, customers, discounts, tax, refunds,
split payments, shifts, printing, cash drawer, multi-terminal, auto-update, code signing.
