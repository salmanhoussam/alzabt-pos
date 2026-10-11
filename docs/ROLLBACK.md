# Rolling back Alzabt POS

> **Read this before reinstalling an older build on a shop machine.**
> Written 2026-10-11, when migration 8 (operator accounts) changed what rollback means for the
> first time in this product's history.

## 🔴 OLD EXE ALONE IS NOT ROLLBACK

Every installer up to **`b18b5b4`** writes schema **v7**. From schema **v8** onward that stops
being true, because a v7 build opening a v8 database raises `SchemaNewerThanAppError` and
**refuses to start** — by design, so it can never half-read a database it does not understand.

```
VALID ROLLBACK  =  RESTORE THE PRE-MIGRATION DATABASE  +  RUN THE OLDER EXECUTABLE
```

**The pre-migration backup is the only coherent rollback boundary.** It is taken automatically,
before any schema change, and never pruned:

```
%APPDATA%\Alzabt POS\backups\pre-migration-v<from>-to-v<to>-<UTC stamp>.sqlite
```

## Why the old EXE alone is worse than merely useless

If an operator completes PIN setup on v8 and a v7 build is then run against a database that was
**not** restored, that build reads its credentials from the compiled-in fixtures instead of the
`operators` table it cannot see. **`1111` would authenticate again, and the PIN the operator just
set would not exist in that build's account model.** A refusal is the safe outcome; a
silently-working old build would not be.

## The procedure

1. **Stop the app completely.** No Alzabt POS process may be running.
2. **Keep the current database.** Copy `alzabt-pos-ledger.sqlite` somewhere safe before touching
   anything — if the rollback turns out to be unnecessary, this is the only way back to v8.
3. **Find the snapshot** named for the span you are undoing, e.g. `pre-migration-v7-to-v8-*.sqlite`.
   Check it: it must open, and `SELECT max(version) FROM schema_migrations` must report the version
   you are rolling back **to**.
4. **Replace the active database** with that snapshot, and delete any `-wal` / `-shm` sidecars
   beside it, so no newer page survives into the restored database.
5. **Install the older executable** over the current one.
6. **Start it.** It must reach the login screen normally.
7. **Check the ledger**: sales, receipt numbers, voids, invoices and the audit trail should all read
   exactly as they did before the upgrade.

## What a rollback costs — expected, not corruption

Everything that only the newer schema could hold is in the database you just replaced, so it is
gone:

| Rolling back from v8 loses | Because |
| :--- | :--- |
| Every operator account, including ones created after the upgrade | The `operators` table does not exist in v7 |
| Every PIN and name set during or after mandatory setup | They live in that table |
| Every `OPERATOR_*` audit row | Written after the snapshot was taken |

What is **not** lost: sales, sale lines, voids, receipt numbers, invoices, invoice lines,
reconciliation state, the catalog, and the audit history that existed before the upgrade. Those are
in the snapshot, and the ledger's cashier id/name snapshots are plain text with no foreign key —
so a reprinted receipt still names the person who rang it up.

After a rollback the shop is back on the **v7 credential model**: the bundled bootstrap PINs work
again, exactly as they did before the upgrade.

## Proven, not asserted

`e2e/upgrade.mjs` runs this whole sequence on a real Windows machine in CI, on the real
`%APPDATA%` profile, with real installers:

| Phase | What it proves |
| :--- | :--- |
| `seed-v7` | a populated v7 shop, created by driving the **real** v7 build's own UI |
| `verify-from-v7` | the real v8 installer migrates it; schema 8; nothing pre-existing altered |
| `rollback-prepare-v7` | real v8-only changes are made, so the restore has something to lose |
| `rollback-refuse-v7` | 🔴 the v7 executable **refuses** the v8 database, and the file is byte-for-byte unchanged — no silent downgrade, no destructive reset, no mutation |
| `rollback-restore-v7` | 🔴 snapshot restored + the v7 executable starts normally, the original ledger is intact against facts recorded **before** the upgrade, and the v8-only changes are gone |
