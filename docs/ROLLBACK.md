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
| The terminal's record of having been claimed | `terminal_security_state` does not exist in v7 either |

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

---

## Before any of this: the v8 install/upgrade ceremony

Added 2026-10-11 with schema v8. A terminal is **not operational** the moment the installer
finishes — it is in **OWNER SETUP REQUIRED** until the shop owner signs in on `Cashier One` with the
old PIN and sets their real name and their own 6–8 digit PIN. Until then nobody else can sign in at
all, and the terminal cannot sell.

**This is part of the upgrade, not a follow-up task.** The PINs that ship with the product are
published; an upgraded-but-unclaimed terminal is claimable by whoever reaches it first, and whoever
claims the owner account sets its PIN permanently with no in-app recovery. Complete owner setup
before the machine goes back to the counter.

## 🔴 The one state that locks everybody out — and how to get out of it

Recorded here because it is a **support path**, not a defect: it is the deliberate fail-closed
direction of the ownership ceremony, and the shop needs to know the way back BEFORE it happens.

The terminal keeps its own durable record of having been claimed by its owner
(`terminal_security_state.terminal_claimed`). If that record says UNCLAIMED while the seeded owner
account `Cashier One` has already been set up — or while that account has been deactivated — then:

```
NOBODY CAN SIGN IN AT ALL.
Not the owner. Not a cashier. Not with a correct PIN.
```

That is on purpose. An unclaimed terminal admits exactly one identity, the seeded bootstrap owner,
and if that identity cannot complete the ceremony then the terminal refuses everyone rather than
letting the next person claim a till whose published PINs are in a public repository. Failing closed
is the right direction; being unable to find the way out is not.

**How it is reached.** Not by any ordinary action. Resetting PINs, adding staff, promoting an owner,
deactivating anyone — none of these can touch the claim record, and that is asserted by test. It
takes a database edited by hand, a restored backup from before the claim combined with accounts set
up after it, or storage corruption.

**The way out.** Restore a backup, exactly as below. The automatic daily backup is usually the
cheapest choice; the pre-migration snapshot takes you back to v7 and needs the v7 executable too:

```
1. stop the app
2. restore the most recent backup from
     %APPDATA%\Alzabt POS\backups\
3. start the app
   - a v8 backup from AFTER the claim  -> the shop signs in normally again
   - a v8 backup from BEFORE the claim -> the terminal asks the owner to claim it again,
                                          with the PINs that backup held
   - the pre-migration v7 snapshot     -> ALSO install the v7 EXE (see above)
```

Nothing in the ledger is at risk in this state: sales, invoices and the audit trail are intact and
unreadable only because nobody can open the door. Restoring re-opens it.

One consequence for rollback specifically: a restored pre-migration v7 database has no operator
accounts at all **and no terminal-claim state** — v7 does not have either concept — so the shop
returns to the **v7 credential model**: the bundled PINs work again, exactly as they did before the
upgrade. Any PIN or name an operator set on v8 is gone with the table that held it. Re-upgrading
later arrives UNCLAIMED again, so the ceremony has to be performed again. All of that is expected
rollback semantics, not corruption, and each line of it is asserted by the rollback phases of
`e2e/upgrade.mjs`.
