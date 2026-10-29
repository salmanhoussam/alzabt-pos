# Backing up and recovering Alzabt POS — support runbook

> **Read this before promising a shop that its data is safe, and before touching a shop machine.**
> Written 2026-10-21, when the three different things people call "backup" were given three
> different names in the interface. Companion to [`ROLLBACK.md`](ROLLBACK.md), which covers the
> other direction: putting an **older build** back on a machine after a schema change.

## 🔴 Three artifacts, and only one of them is a backup

| What the operator clicks | What it really is | Carries | Does NOT carry |
| --- | --- | --- | --- |
| «تصدير قائمة الأسعار (CSV)» · *Export price list (CSV)* | A 7-column price list of **imported** products that are active | `source_id, name_ar, name_en, price, currency, base_unit, price_needs_review` | **Manually added products**, photos, categories, SKU, barcode, brand, descriptions, sales, invoices |
| «نسخة احتياطيّة لقاعدة البيانات» · *Database backup* | A verified SQLite snapshot of the ledger | Every table: sales, sale lines, voids, invoices, invoice lines, reconciliation, products, categories, **product photo BLOBs**, operators, terminal security state, audit events, company profile, schema version | **Frozen invoice-logo files**, the live branding file, logs, anything else outside the `.sqlite` file |
| *(no button — see §4)* | **Full cold copy** of the whole data folder | Everything above **plus** the frozen invoice logos and branding | Nothing — but it is only safe with the application **closed** |

**Never call the CSV a backup.** A shop that hand-types products — which is the normal case — would
lose every one of them, plus every photo, while believing it had a backup.

## 1 · Where the live shop data is

Windows (the shipped configuration):

```
%APPDATA%\Alzabt POS\
  alzabt-pos-ledger.sqlite          the ledger: everything durable
  alzabt-pos-ledger.sqlite-wal      write-ahead log — COMMITTED DATA CAN LIVE HERE
  alzabt-pos-ledger.sqlite-shm      shared-memory index for the WAL
  backups\
    daily-<business date>.sqlite            automatic, at most one per business day, last 14 kept
    pre-migration-v<from>-to-v<to>-*.sqlite automatic, before any schema change, NEVER pruned
  branding\
    invoice-logo.<ext>              the shop's CURRENT logo — one fixed name, overwritten on change
    frozen\<32-hex>.<ext>           one immutable copy per logo an invoice was issued with
  print\                            scratch space for the document being printed; disposable
  logs\                             application logs
```

A support or test machine can point the application at a different folder with the
`ALZABT_POS_USER_DATA` environment variable. **Never use it to aim a running application at a copy
of a shop's data you intend to keep** — use it to aim at a disposable fixture (§7).

## 2 · What the database backup includes, exactly

`Tools → Database backup` runs SQLite `VACUUM INTO`, which reads **one consistent snapshot** of the
main file and the WAL together, and then verifies it before keeping it:

- `PRAGMA integrity_check` must answer `ok`
- row counts must match the source for every table in the backup contract
- a snapshot that fails either check is **deleted**, and the operator gets an error — a bad backup
  is never left looking like a good one

Product photos are inside this snapshot: they are `BLOB` columns in `catalog_product_images`, not
files.

## 3 · 🔴 What it excludes, and why that matters

**The frozen invoice logos are files, not rows.** When an invoice is finalized, the shop's logo at
that moment is copied into `branding\frozen\` under a content-addressed name, and the invoice stores
**that name** — not the image. A `.sqlite` export cannot contain those bytes.

Consequence, and the reason this document exists: restore only the database onto a machine whose
`branding\frozen\` is empty, and every historical invoice has a logo name it cannot resolve.

**What the application does in that case (since 2026-10-21):** it prints the invoice **without a
logo** and shows the operator a warning. It does **not** substitute the shop's current logo. That
matters because the live logo always has the same file name, so the old behaviour could reprint a
two-year-old invoice carrying this year's branding — a document that looks correct and is not. The
invoice's own numbers, lines, totals and tax are unaffected and remain immutable.

An invoice issued **before** logo freezing existed records no asset at all; those keep their
original behaviour and show no warning, because nothing was lost.

## 4 · Closing the application completely, then taking a cold copy

A plain file copy of a running ledger is **not safe**: in WAL mode, committed sales can still be in
the `-wal` file, so a copy can miss them or catch a half-written page. That is why the complete copy
is a procedure and not a button.

1. In the application, sign out and close the window.
2. Confirm **no process remains**. Windows: Task Manager → Details → no `Alzabt POS.exe`.
   From a terminal: `tasklist | findstr /i "alzabt"` must print nothing.
   If one is still running, end it and wait for the file handles to be released.
3. Confirm the WAL has been checkpointed away, or accept that you are copying it too: copying
   `alzabt-pos-ledger.sqlite` **together with** its `-wal` and `-shm` sidecars is correct and is
   what step 4 does. Copying the `.sqlite` **alone** is not.
4. Copy the **whole** `%APPDATA%\Alzabt POS` folder to the destination, keeping its structure.
5. Verify the copy carries `branding\frozen\` and that the file count matches.

Keep the copy read-only where you can. Label it with the shop name, the date and the application
version from `Tools → About`.

## 5 · Recovering a matching app-data copy

> **Precondition that is not negotiable: the application must be closed, and you must have a copy of
> the CURRENT state before you overwrite anything.** Recovery that cannot be undone is not recovery.

1. Close the application completely (§4, steps 1-2).
2. **Anti-overwrite:** rename the existing folder — `Alzabt POS` → `Alzabt POS.before-recovery-<date>`
   — rather than deleting or writing over it. If the recovery is wrong, this is the only way back.
3. Put the copy in place as `%APPDATA%\Alzabt POS`.
4. Delete nothing inside it. In particular do **not** delete `-wal` / `-shm` sidecars that came with
   the copy; they belong to that ledger.
5. Start the application and verify §6 before telling anyone the shop is recovered.

**If you only have a `.sqlite` backup** and not a folder copy, you are restoring the *database*, not
the shop: replace `alzabt-pos-ledger.sqlite` with the snapshot, delete the stale `-wal`/`-shm`
sidecars **of the replaced file** (they belong to the old database and will corrupt the new one),
and expect historical invoice logos to be missing with the warning described in §3.

### Schema compatibility

The application refuses to open a database written by a **newer** schema than it knows
(`SchemaNewerThanAppError`), by design. So:

- A backup is restorable by the build that made it, or any later build.
- It is **not** restorable by an earlier build. Installing an older EXE over a newer database does
  not work, and is covered by [`ROLLBACK.md`](ROLLBACK.md).
- Check before you start: open the snapshot read-only and run
  `SELECT max(version) FROM schema_migrations;`. It must be **≤** the schema of the build you are
  going to run.
- The application will not silently create a ledger it cannot find, so a wrong path fails loudly
  rather than starting an empty shop.

## 6 · Verifying a recovery — before you call it done

Check all of these in the running application, against what the shop expects:

| Check | Where | What proves it |
| --- | --- | --- |
| Products, including hand-typed ones | Products screen | total count, and a product the shop created by hand is present |
| Product photos | Products screen | thumbnails render, not placeholders |
| Historical sales | History screen | the last business day's sales and their totals |
| Invoices | Invoices → history | count, numbers, totals |
| **Historical invoice logos** | open an old invoice → Save PDF | the logo appears **and no missing-asset warning is shown** |
| Operators | Login screen, Tools → Operators | every operator is listed; each signs in with their own PIN |
| Audit trail | Tools / audit view | events exist for dates before the recovery |
| Installation identity | Tools → About | version and build are the ones you intended to run |

**Any one of these failing means the recovery is not complete.** Report it; do not work around it.

## 7 · The disposable drill — and what is actually rehearsed

**Never rehearse on a shop machine, and never on a copy of real shop data you cannot discard.**
Build a fixture, break it, recover it.

Two halves of this runbook's central claim are exercised automatically on every Windows gate, by
`e2e/invoice-logo.mjs` against the **installed** application and a synthetic shop:

- **§3** — the frozen asset is deleted while the live logo (a *different* image under the same fixed
  name) remains. The reprint embeds **no** image, the operator sees the warning, and the invoice's
  number and total are unchanged.
- **§4-§5** — the whole data folder is cold-copied, a second application instance is started against
  the copy, the recovered operator signs in with the same PIN, and the historical invoice reprints
  **with** its own logo and **no** warning.

### What is NOT rehearsed, and must not be described as verified

- Recovery onto a **different physical machine**, including Windows file permissions and ACLs on a
  folder copied from another user profile.
- Copying from or to removable media that fails or disconnects mid-copy.
- A ledger damaged in a way `integrity_check` does not catch.
- Any recovery of **real shop data**. Nothing in this document has been exercised against a shop's
  own ledger, and it must not be.

State that honestly when you report. "The procedure is rehearsed on a fixture" is true; "recovery is
verified for this shop" is only true once §6 passes on that shop's own machine.

## 8 · If validation fails

1. Stop. Do not keep working inside a half-recovered profile.
2. Close the application completely.
3. Put `Alzabt POS.before-recovery-<date>` (§5 step 2) back as `Alzabt POS`.
4. Start the application and re-check §6 against the pre-recovery state, so you know you are back
   where you started rather than somewhere new.
5. Record what failed, with the real counts you saw, and escalate with that evidence.

If the pre-recovery folder was not kept, the next-best source is the newest verified snapshot in
`backups\` — and that recovers the database only, with §3's consequence for invoice logos.

## 9 · Known limitation, stated plainly

The exported `.sqlite` backup is **not** a complete backup of the shop, because the frozen invoice
logos live outside it. Until a packaged backup exists — SQLite plus external assets plus a manifest
with checksums, which is planned and not built — the only complete artifact is the cold folder copy
in §4. The interface now says so in both languages rather than leaving the merchant to assume.
